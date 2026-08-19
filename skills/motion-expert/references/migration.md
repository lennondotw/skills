# Migration Guide

Load this when upgrading `framer-motion` to `motion`, or moving from v10/v11 to v12+.

All version claims in this file are taken from `CHANGELOG.md` in the repository. The major removals and renames cluster around specific minor versions, not entire majors; where that matters, the exact version is cited.

## `framer-motion` → `motion`

The package was renamed. `framer-motion` still exists (as a compatibility re-export) but the canonical npm name is now `motion`, with React bits at `motion/react`.

### Runtime equivalence

```
framer-motion → same engine as motion (deduped at the bundler)
```

Installing both packages does **not** duplicate the runtime. However, **TypeScript types are not shared**. A `MotionValue` from `motion/react` is not structurally identical to a `MotionValue` from `framer-motion`; assignments across the boundary error.

### Import migration

```diff
- import { motion, AnimatePresence, useScroll } from 'framer-motion';
+ import { motion, AnimatePresence, useScroll } from 'motion/react';
```

Vanilla:

```diff
- import { animate, scroll, inView } from 'framer-motion/dom';
+ import { animate, scroll, inView } from 'motion';
```

For Next.js App Router client boundaries:

```ts
// Only if the file is a client component and Motion is used at a boundary
import { motion } from "motion/react-client";
```

### Codemod

No official codemod for the rename at the time of writing. A `jscodeshift` or simple regex replacement across the codebase suffices:

```bash
rg -l "from 'framer-motion'" | xargs sd "from 'framer-motion'" "from 'motion/react'"
rg -l 'from "framer-motion"' | xargs sd 'from "framer-motion"' 'from "motion/react"'
```

Verify imports that extract types (`import type { HTMLMotionProps } from ...`) are updated too.

## Notable removals and renames

Do not treat these as "v12 breaking changes" wholesale — they landed across multiple minor versions over several years. The list below cites the CHANGELOG.

### `motion.custom` → `motion.create`

```diff
- const MotionButton = motion.custom(Button);
+ const MotionButton = motion.create(Button);
```

`motion.custom()` was **removed in 4.0.0 (2021-03-18)**. `motion.create()` was introduced in **11.5.0 (2024-09-04)**. Between these versions, wrapping a custom component required `motion(Component)` (the function call form). If a codebase still uses `motion.custom`, it is running something older than 4.0 and has many other updates pending.

`motion.create` requires the wrapped component to forward `ref`.

### `AnimatePresence` `exitBeforeEnter` removed

```diff
- <AnimatePresence exitBeforeEnter>
+ <AnimatePresence mode="wait">
```

`exitBeforeEnter` was deprecated much earlier and **removed in 11.17.0 (2025-01-10)**. `mode="wait"` is the replacement.

### Independent transform properties

Previously:

```tsx
<motion.div animate={{ transform: "translateX(100px) scale(1.2)" }} />;
```

Now:

```tsx
<motion.div animate={{ x: 100, scale: 1.2 }} />;
```

Independent `x`, `y`, `scale`, `rotate`, `skewX`, `skewY` are first-class properties. Motion composes them into the single `transform` string internally.

**Impact on custom code**: reading `motion.div.style.x` returns a `MotionValue`, not a number. Use `x.get()`.

### `transition.ease` default changed

Default tween easing was `'linear'` in older versions. Since v11+ it is `'easeOut'`. If your design system expected linear by default, you will notice animations "ease out" that previously went straight.

**Fix** (if you want linear):

```ts
transition: {
  ease: "linear";
}
// or globally via MotionConfig
```

### `spring` perceptual API added

`visualDuration` and `bounce` were added in **11.12.0 (2024-11-27)**. Older code using `duration` is still supported but takes a different code path inside `getSpringOptions` (Newton iteration via `findSpring` instead of the closed-form solution used for `visualDuration`).

**Recommended migration**:

