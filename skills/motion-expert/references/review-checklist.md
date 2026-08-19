# Review Checklist

Load this when reviewing a motion-heavy PR. Go through items in order; anything triggered in tier A must be reported as blocking.

## Tier A — Blocking correctness

### A1. `layout` / `layoutId` without `style`-prop rounded corner or shadow

**Check**: any `motion.*` component with `layout` or `layoutId` that also renders a rounded border or shadow.

**Fail if**: `borderRadius` or `boxShadow` is in `className` (Tailwind / CSS) only, not in `style`, a variant, or an `animate` prop.

**Why**: `scrapeMotionValuesFromProps` iterates `props.style` only. The scale corrector cannot fire on a value Motion does not track.

**Fix**: move the value into `style={{ borderRadius: 16 }}` or bake it into a variant.

### A2. `AnimatePresence mode="wait"` with multiple children

**Check**: `<AnimatePresence mode="wait">` has more than one child at a time.

**Fail if**: the children list has length >1 on any render.

**Why**: `wait` mode requires exactly one child; Motion emits a console warning and sequencing breaks.

**Fix**: split into multiple `AnimatePresence` blocks, or collapse to a single keyed switch.

### A3. Non-stable `key` on `AnimatePresence` children

**Check**: keys on direct children of `AnimatePresence`.

**Fail if**: key is an array index, a random / generated value, or absent.

**Why**: enter/exit detection uses React key identity. Index keys make reorders look like updates; exit animations play on wrong items.

**Fix**: use the data model's stable identifier (`item.id`).

### A4. `AnimatePresence` inside the conditional

**Check**: the conditional that mounts / unmounts the animated content.

**Fail if**: the conditional wraps `AnimatePresence`, not the content inside.

```tsx
// Wrong
{
  isOpen && (
    <AnimatePresence>
      <motion.div exit={{ opacity: 0 }} />
    </AnimatePresence>
  );
}
```

**Why**: when `isOpen` flips false, `AnimatePresence` itself unmounts, cancelling the exit animation before it starts.

**Fix**: put `AnimatePresence` outside the conditional:

```tsx
<AnimatePresence>
  {isOpen && <motion.div key="overlay" exit={{ opacity: 0 }} />}
</AnimatePresence>;
```

### A5. Spring with both physical and perceptual parameters

**Check**: `transition={{ type: 'spring', ... }}`.

**Fail if**: the transition contains any of `stiffness`, `damping`, `mass` alongside `duration`, `visualDuration`, or `bounce`.

**Why**: physical params silently win; the perceptual intent is lost. Ambiguous code.

**Fix**: pick one API. Recommended modern form:

```ts
transition: { type: 'spring', visualDuration: 0.4, bounce: 0.25 }
```

### A6. `layout` on inline or SVG child

**Check**: elements with `layout` or `layoutId`.

**Fail if**: target element is `display: inline` (typically `<span>` without inline-block) or is an SVG child element (not the root `<svg>`).

**Why**: projection requires a box model with bounds. Inline and SVG descendants do not have one.

**Fix**: promote to `inline-block` / `block`, or wrap in a `<div>`.

### A7. `mode="popLayout"` without a positioning context

**Check**: `<AnimatePresence mode="popLayout">`.

**Fail if**: the animated parent (or a recent ancestor) has `position: static`.

**Why**: `popLayout` sets the exiting element to `position: absolute`. That only works relative to a positioned ancestor; otherwise it escapes to the viewport.

**Fix**: set the parent to `position: relative` (or any non-static positioning).

### A8. `popLayout` with `layout` exit animation

**Check**: an element using `mode="popLayout"` also has an `exit` that animates `layout`-style properties (size, position).

**Fail if**: `exit` contains `width`, `height`, `x`, `y`, or relies on `layout` continuity.

**Why**: `popLayout` removes the element from the flow (`position: absolute`), which changes its bounding box. `layout` animations during exit are incoherent.

**Fix**: use `opacity` or `scale` exit only under `popLayout`.

### A9. `framer-motion` import in modern code

**Check**: import statements.

**Fail if**: new or modified code uses `from 'framer-motion'` rather than `from 'motion/react'`.

**Why**: single-source import keeps types coherent. The `motion` and `framer-motion` packages share runtime but not TypeScript type identity.

**Fix**: change to `from 'motion/react'`. Legacy code without migration is a should-fix, not blocking.

### A10. Drag release overridden to spring

**Check**: `<motion.div drag dragTransition={{ type: 'spring' }} />`.

**Fail if**: `dragTransition.type` is explicitly set to `'spring'` and `dragSnapToOrigin` is false.

**Why**: inertia is two-phase (friction then spring hand-off at constraints). Forcing spring loses the friction decay — the drag release feels wrong.

**Fix**: remove the override, or if you really want a spring return to origin, set `dragSnapToOrigin={true}` which is the correct API.

## Tier B — Should-fix performance

### B1. Animating non-accelerated properties on a hot path

**Check**: `animate` or `initial` / `animate` with `width`, `height`, `top`, `left`, `margin*`, `padding*`, `backgroundColor`, `borderColor`, `boxShadow`, `borderRadius` (pixel value, not wrapped in `style` for scale correction).

**Flag**: likely paint / layout cost per frame.

**Fix tree**:

