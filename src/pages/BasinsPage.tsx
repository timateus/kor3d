import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, RotateCcw } from 'lucide-react';

/**
 * Central Asia river/lake basins — population by HydroBASINS sub-basin
 * (dissolved to MAIN_BAS for the "main" level, raw HydroBASINS lev03 for
 * the "lvl3" level), clipped to KZ/UZ/TM/TJ/KG territory only. Population
 * from GHS-POP R2023A. Data pre-baked as static GeoJSON under
 * public/data/basins/ — see the ad-hoc Python pipeline that produced it
 * (not checked into this repo; same source datasets as
 * scripts/prefetch/hydrosheds.mjs and scripts/prefetch/ghs-pop.mjs).
 *
 * Rendered with D3 (geo projection + zoom) loaded from cdnjs at runtime —
 * this is the only page in the app that needs it, so it isn't a package
 * dependency. Rivers are merged into one path per Strahler-order bucket
 * (not one path per reach) — thousands of separate <path> elements is what
 * made the first version of this map laggy to pan/zoom.
 *
 * Two color modes: 'basin' (golden-angle categorical hue per shape — good
 * for telling basins apart, useless for comparing magnitude) and 'density'
 * (sequential scale in the app's own accent hue, with a legend — answers
 * "where is it denser" at a glance, which categorical color structurally
 * cannot). A design critique flagged shipping only the categorical mode as
 * answering the wrong question for population data; both are kept and the
 * viewer picks.
 */

const D3_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js';

declare global {
  interface Window {
    d3: any;
  }
}

function loadD3(): Promise<any> {
  if (window.d3) return Promise.resolve(window.d3);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${D3_CDN}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(window.d3));
      existing.addEventListener('error', () => reject(new Error('D3 (cdnjs)')));
      return;
    }
    const s = document.createElement('script');
    s.src = D3_CDN;
    s.onload = () => resolve(window.d3);
    s.onerror = () => reject(new Error('D3 (cdnjs)'));
    document.head.appendChild(s);
  });
}

async function fetchJson(url: string, label: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(label);
  return res.json();
}

const BASIN_NAMES_MAIN: Record<number, string> = {
  4060050240: 'Сырдарья',
  4060050220: 'Амударья',
  3060001840: 'Иртыш–Ишим (бассейн Оби, каз. часть)',
  4060050230: 'Иле-Балхаш',
  2060085500: 'Мургаб и реки Копетдага',
  2060085610: 'Западный Туркменистан (Каспий)',
  4060050300: 'Шу (Чу)',
  2060067740: 'Урал (Жайык)',
  4060050350: 'Талас',
  4060051420: 'Зеравшан (Бухарский оазис)',
  2060066680: 'Эмба (Жем)',
  4060050570: 'Иссык-Куль',
  4060050310: 'Сарысу',
  2060066340: 'Западноказахстанские бессточные реки',
  2060086980: 'Приуральские бессточные реки',
  4060050330: 'Алаколь',
  2060067570: 'Уил',
  2060067650: 'Сагиз',
};
const BASIN_NAMES_LVL3: Record<number, string> = {
  4030050240: 'Сырдарья, Шу-Талас, Иссык-Куль и Сарысу (укрупнённо)',
  4030050220: 'Амударья',
  2030065840: 'Юг Туркменистана и Каспий (укрупнённо)',
  3030001840: 'Иртыш–Ишим (бассейн Оби, каз. часть)',
  4030050230: 'Иле-Балхаш',
  2030066850: 'Западноказахстанские бессточные реки (укрупнённо)',
};

