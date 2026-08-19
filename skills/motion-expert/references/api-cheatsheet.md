# API Cheat Sheet

Quick reference for signatures, defaults, and precedence. Load when you need to check "what's the default easing?" or "which prop wins?" without reading narrative docs.

## Transitions — defaults

Values taken from `packages/motion-dom/src/animation/utils/default-transitions.ts` and `packages/motion-dom/src/animation/generators/spring.ts`. Where the two disagree, this table reflects the engine's resolved default for that property.

### Per-property auto-selected type (`default-transitions.ts`)

| Property family                                               | Default type                                                                                                           | Config                                               |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `x`, `y`, `z`, `rotate`, `scale`, `skew...`, color properties | `'keyframes'` with a spring-feeling ease, **or** a spring (`stiffness: 500, damping: 25`) depending on the value shape | `underDampedSpring: { stiffness: 500, damping: 25 }` |
| Everything else (opacity, backgroundColor, width, ...)        | `'keyframes'`                                                                                                          | `ease: [0.25, 0.1, 0.35, 1], duration: 0.3`          |

The shorthand `type: 'tween'` in user code routes into the keyframes path with the same defaults. Note the default ease is a **bezier curve**, not the string `'easeOut'`.

### Spring generator defaults (`spring.ts`)

When you write `type: 'spring'` without specifying parameters, the generator defaults kick in:

| Property                          | Default         | Notes                                                                 |
| --------------------------------- | --------------- | --------------------------------------------------------------------- |
| `stiffness`                       | `100`           | Physical API default.                                                 |
| `damping`                         | `10`            | Physical API default.                                                 |
| `mass`                            | `1`             | Physical API default.                                                 |
| `bounce`                          | `0.3`           | Used in perceptual paths.                                             |
| `visualDuration`                  | `0.3`           | Seconds. Used when no physical keys and no explicit `visualDuration`. |
| `velocity`                        | `0`             | Zeroed explicitly when entering the perceptual path.                  |
| `restSpeed.default` / `.granular` | `2` / `0.01`    | Units/sec.                                                            |
| `restDelta.default` / `.granular` | `0.5` / `0.005` | `isGranularScale` picks granular when `                               |

Note: transforms and colors default to the `underDampedSpring` values (`stiffness: 500, damping: 25`) in `default-transitions.ts`, not to the generator's 100/10. The 100/10 defaults apply only to explicit `type: 'spring'` with no further config.

### Common schedule props

| Property                       | Default                | Notes                                  |
| ------------------------------ | ---------------------- | -------------------------------------- |
| `duration` (keyframes / tween) | `0.3`                  | Seconds.                               |
| `ease` (keyframes / tween)     | `[0.25, 0.1, 0.35, 1]` | Bezier, from `default-transitions.ts`. |
| `repeat`                       | `0`                    | `Infinity` for endless.                |
| `repeatType`                   | `'loop'`               | Also `'reverse'`, `'mirror'`.          |
| `repeatDelay`                  | `0`                    | Seconds between repeats.               |
| `delay`                        | `0`                    | Seconds before start.                  |

## Variant precedence

The engine's `variantPriorityOrder` (from `packages/motion-dom/src/render/utils/variant-props.ts`):

```
animate  <  whileInView  <  whileFocus  <  whileHover  <  whileTap  <  whileDrag  <  exit
```

Higher entries override lower ones for the properties they touch. `initial` and `style` form the base beneath this chain. Unspecified properties pass through — a gesture variant does not need to repeat the `animate` keys.

`variants` with named states (e.g. `open`, `closed`) resolve during `animate={variantName}`; per-property precedence follows the chain above.

## Variant orchestration

```ts
const container = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      when: "beforeChildren", // 'beforeChildren' | 'afterChildren' | false
      staggerChildren: 0.1, // delay between each child
      delayChildren: 0.3, // delay before any child starts
      staggerDirection: 1, // 1 forward, -1 reverse
    },
  },
};

