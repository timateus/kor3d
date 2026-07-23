import * as THREE from 'three';
import { cacheGet, cacheSet } from './browser-cache';

function bboxKey(b: LonLatBounds, style: string) {
  const r = (n: number) => n.toFixed(4);
  return `basemap:${style}:${r(b.minLon)},${r(b.minLat)},${r(b.maxLon)},${r(b.maxLat)}`;
}

async function blobToCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  bmp.close?.();
  return c;
}

function canvasToBlob(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve) => c.toBlob((b) => resolve(b!), 'image/jpeg', 0.9));
}


export interface MapboxTextures {
  satellite: THREE.Texture;
  terrainRGB: THREE.Texture;
  minElev: number;
  maxElev: number;
}

export interface LonLatBounds {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

const TILE_SIZE = 512; // @2x

// --- Web Mercator tile math ---
function lon2tile(lon: number, z: number) {
  return ((lon + 180) / 360) * Math.pow(2, z);
}
function lat2tile(lat: number, z: number) {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z);
}

function pickZoom(bounds: LonLatBounds, targetTiles = 4): number {
  // pick the smallest zoom where the bbox spans roughly targetTiles tiles
  for (let z = 1; z <= 16; z++) {
    const x0 = Math.floor(lon2tile(bounds.minLon, z));
    const x1 = Math.floor(lon2tile(bounds.maxLon, z));
    const y0 = Math.floor(lat2tile(bounds.maxLat, z));
    const y1 = Math.floor(lat2tile(bounds.minLat, z));
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    if (Math.max(w, h) >= targetTiles) return z;
  }
  return 16;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load tile: ${url.slice(0, 100)}`));
    img.src = url;
  });
}

async function stitchTiles(
  bounds: LonLatBounds,
  z: number,
  urlFor: (x: number, y: number, z: number) => string
): Promise<{ canvas: HTMLCanvasElement; pixelBounds: { u0: number; v0: number; u1: number; v1: number } }> {
  const fx0 = lon2tile(bounds.minLon, z);
  const fx1 = lon2tile(bounds.maxLon, z);
  const fy0 = lat2tile(bounds.maxLat, z); // top
  const fy1 = lat2tile(bounds.minLat, z); // bottom
  const x0 = Math.floor(fx0), x1 = Math.floor(fx1);
  const y0 = Math.floor(fy0), y1 = Math.floor(fy1);
  const cols = x1 - x0 + 1;
  const rows = y1 - y0 + 1;
  const canvas = document.createElement('canvas');
  canvas.width = cols * TILE_SIZE;
  canvas.height = rows * TILE_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const tasks: Promise<void>[] = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const url = urlFor(tx, ty, z);
      tasks.push(
        loadImage(url).then((img) => {
          ctx.drawImage(img, (tx - x0) * TILE_SIZE, (ty - y0) * TILE_SIZE, TILE_SIZE, TILE_SIZE);
        })
      );
    }
  }
  await Promise.all(tasks);
  // pixel-bounds of our actual bbox within the stitched canvas (0..1)
  const u0 = (fx0 - x0) / cols;
  const u1 = (fx1 - x0) / cols;
  const v0 = (fy0 - y0) / rows;
  const v1 = (fy1 - y0) / rows;
  return { canvas, pixelBounds: { u0, v0, u1, v1 } };
}

function cropCanvas(src: HTMLCanvasElement, pb: { u0: number; v0: number; u1: number; v1: number }): HTMLCanvasElement {
  const sx = pb.u0 * src.width;
  const sy = pb.v0 * src.height;
  const sw = (pb.u1 - pb.u0) * src.width;
  const sh = (pb.v1 - pb.v0) * src.height;
  const out = document.createElement('canvas');
  out.width = Math.round(sw);
  out.height = Math.round(sh);
  const ctx = out.getContext('2d')!;
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out;
}

function canvasToTexture(c: HTMLCanvasElement, srgb: boolean): THREE.Texture {
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

function decodeMinMax(c: HTMLCanvasElement): { min: number; max: number } {
  const W = Math.min(256, c.width);
  const H = Math.min(256, c.height);
  const tmp = document.createElement('canvas');
  tmp.width = W; tmp.height = H;
  const ctx = tmp.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(c, 0, 0, W, H);
  const data = ctx.getImageData(0, 0, W, H).data;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const elev = -10000 + (r * 65536 + g * 256 + b) * 0.1;
    if (elev < min) min = elev;
    if (elev > max) max = elev;
  }
  return { min, max };
}

export async function loadMapboxTextures(bounds: LonLatBounds, token: string): Promise<MapboxTextures> {
  const z = pickZoom(bounds, 4);
  const satUrl = (x: number, y: number, z: number) =>
    `https://api.mapbox.com/v4/mapbox.satellite/${z}/${x}/${y}@2x.jpg90?access_token=${token}`;
  const terUrl = (x: number, y: number, z: number) =>
    `https://api.mapbox.com/v4/mapbox.terrain-rgb/${z}/${x}/${y}@2x.pngraw?access_token=${token}`;

  const [sat, ter] = await Promise.all([
    stitchTiles(bounds, z, satUrl),
    stitchTiles(bounds, z, terUrl),
  ]);
  const satCropped = cropCanvas(sat.canvas, sat.pixelBounds);
  const terCropped = cropCanvas(ter.canvas, ter.pixelBounds);
  const { min, max } = decodeMinMax(terCropped);
  return {
    satellite: canvasToTexture(satCropped, true),
    terrainRGB: canvasToTexture(terCropped, false),
    minElev: min,
    maxElev: max,
  };
}

