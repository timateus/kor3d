import type { GeoBounds } from './geotiff-loader';

export interface EmbeddingMetadata {
  dataset?: string;
  crs?: string;
  version: number;
  year: number;
  width: number;
  height: number;
  dimensions: number;
  encoding: string;
  noData: number;
  bounds: GeoBounds;
  valuesFile: string;
  attribution: string;
  sourceResolutionMeters: number;
  gridSpacingMeters?: { x: number; y: number };
  aggregationMeters?: number;
}

export function validateEmbeddingMetadata(meta: EmbeddingMetadata) {
  const b = meta.bounds;
  if (meta.version !== 1 || meta.dimensions !== 64 || meta.encoding !== 'aef-int8' || meta.noData !== -128 ||
      !Number.isInteger(meta.width) || !Number.isInteger(meta.height) || meta.width < 1 || meta.height < 1 ||
      meta.width * meta.height > 512 * 512 || !b ||
      ![b.minLon, b.maxLon, b.minLat, b.maxLat].every(Number.isFinite) ||
      b.minLon >= b.maxLon || b.minLat >= b.maxLat || meta.valuesFile !== 'values.bin') {
    throw new Error('Unsupported AlphaEarth data format');
  }
}

/** Approximate displayed cell size, including exports made before spacing metadata. */
export function embeddingGridMeters(meta: EmbeddingMetadata): number {
  const b = meta.bounds;
  return Math.max((b.maxLon - b.minLon) * 111320 * Math.cos((b.maxLat + b.minLat) / 2 * Math.PI / 180) / meta.width,
    (b.maxLat - b.minLat) * 111320 / meta.height);
}

export function formatEmbeddingMeters(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

/** Pixel cells, north to south; bounds describe outer edges, not pixel centres. */
export function embeddingPixel(meta: EmbeddingMetadata, lon: number, lat: number): number | null {
  const b = meta.bounds;
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < b.minLon || lon > b.maxLon || lat < b.minLat || lat > b.maxLat) return null;
  const x = Math.min(meta.width - 1, Math.floor((lon - b.minLon) / (b.maxLon - b.minLon) * meta.width));
  const y = Math.min(meta.height - 1, Math.floor((b.maxLat - lat) / (b.maxLat - b.minLat) * meta.height));
  return y * meta.width + x;
}

/** Google's nonlinear inverse quantization. */
export function decodeEmbedding(value: number): number {
  return Math.sign(value) * (value / 127.5) ** 2;
}

export function normalizeEmbeddings(raw: Int8Array): Float32Array {
  const result = new Float32Array(raw.length);
  for (let offset = 0; offset < raw.length; offset += 64) {
    let norm = 0;
    let valid = true;
    for (let d = 0; d < 64; d++) {
      if (raw[offset + d] === -128) valid = false;
      const v = decodeEmbedding(raw[offset + d]);
      result[offset + d] = v;
      norm += v * v;
    }
    norm = Math.sqrt(norm);
    for (let d = 0; d < 64; d++) result[offset + d] = valid && norm > 0 ? result[offset + d] / norm : 0;
  }
  return result;
}

export function similarityScores(values: Float32Array, reference: number | Float32Array): Float32Array | null {
  const start = typeof reference === 'number' ? reference * 64 : 0;
  if (typeof reference === 'number' && (!Number.isInteger(reference) || start < 0 || start + 64 > values.length)) return null;
  const vector = typeof reference === 'number' ? values.subarray(start, start + 64) : reference;
  if (vector.length !== 64 || !vector.some(v => v !== 0)) return null;
  const scores = new Float32Array(values.length / 64);
  for (let p = 0; p < scores.length; p++) {
    let dot = 0, valid = false;
    for (let d = 0; d < 64; d++) {
      const value = values[p * 64 + d];
      valid ||= value !== 0;
      dot += value * vector[d];
    }
    scores[p] = valid ? Math.max(-1, Math.min(1, dot)) : NaN;
  }
  return scores;
}

export interface EmbeddingRaster { width: number; height: number; rgba: Uint8ClampedArray; bounds: GeoBounds }

