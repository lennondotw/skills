# Gestures: Pointer, Drag, Pan, Hover, Press

Load this when reviewing drag-enabled components, debugging "why doesn't my hover fire on touch", or designing a custom gesture hook.

## Unified pointer model

All Motion gestures funnel through a pointer abstraction built on `PointerEvent`. The design decisions:

- **Pointer, not mouse/touch.** Native `PointerEvent` unifies mouse, touch, pen, and stylus. Motion listens on pointer events exclusively.
- **`isPrimaryPointer` filter.** Multitouch does not trigger gestures. The first pointer wins; subsequent contacts are ignored. This prevents pinch / multi-finger scroll from accidentally firing drag.
- **Throttled to `frame.update`.** `pointermove` handlers are coalesced; one logical update per frame. This keeps raf-scheduled animations in sync with input.
- **`contextWindow`.** Listeners attach on the element's owner window (`element.ownerDocument.defaultView`), not always `window`. Important for iframe embeds and popovers in separate documents.

Core: `PanSession` (`packages/framer-motion/src/gestures/pan/PanSession.ts`). Every drag, pan, and related gesture instantiates one `PanSession` per active interaction.

## `hover`

Source: `packages/motion-dom/src/gestures/hover.ts`.

Semantics:

- Listens to `pointerenter` and `pointerleave`.
- **Ignores `pointerType === 'touch'`.** This is a deliberate design choice: hover on touch screens fires on every tap, producing sticky hover states. Motion's `hover` = mouse/pen/stylus only.
- **Ignores events while `isDragActive()` is true.** A drag in progress suppresses hover changes to prevent confusing state.

Implementation notes:

- Respects `setupGesture` selector resolution (same as `animate('.class', ...)`).
- Registers `pointerenter` on the element; on fire, installs a one-shot `pointerleave` listener to avoid double-subscription.

### React usage

```tsx
<motion.div
  whileHover={{ scale: 1.05 }}
  onHoverStart={() => setFocused(true)}
  onHoverEnd={() => setFocused(false)}
/>;
```

`whileHover` and the `onHoverStart` / `onHoverEnd` callbacks use the same `hover` under the hood. `onHoverStart` fires only on mouse/pen; touch never triggers it.

For touch equivalents, combine with `whileTap` or `press`.

### Vanilla usage

```ts
import { hover } from "motion";

const stop = hover(".item", (element, e) => {
  element.style.background = "blue";
  return () => {
    element.style.background = "";
  };
});
stop(); // removes all listeners
```

The callback may return an `onHoverEnd` cleanup. The outer `stop` removes the listener entirely.

## `press`

Source: `packages/motion-dom/src/gestures/press/index.ts`.

Semantics:

- Triggers on `pointerdown` and releases on `pointerup` / `pointercancel`.
- **Only primary pointer** (`isPrimaryPointer`).
- **Suppressed during active drag** (`!isDragActive()`).
- **Keyboard accessibility**: elements with `role="button"`, `<button>`, `<a href>`, or `tabindex` participate in press via `enableKeyboardPress`. Space and Enter fire press, respecting focus-visible semantics.
- Differences from `onClick`:
  - `press` starts on `pointerdown`, not `click`. Visual feedback is immediate.
  - `press` does not fire if the pointer leaves the element before `pointerup` (unlike `click`, which fires regardless).
  - `press` is not triggered by programmatic `.click()` calls.

### React usage

```tsx
<motion.button
  whileTap={{ scale: 0.95 }}
  onTapStart={() => setActive(true)}
  onTap={() => submit()}
  onTapCancel={() => setActive(false)}
/>;
```

Callback taxonomy:

- `onTapStart` — pointer down on the element.
- `onTap` — pointer up on the element. Equivalent to a "completed press".
- `onTapCancel` — pointer left the element before release.

### Vanilla usage

```ts
import { press } from "motion";

press("button", (element, e) => {
  element.style.transform = "scale(0.95)";
  return (endEvent, info) => {
    element.style.transform = "";
    if (info.success) console.log("tap completed");
  };
});
```

The start callback returns an end callback that receives `{ success }` indicating whether the tap was completed (true) or cancelled (false).

## `drag`

Source: `packages/framer-motion/src/gestures/drag/`. Built on `PanSession` + a dedicated `VisualElementDragControls`.

Semantics:

- Enables the element to be moved by pointer drag.
- Tracks state: `isDragging`, current offset, velocity.
- On release, runs an `inertia` animation to settle the element (momentum + optional constraint bounce).
- Managed through `drag`, `dragControls`, `dragConstraints`, `dragElastic`, `dragMomentum`, `dragTransition`, `dragListener`, `dragPropagation`, and related props.

### Minimal usage

```tsx
<motion.div
  drag
  dragConstraints={{ left: 0, right: 200, top: 0, bottom: 100 }}
  dragElastic={0.2}
/>;
```

