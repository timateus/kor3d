// Global visual style mode.
//   - 'dark'     default dark scientific
//   - 'mirage'   off-white paper, hairline strokes, monospace
//   - 'designer' live-editable scheme (see DesignerPanel)
//
// State lives on <html class="..."> + a set of CSS custom properties
// written to <html>'s inline style. CSS in index.css falls back to the
// hard-coded mirage palette via `var(--m-*, fallback)` so designer
// edits override mirage in real time.

import { useEffect, useState } from 'react';
import { setDesignerPaletteOverride } from '@/lib/geotiff-loader';

export type VisualMode = 'dark' | 'mirage' | 'designer';

const KEY = 'visualMode';
const SCHEME_KEY = 'designerScheme';
const listeners = new Set<(m: VisualMode) => void>();
const schemeListeners = new Set<(s: DesignerScheme) => void>();

export interface DesignerScheme {
  // Colours (hex)
  background: string;
  foreground: string;
  muted: string;
  panel: string;
  border: string;
  accent: string;
  // Map / terrain
  water: string;
  land: string;
  vegetation: string;
  alert: string;
  // Optional multi-stop terrain ramp (5+ colors low->high). When provided
  // it OVERRIDES the 4-color water/land/veg/alert ramp on the 3D surface.
  terrainStops?: string[];
  // Optional override for the R3F scene background — when present, the 3D
  // scene uses this colour even when the UI `background` is something else.
  // Used by Spectral Earth so the panels stay calm (mirage cream) while the
  // scene takes the wild preset hue.
  sceneBackground?: string;
  // Thicknesses
  borderWidth: number;     // px, 0.25 - 2
  gridOpacity: number;     // 0 - 0.2
  gridSpacing: number;     // px, 16 - 96
  fontWeight: number;      // 100 - 500
  baseFontSize: number;    // px, 9 - 14
  labelFontSize: number;   // px, 7 - 14
  radius: number;          // px, 0 - 12
  svgStroke: number;       // px, 0.25 - 2
}

export const DEFAULT_SCHEME: DesignerScheme = {
  background: '#FAF8F4',
  foreground: '#1A1A1A',
  muted: '#6B6B6B',
  panel: '#FFFFFF',
  border: '#1A1A1A',
  accent: '#1A1A1A',
  water: '#6FA3B8',
  land: '#D9D2C3',
  vegetation: '#8FA68E',
  alert: '#C05A5A',
  borderWidth: 1,
  gridOpacity: 0.012,
  gridSpacing: 48,
  fontWeight: 200,
  baseFontSize: 11,
  labelFontSize: 9,
  radius: 0,
  svgStroke: 0.5,
};

