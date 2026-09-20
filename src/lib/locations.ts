import type { GeoBounds } from './geotiff-loader';

/**
 * Location registry. To add a new location, append an entry here and it will
 * automatically be available at `/{slug}` (see `src/pages/LocationPage.tsx`
 * and the route in `src/App.tsx`).
 */
export interface LocationDef {
  slug: string;
  label: string;
  center: { lat: number; lon: number };
  /** Bounding box for terrain, satellite, and vector layers. */
  bounds: GeoBounds;
  /** Larger bounding box for water features (rendered beyond terrain edges). */
  waterBounds?: GeoBounds;
  /** Optional default vertical exaggeration (1–30). */
  exaggeration?: number;
  /** Has glacier_outline.json (GLIMS) + mass_balance.json (WGMS FoG) in its data folder. */
  hasGlacierData?: boolean;
  /** Has ice_thickness.json/.bin (Farinotti et al. 2019 consensus estimate) in its data folder. */
  hasIceThickness?: boolean;
  /** Has water_accounting.json — real (not HydroSHEDS-modeled) irrigation
   * canal design capacities and NIC ICWC reservoir/withdrawal figures. */
  hasCanalData?: boolean;
  /** Optional per-location basemap image adjustment defaults (see LocationPage's Image panel). */
  imageDefaults?: {
    brightness?: number;
    contrast?: number;
    saturation?: number;
    gamma?: number;
    tint?: string;
    tintStrength?: number;
  };
}

/**
 * Build a square-ish bounding box of roughly `sizeKm` on a side around a
 * lon/lat center. Compensates for latitude on the longitude axis.
 */
export function bboxAround(lat: number, lon: number, sizeKm: number): GeoBounds {
  const latDelta = sizeKm / 111; // ~111 km per degree of latitude
  const lonDelta = sizeKm / (111 * Math.cos((lat * Math.PI) / 180));
  return {
    minLat: lat - latDelta / 2,
    maxLat: lat + latDelta / 2,
    minLon: lon - lonDelta / 2,
    maxLon: lon + lonDelta / 2,
  };
}

