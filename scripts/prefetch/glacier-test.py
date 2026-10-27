"""Bake published Tuyuksu data for /glacier-test (no runtime scientific dependencies).

Usage: python glacier-test.py --velocity source.nc --outlines glims.geojson
    --tiles tile-directory [--elevation-change pgo.tif]
Requires numpy, netCDF4, pyproj, Pillow; rasterio for optional PGO input.
Original downloads stay outside the repository. See the output manifest for sources.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from netCDF4 import Dataset, num2date
from PIL import Image
from pyproj import Transformer

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public/data/glacier-test'
BOUNDS = dict(minLon=77.0436, minLat=43.0213, maxLon=77.1176, maxLat=43.0753)


def write_json(name, obj):
    (OUT / name).write_text(json.dumps(obj, separators=(',', ':'), allow_nan=False))


def inside(x, y, ring):
    hit = False
    for (ax, ay), (bx, by) in zip(ring, ring[1:] + ring[:1]):
        if (ay > y) != (by > y) and x < (bx-ax) * (y-ay) / (by-ay) + ax:
            hit = not hit
    return hit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--velocity', type=Path, required=True)
    parser.add_argument('--outlines', type=Path, required=True)
    parser.add_argument('--tiles', type=Path, required=True)
    parser.add_argument('--elevation-change', type=Path)
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    inventory = json.loads((ROOT / 'public/data/locations/tuyuksu-glacier/all_glaciers.json').read_text())
    main_glacier = next(f for f in inventory['features'] if f['properties']['rgi_id'] == 'RGI60-13.08624')
    geometry = main_glacier['geometry']
    polygons = [geometry['coordinates']] if geometry['type'] == 'Polygon' else geometry['coordinates']
    with Dataset(args.velocity) as ds:
        transform = Transformer.from_crs(int(ds['speed'].EPSG), 4326, always_xy=True)
        xx, yy = np.meshgrid(ds['x'][:], ds['y'][:])
        lon, lat = transform.transform(xx, yy)
        selected = [(j, i) for j, i in np.ndindex(xx.shape) if any(
            inside(float(lon[j, i]), float(lat[j, i]), p[0]) and not any(
                inside(float(lon[j, i]), float(lat[j, i]), hole) for hole in p[1:]) for p in polygons)]
        rows, cols = np.array(selected).T
        dates = [str(d)[:10] for d in num2date(ds['time'][:], ds['time'].units)]
        cells = []
        for j, i in selected:
            corners = [transform.transform(float(xx[j, i])+dx, float(yy[j, i])+dy)
                       for dx, dy in [(-60, 60), (60, 60), (60, -60), (-60, -60)]]
            cells.append({'center': [round(float(lon[j, i]), 7), round(float(lat[j, i]), 7)],
                          'corners': [[round(a, 7), round(b, 7)] for a, b in corners]})
        variables = {}
        for key in ['speed', 'speed_uncertainty', 'data_gap_days']:
            values = ds[key][:].filled(np.nan)[:, rows, cols].astype('<f4')
            (OUT / f'{key}.bin').write_bytes(values.tobytes())
            variables[key] = f'{key}.bin'
        write_json('velocity.json', {'dates': dates, 'cells': cells, 'variables': variables,
                    'layout': 'time-major float32 little-endian', 'units': 'm/day', 'spacingM': 120,
                    'mask': 'Cell centers within existing RGI60-13.08624 outline; fixed spatial mask, not a historical boundary.'})
    outlines = json.loads(args.outlines.read_text())
    write_json('outlines.json', {'type': 'FeatureCollection', 'features': outlines['features']})

    # Local, static reference terrain. It is not a PGO historical surface.
    canvas = Image.new('RGB', (1024, 1024))
    for x in [2924, 2925]:
        for y in [1503, 1504]:
            tile = Image.open(args.tiles / f'{x}-{y}.webp').convert('RGB')
            canvas.paste(tile, ((x-2924)*512, (y-1503)*512))
    w, h = 240, 240
    lons = np.linspace(BOUNDS['minLon'], BOUNDS['maxLon'], w)
    lats = np.linspace(BOUNDS['maxLat'], BOUNDS['minLat'], h)
    pixel_x = (((lons + 180) / 360 * 4096 - 2924) * 512).astype(int)
    pixel_y = (((1 - np.arcsinh(np.tan(np.radians(lats))) / math.pi) / 2 * 4096 - 1503) * 512).astype(int)
    pixels = np.asarray(canvas, dtype=float)[pixel_y[:, None], pixel_x[None, :]]
    elevation = pixels[:, :, 0]*256 + pixels[:, :, 1] + pixels[:, :, 2]/256 - 32768
    (OUT / 'terrain.bin').write_bytes(elevation.astype('<f4').tobytes())
    write_json('terrain.json', {'width': w, 'height': h, 'bounds': BOUNDS,
                'minElevation': float(elevation.min()), 'maxElevation': float(elevation.max()),
                'valuesFile': 'terrain.bin', 'source': 'Mapterhorn reference terrain; acquisition date unspecified'})
    elevation_status = {'status': 'unavailable', 'reason': 'PGO raster download not yet obtained. No synthetic elevation-change values are substituted.'}
    if args.elevation_change:
        import rasterio
        from rasterio.warp import reproject, Resampling, from_bounds
        with rasterio.open(args.elevation_change) as src:
            dst = np.full((h, w), np.nan, dtype=np.float32)
            reproject(rasterio.band(src, 1), dst, src_transform=src.transform, src_crs=src.crs,
                      src_nodata=src.nodata, dst_transform=from_bounds(BOUNDS['minLon'], BOUNDS['minLat'], BOUNDS['maxLon'], BOUNDS['maxLat'], w, h),
                      dst_crs='EPSG:4326', dst_nodata=np.nan, resampling=Resampling.bilinear)
            if not np.isfinite(dst).any():
                raise ValueError('PGO raster does not overlap the study bounds')
            (OUT / 'elevation-change.bin').write_bytes(dst.astype('<f4').tobytes())
            elevation_status = {'status': 'ready', 'valuesFile': 'elevation-change.bin', 'units': 'm',
                                'start': '2016-08-27', 'end': '2021-08-21'}
    write_json('manifest.json', {'prepared': '2026-10-20', 'bounds': BOUNDS,
        'elevationChange': elevation_status,
        'sources': [
            {'name': 'Baldacchino et al. 2025 — glacier speed', 'url': 'https://zenodo.org/records/15366525',
             'file': 'Tuyusku_Global-ts-results.nc', 'sha256': hashlib.sha256(args.velocity.read_bytes()).hexdigest()},
            {'name': 'GLIMS dated glacier outlines', 'url': 'https://www.glims.org/glacierdata/index.php',
             'sha256': hashlib.sha256(args.outlines.read_bytes()).hexdigest()},
            {'name': 'Mapterhorn reference elevation', 'url': 'https://mapterhorn.com', 'license': 'BSD-3-Clause'},
            {'name': 'PGO elevation change', 'url': 'https://doi.theia.data-terra.org/pgo/', 'license': 'CC BY-NC 4.0'},
        ]})
    print(json.dumps({'cells': len(cells), 'frames': len(dates), 'outlines': len(outlines['features']),
                      'dates': [dates[0], dates[-1]], 'elevationChange': elevation_status}, indent=2))


if __name__ == '__main__':
    main()
