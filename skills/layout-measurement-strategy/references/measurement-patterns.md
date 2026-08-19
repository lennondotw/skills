# Measurement patterns — copy-pasteable code

Three patterns, ranked by preference. **(A) is the default** — it never leaves the real cascade, so it cannot measure the wrong context. Reach for **(B)** only when you need the number synchronously before paint. **(C)** is the settle loop + batched measurement that both build on.

All hooks are thin wrappers over three vanilla primitives — the vanilla equivalent is noted per pattern.

## Shared: the validity predicate

```ts
/** Below this, a height is "collapsed / not yet real." Tune > max expected total border. */
export const MIN_TRUSTWORTHY_HEIGHT = 4; // px

/**
 * Returns the height if trustworthy, else null (keep previous / stay loading; do NOT commit).
 * chromeH = top+bottom border+padding of the measured element, if known.
 */
export function trustHeight(borderBoxH: number, chromeH = 0, prev?: number): number | null {
  if (!Number.isFinite(borderBoxH) || borderBoxH <= 0) return null;
  if (borderBoxH - chromeH <= 1) return null; // border-only
  if (borderBoxH < MIN_TRUSTWORTHY_HEIGHT) return null; // near-zero
  if (prev != null && borderBoxH < prev * 0.25) return null; // implausible collapse
  return Math.ceil(borderBoxH);
}
```

---

## (A) In-place placeholder + hidden content — the default

The content stays in its real place at its real width with real context the entire time; only `visibility` and flow position toggle. A placeholder holds the flow open so the page doesn't jump. **Never** `height: 0 + overflow: hidden` on the content — under flex/grid/percentage parents that reads back the constrained `0`.

```tsx
import { useLayoutEffect, useRef, useState } from "react";
import { MIN_TRUSTWORTHY_HEIGHT, trustHeight } from "./trustHeight";

export function MeasureInPlace({ children }: { children: React.ReactNode; }) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState<number | null>(null); // null ⇒ still measuring

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    let prev: number | undefined;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.borderBoxSize?.[0]?.blockSize;
      if (h == null) return;
      const trusted = trustHeight(h, /* chromeH */ 0, prev);
      if (trusted != null) {
        prev = trusted;
        setHeight(trusted);
      }
    });
    ro.observe(el, { box: "border-box" });
    return () => ro.disconnect();
  }, []);

  const measuring = height == null;
  return (
    <div style={{ position: "relative", width: "100%" }}>
      {measuring && <div style={{ minHeight: 48 /* loading height */ }} aria-hidden />}
      <div
        ref={contentRef}
        style={{
          width: "100%", // real inline size
          visibility: measuring ? "hidden" : "visible", // keeps layout box
          position: measuring ? "absolute" : "static", // out of flow, still boxed
          inset: measuring ? 0 : undefined,
        }}
      >
        {children}
      </div>
    </div>
  );
}
```

**Vanilla:** set the same styles on the real node, `new ResizeObserver(cb).observe(el, { box: "border-box" })`, read `entry.borderBoxSize[0].blockSize`, run through `trustHeight`, toggle `visibility`/`position` when trusted, `disconnect()`.

---

## (B) Off-flow probe — synchronous number before paint

Use when a layout algorithm must place _other_ elements against this height before first paint (the collapsed-widget badge case). Mount the probe **inside the real subtree** (inline hidden, or a React portal into a container under the same themed / container / shadow ancestor) so it inherits vars, fonts, `@container` context, and shadow stylesheets — **not** on `document.body`.

```tsx
const probeStyle: React.CSSProperties = {
  position: "absolute",
  insetInlineStart: "-10000px", // logical, not `left`, so RTL is safe
  insetBlockStart: 0,
  inlineSize: 512, // == the real render width. THE load-bearing line.
  blockSize: "auto", // let it expand. NOT 0.
  visibility: "hidden", // still lays out; invisible + not hit-tested
  pointerEvents: "none",
  // do NOT set overflow:hidden — it can clip the very growth you're measuring
  contain: "layout", // optional: isolate its layout cost (NOT `size`)
};
// <div ref={probeRef} style={probeStyle} aria-hidden>{content}</div>
```

