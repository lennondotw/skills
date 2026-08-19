# `useAutoHeight` — animate an expand/collapse panel to its content height

The reason this bites people is almost never the animation — it's the **measurement**. If you measure the height wrong, the animation faithfully animates to the wrong number. So the whole design is built around one rule:

> Never measure the element you're constraining, and never trust a height that came back "collapsed."

Concretely that means three decisions, and everything else follows:

1. **Measure an inner wrapper that is left at `height: auto`, not the outer container.** The container is the thing you clip and animate (`height: 0 → N`, `overflow: hidden`). If you read the _container's_ height you just read back the number you set. The height has to come from an element that is _not_ being constrained.
2. **Observe with a `ResizeObserver`, don't measure once.** Content changes after first paint — fonts swap, text reflows on resize, async content streams in. RO fires after layout / before paint and _re-fires on every one of those changes_, which is exactly the "children whose height can change while open" requirement. It turns "when is the height final?" from a guess into an event.
3. **Reject border-only / collapsed reads.** An element that has content but momentarily measures ~0 (or just its border) hasn't finished layout — that's the classic silent-wrong-number. A validity guard refuses that value instead of committing it.

Two supporting details that are the difference between "works in the demo" and "robust":

- **`display: flow-root` on the measured inner wrapper.** Otherwise the children's top/bottom margins _collapse through_ the wrapper and fall out of the measured box — the panel then animates to a height that clips the content by exactly the collapsed margin. `flow-root` establishes a block formatting context so margins stay inside the number.
- **Keep the content in the DOM while collapsed** (`height: 0` on the container, never `display: none`). `display: none` destroys the layout box and blinds the ResizeObserver. Because the inner wrapper stays measurable even while closed, the target height is already known the instant `open` flips — so `0 → N` animates cleanly with **no first-open flicker**, and it's `inert` + `aria-hidden` for accessibility.

One React-specific trap this avoids: the animated `height` has **exactly one owner** — React state. We never also poke `el.style.height` imperatively, because then a parent re-render reconciles `style.height` back to a stale value mid-animation. React owns it end to end.

---

## The hook

```tsx
import { useEffect, useLayoutEffect, useRef, useState } from "react";

// useLayoutEffect warns during SSR (no DOM); fall back to useEffect there.
// There's nothing to measure on the server anyway.
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/** Below this a height is "collapsed / not real yet." Tune above max expected border. */
const MIN_TRUSTWORTHY_HEIGHT = 4; // px

/**
 * Returns a trustworthy ceil'd height, or null if the read looks collapsed
 * (border-only, zero, or an implausible sudden shrink). null ⇒ keep previous.
 * `chromeH` = the measured wrapper's own top+bottom border+padding, if any.
 */
function trustHeight(borderBoxH: number, chromeH = 0, prev?: number): number | null {
  if (!Number.isFinite(borderBoxH) || borderBoxH <= 0) return null;
  if (borderBoxH - chromeH <= 1) return null; // border-only read
  if (borderBoxH < MIN_TRUSTWORTHY_HEIGHT) return null; // near-zero
  if (prev != null && borderBoxH < prev * 0.25) return null; // implausible collapse
  return Math.ceil(borderBoxH); // ceil: a rounded-DOWN height crops the last text line
}

export interface UseAutoHeight {
  /** Spread onto the outer clipping container. */
  containerProps: {
    ref: React.RefObject<HTMLDivElement | null>;
    style: React.CSSProperties;
    "aria-hidden"?: boolean;
    inert?: boolean;
  };
  /** Spread onto the single inner wrapper that holds your children. */
  contentProps: {
    ref: React.RefObject<HTMLDivElement | null>;
    style: React.CSSProperties;
  };
  /** The current trusted content height in px (null until first real measurement). */
  measuredHeight: number | null;
}

export function useAutoHeight(open: boolean): UseAutoHeight {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);

  // Observe the INNER wrapper (left at height:auto), not the outer container.
  // RO re-fires on first layout, font swap, image load, text reflow, and any
  // async child that streams in — which is exactly what keeps `open` in sync.
  useIsoLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    let prev: number | undefined;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.borderBoxSize?.[0]?.blockSize;
      if (h == null) return;
      const trusted = trustHeight(h, /* chromeH */ 0, prev);
      if (trusted == null) return; // reject collapsed / border-only reads
      if (trusted === prev) return; // no-op: avoids a needless re-render
      prev = trusted;
      setMeasuredHeight(trusted);
    });

    ro.observe(el, { box: "border-box" });
    return () => ro.disconnect();
  }, []);

  // React is the SOLE owner of `height`. We never write el.style.height ourselves.
  // - closed        -> 0
  // - open, known   -> measured px (transition animates 0 -> N, and N -> N' on reflow)
  // - open, unknown -> "auto" for the first paint before RO has run (rare: initially
  //                     open). RO corrects it to a px value immediately after.
  const height: number | "auto" = !open ? 0 : measuredHeight ?? "auto";

  return {
    containerProps: {
      ref: containerRef,
      style: { height, overflow: "hidden" },
      "aria-hidden": open ? undefined : true,
      inert: open ? undefined : true,
    },
    contentProps: {
      ref: contentRef,
      // height stays AUTO here — this is the element we measure. flow-root keeps
      // child margins inside the measured box. width:100% = the real inline size.
      style: { display: "flow-root", inlineSize: "100%" },
    },
    measuredHeight,
  };
}
```

