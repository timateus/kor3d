import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowUpRight, ChevronLeft, ChevronRight, Pause, Play, RotateCcw } from 'lucide-react';
import GlacierTestScene, { type GlacierTestLayer } from '@/components/location/GlacierTestScene';
import { dateLabel, frameStats, loadGlacierTest, validSpeed, type GlacierTestData } from '@/lib/glacier-test';
import GlacierModelExplorer from '@/components/location/GlacierModelExplorer';
import './GlacierTestPage.css';

const PAPERS = {
  velocity: 'https://doi.org/10.1016/j.srs.2025.100266',
  velocityData: 'https://zenodo.org/records/15366525',
  pgo: 'https://tc.copernicus.org/articles/18/5551/2024/',
  pgoData: 'https://doi.theia.data-terra.org/pgo/',
  history: 'https://www.frontiersin.org/journals/earth-science/articles/10.3389/feart.2020.00259/full',
  glims: 'https://www.glims.org/glacierdata/index.php',
};
type Layer = GlacierTestLayer | 'model';
const LAYERS: { id: Layer; number: string; label: string }[] = [
  { id: 'velocity', number: '01', label: 'Ice velocity' },
  { id: 'outlines', number: '02', label: 'Dated outlines' },
  { id: 'elevation', number: '03', label: 'Surface change' },
  { id: 'model', number: '04', label: '3D glacier' },
];
function External({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer">{children}<ArrowUpRight size={13} aria-hidden="true" /></a>;
}

function SpeedChart({ data, maxGap, frame, onFrame }: { data: GlacierTestData; maxGap: number; frame: number; onFrame: (v: number) => void }) {
  const stats = useMemo(() => data.velocity.dates.map((_, i) => frameStats(data.velocity, i, maxGap)), [data, maxGap]);
  const yMax = Math.max(20, ...stats.map(s => s.mean ?? 0));
  const points = stats.map((s, i) => ({ x: 12 + i / (stats.length - 1) * 736, y: s.mean === null ? null : 84 - s.mean / yMax * 64 }));
  let moving = false;
  const path = points.map(p => {
    if (p.y === null) { moving = false; return ''; }
    const command = moving ? 'L' : 'M'; moving = true;
    return `${command}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  }).join(' ');
  return <div className="gt-chart">
    <div className="gt-chart-title"><span>Mean speed over displayed cells</span><span>m/year · annualized</span></div>
    <svg viewBox="0 0 760 102" role="img" aria-label="Mean glacier speed from August 2016 to May 2024. Gaps indicate no cells pass the observation-gap filter.">
      {[0, .5, 1].map(t => <g key={t}><line x1="12" x2="748" y1={84 - t * 64} y2={84 - t * 64} stroke="#cbcfc9" strokeDasharray="2 5" /><text x="12" y={80 - t * 64} fill="#67746e" fontSize="9">{Math.round(t * yMax)}</text></g>)}
      <path d={path} fill="none" stroke="#376c6b" strokeWidth="1.7" />
      <line x1={points[frame].x} x2={points[frame].x} y1="12" y2="88" stroke="#a45c43" />
      {points[frame].y !== null && <circle cx={points[frame].x} cy={points[frame].y!} r="3.5" fill="#a45c43" />}
      {[2017, 2019, 2021, 2023].map(year => {
        const i = data.velocity.dates.findIndex(d => d >= `${year}-01-01`);
        return <text key={year} x={points[i].x} y="100" fill="#67746e" fontSize="9">{year}</text>;
      })}
    </svg>
    <input aria-label="Glacier speed date" type="range" min="0" max={data.velocity.dates.length - 1} value={frame} onChange={e => onFrame(Number(e.target.value))} />
    <p>Cell membership changes when estimates fail the filter. This is a descriptive mean, not a glacier-wide mass-balance series.</p>
  </div>;
}

export default function GlacierTestPage() {
  const [data, setData] = useState<GlacierTestData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [params, setParams] = useSearchParams();
  const layer: Layer = LAYERS.find(item => item.id === params.get('layer'))?.id ?? 'velocity';
  const setLayer = (value: Layer) => setParams(previous => { const next = new URLSearchParams(previous); next.set('layer', value); return next; }, { replace: true });
  const [frame, setFrame] = useState(0);
  const [maxGap, setMaxGap] = useState(30);
  const [playing, setPlaying] = useState(false);
  const [outlineDate, setOutlineDate] = useState('1999-09-09');
  const [selected, setSelected] = useState<number | null>(null);
  const [flat, setFlat] = useState(false);
  const [viewVersion, setViewVersion] = useState(0);

  useEffect(() => {
    document.title = 'Tuyuksu · Glacier field test — KÖR3D';
    const controller = new AbortController();
    setError(null);
    loadGlacierTest(controller.signal).then(d => {
      if (!controller.signal.aborted) {
        setData(d);
        setFrame(d.velocity.dates.findIndex(date => date >= '2021-08-21'));
      }
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [retry]);
  useEffect(() => {
    if (!playing || !data || layer !== 'velocity') return;
    const timer = window.setInterval(() => setFrame(f => (f + 1) % data.velocity.dates.length), 220);
    return () => window.clearInterval(timer);
  }, [playing, data, layer]);
  const dates = useMemo(() => data ? [...new Set(data.outlines.map(f => f.properties.src_date?.slice(0, 10)).filter(Boolean))].sort() : [], [data]);
  const stats = useMemo(() => data ? frameStats(data.velocity, frame, maxGap) : null, [data, frame, maxGap]);
  const selectedIndex = selected !== null && data ? frame * data.velocity.cells.length + selected : null;
  const selectedValid = data && selected !== null ? validSpeed(data.velocity, frame, selected, maxGap) : false;
  const count = data?.outlines.filter(f => f.properties.src_date?.startsWith(outlineDate)).length ?? 0;
  const elevationReady = !!data?.change;
  const changeFrame = (value: number) => { setPlaying(false); setFrame(value); };

  return <main className="glacier-test">
    <header className="gt-header">
      <Link to="/tuyuksu-glacier" className="gt-back"><ArrowLeft size={15} /> KÖR3D</Link>
      <span className="gt-kicker">RESEARCH FIELD TEST / 01</span>
      <span className="gt-test-badge">Experimental</span>
    </header>
    <div className="gt-intro"><div><div className="gt-kicker">43.05° N / 77.08° E · NORTHERN TIEN SHAN</div><h1>A glacier, in motion.</h1></div>
      <p>Central Tuyuksu, Kazakhstan.<br />{' '}Explore the measurements behind a changing landscape.</p></div>
    <nav className="gt-tabs" aria-label="Glacier datasets">{LAYERS.map(item => <button key={item.id} aria-pressed={layer === item.id} onClick={() => { setLayer(item.id); setPlaying(false); setSelected(null); }}><span>{item.number}</span>{item.label}{item.id === 'elevation' && !elevationReady && <small>Pending raster</small>}</button>)}</nav>

    {error ? <section className="gt-error" role="alert"><h2>Couldn’t load the glacier data.</h2><p>{error}</p><button onClick={() => setRetry(v => v + 1)}>Retry loading</button></section>
      : !data ? <section className="gt-loading" role="status"><div className="gt-loading-mark" /><p>Preparing terrain & published measurements…</p></section>
        : <>
          {layer === 'model' ? <GlacierModelExplorer data={data} /> : <>
          <section className="gt-workbench">
            <div className="gt-map">
              <GlacierTestScene key={viewVersion} data={data} frame={frame} maxGap={maxGap} layer={layer} outlineDate={outlineDate} selected={selected} onSelect={setSelected} flat={flat} />
              <div className="gt-map-top"><span>{layer === 'velocity' ? 'ANNUALIZED ICE SPEED' : layer === 'outlines' ? 'GLIMS SOURCE SNAPSHOT' : elevationReady ? 'SURFACE ELEVATION CHANGE' : 'REFERENCE TERRAIN · NO CHANGE RASTER'}</span><div className="gt-view-buttons"><button aria-pressed={flat} onClick={() => setFlat(v => !v)}>{flat ? '3D view' : 'Plan view'}</button><button aria-label="Reset map view" onClick={() => setViewVersion(v => v + 1)}><RotateCcw size={14} /></button></div></div>
              <div className="gt-north">{flat ? 'N ↑' : '3D / orbit view'}</div>
              {layer === 'velocity' && <div className="gt-legend"><span>Slower</span><div /><span>Faster</span><section><span>0</span><span>10</span><span>20</span><span>40+ m/year</span></section></div>}
              {layer === 'elevation' && elevationReady && <div className="gt-legend gt-change-legend"><span>Lower surface</span><div /><span>Higher surface</span><section><span>−20 m</span><span>0</span><span>+20 m</span></section></div>}
              {layer === 'outlines' && <div className="gt-map-caption">Purple lines · {dateLabel(outlineDate)} · {count} features</div>}
              {layer === 'elevation' && !elevationReady && <div className="gt-pending-map"><span className="gt-kicker">2016 → 2021</span><h2>Where did the surface lower?</h2><p>The published elevation-change product exists. Its raster has not been obtained for this test, so no change values are shown.</p><External href={PAPERS.pgoData}>Open the PGO catalog</External></div>}
              <div className="gt-map-bottom"><span>Elevation: Mapterhorn · date unspecified</span><span>{flat ? 'North up · scroll to zoom' : 'Drag to orbit · scroll to zoom · height ×1.8'}</span></div>
            </div>
            <aside className="gt-panel">
              {layer === 'velocity' ? <>
                <div className="gt-kicker">BALDACCHINO ET AL. / 2025</div><h2>Ice flows.<br />{' '}The speed changes.</h2>
                <p>Each colored square is a 120 m cell. Scrub through the six-day estimates, then click a cell to inspect its speed and uncertainty.</p>
                <div className="gt-number">{stats?.mean === null ? '—' : stats?.mean.toFixed(1)}<span>m/year</span></div>
                <div className="gt-stat-label">Mean annualized speed · {stats?.count} / {data.velocity.cells.length} cells pass the filter</div>
                <label className="gt-control">Maximum distance to an observation<select value={maxGap} onChange={e => setMaxGap(Number(e.target.value))}><option value={7}>7 days · strict</option><option value={30}>30 days · default</option><option value={90}>90 days</option><option value={10000}>All estimates</option></select></label>
                <p className="gt-small">Grey cells have no qualifying estimate. Speed is converted from m/day × 365.25; it is not a measured annual displacement. The dataset contains speed magnitude, not flow direction.</p>
                <div className="gt-inspector" aria-live="polite"><span className="gt-kicker">{selected === null ? 'INSPECT A CELL' : `CELL ${String(selected + 1).padStart(3, '0')}`}</span>
                  <label className="gt-control gt-cell-picker">Choose grid cell<select value={selected ?? ''} onChange={e => setSelected(e.target.value === '' ? null : Number(e.target.value))}><option value="">Select on map or choose a cell</option>{data.velocity.cells.map((cell, i) => <option key={i} value={i}>Cell {String(i + 1).padStart(3, '0')} · {cell.center[1].toFixed(4)}° N</option>)}</select></label>
                  {selectedIndex === null || selected === null ? <p>Click a colored cell on the glacier.</p> : <>
                    <p>{data.velocity.cells[selected].center[1].toFixed(5)}° N · {data.velocity.cells[selected].center[0].toFixed(5)}° E</p>
                    <strong>{selectedValid ? `${(data.velocity.speed[selectedIndex] * 365.25).toFixed(1)} m/year` : 'No qualifying estimate'}</strong>
                    <p>1σ uncertainty: {Number.isFinite(data.velocity.uncertainty[selectedIndex]) ? `±${(data.velocity.uncertainty[selectedIndex] * 365.25).toFixed(1)} m/year` : 'unavailable'}<br />{' '}Nearest observation: {Number.isFinite(data.velocity.gap[selectedIndex]) ? `${data.velocity.gap[selectedIndex].toFixed(1)} days away` : 'unavailable'}</p>
                  </>}
                </div><External href={PAPERS.velocityData}>Dataset & original files</External>
              </> : layer === 'outlines' ? <>
                <div className="gt-kicker">GLIMS / DATED SUBMISSIONS</div><h2>Boundaries<br />{' '}with a date.</h2><p>These are downloaded source geometries. Select an acquisition date to inspect the available outlines across the study area.</p>
                <div className="gt-date-list">{dates.map(date => <button key={date} aria-pressed={date === outlineDate} onClick={() => setOutlineDate(date!)}><span>{dateLabel(date!)}</span><small>{data.outlines.filter(f => f.properties.src_date?.startsWith(date!)).length} features</small></button>)}</div>
                <p className="gt-small">Submissions use different glacier divisions and may reuse geometry. A new source date does not necessarily mean a newly mapped boundary. These snapshots are not a harmonized retreat series.</p>
                <div className="gt-inspector"><span className="gt-kicker">EARLIER SURVEYED EXTENTS</span><div className="gt-area-rows">{[[1958, 2.99], [1998, 2.53], [2016, 2.28]].map(([year, area]) => <div key={year}><span>{year}</span><span className="gt-area-bar" style={{ width: `${area / 2.99 * 105}px` }} /><strong>{area.toFixed(2)} km²</strong></div>)}</div><p>Central Tuyuksu open-ice areas from Kapitsa et al. (2020). Polygon files for these three surveys are available by author request; they are not drawn here.</p><External href={PAPERS.history}>Historical survey paper</External></div>
                <External href={PAPERS.glims}>GLIMS database</External>
              </> : <>
                <div className="gt-kicker">PLÉIADES GLACIER OBSERVATORY</div><h2>Thinning,<br />{' '}in three dimensions.</h2><p>Repeat satellite elevation models can reveal how much the surface lowered between 27 August 2016 and 21 August 2021.</p>
                <div className="gt-data-status"><span className={elevationReady ? 'gt-ready-dot' : 'gt-pending-dot'} />{elevationReady ? 'Elevation-change raster loaded' : 'Raster not loaded'}</div>
                <p className="gt-small">{elevationReady ? '2021 minus 2016 surface height in metres, resampled onto the study grid. Uncolored terrain has no valid change estimate.' : 'The published raster has not yet been downloaded for this test. Open the PGO catalog below for the source products and access information.'}</p>
                <div className="gt-inspector"><span className="gt-kicker">WHAT THE PAPER PROVIDES</span><p>Figure 4 compares the 2016–2021 Tuyuksu elevation differences before and after alignment and bias correction. The catalog lists 2 m and 20 m products.</p><p>Surface-elevation change is not the same quantity as ice thickness or mass balance. Converting it to mass requires additional assumptions.</p></div>
                <External href={PAPERS.pgo}>Read the methods & Figure 4</External><External href={PAPERS.pgoData}>PGO data catalog</External><p className="gt-small">PGO DEM / dZ licence: CC BY-NC 4.0. Ortho-imagery requires separate access.</p>
              </>}
            </aside>
          </section>
          {layer === 'velocity' && <section className="gt-timeline"><div className="gt-time-controls"><button className="gt-play" aria-label={playing ? 'Pause animation' : 'Play animation'} onClick={() => setPlaying(v => !v)}>{playing ? <Pause size={16} /> : <Play size={16} />}</button><button aria-label="Previous date" disabled={frame === 0} onClick={() => changeFrame(frame - 1)}><ChevronLeft size={16} /></button><div><span className="gt-kicker">ESTIMATE DATE</span><strong>{dateLabel(data.velocity.dates[frame])}</strong></div><button aria-label="Next date" disabled={frame === data.velocity.dates.length - 1} onClick={() => changeFrame(frame + 1)}><ChevronRight size={16} /></button><input aria-label="Choose estimate date" type="date" min={data.velocity.dates[0]} max={data.velocity.dates[data.velocity.dates.length - 1]} value={data.velocity.dates[frame]} onChange={e => {
            if (!e.target.value) return;
            const value = Date.parse(e.target.value);
            let nearest = 0;
            data.velocity.dates.forEach((date, i) => { if (Math.abs(Date.parse(date) - value) < Math.abs(Date.parse(data.velocity.dates[nearest]) - value)) nearest = i; });
            changeFrame(nearest);
          }} /></div><SpeedChart data={data} frame={frame} maxGap={maxGap} onFrame={changeFrame} /></section>}
          </>}
          <section className="gt-notes"><div><span className="gt-kicker">READING THE EVIDENCE</span><h2>Three datasets.<br />{' '}Three different questions.</h2></div><div><h3>Velocity</h3><p>How fast does the surface move? A fixed RGI outline selects cell centers. It does not reconstruct the glacier boundary on each date.</p><External href={PAPERS.velocity}>Baldacchino et al., 2025</External></div><div><h3>Extent</h3><p>Where was ice mapped? Acquisition dates and original GLIMS analysis IDs are retained in the downloaded GeoJSON.</p><External href={PAPERS.history}>Kapitsa et al., 2020</External></div><div><h3>Elevation</h3><p>How did surface height change? {elevationReady ? 'The Pléiades layer shows 2016–2021 height differences.' : 'The Pléiades raster is pending.'} The terrain backdrop is a separate reference surface.</p><External href={PAPERS.pgo}>Berthier et al., 2024</External></div></section>
        </>}
    <footer className="gt-footer"><span>TUYUKSU / GLACIER RESEARCH TEST</span><Link to="/tuyuksu-glacier">Open the main terrain page <ArrowUpRight size={13} /></Link></footer>
  </main>;
}
