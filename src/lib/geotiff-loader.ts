import { fromArrayBuffer } from 'geotiff';

export interface GeoBounds {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}

export interface TerrainData {
  width: number;
  height: number;
  elevations: Float32Array | Float64Array;
  minElevation: number;
  maxElevation: number;
  noDataValue: number | null;
  bounds: GeoBounds | null;
}


// Module-level cache so repeated calls (e.g., after a component remount or
// after toggling layers that rebuild the terrain pipeline) reuse the same
// parsed result instead of re-fetching + re-decoding the GeoTIFF.
const _terrainCache = new Map<string, Promise<TerrainData>>();

export async function loadGeoTiff(url: string): Promise<TerrainData> {
  const cached = _terrainCache.get(url);
  if (cached) return cached;
  const promise = _loadGeoTiffUncached(url).catch((err) => {
    _terrainCache.delete(url); // allow retry on failure
    throw err;
  });
  _terrainCache.set(url, promise);
  return promise;
}

async function _loadGeoTiffUncached(url: string): Promise<TerrainData> {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  const tiff = await fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage();

  const fullWidth = image.getWidth();
  const fullHeight = image.getHeight();

  // Downsample large images during read to avoid memory issues
  const maxDim = 512;
  const scaleX = Math.max(1, Math.ceil(fullWidth / maxDim));
  const scaleY = Math.max(1, Math.ceil(fullHeight / maxDim));
  const width = Math.floor(fullWidth / scaleX);
  const height = Math.floor(fullHeight / scaleY);

  const rasters = await image.readRasters({
    width,
    height,
    resampleMethod: 'nearest',
  });
  const elevations = rasters[0] as Float32Array | Float64Array;

  // Get nodata value
  const fileDirectory = image.getFileDirectory() as unknown as Record<string, unknown>;
  const noDataValue = fileDirectory.GDAL_NODATA
    ? parseFloat(String(fileDirectory.GDAL_NODATA))
    : null;

  let minElevation = Infinity;
  let maxElevation = -Infinity;

  for (let i = 0; i < elevations.length; i++) {
    const val = elevations[i];
    if (noDataValue !== null && val === noDataValue) continue;
    if (isNaN(val) || val <= -9999) continue;
    if (val < minElevation) minElevation = val;
    if (val > maxElevation) maxElevation = val;
  }

  // Extract geographic bounds
  let bounds: GeoBounds | null = null;

  // Try getBoundingBox first (works for most well-formed GeoTIFFs)
  try {
    const bbox = image.getBoundingBox();
    if (bbox && bbox.length === 4 && (bbox[2] - bbox[0]) > 0 && (bbox[3] - bbox[1]) > 0) {
      bounds = { minLon: bbox[0], minLat: bbox[1], maxLon: bbox[2], maxLat: bbox[3] };
    }
  } catch (_) { /* no affine transformation */ }

  // Try tiepoint + pixel scale
  if (!bounds) {
    try {
      const fd = fileDirectory as any;
      const tiepoint = fd.ModelTiepoint ?? fd.actualizedFields?.ModelTiepoint;
      const pixelScale = fd.ModelPixelScale ?? fd.actualizedFields?.ModelPixelScale;
      if (tiepoint && pixelScale && pixelScale[0] > 0 && pixelScale[1] > 0) {
        bounds = {
          minLon: tiepoint[3],
          maxLon: tiepoint[3] + fullWidth * pixelScale[0],
          maxLat: tiepoint[4],
          minLat: tiepoint[4] - fullHeight * pixelScale[1],
        };
      }
    } catch (_) {}
  }

  // Try GDAL metadata for bounds
  if (!bounds) {
    try {
      const gdalMeta = (image as any).getGDALMetadata?.();
      console.log('GDAL metadata:', gdalMeta);
    } catch (_) {}
  }

  // Try to read GeoTransform from GDAL_METADATA XML
  if (!bounds) {
    try {
      const fd = fileDirectory as any;
      const metaXml = fd.GDAL_METADATA ?? fd.actualizedFields?.GDAL_METADATA;
      if (metaXml && typeof metaXml === 'string') {
        console.log('GDAL_METADATA XML:', metaXml);
      }
    } catch (_) {}
  }

  // Try origin + resolution methods
  if (!bounds) {
    try {
      const origin = image.getOrigin();
      const resolution = image.getResolution();
      if (origin && resolution) {
        bounds = {
          minLon: origin[0],
          maxLon: origin[0] + fullWidth * Math.abs(resolution[0]),
          maxLat: origin[1],
          minLat: origin[1] - fullHeight * Math.abs(resolution[1]),
        };
      }
    } catch (_) {}
  }

  // Last resort: warn
  if (!bounds) {
    console.warn('No bounds found for', url);
  }

  console.log('Terrain loaded:', { width, height, minElevation, maxElevation, noDataValue, bounds });

  return { width, height, elevations, minElevation, maxElevation, noDataValue, bounds };
}