/** Average valid unit vectors, then normalize the result onto the unit sphere. */
export function areaReference(values: Float32Array, pixels: Uint32Array): { vector: Float32Array; count: number } | null {
  const vector = new Float32Array(64);
  const seen = new Set<number>();
  let count = 0;
  for (const pixel of pixels) {
    if (seen.has(pixel) || pixel * 64 + 64 > values.length) continue;
    seen.add(pixel);
    let valid = false;
    for (let d = 0; d < 64; d++) valid ||= values[pixel * 64 + d] !== 0;
    if (!valid) continue;
    for (let d = 0; d < 64; d++) vector[d] += values[pixel * 64 + d];
    count++;
  }
  const norm = Math.hypot(...vector);
  if (!count || norm < 1e-8) return null;
  for (let d = 0; d < 64; d++) vector[d] /= norm;
  return { vector, count };
}

/** Paint a continuous circular stroke in metres, clipping to the pixel grid. */
export function paintEmbeddingStroke(mask: Uint8Array, meta: EmbeddingMetadata,
  from: { lon: number; lat: number }, to: { lon: number; lat: number }, radius: number): void {
  if (!(radius > 0) || ![from.lon, from.lat, to.lon, to.lat, radius].every(Number.isFinite)) return;
  const b = meta.bounds;
  const metresX = 111320 * Math.cos((b.minLat + b.maxLat) / 2 * Math.PI / 180);
  const metresY = 111320;
  const dx = (to.lon - from.lon) * metresX, dy = (to.lat - from.lat) * metresY;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (radius / 2)));
  const cellX = (b.maxLon - b.minLon) / meta.width, cellY = (b.maxLat - b.minLat) / meta.height;
  for (let step = 0; step <= steps; step++) {
    const lon = from.lon + (to.lon - from.lon) * step / steps;
    const lat = from.lat + (to.lat - from.lat) * step / steps;
    const x0 = Math.max(0, Math.floor((lon - radius / metresX - b.minLon) / cellX));
    const x1 = Math.min(meta.width - 1, Math.floor((lon + radius / metresX - b.minLon) / cellX));
    const y0 = Math.max(0, Math.floor((b.maxLat - lat - radius / metresY) / cellY));
    const y1 = Math.min(meta.height - 1, Math.floor((b.maxLat - lat + radius / metresY) / cellY));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = (b.minLon + (x + 0.5) * cellX - lon) * metresX;
      const py = (b.maxLat - (y + 0.5) * cellY - lat) * metresY;
      if (px * px + py * py <= radius * radius) mask[y * meta.width + x] = 1;
    }
  }
}

export interface EmbeddingChangeStats { validPixels: number; aboveThreshold: number; meanChange: number }

/** Reject misaligned rasters instead of silently comparing different ground pixels. */
export function validateEmbeddingPair(a: EmbeddingMetadata, b: EmbeddingMetadata): void {
  validateEmbeddingMetadata(a);
  validateEmbeddingMetadata(b);
  if (!a.dataset || a.dataset !== b.dataset || a.crs !== 'EPSG:4326' || b.crs !== a.crs ||
      a.width !== b.width || a.height !== b.height || a.year === b.year ||
      !(['minLon', 'maxLon', 'minLat', 'maxLat'] as const).every(key => Math.abs(a.bounds[key] - b.bounds[key]) < 1e-10)) {
    throw new Error('The annual embedding grids are not compatible for comparison');
  }
}

/** Angular change proxy: 1 - cosine similarity, range 0..2. Missing pairs remain NaN. */
export function embeddingChanges(a: Float32Array, b: Float32Array): Float32Array {
  if (a.length !== b.length || a.length % 64 !== 0) throw new Error('Annual embedding arrays must have equal dimensions');
  const changes = new Float32Array(a.length / 64);
  for (let pixel = 0; pixel < changes.length; pixel++) {
    let dot = 0, validA = false, validB = false;
    const offset = pixel * 64;
    for (let d = 0; d < 64; d++) {
      const x = a[offset + d], y = b[offset + d];
      validA ||= x !== 0;
      validB ||= y !== 0;
      dot += x * y;
    }
    changes[pixel] = validA && validB && Number.isFinite(dot) ? Math.max(0, Math.min(2, 1 - dot)) : NaN;
  }
  return changes;
}

export function embeddingOverview(values: Float32Array): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(values.length / 64 * 4);
  for (let pixel = 0; pixel < values.length / 64; pixel++) {
    const offset = pixel * 64;
    if (!values.subarray(offset, offset + 64).some(v => v !== 0)) continue;
    [1, 16, 9].forEach((d, channel) => {
      rgba[pixel * 4 + channel] = Math.max(0, Math.min(255, (values[offset + d] + 0.3) / 0.6 * 255));
    });
    rgba[pixel * 4 + 3] = 255;
  }
  return rgba;
}
