// Open-Meteo data access.
// Free tier: non-commercial, 600 calls/min, 10k calls/day. A location costs
// max(1, vars/10) × max(1, days/14) calls, so the map asks for as few variables as it can.

// meta: Open-Meteo dataset whose run times we report (gfs_global blends GFS 0.11° and 0.25°;
// the 0.25° set carries the upper-air levels and is published last).
// cadence: NCEP run schedule (EMC / NCEP MAG product docs).
export const MODELS = {
  hrrr: { id: 'ncep_hrrr_conus', label: 'HRRR', res: '3 km', days: 2, profile: true, meta: 'ncep_hrrr_conus',
          cadence: 'New run every hour (18 h ahead); the 00/06/12/18Z runs go 48 h ahead.' },
  nam:  { id: 'ncep_nam_conus',  label: 'NAM', res: '3 km', days: 3, profile: false, meta: 'ncep_nam_conus',
          cadence: 'New run every 6 h (00/06/12/18Z), 60 h ahead.' },
  gfs:  { id: 'gfs_global',      label: 'GFS',  res: '13 km', days: 7, profile: true, meta: 'ncep_gfs025',
          cadence: 'New run every 6 h (00/06/12/18Z), 16 days ahead.' },
};

const POINT_LEVELS = [1000, 975, 950, 925, 900, 875, 850, 825, 800, 775, 750, 700, 650, 600, 550, 500];
const MAP_LEVELS = [925, 900, 850, 800, 750, 700, 650, 600, 550];   // enough to find a parcel top
// 80 m wind is the launch-wind fallback for models without upper-air levels (NAM).
const POINT_SURFACE = ['temperature_2m', 'dew_point_2m', 'sensible_heat_flux', 'boundary_layer_height',
  'surface_pressure', 'wind_speed_80m', 'wind_direction_80m'];
const MAP_SURFACE = ['temperature_2m', 'sensible_heat_flux', 'boundary_layer_height',
  'surface_pressure', 'wind_speed_10m', 'wind_direction_10m'];
const API = 'https://api.open-meteo.com/v1/forecast';
const CHUNK = 50;               // locations per request
const MINUTE_BUDGET = 500;      // stay under the 600 calls/min free limit

const CACHE_MS = 15 * 60_000;   // refetch after this, so an open page picks up new model runs
const cache = new Map();         // key -> {value, at}
const cached = key => {
  const e = cache.get(key);
  return e && Date.now() - e.at < CACHE_MS ? e.value : undefined;
};
const remember = (key, value) => { cache.set(key, { value, at: Date.now() }); return value; };
const spent = [];               // [{at, calls}] within the last minute
export let callsUsed = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const callWeight = (nLoc, nVars, days) => nLoc * Math.max(1, nVars / 10) * Math.max(1, days / 14);

/** Wait until `calls` more fits in the per-minute budget. */
async function throttle(calls, onWait) {
  for (;;) {
    const now = Date.now();
    while (spent.length && now - spent[0].at > 60_000) spent.shift();
    const used = spent.reduce((a, s) => a + s.calls, 0);
    if (used + calls <= MINUTE_BUDGET || !spent.length) return;
    const waitMs = 60_000 - (now - spent[0].at) + 250;
    onWait?.(Math.ceil(waitMs / 1000));
    await sleep(Math.min(waitMs, 5000));
  }
}