// Hex -> "h s% l%" string for hsl(var(--x)) consumers
function hexToHslTriplet(hex: string): string {
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

export function applyDesignerScheme(s: DesignerScheme) {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  // Override semantic tokens (consumed via hsl(var(--background)) etc.)
  const set = (k: string, v: string) => html.style.setProperty(k, v);
  set('--background', hexToHslTriplet(s.background));
  set('--foreground', hexToHslTriplet(s.foreground));
  set('--muted-foreground', hexToHslTriplet(s.muted));
  set('--card', hexToHslTriplet(s.panel));
  set('--popover', hexToHslTriplet(s.panel));
  set('--border', hexToHslTriplet(s.border));
  set('--primary', hexToHslTriplet(s.accent));
  set('--accent', hexToHslTriplet(s.water));
  set('--destructive', hexToHslTriplet(s.alert));
  set('--terrain-low', hexToHslTriplet(s.water));
  set('--terrain-mid', hexToHslTriplet(s.land));
  set('--terrain-high', hexToHslTriplet(s.vegetation));

  // Designer-specific tokens
  set('--m-border-width', `${s.borderWidth}px`);
  set('--m-grid-opacity', `${s.gridOpacity}`);
  set('--m-grid-spacing', `${s.gridSpacing}px`);
  set('--m-font-weight', `${s.fontWeight}`);
  set('--m-fs-base', `${s.baseFontSize}px`);
  set('--m-fs-label', `${s.labelFontSize}px`);
  set('--m-radius', `${s.radius}px`);
  set('--m-svg-stroke', `${s.svgStroke}`);

  // Map colors as hex (for three.js components reading via JS)
  set('--map-water', s.water);
  set('--map-land', s.land);
  set('--map-vegetation', s.vegetation);
  set('--map-alert', s.alert);
  set('--map-background', s.background);

  // Push to terrain color ramp so the 3D surface itself recolors.
  setDesignerPaletteOverride({
    water: s.water,
    land: s.land,
    vegetation: s.vegetation,
    alert: s.alert,
    background: s.background,
    stops: s.terrainStops,
  });

  try { localStorage.setItem(SCHEME_KEY, JSON.stringify(s)); } catch {}
  schemeListeners.forEach(l => l(s));
}

export function clearDesignerScheme() {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  const props = [
    '--background','--foreground','--muted-foreground','--card','--popover',
    '--border','--primary','--accent','--destructive',
    '--terrain-low','--terrain-mid','--terrain-high',
    '--m-border-width','--m-grid-opacity','--m-grid-spacing',
    '--m-font-weight','--m-fs-base','--m-fs-label','--m-radius','--m-svg-stroke',
    '--map-water','--map-land','--map-vegetation','--map-alert','--map-background',
  ];
  for (const p of props) html.style.removeProperty(p);
  setDesignerPaletteOverride(null);
}

// ---------- Palette presets ----------
export type PresetId =
  | 'cyberpunk' | 'hotpink'
  | 'rainbow' | 'oilslick' | 'lava' | 'aurora' | 'tropical' | 'acid'
  | 'plasma' | 'candy_rave' | 'toxic' | 'sunset_wild' | 'galaxy' | 'forest_wild';

// Each preset ONLY overrides map colors + terrain stops + scene background.
// UI tokens (foreground/muted/panel/border/accent) are intentionally left
// untouched so panels & text stay readable across every preset.
type PresetScheme = Pick<DesignerScheme, 'water' | 'land' | 'vegetation' | 'alert'> & {
  background?: string;
  terrainStops?: string[];
};

export const PALETTE_PRESETS: { id: PresetId; label: string; scheme: PresetScheme }[] = [
  { id: 'cyberpunk', label: 'Cyberpunk', scheme: {
    background: '#04020E',
    water: '#1B0E4A', land: '#3A1F66', vegetation: '#00F0FF', alert: '#FF00C8',
    terrainStops: ['#0A001F', '#3A0E66', '#7A1FA8', '#FF00C8', '#FF66E0', '#00F0FF', '#FFFFFF'],
  }},
  { id: 'hotpink', label: 'Hot Pink', scheme: {
    background: '#1A0512',
    water: '#4A0E2E', land: '#FF6BA0', vegetation: '#FF1E7A', alert: '#FFE600',
    terrainStops: ['#2A0418', '#7A1040', '#C81A66', '#FF1E7A', '#FF6BA0', '#FFB8D6', '#FFE600'],
  }},
  { id: 'rainbow', label: 'Rainbow', scheme: {
    background: '#0A0A14',
    water: '#5A2EFF', land: '#FFD23F', vegetation: '#3FFF6B', alert: '#FF3F6B',
    terrainStops: ['#7A1FFF', '#3F6BFF', '#3FE0FF', '#3FFF6B', '#FFD23F', '#FF8A3F', '#FF3F6B', '#FF3FE0'],
  }},
  { id: 'oilslick', label: 'Oil Slick', scheme: {
    background: '#06060A',
    water: '#1A1438', land: '#5A3F8A', vegetation: '#3FE0C8', alert: '#FF6BC8',
    terrainStops: ['#0A0A1A', '#2E1A5A', '#5A2E8A', '#3F8AC8', '#3FE0C8', '#C8E03F', '#FF6BC8', '#FFC8E0'],
  }},
  { id: 'lava', label: 'Lava', scheme: {
    background: '#0A0204',
    water: '#1A0204', land: '#7A1808', vegetation: '#FF8A1A', alert: '#FFE63F',
    terrainStops: ['#000000', '#3A0A04', '#7A1808', '#C82E08', '#FF5A1A', '#FF8A1A', '#FFD23F', '#FFFFE0'],
  }},
  { id: 'aurora', label: 'Aurora', scheme: {
    background: '#020A14',
    water: '#0A1A3A', land: '#1A5A8A', vegetation: '#3FFFB8', alert: '#C83FFF',
    terrainStops: ['#02061A', '#0A1A4A', '#1A5AAA', '#3FE0FF', '#3FFFB8', '#A8FF3F', '#FF8A3F', '#C83FFF'],
  }},
  { id: 'tropical', label: 'Tropical', scheme: {
    background: '#0A1A2A',
    water: '#0E5AC8', land: '#FFE08A', vegetation: '#3FC83F', alert: '#FF5A3F',
    terrainStops: ['#0A2E7A', '#0E5AC8', '#3FAAE0', '#FFE08A', '#A8E03F', '#3FC83F', '#1A8A1A', '#FF5A3F'],
  }},
  { id: 'acid', label: 'Acid', scheme: {
    background: '#0A0A04',
    water: '#1A2E0A', land: '#A8E01A', vegetation: '#3FFF1A', alert: '#FF3FE0',
    terrainStops: ['#0A0A02', '#2E3A08', '#7AC81A', '#A8E01A', '#3FFF1A', '#E0FF3F', '#FF8A1A', '#FF3FE0'],
  }},
  { id: 'plasma', label: 'Plasma', scheme: {
    background: '#0A0214',
    water: '#1A0838', land: '#7A1A8A', vegetation: '#FF3F8A', alert: '#FFE63F',
    terrainStops: ['#0A0220', '#3A0A6A', '#7A1A8A', '#C82EAA', '#FF3F8A', '#FF8A3F', '#FFD23F', '#FFFFE0'],
  }},
  { id: 'candy_rave', label: 'Candy Rave', scheme: {
    background: '#1A0A1F',
    water: '#3FE0FF', land: '#FF8AE0', vegetation: '#A8FF3F', alert: '#FFE63F',
    terrainStops: ['#3FE0FF', '#A8C8FF', '#FF8AE0', '#FFB8E0', '#A8FF3F', '#E0FF8A', '#FFE63F', '#FF8A3F'],
  }},
  { id: 'toxic', label: 'Toxic', scheme: {
    background: '#020A02',
    water: '#0A2E0A', land: '#3F7A1A', vegetation: '#A8FF1A', alert: '#FF3F1A',
    terrainStops: ['#020A02', '#0A2E0A', '#1A5A1A', '#3F7A1A', '#7AC81A', '#A8FF1A', '#E0FF3F', '#FF3F1A'],
  }},
  { id: 'sunset_wild', label: 'Sunset Wild', scheme: {
    background: '#1A0214',
    water: '#3A0A4A', land: '#FF6B3F', vegetation: '#FFD23F', alert: '#FFE6A8',
    terrainStops: ['#1A0220', '#3A0A4A', '#7A1A5A', '#C83F4A', '#FF6B3F', '#FF8A3F', '#FFD23F', '#FFE6A8'],
  }},
  { id: 'galaxy', label: 'Galaxy', scheme: {
    background: '#020208',
    water: '#0A0A2E', land: '#2E1A5A', vegetation: '#8A3FC8', alert: '#FFE63F',
    terrainStops: ['#000000', '#0A0A2E', '#1A0A4A', '#3A1A7A', '#7A3FAA', '#C86BE0', '#FFB8E0', '#FFFFE0'],
  }},
  { id: 'forest_wild', label: 'Forest Wild', scheme: {
    background: '#0A1A0A',
    water: '#0A2E2A', land: '#7A5A1A', vegetation: '#3F8A2E', alert: '#FFD23F',
    terrainStops: ['#0A1A0A', '#0A2E2A', '#1A5A3F', '#3F8A2E', '#7AC83F', '#A8E08A', '#7A5A1A', '#FFD23F'],
  }},
];

export function applyPreset(id: PresetId) {
  const p = PALETTE_PRESETS.find(x => x.id === id);
  if (!p) return;
  const cur = getDesignerScheme();
  // Only merge map + bg + stops. Leave UI tokens untouched.
  const next: DesignerScheme = {
    ...cur,
    water: p.scheme.water,
    land: p.scheme.land,
    vegetation: p.scheme.vegetation,
    alert: p.scheme.alert,
    background: p.scheme.background ?? cur.background,
    terrainStops: p.scheme.terrainStops,
  };
  applyDesignerScheme(next);
}

export function applyRandomPreset(): PresetId {
  const idx = Math.floor(Math.random() * PALETTE_PRESETS.length);
  const p = PALETTE_PRESETS[idx];
  applyPreset(p.id);
  return p.id;
}

// ---------- HSL <-> hex utils ----------
function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(1, s)); l = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

