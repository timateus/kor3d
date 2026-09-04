import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import type { GeoBounds, TerrainData } from '@/lib/geotiff-loader';

/**
 * Historical terminus position, derived from WGMS's front-variation series
 * (real ground/photogrammetric length-change surveys since 1902 — not a
 * modeled outline). We don't have a historical polygon to redraw, so instead
 * we walk the current outline's own downhill axis: find the terminus (lowest
 * point) and head (highest point) of the main ring, then push a marker
 * further down that same line by the measured cumulative retreat distance
 * for the selected year. A local equirectangular projection (meters, valid
 * over an area this small) makes the "push along a line" math trivial.
 */

interface Props {
  terrain: TerrainData;
  exaggeration: number;
  bounds: GeoBounds;
  outlineUrl: string;
  /** Cumulative retreat in meters (positive = retreated this far from today's terminus), at the selected year. */
  retreatMeters: number;
}

const _cache = new Map<string, GeoJSON.FeatureCollection>();
async function fetchJson(url: string): Promise<GeoJSON.FeatureCollection> {
  const hit = _cache.get(url);
  if (hit) return hit;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Static ${res.status}`);
  const data = await res.json();
  _cache.set(url, data);
  return data;
}

function ringArea(ring: [number, number][]): number {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return (maxX - minX) * (maxY - minY);
}

const GlacierRetreatLayer = ({ terrain, exaggeration, bounds, outlineUrl, retreatMeters }: Props) => {
  const [fc, setFc] = useState<GeoJSON.FeatureCollection | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchJson(outlineUrl).then((d) => { if (!cancelled) setFc(d); }).catch(() => {});
    return () => { cancelled = true; };
  }, [outlineUrl]);

  const meshW = 10;
  const meshH = 10 * (terrain.height / terrain.width);
  const elevRange = terrain.maxElevation - terrain.minElevation || 1;
  const maxH = 10 * (exaggeration / 100);
  const lift = Math.max(0.02, maxH * 0.01);

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

  const axis = useMemo(() => {
    if (!fc) return null;
    const rings = fc.features.flatMap((f) => {
      if (!f.geometry) return [];
      if (f.geometry.type === 'Polygon') return [f.geometry.coordinates[0] as [number, number][]];
      if (f.geometry.type === 'MultiPolygon') return (f.geometry.coordinates as [number, number][][][]).map((p) => p[0]);
      return [];
    });
    if (rings.length === 0) return null;
    const main = rings.reduce((a, b) => (ringArea(a) > ringArea(b) ? a : b));

    let terminus = main[0], head = main[0];
    let minE = Infinity, maxE = -Infinity;
    for (const [lon, lat] of main) {
      const e = elevAt(lon, lat);
      if (e < minE) { minE = e; terminus = [lon, lat]; }
      if (e > maxE) { maxE = e; head = [lon, lat]; }
    }

    // Local equirectangular meters, referenced at the terminus.
    const lat0 = terminus[1];
    const mPerLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
    const mPerLat = 110540;
    const toM = ([lon, lat]: [number, number]): [number, number] => [(lon - terminus[0]) * mPerLon, (lat - terminus[1]) * mPerLat];
    const fromM = ([mx, my]: [number, number]): [number, number] => [terminus[0] + mx / mPerLon, terminus[1] + my / mPerLat];

    const tM = toM(terminus); // = [0,0]
    const hM = toM(head);
    const dx = tM[0] - hM[0], dy = tM[1] - hM[1];
    const len = Math.hypot(dx, dy) || 1;
    const dir: [number, number] = [dx / len, dy / len]; // head -> terminus, continues downhill beyond it

    return { terminus, fromM, dir };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fc, terrain, bounds]);

  const scene = useMemo(() => {
    if (!axis) return null;
    const historicalLonLat = axis.fromM([axis.dir[0] * retreatMeters, axis.dir[1] * retreatMeters]);
    const [tx, tz] = toXZ(...axis.terminus);
    const ty = toY(elevAt(...axis.terminus));
    const [hx, hz] = toXZ(...historicalLonLat);
    const hy = toY(elevAt(...historicalLonLat));
    return { current: [tx, ty, tz] as [number, number, number], historical: [hx, hy, hz] as [number, number, number] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [axis, retreatMeters, terrain, exaggeration, bounds]);

  if (!scene) return null;

  const lineGeom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(...scene.current),
    new THREE.Vector3(...scene.historical),
  ]);

  return (
    <group>
      <primitive object={new THREE.Line(lineGeom, new THREE.LineDashedMaterial({ color: '#38bdf8', dashSize: 0.05, gapSize: 0.03, transparent: true, opacity: 0.8 }))}
        onUpdate={(l: THREE.Line) => l.computeLineDistances()}
      />
      <group position={scene.historical}>
        <mesh position={[0, 0.05, 0]}>
          <coneGeometry args={[0.05, 0.18, 10]} />
          <meshStandardMaterial color="#38bdf8" emissive="#0369a1" emissiveIntensity={0.6} />
        </mesh>
      </group>
      <group position={scene.current}>
        <mesh>
          <sphereGeometry args={[0.035, 12, 12]} />
          <meshStandardMaterial color="#f8fafc" emissive="#38bdf8" emissiveIntensity={0.4} />
        </mesh>
      </group>
    </group>
  );
};

export default GlacierRetreatLayer;
