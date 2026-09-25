---
target: Central Asia basins map (/basins page)
total_score: 17
max_score: 32
na_heuristics: 7,10
p0_count: 2
p1_count: 3
target_identity: "file:/Users/tim/Projects/kor3d/src/pages/BasinsPage.tsx"
target_fingerprint: "sha256:551ce88120219eb52673b8ee19a6ac8969bf8f69dca1feb65bd9a702e6647582"
target_path: /Users/tim/Projects/kor3d/src/pages/BasinsPage.tsx
timestamp: 2026-09-25T13-01-32Z
slug: src-pages-basinspage-tsx
---
Method: dual-agent (A: abb38e2ce409b3f87 · B: a5da09118e1cee48f)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2/4 | Loading state is static centered text, no motion/skeleton; no zoom-level indicator once zoomed |
| 2 | Match System / Real World | 3/4 | Correct Russian geography/terminology; "население и плотность — по клику" undersells that both stats are click-gated |
| 3 | User Control and Freedom | 1/4 | **Reset-view button was dropped during the React port — confirmed absent in source and DOM.** Zoomed/panned state has no escape but a full page reload |
| 4 | Consistency and Standards | 3/4 | Scroll-to-zoom with zero on-canvas +/- controls breaks the map-UI convention every competitor (Maps, Mapbox) uses as a discoverability backstop |
| 5 | Error Prevention | 3/4 | `Promise.all` + try/catch is reasonable; one JSON 404 nukes the whole page instead of degrading gracefully |
| 6 | Recognition Rather Than Recall | 2/4 | 112 basins get arbitrary rainbow hues with **zero color→name legend** — identity is recall-only, one click at a time |
| 7 | Flexibility and Efficiency | n/a | Read-only exploration surface; no power-user path expected |
| 8 | Aesthetic and Minimalist Design | 2/4 | 5 stacked chrome bands before content on mobile; dense city labels collide at default zoom |
| 9 | Error Recovery | 1/4 | Error state is one static sentence, no retry, no distinction between CDN failure / 404 / network loss |
| 10 | Help and Documentation | n/a | Appropriate to omit for this surface type |
| **Total** | | **17/32** | **Acceptable (53%)** |

## Design Specificity Verdict

**LLM assessment**: Mostly a generic dashboard shell wearing Central Asia's data. The header citations, basin names, and underlying geometry are genuinely specific — but the interaction/visual system (golden-angle rainbow fill, generic stat-tile header, plain `<select>`, dark-slate chrome) is an off-the-shelf choropleth-explorer pattern that could be relabeled for any other region with zero structural change. Nothing in the palette or layout signals what this data is actually *about* — population pressure on water in one of the most water-stressed regions on earth. The page also sits inside `kor3d`, a site with its own established type identity (Sora/Space Grotesk/Instrument Serif, loaded globally via `index.html`), but this page uses none of it — Tailwind's unconfigured default sans stack instead — so it reads as visually disconnected from its own app shell.

**Deterministic scan**: `impeccable detect --json src/pages/BasinsPage.tsx` → 1 finding, `overused-font` (BasinsPage.tsx:315, `font-family:'Inter'` on `.bp-city-label`). Not a clean false positive: Inter is never actually loaded on this route (no `<link>`), so the declaration silently falls back to system sans-serif anyway — the rule caught a real dead declaration, just not for the reason it thinks.

**Visual overlays**: No persistent overlay was left in a user-visible tab (each assessment ran in its own isolated tab per protocol); Assessment B confirmed script-injection mutation is unrestricted on this page (no CSP blocking), so a live overlay pass is available on request.

## Overall Impression

The map itself is well-built underneath — accurate geography, correct population math, a genuinely clever click-to-pin tooltip, zoom-aware label scaling. But it shipped with a load-bearing control missing (reset-view, present in the original artifact, lost in the React port) and a color system that answers the wrong question: 112 hand-picked-feeling hues encode *which shape is which*, when the page's entire reason to exist is *how much/how dense*. Fix those two and the accessibility gaps, and this goes from "acceptable" to genuinely good.

## What's Working

1. **Click-to-pin tooltip** (`pinned` state) — mouse can leave to read the numbers, second click toggles off. Correct affordance for a data-reading task, not just a hover flash.
2. **Zoom-aware city/label scaling** (`base / event.transform.k`) — dots and text shrink appropriately under zoom instead of ballooning into a pin-wall.
3. **Tooltip edge-avoidance** — genuinely keeps the tooltip on-screen near map edges, a detail most quick dashboards skip.

## Priority Issues

**[P0] Reset-view control is missing entirely**
- Why it matters: confirmed in source (no button, no keyboard shortcut) and live DOM (`document.querySelectorAll('button')` → 0 elements page-wide). Once a user scroll-zooms or pans, their only way back to the full map is a hard page reload — which also discards their selected granularity level and any pinned selection. This existed in the original Claude Artifact and was silently dropped porting to `BasinsPage.tsx`.
- Fix: restore the button (`svg.transition().call(zoom.transform, d3.zoomIdentity)`) and wire `Escape` to the same action.
- Suggested command: `/impeccable polish`

