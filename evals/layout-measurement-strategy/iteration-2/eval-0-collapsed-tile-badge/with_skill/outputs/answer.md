# Collapsed tile + misplaced Stage badge: diagnosis and robust fix

## TL;DR

Your `useLayoutEffect` reads `offsetHeight` at the one instant the tile is _guaranteed to be at its wrong size_: after the first commit, but before the streamed content, web fonts, and images have expanded the auto-height body. At that moment the tile is only `border-top + border-bottom + padding` tall — a **border-only measurement** (~2px). You commit that number, position the badge against a ~0-height box, and it lands on the border. When content lands the CSS box grows on its own, so the tile "jumps" to full height — but your measured `tileHeight` is stale, because `[]` means the effect never runs again.

There are two things wrong and both need addressing:

1. **You are measuring before the layout is real** (the border-only trap), and
2. **You almost certainly don't need to measure at all** — a corner badge is something the layout engine can place for free.

The most robust fix is to delete the measurement. If a height genuinely must cross into JS for something else, use a `ResizeObserver` with a reject-border-only guard instead of a one-shot read.

---

## Why this happens (mechanism)

A layout size is not a stored property of an element — it is _computed_ from (1) the inline size it resolves against, (2) the CSS context from its ancestors, and (3) **the readiness of its content**. Your read fails on #3.

- `useLayoutEffect(fn, [])` fires **once**, synchronously after the first commit and before paint. That is deliberately the earliest possible moment — and for streamed/auto-height content it is _too early_. The body has no content yet, so the host chrome (border + padding) is the only thing contributing height. `offsetHeight` comes back as chrome-only, ~2px.
- The browser never signals that this layout is provisional. There's no `isLayoutFinal` flag. `offsetHeight` returns a plausible-looking `2` with no error, and your code commits it.
- The content then arrives in three separate waves, each of which reflows the tile taller: **the async stream chunk, the web-font swap (fallback metrics → real metrics), and each image decoding to its intrinsic size.** Your empty dependency array means none of these re-trigger the measurement. The CSS box grows (that's the visible "jump"); your `tileHeight` state does not.
- The badge is positioned from `tileHeight`, so it's pinned against the stale ~2px box and sits over the border. (If it "looks fine a moment later" in your build, that's incidental — a parent re-render or remount happening to re-run the effect — not something you can rely on.)

This is the canonical **border-only / collapsed-box** failure: `borderBoxHeight − chromeHeight ≈ 0` means _layout hasn't happened yet_, not _height is 0_.

---

## Fix 1 (preferred): don't measure — let CSS place the badge

The cheapest measurement is the one you never take. A badge in the top-right corner needs **no height at all**: anchor it to the tile's own padding box with `position: absolute`. The tile is `position: relative`; the badge is `position: absolute; top; right`. As the auto-height body streams in and the tile grows, the badge stays glued to the corner automatically — through every font swap and image load — with zero JS, zero stale state, and zero border-only window.

```tsx
function WidgetTile({ children, stage }: { children: React.ReactNode; stage: string; }) {
  return (
    // The host "chrome": border + padding. This is the positioning context.
    <div
      style={{
        position: "relative", // badge anchors to THIS box
        border: "1px solid var(--tile-border)",
        padding: "var(--tile-pad)",
        // height is auto — the body drives it; we never read it
      }}
    >
      <StageBadge stage={stage} />
      <div className="widget-body">{children}</div>
    </div>
  );
}

function StageBadge({ stage }: { stage: string; }) {
  return (
    <span
      style={{
        position: "absolute",
        // sit just inside the chrome's top-right corner, clear of the border.
        // use inset-block-start / inset-inline-end for RTL safety if needed.
        top: "var(--tile-pad)",
        right: "var(--tile-pad)",
        zIndex: 1,
      }}
    >
      {stage}
    </span>
  );
}
```

Notes:

- Anchoring to `top/right` (not `bottom`) means the badge never depends on tile height, so there is nothing to recompute as the tile grows. This is what makes it immune to the streaming/font/image races.
- If the badge must nestle inside a _rounded_ chrome corner, keep its inset equal on both axes and make its radius concentric (`r_inner = r_outer − inset`) — but that's still pure CSS, still no measured height.
- If you want the badge to visually clear the border rather than overlap it, offset by the padding (as above) or by `top: calc(var(--border-w) + 4px)`.

Deleting the `useLayoutEffect` and the `tileHeight` state removes the entire bug surface — the collapse, the stale value, and the font/image/stream race — in one move.

