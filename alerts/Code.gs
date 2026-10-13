/**
 * Top of Lift: email alert backend (Google Apps Script bound to a Google Sheet).
 *
 * - doPost: sign-up from the web page. Stores the address as "pending" and sends a confirmation
 *   email (double opt-in), so nobody can be subscribed without clicking the link themselves.
 * - doGet: confirm / unsubscribe pages. Each one needs a button press, so link scanners that
 *   prefetch email links don't confirm or unsubscribe people.
 * - checkAndAlert: hourly trigger. Fetches the HRRR forecast for each site with subscribers and
 *   emails them when a day looks flyable (top of lift 500+ ft above launch, launch wind S/SW/W
 *   under 10 mph), a cancellation if it stops looking flyable, and one "back on" if it recovers.
 *
 * Setup steps are in alerts/README.md.
 */

const CONFIG = {
  appUrl: 'https://zjusbo.github.io/top-of-lift/',
  senderName: 'Top of Lift alerts',
  k: 1.6,                       // keep in sync with THERMAL in js/app.js
  sinkMs: 1.3,
  minGainFt: 500,               // top of lift must be at least this far above launch
  sendHours: [6, 21],           // only send alerts between these local hours
  maxConfirmationsPerHour: 20,  // abuse guard for the sign-up endpoint
};

// Keep in sync with DEFAULT_SITES in js/app.js.
const SITES = {
  'ed-levin': {
    name: 'Ed Levin', lat: 37.476, lon: -121.861, launchAlt: 693, tz: 'America/Los_Angeles',
    dirs: ['S', 'SW', 'W'], maxWindMph: 10,
  },
  'mission-peak': {
    name: 'Mission Peak', lat: 37.518, lon: -121.892, launchAlt: 585, tz: 'America/Los_Angeles',
    dirs: ['S', 'SW', 'W'], maxWindMph: 10,
  },
};

const SUB_HEADERS = ['email', 'sites', 'status', 'token', 'created', 'confirmed', 'lastConfirmationSent'];
const ALERT_HEADERS = ['site', 'date', 'status', 'notices', 'windowEnd', 'recipients', 'lastNoticeAt', 'summary'];
const LEVELS = [1000, 975, 950, 925, 900, 875, 850, 825, 800, 775, 750, 700];

// ---------------------------------------------------------------- setup

/** Run once from the editor: creates the sheets and the hourly trigger. */
function setup() {
  sheet_('subscribers', SUB_HEADERS);
  sheet_('alerts', ALERT_HEADERS);
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'checkAndAlert') ScriptApp.deleteTrigger(t);
  }
  ScriptApp.newTrigger('checkAndAlert').timeBased().everyHours(1).create();
}

// ---------------------------------------------------------------- sign-up

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_(false, 'Bad request.'); }
  // Same reply whether or not the address is already known, so the form can't be used to
  // find out who is subscribed.
  const generic = 'Thanks! If this address isn\'t subscribed yet, a confirmation email is on its way. ' +
    'Click the link in it to start alerts (check your spam folder too).';
  if (body.website) return json_(true, generic);   // honeypot filled: a bot

  const email = String(body.email || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return json_(false, 'Please enter a valid email address.');
  }
  const sites = (Array.isArray(body.sites) ? body.sites : []).filter(id => SITES[id]);
  if (!sites.length) return json_(false, 'Pick at least one site.');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = sheet_('subscribers', SUB_HEADERS);
    const rows = sh.getDataRange().getValues();
    const r = rows.findIndex((row, i) => i > 0 && row[0] === email);
    const now = new Date();
    if (r > 0 && rows[r][2] === 'active') return json_(true, generic);
    if (r > 0 && rows[r][6] && now - new Date(rows[r][6]) < 24 * 3600e3) return json_(true, generic);
    if (!takeConfirmationSlot_()) return json_(false, 'Too many sign-ups right now. Please try again in an hour.');

    const token = Utilities.getUuid();
    const values = [email, sites.join(','), 'pending', token, r > 0 ? rows[r][4] : now, '', now];
    if (r > 0) sh.getRange(r + 1, 1, 1, values.length).setValues([values]);
    else sh.appendRow(values);
    sendConfirmation_(email, sites, token);
    return json_(true, generic);
  } finally {
    lock.releaseLock();
  }
}

function takeConfirmationSlot_() {
  const cache = CacheService.getScriptCache();
  const n = Number(cache.get('confirmations') || 0);
  if (n >= CONFIG.maxConfirmationsPerHour) return false;
  cache.put('confirmations', String(n + 1), 3600);
  return true;
}

