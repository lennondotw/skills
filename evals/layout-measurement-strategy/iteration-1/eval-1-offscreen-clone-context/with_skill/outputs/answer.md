# Measuring feed-row height for virtualization: what's going wrong

Short version: your probe measures a **different element than the one you render**, because "clone and append to `document.body`" throws away the CSS context that decides the row's height. The heights come back short — and worst in compact density — for two compounding reasons:

1. You lost the **CSS custom properties** that drive spacing and font size. On `document.body`, `var(--row-gap)`, `var(--font-size)`, etc. resolve to their initial/fallback values (or nothing), so padding and line height shrink. Compact density is defined _by overriding those same variables_, so a compact row measured on `body` loses the compact overrides too — but it also loses the _base_ values, and you happen to notice compact most because that theme leans hardest on the variables.
2. You lost the **container query context**. The real rows live inside a `container-type` ancestor; their styles are resolved against that container's inline size via `@container` rules. On `document.body` there is no query container, so every `@container` block silently fails to apply — fonts, padding, and wrapping all flip to the default branch. Different styles → different wrapping → different height.

There are a couple of other likely contributors:

- **Wrong width.** `position:absolute` with no `width` set makes the clone shrink-to-fit its content instead of taking the row's real content width. A narrower box wraps text onto _more_ lines, which would make it taller — but if any `@container`/media branch keys off width, or the clone ends up _wider_ than the real row (absolute boxes can size to viewport-ish widths depending on content), you get fewer lines and a shorter read. Either way the width isn't pinned to the real render width, so wrapping is wrong.
- **Fonts not ready.** If you measure before web fonts load, the fallback font's metrics give shorter line boxes. This alone can make every row a few px short.
- **Ancestor classes / attributes gone.** Selectors like `[data-density="compact"] .row`, `.dark .row`, or `:has()` rules on an ancestor don't match once the node is reparented to `body`. Anything themed via a descendant selector reverts.

The underlying theorem: **a layout size is not a property of an element — it's the output of a function of (a) the real inline size it's resolved against, (b) the full CSS context its ancestors impose, and (c) whether its content is ready.** Move the node to `body` and you've changed (b) (and probably (a)); measure before fonts load and you've changed (c). The browser never tells you the number is provisional — it just returns a plausible, confidently-wrong height, and your virtualizer commits it.

## What to do instead

### Best option: measure in place, don't clone off to `body`

For a virtualized feed the highest-fidelity and usually simplest approach is to **measure the real rows where they actually live** and cache the result. Nothing is reparented, so nothing about the context is replicated wrong — same containing block, same query container, same inherited custom properties, same theme classes.

The clean way to do this with a virtualizer is **measure-on-mount with a `ResizeObserver`**, feeding measured heights back into your position map. Render a row (even briefly), observe its real height, cache it keyed by item id, and reuse the cached height for positioning. This also self-corrects when fonts swap, images load, or content streams — the RO just fires again with the new height.

```ts
// Height cache keyed by stable item id.
const heights = new Map<string, number>();

const ro = new ResizeObserver((entries) => {
  let changed = false;
  for (const entry of entries) {
    const id = (entry.target as HTMLElement).dataset.itemId!;
    // border-box block size = the space this row occupies in the column
    const h = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
    if (!isTrustworthy(h, getChromeHeight(entry.target as HTMLElement), heights.get(id))) {
      continue; // reject collapsed / border-only reads; wait for the real one
    }
    const prev = heights.get(id);
    if (prev == null || Math.abs(prev - h) > 0.5) {
      heights.set(id, Math.ceil(h)); // ceil so the last text line isn't clipped
      changed = true;
    }
  }
  if (changed) scheduleReflowOfVirtualList(); // recompute offsets from the map
});

// When a row element mounts:
function observeRow(el: HTMLElement, id: string) {
  el.dataset.itemId = id;
  ro.observe(el, { box: "border-box" });
}
```

Notes:

- Take `borderBoxSize[0].blockSize`, not `getBoundingClientRect().height`, when you can — RO hands you the value _without forcing a synchronous reflow_, and it re-fires on every change so you never have to guess the "right instant" to read.
- `Math.ceil` the height before feeding it back into layout; a rounded-down height crops the last line of text.
- Key the cache by a **stable item id**, not by DOM position, so recycled row nodes don't poison each other's entries.

