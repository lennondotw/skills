# `useAutoHeight` — a robust expand/collapse height hook

Animating to `height: auto` is the classic "why is this wrong again" problem. The browser can't transition to/from `auto`, so you have to feed it a real pixel value. The traps that bite people are almost always about _when and how you measure that pixel value_:

- measuring while the element is `display: none` (you get `0`),
- measuring once, before web fonts / images / async content settle (you get a stale, too-short height and the panel clips),
- letting a React re-render overwrite the height you set imperatively,
- margin-collapse eating the top/bottom margin of the children out of your measurement,
- a mount-time flash where a panel that starts open animates open from 0.

The design below sidesteps all of these. The core ideas:

1. **Never unmount or `display: none` the content** — collapse is done purely with `overflow: hidden` + `height: 0`. The content stays laid out and measurable at all times.
2. **A `ResizeObserver` is the single source of truth for the natural height.** We don't measure once — we _subscribe_ to the content's size. When text reflows on resize or async content loads in, the observer fires and we re-pin the height. The CSS transition animates the delta for free.
3. **The height is written imperatively to the DOM, never through React's `style` prop.** React only manages properties it knows about; since `height` is never in the returned `style` object, re-renders can't clobber it.
4. **The first commit is applied with the transition suppressed**, so a panel that starts open just _is_ open, with no animate-from-zero flash.

---

## The hook

```tsx
// useAutoHeight.ts
import { type CSSProperties, type RefObject, useEffect, useLayoutEffect, useRef } from "react";

// useLayoutEffect warns during SSR; fall back to useEffect on the server.
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export interface UseAutoHeightOptions {
  /** Transition duration in ms. Default: 300. */
  duration?: number;
  /** CSS timing function. Default: 'ease'. */
  easing?: string;
}

export interface UseAutoHeightResult<
  C extends HTMLElement,
  I extends HTMLElement,
> {
  /** Spread onto the OUTER clipping container. */
  containerProps: {
    ref: RefObject<C | null>;
    className: string;
    style: CSSProperties;
    "aria-hidden": boolean;
    inert?: boolean;
  };
  /** Spread onto the INNER content wrapper (the thing whose height we track). */
  contentProps: {
    ref: RefObject<I | null>;
  };
  /** Escape hatches if you'd rather wire refs by hand. */
  containerRef: RefObject<C | null>;
  contentRef: RefObject<I | null>;
}

export function useAutoHeight<
  C extends HTMLElement = HTMLDivElement,
  I extends HTMLElement = HTMLDivElement,
>(
  open: boolean,
  options: UseAutoHeightOptions = {},
): UseAutoHeightResult<C, I> {
  const { duration = 300, easing = "ease" } = options;

  const containerRef = useRef<C | null>(null);
  const contentRef = useRef<I | null>(null);

  // Let the ResizeObserver read the latest `open` without re-subscribing.
  const openRef = useRef(open);
  openRef.current = open;

  // Suppress the transition on the very first commit (no mount flash).
  const isFirstRun = useRef(true);

  useIsomorphicLayoutEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;

    // getBoundingClientRect gives a fractional (sub-pixel) border-box height,
    // which avoids the 1px clip you get from integer offsetHeight.
    const measure = (): number => content.getBoundingClientRect().height;

    const setHeight = (px: number) => {
      // Written straight to the DOM — NOT via React's style prop — so a
      // parent re-render can never reset it.
      container.style.height = `${px}px`;
    };

    const target = open ? measure() : 0;

    if (isFirstRun.current) {
      // Jump to the correct height with the transition turned off, so a
      // panel that starts open doesn't animate open from zero.
      const prevTransition = container.style.transition;
      container.style.transition = "none";
      setHeight(target);
      // Force a style flush so subsequent changes animate from `target`.
      void container.offsetHeight;
      container.style.transition = prevTransition;
      isFirstRun.current = false;
    } else {
      setHeight(target);
    }

    // While open, keep the height pinned to the LIVE content size.
    // This is what makes reflow-on-resize and async content Just Work:
    // the observer fires, we re-pin, the CSS transition animates the delta.
    const observer = new ResizeObserver((entries) => {
      if (!openRef.current) return;
      // borderBoxSize is unaffected by CSS transforms on ancestors
      // (getBoundingClientRect would report the scaled size).
      const box = entries[0]?.borderBoxSize?.[0];
      setHeight(box ? box.blockSize : measure());
    });
    observer.observe(content);

    return () => observer.disconnect();
  }, [open, duration, easing]);

  // Only static, safe-to-reconcile props go through React's style.
  // `height` is deliberately absent — the effect owns it.
  const style: CSSProperties = {
    // Custom props feed the CSS transition; overridable per-instance.
    ["--auto-height-duration" as string]: `${duration}ms`,
    ["--auto-height-easing" as string]: easing,
  };

  return {
    containerProps: {
      ref: containerRef,
      className: "auto-height",
      style,
      "aria-hidden": !open,
      // Keep collapsed content out of the tab order / a11y tree.
      inert: !open,
    },
    contentProps: { ref: contentRef },
    containerRef,
    contentRef,
  };
}
```

