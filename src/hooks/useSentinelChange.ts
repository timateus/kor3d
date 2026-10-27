import { useEffect, useMemo, useState } from 'react';
import type { EmbeddingRaster } from '@/lib/satellite-embeddings';
import {
  decodeSentinelBand, sentinelChange, sentinelPixel, validateSentinelManifest, vegetationLossOnset,
  SENTINEL_BANDS, type SentinelBand, type SentinelChangeKind, type SentinelChangeStats, type SentinelManifest,
} from '@/lib/sentinel-change';

export type SentinelMode = 'imagery' | 'change' | 'onset';

const DEFAULT_THRESHOLDS: Record<SentinelChangeKind, number> = { vegetation: 0.15, bare: 0.1, radar: 3 };

async function loadTruecolor(url: string, manifest: SentinelManifest): Promise<EmbeddingRaster> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = manifest.width;
  canvas.height = manifest.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, manifest.width, manifest.height);
  const { data } = ctx.getImageData(0, 0, manifest.width, manifest.height);
  return { width: manifest.width, height: manifest.height, rgba: data, bounds: manifest.bounds };
}

/** Loads every prepared year up front (~1 MB each) so changes, onset and point series are instant. */
export function useSentinelChange(baseUrl: string | null, enabled: boolean) {
  const [manifest, setManifest] = useState<SentinelManifest | null>(null);
  const [indices, setIndices] = useState<Map<number, Uint8Array> | null>(null);
  const [truecolor, setTruecolor] = useState<Map<number, EmbeddingRaster>>(new Map());
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<SentinelMode>('change');
  const [kind, setKind] = useState<SentinelChangeKind>('vegetation');
  const [thresholds, setThresholds] = useState(DEFAULT_THRESHOLDS);
  const [onsetThreshold, setOnsetThreshold] = useState(0.15);
  const [includeLatest, setIncludeLatest] = useState(false);
  const [chosenA, setYearA] = useState<number | null>(null);
  const [chosenB, setYearB] = useState<number | null>(null);
  const [imageryView, setImageryView] = useState<'a' | 'b' | 'swipe'>('swipe');
  const [swipe, setSwipe] = useState(0.5);
  const [opacity, setOpacity] = useState(0.85);
  const [point, setPoint] = useState<{ lon: number; lat: number } | null>(null);

  const years = useMemo(() => manifest?.years.map(y => y.year) ?? [], [manifest]);
  const yearA = chosenA !== null && years.includes(chosenA) ? chosenA : years[0];
  const yearB = chosenB !== null && years.includes(chosenB) && chosenB !== yearA ? chosenB : years.filter(y => y !== yearA).at(-1);

  useEffect(() => {
    if (!enabled || !baseUrl || indices) return;
    const controller = new AbortController();
    setStatus('loading');
    setError(null);
    (async () => {
      const response = await fetch(`${baseUrl}/manifest.json`, { signal: controller.signal });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Sentinel data is not available for this location.');
      const m: SentinelManifest = await response.json();
      validateSentinelManifest(m);
      const entries = await Promise.all(m.years.map(async ({ year }) => {
        const r = await fetch(`${baseUrl}/${year}/indices.bin`, { signal: controller.signal });
        if (!r.ok) throw new Error(`Sentinel ${year} grid unavailable (${r.status})`);
        const bytes = new Uint8Array(await r.arrayBuffer());
        if (bytes.length !== m.width * m.height * SENTINEL_BANDS.length) throw new Error(`Sentinel ${year} grid has an unexpected size`);
        return [year, bytes] as const;
      }));
      setManifest(m);
      setIndices(new Map(entries));
      setStatus('ready');
    })().catch(e => {
      if (controller.signal.aborted) return;
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    });
    return () => controller.abort();
  }, [enabled, baseUrl, indices, attempt]);

  // True-colour composites are fetched only when the imagery view needs them.
  useEffect(() => {
    if (!enabled || !baseUrl || !manifest || mode !== 'imagery') return;
    const wanted = [yearA, yearB].filter((y): y is number => y !== undefined && !truecolor.has(y));
    if (!wanted.length) return;
    let cancelled = false;
    Promise.all(wanted.map(async y => [y, await loadTruecolor(`${baseUrl}/${y}/truecolor.png`, manifest)] as const))
      .then(loaded => { if (!cancelled) setTruecolor(prev => new Map([...prev, ...loaded])); })
      .catch(e => { if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setStatus('error'); } });
    return () => { cancelled = true; };
  }, [enabled, baseUrl, manifest, mode, yearA, yearB, truecolor]);

  const band = (year: number | undefined, b: SentinelBand) => {
    const bytes = year !== undefined ? indices?.get(year) : undefined;
    return bytes && manifest ? decodeSentinelBand(bytes, b, manifest.scales) : null;
  };

  const threshold = thresholds[kind];
  const change = useMemo((): { raster: EmbeddingRaster; stats: SentinelChangeStats } | null => {
    if (!manifest || mode !== 'change') return null;
    const b = kind === 'vegetation' ? 'ndvi' : kind === 'bare' ? 'bsi' : 'vh';
    const a = band(yearA, b), bb = band(yearB, b);
    if (!a || !bb) return null;
    // Bare-soil gain is limited to pixels that were vegetated in year A, so
    // existing scree and rock faces do not dominate the map.
    if (kind === 'bare') {
      const ndvi = band(yearA, 'ndvi')!;
      for (let i = 0; i < a.length; i++) if (!(ndvi[i] >= 0.3)) a[i] = NaN;
    }
    return sentinelChange(kind, a, bb, threshold, manifest.bounds, manifest.width, manifest.height);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest, indices, mode, kind, yearA, yearB, threshold]);

  const onset = useMemo(() => {
    if (!manifest || !indices || mode !== 'onset') return null;
    const series = years.map(y => band(y, 'ndvi')!);
    return vegetationLossOnset(series, years, onsetThreshold, manifest.bounds, manifest.width, manifest.height, 0.3, includeLatest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest, indices, mode, years, onsetThreshold, includeLatest]);

  const pointSeries = useMemo(() => {
    if (!manifest || !indices || !point) return null;
    const pixel = sentinelPixel(manifest, point.lon, point.lat);
    if (pixel === null) return null;
    return years.map(year => {
      const bytes = indices.get(year)!;
      const value = (b: SentinelBand) => {
        const q = bytes[pixel * SENTINEL_BANDS.length + SENTINEL_BANDS.indexOf(b)];
        const [lo, hi] = manifest.scales[b];
        return q === 0 ? null : lo + (q - 1) / 254 * (hi - lo);
      };
      return { year, ndvi: value('ndvi'), bsi: value('bsi'), vh: value('vh'), vv: value('vv') };
    });
  }, [manifest, indices, point, years]);

  let raster: EmbeddingRaster | null = null, secondRaster: EmbeddingRaster | null = null;
  if (mode === 'change') raster = change?.raster ?? null;
  else if (mode === 'onset') raster = onset?.raster ?? null;
  else {
    const ra = yearA !== undefined ? truecolor.get(yearA) ?? null : null;
    const rb = yearB !== undefined ? truecolor.get(yearB) ?? null : null;
    raster = imageryView === 'b' ? rb : ra;
    secondRaster = imageryView === 'swipe' ? rb : null;
  }

  return {
    manifest, years, status, error, retry: () => { setIndices(null); setAttempt(a => a + 1); },
    mode, setMode, kind, setKind, threshold, setThreshold: (v: number) => setThresholds(t => ({ ...t, [kind]: v })),
    onsetThreshold, setOnsetThreshold, includeLatest, setIncludeLatest, yearA, yearB, setYearA, setYearB,
    imageryView, setImageryView, swipe, setSwipe, opacity, setOpacity,
    point, setPoint, pointSeries,
    raster, secondRaster, split: mode === 'imagery' && imageryView === 'swipe' && secondRaster ? swipe : null,
    stats: change?.stats ?? null, onsetCounts: onset?.counts ?? null,
  };
}

export type SentinelChangeExplorer = ReturnType<typeof useSentinelChange>;
