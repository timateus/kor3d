import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/lib/sentinel-change.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
const { decodeSentinelBand, sentinelChange, vegetationLossOnset, sentinelPixel, sentinelPixelHectares, validateSentinelManifest } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const scales = { ndvi: [-1, 1], bsi: [-1, 1], vh: [-35, 0], vv: [-30, 5] };
const bounds = { minLon: 10, minLat: 40, maxLon: 10.01, maxLat: 40.01 };

test('uint8 decoding maps 1 and 255 to the scale ends and 0 to no data', () => {
  const indices = new Uint8Array([1, 255, 128, 0, 255, 1, 0, 0]);
  const ndvi = decodeSentinelBand(indices, 'ndvi', scales);
  assert.equal(ndvi[0], -1);
  assert.equal(ndvi[1], 1);
  const vh = decodeSentinelBand(indices, 'vh', scales);
  assert.ok(Math.abs(vh[0] - (-35 + 127 / 254 * 35)) < 1e-5);
  assert.ok(Number.isNaN(vh[1]));
});

test('vegetation loss needs a vegetated baseline and a drop past the threshold', () => {
  const a = new Float32Array([0.7, 0.7, 0.1, NaN]);
  const b = new Float32Array([0.2, 0.65, -0.5, 0.1]);
  const { raster, stats } = sentinelChange('vegetation', a, b, 0.15, bounds, 2, 2);
  assert.equal(stats.comparable, 2); // bare baseline and missing pixel excluded
  assert.equal(stats.changed, 1);
  assert.equal(raster.rgba[3], 230);
  assert.equal(raster.rgba[7], 0);
});

test('radar change counts rises and falls by magnitude', () => {
  const a = new Float32Array([-20, -20, -20]);
  const b = new Float32Array([-14, -26, -19]);
  const { raster, stats } = sentinelChange('radar', a, b, 3, bounds, 3, 1);
  assert.equal(stats.changed, 2);
  assert.equal(raster.rgba[2], 255); // rise: cyan-white
  assert.equal(raster.rgba[4], 255); // fall: orange
  assert.equal(raster.rgba[11], 0);
});

test('onset is the first year of a persistent drop; one-off dips and recovery are ignored', () => {
  const years = [2017, 2018, 2019, 2020];
  const s = values => values.map(v => new Float32Array([v]));
  const run = (values, includeLast = true) => vegetationLossOnset(s(values), years, 0.15, bounds, 1, 1, 0.3, includeLast).onset[0];
  assert.equal(run([0.7, 0.7, 0.3, 0.3]), 2019);
  assert.equal(run([0.7, 0.3, 0.7, 0.7]), 0); // dip then recovery
  assert.equal(run([0.7, 0.3, 0.7, 0.3]), 2020); // only the last drop persists
  assert.equal(run([0.7, 0.3, 0.7, 0.3], false), 0); // unconfirmed newest year hidden by default
  assert.equal(run([0.7, NaN, 0.3, NaN]), 2019); // gaps neither start nor break a loss
  assert.equal(run([0.2, 0.0, 0.0, 0.0]), 0); // never vegetated
  const { counts } = vegetationLossOnset(s([0.7, 0.7, 0.3, 0.3]), years, 0.15, bounds, 1, 1);
  assert.deepEqual(counts.map(c => c.year), [2018, 2019]);
  assert.ok(counts[1].hectares > 0 && counts[0].hectares === 0);
});

test('pixel lookup is north-up and area follows latitude', () => {
  const m = { bounds, width: 10, height: 10 };
  assert.equal(sentinelPixel(m, 10.0001, 40.0099), 0);
  assert.equal(sentinelPixel(m, 10.0099, 40.0001), 99);
  assert.equal(sentinelPixel(m, 9.99, 40.005), null);
  // 0.001° cells at 40° N: ~85.3 m × 111.3 m ≈ 0.949 ha
  assert.ok(Math.abs(sentinelPixelHectares(m) - 0.949) < 0.002);
});

const manifestUrl = new URL('../../public/data/locations/kok-zhailau/sentinel/manifest.json', import.meta.url);
test('prepared Kok-Zhailau manifest and grids are consistent', { skip: !existsSync(manifestUrl) }, () => {
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
  validateSentinelManifest(manifest);
  for (const { year } of manifest.years) {
    const bytes = readFileSync(new URL(`${year}/indices.bin`, manifestUrl));
    assert.equal(bytes.length, manifest.width * manifest.height * 4, `${year} size`);
  }
});
