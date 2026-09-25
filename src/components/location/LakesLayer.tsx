import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GeoBounds, TerrainData } from '@/lib/geotiff-loader';
import { fetchOverpass } from '@/lib/overpass';

export interface LakeFeature {
  id: number | string;
  name: string;
  waterType: string;
  artificial: boolean;
  areaKm2: number;
  lat: number;
  lon: number;
}

interface LakePolygon {
  id: number | string;
  name: string;
  waterType: string;
  artificial: boolean;
  coords: [number, number][];
}

interface Props {
  terrain: TerrainData;
  exaggeration: number;
  bounds: GeoBounds;
  clipBounds?: GeoBounds;
  enabled: boolean;
  /** Optional pre-baked static JSON (raw Overpass output, e.g. the same water.json/water_large.json OsmWaterwaysLayer uses) — tried first. */
  dataUrl?: string;
  onSelect?: (f: LakeFeature | null) => void;
}

const NATURAL_COLOR = '#38bdf8';
const ARTIFICIAL_COLOR = '#2dd4bf';

// Standing-water bodies only — rivers/canals/streams/ditches (already covered
// by the Water and Canals layers) are excluded here.
function classify(tags: Record<string, string>): { waterType: string; artificial: boolean } | null {
  const w = tags.water;
  if (tags.natural === 'water') {
    if (w === 'river' || w === 'canal' || w === 'stream' || w === 'ditch' || w === 'drain' || w === 'wadi') return null;
    if (w === 'reservoir') return { waterType: 'Reservoir', artificial: true };
    if (w === 'basin' || w === 'wastewater') return { waterType: 'Basin', artificial: true };
    if (w === 'pond') return { waterType: 'Pond', artificial: false };
    if (w === 'oxbow') return { waterType: 'Oxbow lake', artificial: false };
    if (w === 'lagoon') return { waterType: 'Lagoon', artificial: false };
    return { waterType: 'Lake', artificial: false };
  }
  if (tags.landuse === 'reservoir') return { waterType: 'Reservoir', artificial: true };
  return null;
}

function parseElements(data: any): LakePolygon[] {
  const out: LakePolygon[] = [];
  for (const el of data.elements || []) {
    const tags = el.tags || {};
    const cls = classify(tags);
    if (!cls) continue;
    if (el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length >= 3) {
      const coords = el.geometry.map((g: any) => [g.lon, g.lat] as [number, number]);
      out.push({ id: el.id, name: tags.name ?? '', waterType: cls.waterType, artificial: cls.artificial, coords });
    } else if (el.type === 'relation' && Array.isArray(el.members)) {
      for (const m of el.members) {
        if ((m.role === 'outer' || !m.role) && m.type === 'way' && Array.isArray(m.geometry) && m.geometry.length >= 3) {
          const coords = m.geometry.map((g: any) => [g.lon, g.lat] as [number, number]);
          out.push({ id: `${el.id}/${m.ref}`, name: tags.name ?? '', waterType: cls.waterType, artificial: cls.artificial, coords });
        }
      }
    }
  }
  return out;
}

function polygonAreaKm2(coords: [number, number][]): number {
  if (coords.length < 3) return 0;
  const latRef = coords[0][1];
  const kmPerDegLat = 111.32;
  const kmPerDegLon = 111.32 * Math.cos((latRef * Math.PI) / 180);
  let area = 0;
  for (let i = 0; i < coords.length; i++) {
    const [lon1, lat1] = coords[i];
    const [lon2, lat2] = coords[(i + 1) % coords.length];
    area += lon1 * kmPerDegLon * (lat2 * kmPerDegLat) - lon2 * kmPerDegLon * (lat1 * kmPerDegLat);
  }
  return Math.abs(area) / 2;
}

const _cache = new Map<string, LakePolygon[]>();

