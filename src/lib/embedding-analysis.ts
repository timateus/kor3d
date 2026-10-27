import { decodeEmbedding, type EmbeddingMetadata } from './satellite-embeddings';

export interface LocalStats { validPixels: number; aboveThreshold: number; mean: number }
export interface ShorelineStats {
  validPixels: number; areaKm2: number; comparisonAreaKm2: number | null;
  gainKm2: number | null; lossKm2: number | null; boundaryEdges: number;
}

/** Centre-to-neighbourhood angular distance; transitions compare opposite neighbours.
 * Offsets are in display cells. No-data and incomplete neighbourhoods stay missing. */
export function localEmbeddingDifference(values: Float32Array, width: number, height: number, radius: number,
  kind: 'anomaly' | 'transition'): Float32Array {
  if (values.length !== width * height * 64 || !Number.isInteger(radius) || radius < 1 || radius > 8) throw new Error('Invalid neighbourhood');
  const result = new Float32Array(width * height).fill(NaN);
  const valid = (p: number) => values.subarray(p * 64, p * 64 + 64).some(v => v !== 0);
  const dot = (a: number, b: number) => { let sum = 0; for (let d = 0; d < 64; d++) sum += values[a * 64 + d] * values[b * 64 + d]; return Math.max(-1, Math.min(1, sum)); };
  const mean = new Float64Array(64);
  for (let y = radius; y < height - radius; y++) for (let x = radius; x < width - radius; x++) {
    const p = y * width + x;
    const neighbours = [-radius * width - radius, -radius * width, -radius * width + radius, -radius, radius, radius * width - radius, radius * width, radius * width + radius].map(offset => p + offset);
    if (!valid(p) || neighbours.some(q => !valid(q))) continue;
    if (kind === 'transition') {
      result[p] = (2 - dot(p - radius, p + radius) - dot(p - radius * width, p + radius * width)) / 2;
    } else {
      mean.fill(0);
      for (const q of neighbours) for (let d = 0; d < 64; d++) mean[d] += values[q * 64 + d];
      const norm = Math.hypot(...mean);
      if (norm < 1e-8) continue;
      let score = 0; for (let d = 0; d < 64; d++) score += values[p * 64 + d] * mean[d] / norm;
      result[p] = Math.max(0, Math.min(2, 1 - score));
    }
  }
  return result;
}

export function colourLocalDifference(scores: Float32Array, threshold: number) {
  const rgba = new Uint8ClampedArray(scores.length * 4);
  const stats: LocalStats = { validPixels: 0, aboveThreshold: 0, mean: 0 };
  for (let p = 0; p < scores.length; p++) {
    const value = scores[p]; if (!Number.isFinite(value)) continue;
    stats.validPixels++; stats.mean += value;
    if (value < threshold) continue;
    stats.aboveThreshold++;
    const t = Math.min(1, (value - threshold) / .35);
    rgba.set([Math.round(255 - 80 * t), Math.round(200 - 160 * t), Math.round(80 + 140 * t), 220], p * 4);
  }
  if (stats.validPixels) stats.mean /= stats.validPixels;
  return { rgba, stats };
}

/** Candidate extent using one fixed reference. Extents for two years use only
 * their common valid coverage. Missing data and scene edges are not coastlines. */
export function candidateShoreline(scores: Float32Array, other: Float32Array | null, meta: EmbeddingMetadata, threshold: number) {
  const { width, height, bounds: b } = meta;
  if (scores.length !== width * height || other && other.length !== scores.length) throw new Error('Invalid shoreline grid');
  const mask = new Uint8Array(scores.length), previous = new Uint8Array(scores.length), valid = new Uint8Array(scores.length);
  const rgba = new Uint8ClampedArray(scores.length * 4);
  const edges: number[] = [];
  const stats: ShorelineStats = { validPixels: 0, areaKm2: 0, comparisonAreaKm2: other ? 0 : null, gainKm2: other ? 0 : null, lossKm2: other ? 0 : null, boundaryEdges: 0 };
  const dx = (b.maxLon - b.minLon) / width, dy = (b.maxLat - b.minLat) / height;
  for (let y = 0; y < height; y++) {
    const lat = b.maxLat - (y + .5) * dy;
    const area = dx * dy * 111.32 ** 2 * Math.cos(lat * Math.PI / 180);
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!Number.isFinite(scores[p]) || other && !Number.isFinite(other[p])) continue;
      valid[p] = 1; stats.validPixels++;
      mask[p] = Number(scores[p] >= threshold); previous[p] = Number(!!other && other[p] >= threshold);
      if (mask[p]) { stats.areaKm2 += area; rgba.set([35, 185, 220, 110], p * 4); }
      if (other) {
        if (previous[p]) stats.comparisonAreaKm2! += area;
        if (mask[p] && !previous[p]) { stats.gainKm2! += area; rgba.set([55, 220, 150, 190], p * 4); }
        if (!mask[p] && previous[p]) { stats.lossKm2! += area; rgba.set([235, 75, 135, 190], p * 4); }
      }
    }
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x; if (!valid[p]) continue;
    for (const [q, coords] of [
      [x + 1 < width ? p + 1 : -1, [b.minLon + (x + 1) * dx, b.maxLat - y * dy, b.minLon + (x + 1) * dx, b.maxLat - (y + 1) * dy]],
      [y + 1 < height ? p + width : -1, [b.minLon + x * dx, b.maxLat - (y + 1) * dy, b.minLon + (x + 1) * dx, b.maxLat - (y + 1) * dy]],
    ] as [number, number[]][]) {
      if (q < 0 || !valid[q] || mask[p] === mask[q]) continue;
      edges.push(...coords); stats.boundaryEdges++;
      rgba.set([255, 225, 70, 255], (mask[p] ? p : q) * 4);
    }
  }
  return { rgba, stats, edges: Float32Array.from(edges) };
}

export function shorelineGeoJSON(edges: Float32Array, properties: Record<string, unknown>) {
  const coordinates: number[][][] = [];
  for (let i = 0; i < edges.length; i += 4) coordinates.push([[edges[i], edges[i + 1]], [edges[i + 2], edges[i + 3]]]);
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties, geometry: { type: 'MultiLineString', coordinates } }] };
}

/** Decode a single pixel, rather than normalizing a full annual raster. */
export function decodeTimelineVector(raw: Int8Array): Float32Array | null {
  if (raw.length !== 64 || raw.some(value => value === -128)) return null;
  const vector = Float32Array.from(raw, decodeEmbedding), norm = Math.hypot(...vector);
  if (norm < 1e-8) return null;
  return vector.map(v => v / norm);
}
export interface TimelineSample { year: number; vector: Float32Array | null }
export function embeddingTrajectory(samples: TimelineSample[]) {
  const sorted = [...samples].sort((a, b) => a.year - b.year);
  const first = sorted.find(sample => sample.vector)?.vector;
  const change = (a?: Float32Array | null, b?: Float32Array | null) => a && b ? Math.max(0, Math.min(2, 1 - a.reduce((sum, v, d) => sum + v * b[d], 0))) : null;
  return sorted.map((sample, i) => ({ year: sample.year, fromBaseline: change(first, sample.vector),
    fromPrevious: i && sorted[i - 1].year === sample.year - 1 ? change(sorted[i - 1].vector, sample.vector) : null }));
}
