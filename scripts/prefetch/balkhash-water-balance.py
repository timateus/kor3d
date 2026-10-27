#!/usr/bin/env python3
"""Monthly water-balance ("bucket") model of Lake Balkhash: hindcast and scenarios.

    dV = Q_in + (P − k_E·ET0)·A(h) − G          (km³ per month)

Standard library only. Climate comes from ERA5 via the Open-Meteo archive API
(no key), averaged over points on the lake. Everything else is taken from
published tables, cited in SOURCES below; nothing is fitted except k_E, the
open-water / FAO-56 reference-evaporation ratio, which is calibrated against
observed annual levels. ERA5 precipitation over the lake is ~35% below the
corrected gauge totals in Alimkulov et al., so it is scaled to match those
volumes (k_P) before k_E is fitted.

River inflow is prescribed as period means of gauged inflow (Alimkulov et al.
2025, Table 3) because modelled discharge is unusable here: GloFAS v4 gives
~35 km³/yr for the lower Ili against ~11 km³/yr gauged (no irrigation losses).
The model therefore reproduces decadal swings, not individual wet/dry years.
See research/papers/ for the paper.
"""
import argparse
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

SOURCES = {
    'hypsometry': 'Tursunov, Madibekov & Kulebaev, "Present morphometrical parameters of Balkhash lake", '
                  'Uchenye Zapiski RSHU 34 (2014), Table 1 — bathymetric survey 2011–2013',
    'levels': 'Ivkina, "Water level variations on the Balkash Lake in the modern period", '
              'Hydrometeorology and Ecology 3 (2022), doi:10.54668/2789-6323-2022-106-3-6-13',
    'balance': 'Alimkulov et al., "Long-Term Water Level Projections for Lake Balkhash Using Scenario-Based '
               'Water Balance Modeling", Water 17 (2025) 2021, doi:10.3390/w17132021, Tables 3–5',
    'climate': 'ERA5 reanalysis via Open-Meteo historical weather API (precipitation_sum, et0_fao_evapotranspiration)',
}

# Level (m, Baltic System) → water-surface area (km²), from the 2011–2013 survey.
# The survey's own volume column (113, 93.3, 78.1, 52, 32.2 km³) is not consistent
# with integrating its areas, so area is treated as primary and volume is
# integrated from it, anchored at V(342.5 m) = 113 km³.
HYPSOMETRY = [(335.2, 6265), (337.2, 9863), (339.3, 13085), (341.3, 17391), (342.5, 19225)]
V_ANCHOR = (342.5, 113.0)

# Observed annual mean levels (m BS). 1961/1987/2005 from Ivkina's text, 2010–2021 from her Table 2.
OBSERVED = {1961: 342.99, 1987: 340.66, 2005: 342.60,
            2010: 342.39, 2011: 342.76, 2012: 342.73, 2013: 342.57, 2014: 342.37, 2015: 342.16,
            2016: 342.27, 2017: 342.68, 2018: 342.73, 2019: 342.69, 2020: 342.52, 2021: 342.18}

# Gauged surface inflow, km³/yr, by period (Alimkulov et al. Table 3). Kapshagay filling began Dec 1969.
INFLOW_PERIODS = [(1947, 1969, 16.0), (1970, 1987, 12.2), (1988, 2100, 14.7)]
GROUNDWATER_LOSS = 0.384  # km³/yr net outflow (same table)

# Scenario anchors from Alimkulov et al. Tables 4–5: (year, inflow km³/yr, precip km³/yr, evap km³/yr).
# Their precipitation and evaporation are volumes over their own lake area, so the model uses only
# their ratios to the 1988–2021 baseline (3.53 and 17.1 km³/yr) as multipliers on ERA5 rates.
BASE_P, BASE_E = 3.53, 17.1
SCENARIOS = {
    'ssp245-q50': [(2030, 12.1, 3.73, 20.7), (2040, 11.3, 3.68, 20.9), (2050, 10.5, 3.73, 21.1)],
    'ssp245-q75': [(2030, 9.32, 3.64, 20.4), (2040, 8.49, 3.57, 20.7), (2050, 7.64, 3.61, 20.9)],
    'ssp585-q50': [(2030, 12.2, 3.59, 21.0), (2040, 11.4, 3.73, 21.4), (2050, 10.2, 3.75, 21.6)],
    'ssp585-q75': [(2030, 9.45, 3.50, 20.7), (2040, 8.59, 3.61, 21.1), (2050, 7.37, 3.61, 21.4)],
}

