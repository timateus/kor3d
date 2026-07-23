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
