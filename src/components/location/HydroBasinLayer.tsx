import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { useThree } from '@react-three/fiber';
import type { GeoBounds, TerrainData } from '@/lib/geotiff-loader';

/**
 * Renders the *entire drainage basin* a location sits in — HydroSHEDS
 * (HydroRIVERS + HydroBASINS) rivers and watershed boundary, not clipped to
 * the location's bbox like OsmWaterwaysLayer, but to the whole basin (see
 * scripts/prefetch/hydrosheds.mjs). Positions are computed with the same
 * bounds-relative mapping as every other layer, so this coexists in one
 * consistent scene coordinate frame — a basin can be ~100x wider than the
 * terrain footprint, so LocationPage widens the camera's far/maxDistance
 * while this layer is on so it's actually reachable by scrolling out.
 */

export interface RiverFeature {
  id: number;
  ord_stra?: number;
  ord_clas?: number;
  ord_flow?: number;
  length_km?: number;
  dis_av_cms?: number;
}

interface Props {
  exaggeration: number;
  /** Terrain bounds — used to map lon/lat to mesh coords (same reference as other layers). */
  bounds: GeoBounds;
  terrain: TerrainData;
  riversUrl: string;
  boundaryUrl: string;
  /** 'order' sizes/colors by Strahler order class (topology). 'discharge'
   * sizes/colors by average discharge (m³/s) — actual water volume, so
   * rivers can be compared by contribution rather than just network position. */
  colorBy: 'order' | 'discharge';
  /** Only used when colorBy === 'discharge'. 'log' compresses discharge's
   * heavy right skew so headwater streams stay visible next to a trunk
   * river a thousand times larger — but that compression also flattens the
   * visual gap between, say, a 50 m³/s and a 500 m³/s reach. 'linear' keeps
   * the true proportional difference, at the cost of small tributaries
   * shrinking to near-nothing next to a big basin's mainstem. */
  dischargeScale: 'log' | 'linear';
  /** Client-side Strahler-order floor on top of what's in the prefetched
   * file (which is already filtered at fetch time via --min-stra) — lets
   * you declutter further without re-running the prefetch script. */
  minOrder: number;
  onLoaded?: () => void;
  onSelect?: (river: RiverFeature | null) => void;
  /** Fires with the farthest scene-space distance any basin point sits from
   * the origin, once geometry is built — LocationPage uses this to size the
   * camera's far/maxDistance to what this basin actually needs (a fixed
   * guess undershoots for off-center locations like Charyn in the much
   * larger Balqash basin, clipping the far side when zoomed out). */
  onExtent?: (sceneRadius: number) => void;
}

