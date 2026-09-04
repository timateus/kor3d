// Prefetch HydroSHEDS river network (HydroRIVERS) + watershed boundary
// (HydroBASINS) for a location — not clipped to the location's own bbox, but
// to the *entire drainage basin* it sits in (everything that shares the same
// terminal outlet, e.g. every river feeding the same lake). This is what
// answers "what is this river connected to?", as opposed to water.json /
// water_large.json (OSM, clipped to a fixed bbox around the location).
//
// Method:
//   1. Download (and cache) the HydroBASINS shapefile for one Pfafstetter
//      level, region `as` (Asia — covers Central Asia/Kazakhstan; pass
//      --region to use a different HydroSHEDS region for other locations).
//   2. Find the basin polygon at that level containing the location's
//      center point, then collect every polygon at that level sharing the
//      same MAIN_BAS (i.e. the whole basin draining to the same outlet).
//   3. Download (and cache) HydroRIVERS for the same region, and keep every
//      reach whose line intersects any of those basin polygons.
//   4. Write GeoJSON for both to public/data/locations/{slug}/.
//
// Run:  node scripts/prefetch/hydrosheds.mjs [--level N] [--region xx] [--min-stra N] [slug1 slug2 ...]
//   --level N     HydroBASINS Pfafstetter level used for "the basin" (default 5 —
//                 roughly major-river-basin scale). Lower = coarser/bigger,
//                 higher = finer/smaller. The script logs the resulting basin's
//                 total area (km²) and polygon count — rerun with a different
//                 --level if that looks off for the location.
//   --region xx   HydroSHEDS region code (af/ar/as/au/eu/gr/na/sa/si). Default 'as'.
//                 Kazakhstan/Central Asia is 'as'. Other current locations
//                 (seliger→eu, garibaldi-squamish→na, ...) would need this flag
//                 set explicitly — not auto-detected.
//   --min-stra N  Minimum Strahler stream order to keep (default 3). A whole
//                 basin's full reach network (order 1+) can be 10,000+
//                 individual lines, which is too many for one-Line2-per-feature
//                 rendering (this renderer's pattern, matching OsmLinesLayer)
//                 — filtering out small headwater streams keeps it fast and
//                 the file size reasonable. Lower it for more tributary detail.
//
// Requires: `npm i -D shapefile @turf/turf` (already devDependencies here).
// Data: HydroSHEDS HydroRIVERS & HydroBASINS v1c (Lehner & Grill, 2013),
// data.hydrosheds.org. Free for non-commercial/research use — see their license.

import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { LOCATIONS } from './locations.mjs';

const require = createRequire(import.meta.url);
const shapefile = require('shapefile');
const AdmZip = require('adm-zip');
const turf = require('@turf/turf');

const CACHE = path.join(os.tmpdir(), 'hydrosheds-cache');
const HYDROBASINS_BASE = 'https://data.hydrosheds.org/file/hydrobasins/standard';
const HYDRORIVERS_BASE = 'https://data.hydrosheds.org/file/HydroRIVERS';