function hexToRgb01(hex: string): [number, number, number] {
  const h = hex.replace('#', '').trim();
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const r = parseInt(s.slice(0, 2), 16) / 255;
  const g = parseInt(s.slice(2, 4), 16) / 255;
  const b = parseInt(s.slice(4, 6), 16) / 255;
  return [isNaN(r) ? 0 : r, isNaN(g) ? 0 : g, isNaN(b) ? 0 : b];
}

// Designer-mode palette override pushed by visual-mode.ts. When present,
// terrain colors are derived from this scheme instead of the vintage atlas.
let _designerPalette: {
  water: [number, number, number];
  land: [number, number, number];
  vegetation: [number, number, number];
  alert: [number, number, number];
  background: [number, number, number];
  stops: [number, number, number][] | null;
} | null = null;

export function setDesignerPaletteOverride(p: {
  water: string; land: string; vegetation: string; alert: string; background: string;
  stops?: string[];
} | null) {
  _designerPalette = p ? {
    water: hexToRgb01(p.water),
    land: hexToRgb01(p.land),
    vegetation: hexToRgb01(p.vegetation),
    alert: hexToRgb01(p.alert),
    background: hexToRgb01(p.background),
    stops: p.stops && p.stops.length >= 2 ? p.stops.map(hexToRgb01) : null,
  } : null;
}

function rampFromStops(stops: [number, number, number][], t: number): [number, number, number] {
  const n = stops.length;
  if (n === 1) return stops[0];
  const clamped = Math.max(0, Math.min(1, t));
  const scaled = clamped * (n - 1);
  const i = Math.min(n - 2, Math.floor(scaled));
  const f = scaled - i;
  return lerpColor(stops[i], stops[i + 1], f);
}

function getDesignerElevationColor(elev: number): [number, number, number] {
  const p = _designerPalette!;
  // Multi-stop ramp wins when provided — wild/crazy palettes use this path.
  if (p.stops) {
    // Map elevation -12..300m -> 0..1 across all stops
    const t = (elev + 12) / 312;
    return rampFromStops(p.stops, t);
  }
  // Below sea: deep water -> shore mix
  if (elev < 0) {
    const t = Math.max(0, Math.min(1, (elev + 12) / 12));
    const deep: [number, number, number] = [p.water[0] * 0.6, p.water[1] * 0.6, p.water[2] * 0.6];
    return lerpColor(deep, p.water, t);
  }
  // Shore -> land
  if (elev < 30) {
    const t = elev / 30;
    return lerpColor(p.background, p.land, t);
  }
  // Land -> vegetation
  if (elev < 180) {
    const t = (elev - 30) / 150;
    return lerpColor(p.land, p.vegetation, t);
  }
  // Vegetation -> alert (peaks)
  const t = Math.min(1, (elev - 180) / 400);
  return lerpColor(p.vegetation, p.alert, t * 0.7);
}

