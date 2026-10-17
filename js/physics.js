// Thermal physics for Top of Usable Lift (TOL).
//
//   w*   = (g/T · H/(ρ·cp) · zi)^(1/3)                    Deardorff convective velocity
//   w(z) = k · w* · (z/zi)^(1/3) · (1 − 1.1·z/zi)         Lenschow profile (Allen 2006, NASA, Eq. 11)
//   TOL  = ground + highest z where w(z) ≥ glider sink
//
// k = 1 is Allen's area-averaged updraft (peak 0.45·w*); k = 2.2 makes the peak ≈ w*,
// matching RASP's "W* minus sink ≈ vario reading" reading (used by the SoarCalc Windy plugin).

const G = 9.81;
const CP = 1005;          // J/(kg·K)
const RD = 287.05;        // J/(kg·K)
const DALR = 0.0098;      // dry adiabatic lapse rate, K/m
const R_PEAK = 1 / 4.4;   // z/zi where the profile peaks
const R_ZERO = 1 / 1.1;   // z/zi where the profile reaches zero

/** Convective velocity scale w* (m/s). shf in W/m², zi in m, t2 in °C, psfc in hPa. */
export function wstar(shf, zi, t2, psfc) {
  if (!(shf > 0) || !(zi > 0) || t2 == null) return 0;
  const tk = t2 + 273.15;
  const rho = psfc ? (psfc * 100) / (RD * tk) : 1.1;
  return Math.cbrt((G / tk) * (shf / (rho * CP)) * zi);
}

/** Updraft at height ratio r = z/zi. */
export function updraft(r, ws, k) {
  if (r <= 0 || r >= R_ZERO) return 0;
  return k * ws * Math.cbrt(r) * (1 - 1.1 * r);
}

/** Highest z/zi where updraft ≥ sink, or 0 when thermals never beat the sink rate. */
export function critRatio(ws, k, sink) {
  if (updraft(R_PEAK, ws, k) < sink) return 0;
  let lo = R_PEAK, hi = R_ZERO;  // updraft is decreasing on this branch
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (updraft(mid, ws, k) >= sink) lo = mid; else hi = mid;
  }
  return lo;
}

/**
 * Height (m MSL) where a dry-adiabatic parcel starting at (groundZ, startT) meets the environment.
 * levels: [{z, t}] sorted by height, only those above ground are used.
 */
export function parcelTop(levels, groundZ, startT) {
  let prev = { z: groundZ, t: startT, tp: startT };
  for (const { z, t } of levels) {
    if (z == null || t == null || z <= groundZ + 10) continue;
    const tp = startT - DALR * (z - groundZ);
    if (tp <= t) {
      const d0 = prev.tp - prev.t, d1 = tp - t;
      const f = d0 - d1 !== 0 ? d0 / (d0 - d1) : 0;
      return prev.z + Math.max(0, Math.min(1, f)) * (z - prev.z);
    }
    prev = { z, t, tp };
  }
  return prev.z;  // never capped within the sounding
}

/** Cumulus base (m above ground) from surface temperature/dew point spread. */
export function cuBaseAgl(t2, td2) {
  if (t2 == null || td2 == null) return null;
  return Math.max(0, 125 * (t2 - td2));
}

/** Linear interpolation of a wind vector at height z from levels [{z, spd, dir}]. */
export function windAt(levels, z) {
  const pts = levels.filter(l => l.z != null && l.spd != null && l.dir != null);
  if (!pts.length) return null;
  if (z <= pts[0].z) return { spd: pts[0].spd, dir: pts[0].dir };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (z <= b.z) {
      const f = (z - a.z) / (b.z - a.z);
      const [ua, va] = toUV(a.spd, a.dir), [ub, vb] = toUV(b.spd, b.dir);
      return fromUV(ua + f * (ub - ua), va + f * (vb - va));
    }
  }
  const last = pts[pts.length - 1];
  return { spd: last.spd, dir: last.dir };
}

/**
 * Wind at launch altitude (m MSL): interpolated between pressure levels, or the 80 m wind for
 * models without upper-air levels. source is 'levels' or '80m'.
 */
export function launchWind(hour, alt) {
  if (hour.windLevels?.length) return { ...windAt(hour.windLevels, alt), source: 'levels' };
  if (hour.wind80?.dir != null) return { ...hour.wind80, source: '80m' };
  return null;
}

// Meteorological convention: dir is where the wind blows FROM.
function toUV(spd, dir) {
  const r = (dir * Math.PI) / 180;
  return [-spd * Math.sin(r), -spd * Math.cos(r)];
}
function fromUV(u, v) {
  return { spd: Math.hypot(u, v), dir: ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360 };
}

/**
 * Compute TOL and supporting numbers for one hour.
 * hour: {t2, td2, shf, hpbl, psfc, wind10: {spd, dir}, levels: [{z, t, spd, dir}]}
 * opts: {k, sink, ziMethod: 'model'|'parcel', excess}
 */
export function computeHour(hour, groundZ, opts) {
  const { k, sink, ziMethod, excess } = opts;
  let ziTop = null;  // BL top, m MSL
  if (ziMethod === 'parcel') {
    if (hour.t2 != null && hour.levels.some(l => l.t != null)) {
      ziTop = parcelTop(hour.levels, groundZ, hour.t2 + excess);
    }
  } else if (hour.hpbl != null) {
    ziTop = groundZ + hour.hpbl;
  }
  const zi = ziTop != null ? Math.max(0, ziTop - groundZ) : 0;
  const ws = wstar(hour.shf, zi, hour.t2, hour.psfc);
  const r = critRatio(ws, k, sink);
  const usable = r > 0;
  const tol = groundZ + r * zi;
  const cu = cuBaseAgl(hour.t2, hour.td2);
  return {
    ziTop: ziTop ?? groundZ,
    zi,
    wstar: ws,
    maxClimb: Math.max(0, updraft(R_PEAK, ws, k) - sink),
    usable,
    tol,                                  // m MSL (== ground when not usable)
    tolAgl: tol - groundZ,
    lcl: cu != null ? groundZ + cu : null,                 // cloud base if thermals reached it
    cuBase: cu != null && cu < zi ? groundZ + cu : null,   // only when Cu can form inside the BL
    windTol: usable ? windAt(hour.levels, tol) : null,
    climbAt: z => updraft((z - groundZ) / (zi || 1), ws, k) - sink,
  };
}
