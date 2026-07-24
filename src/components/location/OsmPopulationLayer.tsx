import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import type { GeoBounds, TerrainData } from '@/lib/geotiff-loader';
import { loadPopulationDensity, sampleGrid, type PopulationGrid } from '@/lib/population-density';

interface Props {
  terrain: TerrainData;
  exaggeration: number;
  /** URL of the per-location GHS-POP grid (public/data/locations/{slug}/population_density.json). */
  dataUrl: string;
  /** 0..1 overlay opacity */
  opacity?: number;
  /** 0..3 intensity multiplier */
  intensity?: number;
  /** Fires once the grid is loaded, so the parent can sample values (e.g. on click). */
  onLoad?: (grid: PopulationGrid | null) => void;
  /** Fires once loading settles (success or failure) — unlike onLoad, always fires. */
  onSettled?: () => void;
}

// Yellow → orange → red → violet color ramp (heatmap-friendly)
function heatColor(t: number): [number, number, number] {
  // t in 0..1
  const stops: [number, number, number, number][] = [
    [0.00, 1.00, 1.00, 0.60], // pale yellow
    [0.25, 1.00, 0.85, 0.20], // yellow
    [0.55, 1.00, 0.45, 0.10], // orange
    [0.80, 0.95, 0.10, 0.15], // red
    [1.00, 0.55, 0.05, 0.55], // violet-red
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, r0, g0, b0] = stops[i];
    const [t1, r1, g1, b1] = stops[i + 1];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0 || 1);
      return [r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f];
    }
  }
  const s = stops[stops.length - 1];
  return [s[1], s[2], s[3]];
}

/** Build an RGBA heatmap canvas by resampling the GHS-POP raster onto the terrain's UV grid. */
function buildHeatmap(
  grid: PopulationGrid,
  terrainBounds: GeoBounds,
  w: number,
  h: number,
  intensity: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const logMax = Math.log1p(grid.maxVal);
  if (logMax <= 0) return canvas;

  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const ny = 1 - y / (h - 1);
    const lat = terrainBounds.minLat + ny * (terrainBounds.maxLat - terrainBounds.minLat);
    for (let x = 0; x < w; x++) {
      const nx = x / (w - 1);
      const lon = terrainBounds.minLon + nx * (terrainBounds.maxLon - terrainBounds.minLon);
      const val = sampleGrid(grid, lon, lat) ?? 0;
      if (val <= 0) continue;
      const t = Math.min(1, (Math.log1p(val) / logMax) * intensity);
      if (t < 0.03) continue;
      const [r, g, b] = heatColor(t);
      const alpha = Math.pow(t, 0.6);
      const i = (y * w + x) * 4;
      img.data[i] = Math.round(r * 255);
      img.data[i + 1] = Math.round(g * 255);
      img.data[i + 2] = Math.round(b * 255);
      img.data[i + 3] = Math.round(alpha * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Draped population-density heatmap. Reuses the terrain surface geometry so
 * the color hugs the relief, colored from the real GHS-POP (JRC) raster
 * pre-sampled per location by scripts/prefetch/ghs-pop.mjs in the main app.
 */
const OsmPopulationLayer = ({ terrain, exaggeration, dataUrl, opacity = 0.75, intensity = 1, onLoad, onSettled }: Props) => {
  const [grid, setGrid] = useState<PopulationGrid | null>(null);

  useEffect(() => {
    let cancelled = false;
    setGrid(null);
    onLoad?.(null);
    loadPopulationDensity(dataUrl)
      .then((g) => { if (!cancelled) { setGrid(g); onLoad?.(g); } })
      .catch((e) => console.warn('GHS-POP load failed', e))
      .finally(() => { if (!cancelled) onSettled?.(); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataUrl]);

  const texture = useMemo(() => {
    if (!grid || !terrain.bounds) return null;
    // Canvas resolution scaled to terrain aspect
    const W = 512;
    const H = Math.round(512 * (terrain.height / terrain.width));
    const c = buildHeatmap(grid, terrain.bounds, W, H, intensity);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }, [grid, terrain, intensity]);

  const geometry = useMemo(() => {
    if (!terrain.bounds) return null;
    const { width: w, height: h, elevations, minElevation, maxElevation, noDataValue } = terrain;
    const elevRange = maxElevation - minElevation || 1;
    const maxHeight = 10 * (exaggeration / 100);
    const positions: number[] = [];
    const uvs: number[] = [];
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        let elev = elevations[j * w + i];
        const nd = isNaN(elev) || (noDataValue !== null && elev === noDataValue) || elev <= -9999;
        if (nd) elev = minElevation;
        const normalized = (elev - minElevation) / elevRange;
        const x = (i / (w - 1) - 0.5) * 10;
        const y = (0.5 - j / (h - 1)) * 10 * (h / w);
        const z = normalized * maxHeight + 0.008; // lift slightly to avoid z-fighting
        positions.push(x, y, z);
        uvs.push(i / (w - 1), 1 - j / (h - 1));
      }
    }
    const indices: number[] = [];
    for (let j = 0; j < h - 1; j++) {
      for (let i = 0; i < w - 1; i++) {
        const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }, [terrain, exaggeration]);

  if (!texture || !geometry) return null;

  return (
    <group rotation={[-Math.PI / 2, 0, 0]}>
      <mesh geometry={geometry}>
        <meshBasicMaterial
          map={texture}
          transparent
          opacity={opacity}
          depthWrite={false}
          side={THREE.DoubleSide}
          polygonOffset
          polygonOffsetFactor={-1}
          polygonOffsetUnits={-1}
        />
      </mesh>
    </group>
  );
};

export default OsmPopulationLayer;
