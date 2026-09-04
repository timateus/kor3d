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
