# `useAutoHeight` — animate a panel from 0 to its content's natural height

Here's a version that's built to survive the exact things that bite people: content that reflows on resize, async content that streams in after the animation started, and the classic "measured height comes back wrong / zero / one line short."

The single most important design decision is **what we measure**. We never measure the animating container (its height is `0` or a pinned pixel value — measuring it just reads back what we set). We put an inner wrapper inside it that is **never height-constrained** (`height: auto`, in normal block flow) and observe _that_ with a `ResizeObserver`. The container clips it with `overflow: hidden`. So the number we read is always the true content height, whether the panel is open, closed, or mid-animation — and it re-fires by itself on every reflow, font swap, image load, or async chunk.

## The hook

```tsx
import {
  type CSSProperties,
  type RefObject,
  type TransitionEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

// useLayoutEffect warns during SSR (there's no DOM to measure). Fall back to
// useEffect on the server; the first real measurement happens on the client anyway.
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * Reject a measurement we shouldn't trust, and ceil the ones we keep.
 *
 * - non-finite / negative -> the element was detached or `display:none`
 *   (a `display:none` box generates no layout, so it reads 0). Don't commit it.
 * - `Math.ceil` because a height rounded *down* crops the final text line by a
 *   sub-pixel — the "last line is clipped" bug. Round up so the box never clips.
 *
 * Note we deliberately do NOT apply the aggressive "border-only" / "implausible
 * collapse" guard here. That guard exists for elements whose layout context can
 * starve them (a flex/grid child stretched by a sibling, a percentage-height box
 * under an auto-height parent). Our measured node is a plain block in normal flow
 * with `height:auto` — it structurally cannot collapse to border-only, so a small
 * or zero reading here is a *real* small/empty panel, and we honor it.
 */
function trustHeight(blockSize: number): number | null {
  if (!Number.isFinite(blockSize) || blockSize < 0) return null;
  return Math.ceil(blockSize);
}

export interface UseAutoHeightOptions {
  /** Fired when the open/close transition finishes. `open` = the resting state. */
  onRest?: (open: boolean) => void;
}

export interface UseAutoHeightResult {
  /** Spread onto the outer clipping container (the element that animates). */
  containerProps: {
    ref: RefObject<HTMLDivElement | null>;
    className: string;
    style: CSSProperties;
    "data-ready"?: "";
    "aria-hidden"?: boolean;
    inert?: boolean;
    onTransitionEnd: (e: TransitionEvent<HTMLElement>) => void;
  };
  /** Spread onto the inner wrapper that holds your children (the measured node). */
  contentProps: {
    ref: RefObject<HTMLDivElement | null>;
    className: string;
  };
  /** The last trusted natural height of the content, in px (null before first measure). */
  measuredHeight: number | null;
}

export function useAutoHeight(
  open: boolean,
  options: UseAutoHeightOptions = {},
): UseAutoHeightResult {
  const { onRest } = options;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // Natural (unconstrained) height of the content. Always live — the observer
  // keeps it current even while the panel is closed, so the target is ready the
  // instant `open` flips.
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);

  // Suppress the transition on the very first commit so an initially-open panel
  // doesn't animate up from 0 on mount.
  const [ready, setReady] = useState(false);

  // Observe the CONTENT node (height:auto, unconstrained). ResizeObserver fires
  // after layout / before paint, and re-fires on every reflow: text rewrap on a
  // window resize, web-font swap, image load, async children streaming in. That
  // turns "is the height final yet?" from a guess into an event we subscribe to.
  useIsoLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // Prefer the borderBoxSize the observer already computed (no forced reflow);
      // fall back to a rect read on the rare engine that omits it.
      const block = entry.borderBoxSize?.[0]?.blockSize
        ?? entry.target.getBoundingClientRect().height;

      const next = trustHeight(block);
      if (next == null) return;
      setMeasuredHeight((prev) => (prev === next ? prev : next));
    });

    ro.observe(el, { box: "border-box" });
    return () => ro.disconnect();
  }, []);

  // Enable transitions after the first paint has committed.
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Resolve the container's height:
  //   open   -> the measured px (or `auto` for the one frame before first measure)
  //   closed -> 0
  // Because measuredHeight is kept live even while closed, the open case almost
  // always has a real px value already, so 0px -> Npx animates cleanly.
  const height: CSSProperties["height"] = open
    ? measuredHeight != null
      ? measuredHeight
      : "auto"
    : 0;

  const handleTransitionEnd = (e: TransitionEvent<HTMLElement>) => {
    // Ignore bubbling transitions from children; only react to our own height.
    if (e.target === containerRef.current && e.propertyName === "height") {
      onRest?.(open);
    }
  };

  return {
    containerProps: {
      ref: containerRef,
      className: "auto-height",
      style: { height },
      ...(ready ? { "data-ready": "" as const } : {}),
      "aria-hidden": !open,
      // Keep collapsed content out of the tab order & AT tree without
      // `display:none` (which would destroy our measurement). Requires React 19+;
      // drop this line and manage focus yourself on older React.
      inert: !open,
      onTransitionEnd: handleTransitionEnd,
    },
    contentProps: {
      ref: contentRef,
      className: "auto-height__content",
    },
    measuredHeight,
  };
}
```