function sendConfirmation_(email, sites, token) {
  const url = `${ScriptApp.getService().getUrl()}?action=confirm&token=${token}`;
  const names = sites.map(id => SITES[id].name).join(' and ');
  MailApp.sendEmail({
    to: email,
    name: CONFIG.senderName,
    subject: 'Confirm your Top of Lift alerts',
    body: `Someone (hopefully you) asked for flyable-day alerts for ${names}.\n\n` +
      `Confirm here: ${url}\n\nIf this wasn't you, ignore this email and nothing will be sent.`,
    htmlBody: `<p>Someone (hopefully you) asked for flyable-day alerts for <b>${names}</b>.</p>` +
      `<p><a href="${url}">Confirm my alerts</a></p>` +
      '<p style="color:#666">If this wasn\'t you, ignore this email and nothing will be sent.</p>',
  });
}

// ---------------------------------------------------------------- confirm / unsubscribe pages

function doGet(e) {
  const action = e.parameter.action;
  const token = e.parameter.token || '';
  if (!['confirm', 'unsubscribe'].includes(action) || !/^[0-9a-f-]{36}$/.test(token)) {
    return page_('Top of Lift alerts', `<p>Nothing to do here. <a href="${CONFIG.appUrl}">Open Top of Lift</a>.</p>`);
  }
  const verb = action === 'confirm' ? 'Confirm my alerts' : 'Unsubscribe';
  // The action runs only when the button is pressed (google.script.run), never on page load.
  return page_('Top of Lift alerts',
    `<p>${action === 'confirm' ? 'One more click to start your flyable-day alerts.' : 'Stop all Top of Lift alert emails to this address?'}</p>` +
    `<button id="go" onclick="this.disabled=true;google.script.run.withSuccessHandler(function(m){document.getElementById('out').textContent=m}).act('${action}','${token}')">${verb}</button>` +
    '<p id="out"></p>');
}

