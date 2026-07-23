import type { GeoBounds } from './geotiff-loader';

export interface PopulationGrid {
  width: number;
  height: number;
  bounds: GeoBounds;
  values: Float32Array;
  maxVal: number;
}

const _cache = new Map<string, Promise<PopulationGrid>>();

/**
 * Loads a per-location GHS-POP grid written by scripts/prefetch/ghs-pop.mjs:
 * a small JSON sidecar (dimensions + bounds) plus a raw little-endian
 * Float32 `.bin` file for the values, fetched in parallel.
 *
 * `jsonUrl` is e.g. `/data/locations/{slug}/population_density.json`; the
 * `.bin` file is expected alongside it (see `doc.valuesFile`).
 */
export function loadPopulationDensity(jsonUrl: string): Promise<PopulationGrid> {
  const cached = _cache.get(jsonUrl);
  if (cached) return cached;
  const promise = fetch(jsonUrl)
    .then((res) => {
      if (!res.ok) throw new Error(`Population density ${res.status}`);
      return res.json();
    })
    .then(async (doc) => {
      const binUrl = new URL(doc.valuesFile, new URL(jsonUrl, window.location.href)).toString();
      const binRes = await fetch(binUrl);
      if (!binRes.ok) throw new Error(`Population density values ${binRes.status}`);
      const buf = await binRes.arrayBuffer();
      const values = new Float32Array(buf);

      let maxVal = 0;
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (isFinite(v) && v > maxVal) maxVal = v;
      }
      const grid: PopulationGrid = {
        width: doc.width,
        height: doc.height,
        bounds: { minLon: doc.minLon, minLat: doc.minLat, maxLon: doc.maxLon, maxLat: doc.maxLat },
        values,
        maxVal,
      };
      return grid;
    });
  _cache.set(jsonUrl, promise);
  return promise;
}

/** Bilinear sample of a GHS-POP grid at a given lon/lat. Returns null outside bounds. */
export function sampleGrid(grid: PopulationGrid, lon: number, lat: number): number | null {
  const { width, height, bounds, values } = grid;
  const u = (lon - bounds.minLon) / (bounds.maxLon - bounds.minLon);
  const v = (bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat);
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  const fx = u * (width - 1);
  const fy = v * (height - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  const v00 = values[y0 * width + x0];
  const v10 = values[y0 * width + x1];
  const v01 = values[y1 * width + x0];
  const v11 = values[y1 * width + x1];
  const top = v00 + (v10 - v00) * tx;
  const bot = v01 + (v11 - v01) * tx;
  return top + (bot - top) * ty;
}
