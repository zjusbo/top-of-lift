// Single-point view: an hourly time-height chart ("windgram") for one site and day.
import {
  altVal, fmtAlt, fmtWind, fmtClimb, windVal, compass, climbColor, windColor, arrowSvg,
  launchRating, hourOf, CLIMB_STEPS, WIND_STEPS, windLabel, M_TO_FT,
} from './format.js';
import { launchWind } from './physics.js';

const RATING_COLOR = { good: '#d8f3dc', light: '#e8f1e9', cross: '#ffe8a3', bad: '#ffd6d6' };
const FIRST_HOUR = 7, LAST_HOUR = 20;

/**
 * rows: [{hour, res}] for the chosen day (res = computeHour output)
 * ctx: {site, groundZ, units: {alt, wind}, k, sink, sun: {rise, set},
 *       air: {name, cls, floorM} = lowest Class B/C/D floor overhead, or null}
 * The bottom strip shows wind at launch altitude (site.launchAlt, or ground for custom points).
 */
export function renderPointChart(root, tooltip, rows, ctx) {
  rows = rows.filter(r => hourOf(r.hour.time) >= FIRST_HOUR && hourOf(r.hour.time) <= LAST_HOUR);
  root.replaceChildren();
  if (!rows.length) {
    root.innerHTML = '<p class="empty">No forecast hours for this day from this model.</p>';
    return;
  }
  const { site, groundZ, units } = ctx;
  const W = Math.max(root.clientWidth || 900, 600), H = 560;
  const m = { l: 64, r: 18, t: 22, b: 92 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const n = rows.length, cw = pw / n;

  // Vertical range (m MSL): a little below ground to comfortably above the highest BL top.
  const ftStep = units.alt === 'ft' ? 1000 / M_TO_FT : 250;
  const air = ctx.air;
  const airInRange = air && air.floorM <= groundZ + 3000;   // don't squash the chart for a far-off floor
  const top = Math.max(...rows.map(r => Math.max(r.res.ziTop, r.res.tol)), site?.launchAlt ?? 0, groundZ,
    airInRange ? air.floorM : 0);
  const yMin = Math.max(0, Math.floor((groundZ - ftStep) / ftStep) * ftStep);
  let yMax = Math.ceil((Math.max(top, groundZ + 1200) + 500) / ftStep) * ftStep;
  yMax = Math.min(yMax, 6000);
  const y = z => m.t + ph - ((z - yMin) / (yMax - yMin)) * ph;
  const cx = i => m.l + (i + 0.5) * cw;

  const s = [];
  s.push(`<rect x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" class="plot-bg"/>`);

  // Altitude grid + labels.
  const tickStep = (yMax - yMin) / ftStep > 12 ? ftStep * 2 : ftStep;
  for (let z = Math.ceil(yMin / tickStep) * tickStep; z <= yMax + 1; z += tickStep) {
    s.push(`<line x1="${m.l}" x2="${m.l + pw}" y1="${y(z)}" y2="${y(z)}" class="grid"/>`);
    s.push(`<text x="${m.l - 8}" y="${y(z) + 4}" class="axis" text-anchor="end">${Math.round(altVal(z, units.alt)).toLocaleString()}</text>`);
  }
  s.push(`<text transform="translate(16 ${m.t + ph / 2}) rotate(-90)" class="axis-title" text-anchor="middle">Altitude MSL (${units.alt})</text>`);

  // Net climb shading inside the thermal layer.
  const dz = (yMax - yMin) / 90;
  rows.forEach(({ res }, i) => {
    if (res.wstar <= 0) return;
    for (let z = groundZ; z < res.ziTop; z += dz) {
      const c = climbColor(res.climbAt(z + dz / 2));
      if (c) s.push(`<rect x="${m.l + i * cw + 1}" y="${y(z + dz)}" width="${cw - 2}" height="${y(z) - y(z + dz) + 0.5}" fill="${c}"/>`);
    }
  });

  // Night shading and sunrise/sunset markers (ctx.sun = {rise, set} as local "YYYY-MM-DDTHH:MM").
  const hour0 = hourOf(rows[0].hour.time);
  const xAt = t => Math.max(m.l, Math.min(m.l + pw, cx(0) + (t - hour0) * cw));
  const frac = iso => (iso ? +iso.slice(11, 13) + +iso.slice(14, 16) / 60 : null);
  const rise = frac(ctx.sun?.rise), set = frac(ctx.sun?.set);
  if (rise != null && xAt(rise) > m.l) s.push(`<rect x="${m.l}" y="${m.t}" width="${xAt(rise) - m.l}" height="${ph}" class="night"/>`);
  if (set != null && xAt(set) < m.l + pw) s.push(`<rect x="${xAt(set)}" y="${m.t}" width="${m.l + pw - xAt(set)}" height="${ph}" class="night"/>`);

  // Ground.
  s.push(`<rect x="${m.l}" y="${y(groundZ)}" width="${pw}" height="${m.t + ph - y(groundZ)}" class="ground"/>`);
  if (site?.launchAlt) {
    s.push(`<line x1="${m.l}" x2="${m.l + pw}" y1="${y(site.launchAlt)}" y2="${y(site.launchAlt)}" class="launch-line"/>`);
    s.push(`<text x="${m.l + 6}" y="${y(site.launchAlt) - 5}" class="launch-label">Launch ${fmtAlt(site.launchAlt, units.alt)}</text>`);
  }

  // BL top (dashed) and cumulus base (dotted).
  const blPts = rows.map(({ res }, i) => `${cx(i)},${y(Math.max(res.ziTop, groundZ))}`).join(' ');
  s.push(`<polyline points="${blPts}" class="bl-line"/>`);
  rows.forEach(({ res }, i) => {
    if (res.cuBase != null) s.push(`<line x1="${cx(i) - cw / 2 + 3}" x2="${cx(i) + cw / 2 - 3}" y1="${y(res.cuBase)}" y2="${y(res.cuBase)}" class="cu-line"/>`);
  });

  // Wind arrows at each model level.
  rows.forEach(({ hour }, i) => {
    for (const l of hour.levels) {
      if (l.spd == null || l.z > yMax - dz * 2 || l.z < groundZ + dz) continue;
      s.push(`<g transform="translate(${cx(i) - 8} ${y(l.z) - 8})">${arrowSvg(l.dir, windColor(l.spd), 16)}</g>`);
    }
  });

  for (const [t, label] of [[rise, `Sunrise ${ctx.sun?.rise?.slice(11, 16)}`], [set, `Sunset ${ctx.sun?.set?.slice(11, 16)}`]]) {
    if (t == null || xAt(t) <= m.l || xAt(t) >= m.l + pw) continue;
    s.push(`<line x1="${xAt(t)}" x2="${xAt(t)}" y1="${m.t}" y2="${m.t + ph}" class="sun-line"/>`);
    s.push(`<text x="${xAt(t) + (t === rise ? 4 : -4)}" y="${m.t + 12}" class="sun-label" text-anchor="${t === rise ? 'start' : 'end'}">${label}</text>`);
  }

  // Airspace floor (red).
  if (airInRange && air.floorM <= yMax) {
    const label = air.floorM <= groundZ + 1 ? `${air.name} from the surface` : `${air.name} floor ${fmtAlt(air.floorM, units.alt)}`;
    s.push(`<line x1="${m.l}" x2="${m.l + pw}" y1="${y(air.floorM)}" y2="${y(air.floorM)}" class="air-line"/>`);
    s.push(`<text x="${m.l + pw - 6}" y="${y(air.floorM) - 6}" class="air-label" text-anchor="end">${label}</text>`);
  }

  // TOL line with labels.
  const tolPts = rows.map(({ res }, i) => `${cx(i)},${y(res.tol)}`).join(' ');
  s.push(`<polyline points="${tolPts}" class="tol-line"/>`);
  rows.forEach(({ res }, i) => {
    if (res.usable) {
      s.push(`<circle cx="${cx(i)}" cy="${y(res.tol)}" r="5" class="tol-dot"/>`);
      const v = altVal(res.tol, units.alt);
      const label = units.alt === 'ft' ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`;
      s.push(`<text x="${cx(i)}" y="${y(res.tol) - 10}" class="tol-label" text-anchor="middle">${label}</text>`);
    } else {
      s.push(`<circle cx="${cx(i)}" cy="${y(res.tol)}" r="3.5" class="tol-dot none"/>`);
    }
  });

  // Hour labels and the launch-altitude wind strip.
  const stripY = m.t + ph + 26;
  const windAlt = site?.launchAlt ?? groundZ;
  let source = null;
  s.push(`<text x="${m.l - 8}" y="${stripY + 22}" class="axis" text-anchor="end">Launch</text>`);
  rows.forEach(({ hour }, i) => {
    const h = hourOf(hour.time);
    s.push(`<text x="${cx(i)}" y="${m.t + ph + 16}" class="axis" text-anchor="middle">${String(h).padStart(2, '0')}</text>`);
    const w = launchWind(hour, windAlt);
    source ??= w?.source;
    const rating = launchRating(site, w);
    s.push(`<rect x="${m.l + i * cw + 2}" y="${stripY}" width="${cw - 4}" height="52" rx="6" fill="${rating ? RATING_COLOR[rating] : 'var(--strip)'}"/>`);
    if (w) s.push(`<g transform="translate(${cx(i) - 10} ${stripY + 5})">${arrowSvg(w.dir, windColor(w.spd), 20)}</g>`);
    s.push(`<text x="${cx(i)}" y="${stripY + 42}" class="strip-text" text-anchor="middle">${w ? Math.round(windVal(w.spd, units.wind)) : '–'}</text>`);
  });
  const what = source === '80m' ? 'Wind 80 m above ground (this model has no upper-air levels)'
    : `Wind at launch altitude ${fmtAlt(windAlt, units.alt)}`;
  s.push(`<text x="${m.l + pw}" y="${H - 6}" class="axis" text-anchor="end">${what}, ${windLabel(units.wind)}${site?.faces ? ' · strip color = launch suitability' : ''}</text>`);

  // Hover targets.
  rows.forEach((_, i) => {
    s.push(`<rect x="${m.l + i * cw}" y="${m.t}" width="${cw}" height="${ph + 82}" class="hover" data-i="${i}"/>`);
  });

  root.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Hourly top of lift and wind chart">${s.join('')}</svg>`;
  const svg = root.firstChild;
  svg.addEventListener('mousemove', e => {
    const i = e.target.dataset?.i;
    if (i == null) { tooltip.hidden = true; return; }
    tooltip.innerHTML = tooltipHtml(rows[+i], ctx);
    tooltip.hidden = false;
    const box = root.getBoundingClientRect();
    const left = e.clientX - box.left + 16;
    tooltip.style.left = `${Math.min(left, box.width - 290)}px`;
    tooltip.style.top = `${e.clientY - box.top + 12}px`;
  });
  svg.addEventListener('mouseleave', () => { tooltip.hidden = true; });
}

function tooltipHtml({ hour, res }, { site, groundZ, units, air }) {
  const ref = site?.launchAlt ?? groundZ;
  const rel = res.tol - ref;
  const w = launchWind(hour, ref);
  const rows = [
    ['Top of lift', res.usable ? `<b>${fmtAlt(res.tol, units.alt)}</b> (${rel >= 0 ? '+' : ''}${fmtAlt(rel, units.alt)} vs ${site?.launchAlt ? 'launch' : 'ground'})` : '<b>No usable lift</b>'],
    ...(air ? [['Airspace floor', `${fmtAlt(air.floorM, units.alt)}${res.usable ? airMargin(res.tol, air.floorM, units) : ''}`]] : []),
    ['BL top', fmtAlt(res.ziTop, units.alt)],
    ['w*', `${res.wstar.toFixed(2)} m/s`],
    ['Best net climb', fmtClimb(res.maxClimb)],
    ['Cu base', res.cuBase != null ? fmtAlt(res.cuBase, units.alt) : 'none (blue thermals)'],
    ['Wind at TOL', res.windTol ? `${compass(res.windTol.dir)} ${fmtWind(res.windTol.spd, units.wind)}` : '–'],
    [w?.source === '80m' ? 'Wind 80 m' : 'Wind at launch', w ? `${compass(w.dir)} ${fmtWind(w.spd, units.wind)}` : '–'],
    ['Heat flux', hour.shf != null ? `${Math.round(hour.shf)} W/m²` : '–'],
    ['Temp 2 m', hour.t2 != null ? `${hour.t2.toFixed(1)} °C` : '–'],
  ];
  return `<div class="tt-title">${hour.time.slice(11, 16)}</div>` +
    rows.map(([k, v]) => `<div class="tt-row"><span>${k}</span><span>${v}</span></div>`).join('');
}

function airMargin(tol, floorM, units) {
  const gap = floorM - tol;
  return gap > 0 ? ` (TOL ${fmtAlt(gap, units.alt)} below)` : ' <b class="tt-warn">(TOL reaches it)</b>';
}

export function summaryText(rows, ctx) {
  const { site, groundZ, units } = ctx;
  const usable = rows.filter(r => r.res.usable);
  if (!usable.length) return 'No usable lift this day.';
  const best = usable.reduce((a, b) => (b.res.tol > a.res.tol ? b : a));
  const ref = site?.launchAlt ?? groundZ;
  const first = usable[0].hour.time.slice(11, 16), last = usable[usable.length - 1].hour.time.slice(11, 16);
  const climb = best.res.maxClimb < 0.1 ? 'climbs barely beat sink' : `net climb up to ${best.res.maxClimb.toFixed(1)} m/s`;
  const busted = ctx.air && usable.some(r => r.res.tol >= ctx.air.floorM);
  return `Best ${best.hour.time.slice(11, 16)}: top of lift ${fmtAlt(best.res.tol, units.alt)} ` +
    `(${fmtAlt(best.res.tol - ref, units.alt)} over ${site?.launchAlt ? 'launch' : 'ground'}), ${climb}. ` +
    (first === last ? `Usable lift only at ${first}.` : `Usable lift ${first}–${last}.`) +
    (busted ? ` Lift reaches the ${ctx.air.name} floor (${fmtAlt(ctx.air.floorM, units.alt)}): stay below it.` : '');
}

export function legendHtml(units) {
  const climb = CLIMB_STEPS.map(c => `<span class="sw" style="background:${c.color}"></span>${c.label}`).join(' ');
  const wind = WIND_STEPS.map((w, i) => {
    const next = WIND_STEPS[i + 1];
    const lo = Math.round(windVal(w.lo, units.wind));
    const label = next ? `${lo}–${Math.round(windVal(next.lo, units.wind))}` : `${lo}+`;
    return `<span class="sw" style="background:${w.color}"></span>${label}`;
  }).join(' ');
  return `<div><b>Net climb</b> (m/s, updraft − sink): ${climb}</div>
    <div><b>Wind</b> (${windLabel(units.wind)}, arrows point downwind): ${wind}</div>
    <div><span class="ln tol"></span>Top of usable lift <span class="ln bl"></span>Boundary-layer top <span class="ln cu"></span>Cumulus base <span class="ln launch"></span>Launch <span class="ln air"></span>Airspace floor (Class B/C/D)</div>`;
}
