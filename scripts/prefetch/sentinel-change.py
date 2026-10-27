"""Prepare annual summer Sentinel-2 / Sentinel-1 composites for a kor3d location.

For each year, every cloud-, shadow- and snow-free Sentinel-2 L2A observation
in the season window is reduced to a per-pixel median. The script writes a
true-colour PNG and NDVI / bare-soil-index grids. Sentinel-1 radiometrically
terrain-corrected (RTC) VV/VH backscatter from one relative orbit is reduced
the same way. Source data are read from Microsoft Planetary Computer COGs
with anonymous SAS tokens. The grid matches satellite-embeddings.py: about
10 m spacing, capped at 512 pixels per edge.

Requires numpy, rasterio. See README.md. Already written years are skipped
unless --force is given, so an interrupted run can be resumed.
"""
import argparse
import json
import math
import threading
import time
import urllib.request
import warnings
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.vrt import WarpedVRT

ROOT = Path(__file__).resolve().parents[2]
STAC = 'https://planetarycomputer.microsoft.com/api/stac/v1/search'
TOKEN = 'https://planetarycomputer.microsoft.com/api/sas/v1/token/{}'
S2_BANDS = ['B02', 'B03', 'B04', 'B08', 'B11']
# Scene classification classes kept: vegetation, not vegetated, water.
# Dark-area pixels (2) are mostly topographic shadow on north slopes.
SCL_VALID = (4, 5, 6)
GDAL_ENV = dict(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif,.tiff',
                GDAL_HTTP_MAX_RETRY='5', GDAL_HTTP_RETRY_DELAY='3', GDAL_HTTP_TIMEOUT='120', VSI_CACHE='TRUE')
# uint8 encodings; 0 is no data. Decoded in src/lib/sentinel-change.ts.
SCALES = {'ndvi': (-1.0, 1.0), 'bsi': (-1.0, 1.0), 'vh': (-35.0, 0.0), 'vv': (-30.0, 5.0)}


def http_json(url, body=None):
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, data=json.dumps(body).encode() if body else None,
                                         headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except OSError as error:
            if attempt == 4:
                raise
            print(f'  retrying after {error}', flush=True)
            time.sleep(5 * (attempt + 1))


def search(collection, bbox, start, end, query=None):
    body = dict(collections=[collection], bbox=bbox, datetime=f'{start}/{end}', limit=500)
    if query:
        body['query'] = query
    return http_json(STAC, body)['features']


_tokens = {}
_token_lock = threading.Lock()


def signed(collection, href):
    # Worker threads share one token per collection; the token endpoint is rate limited.
    with _token_lock:
        token, expiry = _tokens.get(collection, (None, 0))
        if time.time() > expiry - 600:
            data = http_json(TOKEN.format(collection))
            expiry = datetime.fromisoformat(data['msft:expiry'].replace('Z', '+00:00')).timestamp()
            token = data['token']
            _tokens[collection] = (token, expiry)
    return f'{href}?{token}'


def read_band(url, grid, resampling):
    with rasterio.Env(**GDAL_ENV), rasterio.open(url) as src:
        with WarpedVRT(src, crs='EPSG:4326', transform=grid['transform'], width=grid['width'],
                       height=grid['height'], resampling=resampling, src_nodata=src.nodata or 0, nodata=0) as vrt:
            return vrt.read(1).astype(np.float32)


def s2_scene(items, grid):
    """Masked surface reflectance for one acquisition date (possibly several tiles)."""
    out = np.full((len(S2_BANDS), grid['height'], grid['width']), np.nan, np.float32)
    for item in items:
        scl = read_band(signed('sentinel-2-l2a', item['assets']['SCL']['href']), grid, Resampling.nearest)
        valid = np.isin(scl, SCL_VALID) & np.isnan(out[0])
        if not valid.any():
            continue
        # Processing baseline 04.00 (from January 2022) adds a +1000 DN offset.
        baseline = float(item['properties'].get('s2:processing_baseline', '0') or 0)
        offset = -1000 if baseline >= 4 else 0
        for b, band in enumerate(S2_BANDS):
            dn = read_band(signed('sentinel-2-l2a', item['assets'][band]['href']), grid, Resampling.bilinear)
            out[b][valid] = (dn[valid] + offset) / 10000
    return out


