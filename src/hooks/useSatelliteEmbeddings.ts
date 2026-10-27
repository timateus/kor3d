import { shorelineGeoJSON, type LocalStats, type ShorelineStats } from '@/lib/embedding-analysis';
import { useEffect, useRef, useState } from 'react';
import type { ExternalEmbeddingReference } from '@/lib/embedding-search';
import { embeddingPixel, embeddingGridMeters, validateEmbeddingMetadata, validateEmbeddingPair, type EmbeddingMetadata, type EmbeddingRaster, type EmbeddingChangeStats } from '@/lib/satellite-embeddings';

async function readEmbedding(url: string, signal: AbortSignal, expectedYear: number) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Embedding metadata unavailable (${response.status})`);
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Satellite data is not available for this year.');
  const metadata: EmbeddingMetadata = await response.json();
  validateEmbeddingMetadata(metadata);
  if (metadata.year !== expectedYear) throw new Error('The embedding metadata does not match the selected year');
  const data = await fetch(new URL(metadata.valuesFile, new URL(url, window.location.href)), { signal });
  if (!data.ok) throw new Error(`Embedding raster unavailable (${data.status})`);
  const buffer = await data.arrayBuffer();
  if (buffer.byteLength !== metadata.width * metadata.height * 64) throw new Error('Embedding raster has an unexpected size');
  return { metadata, buffer };
}

export function useSatelliteEmbeddings(baseUrl: string | null, enabled: boolean, years: number[]) {
  const [chosenYear, setYear] = useState(2025);
  const year = years.includes(chosenYear) ? chosenYear : years[0];
  const url = baseUrl && year ? `${baseUrl}/${year}/metadata.json` : null;
  const [metadata, setMetadata] = useState<EmbeddingMetadata | null>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [raster, setRaster] = useState<EmbeddingRaster | null>(null);
  const [secondRaster, setSecondRaster] = useState<EmbeddingRaster | null>(null);
  const [status, setStatus] = useState<'loading' | 'computing' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'overview' | 'similarity' | 'change' | 'shoreline' | 'anomaly' | 'transition' | 'timeline'>('overview');
  const [radius, setRadius] = useState(1);
  const [localThreshold, setLocalThreshold] = useState(.05);
  const [localStats, setLocalStats] = useState<LocalStats | null>(null);
  const [shorelineStats, setShorelineStats] = useState<ShorelineStats | null>(null);
  const [edges, setEdges] = useState<Float32Array | null>(null);
  const [compareShoreline, setCompareShoreline] = useState(true);
  const [chosenComparisonYear, setComparisonYear] = useState(2017);
  const comparisonYear = chosenComparisonYear !== year && years.includes(chosenComparisonYear) ? chosenComparisonYear : years.find(value => value !== year);
  const [comparisonReady, setComparisonReady] = useState<string | null>(null);
  const comparisonKey = `${url}|${comparisonYear}`;
  const [changeView, setChangeView] = useState<'change' | 'base' | 'comparison' | 'swipe'>('change');
  const [changeThreshold, setChangeThreshold] = useState(0.1);
  const [changeStats, setChangeStats] = useState<EmbeddingChangeStats | null>(null);
  const [swipe, setSwipe] = useState(0.5);
  const [reference, setReference] = useState<Float32Array | null>(null);
  const [externalReference, setExternalReference] = useState<ExternalEmbeddingReference | null>(null);
  const [point, setPoint] = useState<{ lon: number; lat: number } | null>(null);
  const [pixels, setPixels] = useState<Uint32Array | null>(null);
  const [tool, setTool] = useState<'move' | 'point' | 'brush'>('point');
  const [brushRadius, setBrushRadius] = useState(40);
  const gridMeters = metadata ? embeddingGridMeters(metadata) : 10;
  const brushMin = Math.max(10, Math.ceil(gridMeters / 10) * 10);
  const brushMax = Math.max(150, brushMin * 10);
  const brushStep = Math.max(10, Math.round(brushMin / 10) * 10);
  useEffect(() => {
    setBrushRadius(radius => Math.max(brushMin, Math.min(brushMax, radius)));
  }, [brushMin, brushMax]);
  const [sampleCount, setSampleCount] = useState(0);
  const selectionRevision = useRef(0);
  const lastSelection = useRef<{ point: typeof point; pixels: typeof pixels; external: typeof externalReference } | null>(null);
  const [threshold, setThreshold] = useState(0.9);
  const [opacity, setOpacity] = useState(0.8);
  const [retryKey, setRetryKey] = useState(0);
  const worker = useRef<Worker | null>(null);
  const request = useRef(0);

  useEffect(() => {
    setLocalStats(null);
    setShorelineStats(null);
    setEdges(null);
    setMetadata(null);
    setLoadedUrl(null);
    setRaster(null);
    setSecondRaster(null);
    setComparisonReady(null);
    setChangeStats(null);
    setPoint(null);
    setPixels(null);
    setReference(null);
    setExternalReference(null);
    setSampleCount(0);
    setError(null);
    if (!enabled || !url) return;
    setStatus('loading');
    const controller = new AbortController();
    const instance = new Worker(new URL('../workers/satellite-embeddings.worker.ts', import.meta.url), { type: 'module' });
    worker.current = instance;
    let active = true;
    instance.onerror = () => {
      if (!active) return;
      setStatus('error');
      setError('Could not compute embeddings. Try reloading the layer.');
    };
    readEmbedding(url, controller.signal, year).then(({ metadata: meta, buffer }) => {
      if (!active) return;
      instance.onmessage = (event: MessageEvent<{ id: number; rgba?: Uint8ClampedArray; secondRgba?: Uint8ClampedArray; sampleCount?: number; error?: string; stats?: EmbeddingChangeStats; reference?: Float32Array; localStats?: LocalStats; shorelineStats?: ShorelineStats; edges?: Float32Array }>) => {
        if (!active || event.data.id !== request.current) return;
        if (event.data.error) {
          setError(event.data.error);
          setStatus('error');
          setRaster(null);
          setSecondRaster(null);
          setChangeStats(null);
          setSampleCount(0);
          setReference(null);
          setEdges(null);
          setShorelineStats(null);
          setLocalStats(null);
        } else if (event.data.rgba) {
          setRaster({ width: meta.width, height: meta.height, bounds: meta.bounds, rgba: event.data.rgba });
          setSecondRaster(event.data.secondRgba ? { width: meta.width, height: meta.height, bounds: meta.bounds, rgba: event.data.secondRgba } : null);
          setChangeStats(event.data.stats ?? null);
          setLocalStats(event.data.localStats ?? null);
          setShorelineStats(event.data.shorelineStats ?? null);
          setEdges(event.data.edges ?? null);
          setReference(event.data.reference ?? null);
          setStatus('ready');
          setSampleCount(event.data.sampleCount ?? 0);
          setError(null);
        }
      };
      instance.postMessage({ id: ++request.current, type: 'init', buffer, metadata: meta }, [buffer]);
      setMetadata(meta);
      setLoadedUrl(url);
    }).catch((cause: Error) => {
      if (!active) return;
      setStatus('error');
      setError(cause.message);
    });
    return () => {
      active = false;
      controller.abort();
      instance.terminate();
      worker.current = null;
    };
  }, [url, enabled, retryKey, year]);

  useEffect(() => {
    if (!enabled || !metadata || loadedUrl !== url || !baseUrl || !worker.current || !(mode === 'change' || mode === 'shoreline' && compareShoreline) || !comparisonYear || comparisonReady === comparisonKey) return;
    const instance = worker.current;
    const controller = new AbortController();
    let active = true;
    request.current++;
    setStatus('loading');
    setError(null);
    setRaster(null);
    setSecondRaster(null);
    setChangeStats(null);
    readEmbedding(`${baseUrl}/${comparisonYear}/metadata.json`, controller.signal, comparisonYear).then(({ metadata: other, buffer }) => {
      validateEmbeddingPair(metadata, other);
      if (!active) return;
      instance.postMessage({ id: request.current, type: 'comparison-init', buffer }, [buffer]);
      setComparisonReady(comparisonKey);
    }).catch((cause: Error) => {
      if (!active) return;
      setStatus('error');
      setError(cause.message);
    });
    return () => { active = false; controller.abort(); };
  }, [enabled, metadata, loadedUrl, url, baseUrl, mode, comparisonYear, comparisonKey, comparisonReady, retryKey, compareShoreline]);

  useEffect(() => {
    if (!enabled || !metadata || loadedUrl !== url || !worker.current) return;
    if ((mode === 'change' || mode === 'shoreline' && compareShoreline && comparisonYear) && comparisonReady !== comparisonKey) return;
    if (!lastSelection.current || lastSelection.current.point !== point || lastSelection.current.pixels !== pixels || lastSelection.current.external !== externalReference) {
      lastSelection.current = { point, pixels, external: externalReference };
      selectionRevision.current++;
    }
    const pixel = point ? embeddingPixel(metadata, point.lon, point.lat) : null;
    const id = ++request.current;
    setStatus('computing');
    setError(null);
    // Coalesce slider events; stale replies are invalidated immediately.
    const timer = window.setTimeout(() => {
      worker.current?.postMessage({ id, type: mode === 'change' ? 'compare' : mode === 'anomaly' || mode === 'transition' ? mode : (mode === 'similarity' || mode === 'shoreline') && (pixel !== null || pixels || externalReference) ? mode : 'overview',
        pixel, pixels, radius, localThreshold, compareShoreline: compareShoreline && !!comparisonYear, externalReference: externalReference?.vector, selectionId: selectionRevision.current, threshold, view: changeView, changeThreshold });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [enabled, metadata, loadedUrl, url, mode, point, pixels, externalReference, threshold, comparisonReady, comparisonKey, changeView, changeThreshold, radius, localThreshold, compareShoreline, comparisonYear]);

  const exportShoreline = () => {
    if (!edges || !metadata || !shorelineStats) return;
    const result = shorelineGeoJSON(edges, { kind: 'candidate-shoreline', year, referenceYear: year, threshold,
      comparisonYear: compareShoreline ? comparisonYear : null, displayGridMeters: gridMeters,
      ...shorelineStats, reference: reference ? Array.from(reference) : null, referencePoint: point, source: metadata.dataset, caveat: 'Similarity-based candidate boundary; verify against imagery.' });
    const objectUrl = URL.createObjectURL(new Blob([JSON.stringify(result)], { type: 'application/geo+json' }));
    const link = document.createElement('a'); link.href = objectUrl; link.download = `candidate-shoreline-${year}.geojson`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  };

  return { radius, setRadius, localThreshold, setLocalThreshold, localStats, shorelineStats, compareShoreline, setCompareShoreline, exportShoreline, metadata, raster, secondRaster, status, error, mode, setMode, years, year, setYear,
    comparisonYear, setComparisonYear, changeView, setChangeView, changeThreshold, setChangeThreshold, changeStats, swipe, setSwipe, point,
    setPoint: (value: typeof point) => { setPoint(value); setPixels(null); setExternalReference(null); },
    pixels, setPixels: (value: Uint32Array | null) => { setPixels(value); setPoint(null); setExternalReference(null); },
    reference, externalReference, setExternalReference: (value: ExternalEmbeddingReference) => { setExternalReference(value); setPoint(null); setPixels(null); },
    tool, setTool, brushRadius, setBrushRadius, brushMin, brushMax, brushStep, gridMeters, sampleCount, threshold, setThreshold, opacity, setOpacity,
    retry: () => setRetryKey(k => k + 1) };
}

export type EmbeddingExplorer = ReturnType<typeof useSatelliteEmbeddings>;