- Size → `scale` or `layout` (FLIP).
- Position → `x` / `y` (translate).
- Color → stack two colored layers with `opacity`.
- Shadow → `filter: drop-shadow` for simple, or cross-fade for complex.
- Radius → `clip-path: inset(... round ...)`.

### B2. `onUpdate` on an otherwise-accelerated animation

**Check**: `transition={{ onUpdate: ... }}` on animations over `opacity`, `transform`, `clipPath`, `filter`.

**Flag**: forces main-thread `JSAnimation` instead of WAAPI.

**Fix**: if the callback is debug-only, gate by `NODE_ENV`. If it's meaningful, refactor to a `MotionValue` pipeline + `useMotionValueEvent`.

### B3. Independent transforms via CSS custom properties

**Check**: `style={{ '--x': x, '--y': y }}` paired with CSS `transform: translate(var(--x), var(--y))`.

**Flag**: custom-property animations are not compositor-accelerated.

**Fix**: use `useMotionTemplate` or pass typed transform props directly:

```tsx
<motion.div style={{ x, y, scale }} />;
```

### B4. Global `LayoutGroup`

**Check**: `LayoutGroup` with a huge subtree.

**Flag**: every `willUpdate` in the group dirties all members.

**Fix**: scope each group to its minimum required subtree.

### B5. Scroll-linked animation routed through React state

**Check**: `useMotionValueEvent(scrollY, 'change', setStateFunction)` in a component with hot scroll effects.

**Flag**: re-renders at scroll rate.

**Fix**: pass the `MotionValue` directly to a `motion` component's `style`, or derive via `useTransform` and still keep on the MV channel.

### B6. `useScroll` without `target` in a scroll container

**Check**: `useScroll()` with no `target`.

**Flag**: defaults to window. May not match the intended scroll source.

**Fix**: pass `target: ref` when the scroll comes from a nested container; pass `offset` to reduce computation when only a small window matters.

### B7. Hand-rolled `requestAnimationFrame`

**Check**: `requestAnimationFrame` loops in components that also use Motion.

**Flag**: out of phase with the frame batcher; may cause double writes.

**Fix**: use `useAnimationFrame` or `frame.update`.

### B8. Spring tokens duplicated

**Check**: many components hard-code the same spring config.

**Flag**: no single source of truth for the design system's motion vocabulary.

**Fix**: centralize (e.g. a `transitions.ts` module exporting `springs.quick`, `springs.bouncy`, ...). Consume via `MotionConfig` or per-prop.

## Tier C — Consider

### C1. `whileHover` + `whileTap` scale conflict

If both specify `scale`, `whileTap` wins while pressed. Usually fine; worth a comment for design-system consistency.

### C2. Missing `useReducedMotion` on decorative animation

Flag decorative motion (parallax, flourish) without a reduced-motion opt-out. Not a blocker if the animation is subtle, but accessibility is improved by adding.

### C3. Variants vs inline `animate`

For components with 3+ states, variants are cleaner than conditional `animate={isA ? ... : isB ? ... : ...}`. Not a correctness issue.

### C4. `useInView` vs `whileInView`

`whileInView` handles the common case (enter animation on scroll into view). `useInView` gives more control for advanced cases (trigger on 80% visible + element at least 100px tall). Use the simpler one unless you need the extra precision.

### C5. `MotionConfig` placement

`MotionConfig` set at the page root centralizes defaults but propagates through the whole tree. Consider whether the defaults should be global (app-wide motion language) or scoped (a feature-specific motion vocabulary).

### C6. SVG path animation

`motion.path` is an underused primitive. If a component hand-rolls `strokeDashoffset` animation via custom hooks, it can usually be replaced with `<motion.path />` + `animate={{ pathLength: 1 }}`.

### C7. Legacy `exitBeforeEnter`

Old Motion (pre v5) used `exitBeforeEnter` on `AnimatePresence`. Replaced by `mode="wait"`. Migrate; the old API is removed in v11.

## Output format

When reporting findings, use this structure:

````
## Review: <component name or PR>

**Verdict**: <Ship | Ship with nits | Needs changes | Blocking>

### Blocking
1. `<file>:<line range>` — <one-sentence summary>.
   **Why**: <source citation, one sentence>.
   **Fix**:
   ```tsx
   <minimal diff>
````

### Should-fix

<same format, lower severity>

### Consider

<stylistic or performance-optional, one-liner each>

### Sources

- `packages/motion-dom/src/...` (cited rule)
- `motion.dev/docs/...` (cited doc)

```
Keep blocking items strict: only include if they will manifest as a visible bug. Anything else is should-fix at most.

## Common diff patterns worth flagging

The following patterns frequently need review:

- A new `motion.div` was added but `layout` is on an inner child and the outer has only `className`. Intent is probably to put `layout` on the outer with `style={{ borderRadius }}`.
- An `AnimatePresence` was added but the sibling tree was not reviewed for exit animation definitions.
- A `useSpring` was introduced in place of `useTransform`. Ask whether spring physics is actually desired or if clamped linear was enough.
- A new `dragConstraints` ref was introduced but the reference container has `overflow: visible` — the constraints will still measure correctly but the element can render outside the box.
- A `LazyMotion` was introduced mid-tree; everything above continues loading the full bundle. Usually a mistake.
```