def s1_scene(item, grid):
    out = []
    for pol in ('vv', 'vh'):
        v = read_band(signed('sentinel-1-rtc', item['assets'][pol]['href']), grid, Resampling.bilinear)
        v[v <= 0] = np.nan
        out.append(v)
    return np.stack(out)


def median_stack(scenes, workers):
    with ThreadPoolExecutor(workers) as pool:
        stack = np.stack(list(pool.map(lambda f: f(), scenes)))
    count = np.sum(~np.isnan(stack[:, 0]), axis=0)
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', RuntimeWarning)  # all-NaN pixels stay NaN
        return np.nanmedian(stack, axis=0), count


def encode(values, key):
    lo, hi = SCALES[key]
    q = np.clip(np.round((values - lo) / (hi - lo) * 254) + 1, 1, 255)
    return np.where(np.isfinite(values), q, 0).astype(np.uint8)


def write_truecolor(path, rgb, grid):
    alpha = np.isfinite(rgb).all(axis=0)
    with np.errstate(invalid='ignore'):
        scaled = np.clip(rgb / 0.3, 0, 1) ** (1 / 1.8) * 255
    data = np.where(alpha, np.nan_to_num(scaled), 0).astype(np.uint8)
    with rasterio.open(path, 'w', driver='PNG', width=grid['width'], height=grid['height'], count=4, dtype='uint8') as dst:
        dst.write(data, [1, 2, 3])
        dst.write((alpha * 255).astype(np.uint8), 4)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--slug', default='kok-zhailau')
    parser.add_argument('--bounds', nargs=4, type=float, metavar=('WEST', 'SOUTH', 'EAST', 'NORTH'),
                        default=[76.943, 43.075, 77.130, 43.175])
    parser.add_argument('--years', nargs='+', type=int, default=list(range(2017, 2026)))
    parser.add_argument('--season', nargs=2, default=['07-01', '09-30'], metavar=('START', 'END'),
                        help='Month-day window; the default avoids most snow at 2000–3000 m')
    parser.add_argument('--max-cloud', type=float, default=70)
    # Larger than the 512 px embedding cap: these grids are ~1 MB per year per
    # 512² and keep ~15 m spacing over the 15.2 km wide Kok-Zhailau scene.
    parser.add_argument('--max-size', type=int, default=1024)
    parser.add_argument('--workers', type=int, default=6)
    parser.add_argument('--force', action='store_true')
    args = parser.parse_args()
    west, south, east, north = args.bounds
    width = math.ceil((east - west) * 111320 * math.cos(math.radians((north + south) / 2)) / 10)
    height = math.ceil((north - south) * 111320 / 10)
    scale = min(1, args.max_size / max(width, height))
    width, height = max(1, math.ceil(width * scale)), max(1, math.ceil(height * scale))
    grid = dict(width=width, height=height, transform=from_bounds(west, south, east, north, width, height))
    out_dir = ROOT / 'public/data/locations' / args.slug / 'sentinel'
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / 'manifest.json'
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    if manifest and (manifest.get('width'), manifest.get('height')) != (width, height):
        raise RuntimeError('Existing manifest uses a different grid; pass --force after removing it')
    bbox = [west, south, east, north]

    # One relative orbit for every year keeps the radar viewing geometry
    # (and therefore layover/shadow on steep slopes) comparable.
    s1_items = {}
    orbits = Counter()
    for year in args.years:
        items = search('sentinel-1-rtc', bbox, f'{year}-{args.season[0]}', f'{year}-{args.season[1]}')
        s1_items[year] = items
        orbits.update((i['properties'].get('sat:relative_orbit'), i['properties'].get('sat:orbit_state')) for i in items)
    orbit_years = {o: sum(any((i['properties'].get('sat:relative_orbit'), i['properties'].get('sat:orbit_state')) == o
                              for i in s1_items[y]) for y in args.years) for o in orbits}
    orbit = max(orbits, key=lambda o: (orbit_years[o], orbits[o]))
    print(f'Sentinel-1 orbit {orbit[0]} ({orbit[1]}): present in {orbit_years[orbit]}/{len(args.years)} years', flush=True)

    years = {y['year']: y for y in manifest.get('years', [])}
    for year in args.years:
        year_dir = out_dir / str(year)
        if not args.force and year in years and (year_dir / 'indices.bin').exists():
            print(f'{year}: already prepared, skipping', flush=True)
            continue
        year_dir.mkdir(exist_ok=True)
        start, end = f'{year}-{args.season[0]}', f'{year}-{args.season[1]}'
        s2 = search('sentinel-2-l2a', bbox, start, end, {'eo:cloud_cover': {'lt': args.max_cloud}})
        by_date = defaultdict(list)
        for item in s2:
            by_date[item['properties']['datetime'][:10]].append(item)
        print(f'{year}: {len(s2)} Sentinel-2 items on {len(by_date)} dates', flush=True)
        refl, s2_count = median_stack([lambda items=items: s2_scene(items, grid) for items in by_date.values()], args.workers)
        b02, b03, b04, b08, b11 = refl
        with np.errstate(all='ignore'):
            ndvi = (b08 - b04) / (b08 + b04)
            bsi = ((b11 + b04) - (b08 + b02)) / ((b11 + b04) + (b08 + b02))
        s1 = [i for i in s1_items[year] if (i['properties'].get('sat:relative_orbit'), i['properties'].get('sat:orbit_state')) == orbit]
        print(f'{year}: {len(s1)} Sentinel-1 scenes', flush=True)
        if s1:
            radar, s1_count = median_stack([lambda item=item: s1_scene(item, grid) for item in s1], args.workers)
            with np.errstate(divide='ignore', invalid='ignore'):
                vv, vh = 10 * np.log10(radar[0]), 10 * np.log10(radar[1])
        else:
            vv = vh = np.full((height, width), np.nan, np.float32)
            s1_count = np.zeros((height, width), int)
        indices = np.stack([encode(ndvi, 'ndvi'), encode(bsi, 'bsi'), encode(vh, 'vh'), encode(vv, 'vv')], axis=-1)
        (year_dir / 'indices.bin').write_bytes(indices.tobytes())
        write_truecolor(year_dir / 'truecolor.png', np.stack([b04, b03, b02]), grid)
        years[year] = dict(year=year, s2Dates=len(by_date), s1Scenes=len(s1),
                           s2MedianObservations=int(np.median(s2_count)), s1MedianObservations=int(np.median(s1_count)),
                           s2ValidFraction=round(float(np.isfinite(ndvi).mean()), 4),
                           s2Sources=sorted(i['id'] for i in s2), s1Sources=sorted(i['id'] for i in s1))
        manifest = dict(version=1, slug=args.slug, width=width, height=height,
                        bounds=dict(minLon=west, minLat=south, maxLon=east, maxLat=north), crs='EPSG:4326',
                        season=dict(start=args.season[0], end=args.season[1]),
                        bands=['ndvi', 'bsi', 'vh', 'vv'], encoding='uint8, 0 = no data, value = lo + (q - 1) / 254 * (hi - lo)',
                        scales={k: list(v) for k, v in SCALES.items()},
                        s1Orbit=dict(relative=orbit[0], state=orbit[1]),
                        sclValid=list(SCL_VALID), maxCloud=args.max_cloud,
                        years=[years[y] for y in sorted(years)],
                        generated=datetime.now(timezone.utc).isoformat(timespec='seconds'),
                        attribution='Contains modified Copernicus Sentinel data, processed via Microsoft Planetary Computer.')
        manifest_path.write_text(json.dumps(manifest, indent=1))
        print(f'{year}: wrote {year_dir.relative_to(ROOT)} · S2 valid {years[year]["s2ValidFraction"]:.1%}', flush=True)


if __name__ == '__main__':
    main()
