import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Download, Pause, Play, RotateCcw, Upload } from 'lucide-react';
import * as THREE from 'three';
import type { GlacierTestData } from '@/lib/glacier-test';
import { loadReferenceGlacier, loadTuyuksuSimulation, modelCoordinates, modelStats, parseGlacierModel, type GlacierModel } from '@/lib/glacier-model';

type Field = 'thickness' | 'speed';
function ModelWorld({ model, frame, field, exaggeration, opacity, bedOnly, range }: {
  model: GlacierModel; frame: number; field: Field; exaggeration: number; opacity: number; bedOnly: boolean; range: number;
}) {
  const geometry = useMemo(() => {
    const coords = modelCoordinates(model), scale = 8 / coords.span;
    const bedPos: number[] = [], icePos: number[] = [], bedColor: number[] = [], iceColor: number[] = [];
    const values = model.frames[frame], edges = new Map<string, { a: number; b: number; count: number }>();
    const point = (i: number, ice: boolean) => [coords.x[i] * scale, (model.bedrock[i]! + (ice ? values.thickness[i]! : 0) - coords.minBed) * scale * exaggeration, coords.z[i] * scale];
    const maxBed = model.bedrock.reduce<number>((m, h) => Math.max(m, h ?? -Infinity), coords.minBed);
    const addIce = (i: number, top: boolean) => {
      icePos.push(...point(i, top));
      const value = field === 'speed' ? values.speed?.[i] : values.thickness[i];
      const color = value == null ? new THREE.Color('#b6bcb9') : new THREE.Color('#e2f5f8').lerp(new THREE.Color('#12668d'), Math.min(1, value / range));
      iceColor.push(color.r, color.g, color.b);
    };
    for (let row = 0; row < model.height - 1; row++) for (let col = 0; col < model.width - 1; col++) {
      const a = row * model.width + col, b = a + 1, c = a + model.width, d = c + 1;
      for (const tri of [[a, c, b], [b, c, d]]) {
        if (tri.some(i => model.bedrock[i] === null)) continue;
        for (const i of tri) {
          bedPos.push(...point(i, false));
          const t = (model.bedrock[i]! - coords.minBed) / (maxBed - coords.minBed || 1);
          const color = new THREE.Color('#737e65').lerp(new THREE.Color('#d6c5ad'), Math.min(1, t * 1.25));
          bedColor.push(color.r, color.g, color.b);
        }
        if (tri.some(i => values.thickness[i] === null) || !tri.some(i => values.thickness[i]! > 0)) continue;
        tri.forEach(i => addIce(i, true));
        for (let k = 0; k < 3; k++) {
          const i = tri[k], j = tri[(k + 1) % 3], key = `${Math.min(i, j)}-${Math.max(i, j)}`;
          const edge = edges.get(key);
          if (edge) edge.count++; else edges.set(key, { a: i, b: j, count: 1 });
        }
      }
    }
    edges.forEach(({ a, b, count }) => {
      if (count !== 1) return;
      for (const [i, top] of [[a, true], [a, false], [b, true], [b, true], [a, false], [b, false]] as [number, boolean][]) addIce(i, top);
    });
    const make = (positions: number[], colors: number[]) => {
      const result = new THREE.BufferGeometry();
      result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      result.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      result.computeVertexNormals(); return result;
    };
    return { bed: make(bedPos, bedColor), ice: make(icePos, iceColor) };
  }, [model, frame, field, exaggeration, range]);
  useEffect(() => () => { geometry.bed.dispose(); geometry.ice.dispose(); }, [geometry]);
  return <>
    <ambientLight intensity={1.3} /><directionalLight position={[-5, 10, -3]} intensity={2} />
    <mesh geometry={geometry.bed}><meshStandardMaterial vertexColors side={THREE.DoubleSide} roughness={1} /></mesh>
    {!bedOnly && <mesh geometry={geometry.ice}><meshStandardMaterial vertexColors side={THREE.DoubleSide} roughness={.55} transparent={opacity < 1} opacity={opacity} depthWrite={opacity === 1} /></mesh>}
    <OrbitControls makeDefault target={[0, 1.2, 0]} minDistance={2} maxDistance={30} maxPolarAngle={Math.PI / 2.03} />
  </>;
}

