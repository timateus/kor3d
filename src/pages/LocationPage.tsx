import { useEmbeddingTimeline } from '@/hooks/useEmbeddingTimeline';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Navigate, Link, useLocation, useNavigate } from 'react-router-dom';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Line } from '@react-three/drei';
import * as THREE from 'three';
import { Loader2, Layers, Waves, Crosshair, Mountain, ArrowRight, Copy, Check, Sliders, Eye, X, Info, Video, Plus, Trash2, Play, Circle, RotateCw, Snowflake, History, LayoutGrid, PanelTopClose, PanelTopOpen, Layers3 } from 'lucide-react';
import { findLocation, LOCATIONS } from '@/lib/locations';
import { useMapterhornTerrain } from '@/hooks/useMapterhornTerrain';
import { useTerrainMode } from '@/hooks/useTerrainMode';
import MapboxTerrainMesh from '@/components/MapboxTerrainMesh';
import TerrainStyleOverlay, { type TerrainStyle } from '@/components/TerrainStyleOverlay';
import OsmWaterwaysLayer from '@/components/location/OsmWaterwaysLayer';
import LakesLayer, { type LakeFeature } from '@/components/location/LakesLayer';
import HydroBasinLayer from '@/components/location/HydroBasinLayer';
import IrrigationCanalsLayer, { type CanalFeature, type ReservoirFeature } from '@/components/location/IrrigationCanalsLayer';
import OsmPopulationLayer from '@/components/location/OsmPopulationLayer';
import SatelliteEmbeddingPanel from '@/components/location/SatelliteEmbeddingPanel';
import SentinelChangePanel from '@/components/location/SentinelChangePanel';
import PeaksLayer from '@/components/location/PeaksLayer';
import MasterPlanLayer from '@/components/location/MasterPlanLayer';
import SkiLayer from '@/components/location/SkiLayer';
import { useSatelliteEmbeddings } from '@/hooks/useSatelliteEmbeddings';
import { useSentinelChange } from '@/hooks/useSentinelChange';
import { useEmbeddingBrush } from '@/hooks/useEmbeddingBrush';
import { useEmbeddingSearch } from '@/hooks/useEmbeddingSearch';
import { readEmbeddingArrival, type EmbeddingMatch } from '@/lib/embedding-search';
import OsmPlacesLayer from '@/components/location/OsmPlacesLayer';
import OsmLinesLayer from '@/components/location/OsmLinesLayer';
import ResourcesLayer, { type ResourceFeature } from '@/components/location/ResourcesLayer';
import { LayerFade } from '@/lib/layerFade';
import { ExplodedStack, StackSlice } from '@/components/location/ExplodedStack';
import OsmBuildingsLayer from '@/components/location/OsmBuildingsLayer';
import InaturalistLayer, { type InatObservation } from '@/components/location/InaturalistLayer';
import GlacierOutlineLayer, { type GlacierFeatureProps, type ThicknessInfo } from '@/components/location/GlacierOutlineLayer';
import GlacierChartPanel from '@/components/location/GlacierChartPanel';
import WaterBalancePanel from '@/components/location/WaterBalancePanel';
import { loadShoreline, shorelineRaster, type ShorelineGrid } from '@/lib/lake-shoreline';
import GlacierRetreatLayer from '@/components/location/GlacierRetreatLayer';
import GlacierRetreatPanel from '@/components/location/GlacierRetreatPanel';
import FlyoverController from '@/components/location/FlyoverController';
import SelectionRing from '@/components/location/SelectionRing';
import { type FlyKeyframe, orbitKeyframes, ASPECTS, type AspectKey } from '@/lib/flyover';
import type { PopulationGrid } from '@/lib/population-density';
import { sampleGrid } from '@/lib/population-density';
import WaterFlowOverlay from '@/components/WaterFlowOverlay';
import { createFlowState, addWaterAt, stepFlow, type WaterFlowState } from '@/lib/water-flow-simulation';
import { useUserLocation } from '@/hooks/useUserLocation';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, DropdownMenuItem,
  DropdownMenuCheckboxItem, DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export function LocationsIndex() {
  return (
    <div className="min-h-screen bg-background text-foreground p-8">
      <h1 className="text-2xl font-semibold mb-4">Locations</h1>
      <ul className="space-y-2">
        {LOCATIONS.map((l) => (
          <li key={l.slug}>
            <Link to={`/${l.slug}`} className="text-primary hover:underline inline-flex items-center gap-2">
              {l.label} <ArrowRight className="w-3 h-3" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface HoverCoord { lat: number; lon: number; elev: number }
interface CameraInfo {
  pos: [number, number, number];
  target: [number, number, number];
  distance: number;
  headingDeg: number;
  tiltDeg: number;
  fov: number;
}

function uvToCoord(
  uv: THREE.Vector2,
  terrain: import('@/lib/geotiff-loader').TerrainData,
  bounds: import('@/lib/geotiff-loader').GeoBounds,
): HoverCoord {
  const nx = uv.x, ny = uv.y;
  const lon = bounds.minLon + nx * (bounds.maxLon - bounds.minLon);
  const lat = bounds.minLat + ny * (bounds.maxLat - bounds.minLat);
  const col = Math.max(0, Math.min(terrain.width - 1, Math.floor(nx * (terrain.width - 1))));
  const row = Math.max(0, Math.min(terrain.height - 1, Math.floor((1 - ny) * (terrain.height - 1))));
  const elev = terrain.elevations[row * terrain.width + col] ?? terrain.minElevation;
  return { lat, lon, elev };
}

/** Inverse of uvToCoord — maps a lon/lat back to scene (x, y, z), matching
 * the mesh-space math every terrain-anchored layer (InaturalistLayer etc.)
 * uses, so a computed point actually sits on the ground at that location. */
function lonLatToScene(
  lon: number,
  lat: number,
  terrain: import('@/lib/geotiff-loader').TerrainData,
  bounds: import('@/lib/geotiff-loader').GeoBounds,
  exaggeration: number,
): [number, number, number] {
  const meshW = 10;
  const meshH = 10 * (terrain.height / terrain.width);
  const elevRange = terrain.maxElevation - terrain.minElevation || 1;
  const maxH = 10 * (exaggeration / 100);
  const nx = (lon - bounds.minLon) / (bounds.maxLon - bounds.minLon);
  const ny = (lat - bounds.minLat) / (bounds.maxLat - bounds.minLat);
  const x = (nx - 0.5) * meshW;
  const z = -((ny - 0.5) * meshH);
  let y = 0.02;
  if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1) {
    const cx = Math.min(terrain.width - 1, Math.max(0, Math.floor(nx * (terrain.width - 1))));
    const cy = Math.min(terrain.height - 1, Math.max(0, Math.floor((1 - ny) * (terrain.height - 1))));
    let e = terrain.elevations[cy * terrain.width + cx];
    if (!isFinite(e)) e = terrain.minElevation;
    y = ((e - terrain.minElevation) / elevRange) * maxH;
  }
  return [x, y, z];
}

function CameraProbe({ orbitRef, onChange }: { orbitRef: React.MutableRefObject<any>; onChange: (c: CameraInfo) => void }) {
  const { camera } = useThree();
  useFrame(() => {
    const ctrl = orbitRef.current;
    const target = ctrl ? ctrl.target : new THREE.Vector3();
    const dx = camera.position.x - target.x;
    const dy = camera.position.y - target.y;
    const dz = camera.position.z - target.z;
    const distance = Math.hypot(dx, dy, dz);
    // Heading: compass 0=N, 90=E. In our scene +Z is toward viewer(south), -Z is north.
    const headingDeg = (Math.atan2(dx, -dz) * 180) / Math.PI;
    const tiltDeg = (Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI;
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 45;
    onChange({
      pos: [camera.position.x, camera.position.y, camera.position.z],
      target: [target.x, target.y, target.z],
      distance,
      headingDeg: (headingDeg + 360) % 360,
      tiltDeg,
      fov,
    });
  });
  return null;
}

/** R3F's <Canvas camera={{...}}> only applies far/near/fov once at mount —
 * later changes to that prop object are not synced to the live camera. For
 * the basin-rivers view, `far` needs to track basin extent reactively (a
 * fixed guess undershoots for off-center basins and everything vanishes
 * past the stale clip plane once you zoom beyond it), so apply it
 * imperatively here instead. */
function CameraFarSync({ far }: { far: number }) {
  const { camera } = useThree();
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    if (cam.far === far) return;
    cam.far = far;
    cam.updateProjectionMatrix();
  }, [camera, far]);
  return null;
}

export interface RenderMarker { lon: number; lat: number; color?: string; size?: number }
export interface RenderPath { coords: [number, number][]; progress: number; color?: string; width?: number }

/** A route drawn on the terrain up to `progress` (0–1 of its length), with a
 * ring riding its head — used by `?render` scripts for "the drive from A to B". */
function RenderPathLine({ path, terrain, bounds, exaggeration }: {
  path: RenderPath;
  terrain: import('@/lib/geotiff-loader').TerrainData;
  bounds: import('@/lib/geotiff-loader').GeoBounds;
  exaggeration: number;
}) {
  const { pts, cum } = useMemo(() => {
    const pts = path.coords.map(([lon, lat]) => {
      const [x, y, z] = lonLatToScene(lon, lat, terrain, bounds, exaggeration);
      return new THREE.Vector3(x, y + 0.012, z);
    });
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
    return { pts, cum };
  }, [path.coords, terrain, bounds, exaggeration]);
  const total = cum[cum.length - 1] || 1;
  const goal = Math.max(0, Math.min(1, path.progress)) * total;
  const shown: THREE.Vector3[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (cum[i] <= goal) { shown.push(pts[i]); continue; }
    const f = (goal - cum[i - 1]) / (cum[i] - cum[i - 1]);
    shown.push(pts[i - 1].clone().lerp(pts[i], f));
    break;
  }
  if (shown.length < 2) return null;
  const color = path.color ?? '#ffffff';
  return (
    <>
      <Line points={shown} color={color} lineWidth={path.width ?? 5} transparent opacity={0.95} renderOrder={998} />
      <SelectionRing position={shown[shown.length - 1]} color={color} size={0.045} />
    </>
  );
}

/** `?render` mode: hands camera + clock to an external script (window.__kor3d)
 * so a headless browser can step the scene frame-by-frame at a fixed time
 * step — no dropped frames, unlike realtime MediaRecorder capture. */
function RenderDriver({ orbitRef, apiRef }: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  orbitRef: React.MutableRefObject<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apiRef: React.MutableRefObject<Record<string, (...args: any[]) => unknown>>;
}) {
  const { camera, advance, setFrameloop } = useThree();
  useEffect(() => {
    const w = window as unknown as { __kor3d?: Record<string, unknown> };
    w.__kor3d = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      call: (name: string, ...args: any[]) => apiRef.current[name](...args),
      setCamera: (pos: [number, number, number], target: [number, number, number], fov?: number) => {
        camera.position.set(...pos);
        const cam = camera as THREE.PerspectiveCamera;
        if (fov && cam.fov !== fov) { cam.fov = fov; cam.updateProjectionMatrix(); }
        if (orbitRef.current) {
          orbitRef.current.target.set(...target);
          orbitRef.current.update();
        } else {
          camera.lookAt(...target);
        }
      },
      freeze: () => setFrameloop('never'),
      unfreeze: () => setFrameloop('always'),
      // Renders one frame with a deterministic clock (seconds).
      renderAt: (t: number) => advance(t),
    };
    return () => { delete w.__kor3d; };
  }, [camera, advance, setFrameloop, orbitRef, apiRef]);
  return null;
}

/** Line2 (fat-lines) hit-testing needs an explicit raycaster threshold or it
 * defaults to 0 — an exact hit on the mathematically thin centerline, which
 * is practically unclickable regardless of the rendered line width. Affects
 * every Line2-based layer (basin rivers, OSM waterways/roads/borders). */
function RaycasterTuning() {
  const { raycaster } = useThree();
  useEffect(() => {
    (raycaster.params as any).Line2 = { threshold: 15 };
  }, [raycaster]);
  return null;
}

function UserPin({
  terrain, bounds, exaggeration, location,
}: {
  terrain: import('@/lib/geotiff-loader').TerrainData;
  bounds: import('@/lib/geotiff-loader').GeoBounds;
  exaggeration: number;
  location: { lat: number; lon: number };
}) {
  const pos = useMemo(() => {
    const nx = (location.lon - bounds.minLon) / (bounds.maxLon - bounds.minLon);
    const ny = (location.lat - bounds.minLat) / (bounds.maxLat - bounds.minLat);
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
    const meshW = 10;
    const meshH = 10 * (terrain.height / terrain.width);
    const x = (nx - 0.5) * meshW;
    const z = -((ny - 0.5) * meshH);
    const px = Math.floor(nx * (terrain.width - 1));
    const py = Math.floor((1 - ny) * (terrain.height - 1));
    const elev = terrain.elevations[py * terrain.width + px] ?? terrain.minElevation;
    const elevRange = terrain.maxElevation - terrain.minElevation || 1;
    const maxH = 10 * (exaggeration / 100);
    const y = ((elev - terrain.minElevation) / elevRange) * maxH;
    return [x, y, z] as [number, number, number];
  }, [terrain, bounds, exaggeration, location.lat, location.lon]);
  if (!pos) return null;
  return (
    <group position={pos}>
      <mesh position={[0, 0.4, 0]}>
        <coneGeometry args={[0.12, 0.5, 12]} />
        <meshStandardMaterial color="#ef4444" emissive="#7f1d1d" emissiveIntensity={0.4} />
      </mesh>
      <mesh position={[0, 0.75, 0]}>
        <sphereGeometry args={[0.14, 16, 16]} />
        <meshStandardMaterial color="#ef4444" emissive="#7f1d1d" emissiveIntensity={0.4} />
      </mesh>
    </group>
  );
}

function Slider({ label, value, min, max, step = 1, onChange, format }: {
  label: string; value: number; min: number; max: number; step?: number;
  onChange: (v: number) => void; format?: (v: number) => string;
}) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="text-muted-foreground w-20 shrink-0">{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="flex-1"
      />
      <span className="font-mono w-10 text-right">{format ? format(value) : value}</span>
    </div>
  );
}

