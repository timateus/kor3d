import type { GeoBounds } from './geotiff-loader';

export interface SearchLocation {
  slug: string; label: string; bounds: GeoBounds;
  sourceWidth: number; sourceHeight: number; width: number; height: number;
  offset: number; count: number;
}
export interface EmbeddingSearchManifest {
  version: number; year: number; dataset: string; encoding: string; dimensions: number;
  blockSize: number; count: number; valuesFile: string; locations: SearchLocation[];
}
export interface EmbeddingMatch {
  slug: string; label: string; year: number; lat: number; lon: number; score: number;
  sourceWidth: number; sourceHeight: number; sourceX: number; sourceY: number; patchMeters: number;
}
export interface ExternalEmbeddingReference {
  vector: number[]; sourceLabel: string; anchor: { lon: number; lat: number }; score: number;
}
export interface EmbeddingArrival {
  year: number; slug: string; lat: number; lon: number; score: number;
  reference: number[]; sourceLabel: string; patchMeters?: number;
}

export function unitReference(input: ArrayLike<number>): Float32Array | null {
  if (!input || input.length !== 64) return null;
  const out = Float32Array.from(input);
  if (!out.every(Number.isFinite)) return null;
  const norm = Math.hypot(...out);
  if (norm < 1e-8) return null;
  for (let d = 0; d < 64; d++) out[d] /= norm;
  return out;
}

export function insideBounds(lon: number, lat: number, bounds: GeoBounds): boolean {
  return lon >= bounds.minLon && lon <= bounds.maxLon && lat >= bounds.minLat && lat <= bounds.maxLat;
}

export function validateSearchManifest(m: EmbeddingSearchManifest, year: number): void {
  if (!m || m.version !== 1 || m.year !== year || m.dataset !== 'GOOGLE/SATELLITE_EMBEDDING/V1/ANNUAL' ||
      m.encoding !== 'aef-int8' || m.dimensions !== 64 || m.valuesFile !== 'values.bin' ||
      !Number.isInteger(m.blockSize) || m.blockSize < 1 || m.blockSize > 20 ||
      !Array.isArray(m.locations) || m.locations.length < 2 || m.locations.length > 16) throw new Error('Unsupported search index');
  let offset = 0;
  const slugs = new Set<string>();
  for (const location of m.locations) {
    const b = location.bounds;
    if (!/^[a-z0-9-]+$/.test(location.slug) || slugs.has(location.slug) || !location.label ||
        ![location.sourceWidth, location.sourceHeight, location.width, location.height, location.offset, location.count].every(Number.isInteger) ||
        location.sourceWidth < 1 || location.sourceHeight < 1 || location.sourceWidth * location.sourceHeight > 512 * 512 ||
        location.width !== Math.ceil(location.sourceWidth / m.blockSize) || location.height !== Math.ceil(location.sourceHeight / m.blockSize) ||
        location.offset !== offset || location.count !== location.width * location.height || !b ||
        ![b.minLon, b.maxLon, b.minLat, b.maxLat].every(Number.isFinite) ||
        b.minLon < -180 || b.maxLon > 180 || b.minLat < -90 || b.maxLat > 90 || b.minLon >= b.maxLon || b.minLat >= b.maxLat) throw new Error('Invalid location in search index');
    offset += location.count;
    slugs.add(location.slug);
  }
  if (offset !== m.count || offset > 100000) throw new Error('Invalid search index size');
}

/** Approximate metre distance is sufficient for suppressing nearby duplicate results. */
function distance(a: { lon: number; lat: number }, b: { lon: number; lat: number }) {
  const x = (a.lon - b.lon) * 111320 * Math.cos((a.lat + b.lat) / 2 * Math.PI / 180);
  const y = (a.lat - b.lat) * 111320;
  return Math.hypot(x, y);
}

export function searchEmbeddingIndex(manifest: EmbeddingSearchManifest, values: Float32Array, reference: Float32Array,
  excludedSlug: string, excludedBounds: GeoBounds, threshold: number, limit = 6): EmbeddingMatch[] {
  const unit = unitReference(reference);
  if (values.length !== manifest.count * 64 || !unit || !Number.isFinite(threshold)) throw new Error('Invalid search input');
  const candidates: EmbeddingMatch[] = [];
  for (const location of manifest.locations) {
    if (location.slug === excludedSlug) continue;
    for (let p = 0; p < location.count; p++) {
      const x = p % location.width, y = Math.floor(p / location.width);
      const sourceX = (x * manifest.blockSize + Math.min((x + 1) * manifest.blockSize, location.sourceWidth)) / 2;
      const sourceY = (y * manifest.blockSize + Math.min((y + 1) * manifest.blockSize, location.sourceHeight)) / 2;
      const lon = location.bounds.minLon + sourceX / location.sourceWidth * (location.bounds.maxLon - location.bounds.minLon);
      const lat = location.bounds.maxLat - sourceY / location.sourceHeight * (location.bounds.maxLat - location.bounds.minLat);
      const west = location.bounds.minLon + x * manifest.blockSize / location.sourceWidth * (location.bounds.maxLon - location.bounds.minLon);
      const east = location.bounds.minLon + Math.min((x + 1) * manifest.blockSize, location.sourceWidth) / location.sourceWidth * (location.bounds.maxLon - location.bounds.minLon);
      const north = location.bounds.maxLat - y * manifest.blockSize / location.sourceHeight * (location.bounds.maxLat - location.bounds.minLat);
      const south = location.bounds.maxLat - Math.min((y + 1) * manifest.blockSize, location.sourceHeight) / location.sourceHeight * (location.bounds.maxLat - location.bounds.minLat);
      if (west <= excludedBounds.maxLon && east >= excludedBounds.minLon && south <= excludedBounds.maxLat && north >= excludedBounds.minLat) continue;
      let score = 0, valid = false;
      const offset = (location.offset + p) * 64;
      for (let d = 0; d < 64; d++) { const v = values[offset + d]; score += v * unit[d]; valid ||= v !== 0; }
      score = Math.max(-1, Math.min(1, score));
      if (!valid || !Number.isFinite(score) || score < threshold) continue;
      candidates.push({ slug: location.slug, label: location.label, year: manifest.year, lat, lon, score,
        sourceWidth: location.sourceWidth, sourceHeight: location.sourceHeight, sourceX, sourceY,
        patchMeters: Math.max(distance({ lon: west, lat }, { lon: east, lat }), (north - south) * 111320) });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug) || a.lat - b.lat || a.lon - b.lon);
  const matches: EmbeddingMatch[] = [];
  for (const candidate of candidates) {
    if (matches.filter(match => match.slug === candidate.slug).length >= 3 || matches.some(match => distance(match, candidate) < 200)) continue;
    matches.push(candidate);
    if (matches.length >= limit) break;
  }
  return matches;
}

/** Route state is checked before it can set a reference or move the camera. */
export function readEmbeddingArrival(input: unknown, slug: string, years: number[], bounds: GeoBounds): EmbeddingArrival | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as EmbeddingArrival;
  if (value.patchMeters !== undefined && (!Number.isFinite(value.patchMeters) || value.patchMeters <= 0 || value.patchMeters > 100000)) return null;
  if (value.slug !== slug || !years.includes(value.year) || !Array.isArray(value.reference) || !unitReference(value.reference) ||
      typeof value.sourceLabel !== 'string' || !value.sourceLabel || value.sourceLabel.length > 100 ||
      ![value.lon, value.lat, value.score].every(Number.isFinite) || !insideBounds(value.lon, value.lat, bounds) || value.score < -1 || value.score > 1) return null;
  return value;
}
