# Animation Engine: Backends, Frameloop, Drivers

Load this when reviewing performance, debugging "why is this janky", choosing between WAAPI and main-thread behavior, or writing any custom `animate()` / `animateMini()` call.

## Two animation backends

Motion runs one of two engines per animation, chosen at start time:

### `JSAnimation` — main thread, generator-driven

Source: `packages/motion-dom/src/animation/JSAnimation.ts`. Also the subject of the old alias "MainThreadAnimation" that still appears in parts of the changelog.

Behavior:

- Each frame, the driver (default `frameloopDriver`) calls `tick(timestamp)`.
- The installed **generator** (spring, keyframes, inertia) advances and produces `{ value, done, isComplete }`.
- The value is written via `onUpdate` — typically `MotionValue.set`, which fans out to subscribers and eventually the renderer.
- `activeAnimations.mainThread++` at init; decremented at teardown. Useful for telemetry.

`JSAnimation` can animate **anything** — numbers, colors, complex strings (`translate(10px, 20%) scale(1.2)`), even object properties for non-DOM subjects. Cost: every frame touches JS and must eventually hit a style write.

### `NativeAnimation` / `NativeAnimationExtended` — WAAPI, compositor-offloadable

Source: `packages/motion-dom/src/animation/NativeAnimation.ts`, `NativeAnimationExtended.ts`. Wraps `Element.prototype.animate()`.

Behavior:

- Keyframes + options handed to the browser via `element.animate(keyframes, options)`.
- The browser manages the clock. No per-frame JS on the main thread (unless the property cannot be offloaded).
- For accelerated properties (`opacity`, `transform`, `clipPath`, `filter`), the compositor runs the animation off-thread.
- `NativeAnimationExtended` adds MotionValue integration: when the WAAPI animation stops (finishes or is interrupted), a zero-duration `JSAnimation` samples the last two frames to derive velocity and write it back into the `MotionValue`. This is how velocity hand-off works for springs that were WAAPI-offloaded.

## The WAAPI selection gate

The decision is spread across two layers. All conditions must hold for WAAPI to be chosen; any failure drops to `JSAnimation`. No warning is emitted; the fallback is silent.

### Outer layer: `AsyncMotionValueAnimation.onKeyframesResolved`

```
useWaapi = canAnimateValue && !isHandoff && supportsBrowserAnimation(resolvedOptions)
```

- `canAnimateValue` — the parsed keyframes produced a usable value range.
- `!isHandoff` — not resuming an animation that was previously running elsewhere; handoffs always go through the JS path to preserve velocity.
- `supportsBrowserAnimation(resolvedOptions)` — the inner checks below.

Source: `packages/motion-dom/src/animation/AsyncMotionValueAnimation.ts` around lines 162–188.

### Inner layer: `supportsBrowserAnimation`

From `packages/motion-dom/src/animation/waapi/supports/waapi.ts` around lines 26–74:

1. `Element.prototype.animate` exists on the target's global (`supportsWaapi`).
2. `motionValue.owner.current` is an `HTMLElement`. Non-HTML owners (e.g. popovers using window-tied timing, object targets) are excluded.
3. The property is **accelerated** or is a color with browser-only syntax:
   - Accelerated set (`accelerated-values.ts`): `opacity`, `clipPath`, `filter`, `transform`. `background-color` is commented out pending a Chromium issue.
   - Colors: if the keyframes contain values that only the browser can parse (CSS custom property colors, `color-mix()`, `oklch(...)`, etc.), WAAPI is forced so that JS parsing does not fail.
4. `name !== 'transform'` **or** there is no `transformTemplate`. A custom template cannot be expressed as WAAPI keyframes.
5. **No `onUpdate` callback.** WAAPI cannot surface per-frame values back to JS.
6. No `repeatDelay`. WAAPI has no direct equivalent.
7. `repeatType !== 'mirror'`. WAAPI cannot mirror keyframes per iteration.
8. `damping !== 0`. Excludes degenerate physics configurations.
9. `type !== 'inertia'`. Inertia is two-phase (friction + spring hand-off); must run on the main thread.

For a performance investigation, this is the first thing to check: **which backend is actually running?**

### How to check which backend is in use

- Import `activeAnimations` from `motion-dom` (or inspect it in dev via source). It is a module-level counter object in `packages/motion-dom/src/stats/animation-count.ts` with `.waapi`, `.mainThread`, `.layout` fields. It is not attached to `globalThis` automatically — if you need devtools access, expose it yourself in a dev-only bootstrap file.
- Open DevTools Performance. WAAPI animations appear as `CompositorAnimation` entries without corresponding main-thread work; `JSAnimation` shows repeated script evaluation each frame.

