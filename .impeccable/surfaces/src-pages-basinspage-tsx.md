---
version: 1
slug: "src-pages-basinspage-tsx"
primary_target: "src/pages/BasinsPage.tsx"
related_targets: []
---

# Surface: /basins — Central Asia river-basin population map

**Scope**: `/basins` route only (`src/pages/BasinsPage.tsx`). Not the rest of kor3d.
**Visitor mode**: Experience — the visitor explores the map itself; no task, no conversion, no funnel.
**Audience**: Tim (the builder) and other curious people interested in Central Asian geography/hydrology/ecology. Small, self-selecting, not a mass audience.
**Job**: understand which river/lake basins carry Central Asia's population, and how concentrated that is, by exploring a real geographic map — not reading a stat table.
**Proof/content**: real HydroBASINS/HydroRIVERS/GHS-POP data, already fetched and baked to `public/data/basins/*.json`. No invented numbers.
**Constraints**: no third-party basemap tiles (CSP / no imagery license); data covers KZ/UZ/TM/TJ/KG only; solo-maintained, no design system beyond this brief.

## Direction contract

**THESIS**: The map refuses to render all 112 basins as equally important. It foregrounds only the three basins that carry most of the region's population (Сырдарья, Амударья, Иле-Балхаш) in indigo ink, and lets the other 109 recede to bare ghost outlines — hierarchy made of absence, not chrome. Refuses: the full-bleed rainbow choropleth dashboard (shipped twice already and rejected as generic), and its predictable opposite, quiet editorial-minimal color-drained cartography.

**OWN-WORLD**: Palette — warm plaster ground `#eae4d6`; ghost basins `#dcd4bf` fill / `#b3a98f` outline; indigo ink family for the three primary basins (`#46557e` for Сырдарья, `#7386ad` for Амударья and Иле-Балхаш); dark umber/bronze for grounding rule-lines. Type — Noto Serif Display italic, light weight, for the vertical-set off-center title and basin/city names (a considered choice, not the default AI serif list); JetBrains Mono (already kor3d's own family) thin weight for tabular figures, kept restrained. Composition — asymmetric: the map fills the left ~58–62% of the frame; the right third stays deliberately empty except a quiet ruled list ("stems") of the three named basins and their population figures; a vertical Cyrillic title sits in the left margin, not a horizontal header bar. No stat-tile row, no nav chrome above the fold.

**STORY**: A visitor opens the page and reads, in one glance, that three shapes matter most (by ink) while the rest of the territory is quiet and waits to be explored — click/hover on any of the 109 ghost basins reveals its own numbers on demand (existing tooltip convention, kept). The absence of color across ~97% of the map's area *is* the information: population concentrates in a handful of basins, and the page enacts that concentration rather than only stating it in a stat tile.

**FIRST VIEWPORT**: Plaster ground; vertical italic title "центральная азия" in the left margin (~48px from edge, `writing-mode: vertical-rl`); the whole five-country outline visible at once, occupying the left ~60% of the frame; Сырдарья in full indigo ink, Амударья and Иле-Балхаш in the lighter indigo accent, all other basins pale ghost outlines with no fill; right third holds the ruled stem-list (three basin names + population figures in mono type) plus a one-line note on how many minor basins remain unlit ("+109 малых"). Level selector (9 vs 112) and the existing click/hover tooltip interaction are preserved from the current build, restyled into this world, not removed.

**FORM**: Direction 5 of my own 7-candidate Central-Asia-world list, dice-assigned by `concept-seed --scope direction --mode experience` (seed key `335d1098`); the first assigned/pick/challenger round was rejected by the user as still generic; re-rolled once at the user's request with `--register bolder`. This build is the `growth-metamorphosis-branching-ikebana-ma-arrangement` challenger from that bolder hand, which won on both audience identification and product clarity against the assigned leather-skeuomorph challenger; the user picked it over the competing `pop-culture-shelf-sukeban-long-skirt-code` alternate ("Кодекс формы").

**FINISH**: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

## Unresolved decisions

- Exact composition when switching to the "Крупные (9)" level — the three-primary/ghost hierarchy was designed against the 112-basin ("По речным системам") view; at 9 basins the same three (Сырдарья, Амударья, Иле-Балхаш) still dominate by population, so the same ink/ghost split carries over unchanged.
- Whether the vertical title is legible/acceptable on narrow mobile viewports — needs a real responsive pass, not just a proportional shrink.
- No approved comp exists (code-led, no image generation available this session) — the two `.impeccable/direction-preview/{uniform-code,ma}.html` HTML comps built during the direction round are the closest thing to a locked reference; `ma.html` is what the user approved.
