# Measuring feed-row heights for virtualization

## Short version

Your clone renders _shorter_ than the real row because you moved the node out of the context that gives it its height. A layout size isn't a property of the element — it's the output of a function whose inputs are (1) the real inline width it's laid out against, (2) the full CSS context of its ancestors, and (3) whether its content (fonts/images) is ready. When you `appendChild` the clone to `document.body`, you keep the element but throw away inputs (1) and (2). The number you read back is confidently wrong, and the browser never signals that it's provisional.

Specifically, appending to `document.body` silently drops:

- **CSS custom properties** — your spacing and font-size come from `--vars` set on the feed container. On `document.body` those vars are unset, so they fall back to initial values (often `0`, or the browser default font size). Smaller padding + smaller/again-defaulted font ⇒ fewer wrapped lines ⇒ **shorter box**. This alone explains "a bunch of rows come back noticeably shorter."
- **Ancestor classes / attributes that drive descendant selectors** — your themed **compact density** almost certainly keys off something like `[data-density="compact"]` or a `.compact` class on the container. Selectors like `[data-density="compact"] .row { --row-gap: … }` simply don't match once the clone is a child of `body`. That's exactly why compact mode is _especially_ wrong: it's the mode whose styling lives entirely in an ancestor the clone no longer has.
- **The `@container` query context** — container queries resolve against the nearest ancestor with `container-type`. Off in `document.body` that container is gone, so every `@container` rule evaluates as if the container were the viewport (or defaults). Font sizes and spacing that flip at container breakpoints resolve to the wrong branch ⇒ wrong wrapping ⇒ wrong height.
- **The real inline width** — your clone is `position:absolute` with no width, so it shrinks/expands to something other than the real column width. Since height is a function of width (text wraps against available inline size), a different width gives a different line count and a different height. A row that wraps to 3 lines in the real column might fit on 2 lines in the clone.
- **Shadow-root `adoptedStyleSheets`**, if any part of the row is in a shadow tree.

Any one of these makes the read wrong; you likely have several stacking. The common thread: **you measured a different element than the one you'll render.**

## What to do instead

Order of preference:

### Option A (best): measure in place, in the real container

Don't move the node to `document.body`. The cheapest correct measurement keeps the containing block, formatting context, container-query ancestor, inherited custom properties, and theme classes — because _nothing moved_.

Render the row (or its measuring clone) **inside the real feed container**, at the real column width, off-_flow_ but not off-_context_:

