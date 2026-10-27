import { useState } from 'react';
import { onsetColor, type SentinelChangeKind } from '@/lib/sentinel-change';
import type { SentinelChangeExplorer } from '@/hooks/useSentinelChange';

const KIND_LABEL: Record<SentinelChangeKind, string> = { vegetation: 'Vegetation loss', bare: 'New bare ground', radar: 'Radar' };
const fmt = (v: number | null, digits = 2) => v === null ? '—' : v.toFixed(digits);

export default function SentinelChangePanel({ explorer: s, onClose }: { explorer: SentinelChangeExplorer; onClose: () => void }) {
  const control = 'rounded border border-border px-2 py-1 hover:bg-accent disabled:opacity-50';
  const m = s.manifest;
  const yearSelect = (label: string, value: number | undefined, set: (y: number) => void, exclude?: number) =>
    <label className="flex items-center justify-between gap-2">{label}
      <select aria-label={label} value={value ?? ''} onChange={e => set(Number(e.target.value))} className={`${control} bg-background`}>
        {s.years.filter(y => y !== exclude).map(y => <option key={y} value={y}>{y}</option>)}
      </select>
    </label>;
  const info = (year?: number) => m?.years.find(y => y.year === year);
  // Minimizing hides only the controls; the overlay stays on the terrain.
  const [minimized, setMinimized] = useState(false);
  const summary = !s.years.length ? (s.status === 'error' ? 'unavailable' : 'loading…')
    : s.mode === 'change' ? `${KIND_LABEL[s.kind]} · ${s.yearA}→${s.yearB}`
    : s.mode === 'onset' ? `Year of loss · since ${s.years[0] ?? ''}` : `Imagery · ${s.yearA} | ${s.yearB}`;

  if (minimized) return <section aria-label="Sentinel change" className="absolute left-3 bottom-28 z-[110] max-w-[calc(100vw-1.5rem)] flex items-center gap-2 rounded-md border border-border bg-background/95 py-1.5 pl-3 pr-1.5 shadow-lg backdrop-blur text-xs">
    <button onClick={() => setMinimized(false)} aria-label="Expand Sentinel change" aria-expanded={false} className="flex items-center gap-2 text-left hover:text-primary">
      <span className="font-semibold">Sentinel</span>
      <span className="text-muted-foreground truncate">{summary}</span>
    </button>
    <button onClick={() => setMinimized(false)} aria-label="Expand Sentinel change panel" className={control}>▴</button>
    <button onClick={onClose} aria-label="Close Sentinel change" className={control}>×</button>
  </section>;

  return <section aria-label="Sentinel change" className="absolute left-3 bottom-28 z-[110] w-72 max-w-[calc(100vw-1.5rem)] max-h-[calc(100dvh-10rem)] overflow-auto rounded-md border border-border bg-background/95 p-4 shadow-lg backdrop-blur text-xs space-y-3">
    <div className="flex items-center justify-between gap-2">
      <h2 className="font-semibold">Sentinel · summer composites</h2>
      <div className="flex gap-1">
        <button onClick={() => setMinimized(true)} aria-label="Minimize Sentinel change" aria-expanded className={control}>–</button>
        <button onClick={onClose} aria-label="Close Sentinel change" className={control}>×</button>
      </div>
    </div>
    {m && <p className="text-muted-foreground">Median of clear {m.season.start}–{m.season.end} observations each year · Sentinel-2 10–20 m, Sentinel-1 RTC orbit {m.s1Orbit.relative} ({m.s1Orbit.state})</p>}
    <div className="flex gap-2 flex-wrap" aria-label="Sentinel mode">
      {(['change', 'onset', 'imagery'] as const).map(mode => <button key={mode} className={`${control} ${s.mode === mode ? 'bg-accent' : ''}`} aria-pressed={s.mode === mode} onClick={() => s.setMode(mode)}>
        {({ change: 'Change', onset: 'Year of loss', imagery: 'Imagery' })[mode]}</button>)}
    </div>

    {s.mode === 'change' && <>
      {yearSelect('From', s.yearA, s.setYearA)}
      {yearSelect('To', s.yearB, s.setYearB, s.yearA)}
      <div className="flex gap-2 flex-wrap" aria-label="Change signal">
        {(['vegetation', 'bare', 'radar'] as const).map(k => <button key={k} className={`${control} ${s.kind === k ? 'bg-accent' : ''}`} aria-pressed={s.kind === k} onClick={() => s.setKind(k)}>{KIND_LABEL[k]}</button>)}
      </div>
      <label className="block">Minimum change <span className="float-right">{s.kind === 'radar' ? `${s.threshold.toFixed(1)} dB` : s.threshold.toFixed(2)}</span>
        <input aria-label="Minimum change" className="w-full" type="range" min={s.kind === 'radar' ? 1 : 0.05} max={s.kind === 'radar' ? 10 : 0.6} step={s.kind === 'radar' ? 0.5 : 0.01} value={s.threshold} onChange={e => s.setThreshold(Number(e.target.value))} />
      </label>
      {s.kind === 'radar'
        ? <div className="flex justify-between gap-2"><span className="flex items-center gap-1"><i className="inline-block w-3 h-3 rounded-sm" style={{ background: '#ff7a28' }} />darker</span><span className="flex items-center gap-1"><i className="inline-block w-3 h-3 rounded-sm" style={{ background: '#a0f0ff' }} />brighter</span></div>
        : <div className="h-2 rounded" style={{ background: 'linear-gradient(to right, #ffd25a, #d7236e)' }} />}
      <p className="text-muted-foreground">{{
        vegetation: 'Drop in NDVI where the "From" year was vegetated (NDVI ≥ 0.3): clearing, grading, new roads.',
        bare: 'Rise in bare-soil index on formerly vegetated ground: earthworks, pads, cuts.',
        radar: 'Change in VH backscatter. Brighter often means new structures or rough fill; darker means smoothed or cleared ground. Steep slopes facing away from the satellite are less reliable.',
      }[s.kind]}</p>
      {s.stats && <p>{s.stats.hectares.toFixed(1)} ha changed · {(s.stats.changed / Math.max(1, s.stats.comparable) * 100).toFixed(1)}% of {s.stats.comparable.toLocaleString()} comparable pixels</p>}
    </>}

    {s.mode === 'onset' && <>
      <label className="block">NDVI drop vs {s.years[0]} <span className="float-right">{s.onsetThreshold.toFixed(2)}</span>
        <input aria-label="Onset NDVI drop" className="w-full" type="range" min={0.05} max={0.5} step={0.01} value={s.onsetThreshold} onChange={e => s.setOnsetThreshold(Number(e.target.value))} />
      </label>
      <p className="text-muted-foreground">Colour = first year vegetation fell below its {s.years[0]} level and stayed down in every later year. One-off dips are ignored.</p>
      {s.onsetCounts && <ul className="space-y-1">
        {s.onsetCounts.map((c, i) => <li key={c.year} className="flex items-center gap-2">
          <i className="inline-block w-3 h-3 rounded-sm" style={{ background: `rgb(${onsetColor(i, s.years.length - 1).join(',')})` }} />
          <span className="w-10">{c.year}</span>
          <span className="flex-1 h-1.5 rounded bg-muted overflow-hidden"><span className="block h-full bg-foreground/60" style={{ width: `${Math.min(100, c.hectares / Math.max(...s.onsetCounts!.map(x => x.hectares), 1) * 100)}%` }} /></span>
          <span className="w-16 text-right tabular-nums whitespace-nowrap">{c.hectares.toFixed(1)} ha</span>
        </li>)}
      </ul>}
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-0.5" checked={s.includeLatest} onChange={e => s.setIncludeLatest(e.target.checked)} />
        <span>Include {s.years.at(-1)} <span className="text-muted-foreground">(unconfirmed: no later year yet, so it includes one-off dips such as a dry summer)</span></span>
      </label>
    </>}

    {s.mode === 'imagery' && <>
      {yearSelect('Left', s.yearA, s.setYearA)}
      {yearSelect('Right', s.yearB, s.setYearB, s.yearA)}
      <div className="flex gap-2 flex-wrap" aria-label="Imagery view">
        {(['a', 'b', 'swipe'] as const).map(v => <button key={v} className={`${control} ${s.imageryView === v ? 'bg-accent' : ''}`} aria-pressed={s.imageryView === v} onClick={() => s.setImageryView(v)}>{v === 'a' ? s.yearA : v === 'b' ? s.yearB : 'Swipe'}</button>)}
      </div>
      {s.imageryView === 'swipe' && <label className="block">Swipe position
        <input aria-label="Swipe position" className="w-full" type="range" min={0} max={1} step={0.01} value={s.swipe} onChange={e => s.setSwipe(Number(e.target.value))} />
      </label>}
      <p className="text-muted-foreground">True-colour medians of each summer, about 14 m per pixel. They replace the fixed 2023 basemap for historical comparison.</p>
    </>}

    <label className="block">Opacity <span className="float-right">{Math.round(s.opacity * 100)}%</span>
      <input aria-label="Sentinel opacity" className="w-full" type="range" min={0} max={1} step={0.05} value={s.opacity} onChange={e => s.setOpacity(Number(e.target.value))} />
    </label>

    {s.pointSeries ? <div className="space-y-1 rounded border border-border p-2">
      <div className="flex items-center justify-between gap-2"><span>{s.point!.lat.toFixed(5)}, {s.point!.lon.toFixed(5)}</span><button className={control} onClick={() => s.setPoint(null)}>Clear</button></div>
      <table className="w-full tabular-nums"><thead><tr className="text-muted-foreground"><th className="text-left font-normal">Year</th><th className="text-right font-normal">NDVI</th><th className="text-right font-normal">BSI</th><th className="text-right font-normal">VH dB</th></tr></thead>
        <tbody>{s.pointSeries.map(r => <tr key={r.year}><td>{r.year}</td><td className="text-right">{fmt(r.ndvi)}</td><td className="text-right">{fmt(r.bsi)}</td><td className="text-right">{fmt(r.vh, 1)}</td></tr>)}</tbody>
      </table>
    </div> : <p className="text-muted-foreground">Click the terrain to see a pixel's yearly values.</p>}

    <div role="status" aria-live="polite">{s.status === 'loading' ? 'Loading Sentinel composites…' : s.status === 'ready' ? `Ready · ${s.years.length} years${info(s.yearB) ? ` · ${info(s.yearB)!.s2Dates} clear-sky dates in ${s.yearB}` : ''}` : null}</div>
    {s.error && <div role="alert" className="text-destructive space-y-2"><p>{s.error}</p><button className={control} onClick={s.retry}>Reload data</button></div>}
    <p>Spectral changes show where the surface changed, not why.</p>
    <p className="text-[10px] leading-relaxed text-muted-foreground">{m?.attribution ?? 'Contains modified Copernicus Sentinel data.'}</p>
  </section>;
}
