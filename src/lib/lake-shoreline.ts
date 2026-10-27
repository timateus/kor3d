import type { GeoBounds } from './geotiff-loader';
import type { EmbeddingRaster } from './satellite-embeddings';

/**
 * Level → shoreline lookup from scripts/prefetch/balkhash-shoreline.mjs: each
 * lake cell stores the water level (m) below which it falls dry. The pseudo-bed
 * matches the surveyed level–area curve; where the shore retreats is approximate.
 */
export interface ShorelineGrid {
  width: number;
  height: number;
  bounds: GeoBounds;
  level0: number;
  step: number;
  refLevel: number;
  cells: Uint8Array;
}

export async function loadShoreline(baseUrl: string): Promise<ShorelineGrid> {
  const [meta, bin] = await Promise.all([
    fetch(`${baseUrl}/shoreline.json`).then((r) => { if (!r.ok) throw new Error(`shoreline.json ${r.status}`); return r.json(); }),
    fetch(`${baseUrl}/shoreline.bin`).then((r) => { if (!r.ok) throw new Error(`shoreline.bin ${r.status}`); return r.arrayBuffer(); }),
  ]);
  const cells = new Uint8Array(bin);
  if (cells.length !== meta.width * meta.height) throw new Error('shoreline.bin size does not match shoreline.json');
  return { ...meta, cells };
}

const WATER = [57, 135, 229, 200];
const DRY_BED = [236, 226, 200, 235]; // exposed lake bed, salt/sand

/** Water where the pseudo-bed is below `level`, exposed bed elsewhere inside today's outline. */
export function shorelineRaster(grid: ShorelineGrid, level: number): { raster: EmbeddingRaster; areaFraction: number } {
  const { width, height, cells, level0, step } = grid;
  const rgba = new Uint8ClampedArray(width * height * 4);
  // A cell is wet when level ≥ its stored level; compare in quantised units.
  const threshold = (level - level0) / step + 1e-6;
  let lake = 0, wet = 0;
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i];
    if (v === 255) continue;
    lake++;
    const c = v <= threshold ? (wet++, WATER) : DRY_BED;
    rgba.set(c, i * 4);
  }
  return { raster: { width, height, rgba, bounds: grid.bounds }, areaFraction: lake ? wet / lake : 0 };
}