export function getElevationColor(normalized: number, rawElevation?: number): [number, number, number] {
  const isDesigner = typeof document !== 'undefined' && document.documentElement.classList.contains('designer');
  const isMirage = typeof document !== 'undefined' && document.documentElement.classList.contains('mirage');
  const elev = rawElevation !== undefined ? rawElevation : normalized * 300;
  if (isDesigner && _designerPalette) return getDesignerElevationColor(elev);
  const c = getElevationColorAbsolute(elev);
  if (!isMirage) return c;
  // Mirage: vintage atlas — keep elevation hue, soften toward warm paper.
  if (elev < 0) {
    const t = Math.max(0, Math.min(1, (elev + 12) / 12));
    return [0.42 + t * 0.20, 0.62 + t * 0.12, 0.66 + t * 0.08];
  }
  const paper: [number, number, number] = [0.95, 0.92, 0.84];
  const k = 0.25;
  const mix: [number, number, number] = [
    c[0] * (1 - k) + paper[0] * k,
    c[1] * (1 - k) + paper[1] * k,
    c[2] * (1 - k) + paper[2] * k,
  ];
  const m = (mix[0] + mix[1] + mix[2]) / 3;
  const sat = 1.15;
  return [
    Math.max(0, Math.min(1, m + (mix[0] - m) * sat)),
    Math.max(0, Math.min(1, m + (mix[1] - m) * sat)),
    Math.max(0, Math.min(1, m + (mix[2] - m) * sat)),
  ];
}

function getElevationColorAbsolute(elev: number): [number, number, number] {
  // Rich color detail from -12m to 300m; compressed above 300m
  if (elev < -6) {
    // Deep below sea level – grey-green (exposed seabed)
    const t = Math.max(0, Math.min(1, (elev + 12) / 6));
    return lerpColor([0.68, 0.67, 0.6], [0.72, 0.7, 0.58], t);
  } else if (elev < 0) {
    // Shallow below sea level – pale green-tan (salt crusts)
    const t = (elev + 6) / 6;
    return lerpColor([0.72, 0.7, 0.58], [0.78, 0.74, 0.52], t);
  } else if (elev < 20) {
    // Lowest plains – pale cream-yellow
    const t = elev / 20;
    return lerpColor([0.78, 0.74, 0.52], [0.85, 0.8, 0.5], t);
  } else if (elev < 50) {
    // Low plains – warm straw yellow
    const t = (elev - 20) / 30;
    return lerpColor([0.85, 0.8, 0.5], [0.88, 0.78, 0.42], t);
  } else if (elev < 80) {
    // Low-mid – golden yellow
    const t = (elev - 50) / 30;
    return lerpColor([0.88, 0.78, 0.42], [0.84, 0.72, 0.36], t);
  } else if (elev < 120) {
    // Mid-low – warm ochre
    const t = (elev - 80) / 40;
    return lerpColor([0.84, 0.72, 0.36], [0.78, 0.62, 0.32], t);
  } else if (elev < 160) {
    // Mid – amber-brown
    const t = (elev - 120) / 40;
    return lerpColor([0.78, 0.62, 0.32], [0.72, 0.55, 0.28], t);
  } else if (elev < 200) {
    // Upper-mid – rich brown
    const t = (elev - 160) / 40;
    return lerpColor([0.72, 0.55, 0.28], [0.65, 0.48, 0.28], t);
  } else if (elev < 250) {
    // Transition – warm sienna
    const t = (elev - 200) / 50;
    return lerpColor([0.65, 0.48, 0.28], [0.6, 0.44, 0.3], t);
  } else if (elev < 300) {
    // Upper transition – dusty brown
    const t = (elev - 250) / 50;
    return lerpColor([0.6, 0.44, 0.3], [0.56, 0.42, 0.32], t);
  } else if (elev < 1000) {
    // Mountains – compressed brown to grey
    const t = (elev - 300) / 700;
    return lerpColor([0.56, 0.42, 0.32], [0.55, 0.52, 0.5], t);
  } else if (elev < 3000) {
    // High mountains – slate
    const t = (elev - 1000) / 2000;
    return lerpColor([0.55, 0.52, 0.5], [0.65, 0.63, 0.65], t);
  } else {
    // Peaks – snow
    const t = Math.min(1, (elev - 3000) / 2000);
    return lerpColor([0.65, 0.63, 0.65], [0.95, 0.95, 0.97], t);
  }
}

function lerpColor(
  a: [number, number, number],
  b: [number, number, number],
  t: number
): [number, number, number] {
  const ct = Math.max(0, Math.min(1, t));
  return [
    a[0] + (b[0] - a[0]) * ct,
    a[1] + (b[1] - a[1]) * ct,
    a[2] + (b[2] - a[2]) * ct,
  ];
}
