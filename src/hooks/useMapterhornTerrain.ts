import { useEffect, useState } from 'react';
import type { GeoBounds, TerrainData } from '@/lib/geotiff-loader';
import { loadMapterhornDEM } from '@/lib/mapterhorn-dem';
import { cacheGet, cacheSet } from '@/lib/browser-cache';

interface State {
  terrain: TerrainData | null;
  loading: boolean;
  error: string | null;
  progress: number; // 0..1
}

const mem = new Map<string, TerrainData>();
const inflight = new Map<string, Promise<TerrainData>>();
const key = (b: GeoBounds) =>
  `mapterhorn|${b.minLon.toFixed(5)},${b.minLat.toFixed(5)},${b.maxLon.toFixed(5)},${b.maxLat.toFixed(5)}`;

export function useMapterhornTerrain(bounds: GeoBounds | null, enabled: boolean): State {
  const [state, setState] = useState<State>({ terrain: null, loading: false, error: null, progress: 0 });

  useEffect(() => {
    if (!enabled || !bounds) {
      setState({ terrain: null, loading: false, error: null, progress: 0 });
      return;
    }
    const k = key(bounds);
    const hit = mem.get(k);
    if (hit) {
      setState({ terrain: hit, loading: false, error: null, progress: 1 });
      return;
    }
    let cancelled = false;
    setState((p) => ({ terrain: p.terrain, loading: true, error: null, progress: 0 }));

    (async () => {
      // Try IDB
      const cached = await cacheGet<TerrainData>(k);
      if (cancelled) return;
      if (cached && cached.elevations && cached.width && cached.height) {
        mem.set(k, cached);
        setState({ terrain: cached, loading: false, error: null, progress: 1 });
        return;
      }

      let promise = inflight.get(k);
      if (!promise) {
        promise = loadMapterhornDEM(bounds, {
          onProgress: (loaded, total) => {
            if (cancelled) return;
            setState((p) => ({ ...p, progress: total > 0 ? loaded / total : 0 }));
          },
        }).then(async (t) => {
          mem.set(k, t);
          await cacheSet(k, t);
          return t;
        });
        inflight.set(k, promise);
        promise.finally(() => inflight.delete(k));
      }
      promise
        .then((t) => {
          if (!cancelled) setState({ terrain: t, loading: false, error: null, progress: 1 });
        })
        .catch((e) => {
          if (!cancelled) setState((p) => ({ terrain: p.terrain, loading: false, error: e.message, progress: 0 }));
        });
    })();

    return () => { cancelled = true; };
  }, [enabled, bounds?.minLon, bounds?.minLat, bounds?.maxLon, bounds?.maxLat]);

  return state;
}
