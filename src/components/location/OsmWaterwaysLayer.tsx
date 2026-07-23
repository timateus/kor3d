import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { useThree } from '@react-three/fiber';
import type { GeoBounds, TerrainData } from '@/lib/geotiff-loader';

export interface WaterFeature {
  id: number | string;
  kind: 'linear' | 'area';
  tags: Record<string, string>;
  coords: [number, number][];
}

interface Props {
  terrain: TerrainData;
  exaggeration: number;
  /** Terrain bounds — used to map lat/lon to mesh coords. */
  bounds: GeoBounds;
  /** Larger clip bounds — features fully outside are dropped. Defaults to bounds. */
  clipBounds?: GeoBounds;
  dataUrl?: string;
  onSelect?: (f: WaterFeature | null) => void;
}

const _cache = new Map<string, WaterFeature[]>();

function parseElements(data: any): WaterFeature[] {
  const out: WaterFeature[] = [];
  for (const el of data.elements || []) {
    if (el.type === 'way' && Array.isArray(el.geometry)) {
      const coords = el.geometry.map((g: any) => [g.lon, g.lat] as [number, number]);
      const kind: 'linear' | 'area' = el.tags?.waterway ? 'linear' : 'area';
      out.push({ id: el.id, kind, tags: el.tags || {}, coords });
    } else if (el.type === 'relation' && Array.isArray(el.members)) {
      for (const m of el.members) {
        if (m.type === 'way' && Array.isArray(m.geometry)) {
          const coords = m.geometry.map((g: any) => [g.lon, g.lat] as [number, number]);
          out.push({ id: `${el.id}/${m.ref}`, kind: 'area', tags: el.tags || {}, coords });
        }
      }
    }
  }
  return out;
}

async function fetchStatic(url: string): Promise<WaterFeature[]> {
  const hit = _cache.get(url);
  if (hit) return hit;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Static ${res.status}`);
  const parsed = parseElements(await res.json());
  _cache.set(url, parsed);
  return parsed;
}

const OsmWaterwaysLayer = ({ terrain, exaggeration, bounds, clipBounds, dataUrl, onSelect }: Props) => {
  const [features, setFeatures] = useState<WaterFeature[] | null>(null);
  const { size } = useThree();
  const clip = clipBounds ?? bounds;

  useEffect(() => {
    if (!dataUrl) { setFeatures([]); return; }
    let cancelled = false;
    fetchStatic(dataUrl)
      .then((l) => { if (!cancelled) setFeatures(l); })
      .catch((e) => { console.warn('OSM water fetch failed', e); if (!cancelled) setFeatures([]); });
    return () => { cancelled = true; };
  }, [dataUrl]);

  const group = useMemo(() => {
    if (!features || features.length === 0) return null;
    const meshW = 10;
    const meshH = 10 * (terrain.height / terrain.width);
    const elevRange = terrain.maxElevation - terrain.minElevation || 1;
    const maxHeight = 10 * (exaggeration / 100);
    const lift = Math.max(0.008, maxHeight * 0.004);
    const waterColor = new THREE.Color('#6ea8c9');

    // Water features can extend beyond terrain — scale positions using terrain bounds
    // (so overlap is aligned) but keep them visible on a flat plane at min height.
    const sampleY = (nxT: number, nyT: number) => {
      if (nxT < 0 || nxT > 1 || nyT < 0 || nyT > 1) return lift; // outside terrain: near base
      const cx = Math.max(0, Math.min(terrain.width - 1, Math.floor(nxT * (terrain.width - 1))));
      const cy = Math.max(0, Math.min(terrain.height - 1, Math.floor((1 - nyT) * (terrain.height - 1))));
      let e = terrain.elevations[cy * terrain.width + cx];
      if (!isFinite(e)) e = terrain.minElevation;
      return ((e - terrain.minElevation) / elevRange) * maxHeight + lift;
    };

    const g = new THREE.Group();
    const disposables: { geom: LineGeometry; mat: LineMaterial }[] = [];

    for (const f of features) {
      // clip test against wider bounds
      let anyInClip = false;
      for (const [lon, lat] of f.coords) {
        if (lon >= clip.minLon && lon <= clip.maxLon && lat >= clip.minLat && lat <= clip.maxLat) {
          anyInClip = true; break;
        }
      }
      if (!anyInClip) continue;

      const positions: number[] = [];
      for (const [lon, lat] of f.coords) {
        const nxT = (lon - bounds.minLon) / (bounds.maxLon - bounds.minLon);
        const nyT = (lat - bounds.minLat) / (bounds.maxLat - bounds.minLat);
        const x = (nxT - 0.5) * meshW;
        const z = -((nyT - 0.5) * meshH);
        const y = sampleY(nxT, nyT);
        positions.push(x, y, z);
      }
      if (positions.length < 6) continue;

      const geom = new LineGeometry();
      geom.setPositions(new Float32Array(positions));
      const mat = new LineMaterial({
        color: waterColor.getHex(),
        linewidth: 1.6,
        transparent: true,
        opacity: 0.7,
        depthTest: true,
        resolution: new THREE.Vector2(size.width, size.height),
      });
      const line = new Line2(geom, mat);
      line.renderOrder = 2;
      line.userData = { waterFeature: f };
      g.add(line);
      disposables.push({ geom, mat });
    }
    (g.userData as any).__disposables = disposables;
    return g;
  }, [features, terrain, exaggeration, bounds, clip.minLon, clip.minLat, clip.maxLon, clip.maxLat, size.width, size.height]);

  useEffect(() => () => {
    if (!group) return;
    const d = (group.userData as any).__disposables as { geom: LineGeometry; mat: LineMaterial }[] | undefined;
    if (d) for (const { geom, mat } of d) { geom.dispose(); mat.dispose(); }
  }, [group]);

  if (!group) return null;
  return (
    <primitive
      object={group}
      onClick={(e: any) => {
        const obj = e.object;
        const f = obj?.userData?.waterFeature as WaterFeature | undefined;
        if (f) { e.stopPropagation(); onSelect?.(f); }
      }}
      onPointerOver={(e: any) => {
        const f = e.object?.userData?.waterFeature;
        if (f) document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => { document.body.style.cursor = ''; }}
    />
  );
};

export default OsmWaterwaysLayer;
