import { ShorelineControls, LocalDifferenceControls, TimelineControls } from './EmbeddingAnalysisControls';
import type { EmbeddingTimeline } from '@/hooks/useEmbeddingTimeline';
import { formatEmbeddingMeters } from '@/lib/satellite-embeddings';
import EmbeddingSearchResults from './EmbeddingSearchResults';
import type { EmbeddingSearch } from '@/hooks/useEmbeddingSearch';
import type { EmbeddingMatch } from '@/lib/embedding-search';
import type { EmbeddingExplorer } from '@/hooks/useSatelliteEmbeddings';

export default function SatelliteEmbeddingPanel({ explorer: e, onClose, search, onOpenMatch, timeline }: {
  timeline: EmbeddingTimeline; explorer: EmbeddingExplorer; onClose: () => void; search: EmbeddingSearch; onOpenMatch: (match: EmbeddingMatch) => void;
}) {
  const control = 'rounded border border-border px-2 py-1 hover:bg-accent disabled:opacity-50';
  return <section aria-label="Satellite embeddings" className="absolute left-3 bottom-28 z-20 w-72 max-w-[calc(100vw-1.5rem)] max-h-[calc(100dvh-10rem)] overflow-auto rounded-md border border-border bg-background/95 p-4 shadow-lg backdrop-blur text-xs space-y-3">
    <div className="flex items-center justify-between gap-2">
      <h2 className="font-semibold">AlphaEarth · {e.year}</h2>
      <button onClick={onClose} aria-label="Close embeddings" className={control}>×</button>
    </div>
    <p className="text-muted-foreground">Annual satellite embeddings · 10 m native source</p>
    {e.metadata && <p className="text-muted-foreground">Displayed grid ≈ {formatEmbeddingMeters(e.gridMeters)}{(e.metadata.aggregationMeters ?? 10) > 10 ? ` · ${formatEmbeddingMeters(e.metadata.aggregationMeters!)} source overview` : ''}</p>}
    <label className="flex items-center justify-between gap-2">Year
      <select aria-label="Embedding year" value={e.year} onChange={event => e.setYear(Number(event.target.value))} className={`${control} bg-background`}>
        {e.years.map(year => <option key={year} value={year}>{year}</option>)}
      </select>
    </label>
    <div className="flex gap-2 flex-wrap" aria-label="Embedding mode">
      <button className={`${control} ${e.mode === 'overview' ? 'bg-accent' : ''}`} aria-pressed={e.mode === 'overview'} onClick={() => e.setMode('overview')}>Overview</button>
      <button className={`${control} ${e.mode === 'similarity' ? 'bg-accent' : ''}`} aria-pressed={e.mode === 'similarity'} onClick={() => e.setMode('similarity')}>Find similar</button>
      <button className={`${control} ${e.mode === 'change' ? 'bg-accent' : ''}`} disabled={e.years.length < 2} aria-pressed={e.mode === 'change'} onClick={() => e.setMode('change')}>Changes</button>
      {(['shoreline', 'anomaly', 'transition', 'timeline'] as const).map(mode => <button key={mode} className={`${control} ${e.mode === mode ? 'bg-accent' : ''}`} aria-pressed={e.mode === mode} disabled={mode === 'timeline' && e.years.length < 2} onClick={() => { e.setMode(mode); if (mode === 'timeline') e.setTool('point'); }}>{({ shoreline: 'Shoreline', anomaly: 'Unusual', transition: 'Transitions', timeline: 'Timeline' })[mode]}</button>)}
    </div>
    {e.mode === 'shoreline' ? <ShorelineControls e={e} /> : e.mode === 'anomaly' || e.mode === 'transition' ? <LocalDifferenceControls e={e} /> : e.mode === 'timeline' ? <TimelineControls e={e} timeline={timeline} /> : e.mode === 'change' ? <>
      <label className="flex items-center justify-between gap-2">Compare with
        <select aria-label="Comparison year" value={e.comparisonYear ?? ''} onChange={event => e.setComparisonYear(Number(event.target.value))} className={`${control} bg-background`}>
          {e.years.filter(year => year !== e.year).map(year => <option key={year} value={year}>{year}</option>)}
        </select>
      </label>
      <p className="text-muted-foreground">Annual embeddings are compared over a fixed 2023 satellite basemap.</p>
      <div className="flex flex-wrap gap-2" aria-label="Comparison view">
        {(['change', 'base', 'comparison', 'swipe'] as const).map(view => <button key={view} className={`${control} ${e.changeView === view ? 'bg-accent' : ''}`} aria-pressed={e.changeView === view} onClick={() => e.setChangeView(view)}>{view === 'change' ? 'Difference' : view === 'base' ? e.year : view === 'comparison' ? e.comparisonYear : 'Swipe'}</button>)}
      </div>
      {e.changeView === 'swipe' ? <label className="block">Swipe position
        <input aria-label="Swipe position" className="w-full" type="range" min={0} max={1} step={0.01} value={e.swipe} onChange={event => e.setSwipe(Number(event.target.value))} />
      </label> : e.changeView === 'change' ? <>
        <label className="block">Minimum change <span className="float-right">{e.changeThreshold.toFixed(2)}</span>
          <input aria-label="Minimum embedding change" className="w-full" type="range" min={0} max={1} step={0.01} value={e.changeThreshold} onChange={event => e.setChangeThreshold(Number(event.target.value))} />
        </label>
        <div className="h-2 rounded" style={{ background: 'linear-gradient(to right, #ffd25a, #d7236e)' }} />
        <div className="flex justify-between text-muted-foreground"><span>{e.changeThreshold.toFixed(2)}</span><span>≥ {(e.changeThreshold + 0.5).toFixed(2)}</span></div>
        <p className="text-muted-foreground">Change = 1 − cosine similarity (0–2). Zero means identical vectors.</p>
        {e.changeStats && <p>{(e.changeStats.aboveThreshold / e.changeStats.validPixels * 100).toFixed(1)}% above threshold · {e.changeStats.validPixels.toLocaleString()} comparable pixels.</p>}
      </> : null}
      <p>Annual embedding differences can reveal surface changes; they do not identify their cause.</p>
    </> : e.mode === 'overview' ? <p>Colours represent embedding differences, not land-cover classes.</p> : <>
      <div className="flex gap-2" aria-label="Selection tool">
        {(['move', 'point', 'brush'] as const).map(tool => <button key={tool} className={`${control} ${e.tool === tool ? 'bg-accent' : ''}`}
          aria-pressed={e.tool === tool} onClick={() => e.setTool(tool)}>{tool === 'move' ? 'Move' : tool === 'point' ? 'Point' : 'Brush'}</button>)}
      </div>
      <p>{e.tool === 'brush' ? 'Drag on terrain to paint an example. Strokes add to the purple area. Choose Move to navigate.' : e.tool === 'point' ? 'Click terrain to find places with similar annual satellite signatures.' : 'Move the map freely. Choose Point or Brush to select an example.'}</p>
      {e.tool === 'brush' && <label className="block">Brush radius <span className="float-right">{formatEmbeddingMeters(e.brushRadius)}</span>
        <input aria-label="Brush radius" className="w-full" type="range" min={e.brushMin} max={e.brushMax} step={e.brushStep} value={e.brushRadius} onChange={event => e.setBrushRadius(Number(event.target.value))} />
      </label>}
      {e.externalReference && <div className="space-y-2 rounded border border-border p-2"><p>Reference from {e.externalReference.sourceLabel}</p><p className="text-muted-foreground">Matched patch · cos {e.externalReference.score.toFixed(3)}</p><button className={control} onClick={() => e.setPoint(null)}>Clear reference</button></div>}
      {e.pixels && <div className="flex items-center justify-between gap-2"><span>{e.pixels.length.toLocaleString()} selected pixels{e.status === 'ready' ? ` · ${e.sampleCount.toLocaleString()} valid` : ''}</span><button className={control} onClick={() => e.setPoint(null)}>Reset</button></div>}
      {e.point && <div className="flex items-center justify-between gap-2"><span>{e.point.lat.toFixed(5)}, {e.point.lon.toFixed(5)}</span><button className={control} onClick={() => e.setPoint(null)}>Reset</button></div>}
      <label className="block">Minimum cosine similarity <span className="float-right">{e.threshold.toFixed(2)}</span>
        <input aria-label="Minimum cosine similarity" className="w-full" type="range" min={0} max={0.99} step={0.01} value={e.threshold} onChange={event => e.setThreshold(Number(event.target.value))} />
      </label>
      {e.point || e.pixels || e.externalReference ? <><div className="h-2 rounded" style={{ background: 'linear-gradient(to right, #2da0b4, #ffe62d)' }} /><div className="flex justify-between text-muted-foreground"><span>{e.threshold.toFixed(2)}</span><span>1.00 · most similar</span></div></> : <p className="text-muted-foreground">Overview is shown until you select an example.</p>}
      <p className="text-muted-foreground">Cosine similarity is not a probability.</p>
      <EmbeddingSearchResults search={search} year={e.year} canSearch={!!e.reference && e.status === 'ready'} onOpen={onOpenMatch} />
    </>}
    <label className="block">Opacity <span className="float-right">{Math.round(e.opacity * 100)}%</span>
      <input aria-label="Embedding opacity" className="w-full" type="range" min={0} max={1} step={0.05} value={e.opacity} onChange={event => e.setOpacity(Number(event.target.value))} />
    </label>
    <div role="status" aria-live="polite">{e.status === 'loading' ? 'Loading satellite data…' : e.status === 'computing' ? 'Computing…' : e.status === 'ready' ? 'Ready' : null}</div>
    {e.error && <div role="alert" className="text-destructive space-y-2"><p>{e.error}</p><button className={control} onClick={e.retry}>Reload data</button></div>}
    <p className="text-[10px] text-muted-foreground">Population and water overlays pause while Embeddings is open.</p>
    <p className="text-[10px] leading-relaxed text-muted-foreground">The AlphaEarth Foundations Satellite Embedding dataset is produced by Google and Google DeepMind.{' '}
      <a className="underline" href="https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_SATELLITE_EMBEDDING_V1_ANNUAL" target="_blank" rel="noreferrer">Dataset</a> · <a className="underline" href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>
    </p>
  </section>;
}