# ERA5 sample points on open water, west → east.
LAKE_POINTS = [(46.30, 74.50), (46.60, 75.20), (46.45, 76.00), (46.55, 77.30), (46.80, 78.30)]
ERA5_START, ERA5_END = 1950, 2024
HINDCAST_START = 1962  # start from the 1961 high stand (342.99 m)


# --- hypsometry ---------------------------------------------------------------

def _integrated_volumes():
    vols = [0.0]
    for (h0, a0), (h1, a1) in zip(HYPSOMETRY, HYPSOMETRY[1:]):
        vols.append(vols[-1] + (a0 + a1) / 2 * (h1 - h0) * 1e-3)  # km² · m → km³
    shift = V_ANCHOR[1] - vols[[h for h, _ in HYPSOMETRY].index(V_ANCHOR[0])]
    return [v + shift for v in vols]


VOLUMES = _integrated_volumes()


def _segment(h):
    """Index of the hypsometry segment containing h; linear extrapolation outside the survey."""
    for i in range(len(HYPSOMETRY) - 1):
        if h <= HYPSOMETRY[i + 1][0]:
            return i
    return len(HYPSOMETRY) - 2


def area(h):
    i = _segment(h)
    (h0, a0), (h1, a1) = HYPSOMETRY[i], HYPSOMETRY[i + 1]
    return a0 + (a1 - a0) * (h - h0) / (h1 - h0)


def volume(h):
    i = _segment(h)
    h0, a0 = HYPSOMETRY[i]
    return VOLUMES[i] + (a0 + area(h)) / 2 * (h - h0) * 1e-3


def level(v):
    """Invert volume(h) by bisection."""
    lo, hi = 330.0, 346.0
    for _ in range(60):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if volume(mid) < v else (lo, mid)
    return (lo + hi) / 2


def level_for_area(a):
    lo, hi = 330.0, 346.0
    for _ in range(60):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if area(mid) < a else (lo, mid)
    return (lo + hi) / 2


# --- climate ------------------------------------------------------------------

def fetch_era5(cache):
    """Monthly lake-mean precipitation and ET0 (mm), keyed by (year, month)."""
    if cache.exists():
        raw = json.loads(cache.read_text())
    else:
        url = ('https://archive-api.open-meteo.com/v1/archive'
               f'?latitude={",".join(str(p[0]) for p in LAKE_POINTS)}'
               f'&longitude={",".join(str(p[1]) for p in LAKE_POINTS)}'
               f'&start_date={ERA5_START}-01-01&end_date={ERA5_END}-12-31'
               '&daily=precipitation_sum,et0_fao_evapotranspiration&models=era5&timezone=GMT')
        for attempt in range(6):
            try:
                with urllib.request.urlopen(url, timeout=300) as r:
                    raw = json.load(r)
                break
            except urllib.error.HTTPError as e:
                if e.code != 429 or attempt == 5:
                    raise
                print('Open-Meteo rate limit; retrying in 60 s', flush=True)
                time.sleep(60)
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(raw))
    sums = {}
    for site in raw:
        d = site['daily']
        for t, p, e in zip(d['time'], d['precipitation_sum'], d['et0_fao_evapotranspiration']):
            if p is None or e is None:
                continue
            s = sums.setdefault((int(t[:4]), int(t[5:7])), [0.0, 0.0])
            s[0] += p / len(raw)
            s[1] += e / len(raw)
    return {k: tuple(v) for k, v in sums.items()}


