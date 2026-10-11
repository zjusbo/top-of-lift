// Global view: Leaflet map with a TOL-colored grid, 10 m wind arrows and a time slider.
/* global L */
import { fetchGrid, callsUsed, MODELS } from './data.js';
import { computeHour } from './physics.js';
import {
  tolBands, tolColor, fmtAlt, fmtWind, compass, arrowSvg, altVal, windVal, windLabel, dayLabel, hourOf,
} from './format.js';

const MAX_CELLS = 400;
const MIN_CELL_KM = 3;   // HRRR grid spacing; finer cells just repeat the same model point

// Canopy, lines and pilot.
const PARAGLIDER_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
  '<path d="M2 10C5.5 3 18.5 3 22 10C18 7.2 6 7.2 2 10Z" fill="#f3a326" stroke="#8a5300" stroke-width=".8"/>' +
  '<path d="M3 9.6 11.2 18.2M21 9.6 12.8 18.2M8.5 6.4 11.6 18.2M15.5 6.4 12.4 18.2" stroke="#1d2533" stroke-width=".7"/>' +
  '<circle cx="12" cy="19.6" r="2.1" fill="#1d2533"/></svg>';

export class MapView {
  constructor(root, { getSettings, getModel, getUnits, sites, onOpenPoint, onStatus }) {
    Object.assign(this, { root, getSettings, getModel, getUnits, sites, onOpenPoint, onStatus });
    this.cells = [];
    this.times = [];
    this.t = 0;
  }

