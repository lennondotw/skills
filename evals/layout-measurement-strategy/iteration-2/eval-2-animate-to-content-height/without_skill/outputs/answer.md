# `useAutoHeight` — animate a panel between 0 and its content height

The core problem with "animate to `auto`" is that CSS can't transition to/from `height: auto` — you must transition between two pixel values. The trick is to measure the natural height of the content and drive the container's height to that number, then hand control back to the browser so subsequent content changes don't fight the animation.

The robustness traps I've been bitten by (and this hook defends against):

1. **Measuring before layout / fonts settle** — reading height too early gives the wrong number. Measure with a `ResizeObserver` on the _content_, not a one-shot `scrollHeight` read.
2. **Content changing while open** — text reflows on window resize, async data loads in later. If you froze a pixel height at open time, the panel clips or leaves a gap. The observer keeps the height in sync.
3. **Fighting the transition** — if you set an explicit pixel height and leave it, later content growth won't animate and the container can't naturally reflow. After the open transition ends, we set height back to `auto` so the panel is fully fluid; we only re-pin a pixel value at the moment we need to animate.
4. **The 0→auto and auto→0 direction problem** — you can't transition _from_ `auto`. Before collapsing you must first pin the current pixel height (forcing a reflow) and _then_ animate to 0.
5. **First-paint flash** — on mount, a panel that starts open shouldn't animate from 0; and one that starts closed shouldn't flash open. We gate the first commit.
6. **`box-sizing` / padding** — `scrollHeight` and `getBoundingClientRect` behave differently with padding. We measure an inner wrapper and put visual padding _inside_ it so the number we animate to is exactly the number we set.

## The hook

```tsx
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

type UseAutoHeightOptions = {
  /** Transition duration in ms. Must match the CSS if you override it there. */
  duration?: number;
  /** Respect prefers-reduced-motion by snapping instead of animating. */
  respectReducedMotion?: boolean;
};

type UseAutoHeightResult = {
  /** Attach to the animating container (the element whose height changes). */
  containerRef: React.RefObject<HTMLDivElement>;
  /** Attach to the inner wrapper that holds the real content. */
  contentRef: React.RefObject<HTMLDivElement>;
  /** Inline style to spread onto the container. */
  containerStyle: React.CSSProperties;
  /** True while a collapse/expand transition is running (handy for aria/pointer). */
  isAnimating: boolean;
};

export function useAutoHeight(
  open: boolean,
  { duration = 250, respectReducedMotion = true }: UseAutoHeightOptions = {},
): UseAutoHeightResult {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // The live measured height of the content, kept fresh by ResizeObserver.
  const measuredRef = useRef(0);

  // What we actually write to style.height: a number (px), "auto", or 0.
  const [height, setHeight] = useState<number | "auto">(open ? "auto" : 0);
  const [isAnimating, setIsAnimating] = useState(false);

  // Skip animating the very first commit so an initially-open panel doesn't
  // slide down on mount (and an initially-closed one doesn't flash).
  const firstRun = useRef(true);

  const prefersReduced = useCallback(() => {
    if (!respectReducedMotion || typeof window === "undefined") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, [respectReducedMotion]);

  // Keep the measured height current. This is what makes content that changes
  // while open (reflow, async load) behave: whenever content resizes and we're
  // open with height:auto, we do nothing (auto handles it); whenever we're
  // mid-open with a pinned pixel height, we update the target so we animate to
  // the *new* size rather than a stale one.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      // borderBoxSize is the reliable cross-box-model measurement.
      const next = entry.borderBoxSize?.[0]?.blockSize
        ?? entry.target.getBoundingClientRect().height;
      measuredRef.current = next;

      // If we're open and currently pinned to a pixel value (i.e. mid or
      // just-finished expand), keep that value tracking the real content.
      setHeight((prev) => {
        if (prev === "auto" || prev === 0) return prev;
        return next;
      });
    });

    ro.observe(content);
    // Seed an initial measurement synchronously.
    measuredRef.current = content.getBoundingClientRect().height;
    return () => ro.disconnect();
  }, []);

  // Drive the open/close transition.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const target = measuredRef.current;

    // First commit: set the resting state without animating.
    if (firstRun.current) {
      firstRun.current = false;
      setHeight(open ? "auto" : 0);
      return;
    }

    if (prefersReduced()) {
      setHeight(open ? "auto" : 0);
      return;
    }

    setIsAnimating(true);

    if (open) {
      // 0 -> content height. We're currently at 0 (or auto). Pin to the
      // measured px so the browser has two concrete numbers to interpolate.
      setHeight(target);
    } else {
      // auto -> 0. You cannot transition *from* auto, so first pin the current
      // pixel height, force a reflow, then drop to 0 on the next frame.
      setHeight(target);
      // Force layout so the pinned height is committed before we change it.
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      el.getBoundingClientRect();
      requestAnimationFrame(() => {
        setHeight(0);
      });
    }
  }, [open, prefersReduced]);

  // When the expand transition finishes, release to `auto` so the panel is
  // fully fluid and later growth/shrink just works with no JS.
  const handleTransitionEnd = useCallback(
    (e: React.TransitionEvent) => {
      // Only react to the height transition on the container itself, not
      // bubbled transitions from children.
      if (e.propertyName !== "height" || e.target !== containerRef.current) {
        return;
      }
      setIsAnimating(false);
      if (open) setHeight("auto");
    },
    [open],
  );

  // Safety net: if a transitionend never fires (e.g. duration 0, tab
  // backgrounded, or the height didn't actually change), still settle state.
  useEffect(() => {
    if (!isAnimating) return;
    const t = window.setTimeout(() => {
      setIsAnimating(false);
      if (open) setHeight("auto");
    }, duration + 50);
    return () => window.clearTimeout(t);
  }, [isAnimating, open, duration]);

  const containerStyle: React.CSSProperties = {
    height: height === "auto" ? "auto" : `${height}px`,
    // Expose duration to CSS so JS and CSS stay in sync from one source.
    ["--auto-height-duration" as string]: `${duration}ms`,
    // The transitionEnd handler lives on the element via onTransitionEnd below,
    // but we return the callback separately so you can wire it up.
  };

  // Attach the handler through a ref effect so callers only spread style.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const listener = (ev: TransitionEvent) =>
      handleTransitionEnd(ev as unknown as React.TransitionEvent);
    el.addEventListener("transitionend", listener);
    return () => el.removeEventListener("transitionend", listener);
  }, [handleTransitionEnd]);

  return { containerRef, contentRef, containerStyle, isAnimating };
}
```

