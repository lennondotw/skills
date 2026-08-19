# MotionValue and the Reactive Pipeline

Load this when reviewing custom hooks that touch `MotionValue`, when the performance question is "why is this re-rendering", or when designing animation state that must stay outside React's commit phase.

## What `MotionValue` is

A `MotionValue<T>` is an observable cell with velocity tracking:

- `current: T` — the present value.
- `prev: T` — the previous value at last notification.
- `prevFrameValue: T` — the value at the end of the previous frame. Used for velocity.
- `updatedAt`, `prevUpdatedAt` — timestamps for velocity derivation.
- Subscriber lists per event: `change`, `animationStart`, `animationComplete`, `animationCancel`, `renderRequest`.

A `MotionValue` is not React state. It does not trigger a re-render when updated. The renderer (`VisualElement`) subscribes to `change` and writes to the DOM directly during the frame batcher's `render` phase.

Source: `packages/motion-dom/src/value/index.ts`.

## Core API

```ts
import { motionValue } from "motion";

const x = motionValue(0);

x.set(42); // update synchronously
x.jump(42); // update without velocity / animation state
x.get(); // read current
x.getPrevious(); // read prev
x.getVelocity(); // derived velocity (units / sec)

const unsub = x.on("change", (latest) => console.log(latest));
unsub();
```

### `set` vs `jump`

- `set(value)` — normal update. Updates `current`, notifies `change` subscribers, participates in velocity derivation, routes through `passiveEffect` if one is attached (see below).
- `jump(value, endAnimation = true)` — forcibly set to a discrete value. Also routes through `updateAndNotify`, so subscribers still receive a `change` event when the value changes. The differences from `set` are: clears `prevFrameValue` and `prevUpdatedAt` so velocity derives as zero, optionally stops any running animation (`endAnimation=true`), and runs any installed `stopPassiveEffect`. Use when the value is being reset externally (scroll position snapped on navigation, drag release cancelled).

### `getVelocity()`

Derived from `prevFrameValue` with a 30 ms memory window (`MAX_VELOCITY_DELTA` around line 406–427 of `value/index.ts`). If no update has occurred in the last 30 ms, velocity returns 0. If `prevUpdatedAt` is older than that window, the derivation treats it as zero velocity.

Consequences:

- After a drag ends, `getVelocity()` returns the recent velocity (within the window). Inertia uses this.
- After a `set`, `getVelocity()` is derived from the delta between `prev` and `current` divided by the time between `prevUpdatedAt` and `updatedAt`. If those timestamps are identical (two synchronous sets), velocity is infinite / NaN — Motion clamps to 0.
- If you `set` once and then idle, velocity drops to 0 after 30 ms.

### `on('change', handler)`

Subscribes to future updates. The handler receives the new value. Returns an unsubscribe function.

Two subtle behaviors:

- When the last `change` subscriber unsubscribes, the `MotionValue` schedules a `frame.read` callback; if at that point it has no remaining change subscribers, it calls its own `stop()` to terminate any running animation (around lines 257–269 of `value/index.ts`). The `MotionValue` object itself is not destroyed — it just stops burning frames while unobserved.
- The handler fires synchronously on `set`, inside whatever phase triggered the update. Do not do expensive work here. For DOM writes, schedule a `frame.render`.

### Passive effects

`value.attach(passiveEffect, stopPassiveEffect)` installs a pair of callbacks that intercept `set`. The signature of `passiveEffect` is `(v, safeSetter) => void` — it receives the incoming value and a setter that bypasses the passive effect. To pass the value through, call `safeSetter(v)`. To transform, call `safeSetter(transformed)`. To cancel the update, do nothing.

`stopPassiveEffect` runs during `jump` and cleanup, letting the installed effect tear itself down.

This is the mechanism `useSpring` uses to follow a source `MotionValue` without introducing a second value. Rarely needed in application code; if you are tempted to use it, consider `useTransform` or a composed `MotionValue` instead.

## Relationship to React

`useMotionValue` (`packages/framer-motion/src/value/use-motion-value.ts`):

- On first render, creates a fresh `MotionValue`.
- **Does not subscribe React state** by default. Updates do not trigger re-render.
- Under `MotionConfigContext.isStatic === true` (e.g. for SSR thumbnail capture), opts into `useState` mirroring so values are visible on first render.

