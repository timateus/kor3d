#!/usr/bin/env python3
"""Run and package a real OGGM warming experiment for Central Tuyuksu.

Requires OGGM 1.6.3 and its scientific dependencies. Downloads official
preprocessed data; stores working files outside the published site.
The bundled output is an illustrative experiment, not a calibrated forecast.
"""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import sys

RGI_ID = 'RGI60-13.08624'
PREPRO_URL = ('https://cluster.klima.uni-bremen.de/~oggm/gdirs/oggm_v1.6/'
              'L3-L5_files/2025.6/elev_bands/W5E5/per_glacier_spinup/')
SUFFIX = '_kor3d_warming_15'


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--work-dir', required=True, type=Path)
    p.add_argument('--output-dir', type=Path, default=Path('public/data/glacier-test'))
    p.add_argument('--glacier-archive', type=Path, help='Optional official single-glacier L4 tar.gz, avoiding a regional download')
    p.add_argument('--resume', action='store_true', help='Reuse an already computed run and redistribute/package it')
    args = p.parse_args()
    args.work_dir = args.work_dir.resolve()
    args.work_dir.mkdir(parents=True, exist_ok=True)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault('OGGM_DOWNLOAD_CACHE', str(args.work_dir / 'downloads'))
    os.environ.setdefault('OGGM_EXTRACT_DIR', str(args.work_dir / 'extract'))
    os.environ.setdefault('MPLCONFIGDIR', str(args.work_dir / 'matplotlib'))

    import numpy as np
    import xarray as xr
    import oggm
    from oggm import cfg, tasks, utils, workflow
    from oggm.sandbox import distribute_2d
    from pyproj import Transformer

    # We use preprocessed geometry and climate, so no raw DEM/forcing downloads are needed.
    cfg.initialize_minimal(logging_level='WARNING')
    cfg.PATHS['working_dir'] = str(args.work_dir / 'glaciers')
    cfg.PARAMS['use_multiprocessing'] = False
    cfg.PARAMS['border'] = 80
    cfg.PARAMS['store_model_geometry'] = True
    cfg.PARAMS['store_fl_diagnostics'] = True
    if args.resume:
        gdir = workflow.init_glacier_directories([RGI_ID])[0]
    elif args.glacier_archive:
        gdir = oggm.GlacierDirectory(RGI_ID, from_tar=str(args.glacier_archive.resolve()))
    else:
        gdir = workflow.init_glacier_directories(
            [RGI_ID], from_prepro_level=4, prepro_base_url=PREPRO_URL,
            prepro_border=80, prepro_rgi_version='62')[0]
    print(f'Glacier: {gdir.rgi_id}, {gdir.name}, grid {gdir.grid.nx}×{gdir.grid.ny}, dx={gdir.grid.dx} m', flush=True)
    if not args.resume:
        tasks.run_random_climate(
            gdir, ys=2020, ye=2100, y0=2009, halfsize=10, seed=1,
            temperature_bias=1.5, store_fl_diagnostics=True,
            init_model_filesuffix='_spinup_historical', output_filesuffix=SUFFIX)
    print('Ice dynamics complete. Distributing annual flowline volume onto the glacier grid…', flush=True)
    distribute_2d.add_smoothed_glacier_topo(gdir)
    tasks.distribute_thickness_per_altitude(gdir)
    distribute_2d.assign_points_to_band(gdir)
    distribute_2d.distribute_thickness_from_simulation(
        gdir, input_filesuffix=SUFFIX, ys=2020, ye=2100,
        fl_thickness_threshold=0, rolling_mean_smoothing=0, add_monthly=False)
    with xr.open_dataset(gdir.get_filepath('gridded_simulation', filesuffix=SUFFIX)) as ds:
        ds = ds.load()
    with xr.open_dataset(gdir.get_filepath('model_diagnostics', filesuffix=SUFFIX)) as diagnostics:
        diagnostics = diagnostics.load()

    # Restrict the display domain to the glacier and a 700 m terrain margin.
    mask = ds.glacier_mask.values == 1
    rr, cc = np.where(mask)
    margin = int(np.ceil(700 / abs(gdir.grid.dx)))
    region = dict(y=slice(max(0, rr.min() - margin), min(ds.sizes['y'], rr.max() + margin + 1)),
                  x=slice(max(0, cc.min() - margin), min(ds.sizes['x'], cc.max() + margin + 1)))
    crop = ds.isel(**region)
    # Store five-year frames, plus the final year, at native spatial resolution.
    # This preserves the model run while keeping static-site downloads modest.
    years = list(range(2020, 2101, 5))
    crop = crop.sel(time=years)
    x, y = np.meshgrid(crop.x.values, crop.y.values)
    lon, lat = Transformer.from_crs(gdir.grid.proj.srs, 'EPSG:4326', always_xy=True).transform(x, y)
    bed = crop.bedrock.values
    if not np.isfinite(bed).all():
        raise ValueError('Unexpected missing bedrock in the display domain.')
    frames = []
    comparison = []
    for year in years:
        raw = crop.simulated_thickness.sel(time=year).values
        # OGGM explicitly writes NaN outside the simulated ice footprint. Here
        # this means ice-free land (0), not an unknown measurement/filled gap.
        thickness = np.nan_to_num(raw, nan=0.0)
        if np.any(thickness < 0) or not np.isfinite(thickness).all():
            raise ValueError(f'Invalid simulated ice thickness at {year}.')
        model_volume = float(diagnostics.volume_m3.sel(time=year))
        distributed_volume = float(thickness.sum() * gdir.grid.dx ** 2)
        if not np.isclose(distributed_volume, model_volume, rtol=1e-5, atol=1):
            raise ValueError(f'Distribution did not preserve volume at {year}: {distributed_volume} vs {model_volume}')
        frames.append(dict(label=str(year), thickness=np.round(thickness, 2).ravel().tolist()))
        comparison.append(dict(year=year, flowlineVolumeM3=model_volume,
                               distributedVolumeM3=distributed_volume,
                               flowlineAreaM2=float(diagnostics.area_m2.sel(time=year))))
    source = (
        f'OGGM {oggm.__version__}, {RGI_ID}. Illustrative 2020–2100 warming experiment: '
        'randomly resampled 1999–2019 W5E5 climate, seed 1, with +1.5°C temperature bias; '
        'precipitation unchanged. Initialized from the preprocessed historical spinup. '
        'Annual flowline dynamics redistributed to a 2D glacier grid using OGGM; five-year display frames. '
        'Bed inferred from OGGM topography and inverted thickness. Not a calibrated local forecast or an SSP projection.'
    )
    model = dict(schema='kor3d-glacier-v1', title='Central Tuyuksu · OGGM +1.5°C experiment',
                 source=source, kind='simulation', width=crop.sizes['x'], height=crop.sizes['y'],
                 longitude=np.round(lon, 7).ravel().tolist(), latitude=np.round(lat, 7).ravel().tolist(),
                 bedrock=np.round(bed, 2).ravel().tolist(), frames=frames)
    if model['width'] * model['height'] * len(frames) > 4_000_000:
        raise ValueError('Display dataset exceeds viewer limits.')
    output = args.output_dir / 'tuyuksu-oggm.json'
    payload = json.dumps(model, separators=(',', ':'), allow_nan=False).encode()
    output.write_bytes(payload)
    packages = ['oggm', 'numpy', 'scipy', 'pandas', 'xarray', 'salem', 'geopandas', 'rasterio', 'netCDF4', 'shapely', 'scikit-image']
    run = dict(
        glacier=RGI_ID, glacierName=gdir.name, model='OGGM', version=oggm.__version__,
        experiment=dict(startYear=2020, endYear=2100, baselineStart=1999, baselineEnd=2019,
                        temperatureBiasC=1.5, precipitation='unchanged', randomSeed=1,
                        initialization='_spinup_historical', calibratedForecast=False),
        preprocessedData=dict(baseUrl=PREPRO_URL, level=4, rgiVersion='62', border=80,
                              archiveSha256=hashlib.sha256(args.glacier_archive.read_bytes()).hexdigest() if args.glacier_archive else None),
        modelGrid=dict(dxM=gdir.grid.dx, width=gdir.grid.nx, height=gdir.grid.ny, crs=gdir.grid.proj.srs),
        display=dict(width=model['width'], height=model['height'], years=years,
                     thicknessRoundingM=0.01, spatialResampling=False,
                     redistribution='OGGM sandbox.distribute_2d, no temporal smoothing, no monthly interpolation'),
        volumeChecks=comparison, sha256=hashlib.sha256(payload).hexdigest(),
        python=sys.version.split()[0], packages={name: importlib.metadata.version(name) for name in packages},
        references=[
            'https://doi.org/10.5194/gmd-12-909-2019',
            'https://tutorials.oggm.org/stable/notebooks/tutorials/distribute_flowline.html',
            'https://docs.oggm.org/en/stable/input-data.html'],
        limitations=[
            'Single illustrative experiment; not a calibrated Tuyuksu forecast, an SSP pathway, or an uncertainty ensemble.',
            'OGGM solves glacier flow along elevation bands; the 2D footprint is a heuristic redistribution, not a 3D stress solution.',
            'The 2D redistribution supports retreat within the inventory footprint; it cannot faithfully represent advance beyond it.',
            'Years are experiment years. The initial 2020 geometry is a model state, not a 2020 survey.',
            'Modeled geometry and volume differ from the separate Farinotti/Mapterhorn reference dataset.'],
    )
    (args.output_dir / 'tuyuksu-oggm-run.json').write_text(json.dumps(run, indent=2, allow_nan=False) + '\n')
    print(f'Wrote {output}: {len(frames)} frames, {len(payload) / 1e6:.2f} MB', flush=True)
    print(json.dumps(comparison, indent=2), flush=True)


if __name__ == '__main__':
    main()
