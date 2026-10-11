// App state and wiring between the sidebar, the point view and the map view.
import { MODELS, fetchPoint, fetchRunInfo, fetchAirspace, floorMsl, NEARBY_NM } from './data.js';
import { computeHour } from './physics.js';
import { renderPointChart, summaryText, legendHtml } from './point.js';
import { MapView } from './map.js';
import { initFeedback } from './feedback.js';
import { fmtAlt, dayLabel, el, fmtZoned, utcRunLabel, fmtRelative } from './format.js';

// Launch altitudes: Paragliding Earth takeoff altitude, cross-checked with USGS elevation.
const DEFAULT_SITES = [{
  id: 'ed-levin', name: 'Ed Levin', lat: 37.476, lon: -121.861,
  launchAlt: 693, faces: [180, 270], maxWind: 25,
  note: 'Top launch, 693 m (~2,270 ft). Faces S–W, SW best.',
}, {
  id: 'mission-peak', name: 'Mission Peak', lat: 37.518, lon: -121.892,
  launchAlt: 585, faces: [180, 270], maxWind: 25,
  note: 'Launch 585 m (~1,920 ft). Faces S–W, SW best.',
}];
// Fixed thermal model (see "How it's calculated" in index.html).
const THERMAL = { k: 1.6, sink: 1.3, ziMethod: 'model', excess: 0 };
const DEFAULT_SETTINGS = { alt: 'ft', wind: 'kmh' };

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: keep in memory */ }
  },
};

const state = {
  view: 'point',
  model: store.get('tol.model', 'hrrr'),
  settings: { ...DEFAULT_SETTINGS, ...store.get('tol.settings', {}) },
  customSites: store.get('tol.customSites', []),
  siteId: store.get('tol.siteId', 'ed-levin'),
  day: null,
  fc: null,
  mapStale: false,
};
if (!MODELS[state.model]) state.model = 'hrrr';

const $ = s => document.querySelector(s);
const sites = () => [...DEFAULT_SITES, ...state.customSites];
const site = () => sites().find(s => s.id === state.siteId) ?? DEFAULT_SITES[0];
const units = () => ({ alt: state.settings.alt, wind: state.settings.wind });

const effectiveOpts = () => THERMAL;

function setStatus(msg) {
  const box = $('#status');
  box.textContent = msg;
  box.hidden = !msg;
}

// ---------- Sidebar ----------

function renderModels() {
  $('#models').replaceChildren(...Object.entries(MODELS).map(([key, m]) => el('button', {
    'aria-pressed': String(key === state.model),
    onclick: () => {
      if (key === state.model) return;
      state.model = key;
      store.set('tol.model', key);
      renderModels();
      updateModelNote();
      state.mapStale = true;
      if (state.view === 'map') showMap(); else loadPoint();
    },
  }, m.label, el('small', {}, m.res))));
}

function updateModelNote() {
  const note = $('#model-note');
  const m = MODELS[state.model];
  note.hidden = m.profile;
  note.textContent = m.profile ? '' :
    `${m.label} on Open-Meteo has no upper-air levels: no wind arrows aloft, and launch wind uses the 80 m wind.`;
}

function renderSites() {
  const sel = $('#site-select');
  sel.replaceChildren(...sites().map(s => el('option', { value: s.id, selected: s.id === state.siteId }, s.name)));
  const s = site();
  $('#site-info').textContent = s.note ?? `${s.lat.toFixed(3)}, ${s.lon.toFixed(3)}`;
}

function selectSite(s) {
  if (!sites().some(x => x.id === s.id)) {
    s = { ...s, id: `custom-${s.lat.toFixed(4)}-${s.lon.toFixed(4)}` };
    if (!state.customSites.some(x => x.id === s.id)) {
      state.customSites = [...state.customSites, s].slice(-10);
      store.set('tol.customSites', state.customSites);
    }
  }
  state.siteId = s.id;
  store.set('tol.siteId', s.id);
  renderSites();
  setView('point');
}

