// Prefetch Overpass data (water, buildings, places) for a location.
// Saves JSON files under public/data/locations/{slug}/.
//
// Run:  node scripts/prefetch/overpass.mjs [slug1 slug2 ...]
// With no args, all locations are fetched.

import fs from 'node:fs/promises';
import path from 'node:path';
import { LOCATIONS } from './locations.mjs';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const TIMEOUT_MS = 90_000;

async function tryEndpoint(url, query) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'User-Agent': 'aral3d-viewer/prefetch (data-prep)',
      },
      body: 'data=' + encodeURIComponent(query),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function overpass(query) {
  let lastErr;
  // 4 rounds, each round tries every endpoint. Between rounds, wait.
  for (let round = 0; round < 4; round++) {
    for (const url of ENDPOINTS) {
      try {
        return await tryEndpoint(url, query);
      } catch (e) {
        lastErr = e;
        console.warn(`  ${url} failed: ${e.message}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    const wait = 15_000 * (round + 1);
    console.warn(`  round ${round + 1} exhausted, sleeping ${wait / 1000}s…`);
    await new Promise((r) => setTimeout(r, wait));
  }
  throw lastErr ?? new Error('All Overpass endpoints failed');
}

const bbox = (b) => `${b.minLat},${b.minLon},${b.maxLat},${b.maxLon}`;

/**
 * `coarse: true` switches to named-features-only, plus the sea's actual
 * coastline (large seas are mapped as `natural=coastline` ways, not a
 * filled water polygon). For sea-scale locations spanning many countries,
 * the unrestricted query returns 100+ MB — mostly countless unnamed ponds
 * and irrigation ditches — which is both unfetchable (Overpass/Node string
 * limits) and unusable in a browser. At that scale what's visually
 * significant is the coastline itself, named lakes, and named rivers.
 */
async function fetchWater(b, coarse = false) {
  if (coarse) {
    const q = `[out:json][timeout:80];
      (
        way["natural"="coastline"](${bbox(b)});
        way["natural"="water"]["name"](${bbox(b)});
        relation["natural"="water"]["name"](${bbox(b)});
        way["waterway"="river"]["name"](${bbox(b)});
      );
      out geom;`;
    return overpass(q);
  }
  const q = `[out:json][timeout:80];
    (
      way["natural"="water"](${bbox(b)});
      way["waterway"](${bbox(b)});
      relation["natural"="water"](${bbox(b)});
    );
    out geom;`;
  return overpass(q);
}

async function fetchBuildings(b) {
  const q = `[out:json][timeout:80];
    (
      way["building"](${bbox(b)});
      relation["building"](${bbox(b)});
    );
    out geom;`;
  return overpass(q);
}

async function fetchPlaces(b) {
  const q = `[out:json][timeout:80];
    (
      node["place"~"^(city|town|village|hamlet)$"]["name"](${bbox(b)});
    );
    out body 2000;`;
  return overpass(q);
}

async function fetchBordersNational(b) {
  const q = `[out:json][timeout:80];
    (
      relation["boundary"="administrative"]["admin_level"="2"](${bbox(b)});
    );
    out geom;`;
  return overpass(q);
}

async function fetchBordersSub(b) {
  const q = `[out:json][timeout:80];
    (
      relation["boundary"="administrative"]["admin_level"~"^(3|4|5|6)$"](${bbox(b)});
    );
    out geom;`;
  return overpass(q);
}

async function fetchResources(b) {
  const q = `[out:json][timeout:80];
    (
      node["man_made"="mine"](${bbox(b)});
      way["man_made"="mine"](${bbox(b)});
      node["man_made"="petroleum_well"](${bbox(b)});
      node["pipeline"="substation"](${bbox(b)});
      way["landuse"="quarry"](${bbox(b)});
      way["landuse"="industrial"](${bbox(b)});
      way["industrial"="mine"](${bbox(b)});
      way["industrial"="oil"](${bbox(b)});
      way["industrial"="gas"](${bbox(b)});
      way["landuse"="forestry"](${bbox(b)});
      node["resource"](${bbox(b)});
      way["resource"](${bbox(b)});
    );
    out geom;`;
  return overpass(q);
}

// Overpass `out geom` includes a per-way `nodes` (raw node-id list) and
// `bounds` that the renderer never reads (it only uses `geometry`/`tags`) —
// stripping them cuts large buildings.json files roughly 30% for free.
function stripUnusedFields(data) {
  const elements = (data.elements || []).map((el) => {
    const ne = { type: el.type, id: el.id };
    if (el.geometry) ne.geometry = el.geometry.map((p) => ({ lat: round6(p.lat), lon: round6(p.lon) }));
    if (el.tags) ne.tags = el.tags;
    if (el.members) ne.members = el.members;
    if (el.lat !== undefined) ne.lat = round6(el.lat);
    if (el.lon !== undefined) ne.lon = round6(el.lon);
    return ne;
  });
  return { elements };
}
const round6 = (n) => Math.round(n * 1e6) / 1e6;

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data));
  const stat = await fs.stat(file);
  console.log(`  wrote ${file} (${(stat.size / 1024).toFixed(1)} KB)`);
}

async function main() {
  const args = process.argv.slice(2);
  const bordersOnly = args.includes('--borders-only');
  const resourcesOnly = args.includes('--resources-only');
  const requested = args.filter((a) => !a.startsWith('--'));
  const targets = requested.length
    ? LOCATIONS.filter((l) => requested.includes(l.slug))
    : LOCATIONS;

  for (const loc of targets) {
    console.log(`\n[${loc.slug}]`);
    const outDir = path.join('public/data/locations', loc.slug);
    const coarse = !!loc.coarse;

    if (resourcesOnly) {
      console.log('  resources (mining/oil & gas/logging/industrial)…');
      const resources = await fetchResources(loc.waterBounds ?? loc.bounds);
      await writeJson(path.join(outDir, 'resources.json'), resources);
      continue;
    }

    if (bordersOnly) {
      console.log('  borders (national)…');
      const bordersNational = await fetchBordersNational(loc.waterBounds ?? loc.bounds);
      await writeJson(path.join(outDir, 'borders_national.json'), bordersNational);

      console.log('  borders (sub-national)…');
      const bordersSub = await fetchBordersSub(loc.waterBounds ?? loc.bounds);
      await writeJson(path.join(outDir, 'borders_sub.json'), bordersSub);
      continue;
    }

    console.log('  water (small)…');
    const waterSmall = await fetchWater(loc.bounds, coarse);
    await writeJson(path.join(outDir, 'water.json'), waterSmall);

    if (loc.waterBounds) {
      console.log('  water (large)…');
      const waterLarge = await fetchWater(loc.waterBounds, coarse);
      await writeJson(path.join(outDir, 'water_large.json'), waterLarge);
    }

    if (loc.coarse) {
      console.log('  buildings… skipped (sea-scale location, not fetchable at full detail)');
    } else {
      console.log('  buildings…');
      const buildings = await fetchBuildings(loc.bounds);
      await writeJson(path.join(outDir, 'buildings.json'), stripUnusedFields(buildings));
    }

    console.log('  places…');
    const places = await fetchPlaces(loc.waterBounds ?? loc.bounds);
    await writeJson(path.join(outDir, 'places.json'), places);

    console.log('  borders (national)…');
    const bordersNational = await fetchBordersNational(loc.waterBounds ?? loc.bounds);
    await writeJson(path.join(outDir, 'borders_national.json'), bordersNational);

    console.log('  borders (sub-national)…');
    const bordersSub = await fetchBordersSub(loc.waterBounds ?? loc.bounds);
    await writeJson(path.join(outDir, 'borders_sub.json'), bordersSub);

    console.log('  resources (mining/oil & gas/logging/industrial)…');
    const resources = await fetchResources(loc.waterBounds ?? loc.bounds);
    await writeJson(path.join(outDir, 'resources.json'), resources);
  }
  console.log('\nDone.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
