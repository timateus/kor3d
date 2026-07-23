import { useEffect, useState, useCallback } from 'react';
import type { GeoBounds } from '@/lib/geotiff-loader';
import { DEFAULT_CUSTOM_BOUNDS, type RegionId } from '@/lib/terrain-regions';
import type { BaseStyle } from '@/lib/mapbox-tiles';

export type TerrainMode = 'classic' | 'satellite';
export type { BaseStyle };

const STORAGE_TOKEN = 'mapbox_token';
const STORAGE_MODE = 'terrain_mode';
const STORAGE_REGION = 'terrain_region';
const STORAGE_CUSTOM = 'terrain_custom_bounds';
const STORAGE_BASE_STYLE = 'terrain_base_style';

// No default token: this app only uses the tokenless 'satlas'/'osm' basemap
// styles (see LocationPage's baseStyleOverride="satlas"). A token is only
// needed if a caller opts into the 'streets'/'satellite' Mapbox styles.
const DEFAULT_TOKEN = '';

function readCustom(): GeoBounds {
  try {
    const raw = localStorage.getItem(STORAGE_CUSTOM);
    if (raw) {
      const p = JSON.parse(raw);
      if (typeof p.minLon === 'number') return p;
    }
  } catch {}
  return { ...DEFAULT_CUSTOM_BOUNDS };
}

let listeners = new Set<() => void>();
let _mode: TerrainMode = (localStorage.getItem(STORAGE_MODE) as TerrainMode) || 'classic';
let _token: string = localStorage.getItem(STORAGE_TOKEN) || DEFAULT_TOKEN;
let _region: RegionId = (localStorage.getItem(STORAGE_REGION) as RegionId) || 'custom';
let _custom: GeoBounds = readCustom();
let _baseStyle: BaseStyle = (localStorage.getItem(STORAGE_BASE_STYLE) as BaseStyle) || 'satellite';

function notify() { listeners.forEach((l) => l()); }

export function useTerrainMode() {
  const [mode, setModeState] = useState<TerrainMode>(_mode);
  const [token, setTokenState] = useState<string>(_token);
  const [region, setRegionState] = useState<RegionId>(_region);
  const [customBounds, setCustomBoundsState] = useState<GeoBounds>(_custom);
  const [baseStyle, setBaseStyleState] = useState<BaseStyle>(_baseStyle);

  useEffect(() => {
    const cb = () => {
      setModeState(_mode);
      setTokenState(_token);
      setRegionState(_region);
      setCustomBoundsState(_custom);
      setBaseStyleState(_baseStyle);
    };
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  }, []);

  const setMode = useCallback((m: TerrainMode) => {
    _mode = m; localStorage.setItem(STORAGE_MODE, m); notify();
  }, []);

  const setToken = useCallback((t: string) => {
    _token = t.trim(); localStorage.setItem(STORAGE_TOKEN, _token); notify();
  }, []);

  const setRegion = useCallback((r: RegionId) => {
    _region = r; localStorage.setItem(STORAGE_REGION, r); notify();
  }, []);

  const setCustomBounds = useCallback((b: GeoBounds) => {
    _custom = { ...b };
    localStorage.setItem(STORAGE_CUSTOM, JSON.stringify(_custom));
    notify();
  }, []);

  const setBaseStyle = useCallback((s: BaseStyle) => {
    _baseStyle = s; localStorage.setItem(STORAGE_BASE_STYLE, s); notify();
  }, []);

  return { mode, setMode, token, setToken, region, setRegion, customBounds, setCustomBounds, baseStyle, setBaseStyle };
}
