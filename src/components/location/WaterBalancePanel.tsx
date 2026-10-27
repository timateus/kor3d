import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Lake level hindcast and scenarios from scripts/prefetch/balkhash-water-balance.py.
 * A flat SVG panel like GlacierChartPanel: one level axis, observed levels as
 * dots, scenario lines (median-flow solid, dry-year dashed) with a hover readout.
 */

interface Row { year: number; level: number; area: number; volume: number; inflow: number; precip: number; evap: number }
interface Scenario { rows: Row[]; equilibrium: { level: number; area: number; volume: number; extrapolated: boolean } }
interface WaterBalance {
  calibration: { k_E: number; k_P: number; rmse_m: number; observed: Record<string, number> };
  hindcast: Row[];
  scenarios: Record<string, Scenario>;
  sources: Record<string, string>;
}

interface Props {
  dataUrl: string;
  onClose: () => void;
  /** Level (m) for the selected year and scenario, drawn on the terrain as a shoreline. */
  onLevel?: (level: number | null) => void;
  /** Share of today's mapped outline that is wet at that level (from the overlay). */
  areaFraction?: number | null;
}

// Categorical slots 1–3 (validated all-pairs); dashed = dry-year (Q75) variant of the same scenario.
const SERIES = [
  { key: 'current', label: 'Current inflow', slot: 1, dash: false },
  { key: 'ssp245-q50', label: 'SSP2-4.5', slot: 2, dash: false },
  { key: 'ssp245-q75', label: 'SSP2-4.5 dry', slot: 2, dash: true },
  { key: 'ssp585-q50', label: 'SSP5-8.5', slot: 3, dash: false },
  { key: 'ssp585-q75', label: 'SSP5-8.5 dry', slot: 3, dash: true },
] as const;

const STYLE = `
.wb-root { --wb-1: #3987e5; --wb-2: #d95926; --wb-3: #199e70; }
html.mirage .wb-root { --wb-1: #2a78d6; --wb-2: #eb6834; --wb-3: #1baf7a; }
`;

const W = 400, H = 220, L = 36, R = 80, T = 8, B = 20;
const Y_MIN = 335, Y_MAX = 344;
const fmt = (v: number, d = 2) => v.toFixed(d);

type ScenarioKey = typeof SERIES[number]['key'];