function hexToHsl(hex: string): [number, number, number] {
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return [h, s, l];
}

// Generates a fresh wild, multi-colored terrain ramp from a random seed hue.
// Only touches map colors + bg + terrainStops — leaves UI tokens alone.
export function generateRandomRamp() {
  const cur = getDesignerScheme();
  const [, , bgL] = hexToHsl(cur.background);
  const darkMode = bgL < 0.5;

  const baseHue = Math.random() * 360;
  const sat = 0.7 + Math.random() * 0.3; // 0.7..1.0 — vivid

  // 8 hues spread around the wheel for "crazy color" terrain
  const stopCount = 7 + Math.floor(Math.random() * 3); // 7..9
  const hueSpread = 200 + Math.random() * 160; // 200..360°
  const stops: string[] = [];
  for (let i = 0; i < stopCount; i++) {
    const t = i / (stopCount - 1);
    const h = baseHue + t * hueSpread + (Math.random() - 0.5) * 30;
    // Alternating lightness for high contrast banding
    const l = darkMode
      ? 0.25 + (i % 2 === 0 ? 0.15 : 0.40) + t * 0.1
      : 0.40 + (i % 2 === 0 ? 0.10 : 0.30) - t * 0.05;
    stops.push(hslToHex(h, sat, l));
  }

  const background = darkMode
    ? hslToHex(baseHue, 0.30, 0.04 + Math.random() * 0.04)
    : hslToHex(baseHue, 0.10, 0.94 + Math.random() * 0.04);

  const next: DesignerScheme = {
    ...cur,
    background,
    water:      stops[0],
    land:       stops[Math.floor(stopCount / 3)],
    vegetation: stops[Math.floor((2 * stopCount) / 3)],
    alert:      stops[stopCount - 1],
    terrainStops: stops,
  };
  applyDesignerScheme(next);
}