def climatology(climate, y0, y1):
    out = {}
    for m in range(1, 13):
        rows = [climate[(y, m)] for y in range(y0, y1 + 1)]
        out[m] = (sum(r[0] for r in rows) / len(rows), sum(r[1] for r in rows) / len(rows))
    return out


# --- model --------------------------------------------------------------------

def inflow_for(year):
    return next(q for y0, y1, q in INFLOW_PERIODS if y0 <= year <= y1)


def run(h0, years, k_e, forcing, k_p=1.0):
    """forcing(year, month) → (inflow km³/yr, precip mm, et0 mm). Returns annual rows."""
    v = volume(h0)
    rows = []
    for year in years:
        hs, fluxes = [], [0.0, 0.0, 0.0]
        for month in range(1, 13):
            q, p, et0 = forcing(year, month)
            a = area(level(v))
            pv, ev = k_p * p * a * 1e-6, k_e * et0 * a * 1e-6
            v += q / 12 + pv - ev - GROUNDWATER_LOSS / 12
            hs.append(level(v))
            fluxes[0] += q / 12
            fluxes[1] += pv
            fluxes[2] += ev
        h = sum(hs) / 12
        rows.append({'year': year, 'level': round(h, 3), 'area': round(area(h)), 'volume': round(volume(h), 2),
                     'inflow': round(fluxes[0], 2), 'precip': round(fluxes[1], 2), 'evap': round(fluxes[2], 2)})
    return rows


def hindcast(climate, k_e, k_p, last=ERA5_END):
    def forcing(y, m):
        p, e = climate[(y, m)]
        return inflow_for(y), p, e
    return run(OBSERVED[1961], range(HINDCAST_START, last + 1), k_e, forcing, k_p)


# Lake precipitation, km³/yr, by period (Alimkulov et al. Table 3).
PAPER_PRECIP = {(1962, 1969): 3.43, (1970, 1987): 3.21, (1988, 2021): 3.53}
PAPER_EVAP = {(1962, 1969): 17.8, (1970, 1987): 17.4, (1988, 2021): 17.1}


def calibrate(climate):
    """Fixed point: k_P matches the paper's precipitation volumes, then k_E minimises level RMSE."""
    k_p = 1.0
    for _ in range(4):
        err, k_e = min((rmse(hindcast(climate, k / 100, k_p)), k / 100) for k in range(50, 161))
        rows = hindcast(climate, k_e, k_p)
        paper = sum(v * (y1 - y0 + 1) for (y0, y1), v in PAPER_PRECIP.items())
        model = sum(r['precip'] for r in rows if 1962 <= r['year'] <= 2021)
        k_p *= paper / model
    return k_e, k_p, err


def rmse(rows):
    errs = [(r['level'] - OBSERVED[r['year']]) ** 2 for r in rows if r['year'] in OBSERVED]
    return (sum(errs) / len(errs)) ** 0.5


def interp(anchors, year):
    if year <= anchors[0][0]:
        return anchors[0][1:]
    for a, b in zip(anchors, anchors[1:]):
        if year <= b[0]:
            f = (year - a[0]) / (b[0] - a[0])
            return tuple(x + (y - x) * f for x, y in zip(a[1:], b[1:]))
    return anchors[-1][1:]