export default function GlacierModelExplorer({ data }: { data: GlacierTestData }) {
  const [model, setModel] = useState<GlacierModel | null>(null);
  const [simulation, setSimulation] = useState<GlacierModel | null>(null);
  const [reference, setReference] = useState<GlacierModel | null>(null);
  const [frame, setFrame] = useState(0), [playing, setPlaying] = useState(false);
  const [field, setField] = useState<Field>('thickness');
  const [exaggeration, setExaggeration] = useState(1.8), [opacity, setOpacity] = useState(1);
  const [bedOnly, setBedOnly] = useState(false), [view, setView] = useState(0);
  const [error, setError] = useState(''), [importing, setImporting] = useState(false), [retry, setRetry] = useState(0);
  const importVersion = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    Promise.allSettled([loadTuyuksuSimulation(controller.signal), loadReferenceGlacier(data, controller.signal)]).then(([run, ref]) => {
      if (controller.signal.aborted) return;
      if (ref.status === 'fulfilled') setReference(ref.value);
      if (run.status === 'fulfilled') {
        setSimulation(run.value);
        setModel(current => current ?? run.value);
      } else {
        if (ref.status === 'fulfilled') setModel(current => current ?? ref.value);
        setError(`Could not load the OGGM simulation: ${run.reason instanceof Error ? run.reason.message : 'download failed'}. Retry below.`);
      }
    });
    return () => controller.abort();
  }, [data, retry]);
  useEffect(() => {
    if (!playing || !model || model.frames.length < 2) return;
    const timer = window.setInterval(() => setFrame(f => Math.min(f + 1, model.frames.length - 1)), 650);
    return () => window.clearInterval(timer);
  }, [playing, model]);
  useEffect(() => { if (model && frame === model.frames.length - 1) setPlaying(false); }, [frame, model]);
  useEffect(() => () => { importVersion.current++; }, []);
  const series = useMemo(() => {
    if (!model) return [];
    const coordinates = modelCoordinates(model);
    return model.frames.map((_, i) => modelStats(model, i, coordinates));
  }, [model]);
  const stats = series[frame];
  const isBundled = model !== null && model === simulation;
  const volumeChange = stats && series[0]?.volume > 0 ? (stats.volume / series[0].volume - 1) * 100 : 0;
  const hasSpeed = !!model?.frames[frame].speed;
  const activeField = field === 'speed' && !hasSpeed ? 'thickness' : field;
  const range = useMemo(() => {
    let max = 1;
    model?.frames.forEach(f => (activeField === 'speed' ? f.speed : f.thickness)?.forEach(v => { if (v !== null) max = Math.max(max, v); }));
    return max;
  }, [model, activeField]);
  // Switching datasets resets playback, camera, and the selected physical quantity.
  const activateModel = (m: GlacierModel) => { setModel(m); setFrame(0); setPlaying(false); setField('thickness'); setBedOnly(false); setView(v => v + 1); };
  const importFile = async (file?: File) => {
    if (!file) return;
    const version = ++importVersion.current;
    setError(''); setImporting(true);
    try {
      if (file.size > 80 * 1024 * 1024) throw new Error('Use a JSON file smaller than 80 MB. Subset the model before exporting.');
      const m = parseGlacierModel(JSON.parse(await file.text()));
      if (version === importVersion.current) activateModel(m);
    } catch (e) { if (version === importVersion.current) setError(e instanceof Error ? e.message : 'Could not read model output.'); }
    finally { if (version === importVersion.current) setImporting(false); }
  };
  const download = () => {
    if (!model) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(model)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'glacier-model.json'; a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="gt-model-explorer">
    {model && <div className="gt-model-timeline"><div className="gt-time-controls"><button className="gt-play" disabled={model.frames.length < 2} aria-label={playing ? 'Pause model playback' : 'Play model playback'} onClick={() => { if (!playing && frame === model.frames.length - 1) setFrame(0); setPlaying(v => !v); }}>{playing ? <Pause size={16} /> : <Play size={16} />}</button><div><span className="gt-kicker">{model.frames.length > 1 ? `FRAME ${frame + 1} / ${model.frames.length}` : 'ONE REFERENCE FRAME'}</span><strong>{model.frames[frame].label}</strong></div></div><input aria-label="Model time step" type="range" min="0" max={model.frames.length - 1} value={frame} disabled={model.frames.length < 2} onChange={e => { setPlaying(false); setFrame(Number(e.target.value)); }} /><p>{model.frames.length > 1 ? `${model.frames[0].label} → ${model.frames[model.frames.length - 1].label} · ${volumeChange > 0 ? '+' : ''}${volumeChange.toFixed(1)}% displayed ice volume from the first frame. ${isBundled ? 'Illustrative warming experiment, not a calibrated forecast.' : 'Playback shows supplied frames.'}` : 'Static reference. Choose the OGGM experiment for playback.'}</p></div>}
    <div className="gt-workbench">
      <div className="gt-map gt-model-map">
        {model ? <Canvas key={view} camera={{ position: [7, 9, -10], fov: 42, near: .01, far: 200 }} dpr={[1, 2]} aria-label="Three-dimensional glacier ice surface and bedrock. Drag to orbit and scroll to zoom.">
          <color attach="background" args={['#e9e7de']} />
          <ModelWorld model={model} frame={frame} field={activeField} exaggeration={exaggeration} opacity={opacity} bedOnly={bedOnly} range={range} />
        </Canvas> : <div className="gt-loading" role="status">Loading the Tuyuksu simulation…</div>}
        <div className="gt-map-top"><span>{bedOnly ? 'BEDROCK' : activeField === 'speed' ? 'MODELED ICE SPEED' : 'ICE THICKNESS'} · {model?.kind === 'reference' ? 'REFERENCE ESTIMATE' : 'MODEL OUTPUT'}</span><div className="gt-view-buttons"><button aria-label="Reset glacier camera" onClick={() => setView(v => v + 1)}><RotateCcw size={14} /></button></div></div>
        <div className="gt-north">3D / orbit view</div>
        {!bedOnly && <div className="gt-legend gt-ice-legend"><span>{activeField === 'speed' ? 'Ice speed' : 'Ice thickness'}</span><span>{activeField === 'speed' ? 'm/year' : 'metres'}</span><div /><section><span>0</span><span>{Math.round(range / 2)}</span><span>{Math.ceil(range)}</span></section>{activeField === 'speed' && <small>Grey: no speed value</small>}</div>}
        <div className="gt-map-bottom"><span>{model?.kind === 'reference' ? 'Surface: Mapterhorn · thickness: Farinotti et al., 2019' : isBundled ? 'OGGM · illustrative +1.5°C warming experiment' : 'Imported geometry · source in panel'}</span><span>Drag to orbit · scroll to zoom · height ×{exaggeration.toFixed(1)}</span></div>
      </div>
      <aside className="gt-panel">
        <div className="gt-kicker">ICE / LANDSCAPE / TIME</div><h2>A glacier,<br />in three dimensions.</h2>
        <div className="gt-model-datasets"><button disabled={!simulation || importing} aria-pressed={isBundled} onClick={() => { if (simulation) activateModel(simulation); }}>OGGM experiment</button><button disabled={!reference || importing} aria-pressed={model !== null && model === reference} onClick={() => { if (reference) activateModel(reference); }}>Static reference</button></div>
        <p>{model?.title ?? 'Preparing reference geometry.'}</p>
        <div className="gt-model-stats" aria-live="polite"><div><strong>{stats?.volume.toFixed(3) ?? '—'}</strong><span>km³ · displayed ice volume</span></div><div><strong>{stats?.maxThickness.toFixed(0) ?? '—'}</strong><span>m · maximum thickness</span></div></div>
        <label className="gt-control">Color ice by<select value={activeField} onChange={e => setField(e.target.value as Field)}><option value="thickness">Thickness · metres</option><option value="speed" disabled={!hasSpeed}>Speed · m/year{!hasSpeed ? ' (not supplied)' : ''}</option></select></label>
        <label className="gt-control gt-model-range">Vertical exaggeration <output>{exaggeration.toFixed(1)}×</output><input aria-label="Vertical exaggeration" type="range" min="1" max="3" step="0.1" value={exaggeration} onChange={e => setExaggeration(Number(e.target.value))} /></label>
        <label className="gt-control gt-model-range">Ice opacity <output>{Math.round(opacity * 100)}%</output><input aria-label="Ice opacity" type="range" min="0.1" max="1" step="0.05" value={opacity} onChange={e => setOpacity(Number(e.target.value))} /></label>
        <label className="gt-model-check"><input type="checkbox" checked={bedOnly} onChange={e => setBedOnly(e.target.checked)} /> Show bedrock only</label>
        <div className="gt-inspector"><span className="gt-kicker">{model?.kind === 'reference' ? 'STATIC REFERENCE · NOT A FORECAST' : isBundled ? 'OGGM WARMING EXPERIMENT · NOT A FORECAST' : 'IMPORTED SIMULATION'}</span><p>{model?.source}</p>{isBundled && <a href={`${import.meta.env.BASE_URL}data/glacier-test/tuyuksu-oggm-run.json`} target="_blank" rel="noreferrer">Run settings, sources & volume checks ↗</a>}<p>Volume integrates thickness over valid grid triangles. Height exaggeration affects the view only.</p></div>
        <label className="gt-model-import"><Upload size={14} />{importing ? 'Reading model…' : 'Import model JSON'}<input aria-label="Import glacier model JSON" type="file" accept=".json,application/json" disabled={importing} onChange={e => { void importFile(e.target.files?.[0]); e.target.value = ''; }} /></label>
        <p className="gt-small">Load offline OGGM, IGM, or PISM results converted to the KÖR3D grid format. Files stay in your browser. This viewer does not run an ice-flow solver.</p>
        <div className="gt-model-actions"><button onClick={download} disabled={!model}><Download size={13} /> Export grid</button><button disabled={!reference || importing} onClick={() => { setError(''); if (reference) activateModel(reference); }}>Tuyuksu reference</button></div>
        {error && <div className="gt-model-error" role="alert"><p>{error}</p><button onClick={() => { setError(''); setFrame(0); setPlaying(false); setModel(null); setRetry(v => v + 1); }}>Retry simulation</button></div>}
      </aside>
    </div>

  </section>;
}