/** Lighter helper: only fetch + stitch satellite imagery for given bbox. */
export async function loadMapboxSatellite(bounds: LonLatBounds, token: string): Promise<THREE.Texture> {
  return loadBaseStyleTexture(bounds, 'satellite', token);
}

export type BaseStyle = 'satellite' | 'streets' | 'osm' | 'satlas';

/**
 * Fetch + stitch a raster basemap for the given bbox and return it as an
 * sRGB texture suitable for draping over the terrain mesh.
 *
 * `satlas` = Satlas Super-Res 2023 (Sentinel-2 SR by Allen Institute for AI),
 * much brighter than Mapbox satellite in mountainous terrain.
 */
export async function loadBaseStyleTexture(
  bounds: LonLatBounds,
  style: BaseStyle,
  token: string,
): Promise<THREE.Texture> {
  // Try IndexedDB cache first (persists across sessions)
  const key = bboxKey(bounds, style);
  try {
    const cached = await cacheGet<Blob>(key);
    if (cached instanceof Blob) {
      const c = await blobToCanvas(cached);
      return canvasToTexture(c, true);
    }
  } catch { /* ignore */ }

  // Satlas covers up to z17 globally — go tighter for more detail.
  const target = style === 'satlas' ? 6 : 4;
  const z = pickZoom(bounds, target);
  let urlFor: (x: number, y: number, z: number) => string;
  if (style === 'osm') {
    urlFor = (x, y, z) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
  } else if (style === 'satlas') {
    urlFor = (x, y, z) =>
      `https://se-tile-api.allen.ai/mosaic/superres/sr2023/tci/${z}/${x}/${y}.webp`;
  } else if (style === 'streets') {
    urlFor = (x, y, z) =>
      `https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/512/${z}/${x}/${y}@2x?access_token=${token}`;
  } else {
    urlFor = (x, y, z) =>
      `https://api.mapbox.com/v4/mapbox.satellite/${z}/${x}/${y}@2x.jpg90?access_token=${token}`;
  }
  const stitched = await stitchTiles(bounds, z, urlFor);
  const cropped = cropCanvas(stitched.canvas, stitched.pixelBounds);
  // Persist to IndexedDB (fire and forget)
  canvasToBlob(cropped).then((b) => cacheSet(key, b)).catch(() => {});
  return canvasToTexture(cropped, true);
}
