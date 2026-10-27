// Shrink a location's prefetched Overpass files so big (country/sea-scale)
// locations stay interactive. Every layer here renders one Line2/mesh per
// element, so both point count and element count matter:
//
//   1. Douglas–Peucker simplification of every way/member geometry
//      (`--tol` degrees, default 0.0008 ≈ 90 m — invisible at the scale of a
//      several-hundred-km terrain tile).
//   2. Chain-merge of plain ways that share an endpoint and carry the same
//      identifying tags (e.g. the dozens of OSM segments of one named river
//      or one trunk road become a single line).
//   3. Optional highway filter for roads.json (`--roads` regex, default
//      motorway|trunk|primary).
//
// Rewrites files in place: water_large.json (or water.json), roads.json,
// borders_national.json, resources.json.
//
// Run:  node scripts/prefetch/simplify.mjs [--tol 0.0008] [--roads "^(motorway|trunk|primary)$"] slug

import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
let tol = 0.0008;
let roadsRe = /^(motorway|trunk|primary)$/;
const slugs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--tol') tol = Number(args[++i]);
  else if (args[i] === '--roads') roadsRe = new RegExp(args[++i]);
  else slugs.push(args[i]);
}
if (!slugs.length) {
  console.error('usage: simplify.mjs [--tol deg] [--roads regex] slug...');
  process.exit(1);
}

const round5 = (n) => Math.round(n * 1e5) / 1e5;

function perpDist2(p, a, b) {
  let dx = b.lon - a.lon, dy = b.lat - a.lat;
  let x = a.lon, y = a.lat;
  if (dx !== 0 || dy !== 0) {
    const t = ((p.lon - a.lon) * dx + (p.lat - a.lat) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = b.lon; y = b.lat; } else if (t > 0) { x += dx * t; y += dy * t; }
  }
  dx = p.lon - x; dy = p.lat - y;
  return dx * dx + dy * dy;
}

function simplify(pts) {
  if (!pts || pts.length < 3) return pts;
  const t2 = tol * tol;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perpDist2(pts[i], pts[s], pts[e]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > t2) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  const out = pts.filter((_, i) => keep[i]);
  const closed = pts[0].lat === pts[pts.length - 1].lat && pts[0].lon === pts[pts.length - 1].lon;
  // Don't collapse a closed ring below a triangle.
  if (closed && out.length < 4) return pts.length <= 4 ? pts : [pts[0], pts[Math.floor(pts.length / 3)], pts[Math.floor((2 * pts.length) / 3)], pts[0]];
  return out.map((p) => ({ lat: round5(p.lat), lon: round5(p.lon) }));
}

const ptKey = (p) => `${p.lat},${p.lon}`;

/** Merge open ways with equal `keyOf(tags)` that touch end-to-end. */
function mergeChains(ways, keyOf) {
  const groups = new Map();
  const rest = [];
  for (const w of ways) {
    const g = w.geometry;
    const k = keyOf(w.tags || {});
    if (k == null || !g || g.length < 2 || ptKey(g[0]) === ptKey(g[g.length - 1])) { rest.push(w); continue; }
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(w);
  }
  for (const list of groups.values()) {
    const alive = new Set(list);
    const byEnd = new Map();
    const add = (w, p) => { const k = ptKey(p); if (!byEnd.has(k)) byEnd.set(k, new Set()); byEnd.get(k).add(w); };
    const del = (w, p) => byEnd.get(ptKey(p))?.delete(w);
    for (const w of list) { add(w, w.geometry[0]); add(w, w.geometry[w.geometry.length - 1]); }
    for (const w of list) {
      if (!alive.has(w)) continue;
      let grew = true;
      while (grew) {
        grew = false;
        for (const atEnd of [true, false]) {
          const g = w.geometry;
          const p = atEnd ? g[g.length - 1] : g[0];
          const cand = [...(byEnd.get(ptKey(p)) || [])].find((o) => o !== w && alive.has(o));
          if (!cand) continue;
          del(w, g[0]); del(w, g[g.length - 1]);
          del(cand, cand.geometry[0]); del(cand, cand.geometry[cand.geometry.length - 1]);
          let og = cand.geometry;
          if (atEnd) {
            if (ptKey(og[0]) !== ptKey(p)) og = [...og].reverse();
            w.geometry = g.concat(og.slice(1));
          } else {
            if (ptKey(og[og.length - 1]) !== ptKey(p)) og = [...og].reverse();
            w.geometry = og.concat(g.slice(1));
          }
          alive.delete(cand);
          add(w, w.geometry[0]); add(w, w.geometry[w.geometry.length - 1]);
          grew = true;
        }
      }
    }
    rest.push(...alive);
  }
  return rest;
}

function simplifyElements(elements) {
  return elements.map((el) => {
    const ne = { ...el };
    if (el.geometry) ne.geometry = simplify(el.geometry);
    if (el.members) ne.members = el.members.map((m) => (m.geometry ? { ...m, geometry: simplify(m.geometry) } : m));
    return ne;
  });
}

function countPts(els) {
  return els.reduce((s, e) => s + (e.geometry?.length || 0) + (e.members || []).reduce((t, m) => t + (m.geometry?.length || 0), 0), 0);
}

async function processFile(file, { filter, keyOf } = {}) {
  let data;
  try { data = JSON.parse(await fs.readFile(file, 'utf8')); } catch { return; }
  const before = { n: data.elements.length, pts: countPts(data.elements), size: (await fs.stat(file)).size };
  let els = data.elements;
  if (filter) els = els.filter(filter);
  if (keyOf) {
    const ways = els.filter((e) => e.type === 'way' && !e.members);
    const others = els.filter((e) => !(e.type === 'way' && !e.members));
    els = others.concat(mergeChains(ways, keyOf));
  }
  els = simplifyElements(els);
  await fs.writeFile(file, JSON.stringify({ elements: els }));
  const size = (await fs.stat(file)).size;
  console.log(`  ${path.basename(file)}: ${before.n}→${els.length} elements, ` +
    `${before.pts}→${countPts(els)} pts, ${(before.size / 1e6).toFixed(1)}→${(size / 1e6).toFixed(1)} MB`);
}

for (const slug of slugs) {
  const dir = path.join('public/data/locations', slug);
  console.log(`[${slug}] tol=${tol}°`);
  const waterKey = (t) => (t.waterway ? `w:${t.waterway}:${t.name ?? ''}` : t.natural === 'coastline' ? 'coast' : null);
  await processFile(path.join(dir, 'water_large.json'), { keyOf: waterKey });
  await processFile(path.join(dir, 'water.json'), { keyOf: waterKey });
  await processFile(path.join(dir, 'roads.json'), {
    filter: (e) => roadsRe.test(e.tags?.highway ?? ''),
    keyOf: (t) => `h:${t.highway}:${t.ref ?? ''}:${t.name ?? ''}`,
  });
  await processFile(path.join(dir, 'borders_national.json'));
  await processFile(path.join(dir, 'resources.json'));
}