/** Called from the confirm/unsubscribe page. */
function act(action, token) {
  if (!['confirm', 'unsubscribe'].includes(action)) return 'Unknown action.';
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = sheet_('subscribers', SUB_HEADERS);
    const rows = sh.getDataRange().getValues();
    const r = rows.findIndex((row, i) => i > 0 && row[3] === token);
    if (r < 1) return 'This link has expired. Sign up again on the Top of Lift page.';
    if (action === 'confirm') {
      sh.getRange(r + 1, 3).setValue('active');
      sh.getRange(r + 1, 6).setValue(new Date());
      return 'You\'re subscribed. You\'ll get an email when a launch looks flyable.';
    }
    sh.getRange(r + 1, 3).setValue('unsubscribed');
    return 'You\'re unsubscribed. No more alert emails will be sent.';
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------- hourly check

/**
 * Hourly trigger. Per site and day, the `alerts` tab tracks what subscribers were told:
 *   new flyable day          -> "flyable" email, status sent
 *   sent, no flyable hour left before the alerted window ends -> "cancelled" email
 *   cancelled, flyable again -> "back on" email, status sent
 * At most MAX_NOTICES emails per site and day, so a flip-flopping forecast can't spam anyone.
 */
function checkAndAlert() {
  const subs = sheet_('subscribers', SUB_HEADERS).getDataRange().getValues().slice(1)
    .filter(r => r[2] === 'active')
    .map(r => ({ email: r[0], sites: String(r[1]).split(','), token: r[3] }));
  const alertSheet = sheet_('alerts', ALERT_HEADERS);
  const records = {};   // `${site}|${date}` -> {row, status, notices, windowEnd, recipients}
  alertSheet.getDataRange().getValues().slice(1).forEach((r, i) => {
    records[`${r[0]}|${dateKey_(r[1])}`] = {
      row: i + 2, status: r[2], notices: Number(r[3]) || 0,
      windowEnd: String(r[4]).replace(/^'/, ''), recipients: String(r[5] || '').split(',').filter(Boolean),
    };
  });

  for (const id of Object.keys(SITES)) {
    const site = SITES[id];
    const audience = subs.filter(s => s.sites.includes(id));
    if (!audience.length) continue;
    const localHour = Number(Utilities.formatDate(new Date(), site.tz, 'H'));
    if (localHour < CONFIG.sendHours[0] || localHour >= CONFIG.sendHours[1]) continue;

    let om;
    try { om = fetchForecast_(site); } catch (err) { console.warn(`${site.name}: forecast failed: ${err}`); continue; }
    const nowLocal = Utilities.formatDate(new Date(), site.tz, "yyyy-MM-dd'T'HH:00");
    const hours = evaluateHours(site, om, nowLocal);
    const days = flyableDays(site, hours);
    const flyableDates = new Set(days.map(d => d.date));

    // New flyable days, and cancelled days that are flyable again.
    for (const day of days) {
      const key = `${id}|${day.date}`, rec = records[key];
      if (rec && (rec.status === 'sent' || rec.notices >= MAX_NOTICES)) {
        if (rec.status === 'sent') updateAlert_(alertSheet, rec, { windowEnd: day.hours[day.hours.length - 1].time });
        continue;
      }
      if (!hasQuota_(audience.length)) return;
      const kind = rec ? 'back' : 'new';
      for (const s of audience) sendAlert_(s, id, site, day, kind);
      const fields = { status: 'sent', notices: (rec ? rec.notices : 0) + 1, windowEnd: day.hours[day.hours.length - 1].time,
        recipients: audience.map(s => s.email), summary: day.summary };
      if (rec) updateAlert_(alertSheet, rec, fields);
      else {
        alertSheet.appendRow(alertRow_(id, day.date, fields));
        records[key] = Object.assign({ row: alertSheet.getLastRow() }, fields);
      }
    }

    // Alerted days that are no longer flyable, while the alerted window hasn't passed.
    for (const key of Object.keys(records)) {
      const rec = records[key], [recSite, date] = key.split('|');
      if (recSite !== id || rec.status !== 'sent' || flyableDates.has(date)) continue;
      if (`${date}T${rec.windowEnd}` < nowLocal || !(om.daily && om.daily.time.includes(date))) continue;
      if (rec.notices >= MAX_NOTICES) continue;
      const recipients = audience.filter(s => rec.recipients.includes(s.email));   // still subscribed
      if (!hasQuota_(recipients.length)) return;
      const best = bestHour(hours, date);
      for (const s of recipients) sendCancel_(s, id, site, date, best, rec.notices + 1 < MAX_NOTICES);
      updateAlert_(alertSheet, rec, { status: 'cancelled', notices: rec.notices + 1 });
    }
  }
}

const MAX_NOTICES = 3;   // flyable, cancelled, back on

function alertRow_(id, date, f) {
  // Leading ' keeps dates and times as text instead of Sheets date/time values.
  return [id, `'${date}`, f.status, f.notices, `'${f.windowEnd}`, f.recipients.join(','), new Date(), f.summary];
}

function updateAlert_(sheet, rec, fields) {
  Object.assign(rec, fields);
  const cols = { status: 3, notices: 4, windowEnd: 5, recipients: 6, summary: 8 };
  for (const k of Object.keys(fields)) {
    const v = k === 'recipients' ? fields[k].join(',') : k === 'windowEnd' ? `'${fields[k]}` : fields[k];
    sheet.getRange(rec.row, cols[k]).setValue(v);
  }
  if (fields.status) sheet.getRange(rec.row, 7).setValue(new Date());
}

function hasQuota_(n) {
  if (MailApp.getRemainingDailyQuota() >= n) return true;
  console.warn('Daily email quota reached.');
  return false;
}

function fetchForecast_(site) {
  const hourly = ['temperature_2m', 'sensible_heat_flux', 'boundary_layer_height', 'surface_pressure',
    'wind_speed_80m', 'wind_direction_80m'];
  for (const p of LEVELS) hourly.push(`geopotential_height_${p}hPa`, `wind_speed_${p}hPa`, `wind_direction_${p}hPa`);
  const url = 'https://api.open-meteo.com/v1/forecast?' + [
    `latitude=${site.lat}`, `longitude=${site.lon}`, 'models=ncep_hrrr_conus', 'forecast_days=2',
    'timezone=auto', 'wind_speed_unit=kmh', `hourly=${hourly.join(',')}`, 'daily=sunrise,sunset',
  ].join('&');
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error(`Open-Meteo HTTP ${res.getResponseCode()}`);
  return JSON.parse(res.getContentText());
}

const FOOTER_TEXT = 'HRRR model forecast, not a guarantee. Check conditions and airspace before you fly.';

function sendAlert_(sub, id, site, day, kind) {
  const appLink = `${CONFIG.appUrl}?site=${id}`;
  const unsub = `${ScriptApp.getService().getUrl()}?action=unsubscribe&token=${sub.token}`;
  const subject = kind === 'back' ? `Back on: ${day.summary}` : day.summary;
  const lines = day.hours.map(h =>
    `${h.time}  top of lift ${fmtFt_(h.tolFt)} (+${fmtFt_(h.gainFt)} over launch), wind ${h.dir} ${Math.round(h.mph)} mph`);
  MailApp.sendEmail({
    to: sub.email,
    name: CONFIG.senderName,
    subject,
    body: `${subject}\n\n${lines.join('\n')}\n\nForecast: ${appLink}\n${FOOTER_TEXT}\n` +
      'If the forecast turns unflyable, you\'ll get a cancellation email.\n\n' +
      `Unsubscribe: ${unsub}`,
    htmlBody: `<p><b>${subject}</b></p><table cellpadding="4" style="border-collapse:collapse">` +
      day.hours.map(h => `<tr><td>${h.time}</td><td>top of lift <b>${fmtFt_(h.tolFt)}</b> (+${fmtFt_(h.gainFt)} over launch)</td>` +
        `<td>wind ${h.dir} ${Math.round(h.mph)} mph</td></tr>`).join('') +
      `</table><p><a href="${appLink}">Open the forecast</a></p>` +
      `<p style="color:#666">${FOOTER_TEXT} If the forecast turns unflyable, you'll get a cancellation email.</p>` +
      `<p style="color:#666;font-size:12px"><a href="${unsub}">Unsubscribe</a></p>`,
  });
}

function sendCancel_(sub, id, site, date, best, mayComeBack) {
  const appLink = `${CONFIG.appUrl}?site=${id}`;
  const unsub = `${ScriptApp.getService().getUrl()}?action=unsubscribe&token=${sub.token}`;
  const subject = `Cancelled: ${site.name} no longer looks flyable ${dayLabel_(date)}`;
  const rule = `top of lift ${CONFIG.minGainFt}+ ft above launch, launch wind ${site.dirs.join('/')} under ${site.maxWindMph} mph`;
  const why = best
    ? `Best remaining hour now: ${best.time}, ${best.gainFt > 0 ? `top of lift ${fmtFt_(best.tolFt)} (+${fmtFt_(best.gainFt)} over launch)` : 'no usable lift above launch'}, wind ${best.dir} ${Math.round(best.mph)} mph.`
    : '';
  const next = mayComeBack ? 'If it turns flyable again, you\'ll get one more email.' : 'No more emails will be sent about this day.';
  MailApp.sendEmail({
    to: sub.email,
    name: CONFIG.senderName,
    subject,
    body: `The latest HRRR forecast no longer has a flyable hour at ${site.name} on ${dayLabel_(date)} (${rule}).\n\n` +
      `${why}\n${next}\n\nForecast: ${appLink}\n\nUnsubscribe: ${unsub}`,
    htmlBody: `<p><b>${subject}</b></p>` +
      `<p>The latest HRRR forecast no longer has a flyable hour at ${site.name} on ${dayLabel_(date)} (${rule}).</p>` +
      (why ? `<p>${why}</p>` : '') + `<p>${next}</p><p><a href="${appLink}">Open the forecast</a></p>` +
      `<p style="color:#666;font-size:12px"><a href="${unsub}">Unsubscribe</a></p>`,
  });
}

// ---------------------------------------------------------------- forecast logic (pure; tested in Node)

/**
 * Daylight hours from `nowLocal` ("YYYY-MM-DDTHH:00", site time) onward, with what the alert rule
 * looks at: [{date, time, tolFt, gainFt, dir, mph, flyable}]. Flyable = top of lift at least
 * CONFIG.minGainFt above launch and launch wind from an allowed direction under the wind limit.
 */
function evaluateHours(site, om, nowLocal) {
  const h = om.hourly, groundZ = om.elevation;
  const sun = {};
  (om.daily && om.daily.time || []).forEach((d, i) => { sun[d] = [om.daily.sunrise[i], om.daily.sunset[i]]; });
  const out = [];
  h.time.forEach((time, i) => {
    if (time < nowLocal || h.temperature_2m[i] == null) return;
    const date = time.slice(0, 10), daylight = sun[date];
    if (!daylight || time < daylight[0] || time > daylight[1]) return;
    const wind = launchWind_(h, i, site.launchAlt);
    if (!wind) return;

    const zi = h.boundary_layer_height[i] || 0;
    const ws = wstar_(h.sensible_heat_flux[i], zi, h.temperature_2m[i], h.surface_pressure[i]);
    const tol = groundZ + critRatio_(ws, CONFIG.k, CONFIG.sinkMs) * zi;
    const gainFt = (tol - site.launchAlt) * 3.28084;
    const mph = wind.spd * 0.621371;
    const dir = compass8_(wind.dir);
    out.push({
      date, time: time.slice(11, 16), tolFt: tol * 3.28084, gainFt, dir, mph,
      flyable: gainFt >= CONFIG.minGainFt && mph < site.maxWindMph && site.dirs.indexOf(dir) >= 0,
    });
  });
  return out;
}

/** Days with at least one flyable hour: [{date, hours, summary}]. */
function flyableDays(site, hours) {
  const byDate = {};
  for (const x of hours) if (x.flyable) (byDate[x.date] = byDate[x.date] || []).push(x);
  return Object.keys(byDate).sort().map(date => {
    const list = byDate[date];
    const best = Math.max.apply(null, list.map(x => x.tolFt));
    const span = list.length === 1 ? list[0].time : `${list[0].time}–${list[list.length - 1].time}`;
    return { date, hours: list, summary: `${site.name} looks flyable ${dayLabel_(date)}, ${span} (top of lift up to ${fmtFt_(best)})` };
  });
}

/** The remaining hour of `date` with the most lift above launch (for the cancellation email). */
function bestHour(hours, date) {
  return hours.filter(x => x.date === date).reduce((a, b) => (!a || b.gainFt > a.gainFt ? b : a), null);
}

function wstar_(shf, zi, t2, psfc) {
  if (!(shf > 0) || !(zi > 0) || t2 == null) return 0;
  const tk = t2 + 273.15;
  const rho = psfc ? (psfc * 100) / (287.05 * tk) : 1.1;
  return Math.cbrt((9.81 / tk) * (shf / (rho * 1005)) * zi);
}

function updraft_(r, ws, k) {
  if (r <= 0 || r >= 1 / 1.1) return 0;
  return k * ws * Math.cbrt(r) * (1 - 1.1 * r);
}

function critRatio_(ws, k, sink) {
  if (updraft_(1 / 4.4, ws, k) < sink) return 0;
  let lo = 1 / 4.4, hi = 1 / 1.1;
  for (let n = 0; n < 40; n++) {
    const mid = (lo + hi) / 2;
    if (updraft_(mid, ws, k) >= sink) lo = mid; else hi = mid;
  }
  return lo;
}

/** Wind (km/h, from-direction) at altitude z, interpolated between pressure levels; 80 m fallback. */
function launchWind_(h, i, z) {
  const pts = [];
  for (const p of LEVELS) {
    const lz = h[`geopotential_height_${p}hPa`] && h[`geopotential_height_${p}hPa`][i];
    const spd = h[`wind_speed_${p}hPa`] && h[`wind_speed_${p}hPa`][i];
    const dir = h[`wind_direction_${p}hPa`] && h[`wind_direction_${p}hPa`][i];
    if (lz != null && spd != null && dir != null) pts.push({ z: lz, spd, dir });
  }
  pts.sort((a, b) => a.z - b.z);
  if (!pts.length) {
    const spd = h.wind_speed_80m[i], dir = h.wind_direction_80m[i];
    return spd == null || dir == null ? null : { spd, dir };
  }
  if (z <= pts[0].z) return pts[0];
  for (let n = 1; n < pts.length; n++) {
    const a = pts[n - 1], b = pts[n];
    if (z <= b.z) {
      const f = (z - a.z) / (b.z - a.z);
      const rad = d => (d * Math.PI) / 180;
      const u = -(a.spd * Math.sin(rad(a.dir))) * (1 - f) - b.spd * Math.sin(rad(b.dir)) * f;
      const v = -(a.spd * Math.cos(rad(a.dir))) * (1 - f) - b.spd * Math.cos(rad(b.dir)) * f;
      return { spd: Math.hypot(u, v), dir: ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360 };
    }
  }
  return pts[pts.length - 1];
}

function compass8_(dir) {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(dir / 45) % 8];
}

// ---------------------------------------------------------------- helpers

function sheet_(name, headers) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  } else if (sh.getLastRow() <= 1 && sh.getDataRange().getValues()[0].join() !== headers.join()) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);   // sheet made by an older version
  }
  return sh;
}

function json_(ok, message) {
  return ContentService.createTextOutput(JSON.stringify({ ok, message })).setMimeType(ContentService.MimeType.JSON);
}

function page_(title, inner) {
  return HtmlService.createHtmlOutput(
    `<div style="font:15px system-ui,sans-serif;max-width:520px;margin:40px auto;padding:0 16px">` +
    `<h2>${title}</h2>${inner}</div>`).setTitle(title);
}

function dateKey_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, SpreadsheetApp.getActive().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  return String(v).replace(/^'/, '').slice(0, 10);
}

function dayLabel_(date) {
  return Utilities.formatDate(new Date(`${date}T12:00:00Z`), 'UTC', 'EEE MMM d');
}

function fmtFt_(ft) {
  return `${Math.round(ft).toLocaleString('en-US')} ft`;
}
