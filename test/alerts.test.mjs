// Run: node test/alerts.test.mjs
// Loads alerts/Code.gs with mocked Apps Script services (Sheets, Mail, Lock, Cache, ...) and checks:
// the flyable-hour logic, that it agrees with the web app's physics, and the sign-up flow.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { computeHour, launchWind } from '../js/physics.js';

// ---------- minimal Apps Script mocks
function makeSheet(name) {
  const rows = [];
  return {
    name, rows,
    appendRow: r => rows.push(r.map(v => (typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v))),
    setFrozenRows() {},
    getDataRange: () => ({ getValues: () => rows.map(r => [...r]) }),
    getLastRow: () => rows.length,
    getRange: (row, col, nr = 1, nc = 1) => ({
      setValues: vals => vals.forEach((v, i) => v.forEach((x, j) => { rows[row - 1 + i][col - 1 + j] = x; })),
      setValue: v => { rows[row - 1][col - 1] = v; },
    }),
  };
}
const sheets = {};
const mail = [];
const cacheStore = {};
const fmt = (date, tz, pattern) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short', minute: '2-digit',
  }).formatToParts(date).map(p => [p.type, p.value]));
  const mon = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short' }).format(date);
  if (pattern === 'H') return String(+parts.hour);
  if (pattern === "yyyy-MM-dd'T'HH:00") return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:00`;
  if (pattern === 'yyyy-MM-dd') return `${parts.year}-${parts.month}-${parts.day}`;
  if (pattern === 'EEE MMM d') return `${parts.weekday} ${mon} ${+parts.day}`;
  throw new Error(`pattern ${pattern}`);
};
let fakeNow = null;   // override "now" for checkAndAlert
const RealDate = Date;
class MockDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [fakeNow ?? RealDate.now()])); }
  static now() { return fakeNow ?? RealDate.now(); }
}
let omResponse = null;
const ctx = vm.createContext({
  console, Math, JSON, Number, String, Array, Object, Set, Date: MockDate,
  SpreadsheetApp: { getActive: () => ({
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = makeSheet(n)),
    getSpreadsheetTimeZone: () => 'America/Los_Angeles',
  }) },
  ScriptApp: {
    getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/TEST/exec' }),
    getProjectTriggers: () => [], deleteTrigger() {},
    newTrigger: () => ({ timeBased: () => ({ everyHours: () => ({ create() {} }) }) }),
  },
  MailApp: { sendEmail: m => mail.push(m), getRemainingDailyQuota: () => 100 },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  CacheService: { getScriptCache: () => ({ get: k => cacheStore[k] ?? null, put: (k, v) => { cacheStore[k] = v; } }) },
  Utilities: { getUuid: () => randomUUID(), formatDate: fmt },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ setMimeType: () => ({ text: t }) }) },
  HtmlService: { createHtmlOutput: h => ({ setTitle: () => ({ html: h }) }) },
  UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(omResponse) }) },
});
vm.runInContext(fs.readFileSync(new URL('../alerts/Code.gs', import.meta.url), 'utf8'), ctx);
const G = name => vm.runInContext(name, ctx);
const plain = x => JSON.parse(JSON.stringify(x));   // vm arrays have their own prototype
const SITES = G('SITES'), CONFIG = G('CONFIG'), LEVELS = G('LEVELS');

// ---------- 1. flyable-hour rules on synthetic data
function synth(hours) {   // hours: [{time, shf, hpbl, spd, dir}]
  const h = { time: [], temperature_2m: [], sensible_heat_flux: [], boundary_layer_height: [], surface_pressure: [],
    wind_speed_80m: [], wind_direction_80m: [] };
  for (const p of LEVELS) { h[`geopotential_height_${p}hPa`] = []; h[`wind_speed_${p}hPa`] = []; h[`wind_direction_${p}hPa`] = []; }
  for (const x of hours) {
    h.time.push(x.time); h.temperature_2m.push(25); h.sensible_heat_flux.push(x.shf); h.boundary_layer_height.push(x.hpbl);
    h.surface_pressure.push(930); h.wind_speed_80m.push(x.spd); h.wind_direction_80m.push(x.dir);
    for (const p of LEVELS) {   // same wind at every level, heights spaced around the launch
      h[`geopotential_height_${p}hPa`].push(100 + (1000 - p) * 9);
      h[`wind_speed_${p}hPa`].push(x.spd); h[`wind_direction_${p}hPa`].push(x.dir);
    }
  }
  return { elevation: 687, hourly: h, daily: { time: ['2026-10-12'], sunrise: ['2026-10-12T07:12'], sunset: ['2026-10-12T18:35'] } };
}
const evaluateHours = G('evaluateHours'), flyableDaysOf = G('flyableDays');
const flyableDays = (site, om, now) => flyableDaysOf(site, evaluateHours(site, om, now));
const ed = SITES['ed-levin'];
const good = { shf: 350, hpbl: 2000, spd: 10, dir: 240 };                     // SW 6 mph, strong lift
const om = synth([
  { time: '2026-10-12T06:00', ...good },                                         // before sunrise
  { time: '2026-10-12T12:00', ...good },                                         // flyable
  { time: '2026-10-12T13:00', ...good, dir: 60 },                                // NE: over the back
  { time: '2026-10-12T14:00', ...good, spd: 18 },                                // 11 mph: too windy
  { time: '2026-10-12T15:00', ...good, shf: 40, hpbl: 300 },                     // weak: no lift above launch
  { time: '2026-10-12T15:30', ...good, shf: 160, hpbl: 330 },                    // lift, but under 500 ft over launch
  { time: '2026-10-12T16:00', ...good, dir: 185 },                               // S: flyable
  { time: '2026-10-12T19:00', ...good },                                         // after sunset
]);
const days = flyableDays(ed, om, '2026-10-12T00:00');
assert.equal(days.length, 1);
assert.deepEqual(plain(days[0].hours.map(h => h.time)), ['12:00', '16:00'], 'only the flyable hours');
assert.ok(days[0].hours.every(h => h.gainFt >= 500), 'every alert hour is 500+ ft over launch');
assert.match(days[0].summary, /^Ed Levin looks flyable Mon Oct 12, 12:00–16:00 \(top of lift up to [\d,]+ ft\)$/);
assert.deepEqual(plain(flyableDays(ed, om, '2026-10-12T13:00')[0].hours.map(h => h.time)), ['16:00'], 'past hours skipped');

// ---------- 2. same TOL and launch wind as the web app, on the live HRRR forecast
const get = url => new Promise((res, rej) => https.get(url, r => { let b = ''; r.on('data', c => (b += c)); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
const hourly = ['temperature_2m', 'sensible_heat_flux', 'boundary_layer_height', 'surface_pressure', 'wind_speed_80m', 'wind_direction_80m'];
for (const p of LEVELS) hourly.push(`geopotential_height_${p}hPa`, `wind_speed_${p}hPa`, `wind_direction_${p}hPa`);
const live = await get(`https://api.open-meteo.com/v1/forecast?latitude=${ed.lat}&longitude=${ed.lon}&models=ncep_hrrr_conus&forecast_days=2&timezone=auto&wind_speed_unit=kmh&hourly=${hourly.join(',')}&daily=sunrise,sunset`);
let compared = 0;
live.hourly.time.forEach((t, i) => {
  const h = live.hourly;
  if (h.temperature_2m[i] == null) return;
  const windLevels = LEVELS.map(p => ({ z: h[`geopotential_height_${p}hPa`][i], spd: h[`wind_speed_${p}hPa`][i], dir: h[`wind_direction_${p}hPa`][i] }))
    .filter(l => l.z != null && l.spd != null && l.dir != null).sort((a, b) => a.z - b.z);
  const hour = { t2: h.temperature_2m[i], shf: h.sensible_heat_flux[i], hpbl: h.boundary_layer_height[i], psfc: h.surface_pressure[i], levels: [], windLevels };
  const web = computeHour(hour, live.elevation, { k: CONFIG.k, sink: CONFIG.sinkMs, ziMethod: 'model' });
  const zi = hour.hpbl || 0;
  const tolGs = live.elevation + G('critRatio_')(G('wstar_')(hour.shf, zi, hour.t2, hour.psfc), CONFIG.k, CONFIG.sinkMs) * zi;
  assert.ok(Math.abs(web.tol - tolGs) < 0.5, `TOL mismatch at ${t}: ${web.tol} vs ${tolGs}`);
  const wWeb = launchWind(hour, ed.launchAlt), wGs = G('launchWind_')(h, i, ed.launchAlt);
  assert.ok(Math.abs(wWeb.spd - wGs.spd) < 0.01 && Math.abs(((wWeb.dir - wGs.dir + 540) % 360) - 180) < 0.1, `wind mismatch at ${t}`);
  compared++;
});
assert.ok(compared > 20, `compared ${compared} live hours`);
const liveDays = flyableDays(ed, live, live.hourly.time[0]);
console.log(`live HRRR: ${compared} hours agree with the web app; flyable days now: ${liveDays.map(d => d.summary).join(' | ') || 'none'}`);

