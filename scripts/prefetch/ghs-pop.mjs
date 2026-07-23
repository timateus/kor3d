// Prefetch GHS-POP R2023A (JRC Global Human Settlement Layer) population density
// for each location's terrain footprint (`bounds`, not the larger waterBounds).
// Downloads the 10°×10° WGS84 tiles (100 m / 3 arc-seconds) that cover each
// bounding box, samples the raster, and writes two files per location:
//   population_density.bin  — raw little-endian Float32 grid, row-major, north→south
//   population_density.json — { width, height, minLon, minLat, maxLon, maxLat, source, units }
//
// Grid values are population count per ~100 m source pixel (epoch 2020).
//
// Run: node scripts/prefetch/ghs-pop.mjs [slug1 slug2 ...]
//
// Requires: `npm i -D geotiff adm-zip` (already devDependencies here).

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { LOCATIONS } from './locations.mjs';

const require = createRequire(import.meta.url);
const { fromArrayBuffer } = require('geotiff');
const AdmZip = require('adm-zip');

const BASE = 'https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_POP_GLOBE_R2023A/GHS_POP_E2020_GLOBE_R2023A_4326_3ss/V1-0/tiles';
const CACHE = path.join(os.tmpdir(), 'ghs-pop-cache');

// GHS-POP 4326 3ss tiling:
//   Rows: R{r} covers lat [90-10r, 90-10(r-1)], so R1 = 80..90N.
//   Cols: C{c} covers lon [-180+10(c-1), -180+10c], so C1 = -180..-170.
function tileForLatLon(lat, lon) {
  const r = Math.min(18, Math.max(1, Math.ceil((90 - lat) / 10)));
  const c = Math.min(36, Math.max(1, Math.floor((lon + 180) / 10) + 1));
  return { r, c };
}

function tilesForBounds(b) {
  const tiles = new Set();
  const step = 5; // sample interior grid
  for (let lat = b.minLat; lat <= b.maxLat + 0.001; lat += step) {
    for (let lon = b.minLon; lon <= b.maxLon + 0.001; lon += step) {
      const { r, c } = tileForLatLon(lat, lon);
      tiles.add(`${r}_${c}`);
    }
  }
  // Also corners in case bounds are smaller than step.
  for (const [la, lo] of [[b.minLat, b.minLon], [b.minLat, b.maxLon], [b.maxLat, b.minLon], [b.maxLat, b.maxLon]]) {
    const { r, c } = tileForLatLon(la, lo);
    tiles.add(`${r}_${c}`);
  }
  return [...tiles].map((k) => {
    const [r, c] = k.split('_').map(Number);
    return { r, c };
  });
}

