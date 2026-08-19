# Motion Architecture

High-level map of the Motion codebase and how its pieces plug together. Load this when reasoning about bundle size, feature bundles, or where a given behaviour lives.

## Monorepo layout

The `motiondivision/motion` repository is a Yarn 3 + Turbo monorepo. The runtime packages and their responsibilities:

| Package                  | Purpose                                                                                                                                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/motion-utils`  | Pure math and utilities with no framework dependency. `progress`, `clamp`, `pipe`, `SubscriptionManager`, `MotionGlobalConfig`, `velocityPerSecond`, easings (`cubicBezier`, `back`, `circ`, `anticipate`, `steps`).                         |
| `packages/motion-dom`    | Core engine. `VisualElement`, DOM/SVG renderers, projection tree, FLIP, scale correction, frameloop batcher, `MotionValue`, `JSAnimation` (main-thread), `NativeAnimation` (WAAPI), gestures (`hover`, `press`, pan), `interpolate` / `mix`. |
| `packages/framer-motion` | React integration. `motion` component factory, feature bundles, `AnimatePresence`, `LayoutGroup`, `LazyMotion`, `useVisualElement`, and the vanilla re-export surface (`framer-motion/dom`).                                                 |
| `packages/motion`        | Thin re-export package. Its entry is `export * from 'framer-motion/dom'`. The `motion` npm name provides a single import path; runtime is identical to `framer-motion`.                                                                      |

Dependency direction is strict and one-way:

```
motion-utils  <-  motion-dom  <-  framer-motion  <-  motion
```

No upward dependencies. Anything in `motion-dom` is framework-agnostic; anything in `framer-motion` is React-specific.

## Import subpaths

The `motion` npm package exposes multiple entries. Pick the right one for the host environment:

| Import                | Use when                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `motion`              | Vanilla JavaScript / TypeScript, no React. `animate`, `scroll`, `inView`, `hover`, `press`, `stagger`, `motionValue`, `spring`.                     |
| `motion/mini`         | Size-sensitive vanilla. Exposes `animate`, `scroll`, `inView`, `hover`, `press`. Drops keyframes, stagger, spring, `motionValue`.                   |
| `motion/react`        | React components and hooks. The default entry for modern React apps.                                                                                |
| `motion/react-mini`   | Size-sensitive React. Like `motion/react` but with the `m` component only and reduced feature set.                                                  |
| `motion/react-m`      | Explicit `m` component import when you want the tree-shakeable form without loading `motion` + `m` both.                                            |
| `motion/react-client` | Next.js App Router and other RSC setups where the Motion component tree must be a client boundary. Re-exports `motion/react` tagged `'use client'`. |
| `framer-motion`       | Legacy. Flag for migration; identical runtime to `motion/react`.                                                                                    |

## Feature bundles

The `motion/react` component factory splits the feature set so tree-shaking (combined with `LazyMotion` + `m`) can drop unused capability. The bundles:

| Bundle         | Includes                                                                    |
| -------------- | --------------------------------------------------------------------------- |
| `domAnimation` | Animations + gestures (hover, tap, focus, whileInView). No drag, no layout. |
| `domMax`       | `domAnimation` + drag + layout animations.                                  |
| `domMin`       | Animations only, no gestures.                                               |

The default `motion` component (full import) contains the equivalent of `domMax` + additional glue. For bundle-constrained apps, import `m` from `motion/react-m` and wrap with `<LazyMotion features={domAnimation}>`. The `strict` prop makes this safer during development (see below).

## `LazyMotion` in practice

```tsx
import { domAnimation, LazyMotion, m } from "motion/react";
import type { FC } from "react";

