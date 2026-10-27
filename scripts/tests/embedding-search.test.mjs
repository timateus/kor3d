import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
const asUrl = js => `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`;
const searchUrl = asUrl(compile('../../src/lib/embedding-search.ts'));
const coreUrl = asUrl(compile('../../src/lib/satellite-embeddings.ts'));
const { searchEmbeddingIndex, validateSearchManifest, readEmbeddingArrival, unitReference, insideBounds } = await import(searchUrl);
const { normalizeEmbeddings } = await import(coreUrl);
const bounds = { minLon: 0, maxLon: .02, minLat: 0, maxLat: .001 };
const sourceBounds = { ...bounds, minLon: 10, maxLon: 10.02 };
function location(slug, offset, patch = {}) { return { slug, label: slug, bounds, sourceWidth: 100, sourceHeight: 5, width: 20, height: 1, offset, count: 20, ...patch }; }
function manifest(locations) { return { version: 1, year: 2025, dataset: 'GOOGLE/SATELLITE_EMBEDDING/V1/ANNUAL', encoding: 'aef-int8', dimensions: 64, blockSize: 5,
  valuesFile: 'values.bin', count: locations.reduce((n, l) => n + l.count, 0), locations }; }
const m = manifest([location('source', 0, { bounds: sourceBounds }), location('a', 20), location('b', 40)]);
const reference = new Float32Array(64); reference[0] = 1;

test('search ranks valid matches, excludes source coverage and suppresses nearby duplicates', () => {
  const values = new Float32Array(m.count * 64);
  for (let p = 0; p < m.count; p++) values[p * 64] = 1;
  // B has only one strong match, at the same position as A's first patch.
  for (let p = 41; p < 60; p++) { values[p * 64] = .8; values[p * 64 + 1] = .6; }
  const matches = searchEmbeddingIndex(m, values, reference, 'source', sourceBounds, .9);
  assert.equal(matches.length, 3);
  assert.ok(matches.every(match => match.slug === 'a' && match.score === 1));
  assert.ok(matches[1].lon - matches[0].lon > .0017);
  const excluded = { minLon: .0019, maxLon: .0021, minLat: 0, maxLat: .001 };
  const filtered = searchEmbeddingIndex(m, values, reference, 'source', excluded, .9);
  assert.ok(filtered.every(match => match.sourceX !== 7.5 && match.sourceX !== 12.5)); // Whole patch intersects, even when centre is outside.
  const empty = searchEmbeddingIndex(m, new Float32Array(values.length), reference, 'source', sourceBounds, .9);
  assert.deepEqual(empty, []);
});

test('last clipped patch uses its actual centre rather than assuming five source pixels', () => {
  const compact = manifest([location('source', 0, { bounds: sourceBounds }), location('edge', 20, { sourceWidth: 12, width: 3, count: 3, bounds: { ...bounds, maxLon: .012 } })]);
  validateSearchManifest(compact, 2025);
  const values = new Float32Array(compact.count * 64); values[22 * 64] = 1;
  const [match] = searchEmbeddingIndex(compact, values, reference, 'source', sourceBounds, .9);
  assert.equal(match.sourceX, 11);
  assert.equal(match.lon, .011);
  assert.ok(Math.abs(match.patchMeters - 222.64) < .01);
});

test('index schema and navigation state reject invalid dimensions, years and references', () => {
  assert.doesNotThrow(() => validateSearchManifest(m, 2025));
  for (const bad of [{ valuesFile: '../secret' }, { count: 1 }, { year: 2017 }, { locations: [m.locations[0], m.locations[0]] }]) {
    assert.throws(() => validateSearchManifest({ ...m, ...bad }, 2025));
  }
  const arrival = { slug: 'a', year: 2025, lon: .005, lat: .0005, score: .95, reference: Array.from(reference), sourceLabel: 'Source' };
  assert.deepEqual(readEmbeddingArrival(arrival, 'a', [2025], bounds), arrival);
  for (const bad of [{ year: 2017 }, { slug: 'b' }, { lon: 50 }, { score: 2 }, { reference: Array(64).fill(0) }, { reference: [NaN] }]) {
    assert.equal(readEmbeddingArrival({ ...arrival, ...bad }, 'a', [2025], bounds), null);
  }
  assert.equal(unitReference(new Float32Array(64)), null);
});

test('prepared index yields real matches, and the search worker preserves source exclusions', async () => {
  const root = new URL('../../public/data/embedding-search/2025/', import.meta.url);
  const meta = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
  const raw = readFileSync(new URL('values.bin', root));
  validateSearchManifest(meta, 2025);
  assert.equal(raw.byteLength, meta.count * 64);
  const source = meta.locations.find(l => l.slug === 'gorny-gigant');
  const target = meta.locations.find(l => l.slug === 'almaty');
  const vectors = normalizeEmbeddings(new Int8Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)));
  const ref = vectors.slice(target.offset * 64, target.offset * 64 + 64); // Northern Almaty, outside Gorny Gigant.
  const matches = searchEmbeddingIndex(meta, vectors, ref, source.slug, source.bounds, .9);
  for (const slug of ['balqash', 'balqash-lake']) {
    const added = meta.locations.find(l => l.slug === slug);
    assert.ok(added, `${slug} is included in the real index`);
    const addedReference = vectors.slice(added.offset * 64, (added.offset + 1) * 64);
    const results = searchEmbeddingIndex(meta, vectors, addedReference, source.slug, source.bounds, .99);
    const match = results.find(result => result.slug === slug);
    assert.ok(match && match.score > .999);
    assert.ok(slug === 'balqash-lake' ? match.patchMeters > 4000 : match.patchMeters < 60);
  }

  assert.ok(matches.some(match => match.slug === 'almaty' && match.score > .999));
  assert.ok(matches.every(match => match.slug !== source.slug && !insideBounds(match.lon, match.lat, source.bounds)));
  const messages = [];
  globalThis.self = { postMessage: message => messages.push(message) };
  const worker = compile('../../src/workers/embedding-search.worker.ts')
    .replace(/from ['"]\.\.\/lib\/satellite-embeddings['"]/, `from '${coreUrl}'`)
    .replace(/from ['"]\.\.\/lib\/embedding-search['"]/, `from '${searchUrl}'`);
  await import(asUrl(worker));
  self.onmessage({ data: { manifest: meta, buffer: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), reference: ref,
    slug: source.slug, year: 2025, bounds: source.bounds, threshold: .9 } });
  assert.deepEqual(messages[0].matches, matches);
  assert.equal(messages[0].locations, meta.locations.length - 1);
  delete globalThis.self;
});