This is why `<motion.div style={{ x: motionValue(0) }} />` can be updated 60 times per second without React ever re-running.

### Reading a `MotionValue` in React

Do not do this in render:

```tsx
const x = useMotionValue(0);
return <div>Current: {x.get()}</div>; // renders once, does not update
```

Do this:

```tsx
const x = useMotionValue(0);
const [display, setDisplay] = useState(0);
useMotionValueEvent(x, "change", setDisplay);
return <div>Current: {display}</div>;
```

`useMotionValueEvent` is the canonical bridge. It subscribes inside a `useEffect` and calls the handler with the latest value.

**Caveat**: this subscription pulls the value into React state, which re-renders. That is fine for debug readouts but defeats the point for hot paths. If the visual effect can be expressed as a CSS property, animate directly via `style`.

## Composition: `useTransform`, `useSpring`, `useMotionTemplate`

These hooks produce new `MotionValue`s derived from existing ones. They all stay on the `MotionValue` channel — no React state involved.

### `useTransform`

Three polymorphic forms:

```ts
// Mapping from one value to another
const scale = useTransform(scrollY, [0, 100], [1, 0.9]);

// Function form: compute from other MotionValues
const sum = useTransform(() => a.get() + b.get());

// Projection: clamp, ease, custom mix
const eased = useTransform(
  scrollY,
  [0, 100],
  [1, 0],
  { ease: [easeInOut], clamp: true },
);
```

Implementation (`packages/framer-motion/src/value/use-transform.ts` around lines 183–238):

- Mapping form → `transform()` builds a reusable interpolator.
- Function form → `useComputed(fn)` subscribes to all referenced `MotionValue`s (tracked via a dependency recorder) and recomputes on change.
- Under the hood, all paths register into `useCombineMotionValues`, which schedules a `frame.preRender` update so the derived value is available before DOM writes.

### `useSpring`

```ts
const springX = useSpring(sourceX, { stiffness: 200, damping: 20 });
```

`useSpring(source, config)` creates a new `MotionValue` that physically follows the source. Implementation uses `useFollowValue` with `type: 'spring'`, which attaches a `follow` handler on the source. Whenever the source updates, the follower recomputes its spring ODE toward the new target.

Two usage modes:

- Follow a `MotionValue`: `useSpring(scrollY)` — follower trails the scroll.
- Create from scratch: `useSpring(0, { stiffness: 500 })` — returns a `MotionValue` you set manually; it follows the set target with spring physics.

### `useMotionTemplate`

```ts
const transform = useMotionTemplate`translateX(${x}px) scale(${scale})`;
```

A tagged template literal that produces a `MotionValue<string>`. Internally it's `useCombineMotionValues` + string interpolation. The result is a single string value that can be passed to `style.transform` for GPU acceleration.

Common use: re-uniting independent `x`, `y`, `scale` transforms into one `transform` property for compositor offload.

### `useVelocity`

```ts
const velocity = useVelocity(x);
```

Derives a new `MotionValue<number>` that always reflects `source.getVelocity()`. Internally it polls via `frame.update` until velocity reaches zero, then suspends.

### `useTime`

```ts
const time = useTime();
```

Returns a `MotionValue<number>` that is the current `requestAnimationFrame` timestamp minus a reference time (typically component mount). Updated every frame. Useful for procedural animation:

```ts
const t = useTime();
const y = useTransform(t, [0, 2000], [0, 100], { clamp: false });
```

## Reading velocity correctly

Common mistake:

```ts
// Wrong: reads velocity at a random time
useEffect(() => {
  console.log(x.getVelocity());
}, []);
```

`getVelocity` is instantaneous. To observe velocity over time, use `useVelocity` or subscribe:

```ts
useMotionValueEvent(x, 'velocityChange', (v) => { ... });
```

## The pipeline visualized

```
user event
   ↓
motionValue.set(newValue)
   ↓
current = newValue
   ↓
emit 'change'
   ├──→ renderer writes DOM via VisualElement (in render phase)
   ├──→ useTransform recomputes derived MotionValue
   ├──→ useMotionValueEvent handlers fire
   └──→ useSpring's follower receives new target; recomputes ODE
```

All without React re-rendering.

## When to reach for `useState` instead

Not every animation-adjacent value belongs in a `MotionValue`. Use React state when:

- The value affects which components render (conditional branches, list length).
- The value is read in the render return for layout or accessibility (`aria-valuenow`, `tabIndex`).
- The value is serialized (form submission, URL param).
- The update rate is low (once per user action, not per frame).

