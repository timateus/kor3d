import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

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
      existing.addEventListener('error', reject);
      return;
    }
    const s = document.createElement('script');
    s.src = D3_CDN;
    s.onload = () => resolve(window.d3);
    s.onerror = reject;
    document.head.appendChild(s);
  });
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

const dataBase = `${import.meta.env.BASE_URL}data/basins`;

export default function BasinsPage() {
  const svgRef = useRef<SVGSVGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [stats, setStats] = useState({ n: 0, pop: '—', area: '—' });
  const loadLevelRef = useRef<(key: 'main' | 'lvl3') => void>();
  const [level, setLevel] = useState<'main' | 'lvl3'>('main');

  useEffect(() => {
    let cancelled = false;
    let cleanupZoom: (() => void) | undefined;

    (async () => {
      try {
        const [d3, basinsMain, basinsLvl3, countries, rivers] = await Promise.all([
          loadD3(),
          fetch(`${dataBase}/basins_main.json`).then((r) => r.json()),
          fetch(`${dataBase}/basins_lvl3.json`).then((r) => r.json()),
          fetch(`${dataBase}/countries.json`).then((r) => r.json()),
          fetch(`${dataBase}/rivers.json`).then((r) => r.json()),
        ]);
        if (cancelled || !svgRef.current || !tooltipRef.current) return;

        const LEVELS: Record<string, { data: any; names: Record<number, string> }> = {
          main: { data: basinsMain, names: BASIN_NAMES_MAIN },
          lvl3: { data: basinsLvl3, names: BASIN_NAMES_LVL3 },
        };

        const svg = d3.select(svgRef.current);
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
        let levelKey: 'main' | 'lvl3' = 'main';
        let feats: any[] = [];

        function basinName(mainBas: number) {
          return LEVELS[levelKey].names[mainBas] || 'Малый бессточный бассейн';
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

        function renderBasins() {
          gBasins.selectAll('path')
            .data(feats)
            .join('path')
            .attr('class', 'bp-basin')
            .attr('d', path)
            .attr('fill', (_d: any, i: number) => categoryColor(i))
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
              if (pinned === this) { clearTooltip(); return; }
              pinned = this;
              showTooltip(event, this, d);
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
        cleanupZoom = () => svg.on('.zoom', null);

        function loadLevel(key: 'main' | 'lvl3') {
          levelKey = key;
          feats = LEVELS[key].data.features.filter((f: any) => f.geometry);
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

        window.addEventListener('resize', fit);
        fit();
        loadLevel('main');
        setStatus('ready');

        cleanupZoom = () => {
          window.removeEventListener('resize', fit);
          svg.on('.zoom', null);
        };
      } catch (e) {
        console.error('BasinsPage failed to load', e);
        if (!cancelled) setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      cleanupZoom?.();
    };
  }, []);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground overflow-hidden">
      <style>{`
        .bp-basin{ stroke:hsl(220 20% 8%); stroke-width:0.9; vector-effect:non-scaling-stroke; }
        .bp-basin:hover{ filter:brightness(1.1); }
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

      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-6 py-4">
        <div className="max-w-xl">
          <Link to="/" className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-3 w-3" /> назад
          </Link>
          <h1 className="text-xl font-semibold tracking-tight">Бассейны Центральной Азии</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Речные и озёрные бассейны Казахстана, Узбекистана, Туркменистана, Таджикистана и Киргизии —
            HydroBASINS (Lehner &amp; Grill, 2013), население GHS-POP R2023A. Каждый бассейн — свой цвет.
          </p>
        </div>
        <div className="flex gap-6 text-right font-mono text-sm tabular-nums">
          <div><div className="text-lg">{stats.n || '—'}</div><div className="text-[10px] uppercase tracking-wide text-muted-foreground">бассейнов</div></div>
          <div><div className="text-lg">{stats.pop}</div><div className="text-[10px] uppercase tracking-wide text-muted-foreground">население</div></div>
          <div><div className="text-lg">{stats.area}</div><div className="text-[10px] uppercase tracking-wide text-muted-foreground">км²</div></div>
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border bg-card px-6 py-2">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-wide text-muted-foreground">Уровень бассейнов</label>
          <select
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            value={level}
            onChange={(e) => {
              const v = e.target.value as 'main' | 'lvl3';
              setLevel(v);
              loadLevelRef.current?.(v);
            }}
          >
            <option value="lvl3">Крупные (9)</option>
            <option value="main">По речным системам (112)</option>
          </select>
        </div>
        <div className="text-xs text-muted-foreground">
          цвет = отдельный бассейн · население и плотность — по клику
        </div>
      </div>

      <main className="relative min-h-0 flex-1">
        {status === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            Загрузка карты…
          </div>
        )}
        {status === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-destructive">
            Не удалось загрузить карту бассейнов.
          </div>
        )}
        <svg ref={svgRef} className="h-full w-full cursor-grab active:cursor-grabbing" />
        <div ref={tooltipRef} className="bp-tooltip" />
        <div className="absolute bottom-3 left-3 rounded-md bg-background/80 px-2 py-1 text-[10.5px] text-muted-foreground">
          HydroBASINS v1c · HydroRIVERS v1.0 · GHS-POP R2023A (JRC) · наведите или кликните на бассейн
        </div>
      </main>
    </div>
  );
}