---

## The CSS (minimal)

```css
.auto-height {
  height: 0; /* initial + SSR state before the effect runs */
  overflow: hidden; /* the clip that makes 0-height hide the content */
  transition: height var(--auto-height-duration, 300ms)
    var(--auto-height-easing, ease);
}

/* Respect users who don't want motion — collapse instantly. */
@media (prefers-reduced-motion: reduce) {
  .auto-height {
    transition-duration: 1ms;
  }
}
```

That's the whole required stylesheet. Two rules matter:

- `overflow: hidden` — without it the content spills out of the 0-height box.
- `height: 0` as the base — this is the value that's in effect during SSR and for the split second before the layout effect runs, so a closed panel is closed from the very first paint.

> **Optional but recommended:** give your inner content wrapper `display: flow-root` (or padding). This establishes a block formatting context so the children's top/bottom margins are _inside_ the measured box instead of collapsing through it. Margin-collapse is the sneakiest source of "the measured height is a bit short."

```css
.auto-height__content {
  display: flow-root; /* prevents child margins collapsing out of the measurement */
}
```

---

## Usage

```tsx
function FaqItem({ question, answer }: { question: string; answer: React.ReactNode; }) {
  const [open, setOpen] = React.useState(false);
  const { containerProps, contentProps } = useAutoHeight(open);

  return (
    <div>
      <button aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {question}
      </button>

      {/* OUTER: the clipping container the hook drives */}
      <div {...containerProps}>
        {/* INNER: the natural-height content the hook measures */}
        <div {...contentProps} className="auto-height__content">
          {answer}
        </div>
      </div>
    </div>
  );
}
```

The two-element structure (**outer clipper** + **inner content**) is not optional. The outer element's height is animated and clipped; the inner element is left at its natural height so it's always honestly measurable. If you put both jobs on one element you're back to fighting the browser.

---

## Why this survives the things that usually break it

| Failure mode                                                                  | How this avoids it                                                                                                                                                                          |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Content changes while open** (text reflow on resize, async data loading in) | The `ResizeObserver` is subscribed to the inner content the whole time it's open. Any size change re-pins the height and the transition animates to it — no manual "remeasure" call needed. |
| **Measuring a hidden element gives 0**                                        | The content is never `display: none` and never unmounted. Collapse is `overflow: hidden` + `height: 0`, so the inner element always has a real, measurable layout height.                   |
| **Measured too early** (before fonts/images settle)                           | We don't measure once. Fonts loading, images decoding, and lazy content all change the box size → the observer fires → we correct. Self-healing by construction.                            |
| **React re-render resets the height**                                         | `height` is written straight to `container.style` and is never present in the React-managed `style` prop, so reconciliation leaves it alone.                                                |
| **Mount flash** (a panel that starts open animates from 0)                    | The first commit runs inside a `transition: none` window with a forced reflow, so it snaps to the correct height instantly.                                                                 |
| **Sub-pixel clipping**                                                        | We read a fractional height (`getBoundingClientRect` / `borderBoxSize.blockSize`) instead of integer `offsetHeight`.                                                                        |
| **CSS transforms lie about size**                                             | Inside the observer we prefer `borderBoxSize`, which reports layout size regardless of an ancestor `scale()`.                                                                               |
| **Margin collapse shortens the measurement**                                  | Recommended `display: flow-root` on the content wrapper keeps child margins inside the measured box.                                                                                        |
| **Accessibility / tab order**                                                 | Collapsed content gets `aria-hidden` + `inert`, so it's out of the a11y tree and unfocusable while hidden, but still in the DOM and measurable.                                             |
| **Reduced-motion users**                                                      | A single media query drops the duration to ~0; the imperative height writes then apply instantly with no visible animation.                                                                 |

### Notes and trade-offs

- **We keep the height pinned to a pixel value even when fully open** (rather than snapping to `height: auto` after the open transition). This is a deliberate choice: staying pixel-pinned is exactly what lets dynamic content animate smoothly, at the cost of the observer running while the panel is open. That cost is negligible — `ResizeObserver` is cheap and only writes when the size actually changes.
- **The animation follows content growth while open.** If async content loads in 400ms after opening, you'll see the panel glide to its new height. That's usually what you want; if you'd rather it snap for late loads, you could gate the observer to only animate within a window after `open` flips.
- **`inert`** is broadly supported in modern browsers and typed on React 19's DOM props. On older React typings, cast it or drop it and rely on `aria-hidden` alone.
- **`ResizeObserver`** is universally available in evergreen browsers. If you must support ancient ones, polyfill it — everything else in the hook degrades gracefully (you'd just lose live re-measurement, keeping open/close).