const CITIES = [
  { name: 'Астана', lon: 71.449, lat: 51.169, tier: 1 },
  { name: 'Ташкент', lon: 69.279, lat: 41.311, tier: 1 },
  { name: 'Бишкек', lon: 74.590, lat: 42.875, tier: 1 },
  { name: 'Душанбе', lon: 68.787, lat: 38.559, tier: 1 },
  { name: 'Ашхабад', lon: 58.380, lat: 37.950, tier: 1 },
  { name: 'Алматы', lon: 76.851, lat: 43.222, tier: 1 },
  { name: 'Самарканд', lon: 66.975, lat: 39.627, tier: 2 },
  { name: 'Шымкент', lon: 69.596, lat: 42.317, tier: 2 },
  { name: 'Наманган', lon: 71.673, lat: 40.998, tier: 2 },
  { name: 'Андижан', lon: 72.359, lat: 40.783, tier: 2 },
  { name: 'Бухара', lon: 64.421, lat: 39.768, tier: 2 },
  { name: 'Караганда', lon: 73.088, lat: 49.807, tier: 2 },
  { name: 'Ош', lon: 72.798, lat: 40.533, tier: 2 },
  { name: 'Актобе', lon: 57.167, lat: 50.283, tier: 2 },
  { name: 'Тараз', lon: 71.366, lat: 42.900, tier: 2 },
  { name: 'Павлодар', lon: 76.967, lat: 52.287, tier: 2 },
  { name: 'Атырау', lon: 51.883, lat: 47.117, tier: 2 },
  { name: 'Мары', lon: 61.833, lat: 37.600, tier: 3 },
  { name: 'Туркменабат', lon: 63.583, lat: 39.083, tier: 3 },
  { name: 'Нукус', lon: 59.611, lat: 42.460, tier: 3 },
  { name: 'Фергана', lon: 71.784, lat: 40.386, tier: 3 },
  { name: 'Ургенч', lon: 60.631, lat: 41.550, tier: 3 },
  { name: 'Худжанд', lon: 69.622, lat: 40.283, tier: 3 },
  { name: 'Костанай', lon: 63.635, lat: 53.214, tier: 3 },
  { name: 'Кызылорда', lon: 65.502, lat: 44.848, tier: 3 },
  { name: 'Уральск', lon: 51.367, lat: 51.233, tier: 3 },
  { name: 'Петропавловск', lon: 69.162, lat: 54.875, tier: 3 },
  { name: 'Усть-Каменогорск', lon: 82.628, lat: 49.949, tier: 3 },
  { name: 'Семей', lon: 80.227, lat: 50.411, tier: 3 },
  { name: 'Дашогуз', lon: 59.966, lat: 41.836, tier: 3 },
  { name: 'Джалал-Абад', lon: 73.000, lat: 40.933, tier: 3 },
  { name: 'Термез', lon: 67.278, lat: 37.225, tier: 3 },
  { name: 'Балканабат', lon: 54.366, lat: 39.511, tier: 3 },
];

const GOLDEN_ANGLE = 137.50776;
function categoryColor(i: number) {
  const hue = (i * GOLDEN_ANGLE) % 360;
  return `hsl(${hue.toFixed(1)}, 70%, 53%)`;
}

// Sequential ramp in the app's own accent hue (--primary: 190 70% 50% in
// index.css) rather than a generic d3 built-in — ties the density view back
// to kor3d's own palette instead of an arbitrary import.
const DENSITY_LOW = 'hsl(190, 35%, 92%)';
const DENSITY_HIGH = 'hsl(190, 78%, 22%)';

const dataBase = `${import.meta.env.BASE_URL}data/basins`;

type ColorMode = 'basin' | 'density';
type LevelKey = 'main' | 'lvl3';