Use a `MotionValue` when:

- The value is read by a `motion` component's `style`.
- The value changes 60 times per second.
- The chain from source to DOM does not need to touch React.

The anti-pattern is bridging unnecessarily:

```tsx
// Anti-pattern: MotionValue mirrored into React state
const x = useMotionValue(0);
const [xState, setXState] = useState(0);
useMotionValueEvent(x, "change", setXState);
return <div style={{ transform: `translateX(${xState}px)` }} />;
```

Correct form:

```tsx
const x = useMotionValue(0);
return <motion.div style={{ x }} />;
```

The only valid reason for the anti-pattern is when the DOM target cannot use a `motion` component (e.g. a third-party component that accepts a primitive number prop, not a `MotionValue`).

## `MotionValue` lifecycle inside React

Created via `useMotionValue`, the value is stable across renders (ref-like). It is destroyed only when the component unmounts. This means:

- Setting a `MotionValue` in a parent and consuming in a child across renders works without re-initialization.
- Passing a `MotionValue` across suspend / hydrate boundaries in Next.js requires the value to be created client-side. Server renders that touch `MotionValue.get()` return the initial value.

For SSR / RSC:

- `motion/react-client` wraps `motion/react` with `'use client'` so Motion components are client-only by default.
- `useMotionValue` is safe inside a client component.
- Cannot create a `MotionValue` in a server component and pass it across the boundary.

## `useAnimate`: imperative animations on elements

```tsx
const [scope, animate] = useAnimate();

const handleClick = () => {
  animate(scope.current, { scale: 1.2 }, { duration: 0.2 });
};

return <motion.div ref={scope} />;
```

`useAnimate` returns a **scope ref** and an `animate` function bound to that scope. The ref forwards to any element (or ancestor). The `animate` function accepts selectors within the scope:

```ts
animate(".item", { opacity: 1 }, { staggerChildren: 0.05 });
```

Internally it is a `createScopedAnimate(scope)` — the same `animate()` function, but selectors resolve relative to `scope.current`.

Advantages over declarative `animate` prop:

- No re-render needed.
- Timeline sequences via `animate([...])`.
- Can return a controls object with `.play`, `.pause`, `.stop`, `.finished`.

Disadvantages:

- Imperative; less inspectable via devtools.
- Harder to reason about state transitions. Prefer declarative when possible.

## Custom hooks over `MotionValue`

A well-structured Motion hook:

```ts
import { useMotionValue, useMotionValueEvent, useTransform } from "motion/react";
import { type RefObject, useRef } from "react";

export function useMousePosition(ref: RefObject<HTMLElement>) {
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const distance = useTransform(
    () => Math.hypot(x.get() - 0.5, y.get() - 0.5),
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handle = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      x.set((e.clientX - rect.left) / rect.width);
      y.set((e.clientY - rect.top) / rect.height);
    };
    el.addEventListener("pointermove", handle);
    return () => el.removeEventListener("pointermove", handle);
  }, [x, y]);

  return { x, y, distance };
}
```

Rules:

- Create `MotionValue`s via `useMotionValue`, not `motionValue()`, inside a hook. The React version is lifecycle-aware.
- Event listeners go in `useEffect` (attachment is a side effect, not state).
- `useTransform` derivations go at the top level (at render time). They create subscriptions, not side effects.
- Do **not** mirror a `MotionValue` into `useState` in the hook. Let consumers do that only if they need to render the value.

## Reference points

- MotionValue class: `packages/motion-dom/src/value/index.ts` (update ~349–374, subscribe ~247–273, velocity ~406–427, passive effect ~305–329).
- `useMotionValue`: `packages/framer-motion/src/value/use-motion-value.ts`.
- `useTransform`: `packages/framer-motion/src/value/use-transform.ts`.
- `useMotionTemplate`: `packages/framer-motion/src/value/use-motion-template.ts`.
- `useCombineMotionValues`: `packages/framer-motion/src/value/use-combine-values.ts`.
- `useSpring` / `useFollowValue`: `packages/motion-dom/src/value/follow-value.ts`.
- `useAnimate`: `packages/framer-motion/src/animation/hooks/use-animate.ts`.
- `useMotionValueEvent`: `packages/framer-motion/src/value/use-motion-value-event.ts`.
