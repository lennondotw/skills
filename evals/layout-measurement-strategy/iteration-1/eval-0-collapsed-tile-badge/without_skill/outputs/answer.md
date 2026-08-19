# Collapsed tile + misplaced badge: why it happens and how to fix it

## Diagnosis

Your measurement is a **one-shot snapshot taken too early**. The bug is not really about `offsetHeight` being wrong — at the moment you read it, the tile genuinely _is_ ~2px tall. You're reading a real height, just at the wrong time.

Walk through the actual timeline:

1. React commits the first render. The tile body has **no content yet** (it streams in asynchronously). So the body's content box is 0px high, and the "2px" you see is just the chrome wrapper's top+bottom border (a 1px border on each side).
2. `useLayoutEffect(fn, [])` fires **once**, synchronously after that first commit, before paint. You read `offsetHeight` → ~2px → `setTileHeight(2)`.
3. The absolutely-positioned Stage badge is placed using `tileHeight = 2`, so it lands on top of the border. That's the broken first frame.
4. Later, three independent async things happen, each of which changes the height _after_ your effect already ran and will never run again:
   - The streamed content arrives and gets inserted into the body.
   - **Web fonts** finish loading and the text reflows to its final line count (FOUT/FOIT — text is invisible or falls back, then swaps, changing height).
   - **Images** decode and get their intrinsic height (any `<img>` without a reserved height reflows the layout when it loads).
5. Each of those triggers a browser reflow, the tile jumps to full height — but your `tileHeight` state is still `2`. The reason it "looks fine a moment later" is almost certainly that _some other_ re-render (new props, another state update, streaming causing a parent re-render) happens to re-run your layout logic or re-mount, and by then the content is settled.

So the two root causes are:

- **`[]` dependency array** — you measure exactly once, at the emptiest possible moment, and never again. `useLayoutEffect` runs after commit, but layout is not "final" just because React committed. Async content, fonts, and images all mutate layout later.
- **Deriving an absolute position from a JS-measured height at all.** Even with perfect timing, coupling the badge's position to a state value means every height change requires a re-measure + re-render round trip. It will always lag by at least one frame.

A secondary point: `offsetHeight` is an integer (rounded). If precise placement matters, `getBoundingClientRect().height` gives you the fractional value.

## The robust fix

Two layers. First, **prefer CSS so you don't need to measure at all**. Second, if you genuinely need the number in JS, **measure continuously with `ResizeObserver`** instead of once.

### Layer 1 (best): position the badge with CSS, drop the measurement

If the badge is in the top-right corner, it doesn't actually need the tile's height — `top`/`right` on an absolutely-positioned element are relative to the positioned ancestor's padding box, not its height. Make the chrome wrapper the positioning context and place the badge directly:

```tsx
function Tile({ children }: { children: React.ReactNode; }) {
  return (
    // position: relative makes this the containing block for the badge.
    // No height measurement needed at all.
    <div className="tile-chrome">
      <StageBadge className="tile-badge" />
      <div className="tile-body">{children}</div>
    </div>
  );
}
```

```css
.tile-chrome {
  position: relative;      /* containing block for the badge */
  border: 1px solid var(--border);
  padding: 12px;
}

.tile-badge {
  position: absolute;
  top: 8px;                /* offset from the top border, not from measured height */
  right: 8px;
  z-index: 1;
}

.tile-body {
  /* auto height — grows with streamed content */
}
```

This is immune to the entire class of bug: there is no first-frame snapshot, no font/image race, no re-render lag. The badge is pinned to the corner by the layout engine, which already knows the correct box on every frame including reflows. **If your design allows it, stop here** — you almost never need JS to put something in a corner.

### Layer 2: if you truly need the measured height in JS

Sometimes you legitimately need the number (e.g. to size a sibling, drive a tooltip, report telemetry, or the badge position is a function of height for a non-trivial reason). Then measure it _continuously_, not once:

```tsx
import { useLayoutEffect, useRef, useState } from "react";

function useMeasuredHeight<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Fires on the initial box AND on every subsequent reflow:
    // streamed content insertion, web-font swap, image decode, resize.
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      // borderBoxSize matches offsetHeight (includes border + padding).
      const h = entry.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight;
      setHeight(h);
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, height] as const;
}
```

```tsx
function Tile({ children }: { children: React.ReactNode; }) {
  const [tileRef, tileHeight] = useMeasuredHeight<HTMLDivElement>();

  return (
    <div ref={tileRef} className="tile-chrome" style={{ position: "relative" }}>
      <StageBadge style={{/* ...derive from tileHeight if you must... */}} />
      <div className="tile-body">{children}</div>
    </div>
  );
}
```

Why `ResizeObserver` is the correct tool:

- It reports the element's box **on observe** (so you get the initial value) and again **on every reflow** — including the ones caused by streamed content, the web-font swap, and image decode. Those are exactly the events your `[]` effect misses.
- It's throttled to the browser's layout cycle (fires just before paint), so you don't need to poll or guess timings.
- `borderBoxSize.blockSize` corresponds to `offsetHeight` (content + padding + border). Use `contentBoxSize` if you want the inner height instead.

### Things to avoid (common but fragile "fixes")

- **`setTimeout(measure, 0)` / `requestAnimationFrame`** — this just moves the single snapshot slightly later. It'll fix the demo and then break the day a font loads slowly or a big image streams in. It races the network; `ResizeObserver` observes the result.
- **Awaiting `document.fonts.ready` once** — helps with the font-swap case only, still misses streamed content and image decode, and still measures once.
- **Re-running the effect on a `children`/content dependency** — better than `[]`, but you still won't catch font swap or image load, which don't change any prop.

### Bonus: kill the layout jank at the source

Even with the observer, the tile visibly _jumps_ as fonts/images land. Reduce that reflow churn:

- Give `<img>` explicit `width`/`height` (or `aspect-ratio`) so it reserves space before decoding — no post-load shift.
- Use `font-display: optional` or `swap` deliberately, and consider preloading the critical web font so the swap happens before/at first paint.
- Optionally reserve a `min-height` on `.tile-body` while content streams, so the first frame isn't a 2px sliver.

## Summary

- **Why:** `useLayoutEffect(fn, [])` measures exactly once, at the first commit, when the body is empty and fonts/images haven't loaded. The ~2px is the real height at that instant (just the chrome border). Async content, web-font swap, and image decode all grow the tile _after_ your effect ran and it never re-measures — so the badge, positioned from the stale `2`, sits on the border until some unrelated re-render fixes it.
- **Fix:** Prefer CSS — make the chrome `position: relative` and pin the badge with `top`/`right`, needing no measurement. If you must have the height in JS, replace the one-shot effect with a `ResizeObserver` that updates on the initial box and every reflow. Pair with reserved image dimensions and a considered `font-display` to remove the visible jump.
