import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

// Run the numerical code used by the browser without adding a test runtime.
const source = readFileSync(new URL('../../src/lib/satellite-embeddings.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
const { decodeEmbedding, normalizeEmbeddings, similarityScores, embeddingPixel, validateEmbeddingMetadata, areaReference, paintEmbeddingStroke, embeddingChanges, validateEmbeddingPair, embeddingGridMeters } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const metadata = { version: 1, width: 2, height: 2, dimensions: 64, encoding: 'aef-int8', noData: -128,
  valuesFile: 'values.bin', bounds: { minLon: 10, minLat: 40, maxLon: 12, maxLat: 42 } };

test('inverse quantization follows the signed square rather than a linear scale', () => {
  assert.equal(decodeEmbedding(0), 0);
  assert.equal(decodeEmbedding(64), (64 / 127.5) ** 2);
  assert.equal(decodeEmbedding(-64), -((64 / 127.5) ** 2));
});

test('cosine similarity distinguishes same, orthogonal, opposite and missing pixels', () => {
  const raw = new Int8Array(5 * 64);
  raw[0] = 80; raw[1] = 40;
  raw[64] = 80; raw[65] = 40;
  raw[128 + 2] = 80;
  raw[192] = -80; raw[193] = -40;
  raw[256 + 2] = -128; // Any missing component invalidates the whole pixel.
  const normalized = normalizeEmbeddings(raw);
  const scores = similarityScores(normalized, 0);
  assert.ok(Math.abs(scores[0] - 1) < 1e-6);
  assert.ok(Math.abs(scores[1] - 1) < 1e-6);
  assert.equal(scores[2], 0);
  assert.ok(Math.abs(scores[3] + 1) < 1e-6);
  assert.ok(Number.isNaN(scores[4]));
  assert.equal(similarityScores(normalized, 4), null);
  assert.equal(similarityScores(normalized, 5), null);
});

test('coordinates use pixel cell edges, north-to-south rows and inclusive outer bounds', () => {
  assert.equal(embeddingPixel(metadata, 10, 42), 0);
  assert.equal(embeddingPixel(metadata, 11.5, 41.5), 1);
  assert.equal(embeddingPixel(metadata, 10.5, 40.5), 2);
  assert.equal(embeddingPixel(metadata, 12, 40), 3);
  assert.equal(embeddingPixel(metadata, 12.01, 40), null);
  assert.equal(embeddingPixel(metadata, NaN, 41), null);
});

test('rejects unsupported dimensions, oversized rasters and invalid bounds', () => {
  assert.doesNotThrow(() => validateEmbeddingMetadata(metadata));
  for (const bad of [{ dimensions: 63 }, { width: 200000 }, { width: 1.5 }, { valuesFile: '../secret' },
    { bounds: { minLon: 12, maxLon: 10, minLat: 40, maxLat: 42 } }]) {
    assert.throws(() => validateEmbeddingMetadata({ ...metadata, ...bad }));
  }
});

test('worker colours valid pixels, applies similarity thresholds and rejects missing references', async () => {
  const messages = [];
  globalThis.self = { postMessage: message => messages.push(message) };
  const workerSource = readFileSync(new URL('../../src/workers/satellite-embeddings.worker.ts', import.meta.url), 'utf8');
  const coreUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
  const searchSource = readFileSync(new URL('../../src/lib/embedding-search.ts', import.meta.url), 'utf8');
  const searchJs = ts.transpileModule(searchSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
  const searchUrl = `data:text/javascript;base64,${Buffer.from(searchJs).toString('base64')}`;
  const analysisJs = ts.transpileModule(readFileSync(new URL('../../src/lib/embedding-analysis.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText
    .replace(/from ['"]\.\/satellite-embeddings['"]/, `from '${coreUrl}'`);
  const analysisUrl = `data:text/javascript;base64,${Buffer.from(analysisJs).toString('base64')}`;
  const workerJs = ts.transpileModule(workerSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText
    .replace(/from ['"]\.\.\/lib\/satellite-embeddings['"]/, `from '${coreUrl}'`)
    .replace(/from ['"]\.\.\/lib\/embedding-search['"]/, `from '${searchUrl}'`)
    .replace(/from ['"]\.\.\/lib\/embedding-analysis['"]/, `from '${analysisUrl}'`);
  await import(`data:text/javascript;base64,${Buffer.from(workerJs).toString('base64')}`);
  const raw = new Int8Array(3 * 64);
  raw[0] = 80;
  raw[64 + 1] = 80;
  raw[128] = -128;
  self.onmessage({ data: { id: 1, type: 'init', buffer: raw.buffer } });
  assert.equal(messages.shift().ready, true);
  self.onmessage({ data: { id: 1, type: 'overview' } });
  assert.deepEqual([messages[0].rgba[3], messages[0].rgba[7], messages[0].rgba[11]], [255, 255, 0]);
  self.onmessage({ data: { id: 2, type: 'similarity', pixel: 0, threshold: 0.8 } });
  assert.equal(messages[1].id, 2);
  assert.equal(messages[1].reference[0], 1);
  assert.deepEqual([messages[1].rgba[3], messages[1].rgba[7], messages[1].rgba[11]], [255, 0, 0]);
  self.onmessage({ data: { id: 3, type: 'similarity', pixel: 2, threshold: 0.8 } });
  assert.match(messages[2].error, /No valid embedding/);
  self.onmessage({ data: { id: 4, type: 'similarity', pixel: 1, threshold: 0.8 } });
  assert.equal(messages[3].rgba[7], 255);
  self.onmessage({ data: { id: 5, type: 'similarity', selectionId: 10, pixels: Uint32Array.of(0, 1, 2), threshold: 0.6 } });
  assert.equal(messages[4].sampleCount, 2);
  assert.ok(messages[4].rgba[3] > 0 && messages[4].rgba[7] > 0);
  self.onmessage({ data: { id: 6, type: 'similarity', selectionId: 10, threshold: 0.8 } });
  assert.equal(messages[5].rgba[3], 0);
  assert.equal(messages[5].rgba[7], 0);
  const other = new Int8Array(3 * 64);
  other[0] = 80; other[64] = 80; other[128] = 80;
  self.onmessage({ data: { id: 7, type: 'comparison-init', buffer: other.buffer } });
  assert.equal(messages[6].ready, true);
  self.onmessage({ data: { id: 8, type: 'compare', view: 'change', changeThreshold: 0.1 } });
  assert.deepEqual([messages[7].rgba[3], messages[7].rgba[7], messages[7].rgba[11]], [0, 255, 0]);
  assert.deepEqual(messages[7].stats, { validPixels: 2, aboveThreshold: 1, meanChange: 0.5 });
  self.onmessage({ data: { id: 9, type: 'compare', view: 'swipe', changeThreshold: 0.1 } });
  assert.equal(messages[8].secondRgba.length, 12);
  assert.equal(messages[8].rgba[4], 255); // Base year has axis A01 at pixel 1.
  assert.equal(messages[8].secondRgba[4], 128); // Other year has axis A00 there.
  self.onmessage({ data: { id: 10, type: 'init', buffer: raw.buffer } });
  self.onmessage({ data: { id: 11, type: 'compare', view: 'change' } });
  assert.match(messages[10].error, /comparison year is not loaded/);
  self.onmessage({ data: { id: 12, type: 'similarity', selectionId: 30, externalReference: Array.from(other.slice(0, 64)), threshold: 0.8 } });
  assert.equal(messages[11].rgba[3], 255);
  assert.equal(messages[11].reference[0], 1);
  delete globalThis.self;
});


test('area reference averages valid unique pixels and normalizes the mean', () => {
  const values = new Float32Array(4 * 64);
  values[0] = 1;
  values[64 + 1] = 1;
  values[192] = -1;
  const area = areaReference(values, Uint32Array.of(0, 1, 1, 2, 99));
  assert.equal(area.count, 2);
  assert.ok(Math.abs(area.vector[0] - Math.SQRT1_2) < 1e-6);
  assert.ok(Math.abs(area.vector[1] - Math.SQRT1_2) < 1e-6);
  const scores = similarityScores(values, area.vector);
  assert.ok(Math.abs(scores[0] - Math.SQRT1_2) < 1e-6);
  assert.ok(Number.isNaN(scores[2]));
  assert.equal(areaReference(values, Uint32Array.of(0, 3)), null);
  assert.equal(areaReference(values, new Uint32Array()), null);
});

test('metre brush fills continuous strokes, accumulates and clips at grid edges', () => {
  const meta = { ...metadata, width: 10, height: 10, bounds: { minLon: 0, minLat: 0, maxLon: 0.001, maxLat: 0.001 } };
  const mask = new Uint8Array(100);
  paintEmbeddingStroke(mask, meta, { lon: 0.00005, lat: 0.00055 }, { lon: 0.00095, lat: 0.00055 }, 5.6);
  for (let col = 0; col < 10; col++) assert.equal(mask[4 * 10 + col], 1);
  assert.equal(mask.reduce((a, b) => a + b, 0), 10);
  paintEmbeddingStroke(mask, meta, { lon: 0, lat: 0.001 }, { lon: 0, lat: 0.001 }, 20);
  assert.equal(mask[0], 1);
  assert.equal(mask[49], 1);
  const before = mask.slice();
  paintEmbeddingStroke(mask, meta, { lon: NaN, lat: 0 }, { lon: 0, lat: 0 }, 20);
  assert.deepEqual(mask, before);
});


test('annual change is symmetric, masks missing pairs and clamps cosine roundoff', () => {
  const a = new Float32Array(4 * 64), b = new Float32Array(4 * 64);
  a[0] = b[0] = 1;
  a[64] = 1; b[65] = 1;
  a[128] = 1; b[128] = -1;
  a[192] = 1; // Other year has no data for pixel 3.
  const changes = embeddingChanges(a, b);
  assert.deepEqual(Array.from(changes).slice(0, 3), [0, 1, 2]);
  assert.ok(Number.isNaN(changes[3]));
  assert.deepEqual(embeddingChanges(b, a), changes);
  a[0] = b[0] = 1.0000001;
  assert.equal(embeddingChanges(a, b)[0], 0);
  assert.throws(() => embeddingChanges(a, new Float32Array(64)));
});

test('annual comparison rejects different grids, datasets, CRS and identical years', () => {
  const a = { ...metadata, year: 2025, dataset: 'GOOGLE/SATELLITE_EMBEDDING/V1/ANNUAL', crs: 'EPSG:4326' };
  const b = { ...a, year: 2017 };
  assert.doesNotThrow(() => validateEmbeddingPair(a, b));
  for (const mismatch of [{ year: 2025 }, { width: 3 }, { crs: 'EPSG:3857' }, { dataset: 'different-space' },
    { bounds: { ...b.bounds, minLon: 10.01 } }]) {
    assert.throws(() => validateEmbeddingPair(a, { ...b, ...mismatch }));
  }
});

test('prepared annual assets have compatible grids and genuinely distinct values', () => {
  for (const slug of ['gorny-gigant', 'balqash', 'balqash-lake']) {
  const root = new URL(`../../public/data/locations/${slug}/embeddings/`, import.meta.url);
  const years = [2017, 2025];
  const assets = years.map(year => {
    const meta = JSON.parse(readFileSync(new URL(`${year}/metadata.json`, root), 'utf8'));
    const values = readFileSync(new URL(`${year}/values.bin`, root));
    assert.equal(meta.year, year);
    assert.equal(values.length, meta.width * meta.height * meta.dimensions);
    return { meta, values };
  });
  assert.doesNotThrow(() => validateEmbeddingPair(assets[0].meta, assets[1].meta));
  assert.equal(assets[0].values.equals(assets[1].values), false);
  const spacing = embeddingGridMeters(assets[0].meta);
  if (slug === 'balqash-lake') {
    assert.ok(spacing > 900 && spacing < 1000);
    assert.equal(assets[0].meta.aggregationMeters, 640);
    const mask = new Uint8Array(assets[0].meta.width * assets[0].meta.height);
    paintEmbeddingStroke(mask, assets[0].meta, { lon: 75.6, lat: 46.2 }, { lon: 75.6, lat: 46.2 }, Math.ceil(spacing / 10) * 10);
    assert.ok(mask.some(Boolean));
  } else assert.ok(spacing < 12);
  }
});
