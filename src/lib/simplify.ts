/**
 * Drops polyline vertices closer than `minStepDeg` (lon/lat degrees) to the
 * previously kept one. Basin-scale OSM data carries far more vertices than the
 * DEM can show (a ~10° wide map has ~100 m DEM pixels), and every vertex costs
 * a fat-line segment on the GPU. Endpoints are always kept.
 */
export function decimateCoords(coords: [number, number][], minStepDeg: number): [number, number][] {
  if (coords.length <= 2 || minStepDeg <= 0) return coords;
  const min2 = minStepDeg * minStepDeg;
  const out: [number, number][] = [coords[0]];
  let last = coords[0];
  for (let i = 1; i < coords.length - 1; i++) {
    const c = coords[i];
    const dx = c[0] - last[0];
    const dy = c[1] - last[1];
    if (dx * dx + dy * dy >= min2) { out.push(c); last = c; }
  }
  out.push(coords[coords.length - 1]);
  return out;
}

/** Decimation step for a terrain: ~1.5 DEM pixels. */
export function demStepDeg(bounds: { minLon: number; maxLon: number }, terrainWidth: number): number {
  return ((bounds.maxLon - bounds.minLon) / Math.max(1, terrainWidth)) * 1.5;
}
