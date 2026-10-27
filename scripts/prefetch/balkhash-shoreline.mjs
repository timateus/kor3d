// Approximate Lake Balkhash shorelines for any water level, for the
// water-balance overlay (water_balance.json from balkhash-water-balance.py).
//
// The DEM only sees the lake surface, so there is no bed to threshold. Instead:
//   1. Rasterise the OSM lake multipolygon (relation 19025268, islands as holes)
//      with the even–odd rule over all member segments.
//   2. Distance from shore for every lake cell (two-pass chamfer, km).
//   3. Assume depth rises monotonically with distance from shore, and give each
//      cell the level at which the surveyed area A(h) (Tursunov et al. 2011–13,
//      copied into water_balance.json) equals the area of all cells at least as
//      far from shore. Thresholding this pseudo-bed at h therefore reproduces
//      the survey's area for every level, but where along the coast the lake
//      retreats is a guess: shallow bays and the Uzynaral strait dry first.
//
// OSM maps ~13% less water than the survey (reed beds, shallow bays), so areas
// are matched as fractions: the OSM outline is taken as the lake at --ref-level
// (default 342.18 m, the 2021 annual mean) and each cell gets the level where
// A(h) / A(ref) equals its cumulative share of the outline. The outline is the
// largest extent shown; higher levels cannot spread onto land this way.
//
// Output: shoreline.bin (Uint8, row-major from the north; 255 = never lake,
// else level = LEVEL0 + value × STEP) and shoreline.json metadata.
//
// Run:  node scripts/prefetch/balkhash-shoreline.mjs [--cell 0.004] [--ref-level 342.18]

import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const CELL = args.includes('--cell') ? Number(args[args.indexOf('--cell') + 1]) : 0.004;
const DIR = 'public/data/locations/balqash-lake';
const RELATION = 19025268;
const LEVEL0 = 330, STEP = 0.06;
const REF_LEVEL = args.includes('--ref-level') ? Number(args[args.indexOf('--ref-level') + 1]) : 342.18;

const water = JSON.parse(await fs.readFile(path.join(DIR, 'water_large.json'), 'utf8'));
const balance = JSON.parse(await fs.readFile(path.join(DIR, 'water_balance.json'), 'utf8'));
const lake = water.elements.find((e) => e.type === 'relation' && e.id === RELATION);
if (!lake) throw new Error(`relation ${RELATION} missing from water_large.json`);

const segments = [];
let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
for (const m of lake.members) {
  const g = m.geometry ?? [];
  for (let i = 1; i < g.length; i++) segments.push([g[i - 1].lon, g[i - 1].lat, g[i].lon, g[i].lat]);
  for (const p of g) {
    minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
  }
}
const bounds = {
  minLon: Math.floor(minLon / CELL) * CELL - CELL, maxLon: Math.ceil(maxLon / CELL) * CELL + CELL,
  minLat: Math.floor(minLat / CELL) * CELL - CELL, maxLat: Math.ceil(maxLat / CELL) * CELL + CELL,
};
const width = Math.round((bounds.maxLon - bounds.minLon) / CELL);
const height = Math.round((bounds.maxLat - bounds.minLat) / CELL);
console.log(`${segments.length} segments → ${width}×${height} grid at ${CELL}°`);

// 1. Even–odd scanline fill at cell centres. A few OSM member ways don't close
// exactly, which leaves streaks along a scanline, so fill along rows and along
// columns and keep cells both agree on.
const scanFill = (n, m, pos, along, toIndex) => {
  const fill = new Uint8Array(width * height);
  const buckets = Array.from({ length: n }, () => []);
  for (const s of segments) {
    const a = pos(s[0], s[1]), b = pos(s[2], s[3]);
    const k0 = Math.max(0, Math.ceil(Math.min(a, b))), k1 = Math.min(n - 1, Math.floor(Math.max(a, b)));
    for (let k = k0; k <= k1; k++) buckets[k].push([a, along(s[0], s[1]), b, along(s[2], s[3])]);
  }
  for (let k = 0; k < n; k++) {
    const xs = [];
    for (const [p0, q0, p1, q1] of buckets[k]) {
      if ((p0 > k) === (p1 > k)) continue;
      xs.push(q0 + (k - p0) / (p1 - p0) * (q1 - q0));
    }
    xs.sort((x, y) => x - y);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      for (let j = Math.max(0, Math.ceil(xs[i])); j <= Math.min(m - 1, Math.floor(xs[i + 1])); j++) fill[toIndex(k, j)] = 1;
    }
  }
  return fill;
};
// Fractional row/column of a lon/lat, measured at cell centres.
const rowOf = (lon, lat) => (bounds.maxLat - lat) / CELL - 0.5;
const colOf = (lon, lat) => (lon - bounds.minLon) / CELL - 0.5;
const byRow = scanFill(height, width, rowOf, colOf, (r, c) => r * width + c);
const byCol = scanFill(width, height, colOf, rowOf, (c, r) => r * width + c);
const inside = new Uint8Array(width * height);
let disagree = 0;
for (let i = 0; i < inside.length; i++) { inside[i] = byRow[i] & byCol[i]; disagree += byRow[i] ^ byCol[i]; }
console.log(`${disagree} cells where row and column fills disagree (dropped)`);