export const LOCATIONS: LocationDef[] = [
  {
    slug: 'suaq',
    label: 'Suaq',
    center: { lat: (43.33403 + 43.36792) / 2, lon: (79.03803 + 79.09781) / 2 },
    bounds: {
      minLat: 43.33403,
      maxLat: 43.36792,
      minLon: 79.03803,
      maxLon: 79.09781,
    },
    waterBounds: {
      minLat: 43.07, maxLat: 43.63,
      minLon: 78.67, maxLon: 79.47,
    },
    exaggeration: 30,
  },
  {
    slug: 'almaty',
    label: 'Almaty',
    center: { lat: (43.220 + 43.256) / 2, lon: (76.925 + 76.975) / 2 },
    bounds: {
      minLat: 43.220,
      maxLat: 43.256,
      minLon: 76.925,
      maxLon: 76.975,
    },
    waterBounds: {
      minLat: 42.96, maxLat: 43.52,
      minLon: 76.62, maxLon: 77.28,
    },
    exaggeration: 30,
  },
  {
    // Тұйықсу (Tuyuksu) Glacier — one of the world's most-studied glaciers,
    // in the Trans-Ili Alatau just south of Almaty.
    slug: 'tuyuksu-glacier',
    label: 'Tuyuksu Glacier',
    center: { lat: 43.0483, lon: 77.0806 },
    bounds: {
      minLat: 43.0213, maxLat: 43.0753,
      minLon: 77.0436, maxLon: 77.1176,
    },
    waterBounds: {
      minLat: 42.8681, maxLat: 43.2285,
      minLon: 76.8342, maxLon: 77.3270,
    },
    exaggeration: 30,
    hasGlacierData: true,
    hasIceThickness: true,
    imageDefaults: {
      brightness: 1.55,
      contrast: 0.75,
      saturation: 0.40,
      gamma: 0.35,
      tint: '#ffffff',
      tintStrength: 0,
    },
  },
  {
    // Lake Balqash — shoreline at Balkhash city on the north shore.
    slug: 'balqash',
    label: 'Balqash',
    center: { lat: 46.845, lon: 74.994 },
    bounds: {
      minLat: 46.820,
      maxLat: 46.870,
      minLon: 74.960,
      maxLon: 75.030,
    },
    waterBounds: {
      minLat: 46.55, maxLat: 47.10,
      minLon: 74.55, maxLon: 75.40,
    },
    exaggeration: 30,
  },
  {
    // Entire Lake Balqash and surroundings (~600 km east-west).
    slug: 'balqash-lake',
    label: 'Lake Balqash',
    center: { lat: 46.20, lon: 75.60 },
    bounds: {
      minLat: 44.80, maxLat: 47.40,
      minLon: 72.80, maxLon: 79.20,
    },
    waterBounds: {
      minLat: 44.60, maxLat: 47.60,
      minLon: 72.40, maxLon: 79.60,
    },
    exaggeration: 30,
  },
  {
    // Lake Alakol plus the Dzungarian (Jungar) Alatau range to its south
    // (NE Kazakhstan, near Chinese border).
    slug: 'alakol',
    label: 'Lake Alakol',
    center: { lat: 45.525, lon: 81.75 },
    bounds: {
      minLat: 44.50, maxLat: 46.55,
      minLon: 81.05, maxLon: 82.55,
    },
    waterBounds: {
      minLat: 44.30, maxLat: 46.75,
      minLon: 80.80, maxLon: 82.80,
    },
    exaggeration: 30,
  },
  {
    // Lake Seliger — glacial lake in Tver Oblast, Russia.
    slug: 'seliger',
    label: 'Lake Seliger',
    center: { lat: 57.22, lon: 33.05 },
    bounds: {
      minLat: 56.90, maxLat: 57.55,
      minLon: 32.60, maxLon: 33.55,
    },
    waterBounds: {
      minLat: 56.75, maxLat: 57.70,
      minLon: 32.35, maxLon: 33.80,
    },
    exaggeration: 16,
    imageDefaults: {
      brightness: 5.1,
      contrast: 0.75,
      saturation: 0.65,
      gamma: 0.85,
      tintStrength: 0.14,
    },
  },
  {
    // Aral Sea and its dried-up basin (Uzbekistan/Kazakhstan).
    slug: 'aral-sea',
    label: 'Aral Sea',
    center: { lat: 45.25, lon: 60.00 },
    bounds: {
      minLat: 40.80, maxLat: 47.50,
      minLon: 57.50, maxLon: 62.50,
    },
    waterBounds: {
      minLat: 40.60, maxLat: 47.70,
      minLon: 57.20, maxLon: 62.80,
    },
    exaggeration: 30,
    hasCanalData: true,
  },
  {
    // Barsakelmes solonchak — a ~70×40 km salt-marsh depression in
    // Karakalpakstan (Uzbekistan) at the foot of the Ustyurt Plateau, the
    // former bed of the prehistoric Tethys Sea. Not to be confused with the
    // separate Barsakelmes island/nature reserve on the Kazakh side of the
    // Aral Sea (~46°14'N 59°41'E) — this is the Karakalpak one, centered
    // near the viewpoint at 43.34467, 58.04557.
    slug: 'barsakelmes',
    label: 'Barsakelmes',
    center: { lat: 43.35, lon: 58.05 },
    bounds: {
      minLat: 43.00, maxLat: 43.70,
      minLon: 57.55, maxLon: 58.55,
    },
    waterBounds: {
      minLat: 42.70, maxLat: 44.00,
      minLon: 57.20, maxLon: 58.90,
    },
    exaggeration: 30,
  },
  {
    // Garibaldi Provincial Park & Squamish — Coast Mountains, BC, Canada.
    // Spans Howe Sound / Squamish estuary up through the Chief, Garibaldi
    // Lake, and Black Tusk.
    slug: 'garibaldi-squamish',
    label: 'Garibaldi-Squamish',
    center: { lat: 49.80, lon: -123.08 },
    bounds: {
      minLat: 49.62, maxLat: 49.98,
      minLon: -123.28, maxLon: -122.88,
    },
    waterBounds: {
      minLat: 49.50, maxLat: 50.10,
      minLon: -123.45, maxLon: -122.70,
    },
    exaggeration: 30,
  },
  {
    // Northern Caspian Sea near the Kazakh coast (Mangystau / Atyrau region).
    // The full Caspian spans ~1200 km N-S and is impractical for a single
    // bounded terrain tile like the other locations here.
    // Full Caspian Sea, with a generous coastal margin on all sides.
    slug: 'caspian-sea',
    label: 'Caspian Sea',
    center: { lat: 41.80, lon: 50.50 },
    bounds: {
      minLat: 36.00, maxLat: 47.60,
      minLon: 45.50, maxLon: 55.50,
    },
    waterBounds: {
      minLat: 35.50, maxLat: 48.00,
      minLon: 44.80, maxLon: 56.20,
    },
    exaggeration: 30,
  },
];


export function findLocation(slug: string): LocationDef | undefined {
  return LOCATIONS.find((l) => l.slug === slug);
}
