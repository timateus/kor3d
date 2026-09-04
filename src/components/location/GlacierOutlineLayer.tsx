import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { useThree } from '@react-three/fiber';
import type { GeoBounds, TerrainData } from '@/lib/geotiff-loader';

/**
 * Renders glacier outlines (RGI 6.0 / GLIMS, queried by bbox from GLIMS's own
 * geoserver — see scripts note in LocationPage) as translucent ice sheets
 * draped over the terrain — a single point-in-time snapshot, not a
 * pipeline-baked layer like the other overlays (see GlacierChartPanel for the
 * companion WGMS mass-balance time series). Unlike ResourcesLayer's flat
 * fill-at-centroid shortcut, this samples elevation per vertex: a glacier
 * sits on a steep slope, so a single flat plane sinks below terrain uphill
 * and floats above it downhill, hiding most of the shape and breaking clicks.
 *
 * Optionally tints the fill by ice thickness (Farinotti et al. 2019 consensus
 * estimate, reprojected to a lon/lat grid — see thicknessUrl) instead of a
 * flat color, for whichever glacier(s) that grid actually covers — others
 * fall back to the flat color rather than reading as "zero ice". Reports
 * total ice volume for the covered glacier once loaded.
 */

export interface GlacierFeatureProps {
  rgi_id?: string;
  glims_id?: string;
  name?: string | null;
  area_km2?: number;
  zmin?: number;
  zmax?: number;
  zmed?: number;
  slope_deg?: number;
}

export interface ThicknessInfo {
  maxThicknessM: number;
  volumeM3: number;
  source: string;
}

interface ThicknessGrid {
  width: number;
  height: number;
  minLon: number; minLat: number; maxLon: number; maxLat: number;
  values: Float32Array;
  source: string;
}

interface Props {
  terrain: TerrainData;
  exaggeration: number;
  bounds: GeoBounds;
  dataUrl: string;
  /** Optional Farinotti ice-thickness grid (JSON sidecar + .bin) — see scripts/prefetch. Glaciers it covers are tinted by thickness; others stay flat-colored. */
  thicknessUrl?: string;
  onSelect?: (props: GlacierFeatureProps) => void;
  onLoaded?: () => void;
  onThickness?: (info: ThicknessInfo) => void;
}

const FLAT_COLOR = '#1a8fe3';
const FLAT_OPACITY = 0.72;
const OUTLINE_COLOR = '#eaf6ff';
const SHALLOW_COLOR = '#8fd6ff';
const DEEP_COLOR = '#0b3d78';
const THICKNESS_OPACITY = 0.88;

