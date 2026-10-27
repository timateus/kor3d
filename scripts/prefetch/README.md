# Data prefetch scripts

`ghs-pop.mjs` pre-fetches GHS-POP R2023A (JRC) population density for each
location's terrain footprint (`bounds` in `locations.mjs`, not the larger
waterBounds used by other layers) and writes it to
`public/data/locations/{slug}/`:

- `population_density.bin` — raw little-endian Float32 grid, row-major, north→south
- `population_density.json` — `{ width, height, minLon, minLat, maxLon, maxLat, source, units, valuesFile }`

## Run

```bash
# Install one-off dependency used only by this script (geotiff is already
# a runtime dependency for terrain DEM loading)
npm i -D adm-zip

# All locations
node scripts/prefetch/ghs-pop.mjs

# Or one slug at a time
node scripts/prefetch/ghs-pop.mjs alakol seliger
```

## Notes

* Downloads 10°×10° GHS-POP tiles (~30-80 MB each) and caches them under
  `$TMPDIR/ghs-pop-cache`. Re-running is fast once tiles are cached.
* Reads each tile's bounding-box window in a single `readRasters` call
  per tile, not per output pixel — the original per-pixel approach took
  ~40 minutes per location; this takes well under a second once tiles
  are cached (or a few seconds including download).
* When adding a new location to `src/lib/locations.ts`, mirror its
  `bounds` into `locations.mjs` and re-run for that slug.

# HydroSHEDS basin rivers & watershed boundary

`hydrosheds.mjs` fetches the *entire drainage basin* a location sits in —
every river connected to it (same terminal lake/sea), not just what's inside
the location's own bbox. Unlike `water.json`/`water_large.json` (OSM,
bbox-clipped), this answers "what does this river connect to?".

Writes to `public/data/locations/{slug}/`:

- `basin_rivers.json` — GeoJSON `FeatureCollection` of HydroRIVERS reaches
  (`ord_stra`/`ord_clas`/`ord_flow`/`length_km`/`dis_av_cms` properties)
- `basin_boundary.json` — GeoJSON `FeatureCollection` of the HydroBASINS
  sub-basin polygons making up the whole basin
- `basin_meta.json` — basin id, area, polygon/river counts, bbox (for
  sanity-checking, not read by the frontend)

## Run

```bash
# npm i -D shapefile @turf/turf   (already devDependencies)
node scripts/prefetch/hydrosheds.mjs suaq
```

```
node scripts/prefetch/hydrosheds.mjs --level 6 --region as suaq
```

## Notes

* Method: find the HydroBASINS polygon (at `--level`, default 5 — roughly
  major-river-basin scale) containing the location's center, then take every
  polygon at that level sharing the same `MAIN_BAS` (i.e. draining to the
  same outlet) as "the basin". HydroRIVERS reaches are kept if they intersect
  any of those polygons. For `suaq` (Charyn Canyon) this resolves to the
  whole Lake Balqash endorheic basin — 26 level-5 polygons, ~415,000 km²,
  matching the commonly cited figure for that basin.
* `--level` controls granularity: lower = coarser/bigger, higher =
  finer/smaller. The script logs the resulting polygon count and total area
  — rerun with a different level if that looks wrong for a given location.
* `--region` is a HydroSHEDS continent code (af/ar/as/au/eu/gr/na/sa/si).
  Defaults to `as` (covers Kazakhstan/Central Asia — correct for the current
  Kazakhstan-region locations). Locations elsewhere (e.g. `seliger` → `eu`,
  `garibaldi-squamish` → `na`) need it passed explicitly; it is not
  auto-detected.
* `--min-stra` filters out reaches below that Strahler stream order (default
  3). A full basin's reach network (order 1+) runs 10,000-20,000+ individual
  lines — too many for `HydroBasinLayer`'s one-`Line2`-per-feature rendering
  (same pattern as `OsmLinesLayer`). Lower it for more tributary detail at
  the cost of a bigger file and slower rendering.
* Downloads (HydroBASINS ~5-20 MB per level, HydroRIVERS ~70-90 MB per
  region) are cached under `$TMPDIR/hydrosheds-cache`. Region files are
  shared across locations in the same run/region.
