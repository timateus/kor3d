import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

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
 * Visual direction: "Ma" (間) — ikebana's principle of charged negative
 * space. Two earlier directions (a golden-angle rainbow choropleth, then a
 * sequential-density variant) were both rejected in review as generic
 * dashboard defaults. This build foregrounds only the three basins that
 * carry most of the region's population (Сырдарья, Амударья, Иле-Балхаш) in
 * indigo ink and lets the other ~109 recede to bare ghost outlines —
 * hierarchy made of absence, not chrome. See
 * .impeccable/surfaces/src-pages-basinspage-tsx.md for the full direction
 * contract this build is accountable to.
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

const dataBase = `${import.meta.env.BASE_URL}data/basins`;

type LevelKey = 'main' | 'lvl3';

const FONT_HREF = 'https://fonts.googleapis.com/css2?family=Noto+Serif+Display:ital,wght@0,300;0,400;0,500;1,300;1,400;1,500&display=swap';
function ensureFontLink(){
  if (document.querySelector(`link[href="${FONT_HREF}"]`)) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = FONT_HREF;
  document.head.appendChild(l);
}

export default function BasinsPage() {
  useEffect(() => { ensureFontLink(); }, []);
  const svgRef = useRef<SVGSVGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [stats, setStats] = useState({ n: 0, pop: '—', area: '—' });
  const [stems, setStems] = useState<{ name: string; pop: string }[]>([]);
  const [level, setLevel] = useState<LevelKey>('main');
  const loadLevelRef = useRef<(key: LevelKey) => void>();
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
        const gCountry = g.append('g');
        const gBasins = g.append('g');
        const gRivers = g.append('g');
        const gCities = g.append('g');

        const projection = d3.geoConicEqualArea().parallels([32, 54]).rotate([-68, 0]);
        const path = d3.geoPath(projection);
        const tooltip = d3.select(tooltipRef.current);
        const fmtPop = (n: number) => d3.format(',.0f')(n).replace(/,/g, ' ');
        let pinned: any = null;
        let levelKey: LevelKey = 'main';
        let feats: any[] = [];
        let topIds: number[] = [];

        function basinName(mainBas: number) {
          return LEVELS[levelKey].names[mainBas] || 'Малый бессточный бассейн';
        }

        function rankOf(mainBas: number) {
          const i = topIds.indexOf(mainBas);
          return i; // -1 = ghost, 0 = primary, 1/2 = accent
        }

        function fillFor(mainBas: number) {
          const r = rankOf(mainBas);
          if (r === 0) return '#46557e';
          if (r > 0) return '#7386ad';
          return '#dcd4bf';
        }

        function isMobile(){ return window.innerWidth < 720; }

        function fit(){
          const rect = svg.node().getBoundingClientRect();
          if (!rect.width || !rect.height) return;
          svg.attr('viewBox', `0 0 ${rect.width} ${rect.height}`);
          const leftFrac = isMobile() ? 0.04 : 0.13;
          const rightFrac = isMobile() ? 0.04 : 0.40;
          const topPad = isMobile() ? 10 : 90;
          const bottomPad = isMobile() ? 10 : 60;
          projection.fitExtent(
            [[rect.width * leftFrac, topPad], [rect.width * (1 - rightFrac), rect.height - bottomPad]],
            countries
          );
          gBasins.selectAll('path').attr('d', path);
          gRivers.selectAll('path').attr('d', path);
          gCountry.selectAll('path').attr('d', path);
          gCities.selectAll('g.city').attr('transform', (d: any) => {
            const c = projection([d.lon, d.lat]);
            return c ? `translate(${c[0]},${c[1]})` : 'translate(-9999,-9999)';
          });
        }

        function clearTooltip(){
          pinned = null;
          tooltip.style('opacity', 0).style('transform', 'translate(-9999px,-9999px)');
          gBasins.selectAll('path.selected').classed('selected', false);
        }

        function showTooltip(event: any, el: any, d: any){
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
          if (left + 220 > rect.width) left = mx - 226;
          if (top + 96 > rect.height) top = my - 106;
          tooltip.style('transform', `translate(${left}px, ${top}px)`).style('opacity', 1);
          d3.select(el).raise();
          gBasins.selectAll('path.selected').classed('selected', false);
          d3.select(el).classed('selected', true);
        }

        function activate(event: any, el: any, d: any){
          if (pinned === el) { clearTooltip(); return; }
          pinned = el;
          showTooltip(event, el, d);
        }

        function renderBasins(){
          gBasins.selectAll('path')
            .data(feats)
            .join('path')
            .attr('class', (d: any) => 'bp-basin' + (rankOf(d.properties.main_bas) >= 0 ? ' bp-basin--ink' : ''))
            .attr('d', path)
            .attr('fill', (d: any) => fillFor(d.properties.main_bas))
            .attr('tabindex', 0)
            .attr('role', 'button')
            .attr('aria-label', (d: any) => {
              const p = d.properties;
              return `${basinName(p.main_bas)}: население ${fmtPop(p.population)}, площадь ${fmtPop(p.area_km2)} км², плотность ${p.density_km2.toFixed(2)} человек на км²`;
            })
            .on('mousemove', function (this: any, event: any, d: any){ if (!pinned) showTooltip(event, this, d); })
            .on('mouseleave', function (this: any){
              if (pinned) return;
              tooltip.style('opacity', 0).style('transform', 'translate(-9999px,-9999px)');
              d3.select(this).classed('selected', false);
            })
            .on('click', function (this: any, event: any, d: any){ event.stopPropagation(); activate(event, this, d); })
            .on('focus', function (this: any, event: any, d: any){ showTooltip(event, this, d); })
            .on('blur', function (this: any){
              if (pinned !== this){
                tooltip.style('opacity', 0).style('transform', 'translate(-9999px,-9999px)');
                d3.select(this).classed('selected', false);
              }
            })
            .on('keydown', function (this: any, event: any, d: any){
              if (event.key === 'Enter' || event.key === ' '){ event.preventDefault(); activate(event, this, d); }
            });
        }

        svg.on('click', clearTooltip);

        gCountry.selectAll('path')
          .data(countries.features)
          .join('path')
          .attr('class', 'bp-country-line');

        gRivers.selectAll('path')
          .data(rivers.features)
          .join('path')
          .attr('class', 'bp-river')
          .attr('stroke-width', (d: any) => Math.max(0.3, (d.properties.ord_stra - 4) * 0.35));

        const cityG = gCities.selectAll('g.city').data(CITIES).join('g').attr('class', 'city');
        cityG.append('circle')
          .attr('class', 'bp-city-dot')
          .attr('r', (d: any) => (d.tier === 1 ? 3.2 : d.tier === 2 ? 2.2 : 1.5));
        cityG.append('text')
          .attr('class', 'bp-city-label')
          .attr('x', (d: any) => (d.tier === 1 ? 6.5 : 4.5))
          .attr('y', 3.5)
          .attr('font-size', (d: any) => (d.tier === 1 ? 12.5 : d.tier === 2 ? 10.5 : 9))
          .text((d: any) => d.name);

        const zoom = d3.zoom().scaleExtent([1, 14]).on('zoom', (event: any) => {
          g.attr('transform', event.transform);
          gCities.selectAll('circle.bp-city-dot').attr('r', (d: any) => {
            const base = d.tier === 1 ? 3.2 : d.tier === 2 ? 2.2 : 1.5;
            return base / event.transform.k;
          });
          gCities.selectAll('text.bp-city-label')
            .attr('font-size', (d: any) => {
              const base = d.tier === 1 ? 12.5 : d.tier === 2 ? 10.5 : 9;
              return base / event.transform.k;
            })
            .attr('x', (d: any) => (d.tier === 1 ? 6.5 : 4.5) / event.transform.k);
          gCities.selectAll('.bp-city-label').attr('stroke-width', 2.5 / event.transform.k);
        });
        svg.call(zoom);

        function resetView(){
          svg.transition().duration(400).call(zoom.transform, d3.zoomIdentity);
        }
        resetViewRef.current = resetView;

        function loadLevel(key: LevelKey){
          levelKey = key;
          feats = LEVELS[key].data.features.filter((f: any) => f.geometry);
          const ranked = [...feats].sort((a, b) => b.properties.population - a.properties.population);
          topIds = ranked.slice(0, 3).map((f: any) => f.properties.main_bas);

          const totalPop = d3.sum(feats, (f: any) => f.properties.population);
          const totalArea = d3.sum(feats, (f: any) => f.properties.area_km2);
          setStats({
            n: feats.length,
            pop: d3.format(',.2s')(totalPop).replace('G', 'млрд').replace('M', 'млн').replace('k', 'тыс').replace(/,/g, ' '),
            area: d3.format(',.2s')(totalArea).replace('M', 'млн').replace('k', 'тыс').replace(/,/g, ' '),
          });
          setStems(
            ranked.slice(0, 3).map((f: any) => ({
              name: basinName(f.properties.main_bas),
              pop: (f.properties.population / 1e6).toFixed(1) + ' млн',
            }))
          );

          clearTooltip();
          renderBasins();
        }
        loadLevelRef.current = loadLevel;

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

  useEffect(() => {
    function onKey(e: KeyboardEvent){ if (e.key === 'Escape') resetViewRef.current?.(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="relative min-h-screen w-screen overflow-x-hidden bp-root sm:h-screen sm:overflow-hidden">
      <style>{`
        .bp-root{ background:#eae4d6; font-family:'Noto Serif Display', serif; }
        .bp-basin{ stroke:#b3a98f; stroke-width:0.55; vector-effect:non-scaling-stroke; cursor:pointer; fill-opacity:1; transition:filter 0.15s; }
        .bp-basin--ink{ stroke:#2e3a5c; stroke-width:0.9; }
        .bp-basin:hover{ filter:brightness(1.08) saturate(1.1); }
        .bp-basin:focus-visible{ outline:none; stroke:#46557e; stroke-width:2.2; }
        .bp-basin.selected{ stroke:#2e2418; stroke-width:2; }
        .bp-river{ fill:none; stroke:#9a927a; stroke-width:0.6; opacity:0.5; pointer-events:none; }
        .bp-country-line{ fill:none; stroke:#726b52; stroke-width:0.9; stroke-dasharray:0.5 3; stroke-linecap:round; opacity:0.45; pointer-events:none; vector-effect:non-scaling-stroke; }
        .bp-city-dot{ fill:#2e2418; stroke:#eae4d6; stroke-width:0.9px; vector-effect:non-scaling-stroke; pointer-events:none; }
        .bp-city-label{ font-family:'Noto Serif Display', serif; font-style:italic; font-weight:400; fill:#2e2418; paint-order:stroke; stroke:#eae4d6; stroke-width:2.5px; pointer-events:none; }
        .bp-tooltip{ position:absolute; top:0; left:0; pointer-events:none; background:#f2ecdd; border:1px solid #b3a98f; padding:9px 11px; font-size:12px; max-width:220px; opacity:0; transform:translate(-9999px,-9999px); z-index:10; font-family:'JetBrains Mono', monospace; box-shadow:0 6px 18px rgba(46,36,24,0.18); }
        .bp-name{ font-family:'Noto Serif Display', serif; font-style:italic; font-weight:500; font-size:14.5px; margin-bottom:5px; color:#2e2418; }
        .bp-row{ display:flex; justify-content:space-between; gap:12px; padding:1.5px 0; color:#8a8368; }
        .bp-row b{ color:#2e2418; font-variant-numeric:tabular-nums; font-weight:500; }

        .bp-vtitle{ writing-mode:vertical-rl; font-style:italic; font-weight:300; letter-spacing:0.08em; color:#3a3626; }
        .bp-vsub{ writing-mode:vertical-rl; font-family:'JetBrains Mono', monospace; letter-spacing:0.06em; color:#8a8368; }
        .bp-stem-bar{ width:20px; height:2px; background:#46557e; flex:none; }
        .bp-stem-bar--ghost{ width:11px; background:#b3a98f; }
        .bp-select{ appearance:none; background:transparent; border:none; border-bottom:1px solid #8a8368; color:#3a3626; font-family:'JetBrains Mono', monospace; font-size:11px; padding:2px 16px 3px 0; cursor:pointer; }

        @media (max-width: 720px){
          .bp-vtitle{ writing-mode:horizontal-tb; font-size:18px !important; }
          .bp-vsub{ writing-mode:horizontal-tb; font-size:9px !important; }
        }
      `}</style>

      {/* left margin: title + back link */}
      <div className="absolute left-3 top-4 z-10 flex items-start gap-2 sm:left-12 sm:top-14 sm:gap-3">
        <Link to="/" className="mt-0.5 font-mono text-[10px] text-[#8a8368] hover:text-[#3a3626] sm:mt-1" style={{ writingMode: 'inherit' }}>
          ←
        </Link>
        <div className="flex items-baseline gap-2 sm:flex-col sm:items-start sm:gap-3">
          <h1 className="bp-vtitle text-[18px] sm:text-[21px]">центральная азия</h1>
          <p className="bp-vsub text-[9px]">HYDROBASINS · GHS-POP</p>
        </div>
      </div>

      {/* right margin: stem list + controls, quiet, no cards */}
      <div className="absolute right-4 top-14 z-10 hidden w-[210px] flex-col gap-5 sm:flex sm:right-10">
        <div className="flex flex-col gap-4">
          {stems.map((s, i) => (
            <div key={s.name} className="flex items-baseline gap-2.5">
              <span className={'bp-stem-bar' + (i === 0 ? '' : '')} />
              <span className="font-serif text-[15px] italic text-[#3a3626]">{s.name}</span>
              <span className="ml-auto font-mono text-[10px] text-[#8a8368]">{s.pop}</span>
            </div>
          ))}
          <div className="flex items-baseline gap-2.5">
            <span className="bp-stem-bar bp-stem-bar--ghost" />
            <span className="font-mono text-[11px] text-[#8a8368]">+{Math.max(0, stats.n - 3)} малых</span>
          </div>
        </div>

        <div className="mt-2 flex flex-col gap-1 border-t border-[#c9c0a4] pt-3 font-mono text-[10px] text-[#8a8368]">
          <span>{stats.pop} чел. · {stats.area} км²</span>
        </div>

        <div className="mt-2 flex flex-col gap-1.5">
          <label htmlFor="basins-level" className="font-mono text-[9px] uppercase tracking-wide text-[#8a8368]">уровень</label>
          <select
            id="basins-level"
            className="bp-select"
            value={level}
            onChange={(e) => { const v = e.target.value as LevelKey; setLevel(v); loadLevelRef.current?.(v); }}
          >
            <option value="lvl3">крупные (9)</option>
            <option value="main">по речным системам (112)</option>
          </select>
        </div>

        <button
          type="button"
          onClick={() => resetViewRef.current?.()}
          className="mt-1 w-fit font-mono text-[10px] text-[#8a8368] underline decoration-dotted hover:text-[#3a3626]"
          title="Сбросить вид (Esc)"
        >
          сбросить вид
        </button>
      </div>

      {/* mobile controls (title's vertical treatment drops on narrow screens, so
          the level/reset controls get their own compact row instead of the
          quiet right-margin column, which has no room there) */}
      <div className="absolute left-3 top-16 z-10 flex items-center gap-3 sm:hidden">
        <select
          className="bp-select text-[11px]"
          value={level}
          onChange={(e) => { const v = e.target.value as LevelKey; setLevel(v); loadLevelRef.current?.(v); }}
        >
          <option value="lvl3">крупные (9)</option>
          <option value="main">по речным системам (112)</option>
        </select>
        <button
          type="button"
          onClick={() => resetViewRef.current?.()}
          className="font-mono text-[10px] text-[#8a8368] underline decoration-dotted"
        >
          сбросить
        </button>
      </div>

      <div className="absolute left-3 top-[104px] z-10 flex flex-wrap items-baseline gap-x-4 gap-y-1 pr-6 sm:hidden">
        {stems.map((s) => (
          <span key={s.name} className="flex items-baseline gap-1.5">
            <span className="font-serif text-[13px] italic text-[#3a3626]">{s.name}</span>
            <span className="font-mono text-[9px] text-[#8a8368]">{s.pop}</span>
          </span>
        ))}
        <span className="font-mono text-[9px] text-[#8a8368]">+{Math.max(0, stats.n - 3)} малых · {stats.pop} чел.</span>
      </div>

      <main className="relative mt-40 aspect-[1.45/1] w-full sm:mt-0 sm:aspect-auto sm:absolute sm:inset-0 sm:h-full">
        {status === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center font-mono text-xs text-[#8a8368]">
            <div className="flex flex-col items-center gap-2">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-[#c9c0a4] border-t-[#46557e]" />
              загрузка…
            </div>
          </div>
        )}
        {status === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center font-mono text-xs text-[#7a3b2e]">
            <div className="flex flex-col items-center gap-3">
              <p>не удалось загрузить карту{errorDetail ? ` — источник: ${errorDetail}` : ''}.</p>
              <button
                type="button"
                onClick={() => setRetryTick((t) => t + 1)}
                className="border border-[#7a3b2e]/40 px-3 py-1.5 text-[11px] hover:bg-[#7a3b2e]/10"
              >
                повторить
              </button>
            </div>
          </div>
        )}
        <svg
          ref={svgRef}
          className="h-full w-full cursor-grab active:cursor-grabbing"
          role="group"
          aria-label="Карта бассейнов Центральной Азии — фокусируйтесь клавишей Tab, выбирайте Enter или пробелом"
        />
        <div ref={tooltipRef} className="bp-tooltip" role="status" aria-live="polite" />
        <div className="absolute bottom-3 left-3 hidden max-w-[220px] font-mono text-[9.5px] leading-relaxed text-[#8a8368] sm:left-12 sm:bottom-8 sm:block">
          HydroBASINS v1c · HydroRIVERS v1.0 · GHS-POP R2023A (JRC) — наведите, кликните или Tab+Enter
        </div>
      </main>
      <div className="mt-3 px-3 pb-6 font-mono text-[9.5px] leading-relaxed text-[#8a8368] sm:hidden">
        HydroBASINS v1c · HydroRIVERS v1.0 · GHS-POP R2023A (JRC) — наведите или кликните на бассейн
      </div>
    </div>
  );
}
