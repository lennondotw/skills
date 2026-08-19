# Collapsed tile + misplaced badge on first render

## TL;DR

Your `useLayoutEffect(…, [])` measures the tile **exactly once**, at the moment of the first commit — which is the worst possible moment. At that instant the body is still empty (content streams in asynchronously), web fonts haven't swapped, and images have zero intrinsic height. So `offsetHeight` returns ~2px (just the chrome's top+bottom border). You store that stale number and position the badge against it. Later, when content/fonts/images land, the browser reflows the tile to its real height, but your effect never runs again, so the badge is anchored to a height that no longer exists.

There are two robust fixes, and you should probably do both:

1. **Stop measuring for badge placement.** Positioning a corner badge does not require the tile's height at all — anchor it to the tile box directly with `position: relative` + `position: absolute`. This removes the JS→state→layout round-trip entirely and the bug can't recur.
2. **If you genuinely need the measured height for other reasons**, replace the one-shot `useLayoutEffect` with a `ResizeObserver` that keeps the height in sync across every reflow (content stream, font swap, image decode, container resize).

---

## Why this happens (in detail)

### 1. `useLayoutEffect` with `[]` fires once, before the content exists

`useLayoutEffect` runs synchronously after the first DOM commit but _before the browser paints_. That's good for avoiding a visible flash of a wrong value — but it fires based on the DOM as it exists **at first commit**. Your tile body "streams its content in asynchronously," which means at first commit the body is empty or a placeholder. An empty auto-height body contributes 0 to layout, so:

```text
offsetHeight ≈ border-top (1px) + border-bottom (1px) = ~2px
```