async function request(lats, lons, model, vars, days, onWait, daily = []) {
  const calls = callWeight(lats.length, vars.length + daily.length, days);
  await throttle(calls, onWait);
  const q = new URLSearchParams({
    latitude: lats.map(v => v.toFixed(4)).join(','),
    longitude: lons.map(v => v.toFixed(4)).join(','),
    models: model.id, forecast_days: days, timezone: 'auto', wind_speed_unit: 'kmh',
    hourly: vars.join(','),
  });
  if (daily.length) q.set('daily', daily.join(','));
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}?${q}`);
    const body = await res.json();
    spent.push({ at: Date.now(), calls });
    if (res.status === 429 && attempt === 0) {   // someone else used our IP's budget: wait once
      onWait?.(61);
      await sleep(61_000);
      continue;
    }
    if (!res.ok || body.error) throw new Error(body.reason || `Open-Meteo HTTP ${res.status}`);
    callsUsed += calls;
    return Array.isArray(body) ? body : [body];
  }
}

function hourlyVars(model, surface, levels, withWind) {
  const vars = [...surface];
  if (model.profile && levels) {
    for (const p of levels) vars.push(`geopotential_height_${p}hPa`, `temperature_${p}hPa`);
    if (withWind) for (const p of levels) vars.push(`wind_speed_${p}hPa`, `wind_direction_${p}hPa`);
  }
  return vars;
}

/** Convert one Open-Meteo location response into per-hour records the physics module understands. */
function parse(loc, levelsAsked) {
  const h = loc.hourly;
  const col = name => h[name] || [];
  const hours = h.time.map((time, i) => {
    const all = [];
    for (const p of levelsAsked) {
      const z = col(`geopotential_height_${p}hPa`)[i];
      if (z == null) continue;
      all.push({
        p, z,
        t: col(`temperature_${p}hPa`)[i] ?? null,
        spd: col(`wind_speed_${p}hPa`)[i] ?? null,
        dir: col(`wind_direction_${p}hPa`)[i] ?? null,
      });
    }
    all.sort((a, b) => a.z - b.z);
    // Thermal physics and the chart use only levels above the point's ground. Levels a little
    // below it are still above the model's smoothed 3 km terrain, so the launch-altitude wind
    // interpolates across all of them.
    const levels = all.filter(l => l.z > loc.elevation);
    return {
      time,
      t2: col('temperature_2m')[i] ?? null,
      td2: col('dew_point_2m')[i] ?? null,
      shf: col('sensible_heat_flux')[i] ?? null,
      hpbl: col('boundary_layer_height')[i] ?? null,
      psfc: col('surface_pressure')[i] ?? null,
      wind10: { spd: col('wind_speed_10m')[i] ?? null, dir: col('wind_direction_10m')[i] ?? null },
      wind80: { spd: col('wind_speed_80m')[i] ?? null, dir: col('wind_direction_80m')[i] ?? null },
      levels,
      windLevels: all.filter(l => l.spd != null && l.dir != null),
    };
  }).filter(r => r.t2 != null);   // trailing hours past the model horizon come back null
  // Sunrise/sunset per local date, as "YYYY-MM-DDTHH:MM" in the location's timezone.
  const sun = {};
  (loc.daily?.time ?? []).forEach((date, i) => {
    sun[date] = { rise: loc.daily.sunrise?.[i] ?? null, set: loc.daily.sunset?.[i] ?? null };
  });
  return { lat: loc.latitude, lon: loc.longitude, elevation: loc.elevation, timezone: loc.timezone,
           hasProfile: hours.some(r => r.levels.length), hours, sun };
}

/** Full forecast (incl. wind profile) for one point. */
export function fetchPoint(lat, lon, modelKey) {
  const model = MODELS[modelKey];
  const key = `p|${modelKey}|${lat.toFixed(4)}|${lon.toFixed(4)}`;
  const hit = cached(key);
  if (hit) return hit;
  const levels = model.profile ? POINT_LEVELS : [];
  const vars = hourlyVars(model, POINT_SURFACE, levels, true);
  const p = request([lat], [lon], model, vars, model.days, undefined, ['sunrise', 'sunset'])
    .then(r => parse(r[0], levels));
  p.catch(() => cache.delete(key));
  return remember(key, p);
}

/**
 * Latest model run on Open-Meteo and when the next one should appear. Metadata calls are free.
 * Times are Date objects. nextExpected = next run's start + the delay the latest run took.
 */
export function fetchRunInfo(modelKey) {
  const model = MODELS[modelKey];
  const key = `meta|${model.meta}`;
  const hit = cached(key);
  if (hit) return hit;
  const p = fetch(`https://api.open-meteo.com/data/${model.meta}/static/meta.json`)
    .then(r => { if (!r.ok) throw new Error(`run info HTTP ${r.status}`); return r.json(); })
    .then(m => {
      const init = m.last_run_initialisation_time * 1000, avail = m.last_run_availability_time * 1000;
      const every = m.update_interval_seconds * 1000;
      return {
        init: new Date(init), available: new Date(avail), everyHours: every / 3_600_000,
        nextInit: new Date(init + every), nextExpected: new Date(avail + every),
      };
    });
  p.catch(() => cache.delete(key));
  return remember(key, p);
}

