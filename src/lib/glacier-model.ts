import { checkedFetch, GLACIER_TEST_BASE, type GlacierTestData } from './glacier-test';

/** Portable, geographic display format for offline glacier model outputs. Metres throughout. */
export interface GlacierModel {
  schema: 'kor3d-glacier-v1';
  title: string;
  source: string;
  kind: 'reference' | 'simulation';
  width: number;
  height: number;
  // Row-major geographic node coordinates; supports projected source grids after transformation.
  longitude: number[];
  latitude: number[];
  bedrock: (number | null)[];
  frames: { label: string; thickness: (number | null)[]; speed?: (number | null)[] }[];
}
const MAX_VALUES = 4_000_000;
export function parseGlacierModel(value: unknown): GlacierModel {
  if (!value || typeof value !== 'object') throw new Error('Expected a glacier model JSON object.');
  const d = value as GlacierModel;
  if (d.schema !== 'kor3d-glacier-v1') throw new Error('Expected schema kor3d-glacier-v1. Use the NetCDF converter for model output.');
  if (![d.title, d.source].every(v => typeof v === 'string' && v.trim().length > 0)) throw new Error('Title and source are required.');
  if (d.kind !== 'reference' && d.kind !== 'simulation') throw new Error('Model kind must be reference or simulation.');
  if (![d.width, d.height].every(v => Number.isInteger(v) && v >= 2 && v <= 600)) throw new Error('Grid dimensions must be between 2 and 600 nodes.');
  const n = d.width * d.height;
  if (!Array.isArray(d.frames) || !d.frames.length || d.frames.length > 500 || n * d.frames.length > MAX_VALUES) throw new Error('Use 1–500 frames, with at most 4 million grid values in total.');
  const check = (a: unknown, name: string, nullable = true, min = -Infinity, max = Infinity) => {
    if (!Array.isArray(a) || a.length !== n || a.some(v => !(nullable && v === null) && (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max))) throw new Error(`${name}: expected ${n} finite values${nullable ? ' or null' : ''} in the permitted range.`);
  };
  check(d.longitude, 'Longitude', false, -180, 180); check(d.latitude, 'Latitude', false, -89, 89);
  if (d.longitude.every(v => v === d.longitude[0])) throw new Error('Grid has no longitude extent.');
  if (d.latitude.every(v => v === d.latitude[0])) throw new Error('Grid has no latitude extent.');
  check(d.bedrock, 'Bedrock');
  let hasIce = false;
  d.frames.forEach((f, i) => {
    if (!f || typeof f.label !== 'string' || !f.label.trim()) throw new Error(`Frame ${i + 1} needs a label.`);
    check(f.thickness, `Frame ${i + 1} thickness`, true, 0);
    if (f.speed !== undefined) check(f.speed, `Frame ${i + 1} speed (m/year)`, true, 0);
    if (f.thickness.some((h, j) => h !== null && h > 0 && d.bedrock[j] !== null)) hasIce = true;
  });
  if (!hasIce) throw new Error('No ice thickness overlaps valid bedrock in this file.');
  return d;
}

export function modelCoordinates(model: GlacierModel) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity, minBed = Infinity;
  for (let i = 0; i < model.longitude.length; i++) {
    minLon = Math.min(minLon, model.longitude[i]); maxLon = Math.max(maxLon, model.longitude[i]);
    minLat = Math.min(minLat, model.latitude[i]); maxLat = Math.max(maxLat, model.latitude[i]);
    if (model.bedrock[i] !== null) minBed = Math.min(minBed, model.bedrock[i]!);
  }
  const cosLat = Math.cos((minLat + maxLat) / 2 * Math.PI / 180);
  const x = model.longitude.map(lon => (lon - (minLon + maxLon) / 2) * 111320 * cosLat);
  const z = model.latitude.map(lat => ((minLat + maxLat) / 2 - lat) * 111320);
  const span = Math.max((maxLon - minLon) * 111320 * cosLat, (maxLat - minLat) * 111320);
  return { x, z, minBed, span };
}

export function modelStats(model: GlacierModel, frame: number, coords = modelCoordinates(model)) {
  const h = model.frames[frame].thickness;
  let volume = 0, area = 0, maxThickness = 0;
  h.forEach((v, i) => { if (v !== null && model.bedrock[i] !== null) maxThickness = Math.max(maxThickness, v); });
  for (let row = 0; row < model.height - 1; row++) for (let col = 0; col < model.width - 1; col++) {
    const a = row * model.width + col, b = a + 1, c = a + model.width, d = c + 1;
    for (const tri of [[a, c, b], [b, c, d]]) {
      if (tri.some(i => h[i] === null || model.bedrock[i] === null)) continue;
      const [i, j, k] = tri;
      const cellArea = Math.abs((coords.x[j] - coords.x[i]) * (coords.z[k] - coords.z[i]) - (coords.x[k] - coords.x[i]) * (coords.z[j] - coords.z[i])) / 2;
      volume += cellArea * (h[i]! + h[j]! + h[k]!) / 3;
      // Area of the displayed triangular ice footprint, including boundary triangles.
      if (tri.some(v => h[v]! > 0)) area += cellArea;
    }
  }
  return { volume: volume / 1e9, area: area / 1e6, maxThickness };
}

export async function loadReferenceGlacier(data: GlacierTestData, signal: AbortSignal): Promise<GlacierModel> {
  const base = `${import.meta.env.BASE_URL}data/locations/tuyuksu-glacier/`;
  const meta = await (await checkedFetch(base + 'ice_thickness.json', signal)).json();
  const values = new Float32Array(await (await checkedFetch(base + meta.valuesFile, signal)).arrayBuffer());
  if (values.length !== meta.width * meta.height) throw new Error('Reference thickness dimensions do not match.');
  const t = data.terrain, bounds = t.bounds!;
  const longitude: number[] = [], latitude: number[] = [], bedrock: (number | null)[] = [], thickness: (number | null)[] = [];
  for (let row = 0; row < t.height; row++) for (let col = 0; col < t.width; col++) {
    const lon = bounds.minLon + col / (t.width - 1) * (bounds.maxLon - bounds.minLon);
    const lat = bounds.maxLat - row / (t.height - 1) * (bounds.maxLat - bounds.minLat);
    longitude.push(lon); latitude.push(lat);
    const u = (lon - meta.minLon) / (meta.maxLon - meta.minLon), v = (meta.maxLat - lat) / (meta.maxLat - meta.minLat);
    const value = u < 0 || u > 1 || v < 0 || v > 1 ? 0 : values[Math.round(v * (meta.height - 1)) * meta.width + Math.round(u * (meta.width - 1))];
    const h = Number.isFinite(value) && value >= 0 ? value : null;
    const elevation = t.elevations[row * t.width + col];
    thickness.push(h); bedrock.push(h !== null && Number.isFinite(elevation) ? elevation - h : null);
  }
  return parseGlacierModel({ schema: 'kor3d-glacier-v1', title: 'Central Tuyuksu · reference geometry',
    source: `${meta.source}. Surface: Mapterhorn, acquisition date unspecified. Bed inferred as surface minus estimated thickness; datasets are not co-temporal.`,
    kind: 'reference', width: t.width, height: t.height, longitude, latitude, bedrock,
    frames: [{ label: 'Reference estimate · date unspecified', thickness }] });
}

/** Load the published, precomputed OGGM run; numerical modeling is done offline. */
export async function loadTuyuksuSimulation(signal: AbortSignal): Promise<GlacierModel> {
  const response = await checkedFetch(GLACIER_TEST_BASE + 'tuyuksu-oggm.json', signal);
  return parseGlacierModel(await response.json());
}
