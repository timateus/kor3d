import type { GeoBounds, TerrainData } from './geotiff-loader';

export type Vec3 = [number, number, number];

/**
 * lon/lat → scene position on the terrain mesh (10 units wide, north = −z),
 * matching MapboxTerrainMesh and the OSM label layers. Points outside the
 * bounds are clamped to the edge.
 */
export function terrainProjector(terrain: TerrainData, bounds: GeoBounds, exaggeration: number) {
  const meshW = 10;
  const meshH = 10 * (terrain.height / terrain.width);
  const elevRange = terrain.maxElevation - terrain.minElevation || 1;
  const maxH = 10 * (exaggeration / 100);
  return (lon: number, lat: number): Vec3 => {
    const nx = Math.min(1, Math.max(0, (lon - bounds.minLon) / (bounds.maxLon - bounds.minLon)));
    const ny = Math.min(1, Math.max(0, (lat - bounds.minLat) / (bounds.maxLat - bounds.minLat)));
    const px = Math.floor(nx * (terrain.width - 1));
    const py = Math.floor((1 - ny) * (terrain.height - 1));
    const e = terrain.elevations[py * terrain.width + px] ?? terrain.minElevation;
    return [(nx - 0.5) * meshW, ((e - terrain.minElevation) / elevRange) * maxH, -((ny - 0.5) * meshH)];
  };
}

export const insideBounds = (b: GeoBounds, lon: number, lat: number) =>
  lon >= b.minLon && lon <= b.maxLon && lat >= b.minLat && lat <= b.maxLat;

/** A line laid on the surface, densified so it follows the relief between vertices. */
export function drapeLine(project: (lon: number, lat: number) => Vec3, coords: [number, number][], clearance: number, stepDeg = 0.0002): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < coords.length; i++) {
    const [lon, lat] = coords[i];
    if (i > 0) {
      const [plon, plat] = coords[i - 1];
      const n = Math.max(1, Math.ceil(Math.hypot(lon - plon, lat - plat) / stepDeg));
      for (let k = 1; k < n; k++) {
        const t = k / n;
        const p = project(plon + (lon - plon) * t, plat + (lat - plat) * t);
        out.push([p[0], p[1] + clearance, p[2]]);
      }
    }
    const p = project(lon, lat);
    out.push([p[0], p[1] + clearance, p[2]]);
  }
  return out;
}

/**
 * A cable between consecutive supports (stations, pylons): straight from
 * support to support, but never below the terrain plus clearance.
 */
export function cableLine(project: (lon: number, lat: number) => Vec3, supports: [number, number][], clearance: number, samplesPerSpan = 24): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 1; i < supports.length; i++) {
    const [a, b] = [supports[i - 1], supports[i]];
    const pa = project(a[0], a[1]), pb = project(b[0], b[1]);
    for (let k = i === 1 ? 0 : 1; k <= samplesPerSpan; k++) {
      const t = k / samplesPerSpan;
      const g = project(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
      out.push([g[0], Math.max(pa[1] + (pb[1] - pa[1]) * t + clearance, g[1] + clearance), g[2]]);
    }
  }
  return out;
}