That's your mysterious "2px tall." The `~2` is literally the chrome wrapper's border, because `offsetHeight` includes borders and padding (it's the border-box height) but the content box has collapsed to nothing.

The empty dependency array `[]` means the effect never re-runs. So you capture 2px and never correct it. The reason the tile _visually_ "jumps to full height a moment later" is that React re-renders when the streamed content arrives and the browser reflows — but that reflow doesn't re-trigger your measurement. The tile looks right; the badge (which is positioned from the stale `tileHeight`) stays wrong until some _other_ re-render happens to fire the effect again (or it never fully corrects, depending on your deps).

### 2. Web fonts change height after layout

Even if the content were present at first commit, web-font text is measured with the **fallback font** until the web font loads and swaps in (`font-display: swap`). The fallback and the web font almost never have identical metrics (line-height, ascent/descent), so the tile's height changes when the font swaps — _after_ your effect ran. `document.fonts.ready` is the signal for this, and a plain `useLayoutEffect([])` doesn't wait for it.

### 3. Images have no height until they load/decode

An `<img>` without explicit `width`/`height` (or `aspect-ratio`) contributes **zero height** until the image loads and the browser learns its intrinsic size, then reflows. Again: after your effect. This is also a Cumulative Layout Shift (CLS) source independent of the badge bug.

So you have three separate async height sources — streamed content, font swap, image decode — all landing _after_ your single measurement. Any one of them reproduces the bug.

---

## Fix A (preferred): don't measure at all — anchor the badge to the box

A corner badge is a positioning problem, not a measurement problem. Make the tile a positioning context and let the badge pin itself to the corner. The browser recomputes this on every reflow for free, with no JS, no state, no stale values.

```tsx
function Tile({ stage, children }: { stage: string; children: React.ReactNode; }) {
  return (
    // The chrome wrapper. `relative` makes it the containing block for the badge.
    <div className="tile-chrome">
      <span className="stage-badge">{stage}</span>
      {/* auto-height body; streams content in */}
      <div className="tile-body">{children}</div>
    </div>
  );
}
```

```css
.tile-chrome {
  position: relative;      /* containing block for the absolutely-positioned badge */
  border: 1px solid var(--border);
  padding: 12px;
  box-sizing: border-box;
}

.stage-badge {
  position: absolute;
  top: 8px;
  right: 8px;              /* pinned to the top-right corner, inside the border/padding */
  z-index: 1;
}

.tile-body {
  /* auto height — no min-height hack needed, but see note below */
}
```

Because the badge is absolutely positioned relative to the chrome, it sits in the correct corner **at 2px and at full height and at every frame in between**. There's no wrong intermediate state to see, and no measurement to go stale. Delete `tileRef`, `tileHeight`, and the `useLayoutEffect` entirely.

If your badge needs to overhang the corner (half outside the border) rather than sit inside it, use negative offsets:

```css
.stage-badge { top: -10px; right: -10px; }
```

This is the robust answer for the specific symptom you described. Measuring the tile height to place a child _inside_ that same tile is a round-trip you don't need — the layout engine already knows where the corner is.

---

## Fix B: if you truly need the measured height, use a ResizeObserver

Sometimes you need the number in JS state — e.g. to size a sibling element outside the tile, drive a virtualized list, or report layout to a parent. In that case, observe the element so the height stays correct through every reflow instead of snapshotting it once.

```tsx
import { useLayoutEffect, useRef, useState } from "react";

function useMeasuredHeight<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [height, setHeight] = useState<number | null>(null); // null = "not measured yet"

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // borderBoxSize matches offsetHeight (includes border + padding).
      const box = entry.borderBoxSize?.[0];
      const next = box ? box.blockSize : el.offsetHeight;
      // Round to avoid sub-pixel churn causing render loops.
      setHeight((prev) => {
        const rounded = Math.round(next);
        return prev === rounded ? prev : rounded;
      });
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, height] as const;
}
```

Usage:

```tsx
function Tile({ stage, children }: { stage: string; children: React.ReactNode; }) {
  const [tileRef, tileHeight] = useMeasuredHeight<HTMLDivElement>();

  return (
    <div className="tile-chrome" ref={tileRef}>
      {
        /* Only render/position the badge once we have a real height.
          Until then, either hide it or (better) place it with CSS as in Fix A. */
      }
      {tileHeight != null && (
        <span className="stage-badge" style={{/* …if you must use the number… */}}>
          {stage}
        </span>
      )}
      <div className="tile-body">{children}</div>
    </div>
  );
}
```

Why `ResizeObserver` is the right tool:

- It fires whenever the observed box's size changes — **content streaming in, font swap, and image decode all trigger it**, because they all change the box size. You get correct values without enumerating every async source manually.
- It also handles container resizes (window resize, panel drag, zoom) for free — your one-shot effect never did.
- Callbacks are delivered before paint (they're scheduled at a special point in the frame), so with the value applied in state you avoid a visible flash in most cases. If you see a one-frame flicker, gate the dependent UI on `height != null` as shown, or fall back to Fix A's pure-CSS positioning for the visual and use the number only for non-visual logic.

Key correctness notes for Fix B:

- **`offsetHeight` is border-box.** It includes padding and border. `ResizeObserver`'s `borderBoxSize.blockSize` matches it; `contentBoxSize` would not. Pick the one your consumer expects and be consistent.
- **Round the value.** Sub-pixel layout can emit a stream of `123.333…` → `123.334…` values; rounding + the `prev === next` guard prevents an infinite render/measure loop.
- **Guard the initial `null`.** `null` means "not yet measured" — distinct from a real `0`. Don't position anything meaningful off a not-yet-measured state.

---

## Independent hardening you should do regardless

These aren't strictly the badge bug, but they're the same family of "async height" problem and will bite you elsewhere (notably CLS):

1. **Give images explicit dimensions.** Set `width`/`height` attributes or `aspect-ratio` in CSS so the image reserves its box _before_ it loads. This removes the image-driven reflow entirely.

   ```css
   .tile-body img { aspect-ratio: 16 / 9; width: 100%; height: auto; }
   ```

2. **Reserve space for streamed content** if you can predict a minimum, via `min-height` on the body, so the tile doesn't collapse to 2px even momentarily. This makes any intermediate frame look sane.

3. **Consider `font-display: optional` or preloading** the web font if the font-swap reflow is visually disruptive. Preloading the font (`<link rel="preload" as="font" crossorigin>`) shrinks the window where fallback metrics are in effect.

---

## Recommendation

Do **Fix A** — reposition the badge with `position: relative`/`absolute` and delete the measuring code. It's less code, it's impossible to get into a stale state, and it's correct at every frame including the 2px one. Only reach for **Fix B** (the `ResizeObserver` hook) if some other piece of UI genuinely needs the height as a number. In no case keep the one-shot `useLayoutEffect([])` — measuring async, streaming, font- and image-dependent content exactly once at first commit is guaranteed to read a height that isn't real yet.