### `drag` prop values

- `true` — drag on both axes.
- `'x'` — horizontal only.
- `'y'` — vertical only.
- `false` — disable (default).

### `dragConstraints`

Two forms:

- **Object**: `{ left, right, top, bottom }` — bounds in pixel offsets relative to starting position.
- **Ref to element**: `dragConstraints={containerRef}` — constrains to the container's box. Motion measures once on mount; re-measures when `dragConstraints` ref identity changes.

Outside constraints, the element can still be dragged, but resistance follows `dragElastic`:

- `dragElastic: 0` — hard stop at the boundary, cannot overshoot.
- `dragElastic: 0.5` — rubber-band with half resistance (default).
- `dragElastic: 1` — no resistance past boundary (effectively unconstrained).

The rubber-band math (`packages/framer-motion/src/gestures/drag/utils/constraints.ts` around lines 16–33):

```
constrained = mixNumber(currentPoint, boundary, dragElastic)
```

When the pointer moves outside the allowed range, the element position is interpolated toward the boundary with weight `1 - dragElastic`, producing the "squish" feel.

### `dragMomentum`

- `true` (default) — release continues inertia-driven motion with the release velocity.
- `false` — release snaps to rest immediately. Velocity is zeroed in `startAnimation` (around lines 477–479 of `VisualElementDragControls.ts`).

### `dragTransition`

Controls the post-release animation. Defaults to `type: 'inertia'` with:

- `power: 0.8`
- `timeConstant: 750`
- `bounceStiffness: 500`, `bounceDamping: 10` (scaled up dramatically for hard constraints)

Override for snap behavior:

```tsx
dragTransition={{
  modifyTarget: (t) => Math.round(t / 80) * 80, // snap to 80 px grid
}}
```

Combine with `dragSnapToOrigin`:

```tsx
dragSnapToOrigin;
// Element springs back to 0, 0 after drag release.
```

This overrides the inertia target to `{ x: 0, y: 0 }` with a spring hand-off. Good for swipe-to-dismiss cancellation.

### `dragControls` — external trigger

Normally, pointer down on the element starts the drag. To initiate from elsewhere (a drag handle that is not the dragged element itself):

```tsx
const controls = useDragControls();

return (
  <>
    <div onPointerDown={(e) => controls.start(e)}>Handle</div>
    <motion.div drag dragControls={controls} dragListener={false} />
  </>
);
```

`dragListener={false}` disables the element's own pointer listeners, so only `controls.start(e)` can initiate drag.

### `dragPropagation`

By default, `pointerdown` on a drag-enabled child calls `stopPropagation`, preventing parent drags from starting. Set `dragPropagation={true}` to allow parent drags to also receive the event. Rare; mostly used for nested draggable lists.

### Drag + scroll: conflict avoidance

When the element is inside a scroll container, pointer drag can fight the browser's scroll gesture. `PanSession` addresses this via `startScrollTracking` (around lines 178–215):

- Detects scrollable ancestors by walking the parent chain and checking `overflow`.
- On `scroll` events, adjusts the drag's reference point so the dragged element stays with the pointer rather than with the scrolled content.

For touch scrolling:

- **Vertical drag + vertical scroll**: the browser wins the gesture after a small deadzone. Either constrain `drag='x'` or use `touchAction: 'none'` on the element to tell the browser not to handle scroll.
- **Horizontal drag + vertical scroll**: usually both work; vertical scroll on the page, horizontal drag on the element.

Add `style={{ touchAction: 'none' }}` to drag elements that must not defer to browser scroll.

## `Reorder` — drag-to-reorder lists

Source: `packages/framer-motion/src/components/Reorder/`.

A specialized component that combines drag with automatic list re-ordering:

```tsx
import { Reorder } from "motion/react";

function List() {
  const [items, setItems] = useState(["a", "b", "c"]);
  return (
    <Reorder.Group values={items} onReorder={setItems}>
      {items.map((item) => (
        <Reorder.Item key={item} value={item}>
          {item}
        </Reorder.Item>
      ))}
    </Reorder.Group>
  );
}
```

Behavior:

- Each `Reorder.Item` is draggable on one axis (default `y`).
- As an item crosses a sibling's midpoint, the sibling swaps positions with a FLIP layout animation.
- `onReorder` is called with the new order on each swap (not only at release).
- Constraints are inferred from the container; `dragConstraints` may not be needed.

Under the hood, `Reorder.Item` sets `layout` + `drag` + a hover-detection loop that tracks midpoint crossings.

### Caveats

- `values` must be reference-stable when identity matters (e.g. passing new object literals per render breaks the comparison). Use primitive keys or memoize the array.
- `onReorder` is called frequently (on every swap, not every frame). Keep the handler lightweight.
- Accessibility: `Reorder` alone is not keyboard-accessible. Provide alternate UI (up/down buttons) for users who cannot drag.