  init(center) {
    if (this.map) return;
    const mapEl = this.root.querySelector('#map');
    this.map = L.map(mapEl, { zoomControl: true, preferCanvas: true }).setView(center, 10);
    // Gray relief keeps the TOL colors readable; place names sit above the color grid.
    const relief = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 13, maxNativeZoom: 13, attribution: 'Relief © Esri',
    }).addTo(this.map);
    const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 15, attribution: 'Map © OpenStreetMap contributors, SRTM | Style © OpenTopoMap (CC-BY-SA)',
    });
    const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18, attribution: '© OpenStreetMap contributors',
    });
    this.map.createPane('labels').style.zIndex = 450;
    this.map.getPane('labels').style.pointerEvents = 'none';
    const labels = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
      pane: 'labels', maxZoom: 18, attribution: 'Places © Esri',
    }).addTo(this.map);
    L.control.layers({ Relief: relief, Topo: topo, Streets: osm }, { 'Place names': labels }, { position: 'bottomleft' }).addTo(this.map);
    this.renderer = L.canvas({ padding: 0.2 });
    this.gridLayer = L.layerGroup().addTo(this.map);
    this.arrowLayer = L.layerGroup().addTo(this.map);
    this.siteLayer = L.layerGroup().addTo(this.map);
    this.map.on('click', e => this.showPopup(e.latlng));
    this.map.on('zoomend', () => this.updateArrowVisibility());

    const $ = s => this.root.querySelector(s);
    $('#load-grid').addEventListener('click', () => this.load());
    $('#time-slider').addEventListener('input', e => { this.t = +e.target.value; this.render(); });
    $('#play').addEventListener('click', () => this.togglePlay());
    this.drawSites();
  }

  /** Launch sites get a paraglider badge with their name; custom points a small dot. Click opens the point forecast. */
  drawSites() {
    this.siteLayer.clearLayers();
    for (const s of this.sites()) {
      const open = ev => { L.DomEvent.stopPropagation(ev); this.onOpenPoint(s); };
      if (s.launchAlt) {
        const label = document.createElement('span');
        label.textContent = s.name;
        L.marker([s.lat, s.lon], {
          title: `${s.name}: open point forecast`, zIndexOffset: 1000, riseOnHover: true,
          icon: L.divIcon({ className: 'site-icon', html: `${PARAGLIDER_SVG}${label.outerHTML}`, iconSize: [32, 32], iconAnchor: [16, 16] }),
        }).on('click', open).addTo(this.siteLayer);
      } else {
        L.circleMarker([s.lat, s.lon], { radius: 6, color: '#111', weight: 2, fillColor: '#fff', fillOpacity: 1 })
          .bindTooltip(s.name, { direction: 'top', offset: [0, -6] })
          .on('click', open)
          .addTo(this.siteLayer);
      }
    }
  }

  /** Grid of cell centers covering the current viewport. */
  gridPoints() {
    const b = this.map.getBounds();
    const n = +this.root.querySelector('#grid-size').value;
    const midLat = (b.getNorth() + b.getSouth()) / 2;
    const kmX = (b.getEast() - b.getWest()) * 111.32 * Math.cos((midLat * Math.PI) / 180);
    const kmY = (b.getNorth() - b.getSouth()) * 110.57;
    let cellKm = Math.max(kmX, kmY) / n;
    cellKm = Math.max(cellKm, MIN_CELL_KM, Math.sqrt((kmX * kmY) / MAX_CELLS));
    const nx = Math.max(1, Math.round(kmX / cellKm)), ny = Math.max(1, Math.round(kmY / cellKm));
    const dLon = (b.getEast() - b.getWest()) / nx, dLat = (b.getNorth() - b.getSouth()) / ny;
    const pts = [];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const south = b.getSouth() + j * dLat, west = b.getWest() + i * dLon;
        pts.push({ lat: south + dLat / 2, lon: west + dLon / 2, bounds: [[south, west], [south + dLat, west + dLon]] });
      }
    }
    return pts;
  }

  async load() {
    const pts = this.gridPoints();
    const modelKey = this.getModel();
    const btn = this.root.querySelector('#load-grid');
    const status = this.root.querySelector('#grid-status');
    const withProfile = this.getSettings().ziMethod === 'parcel';
    btn.disabled = true;
    this.root.querySelector('#map').classList.add('loading');   // stale colors until new data lands
    try {
      const data = await fetchGrid(pts, modelKey, withProfile, {
        onProgress: (done, total) => { status.textContent = `Loading ${done}/${total} cells…`; },
        onWait: s => { status.textContent = `Pacing requests for the free API limit (~${s}s)…`; },
      });
      const prevTime = this.times[this.t];
      this.cells = pts.map((p, i) => ({ ...p, fc: data[i] }));
      this.times = this.cells[0]?.fc.hours.map(h => h.time) ?? [];
      this.buildLayers();
      this.setupTimeline(prevTime);
      this.recompute();
      status.textContent = `${pts.length} cells · ~${Math.round(callsUsed)} API calls this session (free: 10k/day)`;
      this.onStatus?.('');
    } catch (err) {
      status.textContent = '';
      this.onStatus?.(`Map data failed: ${err.message}`);
    } finally {
      btn.disabled = false;
      this.root.querySelector('#map').classList.remove('loading');
    }
  }

  buildLayers() {
    this.gridLayer.clearLayers();
    this.arrowLayer.clearLayers();
    for (const c of this.cells) {
      c.rect = L.rectangle(c.bounds, { renderer: this.renderer, stroke: false, fillOpacity: 0.7, interactive: false })
        .addTo(this.gridLayer);
      c.arrow = L.marker([c.lat, c.lon], {
        interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'warrow', html: '', iconSize: [28, 30], iconAnchor: [14, 11] }),
      }).addTo(this.arrowLayer);
    }
    this.updateArrowVisibility();
  }

  /** Recompute TOL for every cell and hour (cheap; no refetch). Called when tuning changes. */
  recompute() {
    if (!this.cells.length) return;
    const opts = this.getSettings();
    // The parcel method needs upper-air temperatures that the light grid request skips.
    if (opts.ziMethod === 'parcel' && MODELS[this.getModel()].profile && !this.cells[0].fc.hasProfile) {
      if (!this.root.hidden) this.load(); else this.cells = [];
      return;
    }
    for (const c of this.cells) c.res = c.fc.hours.map(h => computeHour(h, c.fc.elevation, opts));
    this.render();
  }

  /** Keep the previously shown time if it still exists, else default to the first 14:00. */
  setupTimeline(prevTime) {
    const slider = this.root.querySelector('#time-slider');
    slider.max = Math.max(0, this.times.length - 1);
    const kept = prevTime ? this.times.indexOf(prevTime) : -1;
    const i14 = this.times.findIndex(t => hourOf(t) === 14);
    this.t = kept >= 0 ? kept : Math.max(0, i14);
    slider.value = this.t;

    const days = [...new Set(this.times.map(t => t.slice(0, 10)))];
    const chips = this.root.querySelector('#map-days');
    chips.replaceChildren(...days.map(d => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = dayLabel(d);
      b.addEventListener('click', () => {
        const idx = this.times.findIndex(t => t.startsWith(d) && hourOf(t) === 14);
        this.t = idx >= 0 ? idx : this.times.findIndex(t => t.startsWith(d));
        slider.value = this.t;
        this.render();
      });
      return b;
    }));
  }

  render() {
    const units = this.getUnits();
    const bands = tolBands(units.alt);
    const tag = this.times[this.t];
    for (const c of this.cells) {
      const r = c.res?.[this.t], h = c.fc.hours[this.t];
      if (!r || !h) { c.rect.setStyle({ fillOpacity: 0 }); continue; }
      if (r.usable) c.rect.setStyle({ fillColor: tolColor(r.tol, bands), fillOpacity: 0.7 });
      else c.rect.setStyle({ fillColor: '#8a8f98', fillOpacity: 0.18 });
      const w = h.wind10;
      const el = c.arrow.getElement();
      if (el) el.innerHTML = w.dir == null ? '' : `${arrowSvg(w.dir, '#1d2533', 18)}<span>${Math.round(windVal(w.spd, units.wind))}</span>`;
    }
    this.root.querySelector('#time-label').textContent = tag ? `${dayLabel(tag.slice(0, 10))} · ${tag.slice(11, 16)}` : '–';
    this.root.querySelectorAll('#map-days .chip').forEach(ch => {
      ch.classList.toggle('active', tag && ch.textContent === dayLabel(tag.slice(0, 10)));
    });
    this.renderLegend(bands, units);
    if (this.popup?.isOpen()) this.showPopup(this.popup.getLatLng());
  }

  renderLegend(bands, units) {
    const items = [...bands].reverse().map(b =>
      `<div class="lg-row"><span class="lg-sw" style="background:${b.color}"></span>${Math.round(altVal(b.lo, units.alt)).toLocaleString()}</div>`).join('');
    this.root.querySelector('#map-legend').innerHTML =
      `<div class="lg-title">Top of lift<br>MSL (${units.alt})</div>${items}` +
      `<div class="lg-row"><span class="lg-sw" style="background:#8a8f98;opacity:.45"></span>none</div>` +
      `<div class="lg-foot">Arrows: 10 m wind, pointing downwind (${windLabel(units.wind)})</div>`;
  }

  updateArrowVisibility() {
    if (!this.cells.length) return;
    // Hide arrows when cells get smaller than the arrow itself.
    const c = this.cells[0];
    const p1 = this.map.latLngToContainerPoint(c.bounds[0]), p2 = this.map.latLngToContainerPoint(c.bounds[1]);
    const px = Math.min(Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));
    this.root.querySelector('#map').classList.toggle('hide-arrows', px < 16);
    this.root.querySelector('#map').classList.toggle('hide-speeds', px < 34);
  }

  showPopup(latlng) {
    const cell = this.cells.find(c => latlng.lat >= c.bounds[0][0] && latlng.lat < c.bounds[1][0] &&
      latlng.lng >= c.bounds[0][1] && latlng.lng < c.bounds[1][1]);
    const units = this.getUnits();
    const box = document.createElement('div');
    box.className = 'popup';
    if (cell?.res?.[this.t]) {
      const r = cell.res[this.t], h = cell.fc.hours[this.t];
      box.innerHTML =
        `<div><b>${r.usable ? fmtAlt(r.tol, units.alt) : 'No usable lift'}</b>${r.usable ? ` · ${fmtAlt(r.tolAgl, units.alt)} AGL` : ''}</div>` +
        `<div>Ground ${fmtAlt(cell.fc.elevation, units.alt)} · w* ${r.wstar.toFixed(1)} m/s</div>` +
        `<div>Wind 10 m ${h.wind10.dir != null ? `${compass(h.wind10.dir)} ${fmtWind(h.wind10.spd, units.wind)}` : '–'}</div>`;
    } else {
      box.innerHTML = '<div>No grid data here yet.</div>';
    }
    const btn = document.createElement('button');
    btn.className = 'btn small';
    btn.textContent = 'Point forecast here';
    btn.addEventListener('click', () => this.onOpenPoint({ name: `Point ${latlng.lat.toFixed(3)}, ${latlng.lng.toFixed(3)}`, lat: latlng.lat, lon: latlng.lng }));
    box.append(btn);
    this.popup = L.popup({ autoPan: false }).setLatLng(latlng).setContent(box).openOn(this.map);
  }

  togglePlay() {
    const btn = this.root.querySelector('#play');
    if (this.timer) {
      clearInterval(this.timer); this.timer = null; btn.textContent = '▶'; btn.setAttribute('aria-label', 'Play');
      return;
    }
    btn.textContent = '❚❚'; btn.setAttribute('aria-label', 'Pause');
    this.timer = setInterval(() => {
      this.t = (this.t + 1) % Math.max(1, this.times.length);
      this.root.querySelector('#time-slider').value = this.t;
      this.render();
    }, 700);
  }

  /** Called when the view becomes visible or the model changes. */
  show(center, modelChanged) {
    this.init(center);
    this.map.invalidateSize();
    this.drawSites();
    if (!this.cells.length || modelChanged) this.load();
  }
}
