import { useCallback, useEffect, useRef, useState } from 'react';
import { validateSearchManifest, type EmbeddingMatch, type EmbeddingSearchManifest } from '@/lib/embedding-search';
import type { GeoBounds } from '@/lib/geotiff-loader';

export function useEmbeddingSearch(reference: Float32Array | null, slug: string, year: number, bounds: GeoBounds | null, threshold: number, enabled: boolean) {
  const [matches, setMatches] = useState<EmbeddingMatch[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [locations, setLocations] = useState(0);
  const job = useRef<{ worker?: Worker; controller?: AbortController }>({});
  const generation = useRef(0);
  const stop = useCallback(() => { generation.current++; job.current.controller?.abort(); job.current.worker?.terminate(); job.current = {}; }, []);
  useEffect(() => {
    stop();
    setMatches([]); setStatus('idle'); setError(null);
    return () => stop();
  }, [reference, slug, year, threshold, enabled, stop]);
  const search = async () => {
    if (!enabled || !reference || !bounds || year !== 2025) return;
    stop();
    const current = ++generation.current;
    const controller = new AbortController();
    job.current = { controller };
    setStatus('loading'); setMatches([]); setError(null);
    try {
      const base = `${import.meta.env.BASE_URL}data/embedding-search/${year}/`;
      const response = await fetch(`${base}manifest.json`, { signal: controller.signal });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('The cross-location search index is unavailable');
      const manifest: EmbeddingSearchManifest = await response.json();
      validateSearchManifest(manifest, year);
      const data = await fetch(`${base}${manifest.valuesFile}`, { signal: controller.signal });
      if (!data.ok) throw new Error('Could not load search data');
      const buffer = await data.arrayBuffer();
      if (buffer.byteLength !== manifest.count * 64) throw new Error('Search data has an unexpected size');
      if (current !== generation.current || controller.signal.aborted) return;
      const worker = new Worker(new URL('../workers/embedding-search.worker.ts', import.meta.url), { type: 'module' });
      job.current.worker = worker;
      worker.onmessage = (event: MessageEvent<{ matches?: EmbeddingMatch[]; locations?: number; error?: string }>) => {
        if (current !== generation.current) return;
        if (event.data.error) { setError(event.data.error); setStatus('error'); }
        else { setMatches(event.data.matches ?? []); setLocations(event.data.locations ?? 0); setStatus('ready'); }
        worker.terminate();
        job.current.worker = undefined;
      };
      worker.onerror = () => {
        if (current !== generation.current) return;
        setError('Could not search the embedding index'); setStatus('error'); worker.terminate();
      };
      worker.postMessage({ manifest, buffer, reference, slug, year, bounds, threshold }, [buffer]);
    } catch (cause) {
      if (current !== generation.current || controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : String(cause)); setStatus('error');
    }
  };
  return { matches, status, error, locations, search };
}

export type EmbeddingSearch = ReturnType<typeof useEmbeddingSearch>;