const App: FC = () => (
  <LazyMotion features={domAnimation} strict>
    <m.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} />
  </LazyMotion>
);
```

Rules:

- Use `m` (not `motion`) inside a `LazyMotion` tree; mixing `motion` defeats the tree-shaking goal.
- `strict` is a dev-only guard against exactly that mistake: it throws when a `motion.*` component (not `m`) is rendered inside `LazyMotion`. It does **not** validate that the right feature bundle is loaded for the props you used; using `drag` inside a `domAnimation` tree simply results in the feature being unavailable at runtime, no error.
- `LazyMotion` can asynchronously load a bundle: `features={() => import('./features').then((m) => m.domMax)}`. Good for above-the-fold optimization.
- Do not wrap with `LazyMotion` at leaf level; put it high in the tree so bundles are loaded once.

## `VisualElement` — the rendering abstraction

`VisualElement` (`packages/motion-dom/src/render/VisualElement.ts`) is the central abstraction that bridges a React component (or a bare DOM node) and the engine. It:

- Owns the element's `MotionValue` map (`values`).
- Holds the current `AnimationState` (`initial`, `animate`, `whileHover`, `whileTap`, `exit`, `custom`, variant resolution).
- Exposes abstract methods for host-specific work: `measureInstanceViewportBox`, `readValueFromInstance`, `build`, `renderInstance`.
- Registers with `visualElementStore` so external code (e.g. projection, gestures) can reach it by DOM element.

Concrete subclasses: `HTMLVisualElement`, `SVGVisualElement`, `ObjectVisualElement`. React components create them via `useVisualElement`; vanilla `animate(element, ...)` creates `ObjectVisualElement` (or `HTMLVisualElement` when the subject is a DOM element).

`setFeatureDefinitions` / `getFeatureDefinitions` is the injection point where React-layer features (drag controller, layout feature, gesture features) are registered into the engine. This is what `LazyMotion.features` ultimately writes to.

## `motion` component factory

The `motion.div`, `motion.span`, ... exports are produced at module load by iterating a list of HTML and SVG tag names (`packages/framer-motion/src/render/components/motion/elements.ts`). Each calls `createMotionComponent(Component, options, featureBundle, createDomVisualElement)`.

For custom components:

```tsx
import { motion } from "motion/react";
import { forwardRef } from "react";

const Button = forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
  (props, ref) => <button ref={ref} {...props} />,
);

export const MotionButton = motion.create(Button); // v12+ API; replaces motion.custom
```

The forwarded component must accept a `ref` and spread props. Without `ref`, gestures and layout animations will not work.

## Frameloop as the shared clock

All Motion activity is batched through a single frame loop (`packages/motion-dom/src/frameloop/batcher.ts`). The canonical step order per tick:

```
setup -> read -> resolveKeyframes -> preUpdate -> update -> preRender -> render -> postRender
```

- `read` is the only phase where DOM reads are allowed without causing forced reflow.
- `update` is where `JSAnimation` generators tick and `MotionValue`s update.
- `render` is where `VisualElement.render` writes styles.
- A separate `microtask` batcher exists for updates that should not keep rAF alive (`allowKeepAlive: false`). Used for immediate DOM syncs like `useCombineMotionValues`.

This means a raw `requestAnimationFrame` you add near Motion code is guaranteed to race Motion's own scheduling. Use `frame.update(fn)` or `useAnimationFrame` instead.

## `MotionConfig` — global context

`MotionConfig` propagates animation defaults and flags via React context:

```tsx
<MotionConfig
  transition={{ type: "spring", visualDuration: 0.4, bounce: 0.2 }}
  reducedMotion="user"
>
  <App />
</MotionConfig>;
```

Supported props:

- `transition` — default transition merged with per-component `transition`.
- `reducedMotion` — `'always' | 'never' | 'user'` (default `'never'`; `'user'` respects `prefers-reduced-motion`).
- `nonce` — CSP nonce for dynamically injected style tags (rare, only if the app injects them).
- `isStatic` — freeze the entire tree; used for thumbnail capture / SSR previews. Makes `useMotionValue` subscribe React state (so values show up on first render).

## Two-package coexistence

A codebase that imports from both `motion/react` and `framer-motion` is running **one** engine at runtime — bundlers deduplicate — but the type identity of `MotionValue`, `Transition`, `Variants` is **per package**. Mixing imports produces type errors at the boundary (a `MotionValue<number>` from `motion/react` is not assignable to `MotionValue<number>` from `framer-motion`).

Enforce single-source imports at the ESLint / import-sort layer. For migration, prefer a codemod (`jscodeshift`) over manual edits.

## Reference points

- Entry exports: `packages/framer-motion/src/index.ts`, `packages/framer-motion/src/dom.ts`, `packages/motion/src/index.ts`.
- Component factory: `packages/framer-motion/src/motion/index.tsx`, `packages/framer-motion/src/render/components/motion/create.ts`, `elements.ts`, `feature-bundle.ts`.
- Feature bundles: `packages/framer-motion/src/render/dom/features-animation.ts`, `features-max.ts`, `features-min.ts`.
- LazyMotion: `packages/framer-motion/src/components/LazyMotion/index.tsx`.
- VisualElement: `packages/motion-dom/src/render/VisualElement.ts`.
- Frameloop: `packages/motion-dom/src/frameloop/batcher.ts`, `order.ts`, `frame.ts`, `microtask.ts`.