## The minimal CSS

```css
.auto-height {
  overflow: hidden; /* clips the content while the box is shorter than it */
  transition: height 300ms cubic-bezier(0.4, 0, 0.2, 1);
  will-change: height;
}

/* No transition until the hook marks the first commit as ready — stops an
   initially-open panel from animating from 0 on mount. */
.auto-height:not([data-ready]) {
  transition: none;
}

/* Respect the user's motion preference — snap instead of animate. */
@media (prefers-reduced-motion: reduce) {
  .auto-height {
    transition: none;
  }
}

/* The measured node. It must stay height:auto and full-width so it always
   reports its true natural height. Do NOT put height:0 / overflow:hidden here —
   that's the container's job, not the content's. */
.auto-height__content {
  width: 100%;
}
```

## Usage

```tsx
function FaqItem({ question, answer }: { question: string; answer: React.ReactNode; }) {
  const [open, setOpen] = useState(false);
  const { containerProps, contentProps } = useAutoHeight(open);

  return (
    <div>
      <button aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {question}
      </button>
      <div {...containerProps}>
        <div {...contentProps}>{answer}</div>
      </div>
    </div>
  );
}
```

## Why it's robust — the parts that actually matter

**We measure the content, not the container.** The container's height is a value _we_ write (`0` / `Npx`), so reading it back tells us nothing. The inner `.auto-height__content` node is a plain block in normal flow at `height: auto`, so it always resolves to its true content height. This is the whole ballgame: height is a function of the available width and the content, and this node is never starved of either. The container clipping it with `overflow: hidden` does **not** constrain the child's own layout height — the child simply overflows and the observer sees the full number.

**The height is always live, even while closed.** Because the content node is real and unconstrained the whole time (never `display:none`), the observer keeps `measuredHeight` current whether the panel is open or shut. So when someone clicks "open," the target height is already known and correct — no first-open flicker, no reading a stale zero.

**Content that changes while open just works.** A `ResizeObserver` doesn't fire once; it re-fires on _every_ reflow. Window resize that rewraps a paragraph, a web font swapping in and changing line boxes, an image finishing decode, an async fetch injecting more DOM — each triggers the callback, `measuredHeight` updates, and the container animates to the new height. You don't have to know _when_ content is "done"; you observe and let it settle. (This is why the hook does not take a one-shot `scrollHeight` snapshot — a snapshot taken before the async content lands would be too short, and the content would sit clipped behind `overflow: hidden`.)

**`Math.ceil` on every committed height.** Sub-pixel content heights rounded _down_ crop the final line of text by a fraction of a pixel — the "why is the descender of the last line cut off" bug. We always round up.

**No `display: none`, ever.** A `display: none` element generates no layout box and measures `0`. That's why collapsed content is hidden with `height: 0` + `overflow: hidden` on the container (which keeps the box) and taken out of the a11y/tab tree with `aria-hidden` + `inert` — never with `display: none`, which would blind the observer.

**`useLayoutEffect` (via the SSR-safe shim), not `useEffect`.** Measurement and the initial style commit run after DOM mutation but before paint, so you never get a flash of the un-sized state. The shim degrades to `useEffect` on the server to avoid the React SSR warning.

## Two variations, depending on your taste

- **Content changes animate too (this default).** Every content change eases to the new height over 300ms — async content "grows in," resize reflow glides. Usually what you want, and it's the most robust because the container height tracks the content continuously; content is never clipped.
- **Instant on resize, animate only on toggle.** If you find the 300ms lag on window-resize reflow distracting, switch the container to `height: auto` once the open transition finishes (in `onRest`, when `open` is true). Reflow while open is then instant. The cost: collapsing must first snap `auto → measuredHeight` px, then to `0` on the next frame, so the transition has two definite endpoints to animate between. The version above avoids that complexity by keeping a pixel value at all times, which is why it can go straight from any current height to `0` and back.

**Web fonts, one extra nicety:** the observer already catches the font-swap reflow, so the panel self-corrects when the font loads. If you want to avoid animating that correction on a very first open, you can `await document.fonts.ready` before enabling transitions — but for most panels the automatic re-measure is fine and simpler.