## The CSS (minimal)

```css
.auto-height {
  overflow: hidden;                 /* clip content while collapsed / mid-animation */
  height: 0;                        /* JS overrides this; safe default */
  transition: height var(--auto-height-duration, 250ms) ease;
  will-change: height;              /* hint; drop it if you have many panels */
}

/* Put ALL visual padding on the inner wrapper, never on .auto-height,
   so the measured number equals the number we animate to. */
.auto-height__content {
  /* your padding / layout here, e.g.: */
  padding: 16px;
}

@media (prefers-reduced-motion: reduce) {
  .auto-height {
    transition: none;
  }
}
```

## Usage

```tsx
function Panel({ open, children }: { open: boolean; children: React.ReactNode; }) {
  const { containerRef, contentRef, containerStyle } = useAutoHeight(open);

  return (
    <div
      ref={containerRef}
      className="auto-height"
      style={containerStyle}
      aria-hidden={!open}
    >
      <div ref={contentRef} className="auto-height__content">
        {children}
      </div>
    </div>
  );
}
```

## Why this is robust — the pieces that matter

- **Two elements, two jobs.** `containerRef` is the thing whose `height` animates and clips (`overflow: hidden`). `contentRef` is the natural-height inner box the `ResizeObserver` watches. Never measure the animating element itself — its height is a lie during the transition.
- **`ResizeObserver`, not `scrollHeight`.** A one-time `scrollHeight` read is the classic bug: it's taken before webfonts swap, before images decode, before async data arrives — so it's wrong. The observer re-measures whenever the content actually changes size, including window-resize reflow and late-loading content.
- **Release to `auto` after expanding.** Once open, the container is `height: auto`, so any subsequent growth/shrink is handled by the browser with zero JS and no clipping. We only re-pin a pixel value at the instant we start an animation.
- **Handle the `auto → 0` direction explicitly.** You cannot transition _from_ `auto`. On close we pin the current measured px, force a synchronous reflow (`getBoundingClientRect()`), then drop to `0` on the next frame so the browser sees two numbers.
- **`useLayoutEffect`** for the measurement and the pin-height step so writes happen before paint — no flicker between "auto" and the pixel value.
- **First-commit gate** so an initially-open panel doesn't animate open on mount.
- **`prefers-reduced-motion`** snaps instead of sliding.
- **`transitionend` guarded by `propertyName` and `target`** so a child element's own transition doesn't prematurely flip us to `auto`. Plus a `setTimeout` safety net for the cases where `transitionend` never fires (zero-height change, backgrounded tab).

### Edge cases worth knowing

- If the panel can start open _and_ its content isn't measured yet on the first frame, the initial `auto` is correct (browser lays it out naturally) — we only need a real measurement when a _transition_ begins, by which point layout has happened.
- Nested transitions on children can fire `transitionend` that bubbles; the `e.target === containerRef.current` guard is doing real work — don't remove it.
- If you have dozens of these on screen, drop `will-change: height` (it costs memory per layer) and consider animating only when in view.
