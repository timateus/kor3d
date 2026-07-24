import { useEffect, useMemo, useState } from 'react';
import { Html } from '@react-three/drei';
import type { GeoBounds, TerrainData } from '@/lib/geotiff-loader';
import { fetchOverpass } from '@/lib/overpass';

interface Props {
  terrain: TerrainData;
  exaggeration: number;
  /** Core terrain bounds — used to position markers on the mesh (must match the terrain's own bounds). */
  bounds: GeoBounds;
  /** Optional static JSON URL (raw Overpass output) — tried first, avoids a live query. */
  dataUrl?: string;
  /** Wider bounding box for the live-Overpass fallback query (defaults to `bounds`). */
  queryBounds?: GeoBounds;
  /** Fires once loading settles (success or failure). */
  onLoaded?: () => void;
}

interface Place {
  name: string;
  lat: number;
  lon: number;
  kind: 'city' | 'town' | 'village' | 'hamlet';
  population: number | null;
}

const KIND_STYLE: Record<Place['kind'], {
  color: string;
  size: number;
  distFactor: number;
  fontSize: number;
  minSepDeg: number;
  uppercase: boolean;
  weight: number;
}> = {
  city:    { color: '#ffffff', size: 0.055, distFactor: 7,  fontSize: 12, minSepDeg: 0.0,  uppercase: true,  weight: 700 },
  town:    { color: '#ffe9b0', size: 0.035, distFactor: 5,  fontSize: 10, minSepDeg: 0.05, uppercase: false, weight: 600 },
  village: { color: '#c9d4e0', size: 0.022, distFactor: 3.5, fontSize: 9,  minSepDeg: 0.10, uppercase: false, weight: 500 },
  hamlet:  { color: '#a7b1bd', size: 0.016, distFactor: 2.8, fontSize: 8,  minSepDeg: 0.06, uppercase: false, weight: 400 },
};

function parsePlaces(json: any): Place[] {
  return (json.elements || [])
    .filter((el: any) => el.type === 'node' && el.tags?.name && el.tags?.place)
    .map((el: any) => {
      const popRaw = el.tags?.population;
      const pop = popRaw ? parseInt(String(popRaw).replace(/[^\d]/g, ''), 10) : NaN;
      const name: string = el.tags['name:en'] || el.tags['name:ru'] || el.tags['name:kk'] || el.tags.name;
      return {
        name,
        lat: el.lat,
        lon: el.lon,
        kind: el.tags.place as Place['kind'],
        population: Number.isFinite(pop) ? pop : null,
      };
    })
    .filter((p: Place) => p.kind in KIND_STYLE);
}

async function fetchPlacesLive(b: GeoBounds): Promise<Place[]> {
  const bbox = `${b.minLat},${b.minLon},${b.maxLat},${b.maxLon}`;
  const key = `osm-places:${b.minLon.toFixed(4)},${b.minLat.toFixed(4)},${b.maxLon.toFixed(4)},${b.maxLat.toFixed(4)}`;
  const q = `[out:json][timeout:30];
    (
      node["place"~"^(city|town|village|hamlet)$"]["name"](${bbox});
    );
    out body 800;`;
  const json = await fetchOverpass<any>(q, key);
  return parsePlaces(json);
}