async function fetchStatic(url: string): Promise<LakePolygon[]> {
  const hit = _cache.get(url);
  if (hit) return hit;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Static ${res.status}`);
  const parsed = parseElements(await res.json());
  _cache.set(url, parsed);
  return parsed;
}

async function fetchLive(b: GeoBounds): Promise<LakePolygon[]> {
  const bbox = `${b.minLat},${b.minLon},${b.maxLat},${b.maxLon}`;
  const key = `lakes:${b.minLon.toFixed(4)},${b.minLat.toFixed(4)},${b.maxLon.toFixed(4)},${b.maxLat.toFixed(4)}`;
  const hit = _cache.get(key);
  if (hit) return hit;
  const q = `[out:json][timeout:80];
    (
      way["natural"="water"](${bbox});
      relation["natural"="water"](${bbox});
      way["landuse"="reservoir"](${bbox});
    );
    out geom;`;
  const json = await fetchOverpass<any>(q, key);
  const parsed = parseElements(json);
  _cache.set(key, parsed);
  return parsed;
}

const LakesLayer = ({ terrain, exaggeration, bounds, clipBounds, enabled, dataUrl, onSelect }: Props) => {
  const [data, setData] = useState<LakePolygon[] | null>(null);
  const clip = clipBounds ?? bounds;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const fallback = () =>
      fetchLive(clip)
        .then((d) => { if (!cancelled) setData(d); })
        .catch((e) => { console.warn('Lakes fetch failed', e); if (!cancelled) setData([]); });

    if (dataUrl) {
      fetchStatic(dataUrl)
        .then((d) => { if (!cancelled) setData(d); })
        .catch(() => { if (!cancelled) fallback(); });
    } else {
      fallback();
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, dataUrl, clip.minLon, clip.minLat, clip.maxLon, clip.maxLat]);

  const elevAt = (lon: number, lat: number) => {
    const nx = (lon - bounds.minLon) / (bounds.maxLon - bounds.minLon);
    const ny = (lat - bounds.minLat) / (bounds.maxLat - bounds.minLat);
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return terrain.minElevation;
    const px = Math.min(terrain.width - 1, Math.max(0, Math.floor(nx * (terrain.width - 1))));
    const py = Math.min(terrain.height - 1, Math.max(0, Math.floor((1 - ny) * (terrain.height - 1))));
    const e = terrain.elevations[py * terrain.width + px];
    return isFinite(e) ? e : terrain.minElevation;
  };

  // Merged into a single mesh (one draw call for potentially hundreds of
  // ponds/lakes) rather than one Shape mesh per polygon — the OSM water line
  // layer hit exactly this perf wall with thousands of separate meshes (see
  // its own comment), and Aral Sea alone has ~600 lake/pond/reservoir
  // polygons. Each polygon's triangle range is recorded in `triangleFeature`
  // so a raycast hit's faceIndex still resolves back to its LakeFeature.
  const merged = useMemo(() => {
    if (!enabled || !data || data.length === 0) return null;
    const meshW = 10;
    const meshH = 10 * (terrain.height / terrain.width);
    const elevRange = terrain.maxElevation - terrain.minElevation || 1;
    const maxH = 10 * (exaggeration / 100);
    const lift = Math.max(0.014, maxH * 0.008);
    const toXZ = (lon: number, lat: number): [number, number] => {
      const nx = (lon - bounds.minLon) / (bounds.maxLon - bounds.minLon);
      const ny = (lat - bounds.minLat) / (bounds.maxLat - bounds.minLat);
      return [(nx - 0.5) * meshW, -((ny - 0.5) * meshH)];
    };
    const toY = (elev: number) => ((elev - terrain.minElevation) / elevRange) * maxH + lift;

    const geometries: THREE.BufferGeometry[] = [];
    const triangleFeature: LakeFeature[] = [];
    const natural = new THREE.Color(NATURAL_COLOR);
    const artificial = new THREE.Color(ARTIFICIAL_COLOR);

    for (const lp of data) {
      let anyInClip = false;
      for (const [lon, lat] of lp.coords) {
        if (lon >= clip.minLon && lon <= clip.maxLon && lat >= clip.minLat && lat <= clip.maxLat) { anyInClip = true; break; }
      }
      if (!anyInClip) continue;

      const pts2d = lp.coords.map(([lon, lat]) => {
        const [x, z] = toXZ(lon, lat);
        return new THREE.Vector2(x, -z);
      });
      let geo: THREE.BufferGeometry;
      try {
        geo = new THREE.ShapeGeometry(new THREE.Shape(pts2d));
      } catch {
        continue;
      }
      if (!geo.index || geo.index.count === 0) { geo.dispose(); continue; }

      let sumLon = 0, sumLat = 0;
      for (const [lon, lat] of lp.coords) { sumLon += lon; sumLat += lat; }
      const lon = sumLon / lp.coords.length, lat = sumLat / lp.coords.length;
      const cy = toY(elevAt(lon, lat));

      // Rotate the shape's local XY plane flat (matches the standalone
      // `rotation={[-Math.PI/2,0,0]}` pattern elsewhere) and lift to its
      // elevation, baked directly into the geometry so it survives merging.
      geo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
      geo.translate(0, cy, 0);

      const color = lp.artificial ? artificial : natural;
      const colors = new Float32Array(geo.attributes.position.count * 3);
      for (let i = 0; i < geo.attributes.position.count; i++) {
        colors[i * 3] = color.r; colors[i * 3 + 1] = color.g; colors[i * 3 + 2] = color.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

      const feature: LakeFeature = {
        id: lp.id, name: lp.name, waterType: lp.waterType, artificial: lp.artificial,
        areaKm2: polygonAreaKm2(lp.coords), lat, lon,
      };
      const triCount = geo.index.count / 3;
      for (let i = 0; i < triCount; i++) triangleFeature.push(feature);

      geometries.push(geo);
    }
    if (geometries.length === 0) return null;

    const mergedGeo = mergeGeometries(geometries, false);
    for (const g of geometries) g.dispose();
    if (!mergedGeo) return null;

    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.4, side: THREE.DoubleSide,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    return { geo: mergedGeo, mat, triangleFeature };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, data, terrain, exaggeration, bounds, clip.minLon, clip.minLat, clip.maxLon, clip.maxLat]);

  useEffect(() => () => {
    if (!merged) return;
    merged.geo.dispose();
    merged.mat.dispose();
  }, [merged]);

  if (!enabled || !merged) return null;

  return (
    <mesh
      geometry={merged.geo}
      material={merged.mat}
      onClick={(e) => {
        const f = typeof e.faceIndex === 'number' ? merged.triangleFeature[e.faceIndex] : undefined;
        if (f) { e.stopPropagation(); onSelect?.(f); }
      }}
      onPointerOver={(e) => {
        const f = typeof e.faceIndex === 'number' ? merged.triangleFeature[e.faceIndex] : undefined;
        if (f) document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => { document.body.style.cursor = ''; }}
    />
  );
};

export default LakesLayer;