- Keep it a descendant of the same container that carries `[data-density]` and `container-type` and the `--vars`.
- Take it out of the visible flow with `position:absolute; visibility:hidden` **but leave `height:auto`** so it sizes to content, and give it the **real column width** (e.g. `width: 100%` inside a wrapper that's the column width, or an explicit `width: <colWidth>px`).
- Never set `height:0` on the thing you're measuring — under `overflow:hidden`/flex/grid you'd read back the constrained `0`, not the intrinsic size.

```ts
// containerEl is your real feed container (has [data-density], container-type,
// and the --spacing/--font custom properties on it or an ancestor).
function measureRowHeight(
  containerEl: HTMLElement,
  rowNode: HTMLElement,
  columnWidthPx: number,
): number {
  const probe = document.createElement("div");
  probe.style.cssText = [
    "position:absolute",
    "visibility:hidden",
    "left:-99999px", // keep it off-screen but still laid out & in-context
    "top:0",
    "height:auto", // MUST stay auto so it sizes to content
    "contain:layout", // isolate its layout, avoid disturbing the real feed
  ].join(";");
  probe.style.width = `${columnWidthPx}px`; // pin the REAL inline size
  probe.appendChild(rowNode); // rowNode is a fresh clone of the row

  containerEl.appendChild(probe); // <-- in the real context, NOT document.body
  // border-box, integer, transform-immune, and it triggers the sync layout we need:
  const h = probe.offsetHeight;
  containerEl.removeChild(probe);
  return Math.ceil(h); // ceil so a rounded-down px can't crop the last line
}
```

Because the probe lives inside `containerEl`, `[data-density="compact"] .row {…}` matches, `@container` rules resolve against the real container, and the `--vars` inherit correctly. Compact mode now measures compact.

### Option B (often best of all): don't measure — let the layout engine hold the space

For a virtualized feed, you may not need to pre-measure at all. Modern CSS can virtualize for you:

```css
.feed-row {
  content-visibility: auto;
  contain-intrinsic-size: auto 120px; /* last-seen size; the browser remembers real sizes */
}
```

`content-visibility: auto` skips rendering/layout work for off-screen rows (the perf win you're virtualizing for), and `contain-intrinsic-size: auto <estimate>` lets the browser reserve space and then **remember the real rendered size** once a row has been laid out once — self-correcting, no JS measurement, no font/image race. If your feed's constraints allow it, this removes the whole measurement bug surface. (One caveat: putting a _probe_ under `content-visibility:auto` would defeat itself — it skips layout while off-screen — so this is a rendering strategy, not something to combine with an off-screen probe.)

### Option C: if you truly need JS numbers, observe and settle — don't snapshot

Content arrives late: web fonts swap (fallback metrics give shorter line boxes), images load, async children stream. A single synchronous read can catch the row mid-settle and under-report height. So:

- Before trusting text heights, `await document.fonts.ready`.
- For images/replaced content, `await img.decode()` or let a `ResizeObserver` catch the reflow.
- Prefer a **`ResizeObserver`** on the in-context probe and take the _settled_ value (stable across two consecutive callbacks), then disconnect. RO fires after layout, before paint, and re-fires on every change, so "is the geometry final?" becomes an event instead of a guess.

### And: reject border-only / collapsed reads

Whatever path you pick, guard the consumer. If a row _has_ content but measures to roughly just its border/padding (or near-zero), that means layout hasn't happened yet — not that the height is zero. Refuse it rather than positioning rows against it:

```ts
function isTrustworthy(borderBoxH: number, chromeH: number, prev?: number): boolean {
  if (!Number.isFinite(borderBoxH) || borderBoxH <= 0) return false;
  if (borderBoxH - chromeH <= 1) return false; // border-only: layout not done
  if (prev != null && borderBoxH < prev * 0.25) return false; // implausible collapse
  return true;
}
```

## A few implementation notes

- **Clone deeply and keep the row's own classes.** `rowNode = realRow.cloneNode(true)`. The clone's own classes come along; what you were missing was the _ancestors'_ classes and vars — fixed by appending inside the real container.
- **Pin the exact column width, including final scrollbar-gutter state.** If the real feed has a scrollbar and the measuring pass doesn't (or vice versa), the inline size differs and heights drift. Measure at the width the row will actually occupy.
- **Pick one box and stay in it.** `offsetHeight`/`getBoundingClientRect().height` are border-box; `clientHeight`/`contentRect` are content-box. Use `offsetHeight` here (integer, transform-immune). If any ancestor applies a `transform: scale(...)`, avoid `getBoundingClientRect` (it reports the scaled size).
- **Watch margin collapse.** A row child's top/bottom margin can collapse _through_ an auto-height wrapper, so the measured box comes back short by the collapsed margin. Give the measured wrapper its own block formatting context (`display: flow-root`) so child margins stay inside the number.
- **Batch if you measure many rows at once.** Do all DOM writes, then all reads — one forced layout instead of O(N). Never interleave a layout-dirtying write between reads.

## TL;DR

The bug is `document.body`: it strips the custom properties, the `[data-density]`/theme ancestor classes, the container-query context, and the real column width — all inputs to the row's height. Compact density is worst because its entire styling hangs off an ancestor the clone lost. Fix it by measuring **in place inside the real feed container** at the **real column width** with `height:auto` (Option A), or better, let CSS `content-visibility: auto` + `contain-intrinsic-size` reserve and self-correct the space (Option B). Wait for fonts/images to settle and reject border-only reads before committing any number to row positioning.
