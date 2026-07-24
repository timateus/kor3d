import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Navigate, Link, useLocation } from 'react-router-dom';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { Loader2, Layers, Waves, Crosshair, Mountain, ArrowRight, Copy, Check, Sliders, Eye, X, Info } from 'lucide-react';
import { findLocation, LOCATIONS } from '@/lib/locations';
import { useMapterhornTerrain } from '@/hooks/useMapterhornTerrain';
import { useTerrainMode } from '@/hooks/useTerrainMode';
import MapboxTerrainMesh from '@/components/MapboxTerrainMesh';
import TerrainStyleOverlay, { type TerrainStyle } from '@/components/TerrainStyleOverlay';
import OsmWaterwaysLayer from '@/components/location/OsmWaterwaysLayer';
import OsmPopulationLayer from '@/components/location/OsmPopulationLayer';
import OsmPlacesLayer from '@/components/location/OsmPlacesLayer';
import OsmLinesLayer from '@/components/location/OsmLinesLayer';
import OsmBuildingsLayer from '@/components/location/OsmBuildingsLayer';
import InaturalistLayer, { type InatObservation } from '@/components/location/InaturalistLayer';
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
  const { terrain, loading, error, progress } = useMapterhornTerrain(location?.bounds ?? null, !!location);

  const [exaggeration, setExaggeration] = useState(location?.exaggeration ?? 50);
  const [showInspector, setShowInspector] = useState(false);
  const [showTerrain, setShowTerrain] = useState(true);
  const [showWater, setShowWater] = useState(true);
  const [showPopulation, setShowPopulation] = useState(true);
  const [showPlaces, setShowPlaces] = useState(true);
  const [showOsmBuildings, setShowOsmBuildings] = useState(false);
  const [showRoads, setShowRoads] = useState(false);
  const [showBorders, setShowBorders] = useState(false);
  const [showInat, setShowInat] = useState(true);
  const [texLoading, setTexLoading] = useState(true);

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
  const [selectedInat, setSelectedInat] = useState<InatObservation | null>(null);
  const [inatObs, setInatObs] = useState<InatObservation[]>([]);
  const [popGrid, setPopGrid] = useState<PopulationGrid | null>(null);
  const [popPoint, setPopPoint] = useState<{ lat: number; lon: number; value: number | null } | null>(null);
  const lastUserInteractRef = useRef<number>(Date.now());
  const flowLoopRef = useRef<number | null>(null);
  const orbitRef = useRef<any>(null);

  const { location: userLoc, loading: locating, requestLocation } = useUserLocation();

  useEffect(() => {
    if (!terrain) return;
    setFlowState(createFlowState(terrain));
    setFlowKey((k) => k + 1);
  }, [terrain]);

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

  return (
    <div className="fixed inset-0 bg-background text-foreground" style={{ fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace' }}>
      <style>{`
        .location-serif, .display-font { font-family: "Sora", ui-sans-serif, system-ui, sans-serif; font-weight: 800; letter-spacing: -0.02em; }
        .tech-font { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }
      `}</style>
      <Canvas camera={{ position: [-4.2, 4.2, -1.9], fov: 45, near: 0.1, far: 200 }} shadows={false}>
        <color attach="background" args={['#f3f0e7']} />
        <ambientLight intensity={0.9} />
        <directionalLight position={[10, 20, 10]} intensity={1.1} />
        <hemisphereLight args={['#ffffff', '#c9b98a', 0.5]} />

        <OrbitControls
          ref={orbitRef}
          enableDamping
          dampingFactor={0.06}
          minDistance={1.5}
          maxDistance={40}
          maxPolarAngle={Math.PI / 2.05}
          mouseButtons={{ LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }}
        />
        <CameraProbe orbitRef={orbitRef} onChange={setCamera} />

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
              />
            )}
            {showOsmBuildings && (
              <OsmBuildingsLayer terrain={terrain} exaggeration={exaggeration} bounds={location.bounds} dataUrl={`${dataBase}/buildings.json`} />
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
              />
            )}
            {showPlaces && (
              <OsmPlacesLayer
                terrain={terrain}
                exaggeration={exaggeration}
                bounds={location.bounds}
                dataUrl={`${dataBase}/places.json`}
                queryBounds={location.waterBounds ?? location.bounds}
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
            <OsmLinesLayer
              terrain={terrain}
              exaggeration={exaggeration}
              bounds={location.bounds}
              clipBounds={location.waterBounds ?? location.bounds}
              enabled={showBorders}
              cacheKey="osm-borders"
              color="#e05fd0"
              opacity={0.7}
              lineWidth={1.6}
              buildQuery={(bbox) => `[out:json][timeout:60];
                (
                  relation["boundary"="administrative"]["admin_level"~"^(2|4)$"](${bbox});
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

      {/* Full-screen loader while terrain, imagery, and layer data are still loading */}
      {(loading || texLoading) && (
        <div className="absolute inset-0 z-30 grid place-items-center bg-background/95 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
            <div className="text-sm tech-font text-muted-foreground uppercase tracking-widest">
              {loading ? `Loading terrain… ${Math.round((progress ?? 0) * 100)}%` : 'Loading imagery…'}
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
        {loading && (
          <div className="flex flex-col gap-1 px-2.5 py-1.5 rounded-md bg-background/80 backdrop-blur border border-border/60 text-xs text-muted-foreground pointer-events-auto min-w-[180px]">
            <div className="flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span className="tech-font">Loading terrain… {Math.round((progress ?? 0) * 100)}%</span>
            </div>
            <div className="h-1 w-full rounded-full bg-border/60 overflow-hidden">
              <div
                className="h-full bg-primary transition-[width] duration-200"
                style={{ width: `${Math.round((progress ?? 0) * 100)}%` }}
              />
            </div>
          </div>
        )}
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
            <DropdownMenuCheckboxItem checked={showOsmBuildings} onCheckedChange={(v) => setShowOsmBuildings(!!v)}>
              Buildings
            </DropdownMenuCheckboxItem>
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

      {/* Attribution */}
      <div className="absolute bottom-1 left-2 text-[10px] font-mono text-muted-foreground/70">
        <span className="pointer-events-none">Elevation: Mapterhorn · Imagery: Satlas Super-Res 2023 (Allen Institute for AI) · Population: GHS-POP (JRC) · Observations: iNaturalist · Data © OpenStreetMap contributors</span>
      </div>

    </div>
  );
}
