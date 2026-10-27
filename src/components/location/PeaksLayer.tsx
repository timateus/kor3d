import { useEffect, useMemo, useState } from 'react';
import { Html } from '@react-three/drei';
import type { GeoBounds, TerrainData } from '@/lib/geotiff-loader';

interface Props {
  terrain: TerrainData;
  exaggeration: number;
  bounds: GeoBounds;
  /** Raw Overpass output of named peaks and saddles (scripts/prefetch/overpass.mjs --peaks-only). */
  dataUrl: string;
  intensity?: number;
}

interface Peak { name: string; lat: number; lon: number; ele: number | null; kind: 'peak' | 'saddle' }

interface OverpassNode { type: string; lat: number; lon: number; tags?: Record<string, string> }

function parsePeaks(json: { elements?: OverpassNode[] }): Peak[] {
  return (json.elements || [])
    .filter((el): el is OverpassNode & { tags: Record<string, string> } => el.type === 'node' && !!el.tags?.name)
    .map((el) => {
      const ele = parseFloat(String(el.tags.ele ?? '').replace(',', '.'));
      return {
        // Local (Kazakh/Russian) name as signed on the ground; name:ru is often genitive ("Терешковой").
        name: el.tags.name,
        lat: el.lat,
        lon: el.lon,
        ele: Number.isFinite(ele) ? Math.round(ele) : null,
        kind: el.tags.natural === 'saddle' || el.tags.mountain_pass === 'yes' ? 'saddle' : 'peak',
      } as Peak;
    });
}

/** Named summits (▲) and passes, labelled with their OSM height. */
export default function PeaksLayer({ terrain, exaggeration, bounds, dataUrl, intensity = 1 }: Props) {
  const [peaks, setPeaks] = useState<Peak[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch(dataUrl)
      .then((r) => r.ok && r.headers.get('content-type')?.includes('json') ? r.json() : { elements: [] })
      .then((json) => { if (!cancelled) setPeaks(parsePeaks(json)); })
      .catch((e) => console.warn('Peaks unavailable', e));
    return () => { cancelled = true; };
  }, [dataUrl]);

  const meshW = 10;
  const meshH = 10 * (terrain.height / terrain.width);
  const elevRange = terrain.maxElevation - terrain.minElevation || 1;
  const maxH = 10 * (exaggeration / 100);

  const markers = useMemo(() => peaks
    .filter((p) => p.lon >= bounds.minLon && p.lon <= bounds.maxLon && p.lat >= bounds.minLat && p.lat <= bounds.maxLat)
    .map((p) => {
      const nx = (p.lon - bounds.minLon) / (bounds.maxLon - bounds.minLon);
      const ny = (p.lat - bounds.minLat) / (bounds.maxLat - bounds.minLat);
      const px = Math.floor(nx * (terrain.width - 1));
      const py = Math.floor((1 - ny) * (terrain.height - 1));
      const e = terrain.elevations[py * terrain.width + px] ?? terrain.minElevation;
      return { ...p, pos: [(nx - 0.5) * meshW, ((e - terrain.minElevation) / elevRange) * maxH, -((ny - 0.5) * meshH)] as [number, number, number] };
    }), [peaks, terrain, bounds, elevRange, maxH, meshH]);

  return (
    <group>
      {markers.map((m, i) => {
        const peak = m.kind === 'peak';
        return (
          <group key={`${m.name}-${i}`} position={m.pos}>
            <Html center distanceFactor={peak ? 4 : 3.2} position={[0, 0.06, 0]} zIndexRange={[70, 0]} style={{ pointerEvents: 'none', userSelect: 'none' }}>
              <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1.05,
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                color: '#1a1710',
                textShadow: '0 0 6px rgba(243,240,231,0.95), 0 0 2px rgba(243,240,231,1)',
                whiteSpace: 'nowrap',
              }}>
                <span style={{ fontSize: `${(peak ? 10 : 8) * intensity}px`, fontWeight: peak ? 700 : 500, fontStyle: peak ? 'normal' : 'italic' }}>
                  {peak ? '▲ ' : ''}{m.name}
                </span>
                {m.ele !== null && <span style={{ fontSize: `${(peak ? 8.5 : 7.5) * intensity}px`, opacity: 0.8 }}>{peak ? '' : 'пер. '}{m.ele} м</span>}
              </div>
            </Html>
          </group>
        );
      })}
    </group>
  );
}
