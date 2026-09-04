import { useEffect, useMemo, useState } from 'react';

/**
 * Cumulative glacier-wide mass balance from WGMS FoG time series — a quick
 * "has it been shrinking" line chart, companion to GlacierOutlineLayer's
 * single-snapshot extent. Not draped on the 3D scene; a flat SVG panel.
 */

interface MassBalanceRow {
  year: number;
  winter: number | null;
  summer: number | null;
  annual: number | null;
  ela: number | null;
  aar: number | null;
}

interface Props {
  dataUrl: string;
  onClose: () => void;
}

const _cache = new Map<string, MassBalanceRow[]>();
async function fetchJson(url: string): Promise<MassBalanceRow[]> {
  const hit = _cache.get(url);
  if (hit) return hit;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Static ${res.status}`);
  const data = await res.json();
  _cache.set(url, data);
  return data;
}

const W = 280, H = 120, PAD = 4;

const GlacierChartPanel = ({ dataUrl, onClose }: Props) => {
  const [rows, setRows] = useState<MassBalanceRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchJson(dataUrl).then((d) => { if (!cancelled) setRows(d); }).catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, [dataUrl]);

  const { path, cumEnd, minY, maxY, years } = useMemo(() => {
    if (!rows || rows.length === 0) return { path: '', cumEnd: 0, minY: 0, maxY: 0, years: [0, 0] };
    let cum = 0;
    const pts = rows.map((r) => { cum += r.annual ?? 0; return { year: r.year, cum }; });
    const minY = Math.min(0, ...pts.map((p) => p.cum));
    const maxY = Math.max(0, ...pts.map((p) => p.cum));
    const range = maxY - minY || 1;
    const y0 = rows[0].year, y1 = rows[rows.length - 1].year;
    const yearRange = y1 - y0 || 1;
    const toXY = (year: number, cumVal: number): [number, number] => {
      const x = PAD + ((year - y0) / yearRange) * (W - 2 * PAD);
      const y = PAD + (1 - (cumVal - minY) / range) * (H - 2 * PAD);
      return [x, y];
    };
    const d = pts.map((p, i) => {
      const [x, y] = toXY(p.year, p.cum);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return { path: d, cumEnd: cum, minY, maxY, years: [y0, y1] };
  }, [rows]);

  const zeroY = useMemo(() => {
    if (!rows || rows.length === 0) return null;
    const range = (maxY - minY) || 1;
    return PAD + (1 - (0 - minY) / range) * (H - 2 * PAD);
  }, [rows, minY, maxY]);

  return (
    <div className="absolute top-16 right-3 w-80 p-3 rounded-md bg-background/90 backdrop-blur border border-border/60 text-xs font-mono z-10">
      <div className="flex items-center justify-between mb-2">
        <span className="uppercase tracking-widest text-[10px] text-primary">Mass balance · WGMS</span>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground">✕</button>
      </div>
      {!rows ? (
        <div className="text-muted-foreground">loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-muted-foreground">no data</div>
      ) : (
        <>
          <div className="text-lg font-sans font-semibold" style={{ color: cumEnd < 0 ? '#f87171' : '#4ade80' }}>
            {cumEnd.toFixed(1)} m w.e.
          </div>
          <div className="text-[10px] text-muted-foreground mb-2">
            cumulative annual balance, {years[0]}–{years[1]}
          </div>
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block">
            {zeroY != null && (
              <line x1={PAD} y1={zeroY} x2={W - PAD} y2={zeroY} stroke="currentColor" strokeOpacity={0.25} strokeDasharray="2,2" />
            )}
            <path d={path} fill="none" stroke="#60a5fa" strokeWidth={1.5} />
          </svg>
          <div className="text-[10px] text-muted-foreground mt-1 leading-snug">
            Sum of annual glacier-wide mass balance (m water-equivalent) since {years[0]} —
            a continuously negative trend means the glacier has been losing mass most years.
          </div>
          <a
            className="mt-2 inline-block text-primary hover:underline"
            href="https://wgms.ch/products_ref_glaciers/tuyuksuyskiy/"
            target="_blank" rel="noreferrer"
          >
            WGMS reference glacier page →
          </a>
        </>
      )}
    </div>
  );
};

export default GlacierChartPanel;