### Practical consequences

- **Adding `onUpdate` forces main-thread.** Every time. If `onUpdate` is only there for debugging, gate it: `process.env.NODE_ENV === 'development' ? log : undefined`.
- **Animating `transform` with independent `x` / `y` motion values** uses `transformTemplate` internally only if the template was supplied. Independent transforms themselves do not block WAAPI, but they require concatenation into a single `transform` string. Modern Motion v12 does this for you.
- **`transformTemplate` disables hardware acceleration for `transform`.** Avoid unless needed.
- **Animating `background-color` or `color` via `MotionValue`** falls back to `JSAnimation`. This is expensive on a list. Prefer `opacity` layers or `mix-blend-mode` tricks when doing large color transitions.

## The frame loop

All Motion's timing flows through one `rAF`-driven batcher per global scope (`packages/motion-dom/src/frameloop/batcher.ts`).

### Phase order

From `packages/motion-dom/src/frameloop/order.ts`:

```
setup -> read -> resolveKeyframes -> preUpdate -> update -> preRender -> render -> postRender
```

Semantics:

- **`setup`** — initialize values that need to exist before reads. Rare.
- **`read`** — DOM reads go here. Putting DOM writes in `read` is a bug that causes forced layout.
- **`resolveKeyframes`** — late-binding keyframe resolution, e.g. resolving `'auto'` heights by reading bounding box.
- **`preUpdate`** — hook point, infrequently used.
- **`update`** — `JSAnimation` generators tick, `MotionValue`s update, subscribers fire.
- **`preRender`** — final computations before DOM writes. `useCombineMotionValues` lands here.
- **`render`** — `VisualElement.render` writes to DOM.
- **`postRender`** — cleanup, one-shot effects that require the DOM to be up to date.

### `frameData`

Exposed via `import { frameData } from 'motion'` (or `motion/react`). Contains:

- `delta` — clamped to `[1, 40]` ms. Large deltas (after tab unfocus) clamp to 40 ms to avoid huge spring overshoot.
- `timestamp` — the timestamp of the current frame.
- `isProcessing` — true while inside `processBatch`.

`delta === 1000/60 ≈ 16.67` on the first frame.

### `frame` vs `microtask` batchers

Two batchers exist. Both share the same phase order:

- `frame` — created with `createRenderBatcher(requestAnimationFrame, true)`. `allowKeepAlive: true` keeps rAF alive as long as anything is scheduled.
- `microtask` — created with `createRenderBatcher(queueMicrotask, false)`. `allowKeepAlive: false`; fires once and is done. Used for one-shot sync operations that should not extend a frame, such as `useCombineMotionValues` recomputations.

Do not confuse them. Scheduling a long-running animation on `microtask` never advances past frame 1.

### Custom drivers

`JSAnimation` accepts a `driver` option. `Driver = (update: (timestamp: number) => void) => DriverControls`. The returned controls are `{ start(keepAlive?), stop(), now() }`.

The default is `frameloopDriver` (`packages/motion-dom/src/animation/drivers/frame.ts`), which dispatches to `frame.update`. Tests commonly swap in a synchronous driver:

```ts
const syncDriver: Driver = (update) => ({
  start: () => {
    let t = 0;
    while (t <= duration) {
      update(t);
      t += 16;
    }
  },
  stop: () => {},
  now: () => performance.now(),
});
```

Production code rarely needs a custom driver. Use cases:

- Headless testing (above).
- Feeding animation time from an external source (a game engine clock, scroll position, WebXR frame).
- Extremely low-power scenarios where you throttle rAF manually.

## `animate()` pipeline

The public vanilla API is `animate(subject, keyframes, transition)` from `motion` or `framer-motion/dom` (identical runtime).

Internal dispatch in `packages/framer-motion/src/animation/animate/index.ts`:

1. If `subject` is a **sequence** (array with sub-arrays), route to `animateSequence`.
2. Otherwise, route to `animateSubject`.

### Single-value animation

`animateSingleValue(value, keyframes, transition)` is used when the subject is a raw `MotionValue`, a number, or a string that parses as a value type. It creates one `JSAnimation` (or `NativeAnimation`) attached to that value.

### DOM / object animation

`animateSubject` walks `resolveSubjects` to produce a flat list of `(VisualElement, values)` pairs and creates one animation per value. The resolution handles:

- Selectors (`'.card'` → all matching elements).
- `VisualElement` — direct reference.
- `HTMLElement` / `SVGElement` — wrapped in a `DOMVisualElement`.
- Plain object — wrapped in `ObjectVisualElement`.

### Sequences

`animateSequence(sequence, options)` (`packages/framer-motion/src/animation/animate/sequence.ts`) supports:

```ts
animate([
  [".item", { opacity: 1 }, { duration: 0.3 }],
  [".item", { x: 100 }, { at: "+0.1" }],
  [progress, 1, { at: 0.5 }],
  [() => setIsDone(true), {}, { at: 1 }],
]);
```

The segment array is `[subject, keyframes, options]`:

- `subject` can be a selector, element, `MotionValue`, or **a function**. Functions are converted to `motionValue(undefined)` subscribed with `on('change')` to call the function — useful for side-effects at specific timeline positions.
- `options.at` is a timeline position. Values: number (seconds from start), `'+N'` / `'-N'` (relative to previous end), `'<'` (same time as previous), `string` label references.

### `GroupAnimation`

The return of `animate(...)` is a `GroupAnimation` when multiple animations are produced. It proxies `play`, `pause`, `stop`, `cancel`, `finished` (Promise that resolves when all finish), and `duration` (max of children). `then` on the group works because `GroupAnimationWithThen.then = (fulfilled, rejected) => this.finished.finally(...)`.

## `animateMini()` — the compositor-only variant

`animateMini` (alias `animate` when imported from `motion/mini`) skips the generator path entirely. It calls `element.animate()` directly with zero fallback. Smaller bundle. Caveats:

- No springs, no inertia, no `onUpdate`.
- No MotionValue integration.
- Useful for one-off CSS transitions on accelerated properties where every KB matters (embeds, landing pages).

Default to the full `animate`. Only reach for `animateMini` when bundle analysis identifies the spring / keyframes path as a meaningful cost and the use case genuinely has no MotionValue, no `onUpdate`, and only accelerated properties.

## Scroll-linked animation: `scroll()`

`scroll(callback, options)` from the vanilla API, or `useScroll` in React, produces a scroll-progress value. Under the hood it uses:

- Native `ScrollTimeline` / `ViewTimeline` when supported (modern Chromium). Compositor-driven.
- A fallback `scrollTimelineFallback` → `scrollInfo` path on other engines. This attaches a `scroll` event listener on the container and schedules reads via `frame.read`, then publishes progress through `frame.preUpdate`. It is rAF-timed measurement, **not** an `IntersectionObserver`. Source: `packages/framer-motion/src/render/dom/scroll/utils/get-timeline.ts` and `scroll/track.ts`.

`useScroll` + `useTransform` keeps the entire chain on `MotionValue`, bypassing React re-render. For animations driven by `useScroll`, the target must be reachable without re-rendering React — that is, the output `MotionValue` must be passed directly to a `motion` element's `style`.

`useScroll({ target: ref, offset: ['start end', 'end start'] })` is the typical pattern for element-relative progress. Offsets are a pair of strings describing where the target's edge meets the container's edge (`start`, `center`, `end`).

## Interaction with React commits

The engine runs independently of React's render cycle:

1. React renders and commits → `VisualElement` picks up new props, merges variants, updates `MotionValue` targets.
2. Projection `willUpdate` fires → snapshots.
3. Browser reflow.
4. Projection `didUpdate` → computes deltas and starts a FLIP animation (if any).
5. The frame batcher takes over for all subsequent frames.

Because the batcher writes directly to DOM (`render` phase), changes from Motion do not round-trip through React. React is used only to reconcile which `motion` components exist, their props, and their variant resolution.

## Guidelines

- **Ask "which backend" before reasoning about performance.** Adding `onUpdate` changes the answer.
- **Never start a raw `requestAnimationFrame` loop around Motion state.** Use `frame.update` or `useAnimationFrame`.
- **Do not write to DOM in a `read` phase subscriber.** Writes belong in `render`.
- **For sequences, prefer `animate([...])`** over chaining `onAnimationComplete` handlers. The sequence planner produces a single timeline with correct overlap.

## Reference points

- Backends: `packages/motion-dom/src/animation/JSAnimation.ts`, `NativeAnimation.ts`, `NativeAnimationExtended.ts`.
- Gate: `packages/motion-dom/src/animation/waapi/supports/waapi.ts`, `utils/accelerated-values.ts`.
- Dispatch: `packages/motion-dom/src/animation/AsyncMotionValueAnimation.ts` (lines ~162–188 decide the backend).
- Frame loop: `packages/motion-dom/src/frameloop/batcher.ts`, `order.ts`, `frame.ts`, `microtask.ts`.
- Driver: `packages/motion-dom/src/animation/drivers/frame.ts`, `types.ts`.
- Public `animate`: `packages/framer-motion/src/animation/animate/index.ts`, `subject.ts`, `sequence.ts`.
- Group: `packages/motion-dom/src/animation/GroupAnimation.ts`, `GroupAnimationWithThen.ts`.