export function getDesignerScheme(): DesignerScheme {
  if (typeof localStorage === 'undefined') return DEFAULT_SCHEME;
  try {
    const raw = localStorage.getItem(SCHEME_KEY);
    if (!raw) return DEFAULT_SCHEME;
    return { ...DEFAULT_SCHEME, ...JSON.parse(raw) };
  } catch { return DEFAULT_SCHEME; }
}

export function getVisualMode(): VisualMode {
  if (typeof document === 'undefined') return 'dark';
  const cl = document.documentElement.classList;
  if (cl.contains('designer')) return 'designer';
  if (cl.contains('mirage')) return 'mirage';
  return 'dark';
}

export function setVisualMode(mode: VisualMode) {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  html.classList.remove('mirage', 'designer');
  if (mode === 'mirage') html.classList.add('mirage');
  if (mode === 'designer') {
    html.classList.add('mirage', 'designer');
    applyDesignerScheme(getDesignerScheme());
  } else {
    clearDesignerScheme();
  }
  try { localStorage.setItem(KEY, mode); } catch {}
  listeners.forEach(l => l(mode));
}

export function toggleVisualMode() {
  const order: VisualMode[] = ['dark', 'mirage', 'designer'];
  const cur = getVisualMode();
  const next = order[(order.indexOf(cur) + 1) % order.length];
  setVisualMode(next);
}

export function subscribeVisualMode(fn: (m: VisualMode) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function subscribeDesignerScheme(fn: (s: DesignerScheme) => void): () => void {
  schemeListeners.add(fn);
  return () => { schemeListeners.delete(fn); };
}

// Initialise from localStorage on module load
if (typeof document !== 'undefined') {
  try {
    const saved = localStorage.getItem(KEY) as VisualMode | null;
    if (saved === 'mirage') document.documentElement.classList.add('mirage');
    if (saved === 'designer') {
      document.documentElement.classList.add('mirage', 'designer');
      applyDesignerScheme(getDesignerScheme());
    }
  } catch {}
}

export function useVisualMode(): [VisualMode, (m: VisualMode) => void] {
  const [mode, setMode] = useState<VisualMode>(() => getVisualMode());
  useEffect(() => subscribeVisualMode(setMode), []);
  return [mode, setVisualMode];
}

export function useDesignerScheme(): [DesignerScheme, (s: DesignerScheme) => void] {
  const [scheme, setScheme] = useState<DesignerScheme>(() => getDesignerScheme());
  useEffect(() => subscribeDesignerScheme(setScheme), []);
  return [scheme, applyDesignerScheme];
}

// Mirage-ish UI tokens. Used by Spectral Earth so panels stay readable
// while the 3D scene runs wild presets.
const MIRAGE_UI = {
  background: '#FAF8F4',
  foreground: '#1A1A1A',
  muted: '#6B6B6B',
  panel: '#FFFFFF',
  border: '#1A1A1A',
  accent: '#1A1A1A',
};

/** Apply a random preset (or a freshly generated ramp) while locking the
 *  UI to the mirage cream/ink palette. The scene background takes the wild
 *  hue via `sceneBackground`. */
export function applyRandomSpectralPalette() {
  const cur = getDesignerScheme();
  // 50/50: curated preset vs freshly generated ramp.
  if (Math.random() < 0.5) {
    applyRandomPreset();
  } else {
    generateRandomRamp();
  }
  const wild = getDesignerScheme();
  applyDesignerScheme({
    ...wild,
    ...MIRAGE_UI,
    sceneBackground: '#FAF8F4',
  });
}