def equilibrium(q, p_mm, e_mm):
    """Area where net evaporation balances inflow; level read off the hypsometry."""
    a = (q - GROUNDWATER_LOSS) / ((e_mm - p_mm) * 1e-6)
    return {'area': round(a), 'level': round(level_for_area(a), 2), 'volume': round(volume(level_for_area(a)), 1),
            'extrapolated': not HYPSOMETRY[0][1] <= a <= HYPSOMETRY[-1][1]}


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--work-dir', type=Path, default=Path('.cache/balkhash'), help='ERA5 download cache')
    p.add_argument('--output', type=Path, default=Path('public/data/locations/balqash-lake/water_balance.json'))
    p.add_argument('--until', type=int, default=2100, help='Last scenario year')
    args = p.parse_args()

    climate = fetch_era5(args.work_dir / f'era5_lake_{ERA5_START}_{ERA5_END}.json')

    k_e, k_p, err = calibrate(climate)
    rows = hindcast(climate, k_e, k_p)
    print(f'k_P = {k_p:.2f} (precipitation bias correction), '
          f'k_E = {k_e:.2f} (open-water evaporation / ERA5 ET0), level RMSE = {err:.2f} m '
          f'over {sum(r["year"] in OBSERVED for r in rows)} observed years')

    print('\nHindcast vs observed (m BS):')
    for r in rows:
        if r['year'] in OBSERVED:
            print(f"  {r['year']}  model {r['level']:.2f}  obs {OBSERVED[r['year']]:.2f}  "
                  f"Δ {r['level'] - OBSERVED[r['year']]:+.2f}")

    print('\nPeriod means, model vs Alimkulov et al. Table 3 (km³/yr):')
    for (y0, y1), pp in PAPER_PRECIP.items():
        pe = PAPER_EVAP[(y0, y1)]
        sel = [r for r in rows if y0 <= r['year'] <= y1]
        mp = sum(r['precip'] for r in sel) / len(sel)
        me = sum(r['evap'] for r in sel) / len(sel)
        print(f'  {y0}–{y1}: precip {mp:5.2f} (paper {pp})  evap {me:5.2f} (paper {pe})')

    base = climatology(climate, 1991, 2020)
    p_ann = k_p * sum(v[0] for v in base.values())
    e_ann = k_e * sum(v[1] for v in base.values())
    print(f'\nERA5 1991–2020 over the lake: precip {p_ann:.0f} mm/yr, open-water evaporation {e_ann:.0f} mm/yr')

    start_year, start_level = rows[-1]['year'], rows[-1]['level']
    out_scen = {}
    flat = [(start_year, inflow_for(start_year), BASE_P, BASE_E)]
    scen_defs = {'current': flat} | {k: flat + v for k, v in SCENARIOS.items()}
    print(f'\nScenarios from the modelled {start_year} level ({start_level:.2f} m):')
    for name, anchors in scen_defs.items():
        def forcing(y, m, anchors=anchors):
            q, pv, ev = interp(anchors, y)
            return q, base[m][0] * pv / BASE_P, base[m][1] * ev / BASE_E
        srows = run(start_level, range(start_year + 1, args.until + 1), k_e, forcing, k_p)
        q, pv, ev = anchors[-1][1:]
        eq = equilibrium(q, p_ann * pv / BASE_P, e_ann * ev / BASE_E)
        out_scen[name] = {'anchors': anchors, 'rows': srows, 'equilibrium': eq}
        at = {r['year']: r['level'] for r in srows}
        print(f"  {name:11s} 2030 {at.get(2030, float('nan')):.2f}  2050 {at.get(2050, float('nan')):.2f}  "
              f"{args.until} {srows[-1]['level']:.2f}  → equilibrium {eq['level']:.2f} m, {eq['area']} km², "
              f"{eq['volume']} km³{' (extrapolated below survey)' if eq['extrapolated'] else ''}")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({
        'title': 'Lake Balkhash water balance',
        'model': 'Monthly bucket model: dV = Q_in + (P − k_E·ET0)·A(h) − G',
        'sources': SOURCES,
        'calibration': {'k_E': k_e, 'k_P': round(k_p, 3), 'rmse_m': round(err, 3), 'observed': OBSERVED},
        'hypsometry': [{'level': h, 'area': a, 'volume': round(v, 2)} for (h, a), v in zip(HYPSOMETRY, VOLUMES)],
        'inflow_periods': INFLOW_PERIODS,
        'groundwater_loss': GROUNDWATER_LOSS,
        'hindcast': rows,
        'scenarios': out_scen,
    }, indent=1))
    print(f'\nWrote {args.output}')


if __name__ == '__main__':
    main()