**[P0] Color encodes identity, not the magnitude the page exists to show — with no legend**
- Why it matters: population/density is a magnitude question; a golden-angle rainbow is a categorical/identity encoding. Users cannot compare two basins' density at a glance — they must click every shape, one at a time, to learn even its name. Detector-independent, but Assessment B confirms zero legend markup exists (no `role`/labeling near the map, no color-key DOM element).
- Fix: either switch the default view to a sequential density scale with a color-mapped legend bar (directly answers "where is it denser"), or keep categorical identity color but add a synced legend list of the currently-visible features.
- Suggested command: `/impeccable colorize`

**[P1] Zero keyboard/ARIA accessibility on the entire map surface**
- Why it matters: only 2 elements on the whole page are Tab-reachable (the back link and the level-select). All 122 basin `<path>` elements have `tabindex: null`, `role: null`, `aria-label: null` — a keyboard or screen-reader user cannot access a single basin's data. The tooltip has no `aria-live`, so even a sighted mouse-only assumption breaks for anyone using assistive tech.
- Fix: add `tabindex="0"` + `role="button"` + `aria-label` (basin name, population) to each basin path, keyboard Enter/Space to trigger the same click handler, and `aria-live="polite"` on the tooltip container.
- Suggested command: `/impeccable audit`

**[P1] Mobile layout breaks its own fixed-canvas contract**
- Why it matters: the component is built as `h-screen flex-col overflow-hidden` — clearly intended as a fixed, non-scrolling canvas. At 375×812 the header paragraph + 3 stat tiles + level-selector row + hint text stack to ~830px before the map starts, forcing page scroll and pushing the actual map (the entire point of the page) below the first viewport.
- Fix: collapse the description and stat tiles into a condensed single row (or a details toggle) under ~640px so the map stays dominant and immediately visible.
- Suggested command: `/impeccable adapt`

**[P1] Error state is a dead end**
- Why it matters: any fetch/CDN failure renders one static sentence with no retry and no distinction between "D3 CDN blocked," "one JSON 404'd," or "network down." A user who hits this has no recovery path but reload.
- Fix: add a retry button that re-runs the fetch effect; surface which specific resource failed.
- Suggested command: `/impeccable harden`

## Persona Red Flags

**Jordan (First-Timer)**: Lands on 112 differently-colored shapes and a subtitle claiming "each basin — its own color," with no key telling them what any color means. Hover affordance is a subtle `brightness(1.1)` filter — easy to miss; nothing on first load signals the shapes are clickable.

**Sam (Accessibility-Dependent)**: Cannot reach a single basin by keyboard. Screen reader gets two focusable elements on the entire page and no announcement when a tooltip appears. This isn't a partial gap — the primary interaction (click a basin for its data) is completely inaccessible to this persona.

**Casey (Mobile)**: By the time Casey scrolls past header/stats/selector chrome to reach the map, most of the initial screen is already spent — a poor discovery path for a page whose entire value is the map. City labels also visibly collide at default mobile zoom (confirmed: "Джалал-Абад" overlapping "Худжанд" in the 375px screenshot).

## Minor Observations

- `.bp-city-label` declares `font-family:'Inter'`, but Inter is never loaded on this route (no `<link>`) — silently falls back to system sans-serif. The detector's `overused-font` flag on this line is technically about the wrong font (Inter isn't rendering at all) but correctly points at dead CSS.
- The page loads none of kor3d's own custom type (Sora/Space Grotesk/Instrument Serif already paid for globally via `index.html`) — Tailwind's unconfigured default sans renders instead, so headings look generic rather than matching the rest of the site.
- Internal naming is inverted from UI labels (`levelKey: 'main'` = the 112-basin dataset shown as "По речным системам"; `lvl3` = the 9-basin aggregate shown as "Крупные") — invisible to users, a maintenance trap.
- `stats.pop`/`stats.area` formatting manually string-replaces d3's SI-prefix letters (G/M/k → млрд/млн/тыс) — fragile if d3.format ever returns a prefix outside that set.
- Direct navigation to `/kor3d/basins` 404s on GitHub Pages before the SPA-fallback redirect resolves it — not user-visible (redirect lands at 200), but worth knowing if this URL is ever shared as a deep link from an external, redirect-stripping context.

## Questions to Consider

1. What would this look like with a sequential density scale as the default, legend included — and would anything real be lost by dropping the rainbow?
2. The header cites HydroBASINS/GHS-POP with real rigor, but nothing frames *why* Central Asian basin density matters (Aral Sea desiccation, transboundary water stress) — is this meant as a pure technical data-explorer, or should the framing carry more of that tension?
3. Was the reset-view control cut on purpose during the port, or just missed — and on mobile, where discovery is already harder, what's the intended recovery path today besides a reload?