```diff
- transition: { type: 'spring', duration: 0.5, bounce: 0.3 }
+ transition: { type: 'spring', visualDuration: 0.5, bounce: 0.3 }
```

`duration` measures total settle time; `visualDuration` measures perceptual settle time. The two paths use different math, so the numbers are not interchangeable; re-tune if the animation feels off.

### Gesture callback signatures (vanilla)

The vanilla `hover` and `press` callbacks use an `(element, event) => ...` signature in the current `motion-dom` API, with the element as the first argument. If you are updating an older codebase whose callbacks only took `(e)`, switch to the new signature:

```diff
- hover('.item', (e) => { ... });
+ hover('.item', (element, e) => { ... });
```

(A precise version bump for this signature change is not labelled in `CHANGELOG.md`; treat it as "whatever version moved from the old signature to the current one".)

React gesture callbacks (`onHoverStart`, `onTap`, etc.) did **not** change.

### `useAnimation` → `useAnimate` (rename, old name still exported as alias)

`useAnimationControls` was introduced in **6.4.1**, and `useAnimation` was kept as an alias to it for backward compatibility:

```ts
// packages/framer-motion/src/animation/hooks/use-animation.ts (current)
export const useAnimation = useAnimationControls;
```

Both names still work. `useAnimate` is the modern replacement that additionally provides a scope ref:

```diff
- const controls = useAnimation();
- controls.start({ scale: 1.2 });
+ const [scope, animate] = useAnimate();
+ animate(scope.current, { scale: 1.2 });
```

`useAnimate` requires the `scope` ref to be attached to a DOM element. For simple cases, migrating from `useAnimation` to `useAnimate` is not required — the old name still works.

### `LayoutGroup inherit` default

`LayoutGroup` prefixing behavior: if nested inside another `LayoutGroup`, by default the inner group's `id` is concatenated with the outer's (`outer-inner-<layoutId>`).

In older versions, `inherit={false}` had to be explicitly passed to prevent this. In v12, the default is the same, but the prop is called out more clearly. Behavior is unchanged.

### `Reorder` component API

`Reorder.Group` requires `values` (formerly `items` in some early previews). The prop accepts an array of values (not React elements) and `onReorder` receives the new array.

```tsx
<Reorder.Group values={items} onReorder={setItems}>
  {items.map((item) => <Reorder.Item key={item.id} value={item}>{item.name}</Reorder.Item>)}
</Reorder.Group>;
```

## v12+ specifically

### `motion/mini` split

`motion/mini` is a size-focused vanilla entry without spring / keyframes. Introduced to let size-constrained vanilla sites (landing pages, embeds) skip the full animation core.

### `motion/react-mini`

The React analogue of `motion/mini`. Omits layout, drag, springs. Useful only for extreme size constraints.

### `motion.create` auto-forwarding

`motion.create(Component)` is now tolerant of components that do not explicitly `forwardRef`, using a runtime ref-forwarding shim. Still, best practice is to forward ref explicitly:

```tsx
const Button = forwardRef<HTMLButtonElement, Props>((props, ref) => (
  <button
    ref={ref}
    {...props}
  />
));
export const MotionButton = motion.create(Button);
```

### `MotionCanvas` for WebGL

Integration with `@react-three/fiber` via a separate package (`framer-motion-3d`). Covered only to the extent needed to recognize the boundary; detailed R3F review belongs to that package.

### SVG filter primitive support

v12 added support for animating SVG filter primitives via `motion.feGaussianBlur` etc. They now accept `initial` / `animate` props; previously these required manual attribute animation.

## Reference points

- Official upgrade guide: `motion.dev/docs/upgrade-guide` (React) and `motion.dev/docs/js-upgrade-guide` (vanilla).
- Changelog: `github.com/motiondivision/motion/blob/main/CHANGELOG.md`.
- Release tags: `github.com/motiondivision/motion/releases`.
