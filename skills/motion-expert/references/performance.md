# Performance: Hardware Acceleration, Bundle Size, Common Pitfalls

Load this when the symptom is "feels janky", when reviewing animation-heavy pages for frame budget, or when making bundle-size decisions.

## The hardware acceleration whitelist

Browsers can offload animations to the GPU compositor only for certain CSS properties. Motion's WAAPI path exploits this; the main-thread path does not benefit unless the property happens to be compositor-friendly.

The engine's accelerated set (`packages/motion-dom/src/animation/waapi/utils/accelerated-values.ts`):

- `opacity`
- `transform`
- `clipPath`
- `filter`

Not accelerated (animating these triggers paint or layout):

- `width`, `height`, `top`, `left`, `right`, `bottom`
- `margin*`, `padding*`
- `border*` (not the radius, the border itself)
- `background-color`, `color` (under investigation — `background-color` is commented out in the accelerated list pending a Chromium issue)
- `box-shadow`
- `font-size`, `line-height`
- `border-radius` at pixel values (percentages avoid repaint on scale)

### Replacement strategies

| Want to animate       | Do not                            | Do                                                                        |
| --------------------- | --------------------------------- | ------------------------------------------------------------------------- |
| Box size              | `width` / `height`                | `scale` or `layout` (FLIP)                                                |
| Position              | `top` / `left`                    | `x` / `y` (translate)                                                     |
| Rounded corner change | `border-radius` animated directly | `clip-path: inset(0 round X)`                                             |
| Soft shadow           | `box-shadow` tween                | `filter: drop-shadow(...)` (single layer shadow only)                     |
| Color                 | `background-color`                | Stack two colored layers, animate `opacity`                               |
| Outline / focus ring  | `outline`                         | Overlay an absolutely-positioned pseudo-element with `transform: scale()` |
| Gradient angle        | `linear-gradient(...)` keyframes  | `transform: rotate()` a gradient layer                                    |

`filter: drop-shadow` is important but partial: it renders only a single shadow, not multiple layers, and it is expensive on large bounding boxes. For complex multi-layer shadows, pre-render them on a pseudo-element and cross-fade.

## The `onUpdate` trap

Recap from `animation-engine.md`: any transition with an `onUpdate` callback is forced to the main-thread `JSAnimation` path, even for accelerated properties.

Common accidental triggers:

```tsx
// Wrong: forces main-thread even though opacity is GPU-friendly
<motion.div
  animate={{ opacity: 1 }}
  transition={{
    duration: 0.3,
    onUpdate: (v) => console.log(v),
  }}
/>;
```

Fixes:

- Remove the callback. If debugging, gate by `NODE_ENV`.
- Replace with a `MotionValue` subscription if you need the value continuously:

```tsx
const opacity = useMotionValue(0);
useMotionValueEvent(opacity, "change", (v) => {/* ... */});
return <motion.div style={{ opacity }} animate={{ opacity: 1 }} />;
```

`useMotionValueEvent` does not disable WAAPI because the animation runs against the `MotionValue`, and the subscription is not an animation callback.

## Independent transforms and the GPU

Motion v12 supports `x`, `y`, `scale`, `rotate` as independent `MotionValue`s. Under the hood, the engine composes these into a single `transform` string — which is GPU-accelerated.

However, if you set them as CSS custom properties (`--x`, `--y`) and construct the transform in CSS:

```css
.item { transform: translate(var(--x), var(--y)); }
```

```tsx
<motion.div style={{ "--x": x, "--y": y }} />;
```

The animation of the custom property is **not composited**. Every frame the browser resolves the variable and recalculates the transform on the main thread.

For GPU-accelerated transforms, use `useMotionTemplate`:

```tsx
const transform = useMotionTemplate`translate(${x}px, ${y}px) scale(${scale})`;
return <motion.div style={{ transform }} />;
```

Or pass directly as typed props (Motion handles composition):

```tsx
<motion.div style={{ x, y, scale }} />;
```

## `box-shadow` animation

Animating `box-shadow` is paint-heavy: the browser rasterizes a blurred region every frame. Cost scales with blur radius squared.

Strategies (in order of preference):

1. **Cross-fade two shadows.** Render two elements, one with the small shadow, one with the large, and animate `opacity`.
2. **Single `filter: drop-shadow`.** If the element has a single-layer shadow with a simple shape, `filter` is cheaper than `box-shadow` and runs on the compositor for simple cases.
3. **CSS variable.** Animate a custom property and let CSS compose the shadow. Not GPU, but bundled with other paints.
4. **Motion's scale correction.** If the animation is a scale change (not an intrinsic shadow change), the scale corrector keeps the shadow proportional without a separate animation.

## `border-radius` animation

Pixel radii animate on the paint layer and cause repaint.

