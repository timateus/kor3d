#!/usr/bin/env python3
"""Convert a rectangular OGGM/IGM/PISM NetCDF subset into the KÖR3D glacier viewer format.

Requires numpy, netCDF4 and pyproj. See docs/glacier-models.md.
Coordinates and units are explicit; no forecast or missing geometry is fabricated.
"""
import argparse
import json
from pathlib import Path


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('input', type=Path)
    p.add_argument('output', type=Path)
    p.add_argument('--title', required=True)
    p.add_argument('--source', required=True, help='Model, scenario, citation, and run provenance')
    p.add_argument('--crs', required=True, help='Source grid CRS, e.g. EPSG:32643 or EPSG:4326')
    p.add_argument('--bed', default='topg')
    p.add_argument('--thickness', default='thk')
    p.add_argument('--speed', help='Optional scalar speed variable, not a velocity component')
    p.add_argument('--speed-unit', choices=['m/year', 'm/day', 'm/s'], help='Explicit override for speed units')
    p.add_argument('--assume-metres', action='store_true', help='Confirm geometry is in metres if units metadata is absent')
    p.add_argument('--x', default='x')
    p.add_argument('--y', default='y')
    p.add_argument('--time', default='time', help='Time dimension; use calendar_year for OGGM outputs when applicable')
    p.add_argument('--stride', type=int, default=1)
    p.add_argument('--frame-stride', type=int, default=1)
    args = p.parse_args()
    if args.stride < 1 or args.frame_stride < 1:
        p.error('Strides must be positive.')
    import numpy as np
    from netCDF4 import Dataset, num2date
    from pyproj import Transformer

    with Dataset(args.input) as ds:
        for name in [args.x, args.y, args.bed, args.thickness] + ([args.speed] if args.speed else []):
            if name not in ds.variables:
                p.error(f'Variable {name!r} is missing. Available: {list(ds.variables)}')
        if ds[args.x].ndim != 1 or ds[args.y].ndim != 1:
            p.error('Use one-dimensional rectangular grid coordinates; subset/regrid unstructured meshes first.')
        xd, yd = ds[args.x].dimensions[0], ds[args.y].dimensions[0]
        if xd == yd:
            p.error('x and y must use different dimensions.')
        selection = {xd: slice(None, None, args.stride), yd: slice(None, None, args.stride)}
        if args.time in ds.dimensions:
            selection[args.time] = slice(None, None, args.frame_stride)
        xvalues = ds[args.x][::args.stride]
        yvalues = ds[args.y][::args.stride]
        width, height = len(xvalues), len(yvalues)
        count = len(range(0, len(ds.dimensions[args.time]), args.frame_stride)) if args.time in ds.dimensions else 1
        if not 2 <= width <= 600 or not 2 <= height <= 600 or count > 500 or width * height * count > 4_000_000:
            p.error('Use a smaller subset or increase strides: 2–600 nodes/axis, ≤500 frames, ≤4 million values.')
        for name in [args.bed, args.thickness]:
            unit = str(getattr(ds[name], 'units', '')).strip().lower()
            if unit not in ['m', 'meter', 'meters', 'metre', 'metres'] and not (not unit and args.assume_metres):
                p.error(f'{name}: geometry must use metres; units are {unit!r}. Missing metadata requires --assume-metres.')
        xx, yy = np.meshgrid(xvalues, yvalues)
        lon, lat = Transformer.from_crs(args.crs, 'EPSG:4326', always_xy=True).transform(xx, yy)
        if not (np.isfinite(lon).all() and np.isfinite(lat).all() and (np.abs(lon) <= 180).all() and (np.abs(lat) < 89).all()):
            p.error('Invalid geographic coordinates after transformation. Check the grid CRS.')

        def grid(name, frame=0):
            variable = ds[name]
            dims = [d for d in variable.dimensions if d != args.time]
            if set(dims) != {xd, yd} or len(dims) != 2:
                p.error(f'{name}: expected x/y grid with optional time; got dimensions {variable.dimensions}. Subset other dimensions first.')
            slices = tuple(frame * args.frame_stride if d == args.time else selection[d] for d in variable.dimensions)
            values = np.ma.asarray(variable[slices], dtype=float).filled(np.nan)
            return values.transpose(dims.index(yd), dims.index(xd))

        def serial(values):
            return [round(float(v), 6) if np.isfinite(v) else None for v in values.ravel()]

        bed = grid(args.bed)
        frames = []
        speed_factor = 1
        if args.speed:
            unit = args.speed_unit or str(getattr(ds[args.speed], 'units', '')).lower().strip()
            units = {'m/year': 1, 'm/yr': 1, 'm yr-1': 1, 'm year-1': 1, 'm a-1': 1,
                     'm/day': 365.25, 'm day-1': 365.25, 'm d-1': 365.25,
                     'm/s': 365.25 * 86400, 'm s-1': 365.25 * 86400}
            if unit not in units:
                p.error(f'Unrecognized speed units {unit!r}; specify --speed-unit after verifying source units.')
            speed_factor = units[unit]
        has_ice = False
        for i in range(count):
            if args.time in ds[args.bed].dimensions and not np.allclose(bed, grid(args.bed, i), equal_nan=True):
                p.error('Time-varying bedrock is not supported by this viewer. Export a run with a fixed bed.')
            thickness = grid(args.thickness, i)
            thickness[thickness < 0] = np.nan
            has_ice |= bool(np.any((thickness > 0) & np.isfinite(bed)))
            label = 'Model snapshot'
            if args.time in ds.variables:
                time = ds[args.time]
                raw = time[i * args.frame_stride]
                unit = getattr(time, 'units', '')
                label = str(num2date(raw, unit, calendar=getattr(time, 'calendar', 'standard'))) if 'since' in unit else str(raw)
            elif args.time in ds.dimensions:
                label = f'Frame {i * args.frame_stride + 1}'
            frame = {'label': label, 'thickness': serial(thickness)}
            if args.speed:
                speed = grid(args.speed, i) * speed_factor
                speed[speed < 0] = np.nan
                frame['speed'] = serial(speed)
            frames.append(frame)
        if not has_ice:
            p.error('No positive ice thickness overlaps valid bedrock.')
        model = dict(schema='kor3d-glacier-v1', title=args.title, source=args.source, kind='simulation',
                     width=width, height=height, longitude=serial(lon), latitude=serial(lat), bedrock=serial(bed), frames=frames)
        args.output.write_text(json.dumps(model, separators=(',', ':'), allow_nan=False))
        print(f'Wrote {args.output}: {width} × {height} nodes, {count} frames.')


if __name__ == '__main__':
    main()