async function downloadAndExtract(url, destDir) {
  await fs.mkdir(destDir, { recursive: true });
  const marker = path.join(destDir, '.done');
  if (fssync.existsSync(marker)) return;

  const zipPath = destDir + '.zip';
  console.log(`  downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(zipPath, buf);
  console.log(`  ${(buf.length / 1e6).toFixed(1)} MB → extracting…`);

  const zip = new AdmZip(zipPath);
  zip.extractAllTo(destDir, true);
  await fs.rm(zipPath).catch(() => {});
  await fs.writeFile(marker, '');
}

async function hydrobasinsFiles(region, level) {
  const lvl = String(level).padStart(2, '0');
  const dir = path.join(CACHE, `hybas_${region}_lev${lvl}_v1c`);
  await downloadAndExtract(`${HYDROBASINS_BASE}/hybas_${region}_lev${lvl}_v1c.zip`, dir);
  const entries = await fs.readdir(dir);
  const shp = entries.find((e) => e.toLowerCase().endsWith('.shp'));
  const dbf = entries.find((e) => e.toLowerCase().endsWith('.dbf'));
  return { shp: path.join(dir, shp), dbf: path.join(dir, dbf) };
}

async function hydroriversFiles(region) {
  const dir = path.join(CACHE, `HydroRIVERS_v10_${region}`);
  await downloadAndExtract(`${HYDRORIVERS_BASE}/HydroRIVERS_v10_${region}_shp.zip`, dir);
  // This zip extracts into a nested HydroRIVERS_v10_{region}_shp/ folder.
  const findShp = async (d) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        const found = await findShp(path.join(d, e.name));
        if (found) return found;
      } else if (e.name.toLowerCase().endsWith('.shp')) {
        return path.join(d, e.name);
      }
    }
    return null;
  };
  const shp = await findShp(dir);
  const dbf = shp.replace(/\.shp$/i, '.dbf');
  return { shp, dbf };
}

async function readAllFeatures(shp, dbf) {
  const source = await shapefile.open(shp, dbf);
  const out = [];
  while (true) {
    const r = await source.read();
    if (r.done) break;
    out.push(r.value);
  }
  return out;
}

function lineBBox(coords) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of coords) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function bboxIntersects(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

const round5 = (n) => Math.round(n * 1e5) / 1e5;
const roundLine = (coords) => coords.map(([x, y]) => [round5(x), round5(y)]);
const roundRing = (ring) => ring.map(([x, y]) => [round5(x), round5(y)]);
function roundPolyGeom(geom) {
  if (geom.type === 'Polygon') return { type: 'Polygon', coordinates: geom.coordinates.map(roundRing) };
  if (geom.type === 'MultiPolygon') {
    return { type: 'MultiPolygon', coordinates: geom.coordinates.map((poly) => poly.map(roundRing)) };
  }
  return geom;
}

async function processLocation(loc, level, region, minStra, basinsCache) {
  console.log(`\n[${loc.slug}] basin (HydroBASINS lev${level}, region ${region}, min Strahler order ${minStra})…`);

  const key = `${region}_${level}`;
  if (!basinsCache[key]) {
    const { shp, dbf } = await hydrobasinsFiles(region, level);
    basinsCache[key] = await readAllFeatures(shp, dbf);
  }
  const basins = basinsCache[key];

  const b = loc.bounds;
  const center = turf.point([(b.minLon + b.maxLon) / 2, (b.minLat + b.maxLat) / 2]);
  const containing = basins.find((f) => {
    try { return turf.booleanPointInPolygon(center, f); } catch { return false; }
  });
  if (!containing) {
    console.warn(`  no lev${level}/${region} basin polygon contains ${loc.slug}'s center — wrong --region? skipping.`);
    return;
  }

  const mainBas = containing.properties.MAIN_BAS;
  const basinPolys = basins.filter((f) => f.properties.MAIN_BAS === mainBas);
  const totalArea = basinPolys.reduce((s, f) => s + (f.properties.SUB_AREA || 0), 0);
  console.log(`  basin: MAIN_BAS=${mainBas}, ${basinPolys.length} lev${level} polygons, ~${totalArea.toFixed(0)} km²`);

  const basinFC = turf.featureCollection(basinPolys);
  const basinBBox = turf.bbox(basinFC);

  // --- HydroRIVERS: keep reaches whose line intersects any basin polygon ---
  const { shp: riverShp, dbf: riverDbf } = await hydroriversFiles(region);
  console.log('  scanning HydroRIVERS…');
  const source = await shapefile.open(riverShp, riverDbf);
  const keptRivers = [];
  let scanned = 0;
  while (true) {
    const r = await source.read();
    if (r.done) break;
    scanned++;
    if (scanned % 200_000 === 0) console.log(`    …${scanned} scanned, ${keptRivers.length} kept so far`);
    const p = r.value.properties;
    if ((p.ORD_STRA ?? 0) < minStra) continue;
    const geom = r.value.geometry;
    if (!geom || geom.type !== 'LineString') continue;
    const fbbox = lineBBox(geom.coordinates);
    if (!bboxIntersects(fbbox, basinBBox)) continue;
    const hit = basinPolys.some((p2) => {
      try { return turf.booleanIntersects(r.value, p2); } catch { return false; }
    });
    if (!hit) continue;
    keptRivers.push({
      type: 'Feature',
      properties: {
        id: p.HYRIV_ID,
        ord_stra: p.ORD_STRA,
        ord_clas: p.ORD_CLAS,
        ord_flow: p.ORD_FLOW,
        length_km: p.LENGTH_KM,
        dis_av_cms: p.DIS_AV_CMS,
      },
      geometry: { type: 'LineString', coordinates: roundLine(geom.coordinates) },
    });
  }
  console.log(`  scanned ${scanned} reaches, kept ${keptRivers.length}`);

  const outDir = path.join('public/data/locations', loc.slug);
  await fs.mkdir(outDir, { recursive: true });

  const riversDoc = { type: 'FeatureCollection', features: keptRivers };
  await fs.writeFile(path.join(outDir, 'basin_rivers.json'), JSON.stringify(riversDoc));

  const boundaryDoc = {
    type: 'FeatureCollection',
    features: basinPolys.map((f) => ({
      type: 'Feature',
      properties: {
        hybas_id: f.properties.HYBAS_ID,
        pfaf_id: f.properties.PFAF_ID,
        sub_area_km2: f.properties.SUB_AREA,
        endo: f.properties.ENDO,
      },
      geometry: roundPolyGeom(f.geometry),
    })),
  };
  await fs.writeFile(path.join(outDir, 'basin_boundary.json'), JSON.stringify(boundaryDoc));

  const metaDoc = {
    source: 'HydroSHEDS HydroBASINS/HydroRIVERS v1c (Lehner & Grill, 2013)',
    region, level, mainBas,
    polygonCount: basinPolys.length,
    totalAreaKm2: Math.round(totalArea),
    riverCount: keptRivers.length,
    bbox: { minLon: basinBBox[0], minLat: basinBBox[1], maxLon: basinBBox[2], maxLat: basinBBox[3] },
  };
  await fs.writeFile(path.join(outDir, 'basin_meta.json'), JSON.stringify(metaDoc, null, 2));

  const riversStat = await fs.stat(path.join(outDir, 'basin_rivers.json'));
  const boundaryStat = await fs.stat(path.join(outDir, 'basin_boundary.json'));
  console.log(`  wrote basin_rivers.json (${(riversStat.size / 1024).toFixed(1)} KB), ` +
    `basin_boundary.json (${(boundaryStat.size / 1024).toFixed(1)} KB)`);
}

async function main() {
  const args = process.argv.slice(2);
  let level = 5;
  let region = 'as';
  let minStra = 3;
  const slugs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--level') { level = Number(args[++i]); }
    else if (args[i] === '--region') { region = args[++i]; }
    else if (args[i] === '--min-stra') { minStra = Number(args[++i]); }
    else slugs.push(args[i]);
  }
  const targets = slugs.length ? LOCATIONS.filter((l) => slugs.includes(l.slug)) : LOCATIONS;
  if (targets.length === 0) {
    console.error('No matching locations.');
    process.exit(1);
  }

  const basinsCache = {};
  for (const loc of targets) {
    await processLocation(loc, level, region, minStra, basinsCache);
  }
  console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); });
