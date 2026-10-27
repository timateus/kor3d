import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
const asUrl = js => `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`;
const coreUrl = asUrl(compile('../../src/lib/satellite-embeddings.ts'));
const analysisUrl = asUrl(compile('../../src/lib/embedding-analysis.ts').replace(/from ['"]\.\/satellite-embeddings['"]/, `from '${coreUrl}'`));
const { localEmbeddingDifference, candidateShoreline, shorelineGeoJSON, decodeTimelineVector, embeddingTrajectory } = await import(analysisUrl);
const hookUrl = asUrl(compile('../../src/hooks/useEmbeddingTimeline.ts')
  .replace(/from ['"]react['"]/, `from '${import.meta.resolve('react')}'`)
  .replace(/from ['"]@\/lib\/satellite-embeddings['"]/, `from '${coreUrl}'`)
  .replace(/from ['"]@\/lib\/embedding-analysis['"]/, `from '${analysisUrl}'`));
const { readTimelinePixel } = await import(hookUrl);
const meta = { width: 3, height: 2, bounds: { minLon: 74, maxLon: 74.03, minLat: 46, maxLat: 46.02 } };
const vectors = (width, height) => { const a = new Float32Array(width * height * 64); for (let p = 0; p < width * height; p++) a[p * 64] = 1; return a; };

test('local anomaly singles out an isolated signature; transition responds across a boundary', () => {
  const a = vectors(7, 7); a[24 * 64] = 0; a[24 * 64 + 1] = 1;
  const anomaly = localEmbeddingDifference(a, 7, 7, 1, 'anomaly');
  assert.equal(anomaly[24], 1); assert.equal(anomaly[8], 0); assert.ok(Number.isNaN(anomaly[0]));
  const b = vectors(7, 7);
  for (let y = 0; y < 7; y++) for (let x = 3; x < 7; x++) { b[(y * 7 + x) * 64] = 0; b[(y * 7 + x) * 64 + 1] = 1; }
  const transition = localEmbeddingDifference(b, 7, 7, 1, 'transition');
  assert.equal(transition[3 * 7 + 1], 0); assert.equal(transition[3 * 7 + 2], .5); assert.equal(transition[3 * 7 + 3], .5);
  b.fill(0, 24 * 64, 25 * 64);
  assert.ok(Number.isNaN(localEmbeddingDifference(b, 7, 7, 1, 'anomaly')[24]));
  assert.ok(Number.isNaN(localEmbeddingDifference(b, 7, 7, 1, 'transition')[23]));
  assert.throws(() => localEmbeddingDifference(b, 7, 7, 0, 'anomaly'));
});

test('candidate boundaries omit outer edges and no-data; extent gain/loss use shared coverage', () => {
  const current = Float32Array.from([1, 1, 0, 1, NaN, 0]);
  const previous = Float32Array.from([1, 0, 1, 1, 1, NaN]);
  const result = candidateShoreline(current, previous, meta, .9);
  assert.equal(result.stats.validPixels, 4);
  assert.equal(result.stats.boundaryEdges, 1); // only upper row x=2 boundary; missing cells are not shoreline
  assert.ok(result.stats.gainKm2 > 0 && result.stats.lossKm2 > 0);
  assert.ok(Math.abs(result.stats.areaKm2 - result.stats.comparisonAreaKm2) < 1e-10);
  assert.equal(result.edges.length, 4);
  const json = shorelineGeoJSON(result.edges, { kind: 'candidate-shoreline' });
  assert.equal(json.features[0].geometry.type, 'MultiLineString');
  assert.ok(Math.abs(json.features[0].geometry.coordinates[0][0][0] - 74.02) < .00001);
  assert.equal(candidateShoreline(new Float32Array(6).fill(1), null, meta, .9).edges.length, 0);
  assert.equal(candidateShoreline(new Float32Array(6).fill(NaN), null, meta, .9).stats.validPixels, 0);
});

test('trajectory reports a shift and return without bridging missing or nonconsecutive years', () => {
  const a = new Float32Array(64); a[0] = 1; const b = new Float32Array(64); b[1] = 1;
  const data = embeddingTrajectory([{ year: 2020, vector: a }, { year: 2017, vector: a }, { year: 2018, vector: b }, { year: 2019, vector: null }, { year: 2022, vector: b }]);
  assert.deepEqual(data.map(s => s.fromBaseline), [0, 1, null, 0, 1]);
  assert.deepEqual(data.map(s => s.fromPrevious), [null, 1, null, null, null]);
  assert.equal(decodeTimelineVector(new Int8Array(64).fill(-128)), null);
  assert.equal(decodeTimelineVector(new Int8Array(64)), null);
});

test('timeline range reads exactly one vector and rejects a wrong range', async () => {
  const original = globalThis.fetch;
  const raw = new Int8Array(64); raw[0] = 80;
  try {
    globalThis.fetch = async (_url, options) => {
      assert.equal(options.headers.Range, 'bytes=128-191');
      return new Response(raw, { status: 206, headers: { 'content-range': 'bytes 128-191/640' } });
    };
    assert.equal((await readTimelinePixel('test', 2, 640, new AbortController().signal))[0], 1);
    globalThis.fetch = async () => new Response(raw, { status: 206, headers: { 'content-range': 'bytes 0-63/640' } });
    await assert.rejects(() => readTimelinePixel('test', 2, 640, new AbortController().signal), /range/);
  } finally { globalThis.fetch = original; }
});

test('timeline streaming fallback handles split vectors, cancels the stream and rejects truncated data', async () => {
  const original = globalThis.fetch; let cancelled = false;
  const raw = new Uint8Array(640); raw[128] = 80;
  try {
    globalThis.fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(raw.slice(0, 145)); c.enqueue(raw.slice(145, 260)); }, cancel() { cancelled = true; } }), { status: 200 });
    assert.equal((await readTimelinePixel('test', 2, 640, new AbortController().signal))[0], 1); assert.equal(cancelled, true);
    globalThis.fetch = async () => new Response(new Uint8Array(140), { status: 200 });
    await assert.rejects(() => readTimelinePixel('test', 2, 640, new AbortController().signal), /Incomplete/);
  } finally { globalThis.fetch = original; }
});

test('analysis worker keeps a fixed shoreline reference across comparison years and modes', async () => {
  const searchUrl = asUrl(compile('../../src/lib/embedding-search.ts'));
  const workerUrl = asUrl(compile('../../src/workers/satellite-embeddings.worker.ts')
    .replace(/from ['"]\.\.\/lib\/satellite-embeddings['"]/, `from '${coreUrl}'`)
    .replace(/from ['"]\.\.\/lib\/embedding-search['"]/, `from '${searchUrl}'`)
    .replace(/from ['"]\.\.\/lib\/embedding-analysis['"]/, `from '${analysisUrl}'`));
  const messages = []; globalThis.self = { postMessage: value => messages.push(value) };
  await import(workerUrl);
  const raw = new Int8Array(25 * 64); for (let p = 0; p < 25; p++) raw[p * 64 + (p % 5 >= 3 ? 1 : 0)] = 100;
  const other = raw.slice(); other[2 * 64] = 0; other[2 * 64 + 1] = 100;
  self.onmessage({ data: { id: 1, type: 'init', buffer: raw.buffer, metadata: { ...meta, width: 5, height: 5 } } });
  self.onmessage({ data: { id: 2, type: 'comparison-init', buffer: other.buffer } });
  self.onmessage({ data: { id: 3, type: 'shoreline', pixel: 0, selectionId: 1, threshold: .9, compareShoreline: true } });
  assert.equal(messages.at(-1).reference[0], 1);
  assert.ok(messages.at(-1).shorelineStats.gainKm2 > 0);
  assert.ok(messages.at(-1).edges.length > 0);
  self.onmessage({ data: { id: 4, type: 'transition', radius: 1, localThreshold: .05 } });
  assert.equal(messages.at(-1).localStats.validPixels, 9);
  self.onmessage({ data: { id: 5, type: 'shoreline', pixel: 0, selectionId: 1, threshold: .99, compareShoreline: true } });
  assert.equal(messages.at(-1).reference[0], 1);
  assert.ok(messages.at(-1).shorelineStats.gainKm2 > 0);
  delete globalThis.self;
});

test('Balqash annual series have aligned, distinct rasters for every year 2017–2025', async () => {
  const { validateEmbeddingPair } = await import(coreUrl);
  for (const slug of ['balqash', 'balqash-lake']) {
    let previous = null;
    for (let year = 2017; year <= 2025; year++) {
      const folder = new URL(`../../public/data/locations/${slug}/embeddings/${year}/`, import.meta.url);
      const meta = JSON.parse(readFileSync(new URL('metadata.json', folder), 'utf8'));
      const raw = readFileSync(new URL('values.bin', folder));
      assert.equal(meta.year, year); assert.equal(raw.length, meta.width * meta.height * 64);
      assert.equal(meta.validPixels, meta.width * meta.height);
      if (previous) { validateEmbeddingPair(previous.meta, meta); assert.equal(previous.raw.equals(raw), false); }
      previous = { meta, raw };
    }
  }
});
