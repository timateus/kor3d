import type { EmbeddingExplorer } from '@/hooks/useSatelliteEmbeddings';
import type { EmbeddingTimeline } from '@/hooks/useEmbeddingTimeline';
import { formatEmbeddingMeters } from '@/lib/satellite-embeddings';

const control = 'rounded border border-border px-2 py-1 hover:bg-accent disabled:opacity-50';
export function EmbeddingSelection({ e, pointOnly = false }: { e: EmbeddingExplorer; pointOnly?: boolean }) {
  return <div className="space-y-2">
    <div className="flex gap-2" aria-label="Selection tool">
      {(pointOnly ? ['move', 'point'] as const : ['move', 'point', 'brush'] as const).map(tool => <button key={tool} aria-pressed={e.tool === tool} className={`${control} ${e.tool === tool ? 'bg-accent' : ''}`} onClick={() => e.setTool(tool)}>{tool === 'move' ? 'Move' : tool === 'point' ? 'Point' : 'Brush'}</button>)}
    </div>
    <p>{e.tool === 'move' ? 'Move the map. Choose Point to select an example.' : e.tool === 'brush' && !pointOnly ? 'Paint a water example. Strokes add to the selection.' : pointOnly ? 'Click a patch to follow its annual signature.' : 'Click a known water patch to use as the reference.'}</p>
    {!pointOnly && e.tool === 'brush' && <label className="block">Brush radius · {formatEmbeddingMeters(e.brushRadius)}<input aria-label="Brush radius" className="w-full" type="range" min={e.brushMin} max={e.brushMax} step={e.brushStep} value={e.brushRadius} onChange={event => e.setBrushRadius(Number(event.target.value))} /></label>}
    {e.point && <p>{e.point.lat.toFixed(5)}, {e.point.lon.toFixed(5)}</p>}
    {!pointOnly && e.pixels && <p>{e.pixels.length.toLocaleString()} selected cells · {e.sampleCount.toLocaleString()} valid</p>}
    {(e.point || e.pixels || e.externalReference) && <button className={control} onClick={() => e.setPoint(null)}>Reset example</button>}
  </div>;
}

export function ShorelineControls({ e }: { e: EmbeddingExplorer }) {
  return <div className="space-y-3">
    <p>Choose a water example, then adjust similarity. Yellow marks the candidate boundary; blue marks the matching extent.</p>
    <EmbeddingSelection e={e} />
    {e.externalReference && <p>Reference from {e.externalReference.sourceLabel}. Reset and choose local water if needed.</p>}
    <label className="block">Water-example similarity · {e.threshold.toFixed(2)}<input aria-label="Water example similarity" className="w-full" type="range" min={0} max={.99} step={.01} value={e.threshold} onChange={event => e.setThreshold(Number(event.target.value))} /></label>
    <label className="flex gap-2 items-center"><input type="checkbox" checked={e.compareShoreline && e.years.length > 1} disabled={e.years.length < 2} onChange={event => e.setCompareShoreline(event.target.checked)} />Compare candidate extent</label>
    {e.compareShoreline && e.years.length > 1 && <>
      <label className="flex items-center justify-between">Compare with<select aria-label="Shoreline comparison year" className={`${control} bg-background`} value={e.comparisonYear} onChange={event => e.setComparisonYear(Number(event.target.value))}>{e.years.filter(year => year !== e.year).map(year => <option key={year} value={year}>{year}</option>)}</select></label>
      <p className="text-muted-foreground">Uses the same {e.year} reference for both years. Green: gain · pink: loss, relative to {e.comparisonYear}, within common valid coverage.</p>
    </>}
    {e.status === 'ready' && e.shorelineStats && <div role="status" className="space-y-1 rounded border border-border p-2">
      <p>{e.year}: {e.shorelineStats.areaKm2.toFixed(2)} km² matching extent</p>
      {e.shorelineStats.comparisonAreaKm2 !== null && <><p>{e.comparisonYear}: {e.shorelineStats.comparisonAreaKm2.toFixed(2)} km²</p><p>Gain {e.shorelineStats.gainKm2!.toFixed(2)} · loss {e.shorelineStats.lossKm2!.toFixed(2)} km²</p></>}
      <p>{e.shorelineStats.boundaryEdges.toLocaleString()} boundary segments</p>
    </div>}
    <button className={control} disabled={e.status !== 'ready' || !e.shorelineStats?.boundaryEdges} onClick={e.exportShoreline}>Export candidate GeoJSON</button>
    <p className="text-muted-foreground">Candidate water signatures may match other surfaces. Verify against imagery. Boundary precision is limited by the ≈{formatEmbeddingMeters(e.gridMeters)} grid; scene edges and missing data are excluded.</p>
  </div>;
}

