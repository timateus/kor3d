import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { useThree } from '@react-three/fiber';
import type { GeoBounds, TerrainData } from '@/lib/geotiff-loader';
import { fetchOverpass } from '@/lib/overpass';

interface LineFeature {
  id: number | string;
  coords: [number, number][];
}

interface Props {
  terrain: TerrainData;
  exaggeration: number;
  bounds: GeoBounds;
  clipBounds?: GeoBounds;
  /** Only fetches/renders when true — used to make optional layers lazy. */
  enabled: boolean;
  /** Overpass query body, e.g. `way["highway"](${bbox});` — bbox is substituted by the caller. */
  buildQuery: (bbox: string) => string;
  /** Cache namespace so different layers/queries don't collide. */
  cacheKey: string;
  color: string;
  opacity?: number;
  lineWidth?: number;
}

function parseElements(data: any): LineFeature[] {
  const out: LineFeature[] = [];
  for (const el of data.elements || []) {
    if (el.type === 'way' && Array.isArray(el.geometry)) {
      out.push({ id: el.id, coords: el.geometry.map((g: any) => [g.lon, g.lat] as [number, number]) });
    } else if (el.type === 'relation' && Array.isArray(el.members)) {
      for (const m of el.members) {
        if (m.type === 'way' && Array.isArray(m.geometry)) {
          out.push({ id: `${el.id}/${m.ref}`, coords: m.geometry.map((g: any) => [g.lon, g.lat] as [number, number]) });
        }
      }
    }
  }
  return out;
}

/** Generic renderer for OSM line/boundary data, fetched live (and cached) only while `enabled`. */
const OsmLinesLayer = ({
  terrain, exaggeration, bounds, clipBounds, enabled, buildQuery, cacheKey,
  color, opacity = 0.6, lineWidth = 1.2,
}: Props) => {
  const [features, setFeatures] = useState<LineFeature[] | null>(null);
  const { size } = useThree();
  const clip = clipBounds ?? bounds;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const bbox = `${clip.minLat},${clip.minLon},${clip.maxLat},${clip.maxLon}`;
    const key = `${cacheKey}:${bbox}`;
    fetchOverpass<any>(buildQuery(bbox), key)
      .then((json) => { if (!cancelled) setFeatures(parseElements(json)); })
      .catch((e) => { console.warn(`${cacheKey} fetch failed`, e); if (!cancelled) setFeatures([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, clip.minLon, clip.minLat, clip.maxLon, clip.maxLat, cacheKey]);

  const group = useMemo(() => {
    if (!enabled || !features || features.length === 0) return null;
    const meshW = 10;
    const meshH = 10 * (terrain.height / terrain.width);
    const elevRange = terrain.maxElevation - terrain.minElevation || 1;
    const maxHeight = 10 * (exaggeration / 100);
    const lift = Math.max(0.01, maxHeight * 0.006);
    const lineColor = new THREE.Color(color);

    const sampleY = (nxT: number, nyT: number) => {
      if (nxT < 0 || nxT > 1 || nyT < 0 || nyT > 1) return lift;
      const cx = Math.max(0, Math.min(terrain.width - 1, Math.floor(nxT * (terrain.width - 1))));
      const cy = Math.max(0, Math.min(terrain.height - 1, Math.floor((1 - nyT) * (terrain.height - 1))));
      let e = terrain.elevations[cy * terrain.width + cx];
      if (!isFinite(e)) e = terrain.minElevation;
      return ((e - terrain.minElevation) / elevRange) * maxHeight + lift;
    };

    const g = new THREE.Group();
    const disposables: { geom: LineGeometry; mat: LineMaterial }[] = [];

    for (const f of features) {
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
        color: lineColor.getHex(),
        linewidth: lineWidth,
        transparent: true,
        opacity,
        depthTest: true,
        resolution: new THREE.Vector2(size.width, size.height),
      });
      const line = new Line2(geom, mat);
      line.renderOrder = 2;
      g.add(line);
      disposables.push({ geom, mat });
    }
    (g.userData as any).__disposables = disposables;
    return g;
  }, [enabled, features, terrain, exaggeration, bounds, color, opacity, lineWidth, size.width, size.height]);

  useEffect(() => () => {
    if (!group) return;
    const d = (group.userData as any).__disposables as { geom: LineGeometry; mat: LineMaterial }[] | undefined;
    if (d) for (const { geom, mat } of d) { geom.dispose(); mat.dispose(); }
  }, [group]);

  if (!group) return null;
  return <primitive object={group} />;
};

export default OsmLinesLayer;