// ---------- 3. sign-up, confirm, alert, unsubscribe
const post = body => JSON.parse(G('doPost')({ postData: { contents: JSON.stringify(body) } }).text);
G('setup')();
assert.equal(post({ email: 'bad', sites: ['ed-levin'] }).ok, false, 'invalid email rejected');
assert.equal(post({ email: 'a@b.co', sites: ['nowhere'] }).ok, false, 'unknown site rejected');
assert.equal(post({ email: 'bot@spam.co', sites: ['ed-levin'], website: 'x' }).ok, true);
assert.equal(mail.length, 0, 'honeypot: no email sent');
assert.equal(post({ email: 'Pilot@Example.com', sites: ['ed-levin', 'mission-peak'] }).ok, true);
assert.equal(mail.length, 1, 'confirmation sent');
assert.equal(mail[0].to, 'pilot@example.com');
post({ email: 'pilot@example.com', sites: ['ed-levin'] });
assert.equal(mail.length, 1, 'no second confirmation within 24 h');
const subs = sheets.subscribers.rows;
assert.equal(subs[1][2], 'pending');
const token = subs[1][3];
assert.ok(mail[0].body.includes(`action=confirm&token=${token}`));
assert.ok(G('doGet')({ parameter: { action: 'confirm', token } }).html.includes('Confirm my alerts'), 'confirm page has a button');
assert.equal(subs[1][2], 'pending', 'opening the link alone does not confirm');
G('act')('confirm', token);
assert.equal(subs[1][2], 'active');

