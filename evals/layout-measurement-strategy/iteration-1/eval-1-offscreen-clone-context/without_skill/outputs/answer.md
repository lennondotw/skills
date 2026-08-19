# Why your off‑screen clone measures short

Short version: you're measuring the row **in the wrong styling context**. When you `appendChild` the clone to `document.body`, you rip it out of the subtree that gives it its size. Two things that live on ancestors — **container queries** and **inherited CSS custom properties** — stop resolving, and a third — **width** — is left unconstrained. The result is a node that computes a smaller layout than the real row, and it's worst exactly where those ancestors matter most: your themed "compact density" mode.

Let me break down each cause, because your bug is almost certainly a combination of all of them.

---

## 1. Container queries don't have a container anymore

Your real rows live inside a container that "uses container queries." That means somewhere up the tree there's an element with `container-type: inline-size` (or `size`), and your row's styles include `@container (...) { ... }` rules that change padding, line clamping, font size, direction of layout, etc.

A `@container` rule resolves against the **nearest ancestor that is a query container**. When you move the clone under `<body>`:

- There is no query container ancestor (unless `<body>` happens to be one, which it isn't).
- So **every `@container` rule fails to match** and falls back to the default (outside-any-container) styles.

If your compact layout, multi-line clamp, or reduced padding is expressed via container queries — which is the whole point of the container in your description — the clone renders as if the container were at its default/widest breakpoint. That typically produces a **shorter** box (fewer wrapped lines, tighter clamp, single-row instead of stacked layout).

This alone explains "a bunch of rows come back noticeably shorter."

## 2. Inherited custom properties evaporate

This is the big one for "compact density is especially wrong."

CSS custom properties (`--row-gap`, `--font-size`, `--line-height`, `--space-unit`, …) are **inherited**. Your density/theme system almost certainly sets them on a theme root or on the feed container:

```css
.feed[data-density="compact"] {
  --row-padding: 4px;
  --row-font-size: 13px;
  --row-line-height: 1.2;
}
```

The row reads them:

```css
.row {
  padding: var(--row-padding, 12px);
  font-size: var(--row-font-size, 15px);
  line-height: var(--row-line-height, 1.5);
}
```

When the clone is under `<body>`, it no longer inherits those variables. Every `var()` **falls back to its default** (the second argument, or the property's initial value, or `unset`). So:

- In _normal_ density, the clone accidentally lands near the fallback values, so it's only a little off.
- In _compact_ density, the real row is driven entirely by the compact variable overrides. The clone loses all of them and reverts to the fallbacks (which are your _comfortable_ defaults). So the clone renders larger font / more padding than compact...

—but you said compact comes back _shorter_, not taller. That points to the interaction with **width and container queries**: the compact container is also narrower or triggers a compact `@container` branch that wraps text differently. With the variables gone _and_ the container query gone, the text lays out at fallback font size across an unconstrained (usually too‑wide) width, wraps onto fewer lines, and the measured height collapses. Either way, the root cause is identical: **the clone is not inheriting the cascade that the real row lives in.**

## 3. Width is unconstrained, so wrapping is wrong

You set `position:absolute; visibility:hidden; height:auto` but you did **not** pin the width. An absolutely‑positioned block with no `width` and no positioning offsets shrinks/expands based on content and containing block, and in practice you get a width that has nothing to do with the real row's content-box width.

Row height for anything with text is a function of width (wrapping). Measure at the wrong width and you get the wrong number of lines and the wrong height. This is a classic virtualization measurement bug independent of the theming issue.

## 4. Web fonts may not be loaded yet

If you measure before the row's web font is ready, the browser lays out with a fallback font whose metrics differ, then swaps (`font-display: swap`) later and reflows. Your cached height is then stale/short. Any measurement strategy has to wait for `document.fonts.ready`.

---

## What to do instead

The governing principle: **measure the node inside the real styling context, at the real content width, after fonts are ready.** Don't lift it out of the tree.

You have two good strategies. Prefer the second if you can.

### Strategy A — Off‑screen measurement _inside a clone of the container_

If you must pre-measure before the row is on screen, don't append to `<body>`. Build a hidden measuring host that **reproduces the container hierarchy** — same container element with `container-type`, same density/theme attributes and classes, same width as the real content column — and put the row clone inside _that_.

```js
class RowMeasurer {
  constructor(realContainer) {
    // Clone the container chain that carries container-type + theme vars,
    // but empty of rows. Keep it attached so the cascade + container queries work.
    this.host = document.createElement("div");
    this.host.style.cssText = `
      position: absolute;
      top: 0; left: -99999px;   /* off-screen, NOT display:none */
      visibility: hidden;
      pointer-events: none;
      contain: layout style;     /* don't let it affect the page */
    `;

    // Recreate the container that defines the query context.
    this.container = realContainer.cloneNode(false); // shallow: attrs/classes only
    // Ensure it is a query container and matches theme/density.
    // (cloneNode copies class + data-* attributes, which usually carries this.)
    this.host.appendChild(this.container);
    document.body.appendChild(this.host);

    this.ro = new ResizeObserver(() => {}); // optional
  }

  setWidth(px) {
    // Pin the container to the real content-box width so wrapping matches.
    this.container.style.width = px + "px";
    this.container.style.containerType ||= "inline-size";
  }

  measure(rowNode) {
    const clone = rowNode.cloneNode(true);
    clone.style.height = "auto";
    this.container.appendChild(clone);
    const h = clone.getBoundingClientRect().height;
    this.container.removeChild(clone);
    return h;
  }
}

// usage
await document.fonts.ready;
const measurer = new RowMeasurer(realFeedContainer);
measurer.setWidth(realFeedContainer.clientWidth); // or the exact content width
const height = measurer.measure(rowTemplateNode);
```

Key differences from your version:

- The clone lives inside a **real query container** (`container-type: inline-size`), so `@container` rules match.
- The container carries the **same classes / `data-density` / theme attributes**, so the custom properties are inherited and compact mode resolves correctly. If your variables are set higher up (e.g. on `<html data-theme>` or a provider), also copy those onto the host, or mount the host _inside_ the theme root instead of `<body>`.
- **Width is pinned** to the real content width, so text wraps identically.
- Use `left: -99999px` + `visibility: hidden`, **not** `display: none`. `display: none` yields a zero/absent layout and `getBoundingClientRect()` returns zeros; also container queries on a `display:none` subtree don't lay out.
- Measure **after `document.fonts.ready`**.
- `contain: layout style` (and keeping it off-screen) prevents the measuring host from perturbing the page.

Match `box-sizing`, and remember `getBoundingClientRect().height` is the **border-box** height including padding and border but **excluding margins**. If your virtualizer positions rows using margin-collapsed spacing, add the row's vertical margins explicitly.

### Strategy B (preferred) — Measure the _real_ rows and cache, don't pre-clone

Cloning is fragile: you have to keep the measuring context perfectly in sync with the real one (theme changes, density toggles, viewport-driven container breakpoints, font loading). The more robust pattern used by mature virtualization libs is **measure-on-mount with an estimate + correction**:

1. Start with an **estimated** row height (a constant, or a cheap heuristic from content length) so you can position rows immediately.
2. When a row actually mounts into the real container, measure its real rendered height with `ResizeObserver` / `getBoundingClientRect()` — this is by definition in the correct context, correct width, correct theme, post-font.
3. **Cache** the measured height keyed by row id, and reconcile the scroll offsets (adjust the running offset map by the delta). Re-measure on width/density/theme changes.

```js
const measured = new Map(); // id -> height
const estimate = 72;

function getHeight(id) {
  return measured.get(id) ?? estimate;
}

const ro = new ResizeObserver((entries) => {
  let dirty = false;
  for (const entry of entries) {
    const id = entry.target.dataset.rowId;
    const h = entry.borderBoxSize?.[0]?.blockSize ?? entry.target.offsetHeight;
    if (measured.get(id) !== h) {
      measured.set(id, h);
      dirty = true;
    }
  }
  if (dirty) scheduleReflow(); // recompute offsets, keep scroll anchored
});

// when a row element mounts:
ro.observe(rowEl); // rowEl.dataset.rowId = id
```

This eliminates every one of your four bugs by construction, because you never measure outside the real context. The only cost is a brief correction on first paint of each row, which `ResizeObserver` makes cheap and jank-free. If you're on React, this is exactly what TanStack Virtual's `measureElement` / dynamic mode does — worth using rather than hand-rolling.

- Invalidate the whole cache on `container` width breakpoints, density toggles, and theme changes (a `ResizeObserver` on the container plus a mutation/observer on the theme attribute).
- Re-run after `document.fonts.ready` once at startup.

---

## Recommendation

- If you can tolerate a one-frame correction (almost everyone can): use **Strategy B**. It's the correct model for container-query + custom-property-driven rows because "the height" genuinely depends on runtime context, and the only source of truth is the real DOM.
- If you truly need the height _before_ the row exists on screen: use **Strategy A**, but understand you are signing up to keep the measuring host's container type, theme variables, width, and font state in lockstep with reality forever. Mount the host **inside the theme/density root**, make it a real query container, pin the width, and wait for fonts.

Whatever you pick, drop `document.body` as the measurement parent — that single choice is what's throwing away your container queries and your compact-density variables and producing the short rows.
