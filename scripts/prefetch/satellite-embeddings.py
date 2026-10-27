"""Prepare a small AlphaEarth raster for a static kor3d location.

Requires numpy, rasterio. See README.md. Native int8 quantization is preserved;
nearest-neighbour reprojection does not average quantized embedding components.
"""
import argparse
import csv
import json
import math
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_bounds
from rasterio.warp import reproject, Resampling, transform_bounds
from rasterio.windows import Window

ROOT = Path(__file__).resolve().parents[2]
ATTRIBUTION = 'The AlphaEarth Foundations Satellite Embedding dataset is produced by Google and Google DeepMind.'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--slug', default='gorny-gigant')
    parser.add_argument('--year', type=int, default=2025)
    parser.add_argument('--bounds', nargs=4, type=float, metavar=('WEST', 'SOUTH', 'EAST', 'NORTH'),
                        default=[76.9323, 43.1993, 76.9737, 43.2302])
    parser.add_argument('--index', type=Path, required=True, help='Local aef_index.csv from the public bucket')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--source-dir', type=Path, help='Optional local cache of source COGs by filename')
    parser.add_argument('--max-size', type=int, default=512, help='Maximum output edge in pixels (1–512)')
    parser.add_argument('--overview-level', type=int, help='GDAL source overview level, zero is 2×')
    args = parser.parse_args()
    if not 1 <= args.max_size <= 512:
        parser.error('max-size must be 1–512')
    west, south, east, north = args.bounds
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        parser.error('Invalid bounds')
    width = math.ceil((east - west) * 111320 * math.cos(math.radians((north + south) / 2)) / 10)
    height = math.ceil((north - south) * 111320 / 10)
    scale = min(1, args.max_size / max(width, height))
    width, height = max(1, math.ceil(width * scale)), max(1, math.ceil(height * scale))
    spacing = dict(x=(east-west)*111320*math.cos(math.radians((north+south)/2))/width,
                   y=(north-south)*111320/height)
    aggregation = 10
    with args.index.open() as f:
        tiles = [row for row in csv.DictReader(f) if row['year'] == str(args.year)
                 and float(row['wgs84_west']) < east and float(row['wgs84_east']) > west
                 and float(row['wgs84_south']) < north and float(row['wgs84_north']) > south]
    if not tiles:
        raise RuntimeError('No source tiles intersect this region/year')
    transform = from_bounds(west, south, east, north, width, height)
    grid = np.full((64, height, width), -128, dtype=np.int8)
    sources = []
    for tile in tiles:
        url = tile['path'].replace('gs://', 'https://storage.googleapis.com/', 1)
        print(f'Reading spatial window: {url}', flush=True)
        sources.append(url)
        with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tiff', GDAL_HTTP_TIMEOUT='120'):
            source_path = args.source_dir / Path(tile['path']).name if args.source_dir else url
            with rasterio.open(source_path, **({'overview_level': args.overview_level} if args.overview_level is not None else {})) as src:
                aggregation = max(aggregation, abs(src.transform.a), abs(src.transform.e))
                if src.count != 64 or src.dtypes[0] != 'int8':
                    raise RuntimeError('Unexpected source schema')
                native_bounds = transform_bounds('EPSG:4326', src.crs, west, south, east, north, densify_pts=21)
                # Some published tiles have a south-up transform; use the
                # inverse affine instead of assuming a north-up raster.
                left, bottom, right, top = native_bounds
                corners = [~src.transform * (x, y) for x in (left, right) for y in (bottom, top)]
                col0 = math.floor(min(c[0] for c in corners)) - 1
                row0 = math.floor(min(c[1] for c in corners)) - 1
                col1 = math.ceil(max(c[0] for c in corners)) + 1
                row1 = math.ceil(max(c[1] for c in corners)) + 1
                window = Window(col0, row0, col1 - col0, row1 - row0)
                window = window.intersection(Window(0, 0, src.width, src.height))
                print(f'Reading {int(window.width)} × {int(window.height)} source pixels', flush=True)
                source = src.read(window=window)
                candidate = np.full_like(grid, -128)
                reproject(source=source, destination=candidate,
                          src_transform=src.window_transform(window), src_crs=src.crs,
                          src_nodata=-128, dst_transform=transform, dst_crs='EPSG:4326',
                          dst_nodata=-128, resampling=Resampling.nearest)
                valid = np.all(candidate != -128, axis=0)
                grid[:, valid] = candidate[:, valid]
    valid = np.all(grid != -128, axis=0)
    if not valid.any():
        raise RuntimeError('Source tiles contain no valid pixels in this region')
    grid[:, ~valid] = -128
    output = args.output or ROOT / 'public' / 'data' / 'locations' / args.slug / 'embeddings' / str(args.year)
    output.mkdir(parents=True, exist_ok=True)
    # Interleaved pixel-major, row-major north to south.
    grid.transpose(1, 2, 0).copy().tofile(output / 'values.bin')
    meta = dict(version=1, dataset='GOOGLE/SATELLITE_EMBEDDING/V1/ANNUAL', year=args.year,
                width=width, height=height, dimensions=64, encoding='aef-int8', noData=-128,
                bounds=dict(minLon=west, minLat=south, maxLon=east, maxLat=north),
                crs='EPSG:4326', sourceResolutionMeters=10, gridSpacingMeters=spacing,
                aggregationMeters=aggregation, sourceOverviewLevel=args.overview_level, resampling='nearest',
                valuesFile='values.bin', validPixels=int(valid.sum()), sources=sources,
                license='CC-BY-4.0', attribution=ATTRIBUTION)
    (output / 'metadata.json').write_text(json.dumps(meta, indent=2) + '\n')
    print(f'Wrote {width} × {height}, {valid.mean():.1%} valid, {grid.nbytes / 1024**2:.2f} MiB to {output}')


if __name__ == '__main__':
    main()
