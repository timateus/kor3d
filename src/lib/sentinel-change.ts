import type { GeoBounds } from './geotiff-loader';
import type { EmbeddingRaster } from './satellite-embeddings';

/** Per-year summer composites written by scripts/prefetch/sentinel-change.py. */
export type SentinelBand = 'ndvi' | 'bsi' | 'vh' | 'vv';
export const SENTINEL_BANDS: SentinelBand[] = ['ndvi', 'bsi', 'vh', 'vv'];

export interface SentinelYear {
  year: number;
  s2Dates: number;
  s1Scenes: number;
  s2MedianObservations: number;
  s1MedianObservations: number;
  s2ValidFraction: number;
}

export interface SentinelManifest {
  version: number;
  width: number;
  height: number;
  bounds: GeoBounds;
  season: { start: string; end: string };
  bands: SentinelBand[];
  scales: Record<SentinelBand, [number, number]>;
  s1Orbit: { relative: number; state: string };
  years: SentinelYear[];
  attribution: string;
}

export type SentinelChangeKind = 'vegetation' | 'bare' | 'radar';

export interface SentinelChangeStats { changed: number; comparable: number; hectares: number }

export function validateSentinelManifest(m: SentinelManifest) {
  const b = m?.bounds;
  if (m?.version !== 1 || !Number.isInteger(m.width) || !Number.isInteger(m.height) || m.width < 1 || m.height < 1
    || !b || !(b.minLon < b.maxLon && b.minLat < b.maxLat) || !Array.isArray(m.years) || !m.years.length
    || SENTINEL_BANDS.some((band, i) => m.bands?.[i] !== band || !Array.isArray(m.scales?.[band]))) {
    throw new Error('Unsupported Sentinel manifest');
  }
}

/** Area of one grid cell in hectares (bounds are outer pixel edges). */
export function sentinelPixelHectares(m: Pick<SentinelManifest, 'bounds' | 'width' | 'height'>): number {
  const b = m.bounds;
  const dx = (b.maxLon - b.minLon) * 111320 * Math.cos(((b.minLat + b.maxLat) / 2) * Math.PI / 180) / m.width;
  const dy = (b.maxLat - b.minLat) * 111320 / m.height;
  return dx * dy / 10000;
}

/** Decode one interleaved uint8 band; 0 is no data and becomes NaN. */
export function decodeSentinelBand(indices: Uint8Array, band: SentinelBand, scales: SentinelManifest['scales']): Float32Array {
  const b = SENTINEL_BANDS.indexOf(band);
  const [lo, hi] = scales[band];
  const out = new Float32Array(indices.length / SENTINEL_BANDS.length);
  for (let i = 0; i < out.length; i++) {
    const q = indices[i * SENTINEL_BANDS.length + b];
    out[i] = q === 0 ? NaN : lo + (q - 1) / 254 * (hi - lo);
  }
  return out;
}

/** Pixel index for a coordinate, rows north to south; null outside the grid. */
export function sentinelPixel(m: Pick<SentinelManifest, 'bounds' | 'width' | 'height'>, lon: number, lat: number): number | null {
  const b = m.bounds;
  const col = Math.floor((lon - b.minLon) / (b.maxLon - b.minLon) * m.width);
  const row = Math.floor((b.maxLat - lat) / (b.maxLat - b.minLat) * m.height);
  return col < 0 || row < 0 || col >= m.width || row >= m.height ? null : row * m.width + col;
}

const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);

/**
 * Change between two years, coloured where it passes the threshold.
 * vegetation: NDVI drop (a − b), only where year A was vegetated (NDVI ≥ minBase).
 * bare: bare-soil-index rise (b − a).
 * radar: VH backscatter change in dB, both directions (rise cyan, fall orange).
 */
export function sentinelChange(kind: SentinelChangeKind, a: Float32Array, b: Float32Array, threshold: number,
  bounds: GeoBounds, width: number, height: number, minBase = 0.3): { raster: EmbeddingRaster; stats: SentinelChangeStats } {
  const rgba = new Uint8ClampedArray(a.length * 4);
  const span = kind === 'radar' ? 6 : 0.3;
  let changed = 0, comparable = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue;
    if (kind === 'vegetation' && a[i] < minBase) continue;
    comparable++;
    const delta = kind === 'vegetation' ? a[i] - b[i] : b[i] - a[i];
    const size = kind === 'radar' ? Math.abs(delta) : delta;
    if (size < threshold) continue;
    changed++;
    const t = Math.min(1, (size - threshold) / span);
    const o = i * 4;
    if (kind === 'radar') {
      if (delta > 0) { rgba[o] = lerp(120, 230, t); rgba[o + 1] = lerp(220, 255, t); rgba[o + 2] = 255; }
      else { rgba[o] = 255; rgba[o + 1] = lerp(170, 90, t); rgba[o + 2] = lerp(60, 20, t); }
    } else {
      // Same yellow → magenta ramp as the embedding Difference view.
      rgba[o] = lerp(255, 215, t); rgba[o + 1] = lerp(210, 35, t); rgba[o + 2] = lerp(90, 110, t);
    }
    rgba[o + 3] = 230;
  }
  return { raster: { width, height, rgba, bounds }, stats: { changed, comparable, hectares: changed * sentinelPixelHectares({ bounds, width, height }) } };
}

/** Sequential palette for onset years, early (violet) to recent (yellow). */
export function onsetColor(index: number, count: number): [number, number, number] {
  const stops: [number, number, number][] = [[94, 60, 153], [59, 130, 189], [33, 171, 140], [140, 200, 75], [253, 220, 60]];
  const t = count <= 1 ? 1 : index / (count - 1);
  const s = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)));
  const f = t * (stops.length - 1) - s;
  return [0, 1, 2].map(c => lerp(stops[s][c], stops[s + 1][c], f)) as [number, number, number];
}

/**
 * First year in which a pixel's NDVI fell at least `threshold` below the
 * first (baseline) year and stayed down in every later year with data.
 * The persistence test drops one-off dips from late snow, cloud residue
 * or drought. `series` is ordered by year; index 0 is the baseline.
 * Losses first seen in the newest year cannot be confirmed by a later one;
 * they are left out unless `includeLast` is set.
 */
export function vegetationLossOnset(series: Float32Array[], years: number[], threshold: number,
  bounds: GeoBounds, width: number, height: number, minBase = 0.3, includeLast = false): { raster: EmbeddingRaster; onset: Int16Array; counts: { year: number; hectares: number }[] } {
  const n = series[0].length;
  const rgba = new Uint8ClampedArray(n * 4);
  const onset = new Int16Array(n);
  const counts = years.map(year => ({ year, hectares: 0 }));
  const area = sentinelPixelHectares({ bounds, width, height });
  for (let i = 0; i < n; i++) {
    const base = series[0][i];
    if (!Number.isFinite(base) || base < minBase) continue;
    // Scan backwards: `down` is true while every later valid year is below the baseline.
    let first = -1, down = true, seen = false;
    for (let k = series.length - 1; k >= 1; k--) {
      const v = series[k][i];
      if (Number.isFinite(v)) {
        seen = true;
        down = down && base - v >= threshold;
      }
      if (!down) break;
      if (seen && Number.isFinite(v)) first = k;
    }
    if (first < 1 || (!includeLast && first === series.length - 1)) continue;
    onset[i] = years[first];
    counts[first].hectares += area;
    const [r, g, b] = onsetColor(first - 1, years.length - 1);
    rgba.set([r, g, b, 235], i * 4);
  }
  return { raster: { width, height, rgba, bounds }, onset, counts: counts.slice(1, includeLast ? undefined : -1) };
}