Why each choice: `insetInlineStart:-10000px` (not `display:none`) keeps the box; `visibility:hidden` + `aria-hidden` keeps it out of the a11y/tab tree; fixed `inlineSize` because height is a function of width; parking with `position` (not `transform: translate`) so `getBoundingClientRect` and `offset*` agree — a `transform` scale would inflate the rect.

> **Shadow DOM:** a probe in the light DOM gets none of a shadow root's stylesheets. Measure inside a shadow root that adopts the **same** `adoptedStyleSheets` objects (share, don't clone). See `context-replication.md`.

Read it through the same RO + `trustHeight` loop as (A). If you also need a one-shot read after fonts, gate it on `document.fonts.ready` before the first trusted commit.

**Vanilla:** identical — create the node, set `probeStyle`, mount it inside the real subtree, observe, read `blockSize`, `trustHeight`, `disconnect`.

---

## (C) The settle loop and batched measurement

### Settle loop (one-shot trustworthy measure)

```ts
export async function measureSettled(
  el: HTMLElement,
  chromeH = 0,
  { awaitFonts = true } = {},
): Promise<number> {
  if (awaitFonts && "fonts" in document) await document.fonts.ready;
  return new Promise((resolve) => {
    let last: number | null = null;
    let stableFor = 0;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.borderBoxSize?.[0]?.blockSize;
      if (h == null) return;
      const trusted = trustHeight(h, chromeH, last ?? undefined);
      if (trusted == null) return; // reject border-only / collapsed
      stableFor = trusted === last ? stableFor + 1 : 0;
      last = trusted;
      if (stableFor >= 1) { // stable across 2 deliveries ⇒ settled
        ro.disconnect();
        resolve(trusted);
      }
    });
    ro.observe(el, { box: "border-box" });
  });
}
```

### Batched N-node measurement — no layout thrash

Reading geometry after a layout-dirtying write forces a synchronous reflow. Interleaving write/read per node is **O(N) reflows** (layout is whole-dirty-subtree work). Separate the frame into a write phase and a read phase — the first read forces **one** layout that resolves all pending writes; the rest hit a clean tree.

```ts
export function measureMany(items: { el: HTMLElement; width: number; }[]): number[] {
  for (const { el, width } of items) el.style.inlineSize = `${width}px`; // WRITE ALL
  return items.map(({ el }) => el.offsetHeight); // READ ALL
}
```

The invariant: **never issue a layout-dirtying write between reads.** One stray `el.style.x = …` mid-loop resets you to O(N). This is the same measure-then-mutate discipline FLIP uses (read all "First" boxes, write all end states, read all "Last" boxes) to animate without a reflow per frame.

### Animating a container to its content height

For an expand/collapse (`0 ↔ content height`), the height the container transitions to must come from an element that is **not** the one being constrained. Measure an **inner wrapper left at `height: auto`** and observe _it_ with a `ResizeObserver`; the outer container clips it with `overflow: hidden` and animates its own height to the measured value. Reading the outer container's height would just read back what you set. Two supporting details:

- **`display: flow-root` on the measured inner wrapper** — otherwise the children's top/bottom margins collapse out of the measurement and the panel animates to a height that clips them.
- **Keep the content in the DOM** while collapsed (`height: 0` + `overflow: hidden` on the container, `aria-hidden` + `inert` for a11y) — never `display: none`, which removes the box and blinds the observer. Because the inner wrapper stays measurable even while closed, the target height is already known the instant `open` flips, so `0 → N` animates without a first-open flicker.

### React gotcha: don't let re-render clobber an imperative height

If the _same element's_ height is both animated and written from a measurement, writing it through React's `style` prop means any parent re-render reconciles `style.height` back to a stale value mid-animation. Two safe options: keep the measured height in React state and let React own it consistently (fine when the measurement drives the render), or write `el.style.height` **imperatively** from the effect / RO callback and keep `height` out of the JSX `style` object entirely, so reconciliation never touches it. Pick one owner for the property; the bug is having two.

### `useLayoutEffect` on the server

`useLayoutEffect` warns during SSR (no DOM). For measurement hooks, use the isomorphic shim — there's nothing to measure on the server anyway, so the first client pass is where measurement starts:

```ts
import { useEffect, useLayoutEffect } from "react";
export const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;
```
