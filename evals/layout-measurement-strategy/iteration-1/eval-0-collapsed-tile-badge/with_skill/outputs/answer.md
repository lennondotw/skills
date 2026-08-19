# Collapsed tile → misplaced Stage badge

## TL;DR

Your `useLayoutEffect(…, [])` measures the tile **exactly once, on the first commit — before the tile has any content in it**. At that instant the auto-height body is empty (content streams in later, fonts haven't swapped, images haven't loaded), so the tile is only as tall as the chrome's `border-top + border-bottom` — the classic **border-only measurement** of ~2px. You then commit that 2px into `tileHeight` and position the badge against a ~0-height box, so it collides with the border. When the streamed content finally arrives the real DOM tile grows to full height on its own, and the badge _looks_ fixed only because some later re-render happened to re-run past your measurement — which is luck, not correctness.

The robust fix is two cooperating halves: **observe until the size settles** (don't measure at a single guessed instant), and **refuse to commit a border-only number** (a validity predicate, not just a value).

---

## Diagnosis

### Why the number is wrong, not just early

A layout size is not a stable property you can read whenever you like. Auto **height is a function of** the content that's present and the width it's resolved against. Your code reads that function at the one moment it is guaranteed to be wrong:

1. **`useLayoutEffect(…, [])` fires once, right after the first commit.** The tile body "streams its content in asynchronously," so on that first commit the body is empty or nearly empty. There is nothing inside to give it height.
2. **The tile is an auto-height body inside a chrome wrapper.** With no content contribution, its border box collapses to just the chrome's vertical border (and any padding that isn't collapsed) — roughly 2px. `offsetHeight` faithfully reports that 2px. The browser gives you no signal that this layout is provisional; a plausible-but-wrong number comes back **silently**, and you commit it.
3. **Web fonts and images make it worse.** Even if some text were present on first commit, fallback-font metrics and not-yet-decoded images give shorter, provisional line boxes. The height keeps changing after your one read.
4. **The empty dependency array means you never look again.** The visible "jump to full height" is the real DOM tile growing as content arrives — that happens regardless of your state. But `tileHeight` stays pinned at 2px until something _else_ triggers a re-render that happens to re-run your effect's logic. That's why it "sometimes" self-heals a moment later: it's a race, and the outcome is non-deterministic (it'll flip with StrictMode, with how the parent re-renders on each stream chunk, with timing on a fast vs slow machine).

This is precisely the border-only failure mode: _a content-bearing element measuring to ~chrome height means layout hasn't happened yet, not that the height is 0._

### Why "measure at the right instant" can't be the fix

There is no right instant to guess. Content arrives late and in stages — first paint, then font swap, then each stream chunk, then each image decode. Any fixed moment (`useLayoutEffect[]`, a `setTimeout`, even a double-`rAF`) either fires before the content or lands in the middle of it. You have to stop guessing an instant and instead **subscribe to the changes and take the settled value.**

---

## The fix

Two halves, both required:

- **Producer — observe, don't snapshot.** Use a `ResizeObserver`. It fires after layout and before paint, and **re-fires on every reflow** — first layout, font swap, image load, each stream chunk. It converts "is the geometry final?" from a guess into an event. Take the value when it has _settled_ (unchanged across two consecutive deliveries).
- **Consumer — reject border-only.** Even a good producer can hand you an early collapsed value. Guard it: refuse any height whose content contribution over the chrome is ≤ ~1px, refuse a non-positive height, and refuse an implausible collapse versus the last good value. Commit only a height that **passes the predicate**.

Measure the tile **in place** — do not move it to a probe or `document.body`. In-place measurement replicates nothing because nothing moved: it keeps the containing block, the formatting context, the chrome's border/padding, inherited custom properties, container-query ancestry, and any shadow stylesheets. Off-flow probing here would only reintroduce bugs.

### The validity predicate

```ts
// The chrome's own vertical border+padding. Measure it once from the wrapper,
// or pass in a known constant. This is the height the tile collapses TO when
// it has no content — anything at/below it means "layout hasn't happened yet."
function isTrustworthy(borderBoxH: number, chromeH: number, prev?: number): boolean {
  if (!Number.isFinite(borderBoxH) || borderBoxH <= 0) return false; // no box / display:none
  if (borderBoxH - chromeH <= 1) return false; // border-only collapse
  if (prev != null && borderBoxH < prev * 0.25) return false; // implausible collapse
  return true;
}
```

### The hook

