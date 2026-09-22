// Mirror of src/lib/locations.ts (kept in sync manually).
// Prefetch scripts read from here to avoid importing TS.
//
// `bounds` is the terrain footprint (used by ghs-pop.mjs, and for
// water.json/buildings.json in overpass.mjs). `waterBounds`, where
// present, is the wider area used for water_large.json and places.json.

export const LOCATIONS = [
  {
    slug: 'suaq',
    bounds: { minLat: 43.33403, maxLat: 43.36792, minLon: 79.03803, maxLon: 79.09781 },
    waterBounds: { minLat: 43.07, maxLat: 43.63, minLon: 78.67, maxLon: 79.47 },
  },
  {
    slug: 'almaty',
    bounds: { minLat: 43.220, maxLat: 43.256, minLon: 76.925, maxLon: 76.975 },
    waterBounds: { minLat: 42.96, maxLat: 43.52, minLon: 76.62, maxLon: 77.28 },
  },
  {
    slug: 'tuyuksu-glacier',
    bounds: { minLat: 43.0213, maxLat: 43.0753, minLon: 77.0436, maxLon: 77.1176 },
    waterBounds: { minLat: 42.8681, maxLat: 43.2285, minLon: 76.8342, maxLon: 77.3270 },
  },
  {
    slug: 'balqash',
    bounds: { minLat: 46.820, maxLat: 46.870, minLon: 74.960, maxLon: 75.030 },
    waterBounds: { minLat: 46.55, maxLat: 47.10, minLon: 74.55, maxLon: 75.40 },
  },
  {
    slug: 'balqash-lake',
    bounds: { minLat: 44.80, maxLat: 47.40, minLon: 72.80, maxLon: 79.20 },
    waterBounds: { minLat: 44.60, maxLat: 47.60, minLon: 72.40, maxLon: 79.60 },
  },
  {
    slug: 'alakol',
    bounds: { minLat: 44.50, maxLat: 46.55, minLon: 81.05, maxLon: 82.55 },
    waterBounds: { minLat: 44.30, maxLat: 46.75, minLon: 80.80, maxLon: 82.80 },
  },
  {
    slug: 'seliger',
    bounds: { minLat: 56.90, maxLat: 57.55, minLon: 32.60, maxLon: 33.55 },
    waterBounds: { minLat: 56.75, maxLat: 57.70, minLon: 32.35, maxLon: 33.80 },
  },
  {
    slug: 'aral-sea',
    bounds: { minLat: 40.80, maxLat: 47.50, minLon: 57.50, maxLon: 62.50 },
    waterBounds: { minLat: 40.60, maxLat: 47.70, minLon: 57.20, maxLon: 62.80 },
  },
  {
    slug: 'karkaralinsk',
    bounds: { minLat: 49.25, maxLat: 49.55, minLon: 75.20, maxLon: 75.70 },
    waterBounds: { minLat: 49.05, maxLat: 49.75, minLon: 74.95, maxLon: 75.95 },
  },
  {
    slug: 'barsakelmes',
    bounds: { minLat: 43.00, maxLat: 43.70, minLon: 56.80, maxLon: 58.55 },
    waterBounds: { minLat: 42.70, maxLat: 44.00, minLon: 56.45, maxLon: 58.90 },
  },
  {
    slug: 'garibaldi-squamish',
    bounds: { minLat: 49.62, maxLat: 49.98, minLon: -123.28, maxLon: -122.88 },
    waterBounds: { minLat: 49.50, maxLat: 50.10, minLon: -123.45, maxLon: -122.70 },
  },
  {
    slug: 'caspian-sea',
    bounds: { minLat: 36.00, maxLat: 47.60, minLon: 45.50, maxLon: 55.50 },
    waterBounds: { minLat: 35.50, maxLat: 48.00, minLon: 44.80, maxLon: 56.20 },
    // Sea-scale bbox spans 5 countries — unrestricted water/buildings queries
    // return 100+ MB (unfetchable/unrenderable). See fetchWater's `coarse` param.
    coarse: true,
  },
];
