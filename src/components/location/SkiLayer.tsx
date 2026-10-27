import { useEffect, useMemo, useState } from 'react';
import { Html, Line } from '@react-three/drei';
import type { GeoBounds, TerrainData } from '@/lib/geotiff-loader';
import { cableLine, drapeLine, insideBounds, terrainProjector, type Vec3 } from '@/lib/terrain-project';

interface Props {
  terrain: TerrainData;
  exaggeration: number;
  bounds: GeoBounds;
  /** Raw Overpass `out geom` from scripts/prefetch/overpass.mjs fetchSki. */
  dataUrl: string;
  intensity?: number;
}

interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  members?: { type: string; ref: number; geometry?: { lat: number; lon: number }[] }[];
}

// Usual European piste colours (also used on the Almaty Superski plan).
const PISTE_COLOR: Record<string, string> = {
  novice: '#3fbf3f', easy: '#2f7cf6', intermediate: '#e53935', advanced: '#151515', expert: '#151515', freeride: '#ffb300', extreme: '#ffb300',
};
const CABLE_LIFTS = new Set(['cable_car', 'gondola', 'mixed_lift', 'chair_lift']);
const SURFACE_LIFTS = new Set(['drag_lift', 't-bar', 'j-bar', 'platter', 'rope_tow', 'magic_carpet']);
const LIFT_LABEL: Record<string, string> = { cable_car: 'cable car', gondola: 'gondola', mixed_lift: 'combi', chair_lift: 'chair' };

interface Piste { key: string; coords: [number, number][]; difficulty: string; type: string; name?: string }
interface Lift { key: string; coords: [number, number][]; kind: string; name?: string }
interface Station { key: string; lon: number; lat: number; name: string }

function parse(json: { elements?: OsmElement[] }) {
  const pistes: Piste[] = [], lifts: Lift[] = [], stations: Station[] = [];
  const pisteWays = new Set<number>();
  const geom = (g?: { lat: number; lon: number }[]) => (g ?? []).map(p => [p.lon, p.lat] as [number, number]);
  for (const el of json.elements ?? []) {
    const t = el.tags ?? {};
    if (el.type === 'node' && t.aerialway === 'station' && t.name && el.lon !== undefined && el.lat !== undefined) {
      stations.push({ key: `n${el.id}`, lon: el.lon, lat: el.lat, name: t.name });
    } else if (el.type === 'way' && t.aerialway && (CABLE_LIFTS.has(t.aerialway) || SURFACE_LIFTS.has(t.aerialway))) {
      lifts.push({ key: `w${el.id}`, coords: geom(el.geometry), kind: t.aerialway, name: t.name });
    } else if (el.type === 'way' && t['piste:type']) {
      pisteWays.add(el.id);
      pistes.push({ key: `w${el.id}`, coords: geom(el.geometry), difficulty: t['piste:difficulty'] ?? '', type: t['piste:type'], name: t['piste:name'] ?? t.name });
    }
  }
  // Route relations: draw members that are not already tagged pistes themselves.
  for (const el of json.elements ?? []) {
    const t = el.tags ?? {};
    if (el.type !== 'relation' || !t['piste:type']) continue;
    for (const m of el.members ?? []) {
      if (m.type === 'way' && m.geometry && !pisteWays.has(m.ref)) {
        pistes.push({ key: `r${el.id}-${m.ref}`, coords: geom(m.geometry), difficulty: t['piste:difficulty'] ?? '', type: t['piste:type'], name: t['piste:name'] ?? t.name });
      }
    }
  }
  return { pistes, lifts, stations };
}

/** Existing ski areas from OSM: lifts on their pylons, stations, and pistes by difficulty. */
export default function SkiLayer({ terrain, exaggeration, bounds, dataUrl, intensity = 1 }: Props) {
  const [data, setData] = useState<ReturnType<typeof parse> | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(dataUrl)
      .then((r) => r.ok && r.headers.get('content-type')?.includes('json') ? r.json() : { elements: [] })
      .then((json) => { if (!cancelled) setData(parse(json)); })
      .catch((e) => console.warn('Ski data unavailable', e));
    return () => { cancelled = true; };
  }, [dataUrl]);

  const project = useMemo(() => terrainProjector(terrain, bounds, exaggeration), [terrain, bounds, exaggeration]);
  const clearance = 0.012;

  const drawn = useMemo(() => {
    if (!data) return null;
    const keep = (c: [number, number][]) => c.length > 1 && c.some(([lon, lat]) => insideBounds(bounds, lon, lat));
    return {
      pistes: data.pistes.filter(p => keep(p.coords)).map(p => ({ ...p, points: drapeLine(project, p.coords, clearance) })),
      lifts: data.lifts.filter(l => keep(l.coords)).map(l => ({
        ...l,
        points: CABLE_LIFTS.has(l.kind) ? cableLine(project, l.coords, 0.035) : drapeLine(project, l.coords, clearance * 1.5),
      })),
      stations: data.stations.filter(s => insideBounds(bounds, s.lon, s.lat)).map(s => ({ ...s, pos: project(s.lon, s.lat) })),
    };
  }, [data, project, bounds]);

  if (!drawn) return null;
  const mid = (pts: Vec3[]) => pts[Math.floor(pts.length / 2)];
  return (
    <group>
      {drawn.pistes.map(p => (
        <Line key={p.key} points={p.points} color={PISTE_COLOR[p.difficulty] ?? (p.type === 'downhill' ? '#9e9e9e' : '#80deea')}
          lineWidth={(p.type === 'downhill' ? 3 : 2) * intensity} dashed={p.type !== 'downhill' || p.difficulty === 'freeride'}
          dashSize={0.04} gapSize={0.03} transparent opacity={0.9} />
      ))}
      {drawn.lifts.map(l => (
        <group key={l.key}>
          <Line points={l.points} color="#ffffff" lineWidth={(CABLE_LIFTS.has(l.kind) ? 2.5 : 1.5) * intensity} transparent opacity={0.95} />
          {l.name && CABLE_LIFTS.has(l.kind) && (
            <Html center position={mid(l.points)} distanceFactor={3.5} zIndexRange={[72, 0]} style={{ pointerEvents: 'none', userSelect: 'none' }}>
              <div style={{
                fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: `${8.5 * intensity}px`, fontWeight: 600,
                color: '#111', background: 'rgba(255,255,255,0.88)', borderRadius: 3, padding: '0 4px', whiteSpace: 'nowrap',
              }}>{l.name} · {LIFT_LABEL[l.kind]}</div>
            </Html>
          )}
        </group>
      ))}
      {drawn.stations.map(s => (
        <group key={s.key} position={[s.pos[0], s.pos[1] + 0.035, s.pos[2]]}>
          <mesh><boxGeometry args={[0.02, 0.02, 0.02]} /><meshBasicMaterial color="#ffffff" /></mesh>
        </group>
      ))}
    </group>
  );
}
