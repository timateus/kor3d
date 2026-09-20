import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { useThree } from '@react-three/fiber';
import type { GeoBounds, TerrainData } from '@/lib/geotiff-loader';

/**
 * Real (not HydroSHEDS-modeled) irrigation/water-accounting data for the Amu
 * Darya / Syr Darya basin — the two things the natural-flow river network
 * can't show: where water is actually diverted (major named canals, at their
 * design capacity — cawater-info.net doesn't publish per-canal actual
 * withdrawal) and how much reservoirs actually released this season (real
 * NIC ICWC figures, sic.icwc-aral.uz analytical reports). See
 * wiki/sources/aral-sea-basin-canal-water-data-2026-09 for provenance —
 * canal routes here are an approximate intake-to-city line, not a surveyed
 * alignment.
 */

export interface CanalFeature {
  name: string;
  kind: string;
  capacity_m3s: number;
  note?: string;
}

export interface ReservoirFeature {
  name: string;
  river: string;
  period: string;
  inflow_km3: number;
  inflow_plan_km3?: number;
  release_km3: number;
  note?: string;
}

interface Props {
  exaggeration: number;
  bounds: GeoBounds;
  terrain: TerrainData;
  dataUrl: string;
  onSelectCanal?: (c: CanalFeature | null) => void;
  onSelectReservoir?: (r: ReservoirFeature | null) => void;
  onLoaded?: () => void;
}

const _cache = new Map<string, any>();
async function fetchJson(url: string): Promise<any> {
  const hit = _cache.get(url);
  if (hit) return hit;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Static ${res.status}`);
  const data = await res.json();
  _cache.set(url, data);
  return data;
}

const IrrigationCanalsLayer = ({
  exaggeration, bounds, terrain, dataUrl, onSelectCanal, onSelectReservoir, onLoaded,
}: Props) => {
  const [data, setData] = useState<any>(null);
  const { size } = useThree();

  useEffect(() => {
    let cancelled = false;
    fetchJson(dataUrl)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { console.warn('Water accounting fetch failed', e); if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) onLoaded?.(); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataUrl]);

  const built = useMemo(() => {
    if (!data) return null;
    const meshW = 10;
    const meshH = 10 * (terrain.height / terrain.width);
    const maxHeight = 10 * (exaggeration / 100);
    const lift = Math.max(0.01, maxHeight * 0.006);

    const toXZ = (lon: number, lat: number): [number, number] => {
      const nxT = (lon - bounds.minLon) / (bounds.maxLon - bounds.minLon);
      const nyT = (lat - bounds.minLat) / (bounds.maxLat - bounds.minLat);
      return [(nxT - 0.5) * meshW, -((nyT - 0.5) * meshH)];
    };

    const canalGroup = new THREE.Group();
    const disposables: { geom: LineGeometry; mat: LineMaterial }[] = [];
    const canalColor = new THREE.Color('#e8964a');
    const maxCap = Math.max(1, ...data.canals.features.map((f: any) => f.properties.capacity_m3s));

    for (const f of data.canals.features) {
      const props = f.properties as CanalFeature;
      const coords = f.geometry.coordinates as [number, number][];
      const positions: number[] = [];
      for (const [lon, lat] of coords) {
        const [x, z] = toXZ(lon, lat);
        positions.push(x, lift, z);
      }
      const geom = new LineGeometry();
      geom.setPositions(new Float32Array(positions));
      const norm = props.capacity_m3s / maxCap;
      const mat = new LineMaterial({
        color: canalColor.getHex(),
        linewidth: 1.2 + norm * 3.2,
        transparent: true,
        opacity: 0.85,
        depthTest: true,
        resolution: new THREE.Vector2(size.width, size.height),
      });
      const line = new Line2(geom, mat);
      line.renderOrder = 3;
      line.userData = { canal: props };
      canalGroup.add(line);
      disposables.push({ geom, mat });
    }

    const reservoirGroup = new THREE.Group();
    const reservoirColor = new THREE.Color('#38bdf8');
    const sphereGeom = new THREE.SphereGeometry(0.045, 12, 12);
    for (const f of data.reservoirs.features) {
      const props = f.properties as ReservoirFeature;
      const [lon, lat] = f.geometry.coordinates as [number, number];
      const [x, z] = toXZ(lon, lat);
      const mat = new THREE.MeshBasicMaterial({ color: reservoirColor, transparent: true, opacity: 0.9 });
      const mesh = new THREE.Mesh(sphereGeom, mat);
      mesh.position.set(x, lift + 0.03, z);
      mesh.userData = { reservoir: props };
      reservoirGroup.add(mesh);
    }

    return { canalGroup, reservoirGroup, disposables, sphereGeom };
  }, [data, terrain, exaggeration, bounds, size.width, size.height]);

  useEffect(() => () => {
    if (!built) return;
    for (const { geom, mat } of built.disposables) { geom.dispose(); mat.dispose(); }
    built.sphereGeom.dispose();
    built.reservoirGroup.children.forEach((m) => {
      const mesh = m as THREE.Mesh;
      (mesh.material as THREE.Material).dispose();
    });
  }, [built]);

  if (!built) return null;
  return (
    <group>
      <primitive
        object={built.canalGroup}
        onClick={(e: any) => {
          const c = e.object?.userData?.canal as CanalFeature | undefined;
          if (c) { e.stopPropagation(); onSelectCanal?.(c); }
        }}
        onPointerOver={(e: any) => { if (e.object?.userData?.canal) document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { document.body.style.cursor = ''; }}
      />
      <primitive
        object={built.reservoirGroup}
        onClick={(e: any) => {
          const r = e.object?.userData?.reservoir as ReservoirFeature | undefined;
          if (r) { e.stopPropagation(); onSelectReservoir?.(r); }
        }}
        onPointerOver={(e: any) => { if (e.object?.userData?.reservoir) document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { document.body.style.cursor = ''; }}
      />
    </group>
  );
};

export default IrrigationCanalsLayer;