export default function BasinsPage() {
  const svgRef = useRef<SVGSVGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [stats, setStats] = useState({ n: 0, pop: '—', area: '—' });
  const [level, setLevel] = useState<LevelKey>('main');
  const [colorMode, setColorMode] = useState<ColorMode>('basin');
  const [maxDensity, setMaxDensity] = useState(0);
  const loadLevelRef = useRef<(key: LevelKey) => void>();
  const setColorModeRef = useRef<(mode: ColorMode) => void>();
  const resetViewRef = useRef<() => void>();

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;

    (async () => {
      setStatus('loading');
      setErrorDetail(null);
      try {
        const [d3, basinsMain, basinsLvl3, countries, rivers] = await Promise.all([
          loadD3(),
          fetchJson(`${dataBase}/basins_main.json`, 'данные по бассейнам (речные системы)'),
          fetchJson(`${dataBase}/basins_lvl3.json`, 'данные по бассейнам (крупные)'),
          fetchJson(`${dataBase}/countries.json`, 'границы стран'),
          fetchJson(`${dataBase}/rivers.json`, 'реки'),
        ]);
        if (cancelled || !svgRef.current || !tooltipRef.current) return;

        const LEVELS: Record<LevelKey, { data: any; names: Record<number, string> }> = {
          main: { data: basinsMain, names: BASIN_NAMES_MAIN },
          lvl3: { data: basinsLvl3, names: BASIN_NAMES_LVL3 },
        };

        const svg = d3.select(svgRef.current);
        svg.selectAll('*').remove();
        const g = svg.append('g');
        const gBasins = g.append('g');
        const gRivers = g.append('g');
        const gBorders = g.append('g');
        const gCities = g.append('g');

        const projection = d3.geoConicEqualArea().parallels([32, 54]).rotate([-68, 0]);
        const path = d3.geoPath(projection);
        const tooltip = d3.select(tooltipRef.current);
        const fmtPop = (n: number) => d3.format(',.0f')(n).replace(/,/g, ' ');
        let pinned: any = null;
        let levelKey: LevelKey = 'main';
        let mode: ColorMode = 'basin';
        let feats: any[] = [];
        let maxDens = 1;

        function basinName(mainBas: number) {
          return LEVELS[levelKey].names[mainBas] || 'Малый бессточный бассейн';
        }

        function densityColor(d: number) {
          const t = Math.log1p(d) / Math.log1p(maxDens || 1);
          return d3.interpolateHsl(DENSITY_LOW, DENSITY_HIGH)(Math.max(0, Math.min(1, t)));
        }

        function colorFor(i: number, p: any) {
          return mode === 'basin' ? categoryColor(i) : densityColor(p.density_km2);
        }

        function fit() {
          const rect = svg.node().getBoundingClientRect();
          if (!rect.width || !rect.height) return;
          svg.attr('viewBox', `0 0 ${rect.width} ${rect.height}`);
          projection.fitExtent([[24, 20], [rect.width - 24, rect.height - 20]], countries);
          gBasins.selectAll('path').attr('d', path);
          gRivers.selectAll('path').attr('d', path);
          gBorders.selectAll('path').attr('d', path);
          gCities.selectAll('g.city').attr('transform', (d: any) => {
            const c = projection([d.lon, d.lat]);
            return c ? `translate(${c[0]},${c[1]})` : 'translate(-9999,-9999)';
          });
        }

        function clearTooltip() {
          pinned = null;
          tooltip.style('opacity', 0).style('transform', 'translate(-9999px,-9999px)');
          gBasins.selectAll('path.selected').classed('selected', false);
        }

        function showTooltip(event: any, el: any, d: any) {
          const p = d.properties;
          const [mx, my] = d3.pointer(event, svg.node().parentNode);
          tooltip.html(`
            <div class="bp-name">${basinName(p.main_bas)}</div>
            <div class="bp-row"><span>Население</span><b>${fmtPop(p.population)}</b></div>
            <div class="bp-row"><span>Площадь</span><b>${fmtPop(p.area_km2)} км²</b></div>
            <div class="bp-row"><span>Плотность</span><b>${p.density_km2.toFixed(2)} чел/км²</b></div>
          `);
          const rect = svg.node().parentNode.getBoundingClientRect();
          let left = mx + 16, top = my + 16;
          if (left + 260 > rect.width) left = mx - 266;
          if (top + 100 > rect.height) top = my - 110;
          tooltip.style('transform', `translate(${left}px, ${top}px)`).style('opacity', 1);
          d3.select(el).raise();
          gBasins.selectAll('path.selected').classed('selected', false);
          d3.select(el).classed('selected', true);
        }

        function activate(event: any, el: any, d: any) {
          if (pinned === el) { clearTooltip(); return; }
          pinned = el;
          showTooltip(event, el, d);
        }

        function renderBasins() {
          gBasins.selectAll('path')
            .data(feats)
            .join('path')
            .attr('class', 'bp-basin')
            .attr('d', path)
            .attr('fill', (d: any, i: number) => colorFor(i, d.properties))
            .attr('tabindex', 0)
            .attr('role', 'button')
            .attr('aria-label', (d: any) => {
              const p = d.properties;
              return `${basinName(p.main_bas)}: население ${fmtPop(p.population)}, площадь ${fmtPop(p.area_km2)} км², плотность ${p.density_km2.toFixed(2)} человек на км²`;
            })
            .on('mousemove', function (this: any, event: any, d: any) {
              if (pinned) return;
              showTooltip(event, this, d);
            })
            .on('mouseleave', function (this: any) {
              if (pinned) return;
              tooltip.style('opacity', 0).style('transform', 'translate(-9999px,-9999px)');
              d3.select(this).classed('selected', false);
            })
            .on('click', function (this: any, event: any, d: any) {
              event.stopPropagation();
              activate(event, this, d);
            })
            .on('focus', function (this: any, event: any, d: any) {
              showTooltip(event, this, d);
            })
            .on('blur', function (this: any) {
              if (pinned !== this) {
                tooltip.style('opacity', 0).style('transform', 'translate(-9999px,-9999px)');
                d3.select(this).classed('selected', false);
              }
            })
            .on('keydown', function (this: any, event: any, d: any) {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                activate(event, this, d);
              }
            });
        }

        svg.on('click', clearTooltip);

        gRivers.selectAll('path')
          .data(rivers.features)
          .join('path')
          .attr('class', 'bp-river')
          .attr('stroke-width', (d: any) => Math.max(0.5, (d.properties.ord_stra - 4) * 0.55));

        gBorders.selectAll('path')
          .data(countries.features)
          .join('path')
          .attr('class', 'bp-country-border');

        const cityG = gCities.selectAll('g.city').data(CITIES).join('g').attr('class', 'city');
        cityG.append('circle')
          .attr('class', 'bp-city-dot')
          .attr('r', (d: any) => (d.tier === 1 ? 4 : d.tier === 2 ? 2.8 : 1.9));
        cityG.append('text')
          .attr('class', 'bp-city-label')
          .attr('x', (d: any) => (d.tier === 1 ? 7 : 5))
          .attr('y', 4)
          .attr('font-size', (d: any) => (d.tier === 1 ? 13 : d.tier === 2 ? 11 : 9.5))
          .text((d: any) => d.name);

        const zoom = d3.zoom().scaleExtent([1, 14]).on('zoom', (event: any) => {
          g.attr('transform', event.transform);
          gCities.selectAll('circle.bp-city-dot').attr('r', (d: any) => {
            const base = d.tier === 1 ? 4 : d.tier === 2 ? 2.8 : 1.9;
            return base / event.transform.k;
          });
          gCities.selectAll('text.bp-city-label')
            .attr('font-size', (d: any) => {
              const base = d.tier === 1 ? 13 : d.tier === 2 ? 11 : 9.5;
              return base / event.transform.k;
            })
            .attr('x', (d: any) => (d.tier === 1 ? 7 : 5) / event.transform.k);
          gCities.selectAll('.bp-city-label').attr('stroke-width', 3 / event.transform.k);
        });
        svg.call(zoom);

        function resetView() {
          svg.transition().duration(400).call(zoom.transform, d3.zoomIdentity);
        }
        resetViewRef.current = resetView;

        function loadLevel(key: LevelKey) {
          levelKey = key;
          feats = LEVELS[key].data.features.filter((f: any) => f.geometry);
          maxDens = d3.max(feats, (f: any) => f.properties.density_km2) || 1;
          setMaxDensity(maxDens);
          const totalPop = d3.sum(feats, (f: any) => f.properties.population);
          const totalArea = d3.sum(feats, (f: any) => f.properties.area_km2);
          setStats({
            n: feats.length,
            pop: d3.format(',.2s')(totalPop).replace('G', 'млрд').replace('M', 'млн').replace('k', 'тыс').replace(/,/g, ' '),
            area: d3.format(',.2s')(totalArea).replace('M', 'млн').replace('k', 'тыс').replace(/,/g, ' '),
          });
          clearTooltip();
          renderBasins();
        }
        loadLevelRef.current = loadLevel;

        function applyColorMode(m: ColorMode) {
          mode = m;
          gBasins.selectAll('path').attr('fill', (d: any, i: number) => colorFor(i, d.properties));
        }
        setColorModeRef.current = applyColorMode;

        window.addEventListener('resize', fit);
        fit();
        loadLevel('main');
        setStatus('ready');

        cleanup = () => {
          window.removeEventListener('resize', fit);
          svg.on('.zoom', null);
        };
      } catch (e: any) {
        console.error('BasinsPage failed to load', e);
        if (!cancelled) {
          setErrorDetail(e?.message || 'неизвестный источник');
          setStatus('error');
        }
      }
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [retryTick]);

  // Escape resets the view — the only other way back once zoomed/panned is
  // otherwise a full page reload, which was the P0 this restores.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') resetViewRef.current?.();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const densityMax = maxDensity > 0 ? maxDensity.toFixed(0) : '—';

  return (
    <div className="flex h-screen flex-col bg-background text-foreground overflow-hidden">
      <style>{`
        .bp-basin{ stroke:hsl(220 20% 8%); stroke-width:0.9; vector-effect:non-scaling-stroke; cursor:pointer; }
        .bp-basin:hover{ filter:brightness(1.1); }
        .bp-basin:focus-visible{ outline:none; stroke:hsl(190 78% 60%); stroke-width:2.5; }
        .bp-basin.selected{ stroke:#fff; stroke-width:2.2; }
        .bp-river{ fill:none; stroke:#bfe6f2; stroke-linecap:round; stroke-linejoin:round; vector-effect:non-scaling-stroke; pointer-events:none; opacity:0.85; }
        .bp-country-border{ fill:none; stroke:#fff; stroke-width:1.3; stroke-dasharray:4 2; opacity:0.4; vector-effect:non-scaling-stroke; pointer-events:none; }
        .bp-city-dot{ fill:#fff; stroke:hsl(220 20% 8%); stroke-width:1px; vector-effect:non-scaling-stroke; pointer-events:none; }
        .bp-city-label{ font-family:'Inter', sans-serif; fill:#fff; paint-order:stroke; stroke:hsl(220 20% 8%); stroke-width:3px; stroke-linejoin:round; pointer-events:none; font-weight:500; }
        .bp-tooltip{ position:absolute; top:0; left:0; pointer-events:none; background:hsl(220 18% 12%); border:1px solid hsl(220 15% 22%); border-radius:10px; box-shadow:0 10px 30px rgba(0,0,0,0.4); padding:10px 12px; font-size:12.5px; max-width:250px; opacity:0; transform:translate(-9999px,-9999px); z-index:10; }
        .bp-name{ font-weight:600; font-size:14px; margin-bottom:6px; }
        .bp-row{ display:flex; justify-content:space-between; gap:14px; padding:2px 0; color:hsl(215 15% 65%); }
        .bp-row b{ color:hsl(210 20% 90%); font-variant-numeric:tabular-nums; font-weight:500; }
      `}</style>

      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-4 py-3 sm:px-6 sm:py-4">
        <div className="max-w-xl">
          <Link to="/" className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground sm:mb-2">
            <ArrowLeft className="h-3 w-3" /> назад
          </Link>
          <h1 className="text-lg font-semibold tracking-tight sm:text-xl">Бассейны Центральной Азии</h1>
          <p className="mt-1 hidden text-xs text-muted-foreground sm:block">
            Речные и озёрные бассейны Казахстана, Узбекистана, Туркменистана, Таджикистана и Киргизии —
            HydroBASINS (Lehner &amp; Grill, 2013), население GHS-POP R2023A.
          </p>
        </div>
        <div className="flex gap-4 text-right font-mono text-xs tabular-nums sm:gap-6 sm:text-sm">
          <div><div className="text-base sm:text-lg">{stats.n || '—'}</div><div className="text-[9px] uppercase tracking-wide text-muted-foreground sm:text-[10px]">бассейнов</div></div>
          <div><div className="text-base sm:text-lg">{stats.pop}</div><div className="text-[9px] uppercase tracking-wide text-muted-foreground sm:text-[10px]">население</div></div>
          <div><div className="text-base sm:text-lg">{stats.area}</div><div className="text-[9px] uppercase tracking-wide text-muted-foreground sm:text-[10px]">км²</div></div>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card px-4 py-2 sm:gap-4 sm:px-6">
        <div className="flex flex-col gap-1">
          <label htmlFor="basins-level" className="text-[10px] uppercase tracking-wide text-muted-foreground">Уровень бассейнов</label>
          <select
            id="basins-level"
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            value={level}
            onChange={(e) => {
              const v = e.target.value as LevelKey;
              setLevel(v);
              loadLevelRef.current?.(v);
            }}
          >
            <option value="lvl3">Крупные (9)</option>
            <option value="main">По речным системам (112)</option>
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Цвет</span>
          <div className="inline-flex rounded-md border border-border bg-background p-0.5" role="group" aria-label="Режим окраски">
            {(['basin', 'density'] as ColorMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setColorMode(m);
                  setColorModeRef.current?.(m);
                }}
                className={`rounded px-2 py-1 text-xs transition-colors ${colorMode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                aria-pressed={colorMode === m}
              >
                {m === 'basin' ? 'По бассейнам' : 'По плотности'}
              </button>
            ))}
          </div>
        </div>

        {colorMode === 'density' && (
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">чел/км² (нелин. шкала)</span>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-muted-foreground">0</span>
              <div className="h-2.5 w-24 rounded-full" style={{ background: `linear-gradient(to right, ${DENSITY_LOW}, ${DENSITY_HIGH})` }} />
              <span className="font-mono text-[10px] text-muted-foreground">{densityMax}</span>
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={() => resetViewRef.current?.()}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          title="Сбросить вид (Esc)"
        >
          <RotateCcw className="h-3 w-3" /> Сбросить вид
        </button>
      </div>

      <main className="relative min-h-0 flex-1">
        {status === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            <div className="flex flex-col items-center gap-2">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
              Загрузка карты…
            </div>
          </div>
        )}
        {status === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-destructive">
            <div className="flex flex-col items-center gap-3">
              <p>Не удалось загрузить карту бассейнов{errorDetail ? ` — источник: ${errorDetail}` : ''}.</p>
              <button
                type="button"
                onClick={() => setRetryTick((t) => t + 1)}
                className="rounded-md border border-destructive/40 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10"
              >
                Повторить
              </button>
            </div>
          </div>
        )}
        <svg
          ref={svgRef}
          className="h-full w-full cursor-grab active:cursor-grabbing"
          role="group"
          aria-label="Интерактивная карта бассейнов Центральной Азии — фокусируйтесь клавишей Tab, выбирайте Enter или пробелом"
        />
        <div ref={tooltipRef} className="bp-tooltip" role="status" aria-live="polite" />
        <div className="absolute bottom-3 left-3 hidden rounded-md bg-background/80 px-2 py-1 text-[10.5px] text-muted-foreground sm:block">
          HydroBASINS v1c · HydroRIVERS v1.0 · GHS-POP R2023A (JRC) · наведите, кликните или сфокусируйте Tab на бассейн
        </div>
      </main>
    </div>
  );
}
