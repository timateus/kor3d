import type { GeoBounds, TerrainData } from './geotiff-loader';

// Mapterhorn — public terrain tiles (BSD-3), terrarium encoding.
// Attribution required: "Elevation: Mapterhorn".
// Tile URL: https://tiles.mapterhorn.com/{z}/{x}/{y}.webp   (512px)

const TILE_SIZE = 512;
const MAX_TILES_PER_AXIS = 4;

function lon2tile(lon: number, z: number) {
  return ((lon + 180) / 360) * Math.pow(2, z);
}
function lat2tile(lat: number, z: number) {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z);
}

// Mapterhorn global coverage tops out at ~z12 in most regions.
const MAX_ZOOM = 12;

function pickZoom(bounds: GeoBounds): number {
  for (let z = MAX_ZOOM; z >= 1; z--) {
    const x0 = Math.floor(lon2tile(bounds.minLon, z));
    const x1 = Math.floor(lon2tile(bounds.maxLon, z));
    const y0 = Math.floor(lat2tile(bounds.maxLat, z));
    const y1 = Math.floor(lat2tile(bounds.minLat, z));
    if (x1 - x0 + 1 <= MAX_TILES_PER_AXIS && y1 - y0 + 1 <= MAX_TILES_PER_AXIS) return z;
  }
  return 1;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('mapterhorn tile fail'));
    img.src = url;
  });
}

async function stitchAtZoom(
  bounds: GeoBounds, z: number,
  onTile?: (loaded: number, total: number) => void,
) {
  const fx0 = lon2tile(bounds.minLon, z);
  const fx1 = lon2tile(bounds.maxLon, z);
  const fy0 = lat2tile(bounds.maxLat, z);
  const fy1 = lat2tile(bounds.minLat, z);
  const x0 = Math.floor(fx0), x1 = Math.floor(fx1);
  const y0 = Math.floor(fy0), y1 = Math.floor(fy1);
  const cols = x1 - x0 + 1, rows = y1 - y0 + 1;
  const canvas = document.createElement('canvas');
  canvas.width = cols * TILE_SIZE;
  canvas.height = rows * TILE_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const total = cols * rows;
  let loaded = 0;
  onTile?.(0, total);
  const tasks: Promise<void>[] = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const url = `https://tiles.mapterhorn.com/${z}/${tx}/${ty}.webp`;
      tasks.push(loadImage(url).then((img) => {
        ctx.drawImage(img, (tx - x0) * TILE_SIZE, (ty - y0) * TILE_SIZE, TILE_SIZE, TILE_SIZE);
        loaded += 1;
        onTile?.(loaded, total);
      }));
    }
  }
  await Promise.all(tasks);
  return {
    canvas,
    u0: (fx0 - x0) / cols,
    u1: (fx1 - x0) / cols,
    v0: (fy0 - y0) / rows,
    v1: (fy1 - y0) / rows,
  };
}

export async function loadMapterhornDEM(
  bounds: GeoBounds,
  opts: { targetSize?: number; onProgress?: (loaded: number, total: number) => void } = {},
): Promise<TerrainData> {
  const target = opts.targetSize ?? 768;
  // Try highest available zoom; drop down on any tile 404.
  let z = pickZoom(bounds);
  let attempt: { canvas: HTMLCanvasElement; u0: number; v0: number; u1: number; v1: number } | null = null;
  let lastErr: Error | null = null;
  while (z >= 1 && !attempt) {
    try {
      attempt = await stitchAtZoom(bounds, z, opts.onProgress);
    } catch (e: any) {
      lastErr = e;
      z -= 1;
    }
  }
  if (!attempt) throw lastErr ?? new Error('mapterhorn: no tiles');
  const { canvas, u0, v0, u1, v1 } = attempt;
  const sx = u0 * canvas.width, sy = v0 * canvas.height;
  const sw = (u1 - u0) * canvas.width, sh = (v1 - v0) * canvas.height;
  const aspect = sw / sh;
  let outW: number, outH: number;
  if (aspect >= 1) { outW = target; outH = Math.max(64, Math.round(target / aspect)); }
  else { outH = target; outW = Math.max(64, Math.round(target * aspect)); }

  const out = document.createElement('canvas');
  out.width = outW; out.height = outH;
  const octx = out.getContext('2d', { willReadFrequently: true })!;
  octx.drawImage(canvas, sx, sy, sw, sh, 0, 0, outW, outH);
  const data = octx.getImageData(0, 0, outW, outH).data;

  const elevations = new Float32Array(outW * outH);
  let minE = Infinity, maxE = -Infinity;
  for (let i = 0, p = 0; p < elevations.length; i += 4, p++) {
    // Terrarium: (R*256 + G + B/256) - 32768
    const elev = (data[i] * 256 + data[i + 1] + data[i + 2] / 256) - 32768;
    elevations[p] = elev;
    if (elev < minE) minE = elev;
    if (elev > maxE) maxE = elev;
  }

  return {
    width: outW, height: outH, elevations,
    minElevation: minE, maxElevation: maxE,
    noDataValue: null, bounds: { ...bounds },
  };
}