const _cache = new Map<string, any>();
async function fetchJson(url: string): Promise<any> {
  const hit = _cache.get(url);
  if (hit) return hit;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Static ${res.status}`);
  const data = await res.json();
  _cache.set(url, data);
  return data;
}

// Order class 1 = largest mainstem rivers … ~10 = smallest headwater reaches.
function widthForOrdClas(ordClas: number | undefined): number {
  const c = ordClas ?? 6;
  return Math.max(0.5, 3.4 - c * 0.28);
}
function opacityForOrdClas(ordClas: number | undefined): number {
  const c = ordClas ?? 6;
  return Math.min(0.9, Math.max(0.35, 1.0 - c * 0.06));
}

// Discharge is heavily right-skewed (a handful of trunk reaches carry most
// of the water). 'log' scale compresses that skew via log10, normalized
// against this basin's own max, so headwater streams stay visible next to
// the mainstem; 'linear' preserves the true proportional difference between
// reaches instead, at the cost of small tributaries nearly disappearing.
function dischargeNorm(dis: number | undefined, maxDis: number, scale: 'log' | 'linear'): number {
  const d = Math.max(0, dis ?? 0);
  if (scale === 'linear') return Math.min(1, d / (maxDis || 1));
  const denom = Math.log10(maxDis + 1) || 1;
  return Math.min(1, Math.log10(d + 1) / denom);
}
function widthForDischarge(norm: number): number {
  return 0.5 + norm * 3.6;
}
function opacityForDischarge(norm: number): number {
  return 0.3 + norm * 0.65;
}

const HydroBasinLayer = ({
  exaggeration, bounds, terrain, riversUrl, boundaryUrl, colorBy, dischargeScale, minOrder, onLoaded, onSelect, onExtent,
}: Props) => {
  const [rivers, setRivers] = useState<GeoJSON.FeatureCollection<GeoJSON.LineString, RiverFeature> | null>(null);
  const [boundary, setBoundary] = useState<GeoJSON.FeatureCollection | null>(null);
  const { size } = useThree();

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchJson(riversUrl), fetchJson(boundaryUrl)])
      .then(([r, b]) => { if (!cancelled) { setRivers(r); setBoundary(b); } })
      .catch((e) => { console.warn('HydroSHEDS basin fetch failed', e); if (!cancelled) { setRivers({ type: 'FeatureCollection', features: [] }); setBoundary({ type: 'FeatureCollection', features: [] }); } })
      .finally(() => { if (!cancelled) onLoaded?.(); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [riversUrl, boundaryUrl]);

  const { group, sceneRadius } = useMemo(() => {
    if (!rivers || !boundary) return { group: null as THREE.Group | null, sceneRadius: 0 };
    const meshW = 10;
    const meshH = 10 * (terrain.height / terrain.width);
    const maxHeight = 10 * (exaggeration / 100);
    const lift = Math.max(0.008, maxHeight * 0.004);

    const toXZ = (lon: number, lat: number): [number, number] => {
      const nxT = (lon - bounds.minLon) / (bounds.maxLon - bounds.minLon);
      const nyT = (lat - bounds.minLat) / (bounds.maxLat - bounds.minLat);
      return [(nxT - 0.5) * meshW, -((nyT - 0.5) * meshH)];
    };

    const g = new THREE.Group();
    const disposables: { geom: LineGeometry; mat: LineMaterial }[] = [];
    let maxDistFromOrigin = 0;

    const addLine = (
      coords: [number, number][], color: number, width: number, opacity: number, order: number,
      userData?: Record<string, unknown>,
    ) => {
      if (coords.length < 2) return;
      const positions: number[] = [];
      for (const [lon, lat] of coords) {
        const [x, z] = toXZ(lon, lat);
        positions.push(x, lift, z);
        const d = Math.hypot(x, z);
        if (d > maxDistFromOrigin) maxDistFromOrigin = d;
      }
      const geom = new LineGeometry();
      geom.setPositions(new Float32Array(positions));
      const mat = new LineMaterial({
        color, linewidth: width, transparent: true, opacity, depthTest: true,
        resolution: new THREE.Vector2(size.width, size.height),
      });
      const line = new Line2(geom, mat);
      line.renderOrder = order;
      if (userData) line.userData = userData;
      g.add(line);
      disposables.push({ geom, mat });
    };

    const lowColor = new THREE.Color('#d8d2f5');
    const highColor = new THREE.Color('#4c1d95');
    const orderColor = new THREE.Color('#8b7ce0').getHex();
    const maxDis = colorBy === 'discharge'
      ? rivers.features.reduce((m, f) => Math.max(m, f.properties?.dis_av_cms ?? 0), 1)
      : 1;

    for (const f of rivers.features) {
      if (f.geometry?.type !== 'LineString') continue;
      const p = f.properties ?? ({} as RiverFeature);
      if ((p.ord_stra ?? 0) < minOrder) continue;
      let color: number, width: number, opacity: number;
      if (colorBy === 'discharge') {
        const norm = dischargeNorm(p.dis_av_cms, maxDis, dischargeScale);
        color = lowColor.clone().lerp(highColor, norm).getHex();
        width = widthForDischarge(norm);
        opacity = opacityForDischarge(norm);
      } else {
        color = orderColor;
        width = widthForOrdClas(p.ord_clas);
        opacity = opacityForOrdClas(p.ord_clas);
      }
      addLine(f.geometry.coordinates as [number, number][], color, width, opacity, 1, { river: p });
    }

    const boundaryColor = new THREE.Color('#c4b5fd').getHex();
    const ringsOf = (geom: GeoJSON.Geometry): [number, number][][] => {
      if (geom.type === 'Polygon') return geom.coordinates as [number, number][][];
      if (geom.type === 'MultiPolygon') return (geom.coordinates as [number, number][][][]).flat();
      return [];
    };
    for (const f of boundary.features) {
      if (!f.geometry) continue;
      for (const ring of ringsOf(f.geometry)) {
        addLine(ring, boundaryColor, 1, 0.3, 0);
      }
    }

    (g.userData as any).__disposables = disposables;
    return { group: g, sceneRadius: maxDistFromOrigin };
  }, [rivers, boundary, terrain, exaggeration, bounds, colorBy, dischargeScale, minOrder, size.width, size.height]);

  useEffect(() => {
    if (sceneRadius > 0) onExtent?.(sceneRadius);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneRadius]);

  useEffect(() => () => {
    if (!group) return;
    const d = (group.userData as any).__disposables as { geom: LineGeometry; mat: LineMaterial }[] | undefined;
    if (d) for (const { geom, mat } of d) { geom.dispose(); mat.dispose(); }
  }, [group]);

  if (!group) return null;
  return (
    <primitive
      object={group}
      onClick={(e: any) => {
        const river = e.object?.userData?.river as RiverFeature | undefined;
        if (river) { e.stopPropagation(); onSelect?.(river); }
      }}
      onPointerOver={(e: any) => {
        if (e.object?.userData?.river) document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => { document.body.style.cursor = ''; }}
    />
  );
};

export default HydroBasinLayer;