async function fetchPlacesStatic(url: string): Promise<Place[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Static ${res.status}`);
  return parsePlaces(await res.json());
}

export default function OsmPlacesLayer({ terrain, exaggeration, bounds, dataUrl, queryBounds, onLoaded }: Props) {
  const [places, setPlaces] = useState<Place[]>([]);

  useEffect(() => {
    let cancelled = false;
    const fallback = () =>
      fetchPlacesLive(queryBounds ?? bounds)
        .then((p) => { if (!cancelled) setPlaces(p); })
        .catch((e) => console.warn('OSM places fetch failed', e))
        .finally(() => { if (!cancelled) onLoaded?.(); });

    if (dataUrl) {
      fetchPlacesStatic(dataUrl)
        .then((p) => { if (!cancelled) setPlaces(p); onLoaded?.(); })
        .catch(() => { if (!cancelled) fallback(); });
    } else {
      fallback();
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataUrl, bounds.minLon, bounds.maxLon, bounds.minLat, bounds.maxLat]);

  const meshW = 10;
  const meshH = 10 * (terrain.height / terrain.width);
  const elevRange = terrain.maxElevation - terrain.minElevation || 1;
  const maxH = 10 * (exaggeration / 100);

  const markers = useMemo(() => {
    if (!places.length) return [];
    // Only render places that actually fall on the terrain's own bounds —
    // positions are mapped relative to this box, so anything outside it
    // would land in the wrong spot (or off the mesh entirely).
    const inside = places.filter((p) =>
      p.lon >= bounds.minLon && p.lon <= bounds.maxLon &&
      p.lat >= bounds.minLat && p.lat <= bounds.maxLat
    );
    const order = { city: 0, town: 1, village: 2, hamlet: 3 } as const;
    inside.sort((a, b) => {
      const o = order[a.kind] - order[b.kind];
      if (o !== 0) return o;
      return (b.population || 0) - (a.population || 0);
    });
    const kept: Place[] = [];
    for (const p of inside) {
      const sep = KIND_STYLE[p.kind].minSepDeg;
      if (sep > 0) {
        const tooClose = kept.some((k) => {
          const dLat = k.lat - p.lat;
          const dLon = (k.lon - p.lon) * Math.cos((p.lat * Math.PI) / 180);
          return Math.hypot(dLat, dLon) < sep;
        });
        if (tooClose) continue;
      }
      kept.push(p);
      if (kept.length >= 150) break;
    }
    return kept.map((p) => {
      const nx = (p.lon - bounds.minLon) / (bounds.maxLon - bounds.minLon);
      const ny = (p.lat - bounds.minLat) / (bounds.maxLat - bounds.minLat);
      const x = (nx - 0.5) * meshW;
      const z = -((ny - 0.5) * meshH);
      const px = Math.floor(nx * (terrain.width - 1));
      const py = Math.floor((1 - ny) * (terrain.height - 1));
      const e = terrain.elevations[py * terrain.width + px] ?? terrain.minElevation;
      const y = ((e - terrain.minElevation) / elevRange) * maxH;
      return { ...p, pos: [x, y, z] as [number, number, number] };
    });
  }, [places, terrain, exaggeration, bounds, elevRange, maxH, meshH]);

  return (
    <group>
      {markers.map((m, i) => {
        const s = KIND_STYLE[m.kind];
        return (
          <group key={`${m.name}-${i}`} position={m.pos}>
            {/* Halo */}
            <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={[s.size * 1.6, s.size * 2.4, 24]} />
              <meshBasicMaterial color={s.color} transparent opacity={0.25} depthWrite={false} />
            </mesh>
            {/* Marker dot */}
            <mesh position={[0, 0.05, 0]}>
              <sphereGeometry args={[s.size, 14, 14]} />
              <meshStandardMaterial color={s.color} emissive={s.color} emissiveIntensity={0.6} />
            </mesh>
            {/* Label */}
            <Html
              center
              distanceFactor={s.distFactor}
              position={[0, s.size + 0.12, 0]}
              zIndexRange={[80, 0]}
              style={{ pointerEvents: 'none', userSelect: 'none' }}
            >
              <div
                style={{
                  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                  fontSize: `${s.fontSize}px`,
                  fontWeight: s.weight,
                  letterSpacing: s.uppercase ? '0.12em' : '0.04em',
                  textTransform: s.uppercase ? 'uppercase' : 'none',
                  color: '#1a1710',
                  textShadow: '0 0 6px rgba(243,240,231,0.95), 0 0 2px rgba(243,240,231,1), 0 1px 0 rgba(243,240,231,0.9)',
                  whiteSpace: 'nowrap',
                  padding: '1px 4px',
                }}
              >
                {m.name}
              </div>
            </Html>
          </group>
        );
      })}
    </group>
  );
}