const _cache = new Map<string, GeoJSON.FeatureCollection>();
async function fetchJson(url: string): Promise<GeoJSON.FeatureCollection> {
  const hit = _cache.get(url);
  if (hit) return hit;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Static ${res.status}`);
  const data = await res.json();
  _cache.set(url, data);
  return data;
}

const _thicknessCache = new Map<string, ThicknessGrid>();
async function fetchThicknessGrid(jsonUrl: string): Promise<ThicknessGrid> {
  const hit = _thicknessCache.get(jsonUrl);
  if (hit) return hit;
  const res = await fetch(jsonUrl);
  if (!res.ok) throw new Error(`Static ${res.status}`);
  const doc = await res.json();
  const binUrl = new URL(doc.valuesFile, new URL(jsonUrl, window.location.href)).toString();
  const binRes = await fetch(binUrl);
  if (!binRes.ok) throw new Error(`Static ${binRes.status}`);
  const values = new Float32Array(await binRes.arrayBuffer());
  const grid: ThicknessGrid = {
    width: doc.width, height: doc.height,
    minLon: doc.minLon, minLat: doc.minLat, maxLon: doc.maxLon, maxLat: doc.maxLat,
    values, source: doc.source,
  };
  _thicknessCache.set(jsonUrl, grid);
  return grid;
}

function sampleThickness(g: ThicknessGrid, lon: number, lat: number): number {
  const u = (lon - g.minLon) / (g.maxLon - g.minLon);
  const v = (g.maxLat - lat) / (g.maxLat - g.minLat);
  if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
  const px = Math.min(g.width - 1, Math.max(0, Math.floor(u * g.width)));
  const py = Math.min(g.height - 1, Math.max(0, Math.floor(v * g.height)));
  return g.values[py * g.width + px] ?? 0;
}

/** Does any part of this ring's bbox fall inside the thickness grid's extent? */
function ringOverlapsGrid(ring: [number, number][], g: ThicknessGrid): boolean {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
  }
  return !(maxLon < g.minLon || minLon > g.maxLon || maxLat < g.minLat || minLat > g.maxLat);
}

const GlacierOutlineLayer = ({ terrain, exaggeration, bounds, dataUrl, thicknessUrl, onSelect, onLoaded, onThickness }: Props) => {
  const [fc, setFc] = useState<GeoJSON.FeatureCollection | null>(null);
  const [thickness, setThickness] = useState<ThicknessGrid | null>(null);
  const { size } = useThree();

  useEffect(() => {
    let cancelled = false;
    fetchJson(dataUrl)
      .then((d) => { if (!cancelled) setFc(d); })
      .catch((e) => { console.warn('Glacier outline fetch failed', e); if (!cancelled) setFc({ type: 'FeatureCollection', features: [] }); })
      .finally(() => { if (!cancelled) onLoaded?.(); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataUrl]);

  useEffect(() => {
    if (!thicknessUrl) { setThickness(null); return; }
    let cancelled = false;
    fetchThicknessGrid(thicknessUrl)
      .then((g) => { if (!cancelled) setThickness(g); })
      .catch((e) => console.warn('Ice thickness fetch failed', e));
    return () => { cancelled = true; };
  }, [thicknessUrl]);

  // Total volume from the raw grid (cell area × thickness, summed) — independent
  // of how the fill mesh triangulates, so it doesn't shift with rendering detail.
  useEffect(() => {
    if (!thickness) return;
    const midLat = (thickness.minLat + thickness.maxLat) / 2;
    const cellW = ((thickness.maxLon - thickness.minLon) / thickness.width) * 111320 * Math.cos((midLat * Math.PI) / 180);
    const cellH = ((thickness.maxLat - thickness.minLat) / thickness.height) * 110540;
    const cellArea = Math.abs(cellW * cellH);
    let sum = 0, maxT = 0;
    for (const t of thickness.values) { sum += t; if (t > maxT) maxT = t; }
    onThickness?.({ maxThicknessM: maxT, volumeM3: sum * cellArea, source: thickness.source });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thickness]);

  const meshW = 10;
  const meshH = 10 * (terrain.height / terrain.width);
  const elevRange = terrain.maxElevation - terrain.minElevation || 1;
  const maxH = 10 * (exaggeration / 100);
  const lift = Math.max(0.014, maxH * 0.008);

  const elevAt = (lon: number, lat: number) => {
    const nx = (lon - bounds.minLon) / (bounds.maxLon - bounds.minLon);
    const ny = (lat - bounds.minLat) / (bounds.maxLat - bounds.minLat);
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return terrain.minElevation;
    const px = Math.min(terrain.width - 1, Math.max(0, Math.floor(nx * (terrain.width - 1))));
    const py = Math.min(terrain.height - 1, Math.max(0, Math.floor((1 - ny) * (terrain.height - 1))));
    const e = terrain.elevations[py * terrain.width + px];
    return isFinite(e) ? e : terrain.minElevation;
  };
  const toXZ = (lon: number, lat: number): [number, number] => {
    const nx = (lon - bounds.minLon) / (bounds.maxLon - bounds.minLon);
    const ny = (lat - bounds.minLat) / (bounds.maxLat - bounds.minLat);
    return [(nx - 0.5) * meshW, -((ny - 0.5) * meshH)];
  };
  const toY = (elev: number) => ((elev - terrain.minElevation) / elevRange) * maxH + lift;

  const thicknessColorMax = useMemo(() => {
    if (!thickness) return 0;
    let max = 0;
    for (const t of thickness.values) if (t > max) max = t;
    return max;
  }, [thickness]);

  const polygons = useMemo(() => {
    if (!fc) return [];
    const ringsOf = (geom: GeoJSON.Geometry): [number, number][][] => {
      if (geom.type === 'Polygon') return geom.coordinates as [number, number][][];
      if (geom.type === 'MultiPolygon') return (geom.coordinates as [number, number][][][]).flat();
      return [];
    };
    return fc.features.flatMap((f, i) => {
      if (!f.geometry) return [];
      const props = (f.properties ?? {}) as GlacierFeatureProps;
      return ringsOf(f.geometry).map((ring, j) => {
        const hasThickness = !!thickness && ringOverlapsGrid(ring, thickness);

        // Build the fill in flat (x,z) shape-space first, purely to get
        // earcut's triangulation — then throw away its flat Y and rebuild
        // positions with each vertex's own terrain height, undraped.
        const pts2d = ring.map(([lon, lat]) => new THREE.Vector2(...toXZ(lon, lat)));
        const shape = new THREE.Shape(pts2d);
        const flat = new THREE.ShapeGeometry(shape);
        const flatPos = flat.getAttribute('position') as THREE.BufferAttribute;

        const positions = new Float32Array(flatPos.count * 3);
        const colors = hasThickness ? new Float32Array(flatPos.count * 3) : null;
        const shallow = new THREE.Color(SHALLOW_COLOR);
        const deep = new THREE.Color(DEEP_COLOR);
        const maxForColor = thicknessColorMax || 1;
        const outlinePositions: number[] = [];
        for (let v = 0; v < flatPos.count; v++) {
          const x = flatPos.getX(v);
          const z = flatPos.getY(v); // ShapeGeometry stores our toXZ() z in its local y
          const lon = bounds.minLon + (x / meshW + 0.5) * (bounds.maxLon - bounds.minLon);
          const lat = bounds.minLat + (0.5 - z / meshH) * (bounds.maxLat - bounds.minLat);
          const y = toY(elevAt(lon, lat));
          positions[v * 3] = x;
          positions[v * 3 + 1] = y;
          positions[v * 3 + 2] = z;
          if (colors && thickness) {
            const t = Math.min(1, sampleThickness(thickness, lon, lat) / maxForColor);
            const c = shallow.clone().lerp(deep, t);
            colors[v * 3] = c.r; colors[v * 3 + 1] = c.g; colors[v * 3 + 2] = c.b;
          }
        }
        for (const [lon, lat] of ring) {
          const [x, z] = toXZ(lon, lat);
          outlinePositions.push(x, toY(elevAt(lon, lat)) + lift * 0.5, z);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        if (colors) geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        geo.setIndex(flat.getIndex());
        geo.computeVertexNormals();
        flat.dispose();

        const outlineGeo = new LineGeometry();
        outlineGeo.setPositions(outlinePositions);
        const outlineMat = new LineMaterial({
          color: new THREE.Color(OUTLINE_COLOR).getHex(),
          linewidth: 1.6, transparent: true, opacity: 0.85, depthTest: true,
          resolution: new THREE.Vector2(size.width, size.height),
        });

        return { key: `${i}-${j}`, geo, outlineGeo, outlineMat, hasThickness, props };
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fc, terrain, exaggeration, bounds, thickness, thicknessColorMax, size.width, size.height]);

  useEffect(() => () => {
    for (const p of polygons) { p.geo.dispose(); p.outlineGeo.dispose(); p.outlineMat.dispose(); }
  }, [polygons]);

  if (polygons.length === 0) return null;

  return (
    <group>
      {polygons.map((p) => (
        <group key={p.key}>
          <mesh
            geometry={p.geo}
            onClick={(e) => { e.stopPropagation(); onSelect?.(p.props); }}
            onPointerOver={() => { document.body.style.cursor = 'pointer'; }}
            onPointerOut={() => { document.body.style.cursor = ''; }}
          >
            <meshBasicMaterial
              color={p.hasThickness ? '#ffffff' : FLAT_COLOR}
              vertexColors={p.hasThickness}
              transparent opacity={p.hasThickness ? THICKNESS_OPACITY : FLAT_OPACITY} side={THREE.DoubleSide} depthWrite={false}
              polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-1}
            />
          </mesh>
          <primitive object={new Line2(p.outlineGeo, p.outlineMat)} />
        </group>
      ))}
    </group>
  );
};

export default GlacierOutlineLayer;
