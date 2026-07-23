import { useMemo } from 'react';
import * as THREE from 'three';
import { TerrainData } from '@/lib/geotiff-loader';
import type { WaterFlowState } from '@/lib/water-flow-simulation';

interface WaterFlowOverlayProps {
  terrain: TerrainData;
  exaggeration: number;
  flowState: WaterFlowState;
  renderKey: number; // force re-render on step
}

const WaterFlowOverlay = ({ terrain, exaggeration, flowState, renderKey }: WaterFlowOverlayProps) => {
  const { width, height, elevations, minElevation, maxElevation } = terrain;
  const elevRange = maxElevation - minElevation || 1;
  const maxHeight = 10 * (exaggeration / 100);

  const geometry = useMemo(() => {
    const { waterDepth } = flowState;
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const vertexMap = new Map<number, number>();
    let vertIdx = 0;

    // Create vertices for all wet pixels
    for (let i = 0; i < waterDepth.length; i++) {
      if (waterDepth[i] < 0.01) continue;

      const row = Math.floor(i / width);
      const col = i % width;
      const elev = elevations[i];
      const waterSurface = elev + waterDepth[i];

      const x = (col / (width - 1) - 0.5) * 10;
      const y = (0.5 - row / (height - 1)) * 10 * (height / width);
      const normalizedSurface = (waterSurface - minElevation) / elevRange;
      const z = normalizedSurface * maxHeight + 0.02;

      positions.push(x, y, z);

      // Color based on depth
      const depth = waterDepth[i];
      const t = Math.min(1, depth / 10); // normalize to ~10m max
      colors.push(
        0.05 + (1 - t) * 0.25,
        0.15 + (1 - t) * 0.45,
        0.6 + (1 - t) * 0.3
      );

      vertexMap.set(i, vertIdx);
      vertIdx++;
    }

    if (vertIdx === 0) return null;

    // Build triangles
    for (const [idx, vi] of vertexMap) {
      const row = Math.floor(idx / width);
      const col = idx % width;
      const right = idx + 1;
      const below = idx + width;
      const belowRight = idx + width + 1;

      if (col < width - 1 && row < height - 1) {
        if (vertexMap.has(right) && vertexMap.has(below)) {
          indices.push(vi, vertexMap.get(right)!, vertexMap.get(below)!);
        }
        if (vertexMap.has(right) && vertexMap.has(belowRight) && vertexMap.has(below)) {
          indices.push(vertexMap.get(right)!, vertexMap.get(belowRight)!, vertexMap.get(below)!);
        }
      }
    }

    if (indices.length === 0) return null;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowState, renderKey, terrain, exaggeration]);

  const material = useMemo(() => {
    return new THREE.MeshStandardMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.7,
      side: THREE.DoubleSide,
      roughness: 0.15,
      metalness: 0.05,
    });
  }, []);

  if (!geometry) return null;

  return (
    <mesh geometry={geometry} material={material} rotation={[-Math.PI / 2, 0, 0]} />
  );
};

export default WaterFlowOverlay;