* Data: [HydroSHEDS](https://www.hydrosheds.org/) HydroRIVERS & HydroBASINS
  v1c (Lehner & Grill, 2013) — free for non-commercial/research use, check
  their license for other uses.

# Google Satellite Embeddings (AlphaEarth)

Pilot: `gorny-gigant`, 2025, 10 m source resolution. Preparation uses the
public Google Cloud Storage COGs; the deployed site only loads local static
assets and needs no Google credentials or backend.

```bash
python3 -m venv /tmp/kor3d-aef-venv
/tmp/kor3d-aef-venv/bin/pip install -r scripts/prefetch/requirements-embeddings.txt
# The worldwide index is large (~761 MiB); cache it outside the repository.
curl -fL https://storage.googleapis.com/alphaearth_foundations/satellite_embedding/v1/annual/aef_index.csv -o /tmp/kor3d-aef-index.csv
/tmp/kor3d-aef-venv/bin/python scripts/prefetch/satellite-embeddings.py --index /tmp/kor3d-aef-index.csv
node --test scripts/tests/satellite-embeddings.test.mjs
```

Other small regions: pass `--slug NAME --year YEAR --bounds WEST SOUTH EAST NORTH`
and register `embeddingYears` in `src/lib/locations.ts`. The pilot rejects
regions above 262144 output pixels; larger regions need tiling first.

Output: `public/data/locations/{slug}/embeddings/{year}/metadata.json` and
`values.bin`. The binary stores 64 signed int8 components per pixel, interleaved,
rows north to south. Bounds are the outer pixel edges. `-128` is no data. Native
UTM source pixels are reprojected to the location's WGS84 rectangle with nearest
neighbour sampling, at approximately 10 m spacing. No averaging of quantized
vectors takes place. The browser decodes each component using
`sign(value) * (value / 127.5)^2`, then normalizes vectors before cosine similarity.

Overview uses fixed axes A01/A16/A09 and a [-0.3, 0.3] stretch; colours are not
land-cover classes. Similarity is computed from all 64 components in a Web Worker;
invalid pixels remain transparent. Similarity is not a probability. This pilot
compares pixels within one location and year, not text queries or global search.

In the app: open `/gorny-gigant`, enable **Embeddings**, choose **Find similar**,
and click open terrain. Water flow takes priority while it is active; feature
markers retain their own click actions. Other overlays can be disabled in Layers
for a clearer view. Closing the panel stops the worker and releases its grid.

Data is CC BY 4.0. Required attribution is included in metadata and the panel:
“The AlphaEarth Foundations Satellite Embedding dataset is produced by Google
and Google DeepMind.” Sources and transformations are recorded in metadata.

- [Dataset](https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_SATELLITE_EMBEDDING_V1_ANNUAL)
- [COGs, index, quantization and pyramid rules](https://developers.google.com/earth-engine/guides/aef_on_gcs_readme)

## Area selection

In **Find similar**, choose **Brush**, set its radius (10–150 m), and drag over
the terrain. Subsequent strokes add to the purple selection. Releasing the
pointer computes a normalized mean of the valid selected embedding vectors;
no-data pixels and duplicate pixel indices are excluded. **Reset** clears the
whole example; **Point** replaces it with one pixel. **Move** enables camera
navigation without changing the example. Camera controls are paused while the
Brush tool is active, including on touch devices.

Painting updates a small selection texture without updating React state for
every pointer movement. Similarity is recomputed at stroke end. Threshold
changes are coalesced for 60 ms and reuse the reference's similarity scores.
The overview is cached inside the worker. Both embedding colours and the purple
selection are composited into the terrain shader, avoiding an extra terrain
mesh/draw pass. Terrain hit testing uses drei's BVH with a nearest-hit query;
the BVH is rebuilt when terrain geometry changes.

## Annual comparison

Prepared years for `gorny-gigant`: **2017 and 2025**. `kok-zhailau` (the
proposed ski-resort area, bounds `76.943 43.075 77.130 43.175`: just west
of the master plan's westernmost station, east past Shymbulak and the Talgar
pass, plateau to Құмбелтау) has every year **2017–2025**, at ~30 m spacing
because the 15.2 × 11.1 km area exceeds the 512-pixel edge cap. Export an additional year
with the same bounds using `--year 2017`, then register it in `embeddingYears`.
The JSON sidecars record the source tiles and common grid. A pair is rejected
if its dimensions, bounds, CRS or embedding dataset differ.

**Changes** loads the comparison year on demand and offers:

- **Difference**: pixelwise `1 - dot(unit_vector_year_a, unit_vector_year_b)`,
  range 0–2. Zero means identical vectors. The minimum-change slider masks
  lower values; the colour ramp saturates at threshold + 0.5.
- Year buttons: fixed-axis A01/A16/A09 overviews of either year.
- **Swipe**: a screen-space divider between the annual embedding overviews.
  Moving it only updates a shader uniform, with no worker recomputation.

The percentage above threshold uses only pixels valid in both years. It is
not a percentage of confirmed land-cover conversion. Changes in annual
satellite signatures do not identify their causes. The satellite basemap is
still Satlas 2023, not historical imagery for the selected years.

Only two normalized annual grids are retained per open layer. Closing the
panel terminates the worker. Population shading pauses while the panel is
open so its colours cannot be mistaken for embedding similarities or changes;
its previous visibility preference takes effect again when the panel closes.

See Google's [description of cross-year embedding consistency](https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_SATELLITE_EMBEDDING_V1_ANNUAL).

## Search between locations

2025 grids are prepared for `gorny-gigant`, `almaty`, `suaq`, `balqash` and `balqash-lake`. Run
`python scripts/prefetch/build-embedding-search.py` after preparing those
location rasters. It writes `public/data/embedding-search/2025/manifest.json`
and `values.bin`, plus `preview.png` beside each location's prepared grid.
The preview colours are actual A01/A16/A09 embedding overviews, not satellite
photos. The index currently contains 34,980 patches (2.14 MiB).

Each index entry represents up to 5×5 prepared grid cells (about 50–55 m in local scenes, about 4.8 km at Lake Balqash). The builder
decodes and normalizes source vectors, sums the valid vectors in each patch,
normalizes the sum, then requantizes using Google's signed-square encoding.
Edge patches use their actual clipped extents and centres.

In **Find similar**, select a point or paint an area, then choose **Find in
other locations**. The compact index loads only on request. A short-lived Web
Worker ranks patches with cosine similarity and terminates when finished.
Search excludes the current location and every patch intersecting its scene
bounds (important because Almaty overlaps Gorny Gigant). Results are at least
200 m apart across all locations, with at most three results per location and
six total. Only matches meeting the current similarity threshold are shown.
No matching patch is a valid outcome; there is no forced low-score fallback.
Cross-location search currently supports 2025 only.

Opening a result carries the original normalized 64D reference in React Router
history state. The destination renders similarity against that original
reference on its prepared display grid, marks the matched patch centre and
flies the camera there. It does not substitute the destination pixel as the
reference. A patch score describes the aggregated search cell, not an exact
10 m destination pixel. Manual point/brush selection or **Clear reference**
replaces the imported example. A copied URL alone does not carry this state;
shareable saved searches are a separate feature.

Tests: `node --test scripts/tests/*.test.mjs` covers ranking, no-data, spatial
exclusions, duplicate suppression, clipped edge patches, route validation,
reference preservation and the prepared real index.


## Balqash city and whole lake

Both scenes include 2017 and 2025, with identical destination grids for annual comparison:

| Scene | Grid | Approximate spacing | Source level | Per year |
| --- | --- | --- | --- | --- |
| `balqash` | 490 × 512 | 11 m | native 10 m | 15.31 MiB |
| `balqash-lake` | 512 × 300 | 965 m | official 640 m COG overview | 9.38 MiB |

The exporter caps the longest edge at 512 cells (`--max-size`), preserving the
bounds and approximate geographic aspect ratio. The lake uses
`--overview-level 5` (GDAL's zero-based overview numbering, 64× native spacing).
Nearest-neighbour reprojection preserves the published overview vectors;
it does not average quantized components. Lake cells and search patches
summarize broad landscapes; use the city scene for local detail. Sidecars
record actual grid spacing, source aggregation spacing and all source URLs.
Water fill and waterway overlays pause while Embeddings is open so that lake
signatures remain visible and selectable; layer preferences are preserved.
The panel reports display spacing and source overview; brush size adapts to
cell spacing. Match cards report each patch's actual geographic size.

Reproduce with `satellite-embeddings.py --slug balqash --year YEAR --bounds
74.960 46.820 75.030 46.870 --index aef_index.csv`, or use
`--slug balqash-lake --bounds 72.80 44.80 79.20 47.40 --overview-level 5`.
Run for YEAR=2017 and 2025, then rebuild the search index.

## Embedding exploration tools

- **Shoreline** uses a clicked water example (or the normalized mean of painted
  examples). Every cell above the cosine threshold belongs to a *candidate*
  water-signature extent. Yellow raster edges separate matching/non-matching
  valid cells; outer scene edges and no-data boundaries are not coastlines.
  Areas use each latitude row's approximate ground-cell area. The comparison
  uses the same selected-year reference for both years and restricts all
  statistics to their shared valid coverage. Green/pink indicate matching
  extent gain/loss, not verified hydrological change. GeoJSON exports the
  selected year's cell-edge segments plus reference, years, threshold, grid
  spacing, statistics and caveat. Coarse lake cells cannot resolve fine shores.
- **Unusual** computes `1 - cos(centre, normalized mean of eight neighbours)`.
  It highlights local signature outliers, without deciding whether they are
  errors, disturbances or particular land-cover types.
- **Transitions** averages `1 - cos(left,right)` and `1 - cos(up,down)` at the
  chosen cell radius. It finds local spatial boundaries, not named classes.
  Both local tools require valid centre and all eight surrounding samples;
  the incomplete outer margin is excluded. The worker caches scores while
  threshold changes only recolour the raster. The radius is in display cells
  and its approximate distance is shown in metres/kilometres.
- **Timeline** reads the same selected cell across available annual grids.
  It plots distance from the first valid year and from the previous calendar
  year, identifies the largest consecutive-year shift and leaves gaps for
  missing data. Near-baseline signatures do not establish ecological recovery.
  Two concurrent requests read 64-byte HTTP ranges, with metadata/grid/year
  validation. If a static host ignores Range, a bounded-memory stream skips
  to the selected pixel and cancels immediately afterwards; bandwidth can be
  higher on such hosts. Annual series requests abort when the selection,
  location or mode changes. Full annual grids are not retained for the chart.

Balqash city and lake now include every year from **2017 through 2025**, on the
same grids and source levels described above. Other locations show only their
prepared years. The scene's underlying basemap remains Satlas 2023 in every
mode. Run the existing annual prefetch command for each year 2018–2024 to
reproduce the additions; the standard 2025 search index is unchanged.

Analysis verification: `node --test scripts/tests/embedding-analysis.test.mjs
scripts/tests/satellite-embeddings.test.mjs scripts/tests/embedding-search.test.mjs`.
Coverage includes isolated anomalies, spatial boundaries, common coverage,
cell-edge GeoJSON, missing years, shift/return trajectories, range-response
validation, streaming cancellation, and fixed-reference worker comparisons.

# Sentinel-2 / Sentinel-1 summer composites

`sentinel-change.py` prepares one composite per year for locations with
`hasSentinelChange` (currently `kok-zhailau`). The grid is laid out like
`satellite-embeddings.py` (about 10 m), but capped at 1024 px per edge
(`--max-size`) instead of 512, so Kok-Zhailau keeps about 15 m spacing. Sources are Microsoft Planetary Computer COGs, read with
anonymous SAS tokens, so no account is needed.

```bash
# Same venv as the embeddings (numpy + rasterio)
/tmp/kor3d-aef-venv/bin/python scripts/prefetch/sentinel-change.py \
  --slug kok-zhailau --bounds 76.943 43.075 77.130 43.175 --years 2017 2018 …
node --test scripts/tests/sentinel-change.test.mjs
```

Years already written are skipped, so a run interrupted by a dropped
connection resumes where it stopped (`--force` rebuilds). A year takes 1–3 minutes.

For each year and the `--season` window (default 1 July – 30 September,
mostly snow-free at 2000–3000 m):

- **Sentinel-2 L2A**: all acquisitions under `--max-cloud` %. Tiles from the
  same date are merged. Only scene-classification classes 4/5/6 (vegetation,
  bare, water) are kept, which drops cloud, cloud shadow, snow and dark
  topographic shadow. The +1000 DN offset of processing baseline ≥ 04.00
  (2022 onwards) is removed before NDVI and the bare-soil index (BSI) are
  computed. Bands are reduced to a per-pixel median.
- **Sentinel-1 RTC** (radiometrically terrain-corrected γ⁰): only the relative
  orbit present in the most years is used (129 ascending at Kok-Zhailau, all
  years 2017–2026). Pass the full year range when adding a year, so the
  orbit choice sees every year; prepared years are skipped. This keeps layover and shadow geometry identical between
  years. VV and VH are median-reduced in linear power, then converted to dB.

Output in `public/data/locations/{slug}/sentinel/`:

- `manifest.json`: grid, bounds, season, uint8 scales, orbit, and per-year
  scene counts plus every source item id.
- `{year}/indices.bin`: 4 interleaved uint8 bands per pixel (NDVI, BSI,
  VH dB, VV dB), rows north to south. 0 means no data; otherwise
  `lo + (q − 1) / 254 × (hi − lo)`.
- `{year}/truecolor.png`: RGB median, stretched 0–0.3 reflectance, γ 1.8.

In the app: **Sentinel change** (next to Embeddings) has three modes.

- **Change**: two years and one signal. *Vegetation loss* is an NDVI drop on
  pixels vegetated (NDVI ≥ 0.3) in the From year. *New bare ground* is a BSI
  rise on those same pixels. *Radar* is a VH change in dB, coloured both ways.
  Hectares use the true cell area.
- **Year of loss**: the first year in which NDVI fell below the first year by
  the threshold and stayed down in every later year with data. One-off dips
  from late snow, drought or residual cloud are ignored. Losses first seen
  in the newest year cannot be confirmed, so they are hidden unless
  "Include {year}" is ticked. Example: at Kok-Zhailau (bounds above), 667 ha
  first dropped in the dry summer of 2025. In 2026, 605 ha of that recovered
  and 62 ha stayed down.
- **Imagery**: the true-colour composites with a swipe. These are the only
  historical images in the app, since the basemap is Satlas 2023.

Click the terrain to list a pixel's yearly NDVI, BSI and VH. Changes show
where the surface changed, not why. Alpine meadows vary from summer to summer,
so check single-pair changes above about 2,800 m against Year of loss or the
imagery.

Data: Copernicus Sentinel (modified), processed via Microsoft Planetary Computer.

# Peaks and the Kok-Zhailau master plan

`node scripts/prefetch/overpass.mjs kok-zhailau` (or `--peaks-only`) writes
`peaks.json`: named OSM summits (`natural=peak|volcano`) and passes
(`natural=saddle`, `mountain_pass=yes`) inside `bounds`. Locations with
`hasPeaks` show them as **Peaks & passes (OSM)**. Each label uses the
local `name` (Kazakh/Russian) and `ele`; `name:ru` is often in the genitive
case ("Терешковой").

`public/data/locations/kok-zhailau/master_plan/` holds the Almaty Superski
master plan slide (`plan.webp`, © Kazakh Tourism Development) and
`master_plan.json`, a hand-traced GeoJSON of its lifts and stations. Turn it
on with **Resort master plan (approx.)**; **Show original plan image** opens
the slide beside the 3D view.

The slide is an oblique illustration (south at the top) with no coordinates,
and no georeferenced plan or EIA coordinates were found. Tracing method:

1. Each station's position relative to the plan's landmarks (Medeu, Mountain
   Kumbel, Three Brothers Rocks, Kokzhailau plateau, road to Almaty) gives a
   first guess.
2. The guess is moved to the nearest terrain at the elevation printed on the
   plan, using Mapterhorn z12 (matches OSM peak heights within ±15 m).
3. The top stations land next to OSM peaks of the same height: 3400 m by
   Терешкова (3435 m), 3252 m by Романтик (3250 m). The 2980 m station sits
   on the ridge from Три брата to Құмбел.
4. The base village is on the Kok-Zhailau meadow itself (the flat pasture at
   ~2200 m, 43.140 N 77.000 E, where the OSM track and bus No. 5 from the
   city end), not at the 1951 m printed on the plan. The 1450 m station is
   ~5 km west of it, toward Almaty.

Lifts are straight lines between stations; pistes are not traced. Each
feature has `confidence` (`medium`: within about 500 m; `low`: may be off by
1 km or more, drawn dashed and marked ≈). The 1450 m bottom station is the
least certain.

# Existing ski areas (OSM)

Locations with `ski: true` in `locations.mjs` get `ski.json` on a full
`overpass.mjs` run (or `--ski-only`). It holds lifts (`aerialway` ways with
their pylon nodes), stations and pistes (`piste:type` ways, plus route
relations whose member ways are not tagged themselves), fetched with
`out geom`. In the app, **Ski lifts & pistes (OSM)** (`hasSkiData`) draws
lifts as cables strung pylon to pylon and lays pistes on the terrain in the
usual colours: green novice, blue easy, red intermediate, black advanced,
dashed orange freeride.

Shymbulak in OSM (October 2026) has the lifts mapped completely: Medeu–Shymbulak
gondola, Combi-1, Combi-2, KKD-4, Sol Talgar, two T-bars, a rope tow, four magic
carpets, 10 stations and 45 pylons. Pistes are partial: 25 downhill ways (3 green,
8 blue, 13 red, 1 unrated) and the snow park, with few names and no black runs.