const WaterBalancePanel = ({ dataUrl, onClose, onLevel, areaFraction = null }: Props) => {
  const [data, setData] = useState<WaterBalance | null>(null);
  const [error, setError] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [year, setYear] = useState<number | null>(null);
  const [scenario, setScenario] = useState<ScenarioKey>('ssp245-q50');
  const [playing, setPlaying] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(dataUrl).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [dataUrl]);

  const geo = useMemo(() => {
    if (!data) return null;
    const y0 = data.hindcast[0].year;
    const y1 = data.scenarios.current.rows.at(-1)!.year;
    const x = (year: number) => L + (year - y0) / (y1 - y0) * (W - L - R);
    const y = (lvl: number) => T + (1 - (lvl - Y_MIN) / (Y_MAX - Y_MIN)) * (H - T - B);
    const path = (rows: Row[]) => rows.map((r, i) => `${i ? 'L' : 'M'}${x(r.year).toFixed(1)},${y(r.level).toFixed(1)}`).join(' ');
    const last = data.hindcast.at(-1)!;
    return {
      y0, y1, x, y,
      hindcast: path(data.hindcast),
      // Scenarios start from the last hindcast year so the lines join.
      scenarios: SERIES.map((s) => ({ ...s, d: path([last, ...data.scenarios[s.key].rows]), end: data.scenarios[s.key].rows.at(-1)! })),
      observed: Object.entries(data.calibration.observed).map(([yr, lvl]) => ({ year: Number(yr), level: lvl })),
    };
  }, [data]);

  const rowAt = (rows: Row[], year: number) => rows.find((r) => r.year === year);
  const lastHindcast = data?.hindcast.at(-1)!.year ?? 0;
  const selectedYear = year ?? lastHindcast;
  const selectedRow = data ? (selectedYear <= lastHindcast ? rowAt(data.hindcast, selectedYear) : rowAt(data.scenarios[scenario].rows, selectedYear)) : undefined;
  const selectedSeries = SERIES.find((s) => s.key === scenario)!;

  useEffect(() => { onLevel?.(selectedRow?.level ?? null); }, [selectedRow?.level, onLevel]);

  // Playback: one model year every 150 ms, looping from the start once it reaches the end.
  useEffect(() => {
    if (!playing || !geo) return;
    const t = window.setInterval(() => setYear((y) => {
      const next = (y ?? lastHindcast) + 1;
      return next > geo.y1 ? geo.y0 : next;
    }), 150);
    return () => window.clearInterval(t);
  }, [playing, geo, lastHindcast]);

  const yearAt = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!geo || !svgRef.current) return null;
    const box = svgRef.current.getBoundingClientRect();
    const px = (e.clientX - box.left) / box.width * W;
    return Math.max(geo.y0, Math.min(geo.y1, Math.round(geo.y0 + (px - L) / (W - L - R) * (geo.y1 - geo.y0))));
  };

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => setHover(yearAt(e));
  const onPick = (e: React.PointerEvent<SVGSVGElement>) => { const y = yearAt(e); if (y != null) { setPlaying(false); setYear(y); } };

  // Spread end labels so they don't collide.
  const endLabels = useMemo(() => {
    if (!geo) return [];
    const labels = geo.scenarios.filter((s) => !s.dash).map((s) => ({ ...s, ly: geo.y(s.end.level) }));
    labels.sort((a, b) => a.ly - b.ly);
    for (let i = 1; i < labels.length; i++) labels[i].ly = Math.max(labels[i].ly, labels[i - 1].ly + 11);
    return labels;
  }, [geo]);

  // The readout follows the pointer, falling back to the year shown on the map.
  const readYear = hover ?? selectedYear;
  const hoverRows = data ? (readYear <= lastHindcast
    ? [{ label: 'Model', slot: 0, dash: false, row: rowAt(data.hindcast, readYear) }]
    : SERIES.map((s) => ({ label: s.label, slot: s.slot, dash: s.dash, row: rowAt(data.scenarios[s.key].rows, readYear) }))) : [];
  const observedAtHover = data ? data.calibration.observed[String(readYear)] : undefined;

  return (
    <div className="wb-root absolute top-16 right-3 w-[27rem] max-w-[calc(100vw-1.5rem)] max-h-[calc(100dvh-6rem)] overflow-auto p-3 rounded-md bg-background/90 backdrop-blur border border-border/60 text-xs font-mono z-[110]">
      <style>{STYLE}</style>
      <div className="flex items-center justify-between mb-2">
        <span className="uppercase tracking-widest text-[10px] text-primary">Lake level · water balance model</span>
        <button onClick={onClose} aria-label="Close water balance" className="text-muted-foreground hover:text-foreground">✕</button>
      </div>
      {error ? <div className="text-muted-foreground">no data</div> : !data || !geo ? <div className="text-muted-foreground">loading…</div> : <>
        <div className="text-[10px] text-muted-foreground mb-1">Annual mean level, m above Baltic datum · model {geo.y0}–{data.hindcast.at(-1)!.year}, scenarios to {geo.y1}</div>
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="block w-full touch-none" role="img"
          aria-label="Lake Balkhash level: modelled history, observed levels and scenario projections"
          onPointerMove={onMove} onPointerLeave={() => setHover(null)} onPointerDown={onPick}>
          {[336, 338, 340, 342, 344].map((v) => <g key={v}>
            <line x1={L} x2={W - R} y1={geo.y(v)} y2={geo.y(v)} stroke="currentColor" strokeOpacity={0.1} />
            <text x={L - 4} y={geo.y(v) + 3} textAnchor="end" fontSize={9} className="fill-muted-foreground">{v}</text>
          </g>)}
          {[1970, 2000, 2024, 2050, 2075, 2100].filter((v) => v >= geo.y0 && v <= geo.y1).map((v) =>
            <text key={v} x={geo.x(v)} y={H - 6} textAnchor="middle" fontSize={9} className="fill-muted-foreground">{v}</text>)}
          <line x1={geo.x(data.hindcast.at(-1)!.year)} x2={geo.x(data.hindcast.at(-1)!.year)} y1={T} y2={H - B} stroke="currentColor" strokeOpacity={0.25} strokeDasharray="2,2" />

          {geo.scenarios.map((s) => <path key={s.key} d={s.d} fill="none" stroke={`var(--wb-${s.slot})`} strokeWidth={2} strokeDasharray={s.dash ? '4,3' : undefined} strokeLinejoin="round" />)}
          <path d={geo.hindcast} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
          {geo.observed.map((o) => <circle key={o.year} cx={geo.x(o.year)} cy={geo.y(o.level)} r={3} className="fill-background" stroke="currentColor" strokeWidth={1.5} />)}
          {endLabels.map((s) => <text key={s.key} x={W - R + 4} y={s.ly + 3} fontSize={9} className="fill-foreground">{s.label}</text>)}

          {selectedRow && <g pointerEvents="none">
            <line x1={geo.x(selectedYear)} x2={geo.x(selectedYear)} y1={T} y2={H - B} className="stroke-primary" strokeWidth={1.5} />
            <circle cx={geo.x(selectedYear)} cy={geo.y(selectedRow.level)} r={4.5} className="fill-primary stroke-background" strokeWidth={2} />
          </g>}
          {hover != null && hover !== selectedYear && <g pointerEvents="none">
            <line x1={geo.x(hover)} x2={geo.x(hover)} y1={T} y2={H - B} stroke="currentColor" strokeOpacity={0.5} />
            {hoverRows.map((h) => h.row && <circle key={h.label} cx={geo.x(hover)} cy={geo.y(h.row.level)} r={3.5}
              fill={h.slot ? `var(--wb-${h.slot})` : 'currentColor'} className="stroke-background" strokeWidth={2} />)}
          </g>}
        </svg>

        <div className="min-h-[5.5rem] mt-1 tabular-nums" aria-live="polite">
          {<>
            <div className="font-semibold">{readYear}{hover == null && <span className="font-normal text-muted-foreground"> · on the map</span>}{observedAtHover != null && <span className="font-normal text-muted-foreground"> · observed {fmt(observedAtHover)} m</span>}</div>
            <table className="w-full"><tbody>
              {hoverRows.map((h) => h.row && <tr key={h.label}>
                <td><i className="inline-block w-3 h-0.5 mr-1.5 align-middle" style={{ background: h.slot ? `var(--wb-${h.slot})` : 'currentColor', opacity: h.dash ? 0.6 : 1 }} />{h.label}</td>
                <td className="text-right">{fmt(h.row.level)} m</td>
                <td className="text-right">{h.row.area.toLocaleString()} km²</td>
                <td className="text-right">{fmt(h.row.volume, 0)} km³</td>
              </tr>)}
            </tbody></table>
          </>}
        </div>

        <div className="mt-2 space-y-2 rounded border border-border/60 p-2">
          <div className="flex items-center gap-2">
            <button className="rounded border border-border px-2 py-0.5 hover:bg-accent min-w-[3.5rem]" aria-pressed={playing}
              onClick={() => { if (!playing && selectedYear >= geo.y1) setYear(geo.y0); setPlaying((p) => !p); }}>
              {playing ? 'Pause' : 'Play'}
            </button>
            <input type="range" aria-label="Year shown on the map" className="flex-1" min={geo.y0} max={geo.y1} step={1} value={selectedYear}
              onChange={(e) => { setPlaying(false); setYear(Number(e.target.value)); }} />
            <span className="tabular-nums w-9 text-right">{selectedYear}</span>
          </div>
          <label className="flex items-center justify-between gap-2">After {lastHindcast}
            <select aria-label="Scenario shown on the map" value={scenario} onChange={(e) => setScenario(e.target.value as ScenarioKey)}
              className="rounded border border-border bg-background px-1.5 py-0.5">
              {SERIES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </label>
          {selectedRow && <div className="tabular-nums">
            <span className="font-semibold">{fmt(selectedRow.level)} m</span>
            <span className="text-muted-foreground"> · {selectedYear <= lastHindcast ? 'model history' : selectedSeries.label}
              {areaFraction != null && ` · ${Math.round(areaFraction * 100)}% of today's mapped lake`}</span>
          </div>}
          <p className="text-[10px] text-muted-foreground leading-snug">
            Blue = water, pale = exposed lake bed. The area matches the survey curve, but where the shore retreats is estimated
            (deeper water assumed farther from shore). Above {'≈'}342.2 m the map shows today's outline.
          </p>
        </div>

        <ul className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-[10px]" aria-label="Legend">
          <li className="flex items-center gap-1"><i className="inline-block w-3 h-0.5 bg-foreground" />Model history</li>
          <li className="flex items-center gap-1"><i className="inline-block w-2 h-2 rounded-full border border-foreground" />Observed</li>
          {SERIES.filter((s) => !s.dash).map((s) => <li key={s.key} className="flex items-center gap-1">
            <i className="inline-block w-3 h-0.5" style={{ background: `var(--wb-${s.slot})` }} />{s.label}</li>)}
          <li className="flex items-center gap-1"><i className="inline-block w-3 border-t-2 border-dashed border-muted-foreground" />dry year (Q75)</li>
        </ul>

        <button className="mt-2 text-primary hover:underline" onClick={() => setShowTable((v) => !v)} aria-expanded={showTable}>
          {showTable ? 'Hide' : 'Show'} long-run equilibrium table
        </button>
        {showTable && <table className="w-full mt-1 tabular-nums">
          <thead><tr className="text-muted-foreground"><th className="text-left font-normal">Scenario</th><th className="text-right font-normal">2050</th><th className="text-right font-normal">Equilibrium</th><th className="text-right font-normal">Area</th><th className="text-right font-normal">Volume</th></tr></thead>
          <tbody>{SERIES.map((s) => { const sc = data.scenarios[s.key]; return <tr key={s.key}>
            <td>{s.label}</td>
            <td className="text-right">{fmt(rowAt(sc.rows, 2050)?.level ?? NaN)}</td>
            <td className="text-right">{fmt(sc.equilibrium.level)}{sc.equilibrium.extrapolated ? '*' : ''}</td>
            <td className="text-right">{sc.equilibrium.area.toLocaleString()}</td>
            <td className="text-right">{fmt(sc.equilibrium.volume, 0)}</td>
          </tr>; })}</tbody>
        </table>}

        <p className="text-[10px] text-muted-foreground mt-2 leading-snug">
          Monthly bucket model: river inflow + rain − evaporation × lake area. Inflow is gauged period means, so single wet or dry years
          are not reproduced. Fit to observed levels: ±{fmt(data.calibration.rmse_m)} m RMSE (misses the 1987 low by ~1 m).
          Scenario inflow and evaporation follow Alimkulov et al. (2025).
        </p>
        <details className="mt-1 text-[10px] text-muted-foreground">
          <summary className="cursor-pointer">Sources</summary>
          <ul className="mt-1 space-y-1">{Object.entries(data.sources).map(([k, v]) => <li key={k}><span className="text-foreground">{k}:</span> {v}</li>)}</ul>
        </details>
      </>}
    </div>
  );
};

export default WaterBalancePanel;
