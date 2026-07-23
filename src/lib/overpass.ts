import { supabase } from '@/integrations/supabase/client';
import { cacheGet, cacheSet } from './browser-cache';

/**
 * Call the Overpass API via our edge-function proxy (bypasses browser CORS).
 * Results are cached in IndexedDB per (cacheKey).
 */
export async function fetchOverpass<T = any>(query: string, cacheKey: string): Promise<T> {
  const disk = await cacheGet<T>(cacheKey);
  if (disk) return disk;

  const { data, error } = await supabase.functions.invoke('overpass-proxy', {
    body: { query },
  });
  if (error) throw error;
  if (data && (data as any).error) throw new Error((data as any).error);

  cacheSet(cacheKey, data as T).catch(() => {});
  return data as T;
}
