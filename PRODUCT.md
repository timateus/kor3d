# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Tim (the builder) and other curious people who land on the site — a small, self-selecting audience of people interested in Central Asian geography, hydrology, and ecology. Not a mass consumer audience; no accounts, no funnel, no conversion goal. Current focus of active work is a single surface, `/basins` (river/lake basin population map of Central Asia), not the rest of the app.

## Product Purpose

kor3d fuses real hydrological/ecological datasets into explorable terrain and maps, so a curious visitor can fly through or click around a place and come away understanding something true about it (a river's course, a glacier's retreat, a basin's population pressure) — not just look at a pretty render.

## Positioning

Unlike Google Earth or a generic map, every layer is a specific dataset (HydroSHEDS/HydroBASINS, HydroRIVERS, GHS-POP, glacier outlines/mass balance, OSM extracts) fused directly into a flyable 3D terrain or an interactive 2D map — the visualization *is* the data, not a basemap with pins on top.

## Operating Context

Static site on GitHub Pages (`timateus.github.io/kor3d`), built with Vite/React/Three.js. Individual locations (Aral Sea, Balqash, Almaty, Alakol, Caspian Sea, Suaq, Tuyuksu Glacier, Seliger, Garibaldi-Squamish) each get a 3D terrain page; `/basins` is a 2D SVG/D3 map covering all of Central Asia at once rather than one location. Data is pre-fetched/baked to static GeoJSON/JSON under `public/data/` — no backend, no live API calls at runtime except loading D3 from a CDN.

## Capabilities and Constraints

- No page tiles/imagery from third-party map providers are used on `/basins` — it's drawn from raw vector data (basin polygons, rivers, city points), not a basemap.
- Data is real: HydroBASINS v1c (Lehner & Grill, 2013), HydroRIVERS v1.0, GHS-POP R2023A (JRC). No fabricated numbers.
- `/basins` currently covers Kazakhstan, Uzbekistan, Turkmenistan, Tajikistan, Kyrgyzstan only (clipped out of neighboring countries).
- Solo-maintained; no design system, no component library beyond shadcn/Radix primitives already in the app shell.

## Brand Commitments

None binding for `/basins` specifically — explicitly confirmed open to establish its own visual identity, independent of the rest of kor3d's look (which itself uses Sora/Space Grotesk/JetBrains Mono/Instrument Serif, loaded globally, but that is not a constraint for this surface).

## Evidence on Hand

- Live reference: https://timateus.github.io/kor3d/basins
- Source: `src/pages/BasinsPage.tsx`
- Data: `public/data/basins/*.json` (basin polygons at two granularities, country borders, merged river network)
- Prior Impeccable critique snapshot: `.impeccable/critique/2026-09-25T13-01-32Z__src-pages-basinspage-tsx.md` — flagged the page as a "generic dashboard shell wearing Central Asia's data," structurally swappable to any other region with no changes, disconnected from the rest of kor3d's own type identity.

## Product Principles

1. The visualization is the data — no decorative chrome that isn't earning its place explaining a real number or shape.
2. Every distinctive choice should be traceable to something only *this* region/subject has (its rivers, its aridity, its water-stress history) — not a swappable dashboard template.
3. Solo-built and free — no visual debt to preserve, no stakeholder sign-off, but real data stays real (no invented specifics).
