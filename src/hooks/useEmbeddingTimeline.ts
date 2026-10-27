import { useEffect, useState } from 'react';
import { embeddingPixel, validateEmbeddingMetadata, validateEmbeddingPair, type EmbeddingMetadata } from '@/lib/satellite-embeddings';
import { decodeTimelineVector, embeddingTrajectory, type TimelineSample } from '@/lib/embedding-analysis';

/** Prefer a 64-byte range. A streaming fallback bounds memory on static hosts
 * that ignore Range; cancel as soon as the selected pixel has been read. */
export async function readTimelinePixel(url: string, pixel: number, expectedBytes: number, signal: AbortSignal) {
  const offset = pixel * 64;
  const response = await fetch(url, { signal, headers: { Range: `bytes=${offset}-${offset + 63}` } });
  if (!response.ok) throw new Error(`Annual pixel unavailable (${response.status})`);
  if (response.status === 206) {
    if (response.headers.get('content-range') !== `bytes ${offset}-${offset + 63}/${expectedBytes}`) throw new Error('Invalid annual pixel range');
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== 64) throw new Error('Incomplete annual pixel');
    return decodeTimelineVector(new Int8Array(buffer));
  }
  if (response.status !== 200 || !response.body || response.headers.get('content-type')?.includes('text/html')) throw new Error('Invalid annual raster response');
  const reader = response.body.getReader(), raw = new Uint8Array(64);
  let position = 0, copied = 0;
  try {
    while (copied < 64) {
      const { value, done } = await reader.read();
      if (done) throw new Error('Incomplete annual raster');
      const start = Math.max(0, offset - position), end = Math.min(value.length, offset + 64 - position);
      if (end > start) { raw.set(value.subarray(start, end), copied); copied += end - start; }
      position += value.length;
    }
  } finally { await reader.cancel(); }
  return decodeTimelineVector(new Int8Array(raw.buffer));
}

export function useEmbeddingTimeline(baseUrl: string | null, years: number[], meta: EmbeddingMetadata | null,
  point: { lon: number; lat: number } | null, enabled: boolean) {
  const [data, setData] = useState<ReturnType<typeof embeddingTrajectory>>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const key = [...years].sort().join(',');
  useEffect(() => {
    setData([]); setError(null); setStatus('idle');
    if (!enabled || !baseUrl || !meta || !point) return;
    const pixel = embeddingPixel(meta, point.lon, point.lat); if (pixel === null) return;
    const controller = new AbortController(); let active = true;
    setStatus('loading');
    const samples: TimelineSample[] = [], pending = key.split(',').map(Number);
    const read = async () => {
      while (pending.length) {
        const year = pending.shift()!;
        const response = await fetch(`${baseUrl}/${year}/metadata.json`, { signal: controller.signal });
        if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error(`Metadata unavailable for ${year}`);
        const other: EmbeddingMetadata = await response.json(); validateEmbeddingMetadata(other);
        if (other.year !== year) throw new Error('Annual metadata year mismatch');
        if (year !== meta.year) validateEmbeddingPair(meta, other);
        const vector = await readTimelinePixel(`${baseUrl}/${year}/values.bin`, pixel, other.width * other.height * 64, controller.signal);
        samples.push({ year, vector });
        if (active) setData(embeddingTrajectory(samples));
      }
    };
    Promise.all([read(), read()]).then(() => { if (active) setStatus('ready'); }).catch((cause: Error) => {
      if (!active) return; setError(cause.message); setStatus('error'); controller.abort();
    });
    return () => { active = false; controller.abort(); };
  }, [baseUrl, key, meta, point, enabled, retry]);
  return { data, status, error, retry: () => setRetry(value => value + 1) };
}
export type EmbeddingTimeline = ReturnType<typeof useEmbeddingTimeline>;