### Using it

```tsx
function Panel({ open, children }: { open: boolean; children: React.ReactNode; }) {
  const { containerProps, contentProps } = useAutoHeight(open);
  return (
    <div className="auto-height" {...containerProps}>
      <div {...contentProps}>{children}</div>
    </div>
  );
}
```

## The minimal CSS

The hook sets `height` and `overflow` inline (React owns them). CSS only needs to add the transition — and turn it off for reduced-motion users:

```css
.auto-height {
  /* height + overflow are set by the hook; this just animates the change. */
  transition: height 240ms ease;
  /* Optional: hint the compositor. Drop it if you have many panels on screen. */
  will-change: height;
}

@media (prefers-reduced-motion: reduce) {
  .auto-height {
    transition: none;
  }
}
```

That's the whole styling surface. Do **not** add `height` or `overflow` to this rule — leave those to the hook so there's a single owner.

---

## Why this survives the things that usually break it

- **Async content loads in after open** → the `ResizeObserver` on the inner wrapper fires on the reflow, `measuredHeight` updates, and the container animates from the old height to the new one. Nothing to wire up per data source.
- **Text reflows when the viewport resizes** → same mechanism; RO fires on the wrapper's height change. (RO also won't loop, because the callback bails when the value is unchanged and the observed inner wrapper is never itself constrained by the height we set.)
- **Web fonts swap in late** → the fallback font gives shorter line boxes first, then the real font reflows. Because we _observe_ rather than measure once, we take the settled value; we never freeze the provisional one. (If you also do a one-shot measure elsewhere, gate it on `await document.fonts.ready`.)
- **Height comes back as 0 / a couple of px** (the reflow hasn't happened yet) → `trustHeight` rejects it and we keep the last good value instead of animating to a collapsed box.
- **Margins on the first/last child** → `display: flow-root` keeps them inside the measured height, so the panel doesn't clip them.
- **Last line of text gets cropped** → `Math.ceil` on the measured value; a rounded-down height clips descenders/the final line.
- **Parent re-render mid-animation** → `height` lives only in React state and JSX, never in an imperative `el.style.height`, so reconciliation can't clobber it with a stale value.

## Deliberate non-choices (in case you want them)

- **I measure in place, not off-screen.** The inner wrapper is measured exactly where it renders, at its real width, inside the real cascade (theme classes, CSS variables, container-query ancestor, fonts). Moving a probe to `document.body` or to a fixed off-screen width would measure a _different_ element — different width means different wrapping means different height. In-place is both simpler and correct here.
- **I don't switch to `height: auto` after the open transition finishes.** Some implementations flip to `auto` on `transitionend` so nested changes reflow "for free." That reintroduces two owners of the height and makes the _next_ change animate from `auto` (which can't transition). Keeping the container pinned to the measured px value — and letting RO keep that value fresh — means every subsequent size change animates smoothly too, which is what you asked for.
- **`overflow: hidden` is on the container, not the content.** The content wrapper must stay unconstrained (`height: auto`) so it reports its true intrinsic height. Only the outer container clips.
