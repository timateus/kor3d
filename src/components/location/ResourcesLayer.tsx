import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { useThree } from '@react-three/fiber';
import type { GeoBounds, TerrainData } from '@/lib/geotiff-loader';
import { fetchOverpass } from '@/lib/overpass';

type Category = 'mining' | 'oil_gas' | 'logging' | 'industrial';

export interface ResourceFeature {
  id: number | string;
  category: Category;
  categoryLabel: string;
  label: string;
  kind: 'point' | 'area';
  lat: number;
  lon: number;
}

interface ResourcePoint {
  id: number | string;
  category: Category;
  label: string;
  lon: number;
  lat: number;
}

interface ResourceArea {
  id: number | string;
  category: Category;
  label: string;
  coords: [number, number][];
}

interface Props {
  terrain: TerrainData;
  exaggeration: number;
  bounds: GeoBounds;
  clipBounds?: GeoBounds;
  enabled: boolean;
  /** Optional pre-baked static JSON (raw Overpass output) — tried first, avoids depending on flaky live Overpass mirrors. */
  dataUrl?: string;
  onSelect?: (r: ResourceFeature | null) => void;
  /** Fires with the full flattened feature list (points + area centroids) whenever the underlying data changes — lets a caller sample from it (e.g. an ambient carousel) without duplicating the fetch. */
  onData?: (features: ResourceFeature[]) => void;
}

const CATEGORY_STYLE: Record<Category, { color: string; label: string }> = {
  mining:     { color: '#f97316', label: 'Mining' },
  oil_gas:    { color: '#eab308', label: 'Oil & gas' },
  logging:    { color: '#22c55e', label: 'Logging' },
  industrial: { color: '#94a3b8', label: 'Industrial' },
};

function categorize(tags: Record<string, string>): { category: Category; label: string } | null {
  if (tags.landuse === 'quarry' || tags.man_made === 'mine' || tags.industrial === 'mine' || tags.resource) {
    return { category: 'mining', label: tags.resource ? `${tags.resource} mine` : (tags.name ?? 'Mine / quarry') };
  }
  if (tags.man_made === 'petroleum_well' || tags.pipeline === 'substation' || tags.industrial === 'oil' || tags.industrial === 'gas' || tags.man_made === 'pipeline') {
    return { category: 'oil_gas', label: tags.name ?? (tags.man_made === 'petroleum_well' ? 'Well' : tags.pipeline === 'substation' ? 'Pipeline substation' : 'Oil/gas facility') };
  }
  if (tags.landuse === 'forestry') {
    return { category: 'logging', label: tags.name ?? 'Forestry' };
  }
  if (tags.landuse === 'industrial') {
    return { category: 'industrial', label: tags.name ?? 'Industrial area' };
  }
  return null;
}

function parseElements(data: any): { points: ResourcePoint[]; areas: ResourceArea[] } {
  const points: ResourcePoint[] = [];
  const areas: ResourceArea[] = [];
  for (const el of data.elements || []) {
    const cat = categorize(el.tags || {});
    if (!cat) continue;
    if (el.type === 'node' && typeof el.lon === 'number' && typeof el.lat === 'number') {
      points.push({ id: el.id, category: cat.category, label: cat.label, lon: el.lon, lat: el.lat });
    } else if (el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length >= 3) {
      const coords = el.geometry.map((g: any) => [g.lon, g.lat] as [number, number]);
      areas.push({ id: el.id, category: cat.category, label: cat.label, coords });
    }
  }
  return { points, areas };
}

const _cache = new Map<string, { points: ResourcePoint[]; areas: ResourceArea[] }>();

