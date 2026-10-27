# Tuyuksu glacier field test

Local experimental route: `/glacier-test` (production base: `/kor3d/glacier-test`).
Prepared 20 October 2026. No production location data was replaced.

## Imported datasets

### Surface speed — Baldacchino et al. (2025)

- Paper: https://doi.org/10.1016/j.srs.2025.100266
- Dataset: https://zenodo.org/records/15366525
- Original: `Tuyusku_Global-ts-results.nc` (the source uses this spelling).
- Coverage: 29 August 2016–7 May 2024, 469 six-day samples; original spatial spacing 120 m, EPSG:32643.
- Browser subset: 199 cells whose centers fall within the project's existing RGI60-13.08624 polygon. This fixed mask is NOT a historical glacier outline.
- `velocity.json`: dates, WGS84 cell centers/corners, array layout.
- `speed.bin`, `speed_uncertainty.bin`, `data_gap_days.bin`: time-major, little-endian float32; NaN retains missing data.
- Original speed and 1-sigma uncertainty are m/day. UI multiplies by 365.25 to show annualized m/year; these are not measured annual displacements. There are no direction vectors in this file.
- Filter: finite, nonnegative speed and finite observation gap at or below the chosen limit. Default 30 days; strict 7 days. No uncertainty threshold is imposed. The descriptive spatial mean uses only cells passing this filter, so its spatial support can change with time.
- Six-day output spacing does NOT mean an independent measurement every six days. The gap field is the distance in days to the nearest measurement; some estimates are far from observations.
- Cite both the paper and dataset when reusing. The inspected repository page exposes a copyright notice without an explicit licence identifier; check reuse terms before external redistribution. This test has not been published.

### Dated outlines — GLIMS

- Database: https://www.glims.org/glacierdata/index.php
- Retrieval: WFS 1.0.0 GetFeature, `GLIMS:GLIMS_Glacier_Outlines`, output `application/json`, `srsName=EPSG:4326`, bbox `77.0436,43.0213,77.1176,43.0753,EPSG:4326` at `https://www.glims.org/geoserver/ows`.
- 77 returned features: 15 for 1999-09-09, 28 for 2001-09-05, 25 for 2002-07-10, 9 for 2002-10-03. All returned features have `line_type=glac_bound`.
- `outlines.json` retains original geometry and properties, including `anlys_id`, `subm_id`, `chief_affl`, `glac_id`, `src_date`, and `line_type`. Source feature IDs can change between requests.
- Different submissions divide/names glaciers differently and may reuse boundaries. No automatic area-loss calculation or geometry interpolation is made from these submissions.
- Lines are clipped to the terrain's study rectangle and densified for display only. Downloaded geometry stays intact.
- Follow GLIMS citation guidance, including the original contributors identified by analysis/submission IDs. The UI links to the database.

### Reference terrain — Mapterhorn

- Public Terrarium tiles: `https://tiles.mapterhorn.com/12/{x}/{y}.webp` for x=2924–2925, y=1503–1504.
- Attribution: Elevation: Mapterhorn. BSD-3-Clause.
- RGB decoded as R×256 + G + B/256 − 32768 and sampled to a 240×240 WGS84 grid. `terrain.json` supplies bounds and dimensions; `terrain.bin` contains little-endian float32 metres.
- Acquisition date unspecified. This is NOT a 2016 or 2021 PGO surface. 3D height is exaggerated by 1.8; plan view is flattened.

## Elevation-change raster: pending

- Paper: Berthier et al. (2024), https://tc.copernicus.org/articles/18/5551/2024/
- Collection: https://doi.theia.data-terra.org/pgo/ (DOI 10.25577/313a-a978).
- Target pair: `2016-08-27_0545099_Tuyuksu_ASC` and `2021-08-21_0546043_Tuyuksu_ASC`; paper Figure 4 covers these dates.
- The provider's catalogue and series discovery endpoints returned empty lists without a signed-in session. This does not establish that the products are unavailable by other access paths. The published raster was not obtained in this run.
- `manifest.json` records `elevationChange.status=unavailable`; no synthetic or paper-digitized raster is substituted.
- PGO DEM/dZ products: CC BY-NC 4.0. Ortho-images have separate scientific access terms.
- Once the correct georeferenced 2021-minus-2016 difference raster is obtained, the preparation script accepts `--elevation-change /path/to/pgo.tif`, warps it to the reference grid, preserves no-data as NaN, and enables the surface-change layer. Check the file's acquisition dates, sign, units, correction variant, uncertainty and licence first. The UI uses a fixed ±20 m colour scale when this raster is loaded.

