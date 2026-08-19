# FLIP and the Projection Tree

Deep reference on how Motion implements layout animations. Load this whenever the task involves `layout`, `layoutId`, `LayoutGroup`, `layoutRoot`, `layoutScroll`, `Reorder`, or shared-element transitions. This is the single most common source of animation bugs in Motion codebases.

## Why FLIP at all

Animating layout properties (`width`, `height`, `top`, `left`, `margin`, `padding`) is expensive: each frame triggers layout recomputation, paint, and composite. FLIP replaces this with:

1. **F**irst — snapshot the element's current box.
2. **L**ast — let the browser reflow to the new layout.
3. **I**nvert — apply an inverse `transform` so the element visually appears in its old position.
4. **P**lay — animate the `transform` back to identity.

Only `transform` (and `opacity`) animate. Layout happens exactly once, off-animation.

Motion's implementation is not "apply FLIP on request". It maintains a **projection tree** that tracks layout boxes continuously, and derives FLIP deltas on every commit. That tree is why the system scales to thousands of nodes without jank, and it is why certain rules (such as `borderRadius` in `style`) exist.

## The projection tree

One `ProjectionNode` per `motion` component, plus a single `DocumentProjectionNode` at the root. The tree mirrors the DOM tree for nodes that have a projection attached. Source of the factory: `packages/motion-dom/src/projection/node/create-projection-node.ts`.

Each node holds:

| Field                    | Meaning                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `instance`               | The DOM element (HTMLElement / SVGElement).                                                         |
| `layout`                 | The current measured box in page coordinates.                                                       |
| `snapshot`               | The box just before the current layout change (set in `willUpdate`, cleared at end of `didUpdate`). |
| `path`                   | Ordered list from this node up to root.                                                             |
| `children`               | Child projection nodes.                                                                             |
| `target` / `targetDelta` | Animation destination and per-axis delta.                                                           |
| `treeScale`              | Cumulative scale applied by ancestors (for compensation).                                           |
| `resumeFrom`             | When present, the node inherited state from a prior lead in a shared `layoutId` transition.         |
| `options`                | Including `layoutId`, `layout`, `crossfade`, `animationType`.                                       |

A node becomes "active" when its React component mounts and it calls `projection.mount(instance)`. Unmount triggers cleanup and, with `AnimatePresence`, delayed removal until exit animations finish (`safeToRemove`).

## Ref contract: how a projection node attaches

The projection node cannot function without a DOM reference. Every `motion` component's layout animation, scale correction, gesture, and drag relies on `projection.mount(domElement)` being called exactly once after the element is in the DOM, and `projection.unmount()` being called on unmount.

### Ref flow inside `motion.*`

For built-in tags (`motion.div`, `motion.button`, ...) the factory (`packages/framer-motion/src/motion/index.tsx` + `render/components/motion/create.ts`) already wires this up:

```
<motion.div> render
  ↓
React.createElement(tag, { ...props, ref: mergedRef })
  ↓
mergedRef = composeRefs(userRef, useVisualElementRef)
  ↓
ref callback fires with HTMLElement
  ↓
visualElement.mount(element)
  ├── projection.mount(element)
  │     ├── parentProjection.addChild(this)
  │     ├── instance-level listeners (resize, scroll)
  │     └── options.layoutId ? registerSharedNode(resolvedId, this) : noop
  └── startup animations for animationState
```

You never wire this manually for built-in tags. The factory composes any user-supplied `ref` with the internal one.

### `motion.create(Component)` — custom component rules

When wrapping a custom component, the wrapped `Component` **must accept and forward `ref` to the underlying DOM element**.

Correct:

```tsx
import { motion } from "motion/react";
import { forwardRef } from "react";

const Button = forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
  (props, ref) => <button ref={ref} {...props} />,
);

export const MotionButton = motion.create(Button);
```

Silently broken:

```tsx
const Button = (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />;

export const MotionButton = motion.create(Button);
// MotionButton receives layoutId etc. but projection.mount never fires.
// Animations silently do nothing. No warning in production.
```

Checklist for any `motion.create` target:

1. The component is a `forwardRef`.
2. The `ref` parameter is passed to exactly one real DOM element (not a wrapper div it never renders).
3. That element is not conditional on an async load — if the component returns `null` before hydration, projection cannot attach.

React 19 note: if you migrate to the React 19 ref-as-prop pattern (`ref: Ref<HTMLButtonElement>` as a regular prop), `motion.create` still works because Motion passes its composed ref through the `ref` prop — but keep the ref on a single concrete DOM element.

### Partial renders and deferred refs

A ref that is attached conditionally (for example, when the element is behind a `Suspense` boundary and the fallback renders first) will not trigger `projection.mount` until the real child commits. In practice this means:

- The first layout animation after reveal may snapshot a "fresh" state with no prior snapshot, producing an instant jump rather than a transition. Preempt by guarding the animated prop with `initial={false}` during the suspended phase.
- `layoutId` matching across a suspense boundary only works after both halves have committed. Plan for that if you are morphing from a placeholder to real content.

### Explicit unmount rules

`projection.unmount()` is called by the `VisualElement`'s cleanup:

1. Cancels any in-flight layout animations.
2. Removes the node from its parent's `children` set.
3. Unregisters from any `NodeStack` (calls `relegate` if this node was the lead — see below).
4. Disconnects resize / scroll listeners.
5. Drops its entry in `visualElementStore`.

With `AnimatePresence`, unmount is deferred: the element remains mounted until `safeToRemove` is called after exit animations. This is crucial for `layoutId` transitions where the exiting element is still the lead for a short window.