// Same day, but the wind has gone over the back (NE) every hour.
const omBad = synth(['06:00', '12:00', '13:00', '14:00', '15:00', '15:30', '16:00', '19:00']
  .map(t => ({ time: `2026-10-12T${t}`, ...good, dir: 60 })));
const run = (forecast, utc) => { omResponse = forecast; fakeNow = Date.parse(utc); const n = mail.length; G('checkAndAlert')(); return mail.slice(n); };
const AM = '2026-10-12T16:30:00Z';                                 // 09:30 PDT, inside send hours
const status = () => plain(sheets.alerts.rows.slice(1).map(r => `${r[0]}:${r[2]}:${r[3]}`));

let got = run(om, AM);
assert.equal(got.length, 2, 'one alert per subscribed site');
assert.ok(got[0].subject.startsWith('Ed Levin looks flyable') && got[0].body.includes('Unsubscribe: '));
assert.ok(got[0].body.includes('?site=ed-levin'), 'deep link to the site');
assert.equal(run(om, AM).length, 0, 'still flyable: no second alert');

got = run(omBad, AM);
assert.equal(got.length, 2, 'cancellation per site when it turns unflyable');
assert.match(got[0].subject, /^Cancelled: Ed Levin no longer looks flyable Mon Oct 12$/);
assert.ok(got[0].body.includes('Best remaining hour now:') && got[0].body.includes('wind NE'), 'says why');
assert.ok(got[0].body.includes('one more email'), 'mentions a possible back-on email');
assert.deepEqual(status(), ['ed-levin:cancelled:2', 'mission-peak:cancelled:2']);
assert.equal(run(omBad, AM).length, 0, 'no repeated cancellation');

got = run(om, AM);
assert.equal(got.length, 2, 'back on when flyable again');
assert.ok(got[0].subject.startsWith('Back on: Ed Levin looks flyable'));
assert.equal(run(omBad, AM).length, 0, 'capped at 3 emails per site and day');

// A day whose flyable window has already passed is not "cancelled".
sheets.alerts.rows.splice(1);
assert.equal(run(om, AM).length, 2);
assert.equal(run(omBad, '2026-10-13T00:30:00Z').length, 0, '17:30 PDT: window (until 16:00) is over, no cancellation');

// Unsubscribed people get no cancellation.
G('act')('unsubscribe', token);
assert.equal(subs[1][2], 'unsubscribed');
sheets.alerts.rows.splice(1);
G('act')('confirm', token);
assert.equal(run(om, AM).length, 2);
G('act')('unsubscribe', token);
assert.equal(run(omBad, AM).length, 0, 'unsubscribed: no cancellation');

// Quiet hours.
G('act')('confirm', token);
sheets.alerts.rows.splice(1);
assert.equal(run(om, '2026-10-12T05:00:00Z').length, 0, 'no alerts at 22:00');

// A sheet made by the previous version (old header row, no data) is upgraded in place.
sheets.alerts.rows.splice(0, sheets.alerts.rows.length, ['site', 'date', 'sentAt', 'recipients', 'summary']);
G("sheet_('alerts', ALERT_HEADERS)");
assert.deepEqual(plain(sheets.alerts.rows[0]), plain(G('ALERT_HEADERS')), 'header row upgraded');

console.log('alerts tests passed');