## Pan (without the drag polish)

`usePan` / `onPan` / `onPanStart` / `onPanEnd` is the raw pointer-drag API without inertia or constraints. It emits `(event, info)` with:

- `info.point` — absolute pointer position.
- `info.delta` — since last event.
- `info.offset` — since drag start.
- `info.velocity` — { x, y } in pixels/sec.

Use when:

- You need the gesture but not the FLIP / inertia (e.g. drawing canvas, slider thumb).
- You want to feed pointer velocity into custom physics.

```tsx
<motion.div
  onPan={(e, info) => {
    x.set(info.offset.x);
    y.set(info.offset.y);
  }}
  onPanEnd={(e, info) => {
    // Apply your own inertia
  }}
/>;
```

`onPan` fires on `pointermove` (throttled by frame). `onPanEnd` on `pointerup` / `pointercancel`.

## `whileFocus`

```tsx
<motion.button whileFocus={{ scale: 1.05 }} />;
```

Activates when the element receives keyboard focus (`:focus-visible`, not `:focus`). The distinction matters for accessibility: `:focus-visible` is shown only for keyboard navigation, not for mouse click. Use this for focus rings that should not flash on click.

Callbacks: `onFocus`, `onBlur` (same as native HTML).

## `whileInView`

```tsx
<motion.div
  whileInView={{ opacity: 1 }}
  initial={{ opacity: 0 }}
  viewport={{ once: true, amount: 0.3 }}
/>;
```

Activates when the element intersects the viewport (or a custom root, via `viewport.root`). Uses `IntersectionObserver` under the hood.

`viewport` options:

- `once: true` — after first trigger, do not re-fire on subsequent scroll-outs. Common for enter animations.
- `amount: 'some' | 'all' | number` — fraction of the element that must be visible. Maps to `IntersectionObserver.threshold`.
- `root: RefObject` — custom scroll root.
- `margin: string` — root margin, CSS style (`'0px 0px -100px 0px'`).

Prefer `whileInView` + `once` over manual `IntersectionObserver` + `useState` toggles.

## Gesture conflicts and priority

When multiple gestures are active on the same element, Motion applies the `variantPriorityOrder` defined in `packages/motion-dom/src/render/utils/variant-props.ts`:

```
animate < whileInView < whileFocus < whileHover < whileTap < whileDrag < exit
```

Higher-priority entries override lower ones for the properties they touch. So `whileTap: { scale: 0.95 }` overrides `whileHover: { scale: 1.05 }` while the element is pressed. `whileFocus` sits between `whileInView` and `whileHover` — a focused element with hover will run `whileHover` for hovered props but keep `whileFocus` for any props `whileHover` does not set.

Note that `initial`, `style`, and the resolved DOM state exist outside this priority chain — they act as the base from which these variants override.

Unspecified properties pass through. `whileHover: { scale: 1.05 }` does not cancel `animate: { opacity: 1 }`.

### Drag vs layout

A `motion` element with both `layout` and `drag` is allowed but tricky:

- The `transform` used for FLIP is composited with the `transform` used for drag offset.
- When drag ends and the element should re-flow, the `inertia` animation animates `x` / `y` back to the resting position while `layout` handles the box change.
- For complex cases (drag-to-rearrange inside a FLIP layout), prefer `Reorder` over rolling your own.

## Reduced motion

`useReducedMotion()` returns `true | false | null` based on the user's OS setting. `null` during SSR; `true` after hydration when `prefers-reduced-motion: reduce` is set.

Motion **automatically** zeros `transform` and `layout` animations under reduced motion when `MotionConfig.reducedMotion = 'user'`. Colors and opacity still animate.

Best practice for gesture-driven feedback:

```tsx
const prefersReduced = useReducedMotion();

<motion.button
  whileTap={prefersReduced ? undefined : { scale: 0.95 }}
  onTap={submit}
/>;
```

Some feedback (press state) is meaningful; some (flourish) is not. Keep the meaningful, drop the decorative.

## Reference points

- `PanSession`: `packages/framer-motion/src/gestures/pan/PanSession.ts` (move throttling ~301–307, scroll tracking ~178–215, 246–261).
- Hover: `packages/motion-dom/src/gestures/hover.ts`.
- Press: `packages/motion-dom/src/gestures/press/index.ts`, `accessibility.ts`.
- Drag state: `packages/motion-dom/src/gestures/drag/state/is-active.ts`, `set-active.ts`.
- Drag controls: `packages/framer-motion/src/gestures/drag/VisualElementDragControls.ts` (inertia start ~443–492, rubber-band ~constraints utility).
- Constraints math: `packages/framer-motion/src/gestures/drag/utils/constraints.ts`.
- Reorder: `packages/framer-motion/src/components/Reorder/`.
- In-view: `packages/framer-motion/src/render/dom/viewport/index.ts`.
