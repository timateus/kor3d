import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Navigate, Link, useLocation } from 'react-router-dom';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { Loader2, Layers, Waves, Crosshair, Mountain, ArrowRight, Copy, Check, Sliders, Eye, X, Info, Video, Plus, Trash2, Play, Circle, RotateCw, Snowflake, History } from 'lucide-react';
import { findLocation, LOCATIONS } from '@/lib/locations';
import { useMapterhornTerrain } from '@/hooks/useMapterhornTerrain';
import { useTerrainMode } from '@/hooks/useTerrainMode';
import MapboxTerrainMesh from '@/components/MapboxTerrainMesh';
import TerrainStyleOverlay, { type TerrainStyle } from '@/components/TerrainStyleOverlay';
import OsmWaterwaysLayer from '@/components/location/OsmWaterwaysLayer';
import HydroBasinLayer from '@/components/location/HydroBasinLayer';
import OsmPopulationLayer from '@/components/location/OsmPopulationLayer';
import OsmPlacesLayer from '@/components/location/OsmPlacesLayer';
import OsmLinesLayer from '@/components/location/OsmLinesLayer';
import ResourcesLayer from '@/components/location/ResourcesLayer';
import OsmBuildingsLayer from '@/components/location/OsmBuildingsLayer';
import InaturalistLayer, { type InatObservation } from '@/components/location/InaturalistLayer';
import GlacierOutlineLayer, { type GlacierFeatureProps, type ThicknessInfo } from '@/components/location/GlacierOutlineLayer';
import GlacierChartPanel from '@/components/location/GlacierChartPanel';
import GlacierRetreatLayer from '@/components/location/GlacierRetreatLayer';
import GlacierRetreatPanel from '@/components/location/GlacierRetreatPanel';
import FlyoverController from '@/components/location/FlyoverController';
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