For most virtualization libraries this is the "dynamic measurement" mode — e.g. TanStack Virtual's `measureElement`, which is exactly a `ResizeObserver` in place. Prefer that over hand-rolling if you're using a library.

### Let the browser hold the space: `content-visibility`

If you want the browser to help rather than manage a full offset map yourself, `content-visibility: auto` plus a remembered size lets it skip rendering off-screen rows _and_ reserve the right space, self-correcting once a row is measured:

```css
.feed-row {
  content-visibility: auto;
  /* seed with a best-guess row height; browser replaces it with the real
     measured size once the row has been laid out once */
  contain-intrinsic-size: auto 120px;
}
```

This is the least-effort path to "don't pay to render 10k rows, but still position them roughly right." You can combine it with the RO cache above for exact offsets.

### If you truly need a synchronous off-flow probe

Sometimes you need the height _before_ the row ever enters flow (e.g. to compute an initial scroll offset synchronously). Off-flow measurement is the exception, not the default — and if you do it, you must **replicate the context, not copy computed styles**:

- **Mount the probe _inside the real container subtree_, not on `document.body`.** It needs the same query container, the same ancestor with `[data-density]` / `.dark`, and the same inherited custom properties. A hidden probe slot rendered as a child of the actual feed container gets all of this for free.
- **Pin the real inline size.** Set the probe's `width` to the row's real content-box width (read it once from a live row or the container). Height is a function of width; if the width is wrong, the wrapping — and therefore the height — is wrong.
- **Keep `height: auto`.** Never `height: 0`. Use `position:absolute; visibility:hidden` (still lays out) so it doesn't affect the visible layout, but keep it in the container's subtree so the cascade and container context still apply.
- **Do NOT clone `getComputedStyle` onto the probe.** That freezes `%`, `em`, `ch`, and `fit-content` into fixed px and kills container queries — it re-introduces exactly the bug you have.
- **Wait for fonts:** `await document.fonts.ready` before trusting the number if the rows use web fonts.

```ts
// Off-flow probe rendered as a child of the REAL feed container.
async function measureRowOffFlow(
  container: HTMLElement,
  renderRow: (host: HTMLElement) => void,
  realWidth: number,
) {
  const probe = document.createElement("div");
  probe.style.cssText = `position:absolute; visibility:hidden; left:-99999px; top:0;
                         height:auto; width:${realWidth}px;`;
  container.appendChild(probe); // <-- inside the container, keeps @container + vars + theme
  renderRow(probe);
  await document.fonts.ready; // fallback metrics give short lines otherwise
  const h = Math.ceil(probe.getBoundingClientRect().height);
  container.removeChild(probe);
  return h;
}
```

But again: for a feed, prefer measure-in-place + cache. It replicates _nothing_, because nothing moved.

## The reject-border-only guard (defensive, cheap, worth it)

Whichever producer you use, protect the _consumer_. Every early-read failure mode collapses the height toward "chrome only" (border/padding with no content contribution). A content-bearing row measuring to roughly its border+padding height means **layout hasn't happened yet**, not "height is 0." Refuse to commit such a value:

```ts
function isTrustworthy(borderBoxH: number, chromeH: number, prev?: number): boolean {
  if (!Number.isFinite(borderBoxH) || borderBoxH <= 0) return false;
  if (borderBoxH - chromeH <= 1) return false; // border-only: not measured yet
  if (prev != null && borderBoxH < prev * 0.25) return false; // implausible collapse
  return true;
}
```

Commit a height only when it passes the predicate _and_ is stable across two consecutive RO deliveries (RO fires on every reflow, so "same value twice" is the practical "settled" signal). Then you can stop observing that row if you want.

## Checklist for your case

- [ ] Stop appending the probe to `document.body`. That single move is dropping your custom properties, container-query context, and theme classes — it fully explains "shorter than rendered" and "compact is especially wrong."
- [ ] Measure in place with a `ResizeObserver` (`borderBoxSize[0].blockSize`), cache by stable id, feed back into the offset map.
- [ ] If you must probe off-flow: mount inside the real container subtree, pin the real width, keep `height:auto`, don't copy computed styles.
- [ ] `await document.fonts.ready` before trusting heights.
- [ ] `Math.ceil` heights before layout; pick border-box and stay in it.
- [ ] Reject border-only/collapsed reads; commit only settled values.
- [ ] Consider `content-visibility: auto` + `contain-intrinsic-size: auto <last>` to let the browser reserve and self-correct.
