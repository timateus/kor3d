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

async function fetchWater(b) {
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

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data));
  const stat = await fs.stat(file);
  console.log(`  wrote ${file} (${(stat.size / 1024).toFixed(1)} KB)`);
}

async function main() {
  const requested = process.argv.slice(2);
  const targets = requested.length
    ? LOCATIONS.filter((l) => requested.includes(l.slug))
    : LOCATIONS;

  for (const loc of targets) {
    console.log(`\n[${loc.slug}]`);
    const outDir = path.join('public/data/locations', loc.slug);

    console.log('  water (small)…');
    const waterSmall = await fetchWater(loc.bounds);
    await writeJson(path.join(outDir, 'water.json'), waterSmall);

    if (loc.waterBounds) {
      console.log('  water (large)…');
      const waterLarge = await fetchWater(loc.waterBounds);
      await writeJson(path.join(outDir, 'water_large.json'), waterLarge);
    }

    console.log('  buildings…');
    const buildings = await fetchBuildings(loc.bounds);
    await writeJson(path.join(outDir, 'buildings.json'), buildings);

    console.log('  places…');
    const places = await fetchPlaces(loc.waterBounds ?? loc.bounds);
    await writeJson(path.join(outDir, 'places.json'), places);
  }
  console.log('\nDone.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