export function LocalDifferenceControls({ e }: { e: EmbeddingExplorer }) {
  return <div className="space-y-3">
    <p>{e.mode === 'anomaly' ? 'Highlights a patch that differs from the mean signature of eight surrounding patches.' : 'Highlights differences between patches on opposite sides of a location. Use it to explore landscape boundaries.'}</p>
    <label className="block">Neighbourhood radius · {formatEmbeddingMeters(e.radius * e.gridMeters)}<input aria-label="Neighbourhood radius" className="w-full" type="range" min={1} max={8} step={1} value={e.radius} onChange={event => e.setRadius(Number(event.target.value))} /></label>
    <label className="block">Minimum local difference · {e.localThreshold.toFixed(2)}<input aria-label="Minimum local difference" className="w-full" type="range" min={0} max={.5} step={.01} value={e.localThreshold} onChange={event => e.setLocalThreshold(Number(event.target.value))} /></label>
    <div className="h-2 rounded" style={{ background: 'linear-gradient(to right,#ffc850,#af28dc)' }} /><p className="text-muted-foreground">Low → high angular difference (0–2)</p>
    {e.status === 'ready' && e.localStats && <p role="status">{e.localStats.validPixels ? (e.localStats.aboveThreshold / e.localStats.validPixels * 100).toFixed(1) : '0'}% above threshold · {e.localStats.validPixels.toLocaleString()} valid neighbourhoods.</p>}
    <p className="text-muted-foreground">An unusual signature does not establish an error or disturbance. Transitions do not label water, wetland, or urban classes. Incomplete neighbourhoods are excluded.</p>
  </div>;
}

export function TimelineControls({ e, timeline: t }: { e: EmbeddingExplorer; timeline: EmbeddingTimeline }) {
  const baseline = t.data.find(sample => sample.fromBaseline !== null)?.year;
  const max = Math.max(.1, ...t.data.map(sample => sample.fromBaseline ?? 0), ...t.data.map(sample => sample.fromPrevious ?? 0));
  const first = Math.min(...e.years), last = Math.max(...e.years);
  const x = (year: number) => 24 + (year - first) / Math.max(1, last - first) * 216;
  const y = (value: number) => 114 - value / max * 92;
  const largest = t.status === 'ready' ? t.data.filter(sample => sample.fromPrevious !== null).sort((a, b) => b.fromPrevious! - a.fromPrevious!)[0] : null;
  return <div className="space-y-3">
    <EmbeddingSelection e={e} pointOnly />
    <p className="text-muted-foreground">Same ground cell across {e.years.length} available years. Annual signature distance is 1 − cosine similarity (0–2).</p>
    {t.status === 'loading' && <p role="status">Reading annual signatures · {t.data.length}/{e.years.length}…</p>}
    {t.error && <div role="alert"><p>{t.error}</p><button className={control} onClick={t.retry}>Retry timeline</button></div>}
    {t.data.length > 0 && <>
      <svg className="w-full" viewBox="0 0 264 144" role="img" aria-label={`Annual embedding distance from ${baseline ?? 'baseline'} and previous year`}>
        <path d="M24 20V114H244" fill="none" stroke="currentColor" opacity=".4" />
        <text x="2" y="22" fontSize="9" fill="currentColor">{max.toFixed(2)}</text><text x="10" y="117" fontSize="9" fill="currentColor">0</text>
        {t.data.map((sample, i) => { const previous = t.data[i - 1]; return <g key={sample.year}>
          {sample.fromBaseline !== null && <><circle cx={x(sample.year)} cy={y(sample.fromBaseline)} r="3" fill="#56d5d1"><title>{sample.year}: {sample.fromBaseline.toFixed(3)} from {baseline}</title></circle>{previous?.fromBaseline !== null && previous && previous.year === sample.year - 1 && <line x1={x(previous.year)} y1={y(previous.fromBaseline!)} x2={x(sample.year)} y2={y(sample.fromBaseline)} stroke="#56d5d1" />}</>}
          {sample.fromPrevious !== null && <circle cx={x(sample.year)} cy={y(sample.fromPrevious)} r="2.5" fill="#fbbf65"><title>{sample.year}: {sample.fromPrevious.toFixed(3)} from previous year</title></circle>}
          {(sample.year === first || sample.year === last || sample.year % 2 === 1) && <text x={x(sample.year)} y="135" textAnchor="middle" fontSize="9" fill="currentColor">{sample.year}</text>}
        </g>; })}
      </svg>
      <p><span style={{ color: '#56d5d1' }}>● From {baseline ?? 'first valid year'}</span> · <span style={{ color: '#fbbf65' }}>● From previous year</span></p>
      <table className="w-full text-right"><caption className="sr-only">Annual embedding distances</caption><thead><tr><th className="text-left">Year</th><th>Baseline</th><th>Previous</th></tr></thead><tbody>{t.data.map(sample => <tr key={sample.year}><th className="text-left font-normal">{sample.year}</th><td>{sample.fromBaseline?.toFixed(3) ?? 'No data'}</td><td>{sample.fromPrevious?.toFixed(3) ?? '—'}</td></tr>)}</tbody></table>
      {largest && <p>Largest consecutive-year shift: {largest.year - 1} → {largest.year} ({largest.fromPrevious!.toFixed(3)}).</p>}
    </>}
    <p className="text-muted-foreground">A return toward the baseline indicates a more similar signature, not confirmed ecological recovery. The imagery underneath remains 2023.</p>
  </div>;
}
