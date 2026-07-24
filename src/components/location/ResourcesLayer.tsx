import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import type { GeoBounds, TerrainData } from '@/lib/geotiff-loader';
import { fetchOverpass } from '@/lib/overpass';

type Category = 'mining' | 'oil_gas' | 'logging' | 'industrial';

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
}

const CATEGORY_STYLE: Record<Category, { color: string; label: string }> = {
  mining:     { color: '#c2410c', label: 'Mining' },
  oil_gas:    { color: '#eab308', label: 'Oil & gas' },
  logging:    { color: '#15803d', label: 'Logging' },
  industrial: { color: '#64748b', label: 'Industrial' },
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

const ResourcesLayer = ({ terrain, exaggeration, bounds, clipBounds, enabled }: Props) => {
  const [data, setData] = useState<{ points: ResourcePoint[]; areas: ResourceArea[] } | null>(null);
  const clip = clipBounds ?? bounds;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchResources(clip)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { console.warn('Resources fetch failed', e); if (!cancelled) setData({ points: [], areas: [] }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, clip.minLon, clip.minLat, clip.maxLon, clip.maxLat]);

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
      const pts2d = a.coords.map(([lon, lat]) => new THREE.Vector2(...toXZ(lon, lat)));
      const shape = new THREE.Shape(pts2d);
      const geo = new THREE.ShapeGeometry(shape);
      let sumLon = 0, sumLat = 0;
      for (const [lon, lat] of a.coords) { sumLon += lon; sumLat += lat; }
      const cy = toY(elevAt(sumLon / a.coords.length, sumLat / a.coords.length));
      return { id: a.id, category: a.category, label: a.label, geo, y: cy };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, data, terrain, exaggeration, bounds]);

  useEffect(() => () => { for (const p of polygons) p.geo.dispose(); }, [polygons]);

  if (!enabled) return null;

  return (
    <group>
      {polygons.map((p) => (
        <mesh key={`area-${p.id}`} geometry={p.geo} position={[0, p.y, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <meshBasicMaterial
            color={CATEGORY_STYLE[p.category].color}
            transparent opacity={0.32} side={THREE.DoubleSide} depthWrite={false}
            polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-1}
          />
        </mesh>
      ))}
      {markers.map((m) => {
        const s = CATEGORY_STYLE[m.category];
        return (
          <group key={`pt-${m.id}`} position={m.pos}>
            <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={[0.02, 0.032, 20]} />
              <meshBasicMaterial color={s.color} transparent opacity={0.5} depthWrite={false} />
            </mesh>
            <mesh position={[0, 0.045, 0]}>
              <sphereGeometry args={[0.016, 10, 10]} />
              <meshStandardMaterial color={s.color} emissive={s.color} emissiveIntensity={0.7} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
};

export default ResourcesLayer;