export default function LocationPage() {
  const params = useParams<{ slug?: string }>();
  const routerLoc = useLocation();
  const slug = params.slug ?? routerLoc.pathname.replace(/^\//, '').split('/')[0];
  const location = slug ? findLocation(slug) : undefined;
  const { token } = useTerrainMode();
  const { terrain, loading, error } = useMapterhornTerrain(location?.bounds ?? null, !!location);

  const [exaggeration, setExaggeration] = useState(location?.exaggeration ?? 50);
  const [showInspector, setShowInspector] = useState(false);
  const [showTerrain, setShowTerrain] = useState(true);
  const [showWater, setShowWater] = useState(true);
  const [showPopulation, setShowPopulation] = useState(true);
  const [showPlaces, setShowPlaces] = useState(true);
  const [showOsmBuildings, setShowOsmBuildings] = useState(false);
  const [showRoads, setShowRoads] = useState(false);
  const [showBorders, setShowBorders] = useState(false);
  const [showResources, setShowResources] = useState(false);
  const [showBasinRivers, setShowBasinRivers] = useState(true);
  const [basinSceneRadius, setBasinSceneRadius] = useState<number | null>(null);
  const [showGlacier, setShowGlacier] = useState(!!location?.hasGlacierData);
  const [selectedGlacier, setSelectedGlacier] = useState<GlacierFeatureProps | null>(null);
  const [showMassBalance, setShowMassBalance] = useState(false);
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

  // Population heatmap
  const [popOpacity, setPopOpacity] = useState(0.75);
  const [popIntensity, setPopIntensity] = useState(1);

  const [waterFlowActive, setWaterFlowActive] = useState(false);
  const [flowState, setFlowState] = useState<WaterFlowState | null>(null);
  const [flowKey, setFlowKey] = useState(0);
  const [hover, setHover] = useState<HoverCoord | null>(null);
  const [camera, setCamera] = useState<CameraInfo | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [selectedWater, setSelectedWater] = useState<import('@/components/location/OsmWaterwaysLayer').WaterFeature | null>(null);
  const [selectedBasinRiver, setSelectedBasinRiver] = useState<import('@/components/location/HydroBasinLayer').RiverFeature | null>(null);
  const [basinColorBy, setBasinColorBy] = useState<'order' | 'discharge'>('discharge');
  const [basinMinOrder, setBasinMinOrder] = useState(3);
  const [selectedInat, setSelectedInat] = useState<InatObservation | null>(null);
  const [inatObs, setInatObs] = useState<InatObservation[]>([]);
  const [popGrid, setPopGrid] = useState<PopulationGrid | null>(null);
  const [popPoint, setPopPoint] = useState<{ lat: number; lon: number; value: number | null } | null>(null);
  const lastUserInteractRef = useRef<number>(Date.now());
  const flowLoopRef = useRef<number | null>(null);
  const orbitRef = useRef<any>(null);

  // Flyover: keyframe path playback + video export
  const [keyframes, setKeyframes] = useState<FlyKeyframe[]>([]);
  const [flyDuration, setFlyDuration] = useState(8);
  const [isFlying, setIsFlying] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
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
  // this was a manual user action.
  const selectInat = (o: InatObservation | null, manual: boolean) => {
    if (manual) lastUserInteractRef.current = Date.now();
    setSelectedInat(o);
  };

  // Auto-cycle: after 5s of no manual interaction, pick a random observation
  // and rotate every 2s until the user clicks something.
  useEffect(() => {
    if (inatObs.length === 0) return;
    let cancelled = false;
    let cycleTimer: number | null = null;

    const pickRandom = () => {
      if (cancelled || inatObs.length === 0) return;
      const idle = Date.now() - lastUserInteractRef.current;
      if (idle < 5000) return;
      const next = inatObs[Math.floor(Math.random() * inatObs.length)];
      setSelectedInat(next);
    };

    const check = () => {
      if (cancelled) return;
      const idle = Date.now() - lastUserInteractRef.current;
      if (idle >= 5000) pickRandom();
      cycleTimer = window.setTimeout(check, 4000);
    };
    cycleTimer = window.setTimeout(check, 5000);

    return () => {
      cancelled = true;
      if (cycleTimer) clearTimeout(cycleTimer);
    };
  }, [inatObs]);

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


  const addKeyframe = () => {
    if (!camera) return;
    setKeyframes((ks) => [...ks, { id: `kf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, pos: camera.pos, target: camera.target }]);
  };
  const removeKeyframe = (id: string) => setKeyframes((ks) => ks.filter((k) => k.id !== id));
  const clearKeyframes = () => setKeyframes([]);
  const useOrbitPreset = () => {
    if (!camera) return;
    setKeyframes(orbitKeyframes(camera.target, camera.distance, camera.tiltDeg, camera.headingDeg, 8));
  };

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

  // Single gate for the full-screen loader: terrain DEM, basemap imagery, and
  // the default-on data layers (water, population, places). Buildings/roads/
  // borders are off by default and don't block first paint.
  const assetsLoading =
    loading || texLoading ||
    (showWater && !waterLoaded) ||
    (showPopulation && !popLoaded) ||
    (showPlaces && !placesLoaded);

  return (
    <div className="fixed inset-0 bg-background text-foreground" style={{ fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace' }}>
      <style>{`
        .location-serif, .display-font { font-family: "Sora", ui-sans-serif, system-ui, sans-serif; font-weight: 800; letter-spacing: -0.02em; }
        .tech-font { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }
      `}</style>
      <div
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
        camera={{ position: [-4.2, 4.2, -1.9], fov: 45, near: 0.1, far: showBasinRivers ? basinFar : 300 }}
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
          enableDamping
          dampingFactor={0.06}
          minDistance={1.5}
          maxDistance={showBasinRivers ? basinMaxDistance : 110}
          maxPolarAngle={Math.PI / 2.05}
          mouseButtons={{ LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }}
        />
        <CameraProbe orbitRef={orbitRef} onChange={setCamera} />
        <CameraFarSync far={showBasinRivers ? basinFar : 300} />
        <RaycasterTuning />
        <FlyoverController keyframes={keyframes} playing={isFlying} duration={flyDuration} orbitRef={orbitRef} onDone={handleFlightDone} />

        {terrain && (
          <>
            <group
              onPointerMove={(e) => {
                if (!e.uv) return;
                setHover(uvToCoord(e.uv, terrain, location.bounds));
              }}
              onPointerOut={() => setHover(null)}
              onClick={(e) => {
                if (!e.uv) return;
                e.stopPropagation();
                if (waterFlowActive && flowState) {
                  const col = Math.floor((e.uv.x) * (terrain.width - 1));
                  const row = Math.floor((1 - e.uv.y) * (terrain.height - 1));
                  addWaterAt(flowState, row, col, 8, 4);
                  setFlowKey((k) => k + 1);
                  return;
                }
                if (showPopulation && popGrid) {
                  const c = uvToCoord(e.uv, terrain, location.bounds);
                  setPopPoint({ lat: c.lat, lon: c.lon, value: sampleGrid(popGrid, c.lon, c.lat) });
                  return;
                }
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
                />
              )}
            </group>
            <TerrainStyleOverlay
              terrain={terrain}
              exaggeration={exaggeration}
              style={terrainStyle}
              contourInterval={contourInterval}
              vectorInterval={vectorInterval}
              meshInterval={meshInterval}
              bounds={location.bounds}
            />
            {showWater && (
              <OsmWaterwaysLayer
                terrain={terrain}
                exaggeration={exaggeration}
                bounds={location.bounds}
                clipBounds={location.waterBounds ?? location.bounds}
                dataUrl={`${dataBase}/${location.waterBounds ? 'water_large.json' : 'water.json'}`}
                onSelect={setSelectedWater}
                onLoaded={() => setWaterLoaded(true)}
              />
            )}
            {showBasinRivers && (
              <HydroBasinLayer
                terrain={terrain}
                exaggeration={exaggeration}
                bounds={location.bounds}
                riversUrl={`${dataBase}/basin_rivers.json`}
                boundaryUrl={`${dataBase}/basin_boundary.json`}
                colorBy={basinColorBy}
                minOrder={basinMinOrder}
                onExtent={setBasinSceneRadius}
                onSelect={setSelectedBasinRiver}
              />
            )}
            {showOsmBuildings && (
              <OsmBuildingsLayer terrain={terrain} exaggeration={exaggeration} bounds={location.bounds} dataUrl={`${dataBase}/buildings.json`} />
            )}
            {showGlacier && location.hasGlacierData && (
              <GlacierOutlineLayer
                terrain={terrain}
                exaggeration={exaggeration}
                bounds={location.bounds}
                dataUrl={`${dataBase}/all_glaciers.json`}
                thicknessUrl={showIceThickness && location.hasIceThickness ? `${dataBase}/ice_thickness.json` : undefined}
                onSelect={setSelectedGlacier}
                onThickness={setThicknessInfo}
              />
            )}
            {showRetreat && location.hasGlacierData && (
              <GlacierRetreatLayer
                terrain={terrain}
                exaggeration={exaggeration}
                bounds={location.bounds}
                outlineUrl={`${dataBase}/all_glaciers.json`}
                retreatMeters={retreatMeters}
              />
            )}
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
            {showPopulation && (
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
            {showPlaces && (
              <OsmPlacesLayer
                terrain={terrain}
                exaggeration={exaggeration}
                bounds={location.bounds}
                dataUrl={`${dataBase}/places.json`}
                queryBounds={location.waterBounds ?? location.bounds}
                onLoaded={() => setPlacesLoaded(true)}
              />
            )}
            <OsmLinesLayer
              terrain={terrain}
              exaggeration={exaggeration}
              bounds={location.bounds}
              clipBounds={location.waterBounds ?? location.bounds}
              enabled={showRoads}
              cacheKey="osm-roads"
              color="#e8b04b"
              opacity={0.65}
              lineWidth={1.1}
              buildQuery={(bbox) => `[out:json][timeout:60];
                (
                  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|track)$"](${bbox});
                );
                out geom;`}
            />
            {/* National borders — the only ones drawn at full visibility. */}
            <OsmLinesLayer
              terrain={terrain}
              exaggeration={exaggeration}
              bounds={location.bounds}
              clipBounds={location.waterBounds ?? location.bounds}
              enabled={showBorders}
              cacheKey="osm-borders-national"
              dataUrl={`${dataBase}/borders_national.json`}
              color="#e05fd0"
              opacity={0.7}
              lineWidth={1.6}
              buildQuery={(bbox) => `[out:json][timeout:60];
                (
                  relation["boundary"="administrative"]["admin_level"="2"](${bbox});
                );
                out geom;`}
            />
            {/* Sub-national (region/district) borders — kept, but nearly transparent. */}
            <OsmLinesLayer
              terrain={terrain}
              exaggeration={exaggeration}
              bounds={location.bounds}
              clipBounds={location.waterBounds ?? location.bounds}
              enabled={showBorders}
              cacheKey="osm-borders-sub"
              dataUrl={`${dataBase}/borders_sub.json`}
              color="#e05fd0"
              opacity={0.08}
              lineWidth={1}
              buildQuery={(bbox) => `[out:json][timeout:60];
                (
                  relation["boundary"="administrative"]["admin_level"~"^(3|4|5|6)$"](${bbox});
                );
                out geom;`}
            />
            {/* Resource extraction: mining/quarries, oil & gas, logging, industrial areas. */}
            <ResourcesLayer
              terrain={terrain}
              exaggeration={exaggeration}
              bounds={location.bounds}
              clipBounds={location.waterBounds ?? location.bounds}
              enabled={showResources}
              dataUrl={`${dataBase}/resources.json`}
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
          </>
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

      {/* Toolbar */}
      <div className="absolute top-3 right-3 flex items-center gap-2">
        {/* Layers */}
        <DropdownMenu>
          <DropdownMenuTrigger className={btnBase}>
            <Layers className="w-3.5 h-3.5" /> Layers
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>Overlays</DropdownMenuLabel>
            <DropdownMenuCheckboxItem checked={showWater} onCheckedChange={(v) => setShowWater(!!v)}>
              Water
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={showBasinRivers} onCheckedChange={(v) => setShowBasinRivers(!!v)}>
              Basin rivers (HydroSHEDS)
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={showOsmBuildings} onCheckedChange={(v) => setShowOsmBuildings(!!v)}>
              Buildings
            </DropdownMenuCheckboxItem>
            {location.hasGlacierData && (
              <DropdownMenuCheckboxItem checked={showGlacier} onCheckedChange={(v) => setShowGlacier(!!v)}>
                Glacier extent (GLIMS)
              </DropdownMenuCheckboxItem>
            )}
            {location.hasGlacierData && location.hasIceThickness && (
              <DropdownMenuCheckboxItem checked={showIceThickness} onCheckedChange={(v) => setShowIceThickness(!!v)}>
                Color by ice thickness (Farinotti)
              </DropdownMenuCheckboxItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={showInat} onCheckedChange={(v) => setShowInat(!!v)}>
              iNaturalist observations
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={showPopulation} onCheckedChange={(v) => setShowPopulation(!!v)}>
              Population density
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={showPlaces} onCheckedChange={(v) => setShowPlaces(!!v)}>
              Towns & villages
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={showRoads} onCheckedChange={(v) => setShowRoads(!!v)}>
              Roads
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={showBorders} onCheckedChange={(v) => setShowBorders(!!v)}>
              Borders
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={showResources} onCheckedChange={(v) => setShowResources(!!v)}>
              Resources (mining / oil & gas / logging)
            </DropdownMenuCheckboxItem>
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
              onClick={() => {
                setBrightness(imgDefaults?.brightness ?? 1.75);
                setContrast(imgDefaults?.contrast ?? 0.8);
                setSaturation(imgDefaults?.saturation ?? 0.6);
                setGamma(imgDefaults?.gamma ?? 0.9);
                setTint(imgDefaults?.tint ?? '#ffffff');
                setTintStrength(imgDefaults?.tintStrength ?? 0);
              }}
              className="w-full mt-1 text-[11px] px-2 py-1 rounded border border-border/60 hover:bg-accent"
            >
              Reset basemap
            </button>

            <div className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground pt-2">Population heatmap (GHS-POP)</div>
            <Slider label="Opacity" value={popOpacity} min={0} max={1} step={0.02}
              onChange={setPopOpacity} format={(v) => v.toFixed(2)} />
            <Slider label="Intensity" value={popIntensity} min={0.1} max={4} step={0.05}
              onChange={setPopIntensity} format={(v) => v.toFixed(2)} />

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
                <Slider label="Min order" value={basinMinOrder} min={3} max={7} step={1}
                  onChange={setBasinMinOrder} format={(v) => `${v}`} />
                <div className="text-[10px] text-muted-foreground leading-snug">
                  {basinColorBy === 'discharge'
                    ? 'Width/color by average discharge (m³/s) — thicker & darker = more water.'
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
      {selectedInat && (
        <div className="absolute top-16 right-3 w-80 text-xs z-20 pointer-events-none">
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