function LayerRow({ checked, onChecked, value, onValue, max = 3, children }: {
  checked: boolean; onChecked: (v: boolean) => void; value: number; onValue: (v: number) => void;
  max?: number; children: React.ReactNode;
}) {
  return (
    <div>
      <DropdownMenuCheckboxItem
        checked={checked}
        onCheckedChange={(v) => onChecked(!!v)}
        onSelect={(e) => e.preventDefault()}
      >
        {children}
      </DropdownMenuCheckboxItem>
      <div
        className={`flex items-center gap-2 pl-8 pr-2 pb-1.5 -mt-0.5 text-[10px] ${checked ? '' : 'opacity-40'}`}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <span className="text-muted-foreground w-12 shrink-0">Intensity</span>
        <input
          type="range" min={0} max={max} step={0.05} value={value}
          onChange={(e) => onValue(parseFloat(e.target.value))}
          onDoubleClick={() => onValue(1)}
          className="flex-1 h-3"
          title="Double-click to reset"
        />
        <span className="font-mono w-8 text-right">{value.toFixed(2)}</span>
      </div>
    </div>
  );
}

export default function LocationPage() {
  const params = useParams<{ slug?: string }>();
  const routerLoc = useLocation();
  const navigate = useNavigate();
  const slug = params.slug ?? routerLoc.pathname.replace(/^\//, '').split('/')[0];
  const location = slug ? findLocation(slug) : undefined;
  const renderMode = new URLSearchParams(routerLoc.search).has('render');
  const { token } = useTerrainMode();
  const { terrain, loading, error } = useMapterhornTerrain(location?.bounds ?? null, !!location);

  const [exaggeration, setExaggeration] = useState(location?.exaggeration ?? 50);
  // Same class of bug as the basemap-defaults one above: this useState
  // initializer only runs on first mount, but react-router reuses this
  // component across slug changes — so exaggeration set on one location
  // leaked into whichever location was visited next. Reset on location
  // change instead of only seeding it once.
  useEffect(() => {
    setExaggeration(location?.exaggeration ?? 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location?.slug]);
  const [hideMenu, setHideMenu] = useState(false);
  const [exploded, setExploded] = useState(false);
  const [stackGap, setStackGap] = useState(1.4);
  const [stackFlatten, setStackFlatten] = useState(0.2);
  const [showInspector, setShowInspector] = useState(false);
  const [showTerrain, setShowTerrain] = useState(true);
  const [showWater, setShowWater] = useState(true);
  const [showLakes, setShowLakes] = useState(true);
  const [showPopulation, setShowPopulation] = useState(true);
  const [showEmbeddings, setShowEmbeddings] = useState(false);
  // Sentinel change and Embeddings share the terrain overlay slot; opening one closes the other.
  const [showSentinel, setShowSentinel] = useState(false);
  const sentinelBaseUrl = location?.hasSentinelChange ? `${import.meta.env.BASE_URL}data/locations/${location.slug}/sentinel` : null;
  const sentinel = useSentinelChange(sentinelBaseUrl, showSentinel && !!sentinelBaseUrl);
  const populationVisible = showPopulation && !showEmbeddings && !showSentinel;
  const waterVisible = showWater && !showEmbeddings;
  const lakesVisible = showLakes && !showEmbeddings;
  const embeddingBaseUrl = location?.embeddingYears?.length ? `${import.meta.env.BASE_URL}data/locations/${location.slug}/embeddings` : null;
  const embeddings = useSatelliteEmbeddings(embeddingBaseUrl, showEmbeddings && !!embeddingBaseUrl, location?.embeddingYears ?? []);
  const embeddingSearch = useEmbeddingSearch(embeddings.reference, location?.slug ?? '', embeddings.year, embeddings.metadata?.bounds ?? null,
    embeddings.threshold, showEmbeddings && embeddings.mode === 'similarity');
  const embeddingTimeline = useEmbeddingTimeline(embeddingBaseUrl, location?.embeddingYears ?? [], embeddings.metadata, embeddings.point, showEmbeddings && embeddings.mode === 'timeline');
  const embeddingArrival = useMemo(() => location ? readEmbeddingArrival(routerLoc.state?.embeddingArrival, location.slug, location.embeddingYears ?? [], location.bounds) : null, [routerLoc.state, location]);
  const openedEmbeddingArrival = useRef('');
  const appliedEmbeddingArrival = useRef('');
  const brushActive = showEmbeddings && !!embeddingBaseUrl && (embeddings.mode === 'similarity' || embeddings.mode === 'shoreline') && embeddings.tool === 'brush' && !!embeddings.metadata;
  const embeddingBrush = useEmbeddingBrush(embeddings.metadata, embeddings.pixels, embeddings.brushRadius, embeddings.setPixels, brushActive);
  useEffect(() => { setShowEmbeddings(false); }, [location?.slug]);
  const [showPlaces, setShowPlaces] = useState(true);
  const [showOsmBuildings, setShowOsmBuildings] = useState(false);
  const [showRoads, setShowRoads] = useState(false);
  const [showBorders, setShowBorders] = useState(false);
  const [showResources, setShowResources] = useState(false);
  const [showBasinRivers, setShowBasinRivers] = useState(true);
  const [showBasinBorder, setShowBasinBorder] = useState(!!location?.highlightBasin);
  const [basinSceneRadius, setBasinSceneRadius] = useState<number | null>(null);
  const [showGlacier, setShowGlacier] = useState(!!location?.hasGlacierData);
  const [showPeaks, setShowPeaks] = useState(!!location?.hasPeaks);
  const [showMasterPlan, setShowMasterPlan] = useState(!!location?.hasMasterPlan);
  const [showSki, setShowSki] = useState(!!location?.hasSkiData);
  const [showPlanImage, setShowPlanImage] = useState(false);
  const [selectedGlacier, setSelectedGlacier] = useState<GlacierFeatureProps | null>(null);
  const [showCanals, setShowCanals] = useState(!!location?.hasCanalData);
  const [selectedCanal, setSelectedCanal] = useState<CanalFeature | null>(null);
  const [selectedReservoir, setSelectedReservoir] = useState<ReservoirFeature | null>(null);
  const [selectedResource, setSelectedResource] = useState<ResourceFeature | null>(null);
  const [resourceObs, setResourceObs] = useState<ResourceFeature[]>([]);
  const [showMassBalance, setShowMassBalance] = useState(false);
  const [showWaterBalance, setShowWaterBalance] = useState(false);
  // Level picked in the water-balance panel, drawn as an approximate shoreline on the terrain.
  const [lakeLevel, setLakeLevel] = useState<number | null>(null);
  const [shoreline, setShoreline] = useState<ShorelineGrid | null>(null);
  useEffect(() => {
    if (!showWaterBalance || !location?.hasWaterBalance || shoreline) return;
    let cancelled = false;
    loadShoreline(`${import.meta.env.BASE_URL}data/locations/${location.slug}`)
      .then((g) => { if (!cancelled) setShoreline(g); })
      .catch((e) => console.warn('Shoreline unavailable', e));
    return () => { cancelled = true; };
  }, [showWaterBalance, location?.hasWaterBalance, location?.slug, shoreline]);
  const lakeOverlay = useMemo(
    () => (showWaterBalance && shoreline && lakeLevel != null ? shorelineRaster(shoreline, lakeLevel) : null),
    [showWaterBalance, shoreline, lakeLevel]);
  const [showIceThickness, setShowIceThickness] = useState(!!location?.hasIceThickness);
  const [thicknessInfo, setThicknessInfo] = useState<ThicknessInfo | null>(null);
  const [showRetreat, setShowRetreat] = useState(false);
  const [retreatYear, setRetreatYear] = useState(1958);
  const [retreatMeters, setRetreatMeters] = useState(0);
  const [showInat, setShowInat] = useState(true);
  const [texLoading, setTexLoading] = useState(true);
  const [waterLoaded, setWaterLoaded] = useState(false);
  const [placesLoaded, setPlacesLoaded] = useState(false);
  const [popLoaded, setPopLoaded] = useState(false);

  // View mode & per-mode parameters
  const [terrainStyle, setTerrainStyle] = useState<TerrainStyle>('none');
  const [contourInterval, setContourInterval] = useState(25);
  const [vectorInterval, setVectorInterval] = useState(80);
  const [meshInterval, setMeshInterval] = useState(60);

  // Basemap image adjustments
  const imgDefaults = location?.imageDefaults;
  const [brightness, setBrightness] = useState(imgDefaults?.brightness ?? 1.75);
  const [contrast, setContrast] = useState(imgDefaults?.contrast ?? 0.8);
  const [saturation, setSaturation] = useState(imgDefaults?.saturation ?? 0.6);
  const [gamma, setGamma] = useState(imgDefaults?.gamma ?? 0.9);
  const [tint, setTint] = useState(imgDefaults?.tint ?? '#ffffff');
  const [tintStrength, setTintStrength] = useState(imgDefaults?.tintStrength ?? 0);
  const resetBasemap = useCallback(() => {
    setBrightness(imgDefaults?.brightness ?? 1.75);
    setContrast(imgDefaults?.contrast ?? 0.8);
    setSaturation(imgDefaults?.saturation ?? 0.6);
    setGamma(imgDefaults?.gamma ?? 0.9);
    setTint(imgDefaults?.tint ?? '#ffffff');
    setTintStrength(imgDefaults?.tintStrength ?? 0);
  }, [imgDefaults]);
  // The useState initializers above only run once, on this component's first
  // mount — react-router doesn't remount LocationPage when navigating between
  // slugs on the same route, so switching locations left the *previous*
  // location's basemap sliders in place instead of picking up the new one's
  // imageDefaults. Re-apply them whenever the location actually changes.
  useEffect(() => { resetBasemap(); }, [resetBasemap]);

  // Population heatmap
  const [popOpacity, setPopOpacity] = useState(0.75);
  const [popIntensity, setPopIntensity] = useState(1);
  // Per-layer "intensity" (opacity multiplier) shown next to each layer in the
  // Layers menu. Population keeps its own heatmap intensity (popIntensity).
  const [intensity, setIntensities] = useState<Record<string, number>>({});
  const iv = (k: string) => intensity[k] ?? 1;
  const intensityKey = `kor3d:layer-intensity:${location?.slug}`;
  const intensityLoaded = useRef<string | null>(null);
  // Intensities are per location: load on slug change, save on edit.
  useEffect(() => {
    let saved: Record<string, number> = {};
    try { saved = JSON.parse(localStorage.getItem(intensityKey) ?? '{}'); } catch { /* ignore */ }
    const { population, ...rest } = saved;
    setIntensities(rest);
    setPopIntensity(typeof population === 'number' ? population : 1);
    intensityLoaded.current = intensityKey;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intensityKey]);
  useEffect(() => {
    if (intensityLoaded.current !== intensityKey) return;
    try { localStorage.setItem(intensityKey, JSON.stringify({ ...intensity, population: popIntensity })); } catch { /* ignore */ }
  }, [intensity, popIntensity, intensityKey]);
  const copyIntensityJson = () => {
    const keys = ['water','lakes','basinRivers','basinBorder','buildings','glacier','canals','inat','population','places','peaks','plan','ski','roads','borders','resources'];
    const all: Record<string, number> = { ...intensity, population: popIntensity };
    const out: Record<string, number> = {};
    for (const k of keys) out[k] = +(all[k] ?? 1).toFixed(2);
    copyText(JSON.stringify({ location: location?.slug, intensity: out }, null, 2));
  };
  const setIv = (k: string, v: number) => setIntensities((m) => ({ ...m, [k]: v }));

  const [waterFlowActive, setWaterFlowActive] = useState(false);
  const [flowState, setFlowState] = useState<WaterFlowState | null>(null);
  const [flowKey, setFlowKey] = useState(0);
  const [hover, setHover] = useState<HoverCoord | null>(null);
  const [camera, setCamera] = useState<CameraInfo | null>(null);
  // CameraProbe fires every rendered frame — routing that straight into React
  // state (setCamera) forces a full LocationPage re-render at up to 60fps,
  // permanently, on every location, regardless of which data layers are on
  // (this was the actual cause of "still lagging with nothing turned on").
  // Keep the live value in a ref for on-demand reads (flyover keyframe
  // capture) and only push to React state — throttled — while the Inspector
  // panel is actually open and displaying it.
  const cameraRef = useRef<CameraInfo | null>(null);
  const lastCameraSetAtRef = useRef(0);
  const handleCameraChange = useCallback((info: CameraInfo) => {
    cameraRef.current = info;
    if (!showInspector) return;
    const now = performance.now();
    if (now - lastCameraSetAtRef.current < 150) return;
    lastCameraSetAtRef.current = now;
    setCamera(info);
  }, [showInspector]);
  const [copied, setCopied] = useState<string | null>(null);
  const [selectedWater, setSelectedWater] = useState<import('@/components/location/OsmWaterwaysLayer').WaterFeature | null>(null);
  const [selectedLake, setSelectedLake] = useState<LakeFeature | null>(null);
  const [selectedBasinRiver, setSelectedBasinRiver] = useState<import('@/components/location/HydroBasinLayer').RiverFeature | null>(null);
  const [basinColorBy, setBasinColorBy] = useState<'order' | 'discharge'>('discharge');
  const [basinDischargeScale, setBasinDischargeScale] = useState<'log' | 'linear'>('log');
  const [basinMinOrder, setBasinMinOrder] = useState(3);
  const [selectedInat, setSelectedInat] = useState<InatObservation | null>(null);
  const [inatObs, setInatObs] = useState<InatObservation[]>([]);
  const [popGrid, setPopGrid] = useState<PopulationGrid | null>(null);
  const [popPoint, setPopPoint] = useState<{ lat: number; lon: number; value: number | null } | null>(null);
  const lastUserInteractRef = useRef<number>(Date.now());
  // True while the currently-shown inat card was a manual pick (vs. the
  // ambient auto-cycle slideshow below) — read by that auto-cycle so it
  // never swaps out an observation the user deliberately opened.
  const inatManualRef = useRef(false);
  // Same idea as inatManualRef, but for a resource popup the ambient
  // carousel opened on its own — a manual click on a resource marker sets
  // this so the carousel doesn't swap it out while the user is reading it.
  const resourceManualRef = useRef(false);
  // Latched once the user closes an iNat/resource card — the ambient
  // slideshow stays off from then on.
  const slideshowOffRef = useRef(false);
  // The various click-to-inspect popups (water, basin river, glacier, inat
  // observation, population sample) all render as fixed-position overlay
  // cards that can stack on top of each other. Selecting any one of them
  // closes the rest, so only one is ever on screen at a time.
  const closeAllPopups = () => {
    setSelectedWater(null);
    setSelectedLake(null);
    setSelectedBasinRiver(null);
    setSelectedGlacier(null);
    setSelectedCanal(null);
    setSelectedReservoir(null);
    setSelectedResource(null);
    setSelectedInat(null);
    inatManualRef.current = false;
    resourceManualRef.current = false;
    setPopPoint(null);
  };
  const flowLoopRef = useRef<number | null>(null);
  const [renderMarkers, setRenderMarkers] = useState<RenderMarker[]>([]);
  const [renderPath, setRenderPath] = useState<RenderPath | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const renderApiRef = useRef<Record<string, (...args: any[]) => unknown>>({});
  useEffect(() => { if (renderMode) slideshowOffRef.current = true; }, [renderMode]);
  const orbitRef = useRef<any>(null);

  // Flyover: keyframe path playback + video export
  const [keyframes, setKeyframes] = useState<FlyKeyframe[]>([]);
  const [flyDuration, setFlyDuration] = useState(8);
  const [isFlying, setIsFlying] = useState(false);
  const [isRecording, setIsRecording] = useState(false);

  // Photo grid: full-screen iNaturalist gallery, clicking a photo flies the
  // camera to that observation. Uses its own tiny FlyoverController instance
  // (own keyframes/playing state) so it never touches the user-authored
  // Flyover keyframes list above.
  const [showInatGrid, setShowInatGrid] = useState(false);
  const [gridFlyKeyframes, setGridFlyKeyframes] = useState<FlyKeyframe[]>([]);
  const [isFlyingToGrid, setIsFlyingToGrid] = useState(false);
  const [exportAspect, setExportAspect] = useState<AspectKey>('landscape');
  const [exportSize, setExportSize] = useState<{ w: number; h: number } | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  const { location: userLoc, loading: locating, requestLocation } = useUserLocation();

  useEffect(() => {
    if (!terrain) return;
    setFlowState(createFlowState(terrain));
    setFlowKey((k) => k + 1);
  }, [terrain]);

  useEffect(() => {
    if (!showBasinRivers) { setBasinSceneRadius(null); setSelectedBasinRiver(null); }
  }, [showBasinRivers]);

  // Basin geometry can sit far off-center from the local terrain (e.g. Charyn
  // is near the edge of the much larger Balqash basin) — size the camera's
  // far/maxDistance from the basin's actual reported extent rather than a
  // fixed guess, or the far side clips out of view when zoomed out to frame
  // the whole thing. ~2.6x radius comfortably frames it (matches roughly
  // radius / tan(fov/2) for this scene's 45° fov); far needs to clear
  // maxDistance + radius for the worst-case (camera and far point on
  // opposite sides of the target), so 4x with margin.
  const basinMaxDistance = basinSceneRadius ? basinSceneRadius * 2.6 : 1500;
  const basinFar = basinSceneRadius ? basinSceneRadius * 4 + 200 : 2000;

  useEffect(() => {
    if (!waterFlowActive || !flowState) return;
    const loop = () => {
      // Run several sub-steps per frame for maximum flow speed
      for (let i = 0; i < 6; i++) stepFlow(flowState);
      setFlowKey((k) => k + 1);
      flowLoopRef.current = requestAnimationFrame(loop);
    };
    flowLoopRef.current = requestAnimationFrame(loop);
    return () => { if (flowLoopRef.current) cancelAnimationFrame(flowLoopRef.current); };
  }, [waterFlowActive, flowState]);

  // Wrap setSelectedInat so callers (points / auto-cycle) can indicate whether
  // this was a manual user action. A manual pick closes every other popup
  // (river/water/glacier/population) first, so only one card is ever showing,
  // and latches inatManualRef so the ambient auto-cycle below leaves it alone
  // until the user closes it — otherwise the mere passage of >5s idle while
  // they're still reading it would swap in a new random observation.
  const selectInat = (o: InatObservation | null, manual: boolean) => {
    if (manual) {
      lastUserInteractRef.current = Date.now();
      closeAllPopups();
    }
    inatManualRef.current = manual && o != null;
    if (manual && o == null) slideshowOffRef.current = true;
    setSelectedInat(o);
  };

  // Same wrapper as selectInat, for resource (mining/oil&gas/logging/
  // industrial) markers — lets a manual click opt out of the ambient
  // carousel the same way a manual iNat pick does.
  const selectResource = (r: ResourceFeature | null, manual: boolean) => {
    if (manual) {
      lastUserInteractRef.current = Date.now();
      closeAllPopups();
    }
    resourceManualRef.current = manual && r != null;
    if (manual && r == null) slideshowOffRef.current = true;
    setSelectedResource(r);
  };

  // Auto-cycle: an ambient slideshow that, after 5s with nothing selected,
  // picks a random iNat observation *or* resource marker from the combined
  // pool and keeps rotating every ~4s. It must not run while a *different*
  // kind of popup (river/water/glacier/population/canal/reservoir) is open —
  // that's `otherPopupOpen`, checked once per effect run — and each tick
  // must not clobber a *manually* selected card the user is currently
  // reading (`inatManualRef`/`resourceManualRef`) — checked live inside
  // pickRandom, not via the effect deps, since the ambient picks it makes
  // itself shouldn't trigger a teardown/restart of its own loop.
  const otherPopupOpen = !!(showEmbeddings || showSentinel || showWaterBalance || selectedWater || selectedLake || selectedBasinRiver || selectedGlacier || popPoint || selectedCanal || selectedReservoir);
  useEffect(() => {
    if ((inatObs.length === 0 && resourceObs.length === 0) || otherPopupOpen) return;
    let cancelled = false;
    let cycleTimer: number | null = null;

    const pickRandom = () => {
      if (cancelled || slideshowOffRef.current || inatManualRef.current || resourceManualRef.current) return;
      const idle = Date.now() - lastUserInteractRef.current;
      if (idle < 5000) return;
      const pool: ({ kind: 'inat'; item: InatObservation } | { kind: 'resource'; item: ResourceFeature })[] = [
        ...inatObs.map((o) => ({ kind: 'inat' as const, item: o })),
        ...resourceObs.map((r) => ({ kind: 'resource' as const, item: r })),
      ];
      if (pool.length === 0) return;
      const next = pool[Math.floor(Math.random() * pool.length)];
      if (next.kind === 'inat') {
        setSelectedResource(null);
        setSelectedInat(next.item);
      } else {
        setSelectedInat(null);
        setSelectedResource(next.item);
      }
    };

    const check = () => {
      if (cancelled) return;
      if (!slideshowOffRef.current && !inatManualRef.current && !resourceManualRef.current) {
        const idle = Date.now() - lastUserInteractRef.current;
        if (idle >= 5000) pickRandom();
      }
      cycleTimer = window.setTimeout(check, 4000);
    };
    cycleTimer = window.setTimeout(check, 5000);

    return () => {
      cancelled = true;
      if (cycleTimer) clearTimeout(cycleTimer);
    };
  }, [inatObs, resourceObs, otherPopupOpen]);

  // Preload observation images into the browser cache so cycling is instant.
  useEffect(() => {
    if (inatObs.length === 0) return;
    const urls = inatObs.map((o) => o.photoUrl).filter(Boolean) as string[];
    let i = 0;
    const step = () => {
      if (i >= urls.length) return;
      const batch = urls.slice(i, i + 6);
      i += 6;
      Promise.all(batch.map((u) => new Promise<void>((res) => {
        const img = new Image();
        img.onload = img.onerror = () => res();
        img.src = u;
      }))).then(step);
    };
    step();
  }, [inatObs]);

  // Preload resource satellite thumbnails the same way, so the carousel/
  // manual clicks don't sit on a blank card while the image fetches.
  useEffect(() => {
    if (resourceObs.length === 0) return;
    const urls = resourceObs.map((r) => r.imageUrl).filter(Boolean);
    let i = 0;
    const step = () => {
      if (i >= urls.length) return;
      const batch = urls.slice(i, i + 6);
      i += 6;
      Promise.all(batch.map((u) => new Promise<void>((res) => {
        const img = new Image();
        img.onload = img.onerror = () => res();
        img.src = u;
      }))).then(step);
    };
    step();
  }, [resourceObs]);

  const addKeyframe = () => {
    const cam = cameraRef.current;
    if (!cam) return;
    setKeyframes((ks) => [...ks, { id: `kf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, pos: cam.pos, target: cam.target }]);
  };
  const removeKeyframe = (id: string) => setKeyframes((ks) => ks.filter((k) => k.id !== id));
  const clearKeyframes = () => setKeyframes([]);
  const useOrbitPreset = () => {
    const cam = cameraRef.current;
    if (!cam) return;
    setKeyframes(orbitKeyframes(cam.target, cam.distance, cam.tiltDeg, cam.headingDeg, 8));
  };

  // Grid → map: fly from wherever the camera currently is to hover over the
  // clicked observation, keeping the current heading/tilt but capping
  // distance so a far-zoomed-out view still reads as "zooming in", not just
  // panning while staying tiny.
  const flyToObservation = (o: InatObservation) => {
    if (!terrain || !location) return;
    const [tx, ty, tz] = lonLatToScene(o.lon, o.lat, terrain, location.bounds, exaggeration);
    const cam = cameraRef.current;
    const tiltDeg = cam ? Math.max(15, Math.min(80, cam.tiltDeg)) : 45;
    const headingDeg = cam?.headingDeg ?? 0;
    const distance = Math.min(cam?.distance ?? 3, 3);
    const tiltRad = (tiltDeg * Math.PI) / 180;
    const headingRad = (headingDeg * Math.PI) / 180;
    const horiz = distance * Math.cos(tiltRad);
    const dx = Math.sin(headingRad) * horiz;
    const dz = -Math.cos(headingRad) * horiz;
    const dy = distance * Math.sin(tiltRad);
    const endPos: [number, number, number] = [tx + dx, ty + dy, tz + dz];
    const endTarget: [number, number, number] = [tx, ty, tz];
    const startPos = cam?.pos ?? endPos;
    const startTarget = cam?.target ?? endTarget;
    setGridFlyKeyframes([
      { id: 'grid-start', pos: startPos, target: startTarget },
      { id: 'grid-end', pos: endPos, target: endTarget },
    ]);
    setShowInatGrid(false);
    selectInat(o, true);
    setIsFlyingToGrid(true);
  };

  const openEmbeddingMatch = (match: EmbeddingMatch) => {
    if (!embeddings.reference || !location) return;
    navigate(`/${match.slug}`, { state: { embeddingArrival: {
      ...match, reference: Array.from(embeddings.reference), sourceLabel: embeddings.externalReference?.sourceLabel ?? location.label,
    } } });
  };

  useEffect(() => {
    if (!embeddingArrival || !location) {
      openedEmbeddingArrival.current = '';
      appliedEmbeddingArrival.current = '';
      return;
    }
    if (openedEmbeddingArrival.current !== routerLoc.key) {
      openedEmbeddingArrival.current = routerLoc.key;
      setShowEmbeddings(true);
      embeddings.setYear(embeddingArrival.year);
      embeddings.setMode('similarity');
      embeddings.setTool('move');
    }
    if (appliedEmbeddingArrival.current === routerLoc.key || loading || !terrain?.bounds || !embeddings.metadata || embeddings.metadata.year !== embeddingArrival.year) return;
    const keys = ['minLon', 'maxLon', 'minLat', 'maxLat'] as const;
    if (!keys.every(key => Math.abs(terrain.bounds[key] - location.bounds[key]) < 1e-10 && Math.abs(embeddings.metadata.bounds[key] - location.bounds[key]) < 1e-10)) return;
    appliedEmbeddingArrival.current = routerLoc.key;
    embeddings.setExternalReference({ vector: embeddingArrival.reference, sourceLabel: embeddingArrival.sourceLabel,
      anchor: { lon: embeddingArrival.lon, lat: embeddingArrival.lat }, score: embeddingArrival.score });
    closeAllPopups();
    const target = lonLatToScene(embeddingArrival.lon, embeddingArrival.lat, terrain, location.bounds, exaggeration);
    const camera = cameraRef.current;
    const widthMeters = (location.bounds.maxLon - location.bounds.minLon) * 111320 * Math.cos(embeddingArrival.lat * Math.PI / 180);
    const zoom = embeddingArrival.patchMeters ? Math.max(0.25, Math.min(1, embeddingArrival.patchMeters * 80 / widthMeters)) : 1;
    setGridFlyKeyframes([
      { id: 'embedding-start', pos: camera?.pos ?? [target[0] + 2, target[1] + 2, target[2] + 2], target: camera?.target ?? target },
      { id: 'embedding-match', pos: [target[0] + 1.6 * zoom, target[1] + 2 * zoom, target[2] + 1.6 * zoom], target },
    ]);
    setIsFlyingToGrid(true);
  }, [embeddingArrival, location, routerLoc.key, loading, terrain, embeddings, exaggeration, closeAllPopups]);

  const playPreview = () => {
    if (keyframes.length < 2 || isFlying) return;
    setIsFlying(true);
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const startRecording = () => {
    if (keyframes.length < 2 || !rendererRef.current || isRecording) return;
    const canvasEl = rendererRef.current.domElement;
    if (typeof canvasEl.captureStream !== 'function') {
      alert('Video recording is not supported in this browser.');
      return;
    }
    const { w, h } = ASPECTS[exportAspect];
    setExportSize({ w, h });
    // Give the canvas two frames to resize to the export resolution before we start capturing.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const stream = canvasEl.captureStream(30);
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
      recordedChunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunksRef.current.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(recordedChunksRef.current, { type: 'video/webm' });
        downloadBlob(blob, `${location?.slug ?? 'flyover'}-${exportAspect}-${Date.now()}.webm`);
        setExportSize(null);
        setIsRecording(false);
      };
      recorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
      setIsFlying(true);
    }));
  };

  const handleFlightDone = () => {
    setIsFlying(false);
    if (isRecording && recorderRef.current) {
      recorderRef.current.stop();
      recorderRef.current = null;
    }
  };

  const copyText = async (txt: string) => {
    try { await navigator.clipboard.writeText(txt); } catch { /* ignore */ }
    setCopied(txt);
    setTimeout(() => setCopied(null), 1600);
  };
  const copyCoords = (c: HoverCoord) => copyText(`${c.lat.toFixed(6)}, ${c.lon.toFixed(6)}`);

  if (!slug) return <Navigate to="/" replace />;
  if (!location) {
    return (
      <div className="min-h-screen bg-background text-foreground grid place-items-center p-8 text-center">
        <div>
          <h1 className="text-xl font-semibold mb-2">Location not found</h1>
          <p className="text-sm text-muted-foreground mb-4">
            Add it to <code>src/lib/locations.ts</code> to make it available.
          </p>
          <Link to="/" className="text-primary hover:underline">Home</Link>
        </div>
      </div>
    );
  }

  const btnBase =
    'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border border-border/60 bg-background/80 backdrop-blur hover:bg-accent transition-colors';

  const dataBase = `${import.meta.env.BASE_URL}data/locations/${location.slug}`;

  // Bottom-to-top floors for the exploded view — only layers that are
  // actually showing get a floor, so the stack has no empty gaps.
  const stackOrder = ([
    ['terrain', showTerrain],
    ['population', populationVisible],
    ['glacier', (showGlacier || showRetreat) && !!location.hasGlacierData],
    ['lakes', lakesVisible],
    ['water', waterVisible],
    ['basin', showBasinRivers || showBasinBorder],
    ['canals', showCanals && !!location.hasCanalData],
    ['buildings', showOsmBuildings],
    ['roads', showRoads],
    ['resources', showResources],
    ['borders', showBorders],
    ['inat', showInat],
    ['places', showPlaces],
    ['ski', showSki && !!location.hasSkiData],
    ['plan', showMasterPlan && !!location.hasMasterPlan],
    ['peaks', showPeaks && !!location.hasPeaks],
  ] as const).filter(([, on]) => on).map(([id]) => id as string);

  // Single gate for the full-screen loader: terrain DEM, basemap imagery, and
  // the default-on data layers (water, population, places). Buildings/roads/
  // borders are off by default and don't block first paint.
  const assetsLoading =
    loading || texLoading ||
    (waterVisible && !waterLoaded) ||
    (populationVisible && !popLoaded) ||
    (showPlaces && !placesLoaded);

  if (renderMode) {
    const layerSetters: Record<string, (v: boolean) => void> = {
      terrain: setShowTerrain, water: setShowWater, lakes: setShowLakes, population: setShowPopulation,
      places: setShowPlaces, buildings: setShowOsmBuildings, roads: setShowRoads, borders: setShowBorders,
      resources: setShowResources, basinRivers: setShowBasinRivers, basinBorder: setShowBasinBorder,
      glacier: setShowGlacier, canals: setShowCanals, inat: setShowInat,
    };
    renderApiRef.current = {
      ready: () => !!terrain && !assetsLoading,
      setLayers: (m: Record<string, boolean>) => Object.entries(m).forEach(([k, v]) => layerSetters[k]?.(v)),
      setIntensity: (m: Record<string, number>) => setIntensities((cur) => ({ ...cur, ...m })),
      setMarkers: (ms: RenderMarker[]) => setRenderMarkers(ms),
      setPath: (p: RenderPath | null) => setRenderPath(p),
      setPathProgress: (progress: number) => setRenderPath((p) => (p ? { ...p, progress } : p)),
      toScene: (lon: number, lat: number) => terrain ? lonLatToScene(lon, lat, terrain, location.bounds, exaggeration) : null,
    };
  }

  return (
    <div className="fixed inset-0 bg-background text-foreground" data-render={renderMode ? '' : undefined} style={{ fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace' }}>
      <style>{`
        .location-serif, .display-font { font-family: "Sora", ui-sans-serif, system-ui, sans-serif; font-weight: 800; letter-spacing: -0.02em; }
        .tech-font { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }
        [data-render] > :not(#scene):not(style) { display: none !important; }
      `}</style>
      <div
        id="scene"
        className={exportSize ? 'absolute top-1/2 left-1/2 ring-2 ring-primary' : 'absolute inset-0'}
        style={exportSize ? {
          width: exportSize.w,
          height: exportSize.h,
          transform: `translate(-50%, -50%) scale(${Math.min(
            (window.innerWidth * 0.8) / exportSize.w,
            (window.innerHeight * 0.8) / exportSize.h,
          )})`,
          transformOrigin: 'center',
        } : undefined}
      >
      <Canvas
        camera={{ position: [-4.2, 4.2, -1.9], fov: 45, near: 0.02, far: showBasinRivers ? basinFar : 300 }}
        shadows={false}
        gl={{ preserveDrawingBuffer: true }}
        onCreated={(state) => { rendererRef.current = state.gl; }}
      >
        <color attach="background" args={['#f3f0e7']} />
        <ambientLight intensity={0.9} />
        <directionalLight position={[10, 20, 10]} intensity={1.1} />
        <hemisphereLight args={['#ffffff', '#c9b98a', 0.5]} />

        <OrbitControls
          ref={orbitRef}
          enabled={!brushActive}
          enableDamping={!renderMode}
          dampingFactor={0.06}
          minDistance={0.15}
          maxDistance={showBasinRivers ? basinMaxDistance : 110}
          maxPolarAngle={Math.PI / 2.05}
          mouseButtons={{ LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }}
        />
        <CameraProbe orbitRef={orbitRef} onChange={handleCameraChange} />
        <CameraFarSync far={showBasinRivers ? basinFar : 300} />
        <RaycasterTuning />
        {renderMode && <RenderDriver orbitRef={orbitRef} apiRef={renderApiRef} />}
        <FlyoverController keyframes={keyframes} playing={isFlying} duration={flyDuration} orbitRef={orbitRef} onDone={handleFlightDone} />
        <FlyoverController keyframes={gridFlyKeyframes} playing={isFlyingToGrid} duration={1.8} orbitRef={orbitRef} onDone={() => setIsFlyingToGrid(false)} />

        {terrain && (
          <ExplodedStack
            active={exploded}
            order={stackOrder}
            gap={stackGap}
            flatten={stackFlatten}
            meshW={10}
            meshH={10 * (terrain.height / terrain.width)}
            orbitRef={orbitRef}
          >
            <StackSlice id="terrain">
            <group
              onPointerDown={brushActive ? (e) => {
                if (!e.uv || e.button !== 0) return;
                e.stopPropagation();
                (e.target as HTMLElement).setPointerCapture(e.pointerId);
                closeAllPopups();
                embeddingBrush.start(uvToCoord(e.uv, terrain, location.bounds));
              } : undefined}
              onPointerMove={showInspector || brushActive ? (e) => {
                if (!e.uv) return;
                if (brushActive) {
                  if (embeddingBrush.isPainting()) {
                    e.stopPropagation();
                    embeddingBrush.paint(uvToCoord(e.uv, terrain, location.bounds));
                  }
                } else setHover(uvToCoord(e.uv, terrain, location.bounds));
              } : undefined}
              onPointerUp={brushActive ? (e) => {
                embeddingBrush.finish();
                (e.target as HTMLElement).releasePointerCapture(e.pointerId);
              } : undefined}
              onPointerOut={showInspector ? () => setHover(null) : undefined}
              onClick={(e) => {
                if (!e.uv) return;
                e.stopPropagation();
                if (brushActive) return;
                if (showEmbeddings && embeddings.mode === 'change') { closeAllPopups(); return; }
                if (waterFlowActive && flowState) {
                  const col = Math.floor((e.uv.x) * (terrain.width - 1));
                  const row = Math.floor((1 - e.uv.y) * (terrain.height - 1));
                  addWaterAt(flowState, row, col, 8, 4);
                  setFlowKey((k) => k + 1);
                  return;
                }
                if (showSentinel && sentinel.manifest) {
                  if (e.delta > 5) return;
                  const c = uvToCoord(e.uv, terrain, location.bounds);
                  closeAllPopups();
                  sentinel.setPoint({ lon: c.lon, lat: c.lat });
                  return;
                }
                if (showEmbeddings && embeddingBaseUrl && embeddings.metadata && ['similarity', 'shoreline', 'timeline'].includes(embeddings.mode)) {
                  if (embeddings.tool !== 'point' || e.delta > 5) return;
                  const c = uvToCoord(e.uv, terrain, location.bounds);
                  closeAllPopups();
                  embeddings.setPoint({ lon: c.lon, lat: c.lat });
                  return;
                }
                if (populationVisible && popGrid) {
                  const c = uvToCoord(e.uv, terrain, location.bounds);
                  const value = sampleGrid(popGrid, c.lon, c.lat);
                  // Only pop up where there's actually someone — clicking
                  // empty desert/mountainside shouldn't surface a "0.0
                  // people" card, it should behave like a plain ground click.
                  if (value != null && value > 0) {
                    closeAllPopups();
                    setPopPoint({ lat: c.lat, lon: c.lon, value });
                    return;
                  }
                }
                // Plain click on open terrain, hitting no feature above (those
                // stop propagation themselves) — treat as click-away and
                // close whatever popup is currently showing.
                closeAllPopups();
              }}
            >
              {showTerrain && (
                <MapboxTerrainMesh
                  terrain={terrain}
                  exaggeration={exaggeration}
                  token={token}
                  baseStyleOverride="satlas"
                  brightness={brightness}
                  contrast={contrast}
                  saturation={saturation}
                  gamma={gamma}
                  tint={tint}
                  tintStrength={tintStrength}
                  onLoadingChange={setTexLoading}
                  embeddingRaster={showSentinel ? sentinel.raster : showEmbeddings && embeddingBaseUrl ? embeddings.raster : lakeOverlay?.raster ?? null}
                  embeddingOpacity={showSentinel ? sentinel.opacity : showEmbeddings ? embeddings.opacity : lakeOverlay ? 0.85 : embeddings.opacity}
                  embeddingSecondRaster={showSentinel ? sentinel.secondRaster : showEmbeddings && embeddings.mode === 'change' ? embeddings.secondRaster : null}
                  embeddingSplit={showSentinel ? sentinel.split : showEmbeddings && embeddings.mode === 'change' && embeddings.changeView === 'swipe' ? embeddings.swipe : null}
                  embeddingBounds={showSentinel ? sentinel.manifest?.bounds : showEmbeddings ? embeddings.metadata?.bounds : lakeOverlay?.raster.bounds ?? embeddings.metadata?.bounds}
                  selectionTexture={embeddingBaseUrl && ((showEmbeddings && ['similarity', 'shoreline'].includes(embeddings.mode) && embeddings.pixels !== null) || brushActive) ? embeddingBrush.texture : null}
                />
              )}
            </group>
            {showEmbeddings && embeddingBaseUrl && ['similarity', 'shoreline', 'timeline'].includes(embeddings.mode) && embeddings.point && (
              <SelectionRing position={lonLatToScene(embeddings.point.lon, embeddings.point.lat, terrain, location.bounds, exaggeration)} color="#ffe62d" />
            )}
            {showEmbeddings && embeddings.mode === 'similarity' && embeddings.externalReference && (
              <SelectionRing position={lonLatToScene(embeddings.externalReference.anchor.lon, embeddings.externalReference.anchor.lat, terrain, location.bounds, exaggeration)} color="#b482ff" />
            )}
            <TerrainStyleOverlay
              terrain={terrain}
              exaggeration={exaggeration}
              style={terrainStyle}
              contourInterval={contourInterval}
              vectorInterval={vectorInterval}
              meshInterval={meshInterval}
              bounds={location.bounds}
            />
            {renderMarkers.map((m, i) => (
              <SelectionRing
                key={i}
                position={lonLatToScene(m.lon, m.lat, terrain, location.bounds, exaggeration)}
                color={m.color}
                size={m.size}
              />
            ))}
            {renderPath && (
              <RenderPathLine path={renderPath} terrain={terrain} bounds={location.bounds} exaggeration={exaggeration} />
            )}

            {flowState && (
              <WaterFlowOverlay
                terrain={terrain}
                exaggeration={exaggeration}
                flowState={flowState}
                renderKey={flowKey}
              />
            )}
            {userLoc && (
              <UserPin
                terrain={terrain}
                bounds={location.bounds}
                exaggeration={exaggeration}
                location={userLoc}
              />
            )}
            </StackSlice>
            <StackSlice id="water">
            <LayerFade intensity={iv('water')}>
{waterVisible && (
              <OsmWaterwaysLayer
                terrain={terrain}
                exaggeration={exaggeration}
                bounds={location.bounds}
                clipBounds={location.waterBounds ?? location.bounds}
                dataUrl={`${dataBase}/${location.waterBounds ? 'water_large.json' : 'water.json'}`}
                onSelect={(f) => { closeAllPopups(); setSelectedWater(f); }}
                onLoaded={() => setWaterLoaded(true)}
              />
            )}
</LayerFade>
            </StackSlice>
            <StackSlice id="lakes">
            <LayerFade intensity={iv('lakes')}>
{lakesVisible && (
              <LakesLayer
                terrain={terrain}
                exaggeration={exaggeration}
                bounds={location.bounds}
                clipBounds={location.waterBounds ?? location.bounds}
                enabled={lakesVisible}
                dataUrl={`${dataBase}/${location.waterBounds ? 'water_large.json' : 'water.json'}`}
                onSelect={(f) => { closeAllPopups(); setSelectedLake(f); }}
              />
            )}
</LayerFade>
            </StackSlice>
            <StackSlice id="basin">
            {(showBasinRivers || showBasinBorder) && (
              <HydroBasinLayer
                terrain={terrain}
                exaggeration={exaggeration}
                bounds={location.bounds}
                riversUrl={`${dataBase}/basin_rivers.json`}
                boundaryUrl={`${dataBase}/basin_boundary.json`}
                colorBy={basinColorBy}
                dischargeScale={basinDischargeScale}
                minOrder={basinMinOrder}
                showRivers={showBasinRivers}
                showBoundary={showBasinBorder || !location.highlightBasin}
                highlightBoundary={showBasinBorder && !!location.highlightBasin}
                riversIntensity={iv('basinRivers')}
                boundaryIntensity={iv('basinBorder')}
                onExtent={setBasinSceneRadius}
                onSelect={showEmbeddings ? undefined : (f) => { closeAllPopups(); setSelectedBasinRiver(f); }}
              />
            )}
            </StackSlice>
            <StackSlice id="buildings">
            <LayerFade intensity={iv('buildings')}>
{showOsmBuildings && (
              <OsmBuildingsLayer terrain={terrain} exaggeration={exaggeration} bounds={location.bounds} dataUrl={`${dataBase}/buildings.json`} />
            )}
</LayerFade>
            </StackSlice>
            <StackSlice id="glacier">
            <LayerFade intensity={iv('glacier')}>
{showGlacier && location.hasGlacierData && (
              <GlacierOutlineLayer
                terrain={terrain}
                exaggeration={exaggeration}
                bounds={location.bounds}
                dataUrl={`${dataBase}/all_glaciers.json`}
                thicknessUrl={showIceThickness && location.hasIceThickness ? `${dataBase}/ice_thickness.json` : undefined}
                onSelect={(f) => { closeAllPopups(); setSelectedGlacier(f); }}
                onThickness={setThicknessInfo}
              />
            )}
</LayerFade>
            {showRetreat && location.hasGlacierData && (
              <GlacierRetreatLayer
                terrain={terrain}
                exaggeration={exaggeration}
                bounds={location.bounds}
                outlineUrl={`${dataBase}/all_glaciers.json`}
                retreatMeters={retreatMeters}
              />
            )}
            </StackSlice>
            <StackSlice id="canals">
            <LayerFade intensity={iv('canals')}>
{showCanals && location.hasCanalData && (
              <IrrigationCanalsLayer
                terrain={terrain}
                exaggeration={exaggeration}
                bounds={location.bounds}
                dataUrl={`${dataBase}/water_accounting.json`}
                onSelectCanal={(c) => { closeAllPopups(); setSelectedCanal(c); }}
                onSelectReservoir={(r) => { closeAllPopups(); setSelectedReservoir(r); }}
              />
            )}
</LayerFade>
            </StackSlice>
            <StackSlice id="inat">
            <LayerFade intensity={iv('inat')}>
{showInat && (
              <InaturalistLayer
                terrain={terrain}
                exaggeration={exaggeration}
                bounds={location.bounds}
                queryBounds={location.waterBounds ?? location.bounds}
                selectedId={selectedInat?.id ?? null}
                onSelect={(o) => selectInat(o, true)}
                onObservationsLoaded={setInatObs}
              />
            )}
</LayerFade>
            </StackSlice>
            <StackSlice id="population">
            {populationVisible && (
              <OsmPopulationLayer
                terrain={terrain}
                exaggeration={exaggeration}
                dataUrl={`${dataBase}/population_density.json`}
                opacity={popOpacity}
                intensity={popIntensity}
                onLoad={setPopGrid}
                onSettled={() => setPopLoaded(true)}
              />
            )}
            </StackSlice>
            <StackSlice id="places">
{showPlaces && (
              <OsmPlacesLayer
                terrain={terrain}
                exaggeration={exaggeration}
                bounds={location.bounds}
                dataUrl={`${dataBase}/places.json`}
                queryBounds={location.waterBounds ?? location.bounds}
                onLoaded={() => setPlacesLoaded(true)}
                intensity={iv('places')}
              />
            )}
            </StackSlice>
            <StackSlice id="ski">
            <LayerFade intensity={iv('ski')}>
            {showSki && location.hasSkiData && (
              <SkiLayer terrain={terrain} exaggeration={exaggeration} bounds={location.bounds} dataUrl={`${dataBase}/ski.json`} />
            )}
            </LayerFade>
            </StackSlice>
            <StackSlice id="plan">
            <LayerFade intensity={iv('plan')}>
            {showMasterPlan && location.hasMasterPlan && (
              <MasterPlanLayer terrain={terrain} exaggeration={exaggeration} bounds={location.bounds} dataUrl={`${dataBase}/master_plan/master_plan.json`} />
            )}
            </LayerFade>
            </StackSlice>
            <StackSlice id="peaks">
            <LayerFade intensity={iv('peaks')}>
            {showPeaks && location.hasPeaks && (
              <PeaksLayer terrain={terrain} exaggeration={exaggeration} bounds={location.bounds} dataUrl={`${dataBase}/peaks.json`} />
            )}
            </LayerFade>
            </StackSlice>

            <StackSlice id="roads">
            <LayerFade intensity={iv('roads')}>
<OsmLinesLayer
              terrain={terrain}
              exaggeration={exaggeration}
              bounds={location.bounds}
              clipBounds={location.waterBounds ?? location.bounds}
              enabled={showRoads}
              cacheKey="osm-roads"
              dataUrl={`${dataBase}/roads.json`}
              color="#ffffff"
              opacity={0.65}
              lineWidth={1.1}
              buildQuery={(bbox) => `[out:json][timeout:60];
                (
                  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|track)$"](${bbox});
                );
                out geom;`}
            />
</LayerFade>
            </StackSlice>
            <StackSlice id="borders">
            <LayerFade intensity={iv('borders')}>
{/* National borders only. */}
            <OsmLinesLayer
              terrain={terrain}
              exaggeration={exaggeration}
              bounds={location.bounds}
              clipBounds={location.waterBounds ?? location.bounds}
              enabled={showBorders}
              cacheKey="osm-borders-national"
              dataUrl={`${dataBase}/borders_national.json`}
              color={renderMode ? '#ffffff' : '#e05fd0'}
              opacity={0.7}
              lineWidth={1.6}
              buildQuery={(bbox) => `[out:json][timeout:60];
                (
                  relation["boundary"="administrative"]["admin_level"="2"](${bbox});
                );
                out geom;`}
            />
            </LayerFade>
            </StackSlice>
            <StackSlice id="resources">
            <LayerFade intensity={iv('resources')}>
{/* Resource extraction: mining/quarries, oil & gas, logging, industrial areas. */}
            <ResourcesLayer
              terrain={terrain}
              exaggeration={exaggeration}
              bounds={location.bounds}
              clipBounds={location.waterBounds ?? location.bounds}
              enabled={showResources}
              dataUrl={`${dataBase}/resources.json`}
              selectedKey={selectedResource ? `${selectedResource.kind}-${selectedResource.id}` : null}
              onSelect={(r) => selectResource(r, true)}
              onData={setResourceObs}
            />
            {/* Pipelines — reuses the generic line layer. */}
            <OsmLinesLayer
              terrain={terrain}
              exaggeration={exaggeration}
              bounds={location.bounds}
              clipBounds={location.waterBounds ?? location.bounds}
              enabled={showResources}
              cacheKey="osm-pipelines"
              color="#eab308"
              opacity={0.55}
              lineWidth={1.2}
              buildQuery={(bbox) => `[out:json][timeout:60];
                (
                  way["man_made"="pipeline"](${bbox});
                );
                out geom;`}
            />
</LayerFade>
            </StackSlice>
          </ExplodedStack>
        )}
      </Canvas>
      </div>

      {/* Single full-screen loader covering all initial assets — one stable spinner/label, no mode-switching. */}
      {assetsLoading && (
        <div className="absolute inset-0 z-30 grid place-items-center bg-background/95 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
            <div className="text-sm tech-font text-muted-foreground uppercase tracking-widest">
              Loading {location.label}…
            </div>
          </div>
        </div>
      )}

      {/* iNaturalist photo grid — click a photo to fly the camera to it. */}
      {/* Same bloom-glow language as the observation popup below: dark
          ground, warm highlight wash, gold small-caps/tech-font labels.
          One filtered <img> per tile (not the popup's stacked blur+lighten
          layers) — with up to hundreds of tiles on screen, three images per
          card would multiply DOM/image load cost for a difference that's
          barely visible at thumbnail size. */}
      {showInatGrid && (
        <div className="absolute inset-0 z-[95] overflow-y-auto bg-background/97 backdrop-blur-md">
          <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-2.5 bg-background/90 backdrop-blur border-b border-border/60">
            <div className="flex items-baseline gap-2">
              <span className="uppercase tracking-[0.2em] text-[10px] tech-font text-primary">iNaturalist</span>
              <span className="text-[11px] text-muted-foreground font-mono">
                {inatObs.filter((o) => o.photoUrl).length} photos
              </span>
            </div>
            <button
              onClick={() => setShowInatGrid(false)}
              className="p-1.5 rounded border border-border/60 hover:bg-accent text-muted-foreground hover:text-foreground"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
            {inatObs.filter((o) => o.photoUrl).map((o) => (
              <button
                key={o.id}
                onClick={() => flyToObservation(o)}
                className="group relative aspect-square text-left overflow-hidden"
                title={`${o.commonName ?? o.species ?? 'Observation'} — click to fly there`}
              >
                {/* Same bloom treatment as the popup: blurred glow copy underneath,
                    the sharp image laid over it with reduced opacity in 'lighten'
                    blend so it reads as luminous/translucent rather than a flat photo. */}
                <img
                  src={o.photoUrl ?? ''}
                  alt=""
                  aria-hidden
                  className="absolute inset-0 w-full h-full object-cover scale-110"
                  style={{ filter: 'blur(16px) saturate(1.6) brightness(1.4)', opacity: 0.75, mixBlendMode: 'screen' }}
                />
                <img
                  src={o.photoUrl ?? ''}
                  alt={o.commonName ?? o.species ?? 'iNaturalist observation'}
                  loading="lazy"
                  className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                  style={{ filter: 'contrast(1.25) saturate(1.35) brightness(1.1)', mixBlendMode: 'lighten', opacity: 0.82 }}
                />
                {/* Warm bloom highlight, same as the popup's */}
                <div
                  className="absolute inset-0 pointer-events-none"
                  style={{
                    background: 'radial-gradient(ellipse at 40% 30%, rgba(255,240,200,0.35), transparent 60%)',
                    mixBlendMode: 'screen',
                  }}
                />
                {/* Text centered on the image, large — allowed to overlap the photo. */}
                <div
                  className="absolute inset-0 flex flex-col items-center justify-center text-center px-2 pointer-events-none"
                  style={{
                    textShadow: '0 0 3px rgba(255,255,255,0.9), 0 0 14px rgba(255,255,255,0.6), 0 0 30px rgba(255,220,140,0.4), 0 2px 16px rgba(0,0,0,0.6)',
                  }}
                >
                  <div className="uppercase tracking-[0.2em] text-[10px] tech-font" style={{ color: '#ffe08a' }}>
                    {o.iconicTaxon ?? 'Life'} · #{o.id}
                  </div>
                  <div className="text-lg font-semibold leading-tight" style={{ color: '#fffdf3' }}>
                    {o.commonName ?? o.species ?? 'Observation'}
                  </div>
                </div>
                <div className="absolute inset-0 flex items-end justify-center pb-3 bg-black/0 group-hover:bg-black/20 transition-colors">
                  <span className="opacity-0 group-hover:opacity-100 tech-font text-[10px] uppercase tracking-wide transition-opacity" style={{ color: '#ffe08a', textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>
                    fly here →
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Header */}
      <div className="absolute top-3 left-3 flex items-center gap-2 pointer-events-none">
        <DropdownMenu>
          <DropdownMenuTrigger className="px-3 py-1.5 rounded-md bg-background/80 backdrop-blur border border-border/60 pointer-events-auto text-left hover:bg-accent transition-colors">
            <div className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground tech-font">
              Location
            </div>
            <div className="display-font text-3xl leading-none">{location.label}</div>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuLabel>Locations</DropdownMenuLabel>
            {LOCATIONS.map((l) => (
              <DropdownMenuItem key={l.slug} asChild disabled={l.slug === location.slug}>
                <Link to={`/${l.slug}`}>{l.label}</Link>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {error && (
          <div className="px-2 py-1 rounded-md bg-destructive/10 border border-destructive/40 text-destructive text-xs pointer-events-auto">
            {error}
          </div>
        )}
      </div>

      {(embeddingBaseUrl || sentinelBaseUrl) && !hideMenu && <div className="absolute bottom-16 left-3 z-20 flex gap-2">
        {embeddingBaseUrl && <button className={`${btnBase} ${showEmbeddings ? 'text-primary border-primary/50' : ''}`} aria-pressed={showEmbeddings} onClick={() => { if (!showEmbeddings) { closeAllPopups(); setShowSentinel(false); } setShowEmbeddings(!showEmbeddings); }}>
          <Crosshair className="w-3.5 h-3.5" /> Embeddings
        </button>}
        {sentinelBaseUrl && <button className={`${btnBase} ${showSentinel ? 'text-primary border-primary/50' : ''}`} aria-pressed={showSentinel} onClick={() => { if (!showSentinel) { closeAllPopups(); setShowEmbeddings(false); } setShowSentinel(!showSentinel); }}>
          <History className="w-3.5 h-3.5" /> Sentinel change
        </button>}
      </div>}
      {showSentinel && sentinelBaseUrl && <SentinelChangePanel explorer={sentinel} onClose={() => setShowSentinel(false)} />}
      {showPlanImage && location.hasMasterPlan && (
        <figure aria-label="Resort master plan" className="absolute right-3 bottom-16 z-[120] w-[min(36rem,calc(100vw-1.5rem))] rounded-md border border-border bg-background/95 p-2 shadow-lg backdrop-blur text-xs space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold">Master plan · Almaty Superski</span>
            <button className="rounded border border-border px-2 py-0.5 hover:bg-accent" aria-label="Close master plan image" onClick={() => setShowPlanImage(false)}>×</button>
          </div>
          <img src={`${dataBase}/master_plan/plan.webp`} alt="Almaty Superski master plan, oblique view from the north" className="w-full rounded" />
          <figcaption className="text-[10px] leading-relaxed text-muted-foreground">
            Source: Kazakh Tourism Development. Oblique view, south at the top. Lifts and stations on the terrain are an approximate trace: dashed / ≈ items may be off by 1 km or more.
          </figcaption>
        </figure>
      )}
      {showSentinel && sentinel.split !== null && (
        <div className="absolute inset-y-0 pointer-events-none border-l-2 border-white/90" style={{ left: `${sentinel.split * 100}%` }}>
          <div className="absolute top-16 right-2 whitespace-nowrap rounded bg-background/90 px-2 py-1 text-xs">{sentinel.yearA}</div>
          <div className="absolute top-16 left-2 whitespace-nowrap rounded bg-background/90 px-2 py-1 text-xs">{sentinel.yearB}</div>
        </div>
      )}
      {showEmbeddings && embeddingBaseUrl && <SatelliteEmbeddingPanel explorer={embeddings} timeline={embeddingTimeline} search={embeddingSearch} onOpenMatch={openEmbeddingMatch} onClose={() => setShowEmbeddings(false)} />}
      {showEmbeddings && embeddings.mode === 'change' && embeddings.changeView === 'swipe' && embeddings.secondRaster && (
        <div className="absolute inset-y-0 pointer-events-none border-l-2 border-white/90" style={{ left: `${embeddings.swipe * 100}%` }}>
          <div className="absolute top-16 right-2 whitespace-nowrap rounded bg-background/90 px-2 py-1 text-xs">{embeddings.year}</div>
          <div className="absolute top-16 left-2 whitespace-nowrap rounded bg-background/90 px-2 py-1 text-xs">{embeddings.comparisonYear}</div>
        </div>
      )}

      {/* Toolbar */}
      <div className="absolute top-3 right-3 flex items-center gap-2">
        <button
          onClick={() => setHideMenu((h) => !h)}
          className={`${btnBase} order-last`}
          title={hideMenu ? 'Show menu' : 'Hide menu'}
        >
          {hideMenu ? <PanelTopOpen className="w-3.5 h-3.5" /> : <PanelTopClose className="w-3.5 h-3.5" />}
          {hideMenu ? null : 'Hide'}
        </button>
        {!hideMenu && (<>
        {/* Exploded layer stack */}
        <div className="flex items-center">
          <button
            onClick={() => setExploded((v) => !v)}
            className={`${btnBase} ${exploded ? 'text-primary border-primary/50 rounded-r-none' : ''}`}
            aria-pressed={exploded}
            title="Lift every layer onto its own floor"
          >
            <Layers3 className="w-3.5 h-3.5" /> Stack
          </button>
          {exploded && (
            <Popover>
              <PopoverTrigger className={`${btnBase} rounded-l-none border-l-0 px-2`} title="Stack settings">
                <Sliders className="w-3.5 h-3.5" />
              </PopoverTrigger>
              <PopoverContent align="end" className="w-60 space-y-3">
                <Slider label="Spacing" value={stackGap} min={0.3} max={4} step={0.1} onChange={setStackGap} format={(v) => v.toFixed(1)} />
                <Slider label="Relief" value={stackFlatten} min={0} max={1} step={0.05} onChange={setStackFlatten} format={(v) => `${Math.round(v * 100)}%`} />
              </PopoverContent>
            </Popover>
          )}
        </div>
        {/* Layers */}
        <DropdownMenu>
          <DropdownMenuTrigger className={btnBase}>
            <Layers className="w-3.5 h-3.5" /> Layers
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuLabel>Overlays</DropdownMenuLabel>
            <LayerRow checked={showWater} onChecked={setShowWater} value={iv('water')} onValue={(v) => setIv('water', v)}>
              Water{showEmbeddings ? ' · paused for Embeddings' : ''}
            </LayerRow>
            <LayerRow checked={showLakes} onChecked={setShowLakes} value={iv('lakes')} onValue={(v) => setIv('lakes', v)}>
              Lakes (natural &amp; artificial){showEmbeddings ? ' · paused for Embeddings' : ''}
            </LayerRow>
            <LayerRow checked={showBasinRivers} onChecked={setShowBasinRivers} value={iv('basinRivers')} onValue={(v) => setIv('basinRivers', v)}>
              Basin rivers (HydroSHEDS)
            </LayerRow>
            {location.highlightBasin && (
              <LayerRow checked={showBasinBorder} onChecked={setShowBasinBorder} value={iv('basinBorder')} onValue={(v) => setIv('basinBorder', v)}>
                Basin border
              </LayerRow>
            )}
            <LayerRow checked={showOsmBuildings} onChecked={setShowOsmBuildings} value={iv('buildings')} onValue={(v) => setIv('buildings', v)}>
              Buildings
            </LayerRow>
            {location.hasGlacierData && (
              <LayerRow checked={showGlacier} onChecked={setShowGlacier} value={iv('glacier')} onValue={(v) => setIv('glacier', v)}>
                Glacier extent (GLIMS)
              </LayerRow>
            )}
            {location.hasGlacierData && location.hasIceThickness && (
              <DropdownMenuCheckboxItem checked={showIceThickness} onCheckedChange={(v) => setShowIceThickness(!!v)}>
                Color by ice thickness (Farinotti)
              </DropdownMenuCheckboxItem>
            )}
            {location.hasCanalData && (
              <LayerRow checked={showCanals} onChecked={setShowCanals} value={iv('canals')} onValue={(v) => setIv('canals', v)}>
                Irrigation canals &amp; reservoirs (ICWC)
              </LayerRow>
            )}
            <DropdownMenuSeparator />
            <LayerRow checked={showInat} onChecked={setShowInat} value={iv('inat')} onValue={(v) => setIv('inat', v)}>
              iNaturalist observations
            </LayerRow>
            <LayerRow checked={showPopulation} onChecked={setShowPopulation} value={popIntensity} onValue={setPopIntensity} max={4}>
              Population density{showEmbeddings ? ' (paused for Embeddings)' : ''}
            </LayerRow>
            <LayerRow checked={showPlaces} onChecked={setShowPlaces} value={iv('places')} onValue={(v) => setIv('places', v)}>
              Towns & villages
            </LayerRow>
            {location.hasPeaks && (
              <LayerRow checked={showPeaks} onChecked={setShowPeaks} value={iv('peaks')} onValue={(v) => setIv('peaks', v)}>
                Peaks &amp; passes (OSM)
              </LayerRow>
            )}
            {location.hasSkiData && (
              <LayerRow checked={showSki} onChecked={setShowSki} value={iv('ski')} onValue={(v) => setIv('ski', v)}>
                Ski lifts &amp; pistes (OSM)
              </LayerRow>
            )}
            {location.hasMasterPlan && (
              <LayerRow checked={showMasterPlan} onChecked={setShowMasterPlan} value={iv('plan')} onValue={(v) => setIv('plan', v)}>
                Resort master plan (approx.)
              </LayerRow>
            )}
            {location.hasMasterPlan && (
              <DropdownMenuCheckboxItem checked={showPlanImage} onCheckedChange={(v) => setShowPlanImage(!!v)}>
                Show original plan image
              </DropdownMenuCheckboxItem>
            )}
            <DropdownMenuSeparator />
            <LayerRow checked={showRoads} onChecked={setShowRoads} value={iv('roads')} onValue={(v) => setIv('roads', v)}>
              Roads
            </LayerRow>
            <LayerRow checked={showBorders} onChecked={setShowBorders} value={iv('borders')} onValue={(v) => setIv('borders', v)}>
              Borders
            </LayerRow>
            <LayerRow checked={showResources} onChecked={setShowResources} value={iv('resources')} onValue={(v) => setIv('resources', v)}>
              Resources (mining / oil & gas / logging)
            </LayerRow>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={(e) => { e.preventDefault(); copyIntensityJson(); }}>
              {copied?.startsWith('{') ? 'Copied intensity JSON ✓' : 'Copy intensity values as JSON'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* View mode */}
        <Popover>
          <PopoverTrigger className={`${btnBase} ${terrainStyle !== 'none' ? 'text-primary border-primary/50' : ''}`}>
            <Eye className="w-3.5 h-3.5" /> View
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">Terrain</div>
              <label className="flex items-center gap-1.5 text-[11px] cursor-pointer">
                <input
                  type="checkbox"
                  checked={showTerrain}
                  onChange={(e) => setShowTerrain(e.target.checked)}
                />
                Show
              </label>
            </div>
            <div className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">Overlay</div>
            <div className="grid grid-cols-4 gap-1 text-[11px]">
              {(['none','contours','mesh','vectors'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setTerrainStyle(m)}
                  className={`px-2 py-1 rounded border ${terrainStyle === m ? 'bg-primary text-primary-foreground border-primary' : 'border-border/60 hover:bg-accent'}`}
                >
                  {m === 'none' ? 'Off' : m === 'contours' ? 'Contour' : m === 'mesh' ? 'Mesh' : 'Vectors'}
                </button>
              ))}
            </div>
            {terrainStyle === 'contours' && (
              <Slider label="Interval" value={contourInterval} min={5} max={200} step={5}
                onChange={setContourInterval} format={(v) => `${v}m`} />
            )}
            {terrainStyle === 'vectors' && (
              <Slider label="Spacing" value={vectorInterval} min={10} max={400} step={5}
                onChange={setVectorInterval} format={(v) => `${v}m`} />
            )}
            {terrainStyle === 'mesh' && (
              <Slider label="Spacing" value={meshInterval} min={5} max={400} step={5}
                onChange={setMeshInterval} format={(v) => `${v}m`} />
            )}
          </PopoverContent>
        </Popover>

        {/* Image adjust */}
        <Popover>
          <PopoverTrigger className={btnBase}>
            <Sliders className="w-3.5 h-3.5" /> Image
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 space-y-2 max-h-[80vh] overflow-y-auto">
            <div className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">Terrain</div>
            <Slider label="Exaggeration" value={exaggeration} min={1} max={300} step={1}
              onChange={setExaggeration} format={(v) => `${v}×`} />

            <div className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground pt-2">Basemap</div>
            <Slider label="Brightness" value={brightness} min={0.2} max={6} step={0.05}
              onChange={setBrightness} format={(v) => v.toFixed(2)} />
            <Slider label="Contrast" value={contrast} min={0.2} max={5} step={0.05}
              onChange={setContrast} format={(v) => v.toFixed(2)} />
            <Slider label="Saturation" value={saturation} min={0} max={5} step={0.05}
              onChange={setSaturation} format={(v) => v.toFixed(2)} />
            <Slider label="Gamma" value={gamma} min={0.2} max={5} step={0.05}
              onChange={setGamma} format={(v) => v.toFixed(2)} />
            <div className="flex items-center gap-2 text-[11px]">
              <span className="text-muted-foreground w-20 shrink-0">Tint</span>
              <input type="color" value={tint} onChange={(e) => setTint(e.target.value)}
                className="h-6 w-8 rounded border border-border/60 bg-transparent p-0" />
              <input type="range" min={0} max={1} step={0.01} value={tintStrength}
                onChange={(e) => setTintStrength(parseFloat(e.target.value))} className="flex-1" />
              <span className="font-mono w-10 text-right">{tintStrength.toFixed(2)}</span>
            </div>
            <button
              onClick={resetBasemap}
              className="w-full mt-1 text-[11px] px-2 py-1 rounded border border-border/60 hover:bg-accent"
            >
              Reset basemap
            </button>

            <div className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground pt-2">Population heatmap (GHS-POP)</div>
            <Slider label="Opacity" value={popOpacity} min={0} max={1} step={0.02}
              onChange={setPopOpacity} format={(v) => v.toFixed(2)} />

            {showBasinRivers && (
              <>
                <div className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground pt-2">Basin rivers (HydroSHEDS)</div>
                <div className="grid grid-cols-2 gap-1 text-[11px]">
                  <button
                    onClick={() => setBasinColorBy('order')}
                    className={`px-2 py-1 rounded border ${basinColorBy === 'order' ? 'bg-primary text-primary-foreground border-primary' : 'border-border/60 hover:bg-accent'}`}
                  >
                    By order
                  </button>
                  <button
                    onClick={() => setBasinColorBy('discharge')}
                    className={`px-2 py-1 rounded border ${basinColorBy === 'discharge' ? 'bg-primary text-primary-foreground border-primary' : 'border-border/60 hover:bg-accent'}`}
                  >
                    By discharge
                  </button>
                </div>
                {basinColorBy === 'discharge' && (
                  <div className="grid grid-cols-2 gap-1 text-[11px]">
                    <button
                      onClick={() => setBasinDischargeScale('log')}
                      className={`px-2 py-1 rounded border ${basinDischargeScale === 'log' ? 'bg-primary text-primary-foreground border-primary' : 'border-border/60 hover:bg-accent'}`}
                    >
                      Log scale
                    </button>
                    <button
                      onClick={() => setBasinDischargeScale('linear')}
                      className={`px-2 py-1 rounded border ${basinDischargeScale === 'linear' ? 'bg-primary text-primary-foreground border-primary' : 'border-border/60 hover:bg-accent'}`}
                    >
                      Linear scale
                    </button>
                  </div>
                )}
                <Slider label="Min order" value={basinMinOrder} min={3} max={7} step={1}
                  onChange={setBasinMinOrder} format={(v) => `${v}`} />
                <div className="text-[10px] text-muted-foreground leading-snug">
                  {basinColorBy === 'discharge'
                    ? (basinDischargeScale === 'linear'
                      ? 'Width/color by average discharge (m³/s), true scale — small tributaries nearly vanish next to the mainstem.'
                      : 'Width/color by average discharge (m³/s), log scale — thicker & darker = more water.')
                    : 'Width/color by Strahler stream order — thicker = more upstream tributaries.'}
                  {' '}Click a river for its numbers.
                </div>
              </>
            )}
          </PopoverContent>
        </Popover>

        {/* Flyover: keyframe path playback + video export */}
        <Popover>
          <PopoverTrigger className={`${btnBase} ${keyframes.length > 0 ? 'text-primary border-primary/50' : ''}`}>
            <Video className="w-3.5 h-3.5" /> Flyover
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground">
                Keyframes ({keyframes.length})
              </div>
              <div className="flex gap-1">
                <button onClick={addKeyframe} className="p-1 rounded border border-border/60 hover:bg-accent" title="Add keyframe from current view">
                  <Plus className="w-3.5 h-3.5" />
                </button>
                <button onClick={useOrbitPreset} className="p-1 rounded border border-border/60 hover:bg-accent" title="Generate 360° orbit around current target">
                  <RotateCw className="w-3.5 h-3.5" />
                </button>
                <button onClick={clearKeyframes} disabled={keyframes.length === 0} className="p-1 rounded border border-border/60 hover:bg-accent disabled:opacity-40" title="Clear all">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {keyframes.length > 0 ? (
              <div className="max-h-32 overflow-y-auto space-y-1">
                {keyframes.map((k, i) => (
                  <div key={k.id} className="flex items-center justify-between text-[11px] px-2 py-1 rounded bg-accent/40">
                    <span>#{i + 1}</span>
                    <button onClick={() => removeKeyframe(k.id)} className="text-muted-foreground hover:text-destructive">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[11px] text-muted-foreground">
                Navigate the view, then add keyframes to build a path — or generate an orbit.
              </div>
            )}

            <Slider label="Duration" value={flyDuration} min={2} max={40} step={1}
              onChange={setFlyDuration} format={(v) => `${v}s`} />

            <button
              onClick={playPreview}
              disabled={keyframes.length < 2 || isFlying}
              className="w-full flex items-center justify-center gap-1.5 text-[11px] px-2 py-1.5 rounded border border-border/60 hover:bg-accent disabled:opacity-40"
            >
              <Play className="w-3.5 h-3.5" /> {isFlying && !isRecording ? 'Playing…' : 'Preview'}
            </button>

            <div className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground pt-1">Export</div>
            <div className="grid grid-cols-3 gap-1 text-[11px]">
              {(Object.keys(ASPECTS) as AspectKey[]).map((a) => (
                <button
                  key={a}
                  onClick={() => setExportAspect(a)}
                  disabled={isRecording}
                  className={`px-2 py-1 rounded border disabled:opacity-40 ${exportAspect === a ? 'bg-primary text-primary-foreground border-primary' : 'border-border/60 hover:bg-accent'}`}
                >
                  {ASPECTS[a].label}
                </button>
              ))}
            </div>
            <button
              onClick={startRecording}
              disabled={keyframes.length < 2 || isRecording}
              className="w-full flex items-center justify-center gap-1.5 text-[11px] px-2 py-1.5 rounded border border-destructive/50 text-destructive hover:bg-destructive/10 disabled:opacity-40"
            >
              <Circle className={`w-3.5 h-3.5 ${isRecording ? 'animate-pulse fill-current' : ''}`} />
              {isRecording ? 'Recording…' : `Record ${ASPECTS[exportAspect].w}×${ASPECTS[exportAspect].h}`}
            </button>
          </PopoverContent>
        </Popover>

        <button
          className={`${btnBase} ${waterFlowActive ? 'text-primary border-primary/50' : ''}`}
          onClick={() => setWaterFlowActive((a) => !a)}
          title="Click on terrain to pour water"
        >
          <Waves className="w-3.5 h-3.5" />
          {waterFlowActive ? 'Pouring…' : 'Water flow'}
        </button>

        <button
          className={`${btnBase} ${showInatGrid ? 'text-primary border-primary/50' : ''}`}
          onClick={() => setShowInatGrid((v) => !v)}
          disabled={inatObs.length === 0}
          title="Browse iNaturalist photos, click one to fly there"
        >
          <LayoutGrid className="w-3.5 h-3.5" /> Grid
        </button>

        {location.slug === 'tuyuksu-glacier' && (
          <Link className={btnBase} to="/glacier-test?layer=model" title="Explore 3D ice geometry and imported glacier simulations">
            <Mountain className="w-3.5 h-3.5" /> 3D glacier
          </Link>
        )}

        {location.hasWaterBalance && (
          <button
            className={`${btnBase} ${showWaterBalance ? 'text-primary border-primary/50' : ''}`}
            aria-pressed={showWaterBalance}
            onClick={() => setShowWaterBalance((v) => !v)}
            title="Lake level: water-balance model hindcast and climate scenarios"
          >
            <Waves className="w-3.5 h-3.5" /> Lake level
          </button>
        )}

        {location.hasGlacierData && (
          <button
            className={`${btnBase} ${showMassBalance ? 'text-primary border-primary/50' : ''}`}
            onClick={() => setShowMassBalance((v) => !v)}
            title="Cumulative mass balance (WGMS)"
          >
            <Snowflake className="w-3.5 h-3.5" /> Mass balance
          </button>
        )}

        {location.hasGlacierData && (
          <button
            className={`${btnBase} ${showRetreat ? 'text-primary border-primary/50' : ''}`}
            onClick={() => setShowRetreat((v) => !v)}
            title="Historical terminus position (WGMS front variation)"
          >
            <History className="w-3.5 h-3.5" /> Retreat
          </button>
        )}

        <button
          className={btnBase}
          onClick={requestLocation}
          disabled={locating}
          title="Show my location"
        >
          {locating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Crosshair className="w-3.5 h-3.5" />}
          Locate me
        </button>

        <button
          className={`${btnBase} ${showInspector ? 'text-primary border-primary/50' : ''}`}
          onClick={() => setShowInspector((v) => !v)}
          title="Toggle inspector"
        >
          <Info className="w-3.5 h-3.5" /> Inspector
        </button>
        </>)}
      </div>

      {/* Population density value at clicked point */}
      {popPoint && (
        <div className="absolute top-16 right-3 w-64 p-3 rounded-md bg-background/90 backdrop-blur border border-border/60 text-xs font-mono z-10">
          <div className="flex items-center justify-between mb-2">
            <span className="uppercase tracking-widest text-[10px] text-primary">Population density</span>
            <button onClick={() => setPopPoint(null)} className="text-muted-foreground hover:text-foreground">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="text-lg font-sans font-semibold">
            {popPoint.value == null ? 'no data' : `${popPoint.value.toFixed(1)} people`}
          </div>
          <div className="text-[10px] text-muted-foreground">per ~100m pixel (GHS-POP 2020)</div>
          <div className="text-[10px] text-muted-foreground mt-1">
            {popPoint.lat.toFixed(6)}, {popPoint.lon.toFixed(6)}
          </div>
        </div>
      )}

      {/* Water feature info */}
      {selectedWater && (
        <div className="absolute top-16 right-3 w-72 p-3 rounded-md bg-background/90 backdrop-blur border border-border/60 text-xs font-mono z-10">
          <div className="flex items-center justify-between mb-2">
            <span className="uppercase tracking-widest text-[10px] text-primary">Water · {selectedWater.kind}</span>
            <button onClick={() => setSelectedWater(null)} className="text-muted-foreground hover:text-foreground">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="text-[10px] text-muted-foreground mb-1">
            id {String(selectedWater.id)}
          </div>
          {selectedWater.tags?.name && (
            <div className="text-sm font-sans font-semibold mb-1">{selectedWater.tags.name}</div>
          )}
          <div className="max-h-64 overflow-auto space-y-0.5">
            {Object.entries(selectedWater.tags).map(([k, v]) => (
              <div key={k} className="flex gap-2 leading-tight">
                <span className="text-muted-foreground shrink-0">{k}</span>
                <span className="break-all">{String(v)}</span>
              </div>
            ))}
            {Object.keys(selectedWater.tags).length === 0 && (
              <div className="text-muted-foreground">no tags</div>
            )}
          </div>
          <a
            className="mt-2 inline-block text-primary hover:underline"
            href={`https://www.openstreetmap.org/${String(selectedWater.id).includes('/') ? 'relation' : 'way'}/${String(selectedWater.id).split('/')[0]}`}
            target="_blank" rel="noreferrer"
          >
            open in OSM →
          </a>
        </div>
      )}

      {/* Lake — natural or artificial (reservoir/pond/basin), from the same OSM water data */}
      {selectedLake && (
        <div className="absolute top-16 right-3 w-72 p-3 rounded-md bg-background/90 backdrop-blur border border-border/60 text-xs font-mono z-10">
          <div className="flex items-center justify-between mb-2">
            <span className="uppercase tracking-widest text-[10px]" style={{ color: selectedLake.artificial ? '#2dd4bf' : '#38bdf8' }}>
              {selectedLake.waterType} · {selectedLake.artificial ? 'artificial' : 'natural'}
            </span>
            <button onClick={() => setSelectedLake(null)} className="text-muted-foreground hover:text-foreground">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="text-sm font-sans font-semibold mb-1">{selectedLake.name || selectedLake.waterType}</div>
          <div className="space-y-0.5">
            <div className="flex gap-2 leading-tight">
              <span className="text-muted-foreground shrink-0">area</span>
              <span>{selectedLake.areaKm2 < 0.1 ? (selectedLake.areaKm2 * 1e6).toFixed(0) + ' m²' : selectedLake.areaKm2.toFixed(2) + ' km²'}</span>
            </div>
            <div className="flex gap-2 leading-tight">
              <span className="text-muted-foreground shrink-0">coords</span>
              <span>{selectedLake.lat.toFixed(5)}, {selectedLake.lon.toFixed(5)}</span>
            </div>
            <div className="flex gap-2 leading-tight">
              <span className="text-muted-foreground shrink-0">id</span>
              <span>{String(selectedLake.id)}</span>
            </div>
          </div>
          <a
            className="mt-2 inline-block text-primary hover:underline"
            href={`https://www.openstreetmap.org/${String(selectedLake.id).includes('/') ? 'relation' : 'way'}/${String(selectedLake.id).split('/')[0]}`}
            target="_blank" rel="noreferrer"
          >
            open in OSM →
          </a>
        </div>
      )}

      {/* Irrigation canal — design capacity (not per-year actual data) */}
      {selectedCanal && (
        <div className="absolute top-16 right-3 w-72 p-3 rounded-md bg-background/90 backdrop-blur border border-border/60 text-xs font-mono z-10">
          <div className="flex items-center justify-between mb-2">
            <span className="uppercase tracking-widest text-[10px] text-primary">Irrigation canal</span>
            <button onClick={() => setSelectedCanal(null)} className="text-muted-foreground hover:text-foreground">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="text-sm font-sans font-semibold mb-1">{selectedCanal.name}</div>
          <div className="text-sm mb-1">{selectedCanal.capacity_m3s} m³/s design capacity</div>
          {selectedCanal.note && (
            <div className="text-[10px] text-muted-foreground leading-snug">{selectedCanal.note}</div>
          )}
          <div className="text-[10px] text-muted-foreground mt-2">
            Route is approximate (intake → endpoint city), not a surveyed alignment. Source: cawater-info.net.
          </div>
        </div>
      )}

      {/* Reservoir — real NIC ICWC seasonal water-balance figures */}
      {selectedReservoir && (
        <div className="absolute top-16 right-3 w-72 p-3 rounded-md bg-background/90 backdrop-blur border border-border/60 text-xs font-mono z-10">
          <div className="flex items-center justify-between mb-2">
            <span className="uppercase tracking-widest text-[10px] text-primary">Reservoir · NIC ICWC</span>
            <button onClick={() => setSelectedReservoir(null)} className="text-muted-foreground hover:text-foreground">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="text-sm font-sans font-semibold mb-1">{selectedReservoir.name}</div>
          <div className="text-[10px] text-muted-foreground mb-2">{selectedReservoir.river} · {selectedReservoir.period}</div>
          <div className="space-y-0.5">
            <div className="flex justify-between"><span className="text-muted-foreground">приток (факт)</span><span>{selectedReservoir.inflow_km3} км³</span></div>
            {selectedReservoir.inflow_plan_km3 != null && (
              <div className="flex justify-between"><span className="text-muted-foreground">приток (план)</span><span>{selectedReservoir.inflow_plan_km3} км³</span></div>
            )}
            <div className="flex justify-between"><span className="text-muted-foreground">попуск/выпуск</span><span>{selectedReservoir.release_km3} км³</span></div>
          </div>
          {selectedReservoir.note && (
            <div className="text-[10px] text-muted-foreground mt-2 leading-snug">{selectedReservoir.note}</div>
          )}
        </div>
      )}

      {/* Resource extraction — mining/oil&gas/logging/industrial (OSM).
          Same bloom-glow treatment + z-[90] as the iNat popup (see its
          comment above) so the two are visually consistent as the ambient
          carousel swaps between them, and so OsmPlacesLayer's <Html> labels
          don't punch through this corner either. */}
      {selectedResource && (
        <div className="absolute top-16 right-3 w-80 text-xs z-[90] pointer-events-none">
          <div className="pointer-events-auto">
            <div
              key={`${selectedResource.kind}-${selectedResource.id}`}
              className="relative w-full h-52 overflow-hidden animate-fade-in"
              style={{ transition: 'opacity 600ms ease-out' }}
            >
              <img
                src={selectedResource.imageUrl}
                alt=""
                aria-hidden
                className="absolute inset-0 w-full h-full object-cover scale-110"
                style={{ filter: 'blur(24px) saturate(1.6) brightness(1.4)', opacity: 0.75, mixBlendMode: 'screen' }}
              />
              <img
                src={selectedResource.imageUrl}
                alt={`Satellite view of ${selectedResource.label}`}
                className="relative w-full h-full object-cover"
                style={{
                  filter: 'contrast(1.25) saturate(1.35) brightness(1.1)',
                  mixBlendMode: 'lighten',
                  opacity: 0.78,
                  maskImage: 'radial-gradient(ellipse at center, black 55%, transparent 95%)',
                  WebkitMaskImage: 'radial-gradient(ellipse at center, black 55%, transparent 95%)',
                }}
                loading="lazy"
              />
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  backgroundImage:
                    "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.55 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")",
                  mixBlendMode: 'overlay',
                  opacity: 0.85,
                }}
              />
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  background: 'radial-gradient(ellipse at 40% 30%, rgba(255,240,200,0.35), transparent 60%)',
                  mixBlendMode: 'screen',
                }}
              />
              <button
                onClick={() => selectResource(null, true)}
                className="absolute top-2 right-2 p-1 rounded bg-background/60 backdrop-blur text-foreground hover:bg-background/90"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div
              className="pt-2 pl-1"
              style={{
                textShadow:
                  '0 0 2px rgba(255,255,255,0.9), 0 0 10px rgba(255,255,255,0.55), 0 0 22px rgba(255,220,140,0.35), 0 1px 12px rgba(0,0,0,0.55)',
              }}
            >
              <div className="uppercase tracking-[0.25em] text-[10px] tech-font" style={{ color: '#ffe08a' }}>
                {selectedResource.categoryLabel} · {selectedResource.subtype}
              </div>
              <div className="display-font text-2xl leading-tight mt-1" style={{ color: '#fffdf3' }}>
                {selectedResource.label}
              </div>
              <div className="mt-2 tech-font text-[10px] space-y-0.5" style={{ color: '#eae5d3' }}>
                <div>{selectedResource.kind === 'area' ? 'mapped area' : 'point feature'} · id {String(selectedResource.id)}</div>
                <div>{selectedResource.lat.toFixed(5)}, {selectedResource.lon.toFixed(5)}</div>
              </div>
              <div className="mt-2 flex gap-3">
                <a
                  className="inline-block hover:underline text-[11px] tech-font"
                  style={{ color: '#ffe08a' }}
                  href={`https://www.openstreetmap.org/${selectedResource.kind === 'area' ? 'way' : 'node'}/${selectedResource.id}`}
                  target="_blank" rel="noreferrer"
                >
                  view on OSM →
                </a>
                <a
                  className="inline-block hover:underline text-[11px] tech-font"
                  style={{ color: '#ffe08a' }}
                  href={`https://www.google.com/maps/search/?api=1&query=${selectedResource.lat},${selectedResource.lon}`}
                  target="_blank" rel="noreferrer"
                >
                  open in Google Maps →
                </a>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Glacier outline info (RGI 6.0 / GLIMS) */}
      {selectedGlacier && (
        <div className="absolute top-16 right-3 w-72 p-3 rounded-md bg-background/90 backdrop-blur border border-border/60 text-xs font-mono z-10">
          <div className="flex items-center justify-between mb-2">
            <span className="uppercase tracking-widest text-[10px] text-primary">Glacier · RGI 6.0</span>
            <button onClick={() => setSelectedGlacier(null)} className="text-muted-foreground hover:text-foreground">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="text-sm font-sans font-semibold mb-1">{selectedGlacier.name ?? 'Unnamed'}</div>
          <div className="space-y-0.5">
            <div className="flex gap-2 leading-tight">
              <span className="text-muted-foreground shrink-0">area</span>
              <span>{selectedGlacier.area_km2?.toFixed(3) ?? '—'} km²</span>
            </div>
            <div className="flex gap-2 leading-tight">
              <span className="text-muted-foreground shrink-0">elevation</span>
              <span>{selectedGlacier.zmin ?? '—'}–{selectedGlacier.zmax ?? '—'} m</span>
            </div>
            <div className="flex gap-2 leading-tight">
              <span className="text-muted-foreground shrink-0">RGI id</span>
              <span>{selectedGlacier.rgi_id ?? '—'}</span>
            </div>
            {showIceThickness && thicknessInfo && selectedGlacier.rgi_id === 'RGI60-13.08624' && (
              <>
                <div className="flex gap-2 leading-tight pt-1 border-t border-border/40 mt-1">
                  <span className="text-muted-foreground shrink-0">max ice depth</span>
                  <span>{thicknessInfo.maxThicknessM.toFixed(0)} m</span>
                </div>
                <div className="flex gap-2 leading-tight">
                  <span className="text-muted-foreground shrink-0">est. volume</span>
                  <span>{(thicknessInfo.volumeM3 / 1e6).toFixed(1)} million m³</span>
                </div>
                <div className="text-[10px] text-muted-foreground pt-0.5">Farinotti et al. 2019 consensus estimate (main glacier only)</div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Mass balance chart (WGMS FoG) */}
      {showWaterBalance && location.hasWaterBalance && (
        <WaterBalancePanel dataUrl={`${dataBase}/water_balance.json`} onLevel={setLakeLevel}
          areaFraction={lakeOverlay?.areaFraction ?? null} onClose={() => { setShowWaterBalance(false); setLakeLevel(null); }} />
      )}
      {showMassBalance && location.hasGlacierData && (
        <GlacierChartPanel dataUrl={`${dataBase}/mass_balance.json`} onClose={() => setShowMassBalance(false)} />
      )}

      {/* Historical terminus retreat (WGMS front variation) */}
      {showRetreat && location.hasGlacierData && (
        <GlacierRetreatPanel
          dataUrl={`${dataBase}/front_variation.json`}
          year={retreatYear}
          onYearChange={setRetreatYear}
          onRetreatChange={setRetreatMeters}
          onClose={() => setShowRetreat(false)}
        />
      )}

      {/* Basin river info (HydroSHEDS) */}
      {selectedBasinRiver && (
        <div className="absolute top-16 right-3 w-72 p-3 rounded-md bg-background/90 backdrop-blur border border-border/60 text-xs font-mono z-10">
          <div className="flex items-center justify-between mb-2">
            <span className="uppercase tracking-widest text-[10px] text-primary">Basin river · order {selectedBasinRiver.ord_stra ?? '—'}</span>
            <button onClick={() => setSelectedBasinRiver(null)} className="text-muted-foreground hover:text-foreground">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="text-lg font-sans font-semibold">
            {selectedBasinRiver.dis_av_cms != null ? `${selectedBasinRiver.dis_av_cms.toFixed(2)} m³/s` : 'no discharge data'}
          </div>
          <div className="text-[10px] text-muted-foreground mb-2">average discharge</div>
          <div className="space-y-0.5">
            <div className="flex gap-2 leading-tight">
              <span className="text-muted-foreground shrink-0">length</span>
              <span>{selectedBasinRiver.length_km?.toFixed(2) ?? '—'} km</span>
            </div>
            <div className="flex gap-2 leading-tight">
              <span className="text-muted-foreground shrink-0">Strahler order</span>
              <span>{selectedBasinRiver.ord_stra ?? '—'}</span>
            </div>
            <div className="flex gap-2 leading-tight">
              <span className="text-muted-foreground shrink-0">order class</span>
              <span>{selectedBasinRiver.ord_clas ?? '—'}</span>
            </div>
            <div className="flex gap-2 leading-tight">
              <span className="text-muted-foreground shrink-0">HydroRIVERS id</span>
              <span>{selectedBasinRiver.id}</span>
            </div>
          </div>
        </div>
      )}

      {/* iNaturalist observation card — no background, floats over map */}
      {/* Specimen-card style: a natural-history catalog label, not a glowing
          photo overlay — faded oversized catalog number, serif scientific
          name, small-caps field-note metadata (Obs./Coll./Loc.). */}
      {/* z-[90]: drei's <Html> place labels set their own z-index up to 80
          (see OsmPlacesLayer's zIndexRange), which otherwise punches through
          a plain z-20 overlay sitting at the same screen spot. */}
      {selectedInat && (
        <div className="absolute top-16 right-3 w-80 text-xs z-[90] pointer-events-none">
          <div className="pointer-events-auto">
            {selectedInat.photoUrl && (
              <div
                key={selectedInat.id}
                className="relative w-full h-52 overflow-hidden animate-fade-in"
                style={{ transition: 'opacity 600ms ease-out' }}
              >
                {/* Bloom glow */}
                <img
                  src={selectedInat.photoUrl}
                  alt=""
                  aria-hidden
                  className="absolute inset-0 w-full h-full object-cover scale-110"
                  style={{ filter: 'blur(24px) saturate(1.6) brightness(1.4)', opacity: 0.75, mixBlendMode: 'screen' }}
                />
                {/* Main image, noisy + bloom + overlay, transparent */}
                <img
                  src={selectedInat.photoUrl}
                  alt={selectedInat.commonName ?? selectedInat.species ?? 'iNaturalist observation'}
                  className="relative w-full h-full object-cover"
                  style={{
                    filter: 'contrast(1.25) saturate(1.35) brightness(1.1)',
                    mixBlendMode: 'lighten',
                    opacity: 0.78,
                    maskImage: 'radial-gradient(ellipse at center, black 55%, transparent 95%)',
                    WebkitMaskImage: 'radial-gradient(ellipse at center, black 55%, transparent 95%)',
                  }}
                  loading="lazy"
                />
                {/* SVG grain overlay */}
                <div
                  className="absolute inset-0 pointer-events-none"
                  style={{
                    backgroundImage:
                      "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.55 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")",
                    mixBlendMode: 'overlay',
                    opacity: 0.85,
                  }}
                />
                {/* Bloom highlight overlay */}
                <div
                  className="absolute inset-0 pointer-events-none"
                  style={{
                    background: 'radial-gradient(ellipse at 40% 30%, rgba(255,240,200,0.35), transparent 60%)',
                    mixBlendMode: 'screen',
                  }}
                />
                <button
                  onClick={() => selectInat(null, true)}
                  className="absolute top-2 right-2 p-1 rounded bg-background/60 backdrop-blur text-foreground hover:bg-background/90"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            <div
              className="pt-2 pl-1"
              style={{
                textShadow:
                  '0 0 2px rgba(255,255,255,0.9), 0 0 10px rgba(255,255,255,0.55), 0 0 22px rgba(255,220,140,0.35), 0 1px 12px rgba(0,0,0,0.55)',
              }}
            >
              <div className="uppercase tracking-[0.25em] text-[10px] tech-font" style={{ color: '#ffe08a' }}>
                iNat · {selectedInat.iconicTaxon ?? 'Life'} · #{selectedInat.id}
              </div>
              {selectedInat.commonName && (
                <div className="display-font text-3xl leading-tight mt-1" style={{ color: '#fffdf3' }}>
                  {selectedInat.commonName}
                </div>
              )}
              {selectedInat.species && (
                <div className="tech-font text-[11px] italic" style={{ color: '#f2eee0' }}>
                  {selectedInat.species}
                </div>
              )}
              <div className="mt-2 tech-font text-[10px] space-y-0.5" style={{ color: '#eae5d3' }}>
                {selectedInat.observedOn && <div>observed {selectedInat.observedOn}</div>}
                {selectedInat.user && <div>@{selectedInat.user}</div>}
                <div>{selectedInat.lat.toFixed(5)}, {selectedInat.lon.toFixed(5)}</div>
              </div>
              <a
                className="mt-2 inline-block hover:underline text-[11px] tech-font"
                style={{ color: '#ffe08a' }}
                href={selectedInat.url}
                target="_blank" rel="noreferrer"
              >
                open on iNaturalist →
              </a>
            </div>
          </div>
        </div>
      )}


      {/* Inspector */}
      {showInspector && (
        <div className="absolute bottom-3 right-3 px-3 py-2 rounded-md bg-background/80 backdrop-blur border border-border/60 text-xs tech-font min-w-[240px]">
          <div className="flex items-center justify-between gap-3 mb-1">
            <span className="uppercase tracking-widest text-[10px] text-muted-foreground">Inspector</span>
            {copied ? (
              <span className="flex items-center gap-1 text-primary">
                <Check className="w-3 h-3" /> copied
              </span>
            ) : (
              <span className="flex items-center gap-1 text-muted-foreground">
                <Copy className="w-3 h-3" /> click to copy
              </span>
            )}
          </div>

          <div className="text-[10px] uppercase tracking-widest text-muted-foreground mt-1">Cursor</div>
          {hover ? (
            <button
              className="block w-full text-left hover:text-primary leading-tight"
              onClick={() => copyCoords(hover)}
              title="Copy lat, lon"
            >
              <div>lat {hover.lat.toFixed(6)}</div>
              <div>lon {hover.lon.toFixed(6)}</div>
              <div className="text-muted-foreground">elev {hover.elev.toFixed(1)} m</div>
            </button>
          ) : (
            <div className="text-muted-foreground">hover terrain…</div>
          )}

          <div className="text-[10px] uppercase tracking-widest text-muted-foreground mt-2">Camera</div>
          {camera ? (
            <button
              className="block w-full text-left hover:text-primary leading-tight"
              onClick={() => copyText(
                `pos ${camera.pos.map((n) => n.toFixed(3)).join(', ')}\n` +
                `target ${camera.target.map((n) => n.toFixed(3)).join(', ')}\n` +
                `distance ${camera.distance.toFixed(3)}\n` +
                `heading ${camera.headingDeg.toFixed(1)}°\n` +
                `tilt ${camera.tiltDeg.toFixed(1)}°\n` +
                `fov ${camera.fov.toFixed(1)}°`
              )}
              title="Copy camera state"
            >
              <div>dist {camera.distance.toFixed(2)}</div>
              <div>hdg {camera.headingDeg.toFixed(1)}° · tilt {camera.tiltDeg.toFixed(1)}°</div>
              <div className="text-muted-foreground">fov {camera.fov.toFixed(0)}°</div>
              <div className="text-muted-foreground">
                pos {camera.pos.map((n) => n.toFixed(1)).join(',')}
              </div>
            </button>
          ) : (
            <div className="text-muted-foreground">—</div>
          )}
        </div>
      )}

      {waterFlowActive && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-md bg-background/80 backdrop-blur border border-primary/40 text-xs tech-font text-primary">
          click terrain to add water
        </div>
      )}

      {/* Compass — always points true north relative to the current camera orientation. */}
      <div className="absolute bottom-14 left-1/2 -translate-x-1/2 pointer-events-none opacity-80">
        <svg width="34" height="34" viewBox="0 0 34 34">
          <circle cx="17" cy="17" r="15.5" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1" className="text-foreground" />
          <g style={{ transform: `rotate(${-(camera?.headingDeg ?? 0)}deg)`, transformOrigin: '17px 17px', transition: 'transform 80ms linear' }}>
            <path d="M17 5 L20.5 17 L17 14.5 L13.5 17 Z" fill="currentColor" className="text-primary" />
            <path d="M17 29 L20 19 L17 21 L14 19 Z" fill="currentColor" fillOpacity="0.35" className="text-foreground" />
            <text x="17" y="10" textAnchor="middle" fontSize="6" fontWeight="700" className="tech-font fill-primary">N</text>
          </g>
        </svg>
      </div>

      {/* Attribution */}
      <div className="absolute bottom-1 left-2 text-[10px] font-mono text-muted-foreground/70">
        <span className="pointer-events-none">Elevation: Mapterhorn · Imagery: Satlas Super-Res 2023 (Allen Institute for AI) · Population: GHS-POP (JRC) · Rivers/basins: HydroSHEDS (Lehner &amp; Grill) · Glaciers: GLIMS/NSIDC, WGMS FoG &amp; Farinotti et al. 2019 ice thickness · Observations: iNaturalist · Data © OpenStreetMap contributors</span>
      </div>

    </div>
  );
}