- On elements with `layout` / `layoutId`: scale correction handles the visual distortion during FLIP. Put the radius in `style` and let the corrector do its job. No explicit animation needed.
- On standalone elements (no layout): `border-radius` is expensive. Alternative: `clip-path: inset(0 round <r>)`. `clip-path` animates on the compositor.

## Painting hints: `will-change`, `transform: translateZ(0)`

Promoting a layer to its own compositor tile can prevent repaints:

```css
.animating { will-change: transform, opacity; }
```

Caveats:

- **Adds memory cost.** Every promoted layer is rasterized separately. Overuse (applying to many elements) can OOM on low-end devices.
- **Remove after animation.** Keep `will-change` only while the element is actively animating:

```tsx
<motion.div
  onAnimationStart={(def) => ref.current?.style.setProperty("will-change", "transform")}
  onAnimationComplete={() => ref.current?.style.removeProperty("will-change")}
/>;
```

- `transform: translateZ(0)` is the older hack; `will-change` is the modern equivalent. Do not combine.

Motion does not automatically apply `will-change`. The library's position: if you know the animation is about to run, hint the compositor; if you don't, don't pay the cost.

## Frame budget

A 60 Hz display gives ~16.67 ms per frame. Browser reserves ~6 ms for compositor/paint/style. That leaves **~10 ms for JS work per frame** if you want zero dropped frames.

Motion's main-thread animations contribute to that JS budget. WAAPI-offloaded animations do not.

Guidelines:

- Keep any single `onUpdate` handler under 1 ms.
- Avoid DOM queries in `onUpdate` — they force layout.
- `useTransform` with a function (`useComputed`) fires on every source change. Keep the function pure and cheap.

## Bundle size tiers

Motion's public packages offer a gradient from "everything" to "minimal", ordered from largest to smallest payload:

| Import                                                    | Includes                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `motion/react` (full)                                     | All components, all hooks, drag, layout, gestures.                                                     |
| `motion/react-m` + `<LazyMotion features={domMax}>`       | Full capability, but loaded on demand; dev-time `strict` guards against accidental `motion.*` usage.   |
| `motion/react-m` + `<LazyMotion features={domAnimation}>` | Animations + core gestures (hover, tap, focus, whileInView). No drag, no layout.                       |
| `motion/react-mini`                                       | The `m` component plus a narrow animation surface. No layout, no drag, no springs.                     |
| `motion/mini` (vanilla)                                   | `animate`, `scroll`, `inView`, `hover`, `press`. No springs, no keyframes, no MotionValue integration. |

Official gzip sizes per export are not published in the repo or docs. The repository's `packages/framer-motion/package.json` declares `bundlesize` **upper bounds** per chunk (e.g. `motion`, `dom-animation`, `dom-max`) which you can inspect for order-of-magnitude sizing; actual emitted size depends on your bundler, mode, and which hooks / features you actually reference. For concrete figures in your app, always verify with `@next/bundle-analyzer`, `source-map-explorer`, or equivalent.

Feature-by-feature, the largest contributors (relative ordering, not absolute KB):

- **Layout** — projection tree, `NodeStack`, scale correction; the biggest single feature cost.
- **Drag** — `PanSession`, inertia solver, constraint math.
- **Complex value mixers** — color spaces, shadow parsing, complex string interpolation.
- **Spring solver** — closed-form and Newton-iteration paths.

### Decision tree

1. **Do you use `layout` or `layoutId` anywhere?**
   - Yes → stay on full `motion/react` (the layout bundle is a majority of the size).
   - No → consider `LazyMotion` + `domAnimation`.
2. **Do you use `drag`?**
   - Yes → need `domMax`.
   - No → `domAnimation` is sufficient.
3. **Do you need springs / inertia?**
   - No → consider `motion/mini` for vanilla-only sites or animation-light React apps.

### Dynamic loading

```tsx
import { LazyMotion, m } from 'motion/react';

const loadFeatures = () =>
  import('motion/react').then((res) => res.domAnimation);

<LazyMotion features={loadFeatures} strict>
  <m.div ... />
</LazyMotion>
```

Features are loaded on first render of the `LazyMotion` tree. Before loading, `m` components render without animations (the initial / animate props are ignored). This is fine for below-the-fold content; it is jarring for above-the-fold.

`strict` is a dev guard against accidentally rendering `motion.*` inside a `LazyMotion` subtree (which would defeat tree-shaking); it throws on that mistake. It does not verify that the loaded bundle covers the props you used — using `drag` under `domAnimation` just silently has no effect at runtime.

## Accessibility and reduced motion

`useReducedMotion()` returns `true` when the user has `prefers-reduced-motion: reduce` in their OS settings. Wire this into every decorative animation:

```tsx
const prefersReduced = useReducedMotion();

<motion.div
  initial={{ opacity: 0, y: prefersReduced ? 0 : 20 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: prefersReduced ? 0 : 0.4 }}
/>;
```

Alternative: set `MotionConfig reducedMotion="user"` at the top of the tree. This automatically zeros `transform` and `layout` animations when the user preference is set. Colors and opacity still animate.

Motion's automatic reduced-motion behavior (`MotionConfig.reducedMotion`):

- `'never'` (default) — always animate.
- `'always'` — always respect reduced motion, zeroing transforms and layout.
- `'user'` — respect user preference via `prefers-reduced-motion`.

Even with `'user'`, explicit opacity / color animations still play. Motion's assumption: color and opacity are rarely vestibular triggers; transforms (especially parallax, large movement, zoom) are.

## Common pitfalls

### 1. Animating a large list

Each `motion` component has a projection node. For a list of 10,000 items, the tree traversal is significant.

Solutions:

- **Virtualize the list** (react-virtual, react-window). Motion handles unmount/mount gracefully; the projection tree only contains rendered nodes.
- **Use `layout` only on visible items.** Pass `layout={isVisible ? true : false}` per item.
- **Batch animations.** Use `animate([...])` with a timeline rather than 10,000 individual `animate()` calls.

### 2. Scroll-linked animations that re-render

```tsx
// Wrong: re-renders on every scroll
const { scrollY } = useScroll();
const [y, setY] = useState(0);
useMotionValueEvent(scrollY, "change", setY);
return <div style={{ transform: `translateY(${y}px)` }} />;
```

`useMotionValueEvent` + `setState` chains scroll progress into React state. Re-renders at ~60 Hz.

Fix: pass the `MotionValue` directly to a `motion` component's `style`:

```tsx
const { scrollY } = useScroll();
return <motion.div style={{ y: scrollY }} />;
```

### 3. Nested `LayoutGroup` over large trees

`LayoutGroup` marks every descendant `willUpdate` when any member updates. For a group containing 500 nodes, one layout change triggers 500 snapshots + measurements.

Fix: scope `LayoutGroup` tightly. One group per shared-layout scope, not one group for the whole page.

### 4. Inadvertent `AnimatePresence` unmounts

```tsx
// Wrong: AnimatePresence inside a conditional
{
  isOpen && (
    <AnimatePresence>
      <motion.div exit={{ opacity: 0 }} />
    </AnimatePresence>
  );
}
```

When `isOpen` flips to `false`, the `AnimatePresence` itself unmounts, cancelling the exit animation before it plays.

Fix:

```tsx
<AnimatePresence>
  {isOpen && <motion.div key="overlay" exit={{ opacity: 0 }} />}
</AnimatePresence>;
```

`AnimatePresence` must be a stable ancestor of the conditional children, not conditional itself.

### 5. Stale `useScroll` targets

```tsx
const { scrollYProgress } = useScroll({ target: ref });
return (
  <div>
    {isOpen && <div ref={ref}>...</div>}
    <motion.div style={{ opacity: scrollYProgress }} />
  </div>
);
```

If `ref.current` changes from `null` to an element, `useScroll` does not re-measure. Pass `offset` and verify the ref is set on mount.

### 6. Key reuse across `AnimatePresence`

Using `index` as key on a list inside `AnimatePresence` treats insertions as updates. Exit animations play on the wrong items.

Fix: stable, unique keys from the data model.

### 7. Drag without `touch-action`

Touch devices may steal the gesture for scrolling before Motion's drag engages.

Fix: `style={{ touchAction: 'none' }}` on the drag target if the page is not scrolled in the same axis.

## Measuring

Tools:

- **Chrome DevTools Performance panel** — record a 5-second session during the animation. Look for frames exceeding 16.67 ms. Large JS blocks indicate main-thread animations.
- **`Long Tasks API`** — observe tasks >50 ms via `PerformanceObserver`. Long tasks during animation are the target to reduce.
- **React Profiler** — check whether `motion` components are re-rendering on every frame (they should not).
- **`activeAnimations` counter** — if Motion exposes it in dev, `activeAnimations.mainThread` vs `.waapi` tells you backend distribution.

## Reference points

- Accelerated list: `packages/motion-dom/src/animation/waapi/utils/accelerated-values.ts`.
- WAAPI gate: `packages/motion-dom/src/animation/waapi/supports/waapi.ts`.
- LazyMotion: `packages/framer-motion/src/components/LazyMotion/index.tsx`.
- Feature bundles: `packages/framer-motion/src/render/dom/features-animation.ts`, `features-max.ts`, `features-min.ts`.
- Reduced motion: `packages/framer-motion/src/utils/reduced-motion/` and `MotionConfig`.