### When ref is wrong: symptoms

| Symptom                                                                 | Likely cause                                                                                                          |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `layout` animation does nothing; element snaps to new position          | The wrapped component does not forward ref.                                                                           |
| `layoutId` match fails between two places that look identical           | One side is rendering a component that doesn't forward ref, so no projection node was registered for that `layoutId`. |
| `whileHover` / `whileTap` fires but `scale` does nothing                | Ref forwarded, but forwarded to a wrapper div that doesn't have the expected bounds.                                  |
| First entrance animation is an instant snap; subsequent runs are smooth | The element was not mounted on first render (conditional rendering). The first entrance had no prior snapshot.        |

First diagnostic step for any layout animation bug: in DevTools, inspect `visualElementStore` (the `WeakMap` exported from `packages/motion-dom/src/render/store.ts`) by calling `visualElementStore.get(element)`. If it returns a `VisualElement`, check `visualElement.projection`. If either is missing, the ref chain is broken.

## Mount and registration lifecycle

Tying it together — the exact sequence from `<motion.div layoutId="card" />` being rendered to a first paint:

1. **React render phase**. `createMotionComponent` executes, builds `VisualState` from props, reads `LayoutGroupContext` to resolve the prefixed `layoutId`.
2. **React commit phase**. `useVisualElement` creates the `HTMLVisualElement` and its paired `ProjectionNode` (via `createProjectionNode`). The projection node is not yet mounted; it has no instance.
3. **ref callback fires** with the real `HTMLElement`. `VisualElement.mount(element)` is called.
4. `projection.mount(element)`:
   - Stores `this.instance = element`.
   - Calls `attachResizeListener(element)` if configured.
   - Finds parent projection via walking up `element.parentNode` until a projection-attached element is found (usually cached via `LayoutGroupContext` or parent `VisualElement`).
   - Calls `parentProjection.addChild(this)`.
   - If `options.layoutId` is set, registers with `root.sharedNodes.get(layoutId)` — see "Shared layoutId matching" below.
5. **`useIsomorphicLayoutEffect`**:
   - If this is a first mount and `initial !== false`, `animationState.animate(initial)` starts the initial animation.
   - `animationState.animate(animate)` transitions to the current target.
6. **Frame 1 paint**. The projection node's `target` equals its `layout` because no change happened. No FLIP yet.
7. **Next render** mutates either the element's CSS (triggering `willUpdate`) or a sibling's `layoutId` registration (triggering a shared-layout transition). Now the FLIP lifecycle described below kicks in.

This ordering matters because:

- Putting `useEffect(() => setAnimate('visible'))` on mount means the transition happens on frame 2, not frame 1. If you need frame-1 animation, pass `animate` directly.
- `layoutId` registration happens in `projection.mount`, so two components with the same `layoutId` that mount in the same commit both become members of the stack before either animates — the second to mount becomes the lead.

## FLIP lifecycle, step by step

The flow for a single commit that changes layout:

### 1. `willUpdate` — top-down snapshot

Runs before React commits. In `create-projection-node.ts` around line 649:

- Cancel any in-flight optimized "appear" animations (these are Framer-authored first-paint optimizations and do not affect vanilla Motion apps).
- Walk **`this.path` upward** and call `willUpdate(false)` on any ancestor that is a `layoutRoot` — this ensures scroll containers above the current node have up-to-date snapshots.
- Call `this.updateSnapshot()`, storing `this.snapshot = this.measure()`.
- Emit `willUpdate` on listeners so any `nodeGroup` this node is part of can dirty its siblings.

Children are **not** recursively snapshotted at this phase. Each `motion.*` component whose own commit changes layout triggers its own `willUpdate`. The `nodeGroup` propagation handles coordination among siblings that all belong to the same `LayoutGroup`.

Important: **the snapshot includes the element's current transform**. Measurements use `getBoundingClientRect`, which accounts for applied `transform`. The engine compensates via `removeTransform` flag during measure when needed.

### 2. Browser reflow (React commit)

React commits the new DOM state. `style` changes, class changes, children reorder. Browser recomputes layout on next paint tick.

### 3. `didUpdate` / `updateLayout` — measure and compute delta

After commit, the projection system calls `notifyLayoutUpdate` on each affected node (`create-projection-node.ts` around lines 2121–2258):

- `snapshot = node.resumeFrom?.snapshot ?? node.snapshot` — for shared layout transitions, inherit from the prior lead.
- `layout = node.layout` (freshly measured).
- `calcBoxDelta(layoutDelta, layout, snapshot.layoutBox)` → the per-axis `{ scale, translate, origin }` transformation.
- For shared layout (`isShared`), `visualDelta` is derived from `applyTransform(measuredLayout, true)` against `snapshot.measuredBox` — this accounts for the fact that the inherited snapshot came from a differently transformed element.
- Emit `didUpdate` with `{ layout, snapshot, delta: visualDelta, layoutDelta }`.

The delta has four components per axis:

- `scale`: target size / snapshot size.
- `translate`: center delta in page coordinates.
- `origin`: transform origin (usually the snapshot's top-left).
- `originPoint`: derived; used for matrix composition when the parent also scales.

### 4. `setAnimationOrigin` — schedule the animation

Found around lines 1583–1680 of `create-projection-node.ts`. The node creates a dedicated `MotionValue` that animates from `0` to `1000` (integer scale — more on this below), with an `onUpdate` that runs `mixTargetDelta(latest)`. The inner function mixes two pre-computed axis deltas, not the raw boxes:

```
mixTargetDelta(latest):
  progress = latest / 1000
  mixAxisDelta(targetDelta.x, delta.x, progress)  // target <- 0..delta, scale 1..deltaScale
  mixAxisDelta(targetDelta.y, delta.y, progress)
  setTargetDelta(targetDelta)
  if (isShared) mixValues(...)
  root.scheduleUpdateProjection()
  scheduleRender()
```

`mixAxisDelta` is defined as:

```
mixAxisDelta(output, delta, p):
  output.translate = mixNumber(delta.translate, 0, p)   // translate toward identity
  output.scale     = mixNumber(delta.scale, 1, p)       // scale toward 1
  output.origin    = delta.origin
```

So the animation drives `targetDelta` from the initial `delta` (computed in `notifyLayoutUpdate`) toward identity. The rendered element's transform is recomputed each frame from the shrinking delta, producing the FLIP motion.

### 5. `startAnimation` — kick the clock

Around lines 1683–1734. The animation is started with `animateSingleValue(motionValue, [0, 1000], { ... })` inside `frame.update`. Why a frame tick? Because it guarantees progress `0` is rendered for at least one frame before the animation advances, preventing a perceptual jump if React happens to commit while the animation was already past zero.

### 6. `buildProjectionTransform` — produce the `transform` string

Each render phase (`render` step of the batcher), `applyTransformsToTarget` calls `buildProjectionTransform(delta, treeScale, latestTransform)` (`packages/motion-dom/src/projection/styles/transform.ts`). The composition order, reading the source:

```
final = translate3d(delta.translate / treeScale)        // viewport-space translation, scale-adjusted
      * scale(1 / treeScale)                             // cancel ancestors' accumulated scale
      * perspective(...) rotate(...) skew(...)           // from latestTransform: perspective/rotate/skew
      * scale(delta.scale * treeScale)                   // this element's own scale × treeScale
```

Two things to note:

- The `latestTransform` branch only reads **`transformPerspective`, `rotate`, `rotateX/Y/Z`, `skewX/Y`** from motion props. It does **not** read `x`, `y`, `scale`, `scaleX/Y` here — those values are composed separately by `HTMLProjectionNode` into `projectionDeltaWithTransform` before this function runs.
- `scale(1 / treeScale)` is the key to parent-scale compensation. The child's own final scale `delta.scale * treeScale` cancels the ancestor portion, leaving just the child's intrinsic delta. This is covered in detail under Parent transform compensation below.

## Why progress is 0–1000, not 0–1

The comment at the top of `create-projection-node.ts` states the intent directly: `0–1000 maps better to pixels than 0–1 which has a noticeable difference in spring animations`. Small-delta animations (a 2 px layout move) would ride very close to the spring's rest thresholds with a float in [0, 1], damping out before the motion completes; the 1000x multiplier keeps the spring solver in a range where its natural rest behavior matches pixel-level perception.

The display-side effect is zero: the `mix*` functions divide by 1000 before producing the final output.

Do not attempt to sample this progress MotionValue yourself assuming 0..1; observe the element's `transform` directly or hook `onLayoutAnimationStart` / `onLayoutAnimationComplete` at the component level.

## Scale correction

Scaling a box via `transform` stretches every pixel inside, including border radii and shadow blur. Designers notice immediately: a 16 px rounded pill becomes an oval when scaled to 2x.

Motion solves this with **scale correctors**: per-property hooks that convert the raw value into a scale-aware one each frame. The registry lives in `packages/motion-dom/src/projection/styles/scale-correction.ts`:

- `borderRadius` and each corner (`borderTopLeftRadius`, …).
- `boxShadow`.

The corrector for `borderRadius` (`scale-border-radius.ts`) converts pixel radii to percentages relative to the **target** box, so the shape stays visually circular through the scale:

```
correct(latest, node) {
  const x = pixelsToPercent(latest, node.target.x);
  const y = pixelsToPercent(latest, node.target.y);
  return `${x}% ${y}%`;
}
```

The corrector for `boxShadow` parses the value via `complex.parse`, applies the inverse scale to offset, and scales blur/spread by the average of x/y scale. It is approximate but visually close for most shadows.

### The `style` prop requirement

**Scale correction only works when Motion holds a `MotionValue` for the property.** That requires Motion to know the property exists.

`scrapeMotionValuesFromProps` (`packages/motion-dom/src/render/html/utils/scrape-motion-values.ts`, lines ~11–26) only iterates `props.style`. A property set via `className` (including Tailwind `rounded-*` utilities) never enters the motion-value map.

`isForcedMotionValue` (`packages/motion-dom/src/render/utils/is-forced-motion-value.ts`) forces specific keys into the motion-value pipeline:

```ts
return (
  transformProps.has(key) // x, y, scale, rotate, etc.
  || key.startsWith("origin") // originX, originY, originZ
  || ((layout || layoutId !== undefined)
    && (!!scaleCorrectors[key] || key === "opacity"))
);
```

Transform props and origin keys are always forced. The scale corrector keys (`borderRadius`, each corner, `boxShadow`) and `opacity` are forced only under `layout` / `layoutId`. This is the full explanation of the "put borderRadius in style" rule. It is not superstition; it is the only path by which the engine sees the value.

### Rule for reviewers

Any element with `layout` or `layoutId` that has rounded corners or a shadow must set those values in `style` (or via a variant / `animate` prop). Bare `className="rounded-2xl shadow-md"` with `layout` is a bug waiting to be noticed on the next QA pass.

### `border` is not correctable

`border` is not in the scale corrector registry. A 1 px border scaled 2x becomes 2 px. There are no plans to add it because `border` affects layout (unlike `box-shadow` / `border-radius`), so correcting it would create contradictions.

Workaround: emulate with inner `padding` and a solid `box-shadow: inset 0 0 0 1px <color>`. The shadow is scale-corrected and the padding is part of the layout.

## Shared `layoutId` transitions, matching, and the layout leader

When multiple elements share a resolved `layoutId` (after `LayoutGroup` prefix application), they form a **`NodeStack`** — a small state machine that picks exactly one member to display at a time and animates handoffs. Source: `packages/motion-dom/src/projection/shared/stack.ts`.

### How matching happens: `DocumentProjectionNode.sharedNodes`

The projection root (`DocumentProjectionNode`, at `packages/motion-dom/src/projection/node/DocumentProjectionNode.ts`) owns a single global map:

```
root.sharedNodes: Map<string /* resolvedLayoutId */, NodeStack>
```

When any projection node finishes `mount` and has an `options.layoutId`:

```
registerSharedNode(resolvedId, node):
  let stack = root.sharedNodes.get(resolvedId)
  if (!stack) {
    stack = new NodeStack()
    root.sharedNodes.set(resolvedId, stack)
  }
  stack.add(node)
  node.promote({ transition, preserveFollowOpacity })  // new member immediately tries to become lead
```

Matching is **global**. Any two elements anywhere in the React tree that resolve to the same string become stack members — regardless of DOM distance, cross-portal placement, different React subtrees, or different `AnimatePresence` boundaries. The only scoping mechanism is `LayoutGroup`'s string prefix.

This is why `LayoutGroup` is not just an orchestration primitive but a **safety primitive**: without it, two unrelated lists that both use `layoutId="item"` accidentally share a stack, producing ghost transitions between them on mount/unmount.

### `NodeStack` state

```
class NodeStack {
  lead?: IProjectionNode              // current visible member
  prevLead?: IProjectionNode          // most recent former lead
  members: IProjectionNode[]          // all registered members, insertion order

  add(node)                           // push + promote
  remove(node)                        // splice + relegate if the lead leaves
  promote(node, preserveFollowOpacity?)
  relegate(node): boolean
  exitAnimationComplete()             // method, fans out onExitComplete to members
}
```

`snapshot` on individual members is stored on the `ProjectionNode` itself, not the stack. `exitAnimationComplete` is a method the stack calls on itself, not a callback field.

Design invariants the stack enforces:

1. At most one member is visible (`lead`) at any time when `crossfade === false`. With default crossfade, both `lead` and `prevLead` can be momentarily visible during the handoff animation.
2. Members are held in insertion order. Newer registrations are pushed to the end.
3. When the lead changes, the new lead inherits the old lead's layout snapshot so the FLIP delta computes correctly.

### `promote` — the layout leader election

`promote` is split across two layers. Understanding the split is essential to reading the source.

**Layer 1: `IProjectionNode.promote({ needsReset?, transition?, preserveFollowOpacity? })`** in `create-projection-node.ts`. Called whenever a node should become its stack's lead. Delegates to `NodeStack.promote`, then handles node-local state:

```
node.promote({ needsReset, transition, preserveFollowOpacity }):
  const stack = this.getStack()
  if (stack) stack.promote(this, preserveFollowOpacity)

  if (needsReset) {
    this.projectionDelta = undefined
    this.needsReset = true
  }
  if (transition) this.setOptions({ transition })
```

**Layer 2: `NodeStack.promote(node, preserveFollowOpacity?)`** in `stack.ts`. Swaps the lead pointer and threads snapshot state across:

```
stack.promote(node, preserveFollowOpacity):
  const prevLead = this.lead
  if (node === prevLead) return          // already lead, nothing to do

  this.prevLead = prevLead
  this.lead = node
  node.show()                            // lift visibility:hidden if any

  if (prevLead) {
    prevLead.updateSnapshot()            // freshen prevLead's snapshot
    node.scheduleRender()

    const prevDep = prevLead.options.layoutDependency
    const nextDep = node.options.layoutDependency

    if (prevDep === undefined || prevDep !== nextDep) {
      node.resumeFrom = prevLead
      if (preserveFollowOpacity) prevLead.preserveOpacity = true
      // inherit snapshot + latestValues so the new lead's FLIP has a 'from'
      node.snapshot = prevLead.snapshot
      if (node.snapshot) {
        node.snapshot.latestValues =
          prevLead.animationValues || prevLead.latestValues
      }
    }

    // Hide the old lead immediately only when the NEW lead has crossfade:false
    if (node.options.crossfade === false) prevLead.hide()
  }
```

Three details developers routinely miss:

- **The crossfade check is on `node` (the new lead), not `prevLead`.** An old lead with `crossfade: false` does not trigger an immediate hide — only a new lead declaring `crossfade: false` does.
- **Snapshot inheritance is gated by `layoutDependency`.** When both sides have matching `layoutDependency`, the new node keeps its own snapshot (no inheritance, no `resumeFrom`). This lets a variant flip that happens to re-mount a component avoid re-animating if both sides carry the same explicit dependency.
- **`node.resumeFrom = prevLead`** is what makes the FLIP delta see the prior lead's world-coordinate box across DOM subtrees. Without it, the new node measures a fresh snapshot that was never at the outgoing element's position, producing a visually zero delta.

### `relegate(node)` — the leader leaves

When the current lead is about to unmount (including the deferred unmount in `AnimatePresence`), `relegate` scans **from the leaving node's position backward to index 0**, picking the nearest older still-viable member:

```
stack.relegate(node):
  for (let i = this.members.indexOf(node) - 1; i >= 0; i--) {
    const member = this.members[i]
    if (member.isPresent !== false
        && (member.instance as HTMLElement)?.isConnected !== false) {
      this.promote(member)
      return true
    }
  }
  return false
```

Note the scan starts at `indexOf(node) - 1`, not `members.length - 1`. The leaving node is naturally skipped because iteration begins below it. Successor picking is "nearest older present member", not "most recently added overall".

Cases where `relegate` returns false (stack goes dormant):

- The only member left is the one leaving (e.g. last item in a conditional tree).
- All other members are also in the process of exiting (e.g. `AnimatePresence` removing a whole group at once).
- All other members' React ref has detached (mid-navigation).

Behavior in these cases: the exiting lead stays visible throughout its own exit animation; no new lead paints; after `safeToRemove`, the stack clears.

### Typical shared transition — trace

```tsx
// Render 1
{
  !isOpen && <motion.div layoutId="card" className="collapsed" />;
}

// Render 2 (after isOpen flips true)
{
  isOpen && <motion.div layoutId="card" className="expanded" />;
}
```

Timeline:

1. **Render 1 mount**: `A` registers. Stack `{ members: [A], lead: A }`. No prior lead; `A.snapshot` is from its own initial measure.
2. **`isOpen` flips true, React commits**:
   - `B` is mounted (ref callback, `projection.mount`, `registerSharedNode`).
   - `B.promote()` runs:
     - `prevLead = A`
     - `A.updateSnapshot()` captures A's current box.
     - `B.snapshot = A.snapshot; B.resumeFrom = A`.
     - `this.lead = B`.
     - `B.show()`.
     - `A.hide()` (if `crossfade === false`) or `A` stays visible for crossfade.
   - `A` is simultaneously being unmounted by React because the conditional flipped. With no `AnimatePresence`, `A` is gone by the time `B` starts animating.
3. **Frame tick**: `B`'s FLIP machinery sees `B.snapshot` (which is `A`'s old box) and `B.layout` (which is `B`'s new box). It computes the delta and animates `B` from `A`'s position to `B`'s position.

With `AnimatePresence` wrapping, step 2 keeps `A` alive during its exit, enabling crossfade or `popLayout` to work.

### `resumeFrom` vs `snapshot`

Both are used during the delta calculation. Their distinction:

- `snapshot` — the box this node is animating **from**. It is either the node's own pre-commit measurement, or inherited from `prevLead`.
- `resumeFrom` — a reference to the **node** whose state was inherited, used to compute the **visual delta** in shared layouts (where the inherited snapshot came from a differently-transformed element and needs `applyTransform` composition).

In the simplest shared transition (both elements at transform identity), `snapshot` alone is enough. `resumeFrom` matters when the outgoing element was itself in the middle of an animation — the new lead picks up not just the old position but the old transform state.

### Ghost space and hidden members

`hide()` sets `visibility: hidden`. The member stays in the DOM, stays in the projection tree, and **stays in layout flow**.

Consequences:

- A collapsed lead that never exits leaves a gap the size of its box.
- `display: none` would remove it from the projection tree, breaking future handoffs.
- The correct cleanup is to `relegate` the lead first (so another member takes over) and then let React unmount the original (with `AnimatePresence`, via `safeToRemove`).

Common bug: a user conditionally renders both halves of a shared transition, then wraps only one side in `AnimatePresence`. The unwrapped side unmounts immediately (correct), but the wrapped side has a hidden `prevLead` that holds space. Fix: wrap both sides, or neither.

## `LayoutGroup` — namespace and orchestration

`LayoutGroup` (`packages/framer-motion/src/components/LayoutGroup/index.tsx`) does two things:

### 1. Prefix `layoutId`

Around lines 36–40, it combines the inherited `upstreamId` with its own `id`:

```
if (inherit !== false && upstreamId) {
  id = id ? `${upstreamId}-${id}` : upstreamId;
}
```

The resolved `layoutId` at the motion component (in `useLayoutId`, `motion/index.tsx` ~174–178) is:

```
resolvedLayoutId = `${layoutGroupContext.id}-${props.layoutId}`
```

Two components using `layoutId="card"` inside different `LayoutGroup` ids (`sidebar`, `main`) resolve to `sidebar-card` and `main-card` — no accidental matching.

### 2. `nodeGroup` for dirty propagation

Each `LayoutGroup` instantiates a `nodeGroup()` (`packages/motion-dom/src/projection/node/group.ts`). Every node `add`ed subscribes to `willUpdate`, and when any fires, the group `dirtyAll` — causing every other node in the group to also run `willUpdate`, ensuring consistent layout measurement across the group for the current commit.

This is why a single `LayoutGroup` wrapping thousands of nodes is expensive. Scope groups tightly.

### `forceRender`

`LayoutGroupContext.forceRender` is a React hook exposed to children. `AnimatePresence` calls it (around line 170–175 of `AnimatePresence/index.tsx`) after all exits complete, so layout-coupled components re-measure once the removed elements are out of the flow. This is the mechanism behind `mode="popLayout"` looking clean.

## Parent transform compensation

A projection animation is not just a single-element transform. When a parent scales (because of its own `layout` / `layoutId`), every descendant with an intrinsic visual appearance will be **visually distorted unless it also participates in projection**. This is the single most counterintuitive rule of Motion's FLIP.

### Why scaling a parent distorts children

Consider:

```tsx
<motion.div
  layoutId="card"
  style={{ borderRadius: 16, width: isOpen ? 400 : 200, height: isOpen ? 300 : 100 }}
>
  <h2>Title</h2>
  <p>Body content</p>
</motion.div>;
```

When the card animates open, FLIP drives `transform: scale(Sx, Sy)` on the outer `motion.div` from (1, 1) at the new size toward the ratio that visually matches the old size. **CSS transforms apply to the entire subtree**. So during the animation:

- `<h2>` is visually scaled Sx horizontally and Sy vertically.
- `<p>` is also scaled.
- Any text, icon, inner shadow, or bordered element inside is stretched.

The engine has no way to visually correct arbitrary CSS inside children — `border-radius` and `box-shadow` are scale-corrected only for the element whose projection node holds them.

### The fix: children also run `layout`

Adding `layout` to children creates a projection node that **knows the parent is scaling** via `treeScale`:

```tsx
<motion.div layoutId="card" style={{ borderRadius: 16 }}>
  <motion.h2 layout>Title</motion.h2>
  <motion.p layout>Body content</motion.p>
</motion.div>;
```

When the parent's projection is computing its delta, children with `layout` each compute an **inverse transform** that cancels the portion of the parent's scale they would otherwise inherit. In `buildProjectionTransform` (`packages/motion-dom/src/projection/styles/transform.ts`), the key step is:

```
childFinalTransform = invertParentTreeScale * childOwnDelta
```

Where `invertParentTreeScale` is the reciprocal of the accumulated `treeScale` from all projection ancestors. A child with `layout` sets its own delta such that the visible motion is exactly what the layout change calls for, not the scaled-parent distortion.

### What `treeScale` actually holds

`treeScale` is not a per-node recurrence. It is recomputed each pass by `applyTreeDeltas` (`packages/motion-dom/src/projection/geometry/delta-apply.ts`), which resets the accumulator to `1` and then multiplies by each ancestor's `projectionDelta` on the way down the `treePath`:

```
applyTreeDeltas(box, treeScale, treePath):
  treeScale.x = treeScale.y = 1
  for each ancestor with a projectionDelta in treePath:
    treeScale.x *= delta.x.scale
    treeScale.y *= delta.y.scale
    applyBoxDelta(box, delta)
```

A child under a grandparent that scales 2x and a parent that scales 1.5x ends with `treeScale ≈ (3, 3)`. Its compensation in `buildProjectionTransform` applies `scale(1/3, 1/3)` before its own delta, yielding the correct visual size.

### When you need it

- Shared-element transitions where the card expands/shrinks and has visible text, icons, or inner sub-layouts that should keep their true size.
- `layout` on the parent with any "intrinsic-looking" children inside. Intrinsic meaning: elements whose visual properties (font size, icon stroke width, border, shadow) should not change during the parent's scale.

### When you do not need it

- The child is a pure background element (a gradient, a solid color) where distortion is invisible.
- You actually want the distortion — a playful UI effect where text squishes during the animation.
- The child is a `motion.img` where the image itself is the content and visual stretching is acceptable.

### Common oversight

Reviewers frequently miss this for **text inside shared-layout cards**. The text is tiny and the scale is modest, so distortion looks subtle — often mistaken for font rendering differences. Test by pausing the animation mid-frame (DevTools animations panel, `transition.duration: 5`) and comparing character widths to the end state.

### Sub-caveat: `layout` without matching parent

A child with `layout` but no animating parent has a near-zero-cost projection node — it measures on commits, finds no layout change, and produces an identity transform. The cost is one extra entry in the projection tree per child. Fine for dozens of children, wasteful for thousands. For very wide layout-animated subtrees, consider `layoutRoot` on the immediate parent to scope the measurement work.

## `layout` prop values

The `layout` prop accepts:

- `true` — animate both translation and size (`animationType: "both"` on the projection options). This is the broadest option and what most code wants.
- `'position'` — animate translation only. Width/height changes do **not** animate; the element snaps to the new size but slides into place.
- `'size'` — animate size only. Translation does not animate.
- `'preserve-aspect'` — maintain aspect ratio during the animation.

`true` and `'position'` are **not** equivalent. `layout={true}` animates size changes, `layout="position"` does not. The distinction lives in `use-visual-element.ts` where `animationType = typeof layout === "string" ? layout : "both"`.

`layoutRoot` (boolean) marks the element as a projection root for scroll tracking. Necessary when the element owns a scrollable region whose children participate in layout animation; otherwise scroll offset is not accounted for and elements appear offset.

`layoutScroll` (boolean) is the shortcut variant of `layoutRoot` for simple scroll containers.

`layoutDependency` (any) forces a new measurement on change, even if the DOM did not change. Use when layout depends on non-React state (window resize captured by an outer hook, for example).

## `AnimatePresence`: exit animations and the deferred-unmount protocol

`AnimatePresence` is not a simple "wrap children to get exit animations" helper. It is a React context provider that implements a deferred-unmount protocol so the projection system (and the renderer in general) can run animations on elements React would otherwise unmount immediately. Understanding its internals is essential for debugging exit animation bugs and shared-layout transitions.

Source: `packages/framer-motion/src/components/AnimatePresence/index.tsx` and the sibling `PresenceChild.tsx`, `use-presence.ts`.

### The core pieces

```
AnimatePresence (component)
  ├── children diffed across renders
  ├── tracks presentChildren, exiting set, exitComplete map
  └── wraps each child in <PresenceChild>
        │
        └── PresenceChild (component)
              ├── provides PresenceContext to descendants
              ├── exposes isPresent + safeToRemove via context
              └── defers React unmount until exit animations finish
```

### `PresenceChild` and the `PresenceContext`

Every direct child rendered inside `AnimatePresence` is wrapped in a `PresenceChild`, which provides a context matching `PresenceContextProps` (`packages/motion-dom/src/render/types.ts`):

```ts
interface PresenceContextProps {
  id: string;
  isPresent: boolean; // true while present or entering; false during exit
  register: (id: string | number) => () => void; // register a presence consumer; returns deregister
  onExitComplete?: (id: string | number) => void; // consumers call this when their exit finishes
  custom?: any; // custom variant resolution value
  initial?: false | VariantLabels;
}
```

Every `motion.*` component descendant reads this context via `usePresence()`. Its return type is a discriminated tuple:

```ts
// Outside AnimatePresence (no context)
// → [true, null]
//
// Inside AnimatePresence, element is still present
// → [true]
//
// Inside AnimatePresence, element is exiting
// → [false, safeToRemove]
function usePresence(subscribe?: boolean):
  | [true, null] // AlwaysPresent (no AP context)
  | [true] // Present (AP + still present)
  | [false, () => void]; // NotPresent (AP + exiting)
```

Consumers that only need the boolean:

```ts
function useIsPresent(): boolean;
```

### The deferred-unmount protocol, step by step

1. **Render N** — parent renders `<AnimatePresence>{condition && <motion.div key="x" />}</AnimatePresence>`. `AnimatePresence` sees the child, wraps in `PresenceChild` with `isPresent: true`.
2. **Render N+1 with `condition === false`** — parent no longer includes the child. Normally React would unmount it immediately.
3. **`AnimatePresence` intervenes**. It diffs the child list, detects `key="x"` is absent. Instead of letting React unmount, it:
   - Keeps rendering the exiting child for now.
   - Switches the child's `PresenceChild` to `isPresent: false`.
   - Adds `"x"` to the internal `exitComplete` map with value `false`.
4. **The exiting child's `motion.*` component observes `isPresent` flip to false**. Its `animationState` starts the `exit` animation. When the animation finishes, `onAnimationComplete` fires, which calls `safeToRemove()` from context.
5. **`safeToRemove` marks `exitComplete["x"] = true`**. `AnimatePresence` checks whether all exiting children have completed.
6. **When every exit is complete**, `AnimatePresence` removes the child from its rendered output. React now unmounts normally, triggering `projection.unmount()`, ref cleanup, and everything else.

This is why the exit animation works even though the conditional went to false: the child is still rendered (inside `AnimatePresence`) until it opts out via `safeToRemove`.

### The three `mode` values — full semantics

| Mode             | What the diff produces                                                                                                                                                                | Timing                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `sync` (default) | On render N+1 we render both new (entering) and old (exiting) children together.                                                                                                      | Enter and exit run concurrently.                     |
| `wait`           | On render N+1 we render only the exiting children. Entering children are queued until all exits complete.                                                                             | Exit first, then enter.                              |
| `popLayout`      | Like `sync`, but the exiting children get `position: absolute` (via a wrapping `PopChild`) so they are taken out of layout flow. Entering children are placed in the now-freed space. | Concurrent visually, but layout reflows immediately. |

Internal mechanics:

- `sync` is the baseline — `AnimatePresence` renders `[...exiting, ...entering]` in diff-preserving order, each wrapped in `PresenceChild`.
- `wait` checks if `exitComplete` has any outstanding entries; if so, skips rendering new entering children this pass. When all exits finish, a React re-render includes the entering children.
- `popLayout` wraps each exiting child in a `<PopChild>` that, on first render, measures the child's bounding box and uses `useInsertionEffect` to inject a stylesheet rule keyed by `data-motion-pop-id`. That rule applies `position: absolute !important` plus the captured `width`, `height`, `top`, `left` to the exiting element itself (not to an extra wrapper div). The element keeps its visual bounds while being taken out of layout flow so siblings reflow immediately. Source: `packages/framer-motion/src/components/AnimatePresence/PopChild.tsx`.

`popLayout` + `layout` interaction (important):

- Siblings with `layout` run their FLIP immediately when the exiting element leaves flow.
- The exiting element itself is now absolutely positioned at its captured bounds. Its own `exit` prop should not animate layout-like properties (`width`, `height`, `top`, `left`); those would fight the pinned position. Use `opacity`, `scale`, `rotate`, or transform-backed `x` / `y`, all of which sit cleanly on top of the absolute positioning.

### `initial={false}` on `AnimatePresence`

Passed down through `PresenceContext`. When `true`, the first mount of children runs their `initial` animations; when `false`, children are rendered at their `animate` state immediately, no initial animation.

Use `initial={false}` for:

- State that is hydrated from storage (e.g. a modal that was open before navigation).
- SSR content that was already visible on the server render.
- Lists where initial mount-in would cause a distracting cascade.

### `custom` prop and variant resolution

```tsx
<AnimatePresence custom={direction}>
  {/* ... */}
</AnimatePresence>;
```

`custom` is passed through `PresenceContext` and reaches any child using dynamic variants:

```tsx
const variants = {
  enter: (direction: 1 | -1) => ({ x: direction * 100 }),
  exit: (direction: 1 | -1) => ({ x: direction * -100 }),
};
```

Because the `direction` may flip between when the child mounts and when it exits, `AnimatePresence` snapshots `custom` at exit time so the exit variant resolves correctly — you do not need to manually stash the value.

### `mode="wait"` with one child at a time — why the rule is strict

`wait` enforces "exactly one child". If two children with different keys are rendered inside `wait` on the same pass, sequencing breaks because:

- `AnimatePresence` cannot decide which should exit first.
- The queue of "entering after exit" assumes a single pending entry; two pending entries race.

Motion logs a console warning. The behavior is undefined (may animate the wrong child, may skip entries), so the warning is treated as a must-fix.

### `safeToRemove` in custom hooks

Advanced code sometimes needs to control when `safeToRemove` fires — for example, when exit animation is not a standard `motion.*` prop, but a manual `animate()` call. `usePresence` returns it:

```tsx
function Lightbox() {
  const [isPresent, safeToRemove] = usePresence();

  useEffect(() => {
    if (!isPresent && safeToRemove) {
      const ctrl = animate(".overlay", { opacity: 0 }, { duration: 0.3 });
      ctrl.finished.then(safeToRemove);
    }
  }, [isPresent, safeToRemove]);

  return <div className="overlay" />;
}
```

Without calling `safeToRemove`, the child would stay rendered forever after the parent set its condition to false. Calling `safeToRemove` too early aborts the exit animation.

### Interaction with `layoutId` / `NodeStack`

When an exiting child is the current `lead` of a `NodeStack`:

1. `isPresent` flips to false — the exit animation starts.
2. If a new child with the same `layoutId` mounts in the same commit, its `promote()` makes it the new lead. The exiting child becomes `prevLead`.
3. The exiting child finishes its exit animation and calls `safeToRemove`.
4. `AnimatePresence` removes the child from render, triggering `projection.unmount`.
5. `projection.unmount` runs `relegate` on the stack. Since the new child is already lead, this is a no-op.

When no successor exists:

1. `isPresent` flips to false; exit animation runs.
2. `relegate` finds no candidate; stack goes dormant during exit.
3. `safeToRemove` fires; React unmounts; stack may end up empty.

This is why you sometimes see a correct exit animation even when the stack has only the exiting member — `relegate` simply did not find a replacement, and that is an acceptable outcome.

### Pitfalls specific to `AnimatePresence`

- **Parent unmount during exit**. If the `AnimatePresence` itself is unmounted (e.g. its own parent conditionally rendered it away), all `PresenceChild`s are destroyed and exit animations are cancelled. This is the `AnimatePresence inside a conditional` anti-pattern. Move the presence above the conditional.
- **Multiple `AnimatePresence` for one logical list**. Two adjacent `AnimatePresence`s each maintain independent exit-complete maps. Shared-layout transitions across them work (because `sharedNodes` is global) but mode coordination does not — `wait` in one does not wait for the other.
- **Keys that collide across renders due to reuse**. If `key="item-1"` is removed and immediately re-added in the same commit with the same key but different semantic identity, React sees an update, not an unmount+mount. Exit animation does not run. Use IDs that are actually unique across the lifetime of the conceptual entity.
- **`onExitComplete` callback timing**. `AnimatePresence`'s `onExitComplete` fires after **all** pending exits complete, not per-child. For per-child timing use `motion.*`'s `onAnimationComplete` on the exiting element.

## Debug checklist

When a layout animation "looks wrong":

1. Is `borderRadius` / `boxShadow` in `style`? If not and the element has `layout` or `layoutId`, corners/shadows will deform.
2. Is the element `display: inline` or a bare SVG child? Projection requires a box model. Promote to `inline-block` / `block` or wrap.
3. Does `layoutId` clash with another subtree? Wrap each subtree in a scoped `LayoutGroup`.
4. Is the exiting element fighting `popLayout`? Use opacity-only exit.
5. Is a hidden lead occupying space? Wrap with `AnimatePresence` to trigger `safeToRemove`.
6. Is the layout change triggered by external state that Motion does not see? Pass that state via `layoutDependency`.
7. Are you trying to animate between two radically different layouts (e.g. grid → list)? `preserve-aspect` helps; sometimes splitting into two elements with shared `layoutId` is cleaner.

## Reference points

- `packages/motion-dom/src/projection/node/create-projection-node.ts` — node factory, lifecycle (`willUpdate` ~649, snapshot/measure ~876–1021, `notifyLayoutUpdate` ~2121–2258, `setAnimationOrigin` ~1583–1680, `startAnimation` ~1683–1734).
- `packages/motion-dom/src/projection/node/DocumentProjectionNode.ts` — root node config.
- `packages/motion-dom/src/projection/node/group.ts` — `nodeGroup` for dirty propagation.
- `packages/motion-dom/src/projection/shared/stack.ts` — `NodeStack`, `promote`, `relegate`.
- `packages/motion-dom/src/projection/geometry/delta-calc.ts` — `calcBoxDelta`, `calcAxisDelta`.
- `packages/motion-dom/src/projection/styles/transform.ts` — `buildProjectionTransform`.
- `packages/motion-dom/src/projection/styles/scale-correction.ts`, `scale-border-radius.ts`, `scale-box-shadow.ts` — scale correctors.
- `packages/motion-dom/src/render/html/utils/scrape-motion-values.ts` — the `style`-only iteration.
- `packages/motion-dom/src/render/utils/is-forced-motion-value.ts` — forced value rule for `scaleCorrectors` + `opacity`.
- `packages/framer-motion/src/components/LayoutGroup/index.tsx` — React wrapper.
- `packages/framer-motion/src/motion/index.tsx` — `useLayoutId` prefix combination.
- `packages/framer-motion/src/components/AnimatePresence/index.tsx` — exit / `forceRender` integration.