## Earlier survey evidence

Kapitsa et al. (2020), https://doi.org/10.3389/feart.2020.00259, Table 3: open-ice areas 2.99 ±0.09 km² (1958), 2.53 ±0.06 km² (1998), 2.28 ±0.06 km² (2016). The UI shows the reported central values. The paper offers its generated datasets on request. These three polygon files have not been obtained, and their shapes are not inferred from the area numbers.

## Reproduce

Install `numpy netCDF4 pyproj Pillow rasterio` in a separate Python environment.
Download the original NetCDF, WFS response, and four terrain tiles into a scratch directory (name the tiles `2924-1503.webp` etc.). Then run from the repository:

```sh
python scripts/prefetch/glacier-test.py \
  --velocity /path/to/Tuyusku_Global-ts-results.nc \
  --outlines /path/to/glims.geojson \
  --tiles /path/to/tiles
```

The script writes only the test data directory. Original-source SHA-256 checksums are retained in `manifest.json`. Large original downloads are not checked in.

## OGGM warming experiment — playback ready

`tuyuksu-oggm.json` contains 17 five-year states (2020–2100) from an actual OGGM 1.6.3 run for Central Tuyuksu, RGI60-13.08624. It loads automatically in **04 · 3D glacier**. The Play button and scrubber are above the scene; playback stops at 2100.

The experiment samples W5E5 baseline years 1999–2019 with seed 1 and applies a fixed additional +1.5°C temperature bias. Precipitation comes from the sampled baseline years without an additional multiplier. Initial geometry is the official preprocessed historical spinup, not a contemporaneous survey. This is one illustrative sensitivity experiment, not a calibrated local forecast, an SSP scenario, or an uncertainty ensemble.

OGGM computes annual flowline dynamics. Its `sandbox.distribute_2d` workflow redistributes the resulting area and volume onto the glacier's native 34 m grid. The display uses a 105×128 crop around the glacier plus a 700 m terrain margin, without spatial downsampling. Only five-year states are stored, and there is no temporal interpolation or temporal smoothing. OGGM's NaN convention outside the simulated ice footprint is represented as zero thickness (ice-free terrain). Thickness and bedrock are rounded to centimetres for JSON storage. No speed field is supplied.

`tuyuksu-oggm-run.json` records exact settings, software versions, the input archive checksum, output checksum, and all 17 volume-conservation checks. The unrounded redistributed volumes agree with OGGM flowline volumes to numerical precision; rendered volumes agree within 1%. The approximate bed is OGGM's topography minus inverted thickness. The flowline model and spatial redistribution do not constitute a full 3D stress solution, and the redistribution cannot faithfully represent advance outside the inventory footprint.

The original L4 archive is from the official [OGGM W5E5 spinup collection](https://cluster.klima.uni-bremen.de/~oggm/gdirs/oggm_v1.6/L3-L5_files/2025.6/elev_bands/W5E5/per_glacier_spinup/), RGI62/b_080/L4/RGI60-13/RGI60-13.08.tar, member RGI60-13.08624.tar.gz (635,265 bytes). Its SHA-256 is `fce2a3177363723bc8cd655ef19fe87403abbf0627835aac7a8c2f7ea9349d2f`. The glacier name in the archive is “Tsentralniy Tuyuksu Glacier”. Original data and scratch model files are not checked in.

Reproduction and interpretation: `docs/glacier-models.md`, `scripts/prefetch/tuyuksu-simulation.py`, and `scripts/prefetch/requirements-oggm.txt`. Cite [Maussion et al. (2019)](https://doi.org/10.5194/gmd-12-909-2019), retain the source information for the preprocessed geometry/climate, and follow the [OGGM redistribution workflow](https://tutorials.oggm.org/stable/notebooks/tutorials/distribute_flowline.html).