const child = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
};
```

Child components inherit the parent's variant if `animate` is not set — they automatically switch when the parent's variant switches.

## `AnimatePresence` modes

| Mode               | Behavior                                                                 | When to use                                                   |
| ------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `'sync'` (default) | Enter and exit overlap                                                   | Most list animations                                          |
| `'wait'`           | Exit completes, then enter starts                                        | Route transitions, single-child switches                      |
| `'popLayout'`      | Exiting element gets `position: absolute` so siblings reflow immediately | Grid / list reorder where removed items should not hold space |

Rules:

- `'wait'` requires exactly one child; console warns otherwise.
- `'popLayout'` requires a positioned ancestor.
- `initial={false}` on `AnimatePresence` suppresses first-mount animations.

## Motion component prop precedence for values

For any CSS property, the resolved value at render is the highest-priority source that defines it:

```
transition defaults  <  MotionConfig.transition  <  motion-component transition
initial / style (base)  <  animate  <  whileInView  <  whileFocus  <  whileHover  <  whileTap  <  whileDrag  <  exit
```

## Easing functions

Available as string names or direct imports from `motion`:

| Name                                     | Function                      |
| ---------------------------------------- | ----------------------------- |
| `'linear'`, `'ease'`                     | `t`; CSS-default cubic-bezier |
| `'easeIn'` / `'easeOut'` / `'easeInOut'` | Standard cubic-bezier         |
| `'circIn'` / `'circOut'` / `'circInOut'` | `sin`/`acos` based            |
| `'backIn'` / `'backOut'` / `'backInOut'` | Overshoot via bezier          |
| `'anticipate'`                           | Small reverse before forward  |

Only a subset of these is **natively** expressible in WAAPI (`supportedWaapiEasing` in `packages/motion-dom/src/animation/waapi/easing/supported.ts` covers `linear`, `ease`, `easeIn`, `easeOut`, `easeInOut`, `circIn`, `circOut`, `backIn`, `backOut`). The rest (`anticipate`, `backInOut`, `circInOut`, custom functions) are sampled into a CSS `linear(...)` string before being handed to WAAPI; on browsers without `linear()` support they fall back to `'ease-out'`.

Array form: `ease: [0.4, 0, 0.2, 1]` — cubic-bezier control points.

Per-segment: `ease: [easeIn, easeOut]` when `keyframes` has 3 values.

Custom function: any `(p: number) => number`.

## `stagger()` (vanilla)

```ts
animate(".item", { opacity: 1 }, { delay: stagger(0.1) });
animate(".item", { opacity: 1 }, {
  delay: stagger(0.1, { from: "first" | "last" | "center" | number }),
});
animate(".item", { opacity: 1 }, { delay: stagger(0.1, { ease: "easeOut" }) });
```

`stagger` options:

- `from` — index to start from. Number picks a specific index.
- `ease` — apply easing to the stagger distribution itself.
- `startDelay` — constant offset before any stagger begins.

## Independent transform properties

| Prop                                       | CSS equivalent                 |
| ------------------------------------------ | ------------------------------ |
| `x`, `y`, `z`                              | `translate3d(x, y, z)`         |
| `scale`, `scaleX`, `scaleY`                | `scale()`                      |
| `rotate`, `rotateX`, `rotateY`, `rotateZ`  | `rotate()` / `rotateX()` / ... |
| `skewX`, `skewY`                           | `skew()`                       |
| `transformPerspective`                     | `perspective()`                |
| `transformOrigin`, `transformOriginX`, ... | `transform-origin`             |

All are composed into a single `transform` string internally. Do not mix `style={{ transform: '...' }}` with independent transforms; the latter overrides.

## `animate()` vanilla API

```ts
animate(subject, keyframes, options?)
```

Subjects:

- `MotionValue<T>`
- `HTMLElement` or `SVGElement`
- CSS selector string (e.g. `'.card'`)
- Plain object (animates keys of the object)
- `number` or `string` (animates a primitive through `from -> to`)

Returns: `AnimationPlaybackControls` (single) or `GroupAnimation` (multiple targets).

### Controls interface

Core members you will use:

```ts
interface AnimationPlaybackControls {
  time: number; // current time in seconds (readable + writable — seek)
  speed: number; // playback speed (1 = normal, 2 = 2x, 0.5 = half)
  duration: number; // total duration
  play(): void;
  pause(): void;
  stop(): void;
  cancel(): void;
  complete(): void;
  finished: Promise<void>;
  then(onFulfilled, onRejected): Promise<void>;
}
```

The full interface (see `packages/motion-dom/src/animation/types.ts`) also includes `startTime`, `state`, `iterationDuration`, `attachTimeline`, and related lower-level members used for scroll timelines and advanced integrations. Reach for those only when hooking into `ScrollTimeline` or building custom controls.

## Sequence syntax

```ts
animate([
  // [subject, keyframes, options]
  [".item", { opacity: 1 }, { duration: 0.3 }],
  [".item", { x: 100 }, { at: "+0.1" }], // 0.1s after previous START
  [".item", { scale: 1.2 }, { at: "<" }], // same time as previous
  [".item", { rotate: 180 }, { at: 0.5 }], // absolute 0.5s
  [".item", { opacity: 0 }, { at: "labelA" }], // named label
  [progressValue, 100, { duration: 1 }], // MotionValue target
], {
  defaultTransition: { duration: 0.3 },
  repeat: 2,
});
```

`at` positions, from `calcNextTime` in `packages/framer-motion/src/animation/sequence/utils/calc-time.ts`:

| Form            | Meaning                                                                     |
| --------------- | --------------------------------------------------------------------------- |
| `number`        | Absolute time, clamped to `>= 0`.                                           |
| `'+N'`, `'-N'`  | Relative to the current running offset (parsed as `parseFloat`).            |
| `'<'`           | Same start time as the previous segment.                                    |
| `'<N'`, `'<-N'` | Previous segment start + offset N.                                          |
| Label string    | Looks up a previously registered label; falls back to `current` if unknown. |

There is **no `>` position** — if you need "after the previous ends", use `'+0'` or omit `at` entirely (the default advances past the previous segment).

## `scroll()` / `useScroll`

```ts
useScroll(options?)
```

Returns:

- `scrollX`, `scrollY` — absolute pixels, `MotionValue<number>`.
- `scrollXProgress`, `scrollYProgress` — 0 to 1, `MotionValue<number>`.

Options:

- `container` — scroll source (default window).
- `target` — element to track progress against.
- `offset` — pair of strings defining the tracking window: `['start end', 'end start']` means "progress 0 when target's start reaches container's end; progress 1 when target's end reaches container's start".
- `axis` — `'x' | 'y'` (default `'y'`).
- `layoutEffect` — when true, use `useLayoutEffect` for ref setup (default `true`).

## `inView()` / `useInView`

```ts
useInView(ref, options?)
```

Returns: `boolean`.

Options:

- `once` — stop observing after first intersection.
- `amount` — `'some' | 'all' | number` (threshold).
- `root` — intersection root.
- `margin` — root margin string.

## `MotionValue` API

```ts
import { motionValue } from 'motion';

