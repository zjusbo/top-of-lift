// Units, colors and small DOM helpers shared by the views.

export const M_TO_FT = 3.28084;
const WIND = { kmh: [1, 'km/h'], mph: [0.621371, 'mph'], kt: [0.539957, 'kt'] };

export const altVal = (m, unit) => (unit === 'ft' ? m * M_TO_FT : m);
export const altFromDisplay = (v, unit) => (unit === 'ft' ? v / M_TO_FT : v);
export const fmtAlt = (m, unit) => `${Math.round(altVal(m, unit)).toLocaleString()} ${unit}`;
export const windVal = (kmh, unit) => kmh * WIND[unit][0];
export const windLabel = unit => WIND[unit][1];
export const fmtWind = (kmh, unit) => (kmh == null ? '–' : `${Math.round(windVal(kmh, unit))} ${windLabel(unit)}`);
export const fmtClimb = ms => `${ms.toFixed(1)} m/s (${Math.round(ms * 196.85)} fpm)`;
export const compass = dir => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(dir / 22.5) % 16];

/** TOL color bands: 1,000 ft or 300 m steps. Returns [{lo, color}] in metres. */
export function tolBands(unit) {
  const step = unit === 'ft' ? 1000 / M_TO_FT : 300;
  const n = 15;
  return Array.from({ length: n }, (_, i) => ({ lo: step * (i + 1), color: ramp(i / (n - 1)) }));
}
export function tolColor(m, bands) {
  let c = null;
  for (const b of bands) if (m >= b.lo) c = b.color;
  return c ?? bands[0].color;
}

// Low = purple/blue, high = orange/red, like XC Skies' TOL legend.
const STOPS = ['#6a3d9a', '#3b57c4', '#2b8fd6', '#25b3c9', '#2cbf8f', '#5cc23f', '#b5d230', '#f2cf2e', '#f3a326', '#ea6b21', '#d0311f'];
function ramp(t) {
  const x = t * (STOPS.length - 1), i = Math.min(Math.floor(x), STOPS.length - 2), f = x - i;
  const a = hex(STOPS[i]), b = hex(STOPS[i + 1]);
  return `rgb(${a.map((v, j) => Math.round(v + f * (b[j] - v))).join(',')})`;
}
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

export const CLIMB_STEPS = [
  { lo: 0, color: '#fff1b8', label: '0–0.5' }, { lo: 0.5, color: '#ffd166', label: '0.5–1' },
  { lo: 1, color: '#f9a03f', label: '1–1.5' }, { lo: 1.5, color: '#f3722c', label: '1.5–2' },
  { lo: 2, color: '#e63946', label: '2–3' }, { lo: 3, color: '#9d0208', label: '3+' },
];
export function climbColor(ms) {
  let c = null;
  for (const s of CLIMB_STEPS) if (ms >= s.lo) c = s.color;
  return c;
}

// Paraglider-relevant wind bands (km/h).
export const WIND_STEPS = [
  { lo: 0, color: '#2a9d8f' }, { lo: 10, color: '#52b788' }, { lo: 20, color: '#e9c46a' },
  { lo: 30, color: '#f4a261' }, { lo: 40, color: '#e63946' },
];
export function windColor(kmh) {
  let c = WIND_STEPS[0].color;
  for (const s of WIND_STEPS) if (kmh >= s.lo) c = s.color;
  return c;
}

/**
 * Launch suitability for a 10 m wind: 'good' | 'light' | 'cross' | 'bad', or null when the site has
 * no orientation. Under ~6 km/h direction hardly matters; thermal cycles decide.
 */
export function launchRating(site, wind) {
  if (!site?.faces || wind?.dir == null) return null;
  const [from, to] = site.faces;
  const span = (to - from + 360) % 360;
  const off = (wind.dir - from + 360) % 360;
  const outside = off <= span ? 0 : Math.min(off - span, 360 - off);
  if (wind.spd > (site.maxWind ?? 25)) return 'bad';
  if (outside === 0) return 'good';
  if (wind.spd < 6) return 'light';
  if (outside <= 45) return 'cross';
  return 'bad';
}

/** SVG arrow pointing downwind (meteorological dir = wind comes FROM). */
export function arrowSvg(dir, color, size = 16) {
  const r = size / 2;
  return `<svg width="${size}" height="${size}" viewBox="${-r} ${-r} ${size} ${size}" aria-hidden="true">` +
    `<g transform="rotate(${(dir + 180) % 360})"><line x1="0" y1="${r - 2}" x2="0" y2="${-r + 3}" stroke="${color}" stroke-width="2"/>` +
    `<path d="M0 ${-r + 1} L${-r / 2.2} ${-r / 4} L${r / 2.2} ${-r / 4} Z" fill="${color}"/></g></svg>`;
}

/** Clock time of a Date in a timezone, e.g. "Sat 19:00 PDT". */
export function fmtZoned(date, timeZone, { weekday = true, zone = true } = {}) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    ...(weekday && { weekday: 'short' }), ...(zone && { timeZoneName: 'short' }),
  }).format(date);
}
export const utcRunLabel = date => `${String(date.getUTCHours()).padStart(2, '0')}Z`;
export function fmtRelative(ms) {
  const min = Math.round(Math.abs(ms) / 60_000);
  const txt = min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
  return ms >= 0 ? `in ${txt}` : `${txt} ago`;
}

export const dayLabel = date => new Date(`${date}T12:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
export const hourOf = time => +time.slice(11, 13);

export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
}