---

## Fix 2 (only if a height genuinely must reach JS)

Sometimes the corner-CSS trick isn't enough — e.g. you need the pixel height for a virtualized list row, an FLIP animation endpoint, or an overlay the layout engine truly can't express. In that case, stop trying to pick "the right instant to read" and instead **observe and settle**: subscribe with a `ResizeObserver` (it fires after layout, before paint, and **re-fires on every reflow** — first layout, stream chunk, font swap, image decode) and commit only a value that passes a **reject-border-only guard**.

```tsx
import { useEffect, useLayoutEffect, useRef, useState } from "react";

// SSR-safe layout effect
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

const MIN_TRUSTWORTHY_HEIGHT = 4; // px — tune above your max total border+padding

/** Returns a trustworthy ceil'd height, or null if the box is still collapsed. */
function trustHeight(borderBoxH: number, chromeH = 0, prev?: number): number | null {
  if (!Number.isFinite(borderBoxH) || borderBoxH <= 0) return null;
  if (borderBoxH - chromeH <= 1) return null; // border-only read
  if (borderBoxH < MIN_TRUSTWORTHY_HEIGHT) return null; // near-zero
  if (prev != null && borderBoxH < prev * 0.25) return null; // implausible collapse
  return Math.ceil(borderBoxH); // ceil so we never crop the last text line
}

function useTileHeight(chromeH = 0) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState<number | null>(null); // null ⇒ not yet measured

  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    let prev: number | undefined;

    // web fonts give short, provisional line boxes until they swap; the RO below
    // will also catch the swap-reflow, but awaiting fonts.ready avoids a needless
    // intermediate commit.
    if ("fonts" in document) void document.fonts.ready;

    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.borderBoxSize?.[0]?.blockSize;
      if (h == null) return;
      const trusted = trustHeight(h, chromeH, prev);
      if (trusted == null) return; // reject collapsed/border-only — stay "loading"
      if (trusted === prev) return; // no change, skip
      prev = trusted;
      setHeight(trusted); // re-fires on stream chunk / font swap / image load
    });
    ro.observe(el, { box: "border-box" });
    return () => ro.disconnect();
  }, [chromeH]);

  return { ref, height };
}
```

Usage — treat `height == null` as "not measured yet" and hold the badge (or render it in a height-independent way) until a real value arrives; never draw geometry against a collapsed number:

```tsx
function WidgetTile({ children, stage }: { children: React.ReactNode; stage: string; }) {
  // chromeH = top+bottom border + padding of the tile, if you know it
  const { ref, height } = useTileHeight(/* chromeH */ 2 + 16 * 2);

  return (
    <div
      ref={ref}
      style={{ position: "relative", border: "1px solid var(--tile-border)", padding: 16 }}
    >
      {/* Only position from height once it's trustworthy. */}
      {height != null && <StageBadge stage={stage} tileHeight={height} />}
      <div className="widget-body">{children}</div>
    </div>
  );
}
```

Key differences from your original code, and why each matters:

| Your code                                     | Fix                                        | Why                                                                                                             |
| --------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `offsetHeight` in `useLayoutEffect([])`, once | `ResizeObserver`, re-fires on every reflow | Content arrives in 3 async waves (stream, font swap, image decode). One read can't see them; the observer does. |
| Commits any number                            | `trustHeight` guard rejects border-only    | A content-bearing box measuring ≈ chrome height means _layout hasn't happened_, not _height is 0_. Refuse it.   |
| No await on content                           | `document.fonts.ready` + RO catches images | Fallback font metrics and un-decoded images give provisional/short boxes.                                       |
| Rounds implicitly                             | `Math.ceil`                                | A rounded-down height crops the final text line.                                                                |
| `[]` never updates                            | observer stays subscribed                  | The tile can grow again; the value stays correct.                                                               |

If it's a list/preview, also cache the settled height and feed it back as `contain-intrinsic-size: auto <last>` with `content-visibility: auto`, so the browser reserves the right space on re-entry instead of re-collapsing.

---

## Recommendation

Use **Fix 1**. A top-right badge is a positioning problem, not a measurement problem — anchoring it with `position: absolute; top; right` inside the `position: relative` chrome eliminates the collapse, the stale value, and the font/image/stream race entirely, with no JS. Reach for **Fix 2** only if some _other_ consumer genuinely needs the tile's pixel height in JS; if so, observe-and-settle with a reject-border-only guard rather than a one-shot read.
