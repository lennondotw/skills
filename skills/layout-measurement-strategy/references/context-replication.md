# CSS context replication — the off-flow travel list

If you measure off-flow (pattern B) instead of in-place (pattern A), the node loses everything its ancestors gave it. Here is the full list of what must travel with it, why it matters, and how each fails silently if it doesn't. **Reproduce ancestors — do not copy computed styles onto the node.** Copying `getComputedStyle` values freezes resolved lengths and kills anything that must re-resolve at the new width (`%`, `em`, `ch`, `fit-content`, container queries all die).

## Inherited properties that change size

These inherit by default, so a probe under `document.body` gets `body`'s values, not the real ancestors':

- **Font stack, `font-size`, `font-weight`, `font-style`, `font-stretch`, `font-feature-settings`, `font-variation-settings`** — change glyph advance → change wrapping → change block-size.
- **`line-height`** — scales block-size per line directly. The most common single source of off-by-N-pixels.
- **`letter-spacing`, `word-spacing`, `tab-size`, `white-space`, `text-transform`, `hyphens`, `word-break`, `overflow-wrap`, `text-wrap` (balance/pretty)** — all move line breaks. `text-wrap: balance`/`pretty` redistribute lines, so a probe without them measures a differently-wrapped block.
- **`direction` / `writing-mode`** — determine which physical axis is the block axis. A probe that fixes physical `width` and reads physical `height` measures the wrong axis under `writing-mode: vertical-rl`. Fix the **inline** size, read the **block** size.
- **Custom properties (CSS variables)** — inherited. If the node uses `padding: var(--gap)` or `font-size: var(--fs)` defined on a real ancestor or a themed wrapper, a probe under `body` gets the fallback or `:root` value. **Variables are the most common thing that silently reverts.**

## Non-inherited but structurally required

- **Ancestor classes / attributes that drive descendant selectors** — `.dark`, `[data-density="compact"]`, `.rtl`, `:where(.theme-x) &`, `:has()` conditions. If real styling depends on `.compact .card { padding: 4px }`, a probe without a `.compact` ancestor gets default padding → wrong height. Reproduce the **ancestor chain** any descendant combinator or `:has()` relies on.
- **Available inline size** — fix it to the real content-box/border-box inline size (get it from the real slot via `getBoundingClientRect()` before detaching; account for `box-sizing`).

## Container queries — the sharpest off-flow break

`@container (min-width: 400px) { .card { … } }` resolves against the nearest ancestor with `container-type: inline-size` (or `size`), matching `container-name` if named. The queried element's **content-relevant** styles (font-size, line-height, padding, `display`, column count, `line-clamp`) flip based on the _container's_ size — invisible in the element's own CSS.

Off-flow this breaks three ways:

1. **No container ancestor** → `@container` rules never match → element styles as if the container were absent → different height.
2. **Wrong-sized container** (an accidental `container-type` high up, or on your probe wrapper) → matches the wrong breakpoint → wrong styles.
3. `container-type: inline-size` also establishes **size containment on the block axis + layout/style containment** — putting it on the wrong element distorts or zeroes the read.

To measure a container-queried node off-flow you must reproduce `[query container @ real inline-size] > [node]` at the same nesting depth, and keep the container's width in sync (a `ResizeObserver` on the real container feeding the probe container). Because that requires knowing the real layout anyway, **container-queried content is the strongest case for in-place / portal-in-subtree measurement.**

## Shadow DOM / constructable stylesheets

A node in a shadow root is styled by that root's `adoptedStyleSheets` + inner `<style>`, plus inherited properties that pierce the boundary (font, color, custom properties — inheritance crosses shadow boundaries; author rules do not). A probe in the light DOM or a _different_ shadow root **loses every shadow stylesheet** → the node renders unstyled-ish → wrong size.

To measure a shadow node off-flow, mount the probe **inside a shadow root that adopts the same `CSSStyleSheet` objects** — constructable stylesheets make this cheap: share the sheet object, don't clone. Custom properties still need reproducing as inherited values into that root.

## The three strategies, ranked by fidelity vs cost

1. **In-place (pattern A) — `visibility: hidden` content behind a placeholder.** Highest fidelity: nothing to replicate because nothing moved. The correct default.
2. **Portal-in-subtree.** Render the probe via a portal mounted _within the real ancestor chain / shadow root_, positioned `absolute` off-view (`inset-inline-start: -10000px`). Keeps inheritance, variables, container, and shadow sheets while leaving flow. Middle cost, high fidelity — good for lists where per-row in-place is too heavy.
3. **`cloneNode(true)` into a matching wrapper on `body`.** Lowest fidelity, highest burden — you manually reconstruct font/line-height/variable context, the query container at the right size, and (if shadow) a root with shared adopted sheets. Every item above is a step you can forget. Use only when 1 and 2 are impossible (measuring before the real subtree exists), and **replicate ancestors, never copy computed styles onto the node.**

## Placeholder height & list stability (avoiding CLS)

A placeholder with no reserved block-size collapses, then expands when content lands → layout shift, felt as a scroll jump; in a virtualized list it cascades. Choose the min-height in this order:

1. **Best — reserve the known intrinsic size.** `content-visibility: auto` + **`contain-intrinsic-size: auto <last-rendered-size>`** tells the browser to remember and reuse the last real size, eliminating the shift on re-entry. Purpose-built for list/preview stability; directly replaces hand-rolled placeholder heights.
2. **Good — a computed estimate** (text: char-count × avg line box; media: `aspect-ratio` + known inline size).
3. **Acceptable — a min-height floor sized to the common case**, paired with `contain-intrinsic-size` so first paint isn't zero.
4. **Avoid — a fixed pixel height that's wrong for variable content** (trades CLS for clipping / dead space).

**Cooperate, don't compete:** when you _do_ off-flow measure, cache the result and feed it back as `contain-intrinsic-size`, so the exact-measurement and the browser's self-correcting placeholder reinforce each other instead of re-measuring on every reveal.

## How bad measurement surfaces as visible jank

Bad numbers are nameable UI defects — each argues for the reject-border-only guard:

- **Badge / corner overlay sliding onto or off a near-zero tile** — positioned at `top: ~2px` when the tile "is" 2px. → don't place against an un-laid-out box.
- **Concentric corner geometry breaking** (`r_inner = r_outer − inset`) — a collapsed container makes inner radius go negative (clamps square) or insets compute against ~0 → child pokes out of the rounded corner.
- **Content clipping into a 2px slit** — `overflow: hidden` + measured-to-0 height: children exist in the DOM but paint into a slit. Deceptive — QA screenshots look "empty," not "broken."
- **Expand / FLIP animation reading a border-only endpoint** — "shoots up from nothing" or overshoots. Suspect the measured endpoint, not the easing.

The guard is not a widget-specific special case — it's the general assertion that **a valid intrinsic measurement contains a non-zero content contribution when the element has content.** Treat a collapse as "layout hasn't happened yet," wait for a real frame, and never let downstream geometry consume a chrome-only number.
