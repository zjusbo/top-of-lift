// Run: node test/physics.test.mjs
import assert from 'node:assert/strict';
import { wstar, updraft, critRatio, parcelTop, computeHour, windAt, launchWind } from '../js/physics.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

// w*: 300 W/m², 2000 m BL, 27 °C → ~2.5 m/s (worked example from the research notes)
near(wstar(300, 2000, 27, 1013), 2.5, 0.1, 'w* worked example');
assert.equal(wstar(-20, 2000, 27, 1000), 0, 'negative heat flux → no thermals');

// Profile: peak 0.45·w* at z/zi ≈ 0.23 with k = 1 (Allen 2006)
near(updraft(1 / 4.4, 1, 1), 0.456, 0.01, 'peak of Lenschow profile');
assert.equal(updraft(0.95, 2, 1), 0, 'no updraft above 0.91 zi');

// critRatio: k=2.2, w*=2.5, sink=1.3 → z/zi where 2.2·2.5·r^⅓(1-1.1r) = 1.3
const r = critRatio(2.5, 2.2, 1.3);
near(updraft(r, 2.5, 2.2), 1.3, 1e-3, 'updraft equals sink at TOL');
assert.ok(r > 0.6 && r < 0.9, `TOL ratio plausible: ${r}`);
assert.equal(critRatio(1.0, 1, 1.3), 0, 'weak day → no usable lift');

// Parcel: environment 6.5 K/km from 20 °C at 0 m; parcel 25 °C dry adiabat meets it at 5/(9.8-6.5) km
const env = [0, 500, 1000, 1500, 2000, 2500].map(z => ({ z, t: 20 - 0.0065 * z }));
near(parcelTop(env, 0, 25), 5 / 0.0033, 2, 'parcel top on linear sounding');

// Wind interpolation crosses north correctly (350° → 10° gives ~0°)
const w = windAt([{ z: 0, spd: 10, dir: 350 }, { z: 1000, spd: 10, dir: 10 }], 500);
near(w.dir > 180 ? w.dir - 360 : w.dir, 0, 0.5, 'wind dir interpolation across north');

// computeHour end-to-end with the model-BL method
const h = computeHour({ t2: 27, td2: 5, shf: 300, hpbl: 2000, psfc: 1000, levels: env.map(l => ({ ...l, spd: 10, dir: 270 })) },
  0, { k: 2.2, sink: 1.3, ziMethod: 'model', excess: 1.5 });
assert.ok(h.usable && h.tol > 1200 && h.tol < 1800, `computeHour TOL ${h.tol}`);
near(h.climbAt(h.tol), 0, 1e-3, 'net climb is zero at TOL');

// Launch wind: interpolated at launch altitude; 80 m fallback when there are no levels
const lw = launchWind({ windLevels: [{ z: 549, spd: 8, dir: 270 }, { z: 787, spd: 16, dir: 270 }], wind80: { spd: 30, dir: 90 } }, 668);
near(lw.spd, 12, 0.05, 'launch wind interpolated between pressure levels');
assert.equal(lw.source, 'levels');
const lw80 = launchWind({ windLevels: [], wind80: { spd: 30, dir: 90 } }, 668);
assert.equal(lw80.source, '80m');
assert.equal(launchWind({ windLevels: [], wind80: { spd: null, dir: null } }, 668), null);

console.log('physics tests passed');