function bindSettings() {
  const s = state.settings;
  $('#alt-unit').value = s.alt; $('#wind-unit').value = s.wind;

  const changed = () => {
    store.set('tol.settings', state.settings);
    renderPoint();
    mapView.recompute();
  };
  $('#alt-unit').addEventListener('change', e => { s.alt = e.target.value; changed(); });
  $('#wind-unit').addEventListener('change', e => { s.wind = e.target.value; changed(); });

  $('#site-select').addEventListener('change', e => selectSite(sites().find(x => x.id === e.target.value)));
  $('#custom-form').addEventListener('submit', e => {
    e.preventDefault();
    const m = $('#custom-latlon').value.match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/);
    if (!m || Math.abs(+m[1]) > 90 || Math.abs(+m[2]) > 180) { setStatus('Enter a point as "lat, lon".'); return; }
    selectSite({ name: `Point ${(+m[1]).toFixed(3)}, ${(+m[2]).toFixed(3)}`, lat: +m[1], lon: +m[2] });
  });
}

// ---------- Point view ----------

async function loadPoint() {
  const s = site();
  $('#point-title').textContent = s.name;
  $('#point-meta').textContent = 'Loading forecast…';
  state.fc = null;
  loadRunInfo();
  loadAirspace(s);
  try {
    const fc = await fetchPoint(s.lat, s.lon, state.model);
    if (site() !== s) return;  // site changed while loading
    state.fc = fc;
    setStatus('');
    const days = [...new Set(fc.hours.map(h => h.time.slice(0, 10)))];
    if (!days.includes(state.day)) state.day = days[0];
    $('#days').replaceChildren(...days.map(d => el('button', {
      class: `chip${d === state.day ? ' active' : ''}`,
      onclick: () => { state.day = d; loadDayChips(); renderPoint(); },
      'data-day': d,
    }, dayLabel(d))));
    renderPoint();
    renderRunInfo();   // timezone is known now
  } catch (err) {
    $('#point-meta').textContent = '';
    $('#chart').replaceChildren();
    setStatus(`Forecast failed: ${err.message}`);
  }
}

function loadDayChips() {
  document.querySelectorAll('#days .chip').forEach(c => c.classList.toggle('active', c.dataset.day === state.day));
}

function renderPoint() {
  const fc = state.fc;
  if (!fc || state.view !== 'point') return;
  const s = site(), m = MODELS[state.model], opts = effectiveOpts(), u = units();
  const rows = fc.hours.filter(h => h.time.startsWith(state.day))
    .map(hour => ({ hour, res: computeHour(hour, fc.elevation, opts) }));
  const sun = fc.sun[state.day];
  const air = overheadFloor(s, fc.elevation);
  const ctx = { site: s, groundZ: fc.elevation, units: u, k: opts.k, sink: opts.sink, sun, air };
  $('#sun-info').innerHTML = sun?.rise
    ? `☀︎ Sunrise <b>${sun.rise.slice(11, 16)}</b> · Sunset <b>${sun.set.slice(11, 16)}</b>` : '';
  $('#point-meta').textContent =
    `${m.label} ${m.res} · model point ${fc.lat.toFixed(3)}, ${fc.lon.toFixed(3)} · ground ${fmtAlt(fc.elevation, u.alt)} · ` +
    `k ${opts.k}, sink ${opts.sink} m/s`;
  renderPointChart($('#chart'), $('#tooltip'), rows, ctx);
  $('#summary').textContent = summaryText(rows.filter(r => +r.hour.time.slice(11, 13) >= 7), ctx);
  $('#legend').innerHTML = legendHtml(u);
  renderAirspaceInfo(s, fc.elevation, air);
}

// ---------- Airspace ----------

async function loadAirspace(s) {
  state.air = null;
  try {
    const data = await fetchAirspace(s.lat, s.lon);
    if (site() !== s) return;
    state.air = { siteId: s.id, data };
  } catch {
    state.air = { siteId: s.id, failed: true };
  }
  renderPoint();
}

