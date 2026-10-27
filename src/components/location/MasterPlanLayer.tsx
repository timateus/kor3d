import { useEffect, useMemo, useState } from 'react';
import { Html, Line } from '@react-three/drei';
import type { GeoBounds, TerrainData } from '@/lib/geotiff-loader';
import { cableLine, terrainProjector } from '@/lib/terrain-project';

interface Props {
  terrain: TerrainData;
  exaggeration: number;
  bounds: GeoBounds;
  /** GeoJSON traced from a resort master plan (public/data/locations/{slug}/master_plan/). */
  dataUrl: string;
  intensity?: number;
}

type Confidence = 'high' | 'medium' | 'low';
interface Station { id: string; name: string; kind: 'station' | 'village'; lon: number; lat: number; planElevation: number | null; confidence: Confidence; note?: string }
interface Lift { name: string; lift: 'gondola' | 'chair_lift'; coords: [number, number][]; confidence: Confidence }

const LIFT_COLOR = { gondola: '#ff3d71', chair_lift: '#ffb020' };

/**
 * Approximate lifts and stations of a planned resort. Lifts are drawn as
 * straight cables between stations, lifted wherever the terrain in between
 * is higher; low-confidence features are dashed.
 */
export default function MasterPlanLayer({ terrain, exaggeration, bounds, dataUrl, intensity = 1 }: Props) {
  const [data, setData] = useState<{ stations: Station[]; lifts: Lift[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(dataUrl).then((r) => r.json()).then((json) => {
      if (cancelled) return;
      const stations: Station[] = [];
      const lifts: Lift[] = [];
      for (const f of json.features ?? []) {
        const p = f.properties ?? {};
        if (f.geometry?.type === 'Point') stations.push({ ...p, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] });
        else if (f.geometry?.type === 'LineString') lifts.push({ name: p.name, lift: p.lift, confidence: p.confidence, coords: f.geometry.coordinates });
      }
      setData({ stations, lifts });
    }).catch((e) => console.warn('Master plan unavailable', e));
    return () => { cancelled = true; };
  }, [dataUrl]);

  const lift = 0.04; // cable / marker clearance above the surface, in scene units
  const project = useMemo(() => terrainProjector(terrain, bounds, exaggeration), [terrain, bounds, exaggeration]);
  const cables = useMemo(() => (data?.lifts ?? []).map((l) => ({ ...l, points: cableLine(project, l.coords, lift, 48) })), [data, project]);

  if (!data) return null;
  return (
    <group>
      {cables.map((c) => (
        <Line key={c.name} points={c.points} color={LIFT_COLOR[c.lift] ?? '#ff3d71'} lineWidth={3 * intensity}
          dashed={c.confidence === 'low'} dashSize={0.06} gapSize={0.04} transparent opacity={0.95} />
      ))}
      {data.stations.map((s) => {
        const [x, y, z] = project(s.lon, s.lat);
        const village = s.kind === 'village';
        return (
          <group key={s.id} position={[x, y + lift, z]}>
            <mesh>
              <sphereGeometry args={[village ? 0.035 : 0.022, 12, 12]} />
              <meshBasicMaterial color={village ? '#ffffff' : '#ff3d71'} />
            </mesh>
            <Html center distanceFactor={4} position={[0, 0.07, 0]} zIndexRange={[75, 0]} style={{ userSelect: 'none' }}>
              <div title={`${s.name}${s.note ? ` — ${s.note}` : ''} · ${s.confidence} confidence`} style={{
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                fontSize: `${(village ? 10 : 9) * intensity}px`,
                fontWeight: village ? 700 : 600,
                color: '#fff',
                background: village ? 'rgba(20,20,28,0.85)' : 'rgba(255,61,113,0.88)',
                borderRadius: 3,
                padding: '1px 5px',
                whiteSpace: 'nowrap',
                border: s.confidence === 'low' ? '1px dashed rgba(255,255,255,0.8)' : '1px solid rgba(255,255,255,0.6)',
              }}>
                {village ? s.name : s.planElevation !== null ? `${s.planElevation} м` : s.name}{s.confidence === 'low' ? ' ≈' : ''}
              </div>
            </Html>
          </group>
        );
      })}
    </group>
  );
}
