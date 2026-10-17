// Run: node test/weather.test.mjs
import assert from 'node:assert/strict';
import { classify, detail, fmtTemp } from '../js/weather.js';

// Cloudiness from cloud cover (HRRR only emits codes 0 and 3)
assert.equal(classify({ code: 0, cloud: 5 }, false).label, 'Sunny');
assert.equal(classify({ code: 0, cloud: 5 }, true).label, 'Clear');
assert.equal(classify({ code: 3, cloud: 40 }, false).kind, 'partly');
assert.equal(classify({ code: 3, cloud: 70 }, false).kind, 'mostly');
assert.equal(classify({ code: 3, cloud: 95 }, false).kind, 'overcast');
// Precipitation, fog and thunder from the weather code
assert.deepEqual(classify({ code: 63, cloud: 100 }, false), { kind: 'rain', label: 'Rain', precip: true });
assert.equal(classify({ code: 73, cloud: 100 }, false).kind, 'snow');
assert.equal(classify({ code: 95, cloud: 100 }, false).kind, 'thunder');
assert.equal(classify({ code: 45, cloud: 100 }, false).kind, 'fog');
// Detail: chance of precipitation for wet hours, cloud cover otherwise; amount when no probability (NAM)
assert.deepEqual(detail({ code: 61, cloud: 100, pop: 40 }, classify({ code: 61 }, false), true), { text: '40%', wet: true });
assert.deepEqual(detail({ code: 61, cloud: 100, pop: null, precip: 2.54 }, classify({ code: 61 }, false), true), { text: '0.10″', wet: true });
assert.deepEqual(detail({ code: 3, cloud: 62, pop: 10 }, classify({ code: 3, cloud: 62 }, false), true), { text: '62%', wet: false });
assert.equal(fmtTemp(27, 'F'), '81°F');
assert.equal(fmtTemp(27, 'C'), '27°C');
console.log('weather tests passed');