/** Lowest Class B/C/D floor over the site whose ceiling is above the launch, as {name, cls, floorM}. */
function overheadFloor(s, groundZ) {
  if (state.air?.siteId !== s.id || !state.air.data) return null;
  const ref = s.launchAlt ?? groundZ;
  const ceilM = a => (a.ceiling.ref === 'MSL' ? 0 : groundZ) + a.ceiling.ft / 3.28084;
  const a = state.air.data.overhead.find(x => ceilM(x) > ref);
  return a ? { name: a.name, cls: a.cls, floorM: floorMsl(a, groundZ), ceilM: ceilM(a) } : null;
}

function renderAirspaceInfo(s, groundZ, air) {
  const box = $('#airspace-info');
  const u = units();
  if (state.air?.siteId !== s.id) { box.textContent = 'Checking airspace…'; return; }
  if (state.air.failed) { box.textContent = 'Airspace data unavailable right now.'; return; }
  const from = a => (a.floor.ref === 'SFC' ? 'the surface' : fmtAlt(floorMsl(a, groundZ), u.alt));
  const over = air
    ? `Airspace overhead: <b>${air.name}</b> ${air.floorM <= groundZ + 1 ? 'from the surface' : `from ${fmtAlt(air.floorM, u.alt)}`} to ${fmtAlt(air.ceilM, u.alt)} MSL.`
    : 'No Class B, C or D airspace overhead.';
  // Nearby airspace that starts lower than what is overhead: what a downwind drift runs into.
  const limitM = air?.floorM ?? Infinity;
  const byName = new Map();
  for (const a of state.air.data.nearby) {
    if (floorMsl(a, groundZ) >= limitM) continue;
    byName.set(a.name, [...(byName.get(a.name) ?? []), from(a)]);
  }
  const near = [...byName].map(([name, floors]) => `${name} from ${floors.join(' and ')}`).join('; ');
  box.innerHTML = `${over}${near ? ` Lower within ${NEARBY_NM} NM: ${near}.` : ''} <span class="src">FAA data; check the current sectional.</span>`;
}

// Model run info: when the data shown was produced and when the next run should land.
async function loadRunInfo() {
  const model = state.model;
  try {
    state.run = { model, info: await fetchRunInfo(model) };
  } catch {
    state.run = null;
  }
  if (state.model === model) renderRunInfo();
}

function renderRunInfo() {
  const box = $('#run-info');
  const run = state.run;
  if (!run || run.model !== state.model || state.view !== 'point') { box.hidden = true; return; }
  const m = MODELS[run.model], r = run.info;
  const tz = state.fc?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const untilNext = r.nextExpected - Date.now();
  const next = untilNext > -10 * 60_000
    ? `Next run <b>${utcRunLabel(r.nextInit)}</b> expected ~${fmtZoned(r.nextExpected, tz, { weekday: false })} (${fmtRelative(untilNext)})`
    : `<span class="due">Next run ${utcRunLabel(r.nextInit)} was due ${fmtRelative(untilNext)}. Reload to check.</span>`;
  box.innerHTML =
    `<span>${m.label} run <b>${utcRunLabel(r.init)}</b> (${fmtZoned(r.init, tz)}), ` +
    `published ${fmtZoned(r.available, tz, { weekday: false })}</span>` +
    `<span>${next}</span><span class="cadence">${m.cadence}</span>`;
  box.hidden = false;
}
setInterval(renderRunInfo, 60_000);   // keep "in N min" current

// ---------- Map view ----------

const mapView = new MapView($('#view-map'), {
  getSettings: effectiveOpts,
  getModel: () => state.model,
  getUnits: units,
  sites,
  onOpenPoint: s => selectSite(s),
  onStatus: setStatus,
});

function showMap() {
  const s = site();
  mapView.show([s.lat, s.lon], state.mapStale);
  state.mapStale = false;
}

// ---------- Views ----------

function setView(view) {
  state.view = view;
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === view)));
  $('#view-point').hidden = view !== 'point';
  $('#view-map').hidden = view !== 'map';
  document.querySelector('main').classList.toggle('map-mode', view === 'map');
  setStatus('');
  if (view === 'map') showMap(); else loadPoint();
}

document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderPoint, 150); });

initFeedback($('#feedback'));
renderModels();
renderSites();
bindSettings();
updateModelNote();
setView('point');