async function downloadTile(r, c) {
  await fs.mkdir(CACHE, { recursive: true });
  const tifPath = path.join(CACHE, `R${r}_C${c}.tif`);
  try { await fs.access(tifPath); return tifPath; } catch { /* not cached */ }

  const zipUrl = `${BASE}/GHS_POP_E2020_GLOBE_R2023A_4326_3ss_V1_0_R${r}_C${c}.zip`;
  const zipPath = path.join(CACHE, `R${r}_C${c}.zip`);
  console.log(`  downloading ${zipUrl}`);
  const res = await fetch(zipUrl);
  if (!res.ok) throw new Error(`Download failed ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(zipPath, buf);
  console.log(`  ${(buf.length / 1e6).toFixed(1)} MB → extracting…`);

  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries().filter((e) => e.entryName.toLowerCase().endsWith('.tif'));
  if (entries.length === 0) throw new Error('No .tif in zip');
  const tifBuf = entries[0].getData();
  await fs.writeFile(tifPath, tifBuf);
  await fs.rm(zipPath).catch(() => {});
  return tifPath;
}

async function readTile(tifPath) {
  const buf = await fs.readFile(tifPath);
  const tiff = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const image = await tiff.getImage();
  const [minLon, minLat, maxLon, maxLat] = image.getBoundingBox();
  const width = image.getWidth();
  const height = image.getHeight();
  return { image, minLon, minLat, maxLon, maxLat, width, height };
}

/**
 * Read the sub-window of a tile that covers `b` in ONE readRasters call
 * (instead of one call per output pixel — that was the bottleneck in the
 * original script, ~30ms/pixel × 360,000 pixels ≈ 3 hours/location).
 */
async function readWindow(tile, b) {
  const x0 = Math.max(0, Math.floor((b.minLon - tile.minLon) / (tile.maxLon - tile.minLon) * tile.width));
  const x1 = Math.min(tile.width, Math.ceil((b.maxLon - tile.minLon) / (tile.maxLon - tile.minLon) * tile.width));
  const y0 = Math.max(0, Math.floor((tile.maxLat - b.maxLat) / (tile.maxLat - tile.minLat) * tile.height));
  const y1 = Math.min(tile.height, Math.ceil((tile.maxLat - b.minLat) / (tile.maxLat - tile.minLat) * tile.height));
  if (x1 <= x0 || y1 <= y0) return null;
  const win = await tile.image.readRasters({ window: [x0, y0, x1, y1], samples: [0] });
  const data = win[0];
  const width = x1 - x0;
  const height = y1 - y0;
  const lon0 = tile.minLon + (x0 / tile.width) * (tile.maxLon - tile.minLon);
  const lon1 = tile.minLon + (x1 / tile.width) * (tile.maxLon - tile.minLon);
  const lat0 = tile.maxLat - (y1 / tile.height) * (tile.maxLat - tile.minLat);
  const lat1 = tile.maxLat - (y0 / tile.height) * (tile.maxLat - tile.minLat);
  return { data, width, height, minLon: lon0, maxLon: lon1, minLat: lat0, maxLat: lat1 };
}

async function extractGrid(loc) {
  const b = loc.bounds;
  const tiles = tilesForBounds(b);
  console.log(`  tiles: ${tiles.map((t) => `R${t.r}C${t.c}`).join(', ')}`);

  const windows = [];
  for (const t of tiles) {
    const tifPath = await downloadTile(t.r, t.c);
    const meta = await readTile(tifPath);
    const win = await readWindow(meta, b);
    if (win) windows.push(win);
  }

  // Choose output resolution: ~600 pixels on longest side (keeps files small).
  const maxSide = 600;
  const lonSpan = b.maxLon - b.minLon;
  const latSpan = b.maxLat - b.minLat;
  const aspect = lonSpan / latSpan;
  let W, H;
  if (aspect >= 1) { W = maxSide; H = Math.max(1, Math.round(maxSide / aspect)); }
  else { H = maxSide; W = Math.max(1, Math.round(maxSide * aspect)); }

  const out = new Float32Array(W * H);

  for (let j = 0; j < H; j++) {
    const lat = b.maxLat - ((j + 0.5) / H) * latSpan;
    for (let i = 0; i < W; i++) {
      const lon = b.minLon + ((i + 0.5) / W) * lonSpan;
      const win = windows.find((w) => lon >= w.minLon && lon <= w.maxLon && lat >= w.minLat && lat <= w.maxLat);
      if (!win) continue;
      const px = Math.min(win.width - 1, Math.max(0, Math.floor((lon - win.minLon) / (win.maxLon - win.minLon) * win.width)));
      const py = Math.min(win.height - 1, Math.max(0, Math.floor((win.maxLat - lat) / (win.maxLat - win.minLat) * win.height)));
      const v = win.data[py * win.width + px];
      out[j * W + i] = isFinite(v) && v > 0 ? v : 0;
    }
  }

  return { width: W, height: H, minLon: b.minLon, minLat: b.minLat, maxLon: b.maxLon, maxLat: b.maxLat, values: out };
}

async function main() {
  const requested = process.argv.slice(2);
  const targets = requested.length
    ? LOCATIONS.filter((l) => requested.includes(l.slug))
    : LOCATIONS;

  for (const loc of targets) {
    console.log(`\n[${loc.slug}] GHS-POP…`);
    const grid = await extractGrid(loc);
    const dir = path.join('public/data/locations', loc.slug);
    await fs.mkdir(dir, { recursive: true });

    const binFile = path.join(dir, 'population_density.bin');
    await fs.writeFile(binFile, Buffer.from(grid.values.buffer));

    const jsonFile = path.join(dir, 'population_density.json');
    const doc = {
      source: 'GHS-POP R2023A (JRC), epoch 2020, WGS84 3 arc-sec (~100 m)',
      units: 'population count per source pixel',
      width: grid.width, height: grid.height,
      minLon: grid.minLon, minLat: grid.minLat, maxLon: grid.maxLon, maxLat: grid.maxLat,
      valuesFile: 'population_density.bin',
    };
    await fs.writeFile(jsonFile, JSON.stringify(doc, null, 2));

    const stat = await fs.stat(binFile);
    console.log(`  ${grid.width}×${grid.height} → ${binFile} (${(stat.size / 1024).toFixed(1)} KB)`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