const v = motionValue<number>(0);

v.get(): number;
v.getPrevious(): number;
v.getVelocity(): number;
v.set(value): void;
v.jump(value): void;
v.on(event, handler): () => void;
v.destroy(): void;
```

Events: `'change'`, `'animationStart'`, `'animationComplete'`, `'animationCancel'`, `'renderRequest'`, `'velocityChange'`.

React hooks:

- `useMotionValue(initial)`
- `useTransform(input, inputRange, outputRange, options?)` or `useTransform(fn)`
- `useTransform([v1, v2, ...], fn)` — compose multiple
- `useSpring(source | initialValue, config?)`
- `useMotionTemplate\`template\`\`` — tagged template
- `useMotionValueEvent(value, event, handler)`
- `useVelocity(source)`
- `useTime()`

## Drag props

| Prop                                 | Default          | Notes                                         |
| ------------------------------------ | ---------------- | --------------------------------------------- |
| `drag`                               | `false`          | `true`, `'x'`, `'y'`, `false`                 |
| `dragConstraints`                    | —                | `{ top, left, right, bottom }` or `RefObject` |
| `dragElastic`                        | `0.5`            | 0 = hard stop, 1 = no resistance              |
| `dragMomentum`                       | `true`           | Inertia on release                            |
| `dragTransition`                     | Inertia defaults | Overrides inertia config                      |
| `dragControls`                       | —                | From `useDragControls()`                      |
| `dragListener`                       | `true`           | False when using external controls            |
| `dragPropagation`                    | `false`          | True allows parent drag to also start         |
| `dragSnapToOrigin`                   | `false`          | Spring back to `{ x: 0, y: 0 }` on release    |
| `whileDrag`                          | —                | Variant during drag                           |
| `onDragStart`, `onDrag`, `onDragEnd` | —                | Callbacks with `(event, info)`                |

`info` in drag callbacks:

```ts
{
  point: { x, y },      // absolute pointer
  delta: { x, y },       // since last event
  offset: { x, y },      // since drag start
  velocity: { x, y },    // pixels/sec
}
```

## `MotionConfig` props

| Prop            | Purpose                                              |
| --------------- | ---------------------------------------------------- |
| `transition`    | Default transition merged per-component              |
| `reducedMotion` | `'never' \| 'always' \| 'user'`                      |
| `nonce`         | CSP nonce for injected styles                        |
| `isStatic`      | Freeze motion; opt `useMotionValue` into React state |

## `LazyMotion` props

| Prop       | Purpose                                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| `features` | Feature bundle (`domAnimation`, `domMax`, `domMin`, or async loader)                                        |
| `strict`   | Dev-only: throw if a `motion.*` component (not `m`) is rendered inside. Does not validate feature coverage. |

## Common typing

```ts
import type {
  AnimatePresenceProps,
  AnimationControls,
  HTMLMotionProps, // HTMLMotionProps<'div'> etc.
  MotionProps,
  MotionValue,
  SVGMotionProps, // for motion SVG elements
  TargetAndTransition,
  Transition,
  Variants,
} from "motion/react";
```

For components that wrap `motion`:

```tsx
import { type HTMLMotionProps, motion } from "motion/react";
import type { FC } from "react";

type CardProps = HTMLMotionProps<"div"> & { featured?: boolean; };

const Card: FC<CardProps> = ({ featured, ...rest }) => (
  <motion.div {...rest} whileHover={{ scale: featured ? 1.05 : 1.02 }} />
);
```

## Where to look first

When stuck, consult source in `packages/motion-dom/` or `packages/framer-motion/` for exact behavior, then `motion.dev/docs` for intended API surface, then this skill's other references for concept walkthroughs.
