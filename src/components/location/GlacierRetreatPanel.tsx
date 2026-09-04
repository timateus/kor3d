import { useEffect, useMemo, useState } from 'react';

/**
 * Year slider driving GlacierRetreatLayer's historical-terminus marker, from
 * WGMS front-variation (length-change) survey data.
 */

interface RetreatPoint { year: number; cum_retreat_m: number }

interface Props {
  dataUrl: string;
  year: number;
  onYearChange: (year: number) => void;
  onRetreatChange: (meters: number) => void;
  onClose: () => void;
}

const _cache = new Map<string, RetreatPoint[]>();
async function fetchJson(url: string): Promise<RetreatPoint[]> {
  const hit = _cache.get(url);
  if (hit) return hit;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Static ${res.status}`);
  const data = await res.json();
  _cache.set(url, data);
  return data;
}

/** Linear-interpolate cumulative retreat at `year` from the sparse survey series. */
function retreatAt(points: RetreatPoint[], year: number): number {
  if (points.length === 0) return 0;
  if (year <= points[0].year) return -points[0].cum_retreat_m;
  if (year >= points[points.length - 1].year) return -points[points.length - 1].cum_retreat_m;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (year >= a.year && year <= b.year) {
      const t = b.year === a.year ? 0 : (year - a.year) / (b.year - a.year);
      return -(a.cum_retreat_m + (b.cum_retreat_m - a.cum_retreat_m) * t);
    }
  }
  return 0;
}

const GlacierRetreatPanel = ({ dataUrl, year, onYearChange, onRetreatChange, onClose }: Props) => {
  const [points, setPoints] = useState<RetreatPoint[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchJson(dataUrl).then((d) => { if (!cancelled) setPoints(d); }).catch(() => { if (!cancelled) setPoints([]); });
    return () => { cancelled = true; };
  }, [dataUrl]);

  const retreatM = useMemo(() => (points ? retreatAt(points, year) : 0), [points, year]);

  useEffect(() => { onRetreatChange(retreatM); }, [retreatM, onRetreatChange]);

  const minYear = points?.[0]?.year ?? 1902;
  const maxYear = points?.[points.length - 1]?.year ?? 2025;

  return (
    <div className="absolute top-16 right-3 w-80 p-3 rounded-md bg-background/90 backdrop-blur border border-border/60 text-xs font-mono z-10">
      <div className="flex items-center justify-between mb-2">
        <span className="uppercase tracking-widest text-[10px] text-primary">Terminus retreat · WGMS</span>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground">✕</button>
      </div>
      {!points ? (
        <div className="text-muted-foreground">loading…</div>
      ) : (
        <>
          <div className="text-lg font-sans font-semibold text-sky-400">{year}</div>
          <div className="text-[10px] text-muted-foreground mb-2">
            {retreatM > 0 ? `terminus ~${retreatM.toFixed(0)} m downhill of today's edge` : "at today's position"}
          </div>
          <input
            type="range" min={minYear} max={maxYear} step={1} value={year}
            onChange={(e) => onYearChange(parseInt(e.target.value, 10))}
            className="w-full"
          />
          <div className="flex justify-between text-[10px] text-muted-foreground mt-0.5">
            <span>{minYear}</span>
            <span>{maxYear}</span>
          </div>
          <div className="text-[10px] text-muted-foreground mt-2 leading-snug">
            Marker position from measured cumulative length change (ground/photogrammetric
            surveys), projected along the glacier's own downhill axis — not a redrawn historical
            outline, since none is openly available for this glacier.
          </div>
        </>
      )}
    </div>
  );
};

export default GlacierRetreatPanel;
