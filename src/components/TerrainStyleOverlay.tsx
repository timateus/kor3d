import { useMemo } from 'react';
import * as THREE from 'three';
import { TerrainData, GeoBounds } from '@/lib/geotiff-loader';
import { useVisualMode, useDesignerScheme } from '@/lib/visual-mode';

export type TerrainStyle = 'none' | 'contours' | 'vectors' | 'mesh';

interface Props {
  terrain: TerrainData;
  exaggeration: number;
  style: TerrainStyle;
  /** Spacing in meters between contour lines */
  contourInterval?: number;
  /** Spacing in meters between sampled vectors (controls density) */
  vectorInterval?: number;
  /** Spacing in meters between mesh-grid lines */
  meshInterval?: number;
  /** Bounds — required for accurate meters→pixels for vector/mesh spacing */
  bounds?: GeoBounds;
}

const TerrainStyleOverlay = ({
  terrain,
  exaggeration,
  style,
  contourInterval = 25,
  vectorInterval = 50,
  meshInterval = 100,
  bounds,
}: Props) => {
  // meters per pixel from bounds (fallback ~250)
  const metersPerPixel = useMemo(() => {
    if (!bounds) return 250;
    const latMid = (bounds.minLat + bounds.maxLat) / 2;
    const widthMeters = (bounds.maxLon - bounds.minLon) * 111000 * Math.cos((latMid * Math.PI) / 180);
    return Math.max(0.5, widthMeters / terrain.width);
  }, [bounds, terrain.width]);

  const meshToWorld = (i: number, j: number, normalized: number, w: number, h: number, maxHeight: number) => {
    const mx = (i / (w - 1) - 0.5) * 10;
    const my = (0.5 - j / (h - 1)) * 10 * (h / w);
    const mz = normalized * maxHeight;
    return [mx, mz, -my] as const;
  };

  const contourGeometry = useMemo(() => {
    if (style !== 'contours') return null;
    const { width: w, height: h, elevations, minElevation, maxElevation, noDataValue } = terrain;
    const elevRange = maxElevation - minElevation || 1;
    const maxHeight = 10 * (exaggeration / 100);
    const isND = (v: number) => isNaN(v) || (noDataValue !== null && v === noDataValue) || v <= -9999;

    const positions: number[] = [];
    const lift = 0.012;

    // Iso levels at fixed meter intervals
    const levels: number[] = [];
    const start = Math.ceil(minElevation / contourInterval) * contourInterval;
    for (let lv = start; lv <= maxElevation; lv += contourInterval) {
      levels.push(lv);
      if (levels.length > 400) break; // safety cap
    }

    const interpolate = (i1: number, j1: number, e1: number, i2: number, j2: number, e2: number, level: number) => {
      const t = (level - e1) / (e2 - e1);
      const i = i1 + (i2 - i1) * t;
      const j = j1 + (j2 - j1) * t;
      const norm = (level - minElevation) / elevRange;
      return meshToWorld(i, j, norm, w, h, maxHeight);
    };

    for (let j = 0; j < h - 1; j++) {
      for (let i = 0; i < w - 1; i++) {
        const aE = elevations[j * w + i];
        const bE = elevations[j * w + i + 1];
        const cE = elevations[(j + 1) * w + i];
        const dE = elevations[(j + 1) * w + i + 1];
        if (isND(aE) || isND(bE) || isND(cE) || isND(dE)) continue;

        for (const level of levels) {
          const a = aE >= level;
          const b = bE >= level;
          const c = cE >= level;
          const d = dE >= level;
          const code = (a ? 1 : 0) | (b ? 2 : 0) | (d ? 4 : 0) | (c ? 8 : 0);
          if (code === 0 || code === 15) continue;

          const crossings: (readonly [number, number, number])[] = [];
          if (a !== b) crossings.push(interpolate(i, j, aE, i + 1, j, bE, level));
          if (b !== d) crossings.push(interpolate(i + 1, j, bE, i + 1, j + 1, dE, level));
          if (c !== d) crossings.push(interpolate(i, j + 1, cE, i + 1, j + 1, dE, level));
          if (a !== c) crossings.push(interpolate(i, j, aE, i, j + 1, cE, level));

          if (crossings.length === 2) {
            positions.push(crossings[0][0], crossings[0][1] + lift, crossings[0][2]);
            positions.push(crossings[1][0], crossings[1][1] + lift, crossings[1][2]);
          } else if (crossings.length === 4) {
            positions.push(crossings[0][0], crossings[0][1] + lift, crossings[0][2]);
            positions.push(crossings[1][0], crossings[1][1] + lift, crossings[1][2]);
            positions.push(crossings[2][0], crossings[2][1] + lift, crossings[2][2]);
            positions.push(crossings[3][0], crossings[3][1] + lift, crossings[3][2]);
          }
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return geo;
  }, [terrain, exaggeration, style, contourInterval]);

  const vectorGeometry = useMemo(() => {
    if (style !== 'vectors') return null;
    const { width: w, height: h, elevations, minElevation, maxElevation, noDataValue } = terrain;
    const elevRange = maxElevation - minElevation || 1;
    const maxHeight = 10 * (exaggeration / 100);
    const isND = (v: number) => isNaN(v) || (noDataValue !== null && v === noDataValue) || v <= -9999;

    const positions: number[] = [];
    const lift = 0.15;
    const arrowScale = 1.2;

    // Convert spacing (meters) → grid step (pixels) using true metersPerPixel from bounds.
    let step = Math.max(1, Math.round(vectorInterval / metersPerPixel));
    if (step > Math.min(w, h) / 3) step = Math.max(1, Math.floor(Math.min(w, h) / 6));

    let maxGrad = 0;
    const samples: { i: number; j: number; dx: number; dy: number; mag: number }[] = [];
    for (let j = step; j < h - step; j += step) {
      for (let i = step; i < w - step; i += step) {
        const cE = elevations[j * w + i];
        if (isND(cE)) continue;
        const eL = elevations[j * w + (i - 1)];
        const eR = elevations[j * w + (i + 1)];
        const eU = elevations[(j - 1) * w + i];
        const eD = elevations[(j + 1) * w + i];
        if (isND(eL) || isND(eR) || isND(eU) || isND(eD)) continue;
        const dx = (eR - eL) / 2;
        const dy = (eD - eU) / 2;
        const mag = Math.hypot(dx, dy);
        if (mag > maxGrad) maxGrad = mag;
        samples.push({ i, j, dx, dy, mag });
      }
    }
    if (maxGrad === 0) maxGrad = 1;

    for (const s of samples) {
      if (s.mag === 0) continue;
      const cE = elevations[s.j * w + s.i];
      const norm = (cE - minElevation) / elevRange;
      const [x0, y0, z0] = meshToWorld(s.i, s.j, norm, w, h, maxHeight);
      const len = Math.max(0.05, (s.mag / maxGrad)) * arrowScale;
      const ux = s.dx / s.mag;
      const uy = s.dy / s.mag;
      const wx = ux;
      const wz = uy;
      const x1 = x0 + wx * len;
      const z1 = z0 + wz * len;
      const y1 = y0 + len * 0.2;

      positions.push(x0, y0 + lift, z0);
      positions.push(x1, y1 + lift, z1);

      const headLen = len * 0.4;
      const angle = Math.atan2(wz, wx);
      const a1 = angle + Math.PI - 0.5;
      const a2 = angle + Math.PI + 0.5;
      positions.push(x1, y1 + lift, z1);
      positions.push(x1 + Math.cos(a1) * headLen, y1 + lift, z1 + Math.sin(a1) * headLen);
      positions.push(x1, y1 + lift, z1);
      positions.push(x1 + Math.cos(a2) * headLen, y1 + lift, z1 + Math.sin(a2) * headLen);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return geo;
  }, [terrain, exaggeration, style, vectorInterval, metersPerPixel]);

  const meshGridGeometry = useMemo(() => {
    if (style !== 'mesh') return null;
    const { width: w, height: h, elevations, minElevation, maxElevation, noDataValue } = terrain;
    const elevRange = maxElevation - minElevation || 1;
    const maxHeight = 10 * (exaggeration / 100);
    const isND = (v: number) => isNaN(v) || (noDataValue !== null && v === noDataValue) || v <= -9999;
    let step = Math.max(1, Math.round(meshInterval / metersPerPixel));
    if (step > Math.min(w, h) / 3) step = Math.max(1, Math.floor(Math.min(w, h) / 6));
    const positions: number[] = [];
    const lift = 0.008;
    const pt = (i: number, j: number) => {
      const e = elevations[j * w + i];
      const norm = isND(e) ? 0 : (e - minElevation) / elevRange;
      const [x, y, z] = meshToWorld(i, j, norm, w, h, maxHeight);
      return [x, y + lift, z] as const;
    };
    // Horizontal rows
    for (let j = 0; j < h; j += step) {
      for (let i = 0; i < w - step; i += step) {
        const a = pt(i, j), b = pt(Math.min(w - 1, i + step), j);
        positions.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      }
    }
    // Vertical cols
    for (let i = 0; i < w; i += step) {
      for (let j = 0; j < h - step; j += step) {
        const a = pt(i, j), b = pt(i, Math.min(h - 1, j + step));
        positions.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return geo;
  }, [terrain, exaggeration, style, meshInterval, metersPerPixel]);

  const [visualMode] = useVisualMode();
  const [scheme] = useDesignerScheme();
  const designerActive = visualMode === 'designer';
  const stops = scheme.terrainStops;
  const contourColor = designerActive ? (stops?.[stops.length - 1] ?? scheme.alert) : '#1a1a1a';
  const vectorColor  = designerActive ? scheme.alert : '#ff2d92';

  if (style === 'contours' && contourGeometry) {
    return (
      <lineSegments geometry={contourGeometry} renderOrder={5}>
        <lineBasicMaterial color={contourColor} transparent opacity={0.7} depthTest={false} />
      </lineSegments>
    );
  }

  if (style === 'vectors' && vectorGeometry) {
    return (
      <lineSegments geometry={vectorGeometry} renderOrder={999} frustumCulled={false}>
        <lineBasicMaterial color={vectorColor} transparent={false} depthTest={false} depthWrite={false} toneMapped={false} />
      </lineSegments>
    );
  }

  if (style === 'mesh' && meshGridGeometry) {
    return (
      <lineSegments geometry={meshGridGeometry} renderOrder={4}>
        <lineBasicMaterial color="#111" transparent opacity={0.5} depthTest={false} />
      </lineSegments>
    );
  }

  return null;
};

export default TerrainStyleOverlay;