/**
 * Forecast for many points. Upper-air temperatures are only requested when the parcel
 * method needs them (withProfile), which roughly doubles the API cost.
 */
export async function fetchGrid(points, modelKey, withProfile, { onProgress, onWait } = {}) {
  const model = MODELS[modelKey];
  const days = Math.min(model.days, 3);
  const levels = withProfile && model.profile ? MAP_LEVELS : [];
  const vars = hourlyVars(model, MAP_SURFACE, levels, false);
  const out = new Array(points.length);
  const todo = [];
  points.forEach((pt, i) => {
    const key = `g|${modelKey}|${levels.length ? 'p' : 's'}|${pt.lat.toFixed(4)}|${pt.lon.toFixed(4)}`;
    const hit = cached(key);
    if (hit) out[i] = hit; else todo.push({ ...pt, i, key });
  });
  let done = points.length - todo.length;
  onProgress?.(done, points.length);
  for (let c = 0; c < todo.length; c += CHUNK) {
    const batch = todo.slice(c, c + CHUNK);
    const res = await request(batch.map(b => b.lat), batch.map(b => b.lon), model, vars, days, onWait);
    res.forEach((loc, j) => {
      out[batch[j].i] = remember(batch[j].key, parse(loc, levels));
    });
    done += batch.length;
    onProgress?.(done, points.length);
  }
  return out;
}

// ---------- Airspace (FAA AIS open data, Class_Airspace layer) ----------

const AIRSPACE_API = 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Class_Airspace/FeatureServer/0/query';
export const NEARBY_NM = 5;   // thermals drift; also report B/C/D this close to the site

const titleCase = s => (s ?? '').toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()).replace(/\bClass ([a-e])\b/i, (_, c) => `Class ${c.toUpperCase()}`);
const limit = (val, uom, code) => ({ ft: uom === 'FL' ? val * 100 : val, ref: code === 'SFC' ? 'SFC' : code === 'AGL' ? 'AGL' : 'MSL' });

/** Floor of an airspace in m MSL at a point whose ground is groundZ (m). */
export function floorMsl(a, groundZ) {
  if (a.floor.ref === 'SFC') return groundZ;
  return (a.floor.ref === 'AGL' ? groundZ : 0) + a.floor.ft / 3.28084;
}

/**
 * Class B, C and D airspace over a point (overhead) and within NEARBY_NM, each sorted by floor:
 * [{name, cls, floor: {ft, ref}, ceiling: {ft, ref}}]. US only; elsewhere both lists are empty.
 */
export function fetchAirspace(lat, lon) {
  const key = `air|${lat.toFixed(4)}|${lon.toFixed(4)}`;
  const hit = cached(key);
  if (hit) return hit;
  const query = async extra => {
    const q = new URLSearchParams({
      geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects', where: "CLASS IN ('B','C','D')",
      outFields: 'NAME,CLASS,LOWER_VAL,LOWER_UOM,LOWER_CODE,UPPER_VAL,UPPER_UOM,UPPER_CODE',
      returnGeometry: 'false', f: 'json', ...extra,
    });
    const res = await fetch(`${AIRSPACE_API}?${q}`);
    const body = await res.json();
    if (!res.ok || body.error) throw new Error(body.error?.message || `airspace HTTP ${res.status}`);
    const seen = new Set();
    return body.features.map(({ attributes: a }) => ({
      name: titleCase(a.NAME), cls: a.CLASS,
      floor: limit(a.LOWER_VAL, a.LOWER_UOM, a.LOWER_CODE),
      ceiling: limit(a.UPPER_VAL, a.UPPER_UOM, a.UPPER_CODE),
    })).filter(a => {
      const k = `${a.name}|${a.floor.ref}|${a.floor.ft}`;
      return !seen.has(k) && seen.add(k);
    }).sort((x, y) => (x.floor.ref === 'SFC' ? 0 : x.floor.ft) - (y.floor.ref === 'SFC' ? 0 : y.floor.ft));
  };
  const p = Promise.all([query({}), query({ distance: String(NEARBY_NM), units: 'esriSRUnit_NauticalMile' })])
    .then(([overhead, nearby]) => ({ overhead, nearby }));
  p.catch(() => cache.delete(key));
  return remember(key, p);
}