// 2. Chamfer distance to the nearest non-lake cell, in km (cells are not square).
const midLat = (bounds.minLat + bounds.maxLat) / 2;
const dx = CELL * 111.32 * Math.cos(midLat * Math.PI / 180), dy = CELL * 110.57, dd = Math.hypot(dx, dy);
const dist = new Float32Array(width * height).fill(Infinity);
for (let i = 0; i < dist.length; i++) if (!inside[i]) dist[i] = 0;
const relax = (i, j, d) => { if (dist[j] + d < dist[i]) dist[i] = dist[j] + d; };
for (let r = 1; r < height; r++) for (let c = 1; c < width - 1; c++) {
  const i = r * width + c;
  if (!inside[i]) continue;
  relax(i, i - 1, dx); relax(i, i - width, dy); relax(i, i - width - 1, dd); relax(i, i - width + 1, dd);
}
for (let r = height - 2; r >= 0; r--) for (let c = width - 2; c >= 1; c--) {
  const i = r * width + c;
  if (!inside[i]) continue;
  relax(i, i + 1, dx); relax(i, i + width, dy); relax(i, i + width + 1, dd); relax(i, i + width - 1, dd);
}

// 3. Rank by distance and map cumulative area onto the survey's level–area curve.
const hyps = balance.hypsometry;
const areaForLevel = (h) => {
  for (let k = 0; k < hyps.length - 1; k++) {
    const p = hyps[k], q = hyps[k + 1];
    if (h <= q.level || k === hyps.length - 2) return p.area + (q.area - p.area) * (h - p.level) / (q.level - p.level);
  }
};
const levelForArea = (a) => {
  for (let k = 0; k < hyps.length - 1; k++) {
    const p = hyps[k], q = hyps[k + 1];
    if (a <= q.area || k === hyps.length - 2) return p.level + (q.level - p.level) * (a - p.area) / (q.area - p.area);
  }
};
const cellArea = (r) => dx * dy * Math.cos((bounds.maxLat - (r + 0.5) * CELL) * Math.PI / 180) / Math.cos(midLat * Math.PI / 180);
const lakeCells = [];
for (let i = 0; i < inside.length; i++) if (inside[i]) lakeCells.push(i);
lakeCells.sort((a, b) => dist[b] - dist[a]);
const osmArea = lakeCells.reduce((s, i) => s + cellArea(Math.floor(i / width)), 0);
const refArea = areaForLevel(REF_LEVEL);
console.log(`OSM lake area ${Math.round(osmArea)} km², taken as the lake at ${REF_LEVEL} m (survey ${Math.round(refArea)} km²)`);

const out = new Uint8Array(width * height).fill(255);
let cum = 0;
for (const i of lakeCells) {
  cum += cellArea(Math.floor(i / width));
  const h = Math.min(levelForArea(cum / osmArea * refArea), REF_LEVEL);
  out[i] = Math.max(0, Math.min(254, Math.round((h - LEVEL0) / STEP)));
}

await fs.writeFile(path.join(DIR, 'shoreline.bin'), out);
await fs.writeFile(path.join(DIR, 'shoreline.json'), JSON.stringify({
  width, height, bounds, level0: LEVEL0, step: STEP, refLevel: REF_LEVEL, osmAreaKm2: Math.round(osmArea), surveyAreaAtRefKm2: Math.round(refArea),
  source: `OSM relation ${RELATION} (ODbL) + level–area curve from Tursunov et al. (2011–2013 survey)`,
  method: 'Pseudo-bathymetry: depth assumed to increase with distance from shore, ranked so the flooded share of the OSM outline matches A(h)/A(ref) from the survey curve.',
}, null, 1));
console.log(`Wrote ${DIR}/shoreline.bin (${out.length} bytes) and shoreline.json`);
