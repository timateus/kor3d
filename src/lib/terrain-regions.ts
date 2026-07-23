import type { GeoBounds } from './geotiff-loader';

export type RegionId = 'aral' | 'khorezm' | 'custom';

export interface RegionPreset {
  id: RegionId;
  label: string;
  bounds: GeoBounds;
}

// Bounds chosen to roughly match the existing GeoTIFFs (aral_region.tif & khorezm.tif)
export const REGION_PRESETS: Record<Exclude<RegionId, 'custom'>, RegionPreset> = {
  aral: {
    id: 'aral',
    label: 'Aral Sea',
    bounds: { minLon: 57.5, maxLon: 62.5, minLat: 43.0, maxLat: 47.5 },
  },
  khorezm: {
    id: 'khorezm',
    label: 'Khorezm',
    bounds: { minLon: 59.5, maxLon: 62.5, minLat: 40.8, maxLat: 43.0 },
  },
};

export const DEFAULT_CUSTOM_BOUNDS: GeoBounds = {
  minLon: 54, maxLon: 66, minLat: 40, maxLat: 47,
};

// Wide Central Asia bbox used as the play-area for game mode.
// Spans roughly Caspian -> Tian Shan, Aral -> Hindu Kush.
export const CENTRAL_ASIA_BOUNDS: GeoBounds = {
  minLon: 50, maxLon: 80, minLat: 35, maxLat: 50,
};

export function getRegionBounds(id: RegionId, custom: GeoBounds): GeoBounds {
  if (id === 'custom') return custom;
  return REGION_PRESETS[id].bounds;
}

export function validateBounds(b: GeoBounds): string | null {
  if (b.minLon >= b.maxLon || b.minLat >= b.maxLat) return 'Min must be less than max.';
  if (Math.abs(b.minLat) > 85 || Math.abs(b.maxLat) > 85) return 'Latitude out of range.';
  return null;
}
