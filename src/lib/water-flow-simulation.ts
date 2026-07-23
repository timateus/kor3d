import { TerrainData } from '@/lib/geotiff-loader';

export interface WaterFlowState {
  waterDepth: Float32Array;  // water depth per pixel
  width: number;
  height: number;
  terrain: TerrainData;
  stepCount: number;
  totalWaterVolume: number;  // track total water added
}

/**
 * Initialize a water flow simulation state for the given terrain.
 */
export function createFlowState(terrain: TerrainData): WaterFlowState {
  const { width, height } = terrain;
  return {
    waterDepth: new Float32Array(width * height),
    width,
    height,
    terrain,
    stepCount: 0,
    totalWaterVolume: 0,
  };
}

/**
 * Add water at a click point and nearby pixels (radius in pixels).
 */
export function addWaterAt(
  state: WaterFlowState,
  row: number,
  col: number,
  amount: number = 5.0,
  radius: number = 3
): void {
  const { width, height, waterDepth } = state;
  for (let dr = -radius; dr <= radius; dr++) {
    for (let dc = -radius; dc <= radius; dc++) {
      const r = row + dr;
      const c = col + dc;
      if (r < 0 || r >= height || c < 0 || c >= width) continue;
      const dist = Math.sqrt(dr * dr + dc * dc);
      if (dist > radius) continue;
      const falloff = 1 - dist / (radius + 1);
      const idx = r * width + c;
      waterDepth[idx] += amount * falloff;
      state.totalWaterVolume += amount * falloff;
    }
  }
}

/**
 * Run one simulation step: water flows to lower-elevation neighbors.
 * Uses a simple pipe model where water flows proportional to elevation difference.
 */
export function stepFlow(state: WaterFlowState): boolean {
  const { waterDepth, width, height, terrain } = state;
  const { elevations, noDataValue } = terrain;
  const outflow = new Float32Array(width * height);
  const inflow = new Float32Array(width * height);

  const flowRate = 0.68; // fraction of excess that flows per step
  let anyFlow = false;

  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const idx = r * width + c;
      const water = waterDepth[idx];
      if (water < 0.001) continue;

      const elev = elevations[idx];
      if (isNaN(elev) || (noDataValue !== null && elev === noDataValue) || elev <= -9999) continue;

      const surfaceLevel = elev + water;

      // Check 4 neighbors
      const neighbors: number[] = [];
      const diffs: number[] = [];
      let totalDiff = 0;

      const dirs = [
        r > 0 ? (r - 1) * width + c : -1,
        r < height - 1 ? (r + 1) * width + c : -1,
        c > 0 ? r * width + (c - 1) : -1,
        c < width - 1 ? r * width + (c + 1) : -1,
      ];

      for (const nIdx of dirs) {
        if (nIdx < 0) continue;
        const nElev = elevations[nIdx];
        if (isNaN(nElev) || (noDataValue !== null && nElev === noDataValue) || nElev <= -9999) continue;
        const nSurface = nElev + waterDepth[nIdx];
        const diff = surfaceLevel - nSurface;
        if (diff > 0.001) {
          neighbors.push(nIdx);
          diffs.push(diff);
          totalDiff += diff;
        }
      }

      if (totalDiff <= 0) continue;

      // Distribute water proportionally to elevation difference
      const maxOut = water * flowRate;
      for (let i = 0; i < neighbors.length; i++) {
        const share = (diffs[i] / totalDiff) * maxOut;
        outflow[idx] += share;
        inflow[neighbors[i]] += share;
        anyFlow = true;
      }
    }
  }

  // Apply flows
  if (anyFlow) {
    for (let i = 0; i < waterDepth.length; i++) {
      waterDepth[i] = Math.max(0, waterDepth[i] - outflow[i] + inflow[i]);
    }
    state.stepCount++;
  }

  return anyFlow;
}

/**
 * Get the set of pixel indices that have significant water (for rendering).
 */
export function getWetPixels(state: WaterFlowState, threshold: number = 0.01): Map<number, number> {
  const wet = new Map<number, number>(); // idx -> depth
  for (let i = 0; i < state.waterDepth.length; i++) {
    if (state.waterDepth[i] > threshold) {
      wet.set(i, state.waterDepth[i]);
    }
  }
  return wet;
}