async function fetchStatic(url: string): Promise<{ points: ResourcePoint[]; areas: ResourceArea[] }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Static ${res.status}`);
  return parseElements(await res.json());
}

async function fetchResources(b: GeoBounds): Promise<{ points: ResourcePoint[]; areas: ResourceArea[] }> {
  const bbox = `${b.minLat},${b.minLon},${b.maxLat},${b.maxLon}`;
  const key = `resources:${b.minLon.toFixed(4)},${b.minLat.toFixed(4)},${b.maxLon.toFixed(4)},${b.maxLat.toFixed(4)}`;
  const hit = _cache.get(key);
  if (hit) return hit;
  const q = `[out:json][timeout:80];
    (
      node["man_made"="mine"](${bbox});
      way["man_made"="mine"](${bbox});
      node["man_made"="petroleum_well"](${bbox});
      node["pipeline"="substation"](${bbox});
      way["landuse"="quarry"](${bbox});
      way["landuse"="industrial"](${bbox});
      way["industrial"="mine"](${bbox});
      way["industrial"="oil"](${bbox});
      way["industrial"="gas"](${bbox});
      way["landuse"="forestry"](${bbox});
      node["resource"](${bbox});
      way["resource"](${bbox});
    );
    out geom;`;
  const json = await fetchOverpass<any>(q, key);
  const parsed = parseElements(json);
  _cache.set(key, parsed);
  return parsed;
}

// Soft radial-gradient disc (white core fading to transparent) — tinted per
// category via the sprite material's color, so one shared texture covers
// every category. Two sprites of this same texture, layered at different
// scales/opacities, give a "beacon glow" instead of a hard map pin.
let _glowTex: THREE.Texture | null = null;
function glowTexture(): THREE.Texture {
  if (_glowTex) return _glowTex;
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.22)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  _glowTex = new THREE.CanvasTexture(c);
  return _glowTex;
}

const ResourcesLayer = ({ terrain, exaggeration, bounds, clipBounds, enabled, dataUrl, onSelect, onData }: Props) => {
  const [data, setData] = useState<{ points: ResourcePoint[]; areas: ResourceArea[] } | null>(null);
  const clip = clipBounds ?? bounds;
  const { size } = useThree();
  const tex = glowTexture();

  useEffect(() => {
    if (!onData) return;
    if (!data) { onData([]); return; }
    const features: ResourceFeature[] = [
      ...data.points.map((p): ResourceFeature => ({
        id: p.id, category: p.category, categoryLabel: CATEGORY_STYLE[p.category].label,
        label: p.label, kind: 'point', lat: p.lat, lon: p.lon,
      })),
      ...data.areas.map((a): ResourceFeature => {
        let sumLon = 0, sumLat = 0;
        for (const [lon, lat] of a.coords) { sumLon += lon; sumLat += lat; }
        return {
          id: a.id, category: a.category, categoryLabel: CATEGORY_STYLE[a.category].label,
          label: a.label, kind: 'area', lat: sumLat / a.coords.length, lon: sumLon / a.coords.length,
        };
      }),
    ];
    onData(features);
    // onData intentionally excluded: only the underlying data should trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const fallback = () =>
      fetchResources(clip)
        .then((d) => { if (!cancelled) setData(d); })
        .catch((e) => { console.warn('Resources fetch failed', e); if (!cancelled) setData({ points: [], areas: [] }); });

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

  const meshW = 10;
  const meshH = 10 * (terrain.height / terrain.width);
  const elevRange = terrain.maxElevation - terrain.minElevation || 1;
  const maxH = 10 * (exaggeration / 100);
  const lift = Math.max(0.012, maxH * 0.007);

  const elevAt = (lon: number, lat: number) => {
    const nx = (lon - bounds.minLon) / (bounds.maxLon - bounds.minLon);
    const ny = (lat - bounds.minLat) / (bounds.maxLat - bounds.minLat);
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return terrain.minElevation;
    const px = Math.min(terrain.width - 1, Math.max(0, Math.floor(nx * (terrain.width - 1))));
    const py = Math.min(terrain.height - 1, Math.max(0, Math.floor((1 - ny) * (terrain.height - 1))));
    const e = terrain.elevations[py * terrain.width + px];
    return isFinite(e) ? e : terrain.minElevation;
  };
  const toXZ = (lon: number, lat: number): [number, number] => {
    const nx = (lon - bounds.minLon) / (bounds.maxLon - bounds.minLon);
    const ny = (lat - bounds.minLat) / (bounds.maxLat - bounds.minLat);
    return [(nx - 0.5) * meshW, -((ny - 0.5) * meshH)];
  };
  const toY = (elev: number) => ((elev - terrain.minElevation) / elevRange) * maxH + lift;

  const markers = useMemo(() => {
    if (!enabled || !data) return [];
    return data.points.map((p) => {
      const [x, z] = toXZ(p.lon, p.lat);
      const y = toY(elevAt(p.lon, p.lat));
      return { ...p, pos: [x, y, z] as [number, number, number] };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, data, terrain, exaggeration, bounds]);

  const polygons = useMemo(() => {
    if (!enabled || !data) return [];
    return data.areas.map((a) => {
      // Shape() builds geometry in the local XY plane; the mesh below then
      // rotates -90° about X to lay it flat, which maps local y → world -z.
      // Negate z here so the fill ends up at world +z — matching the
      // un-rotated outline below, which uses world (x, z) directly. Without
      // this the two were mirrored across z=0 relative to each other, and
      // the clickable fill mesh sat somewhere else entirely from what was
      // drawn as its outline.
      const pts2d = a.coords.map(([lon, lat]) => {
        const [x, z] = toXZ(lon, lat);
        return new THREE.Vector2(x, -z);
      });
      const shape = new THREE.Shape(pts2d);
      const geo = new THREE.ShapeGeometry(shape);
      let sumLon = 0, sumLat = 0;
      for (const [lon, lat] of a.coords) { sumLon += lon; sumLat += lat; }
      const cy = toY(elevAt(sumLon / a.coords.length, sumLat / a.coords.length));
      const outlinePositions: number[] = [];
      for (const [lon, lat] of a.coords) {
        const [ox, oz] = toXZ(lon, lat);
        outlinePositions.push(ox, cy + 0.004, oz);
      }
      const [fx, fz] = toXZ(a.coords[0][0], a.coords[0][1]);
      outlinePositions.push(fx, cy + 0.004, fz);
      const outlineGeom = new LineGeometry();
      outlineGeom.setPositions(new Float32Array(outlinePositions));
      const outlineMat = new LineMaterial({
        color: new THREE.Color(CATEGORY_STYLE[a.category].color).getHex(),
        linewidth: 1.6, transparent: true, opacity: 0.85, depthTest: true,
        resolution: new THREE.Vector2(size.width, size.height),
      });
      return {
        id: a.id, category: a.category, label: a.label, geo, y: cy, outlineGeom, outlineMat,
        lat: sumLat / a.coords.length, lon: sumLon / a.coords.length,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, data, terrain, exaggeration, bounds, size.width, size.height]);

  useEffect(() => () => {
    for (const p of polygons) { p.geo.dispose(); p.outlineGeom.dispose(); p.outlineMat.dispose(); }
  }, [polygons]);

  if (!enabled) return null;

  return (
    <group>
      {polygons.map((p) => (
        <group key={`area-${p.id}`}>
          <mesh
            geometry={p.geo}
            position={[0, p.y, 0]}
            rotation={[-Math.PI / 2, 0, 0]}
            onClick={(e) => {
              e.stopPropagation();
              onSelect?.({ id: p.id, category: p.category, categoryLabel: CATEGORY_STYLE[p.category].label, label: p.label, kind: 'area', lat: p.lat, lon: p.lon });
            }}
            onPointerOver={() => { document.body.style.cursor = 'pointer'; }}
            onPointerOut={() => { document.body.style.cursor = ''; }}
          >
            <meshBasicMaterial
              color={CATEGORY_STYLE[p.category].color}
              transparent opacity={0.4} side={THREE.DoubleSide} depthWrite={false}
              polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-1}
            />
          </mesh>
          <primitive object={new Line2(p.outlineGeom, p.outlineMat)} />
        </group>
      ))}
      {markers.map((m) => {
        const s = CATEGORY_STYLE[m.category];
        const color = new THREE.Color(s.color);
        return (
          <group
            key={`pt-${m.id}`}
            position={m.pos}
            onClick={(e) => {
              e.stopPropagation();
              onSelect?.({ id: m.id, category: m.category, categoryLabel: s.label, label: m.label, kind: 'point', lat: m.lat, lon: m.lon });
            }}
            onPointerOver={() => { document.body.style.cursor = 'pointer'; }}
            onPointerOut={() => { document.body.style.cursor = ''; }}
          >
            {/* outer soft halo */}
            <sprite scale={[0.16, 0.16, 1]}>
              <spriteMaterial map={tex} color={color} transparent opacity={0.55} depthWrite={false} sizeAttenuation />
            </sprite>
            {/* bright core */}
            <sprite position={[0, 0.001, 0]} scale={[0.07, 0.07, 1]}>
              <spriteMaterial map={tex} color={color} transparent opacity={0.95} depthWrite={false} sizeAttenuation />
            </sprite>
            {/* invisible larger hit-target so the glow is easy to click */}
            <mesh visible={false}>
              <sphereGeometry args={[0.06, 8, 8]} />
              <meshBasicMaterial transparent opacity={0} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
};

export default ResourcesLayer;