```tsx
import { useLayoutEffect, useRef, useState } from "react";

/**
 * Measures an auto-height element's settled border-box height in place.
 * - Observes with ResizeObserver, so it catches the async stream, font swap,
 *   and image loads instead of guessing one instant.
 * - Rejects border-only / collapsed reads so the badge never positions against
 *   a ~2px box.
 * - Commits only when the value is trustworthy AND stable across two RO
 *   deliveries (the practical "settled" signal), then keeps watching in case
 *   the tile genuinely resizes later.
 *
 * @param chromeH  the wrapper's vertical border + padding (the height the tile
 *                 collapses to with no content). Pass a constant or measure it.
 */
export function useSettledTileHeight<T extends HTMLElement>(chromeH: number) {
  const ref = useRef<T | null>(null);
  const [height, setHeight] = useState<number | null>(null); // null = not measured yet

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    let committed: number | undefined; // last value we accepted
    let pending: number | undefined; // candidate seen once, awaiting confirmation
    let disposed = false;

    const consider = (raw: number) => {
      // border-box height, rounded up so we never crop the last text line.
      const h = Math.ceil(raw);
      if (!isTrustworthy(h, chromeH, committed)) return; // refuse collapsed numbers

      if (pending != null && Math.abs(pending - h) <= 1) {
        // stable across two deliveries -> settled. Commit.
        committed = h;
        pending = undefined;
        setHeight(h);
      } else {
        pending = h; // first sighting of a plausible value; wait for confirmation
      }
    };

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      // borderBoxSize is the modern, reflow-free read; fall back to contentRect+chrome.
      const box = entry.borderBoxSize?.[0];
      const raw = box ? box.blockSize : el.offsetHeight;
      consider(raw);
    });
    ro.observe(el);

    // Web-font swaps change line-box height after first layout. RO already
    // catches this, but nudging on fonts.ready makes slow-font machines settle
    // deterministically rather than waiting for the next unrelated reflow.
    document.fonts?.ready.then(() => {
      if (!disposed && ref.current) consider(ref.current.offsetHeight);
    });

    return () => {
      disposed = true;
      ro.disconnect();
    };
  }, [chromeH]);

  return { ref, height };
}
```

### Using it — the consumer refuses to place the badge early

```tsx
function WidgetTile({ stage, children }: Props) {
  // chromeH = the wrapper's border+padding, e.g. 2px top + 2px bottom border = 4.
  // Better: read it once from getComputedStyle, or expose it as a CSS constant.
  const { ref, height } = useSettledTileHeight<HTMLDivElement>(/* chromeH */ 4);

  return (
    <div className="chrome" style={{ position: "relative" }}>
      {
        /* Only render the badge once we have a trustworthy height. Until then it
          simply isn't placed — no flash of a badge sitting on the border. */
      }
      {height != null && (
        <StageBadge
          stage={stage}
          style={{ position: "absolute", top: 8, right: 8 /* or derive from `height` */ }}
        />
      )}
      <div className="tile-body" ref={ref}>
        {children /* streams in asynchronously; RO tracks every growth step */}
      </div>
    </div>
  );
}
```

If the badge's position is genuinely derived from the measured height (e.g. vertically centered against it), use `height` in the style and gate on `height != null` so it never renders against the collapsed box. If the badge only needs to sit in the top-right corner, you may not need the measured height for placement at all — but you still want the guard so nothing downstream (radii, insets, animations) consumes the 2px value.

---

## Why each piece matters

- **`ResizeObserver` instead of a one-shot read** — the content is async in _stages_ (stream chunks, font swap, image decode). RO re-fires on each, so you converge on the real height instead of betting on one instant that's guaranteed to be too early. It also hands you the value without forcing a synchronous reflow.
- **Reject-border-only guard** — this is what actually kills your bug. Waiting isn't enough on its own, because an eager first RO delivery (or your old `useLayoutEffect`) will still hand over the collapsed 2px. The predicate refuses to commit it: _border-box − chrome ≤ 1px ⇒ "not measured," not "height is 0."_
- **Settle-across-two-deliveries** — RO fires on every reflow, so a single delivery isn't proof the layout is final. Two consecutive equal (±1px) deliveries is the practical "settled" signal.
- **Measure in place, not off-flow** — nothing moves, so the chrome's border/padding, the containing block, fonts, custom properties, and container-query context are all exactly the real ones. Appending a probe to `document.body` would silently drop custom properties, ancestor classes (`.dark`, `[data-density]`), `@container` context, and shadow `adoptedStyleSheets`, and you'd measure a different element than you render.
- **`Math.ceil`** — feeding a rounded-_down_ height back into layout crops the last line of text. Round up for any box that must not clip. Keep one box type end-to-end: `offsetHeight` / `borderBoxSize.blockSize` are both border-box, which matches how you position the absolute badge.
- **`useLayoutEffect` (not `useEffect`) to install the observer** — so the badge is placed after commit but before paint, with no flash of the un-sized state. But note: the _decision to place_ now waits for `height != null`, not for a single measurement instant.
- **`document.fonts.ready` nudge** — RO already catches font swaps, but on slow-font machines this makes the tile settle deterministically instead of waiting for the next unrelated reflow.

## Pre-trust checklist (applied here)

- [x] Has a layout box — measured in place, not `display: none`.
- [x] Real inline size / context — in place, so chrome border/padding, fonts, vars, container queries are all real.
- [x] Content is real — RO takes the _settled_ value across stream chunks + font swap + image decode.
- [x] Right box + deliberate rounding — border-box throughout, `Math.ceil`.
- [x] No transform contaminating the read — `offsetHeight` / `borderBoxSize` ignore transforms.
- [x] Passed the reject-border-only guard.
- [x] No RO feedback loop — the callback doesn't resize the observed element; it only sets React state after the value settles.
