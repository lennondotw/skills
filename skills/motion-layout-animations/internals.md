# Motion Layout Animation Internals

Deep code references for Motion's layout animation system.

> **Version**: `v12.38.0`\
> **Commit**: [`5b837e31`](https://github.com/motiondivision/motion/commit/5b837e31ce7b2592de6b2bcd55dbc9d2156842c2)\
> **Repository**: [motiondivision/motion](https://github.com/motiondivision/motion)

## NodeStack Implementation

**File**: `packages/motion-dom/src/projection/shared/stack.ts`

### Data Structure

```ts
class NodeStack {
  lead?: IProjectionNode; // Current active element
  prevLead?: IProjectionNode; // Previous lead (for snapshot inheritance)
  members: IProjectionNode[] = [];
}
```

### promote() - New Element Becomes Lead

```ts:45-74
promote(node: IProjectionNode, preserveFollowOpacity?: boolean) {
    const prevLead = this.lead
    if (node === prevLead) return

    this.prevLead = prevLead
    this.lead = node
    node.show()

    if (prevLead) {
        prevLead.updateSnapshot()
        node.scheduleRender()

        const { layoutDependency: prevDep } = prevLead.options
        const { layoutDependency: nextDep } = node.options

        if (prevDep === undefined || prevDep !== nextDep) {
            node.resumeFrom = prevLead
            if (preserveFollowOpacity) prevLead.preserveOpacity = true

            // KEY: Snapshot inheritance
            if (prevLead.snapshot) {
                node.snapshot = prevLead.snapshot
                node.snapshot.latestValues =
                    prevLead.animationValues || prevLead.latestValues
            }

            if (node.root?.isUpdating) node.isLayoutDirty = true
        }
        if (node.options.crossfade === false) prevLead.hide()
    }
}
```

**Flow**:

1. Store current lead as `prevLead`
2. Set new node as `lead`, call `show()`
3. If `prevLead` exists:
   - Take snapshot of prevLead's current state
   - Copy snapshot to new lead
   - Set `resumeFrom = prevLead` for animation
   - Hide prevLead if no crossfade

### relegate() - Lead Exits, Find Replacement

```ts:34-43
relegate(node: IProjectionNode) {
    for (let i = this.members.indexOf(node) - 1; i >= 0; i--) {
        const member = this.members[i]
        if (member.isPresent !== false &&
            (member.instance as HTMLElement)?.isConnected !== false) {
            this.promote(member)
            return true
        }
    }
    return false
}
```

**Flow**:

1. Start from node's index - 1, iterate backwards
2. Find first member that is still present and connected
3. Promote that member as new lead
4. Return `false` if no suitable replacement found

### remove() - Element Unmounts

```ts:25-32
remove(node: IProjectionNode) {
    removeItem(this.members, node)
    if (node === this.prevLead) this.prevLead = undefined
    if (node === this.lead) {
        const prevLead = this.members[this.members.length - 1]
        if (prevLead) this.promote(prevLead)
    }
}
```

---

## layoutId Registration

**File**: `packages/motion-dom/src/projection/node/create-projection-node.ts`

### Registration Call Site

```ts:484-486
if (layoutId) {
    this.root.registerSharedNode(layoutId, this)
}
```

### registerSharedNode Implementation

```ts:1821-1837
registerSharedNode(layoutId: string, node: IProjectionNode) {
    if (!this.sharedNodes.has(layoutId)) {
        this.sharedNodes.set(layoutId, new NodeStack())
    }

    const stack = this.sharedNodes.get(layoutId)!
    stack.add(node)

    const config = node.options.initialPromotionConfig
    node.promote({
        transition: config ? config.transition : undefined,
        preserveFollowOpacity:
            config && config.shouldPreserveFollowOpacity
                ? config.shouldPreserveFollowOpacity(node)
                : undefined,
    })
}
```

**Key**: After `stack.add(node)`, immediately calls `node.promote()` which triggers `stack.promote(this)`. New element becomes lead instantly.

---

## LayoutGroup Prefix

**File**: `packages/framer-motion/src/components/LayoutGroup/index.tsx`

### Group ID Composition

```ts:36-47
if (context.current === null) {
    if (shouldInheritId(inherit) && upstreamId) {
        id = id ? upstreamId + "-" + id : upstreamId
    }

    context.current = {
        id,
        group: shouldInheritGroup(inherit)
            ? layoutGroupContext.group || nodeGroup()
            : nodeGroup(),
    }
}
```

### layoutId Prefix Application

**File**: `packages/framer-motion/src/motion/index.tsx`

```ts:174-178
function useLayoutId({ layoutId }: MotionProps) {
    const layoutGroupId = useContext(LayoutGroupContext).id
    return layoutGroupId && layoutId !== undefined
        ? layoutGroupId + "-" + layoutId
        : layoutId
}
```

**Result**: `<LayoutGroup id="panel"><motion.div layoutId="card" /></LayoutGroup>` produces actual layoutId `"panel-card"`.

---

## Scale Correction

### scaleCorrectors Definition

**File**: `packages/motion-dom/src/projection/styles/scale-correction.ts`

```ts:6-21
export const scaleCorrectors: ScaleCorrectorMap = {
    borderRadius: {
        ...correctBorderRadius,
        applyTo: [
            "borderTopLeftRadius",
            "borderTopRightRadius",
            "borderBottomLeftRadius",
            "borderBottomRightRadius",
        ],
    },
    borderTopLeftRadius: correctBorderRadius,
    borderTopRightRadius: correctBorderRadius,
    borderBottomLeftRadius: correctBorderRadius,
    borderBottomRightRadius: correctBorderRadius,
    boxShadow: correctBoxShadow,
}
```

### borderRadius Correction Logic

**File**: `packages/motion-dom/src/projection/styles/scale-border-radius.ts`

```ts:10-41
/**
 * We always correct borderRadius as a percentage rather than pixels to reduce paints.
 * For example, if you are projecting a box that is 100px wide with a 10px borderRadius
 * into a box that is 200px wide with a 20px borderRadius, that is actually a 10%
 * borderRadius in both states. If we animate between the two in pixels that will trigger
 * a paint each time. If we animate between the two in percentage we'll avoid a paint.
 */
export const correctBorderRadius: ScaleCorrectorDefinition = {
    correct: (latest, node) => {
        if (!node.target) return latest

        if (typeof latest === "string") {
            if (px.test(latest)) {
                latest = parseFloat(latest)
            } else {
                // Already percentage or other unit
                return latest
            }
        }

        const x = pixelsToPercent(latest, node.target.x)
        const y = pixelsToPercent(latest, node.target.y)

        return `${x}% ${y}%`
    },
}
```

### isForcedMotionValue Check

**File**: `packages/motion-dom/src/render/utils/is-forced-motion-value.ts`

```ts:10-19
export function isForcedMotionValue(
    key: string,
    { layout, layoutId }: MotionNodeOptions
): key is keyof typeof scaleCorrectors {
    return (
        scaleCorrectors[key as keyof typeof scaleCorrectors] !== undefined &&
        (layout !== undefined || layoutId !== undefined)
    )
}
```

### Application in applyProjectionStyles

**File**: `packages/motion-dom/src/projection/node/create-projection-node.ts`

```ts:2055-2090
/**
 * Apply scale correction
 */
for (const key in scaleCorrectors) {
    if (valuesToRender[key] === undefined) continue

    const { correct, applyTo, isCSSVariable } = scaleCorrectors[key]

    /**
     * Only apply scale correction to the value if we have an
     * active projection transform.
     */
    const corrected =
        transform === "none"
            ? valuesToRender[key]
            : correct(valuesToRender[key], lead)

    if (applyTo) {
        for (let i = 0; i < applyTo.length; i++) {
            targetStyle[applyTo[i]] = corrected
        }
    }

    if (isCSSVariable) {
        targetStyle[key] = corrected
    } else {
        targetStyle[camelToDash(key)] = corrected
    }
}
```

---

## Hide/Show Mechanism

**File**: `packages/motion-dom/src/projection/node/create-projection-node.ts`

### Flag Toggle

```ts:1547-1555
isVisible = true
hide() {
    this.isVisible = false
}
show() {
    this.isVisible = true
}
```

### Style Application

```ts:1959-1968
applyProjectionStyles(
    targetStyle: any,
    styleProp?: MotionStyle
) {
    if (!this.instance || this.isSVG) return

    if (!this.isVisible) {
        targetStyle.visibility = "hidden"
        return  // Early return, no other styles applied
    }
    // ... rest of projection styles
}
```

**Note**: Uses `visibility: hidden` which:

- Hides element visually
- Element still occupies layout space
- Does not trigger repaint of hidden content

---

## mixValues: Shared Transition Interpolation

**File**: `packages/motion-dom/src/projection/animation/mix-values.ts`

### What Gets Mixed

```ts:26-99
export function mixValues(
    target: ResolvedValues,
    follow: ResolvedValues,
    lead: ResolvedValues,
    progress: number,
    shouldCrossfadeOpacity: boolean,
    isOnlyMember: boolean
) {
    // Opacity crossfade
    if (shouldCrossfadeOpacity) {
        target.opacity = mixNumber(0, (lead.opacity as number) ?? 1, easeCrossfadeIn(progress))
        target.opacityExit = mixNumber((follow.opacity as number) ?? 1, 0, easeCrossfadeOut(progress))
    } else if (isOnlyMember) {
        target.opacity = mixNumber(
            (follow.opacity as number) ?? 1,
            (lead.opacity as number) ?? 1,
            progress
        )
    }

    // borderRadius (all four corners)
    for (let i = 0; i < numBorders; i++) {
        const borderLabel = borderLabels[i]
        let followRadius = getRadius(follow, borderLabel)
        let leadRadius = getRadius(lead, borderLabel)
        // ... mixing logic
    }

    // rotate
    if (follow.rotate || lead.rotate) {
        target.rotate = mixNumber(
            (follow.rotate as number) || 0,
            (lead.rotate as number) || 0,
            progress
        )
    }
}
```

**Automatically mixed**: `opacity`, `borderRadius` (all corners), `rotate`

**Not automatically mixed**: `backgroundColor`, `backdropFilter`, other visual properties (must use `animate` prop)

---

## Projection Delta Calculation

**File**: `packages/motion-dom/src/projection/geometry/delta-calc.ts`

### calcBoxDelta

```ts
export function calcBoxDelta(
  delta: BoxDelta,
  source: Box,
  target: Box,
  origin: number = 0.5,
): void {
  calcAxisDelta(delta.x, source.x, target.x, origin);
  calcAxisDelta(delta.y, source.y, target.y, origin);
}

function calcAxisDelta(delta: AxisDelta, source: Axis, target: Axis, origin: number): void {
  const sourceLength = source.max - source.min;
  const targetLength = target.max - target.min;

  delta.origin = origin;
  delta.originPoint = mix(source.min, source.max, origin);
  delta.scale = targetLength / sourceLength || 1;
  delta.translate = mix(target.min, target.max, origin) - delta.originPoint;
}
```

**Result**: `{ x: { scale, translate, origin }, y: { scale, translate, origin } }` used to build transform string.

---

## FLIP Animation Lifecycle

### 1. willUpdate (Snapshot)

```ts
willUpdate() {
    this.updateSnapshot()
    // Mark as dirty for projection recalculation
}
```

### 2. didUpdate (Measure & Animate)

```ts
didUpdate() {
    // Measure new layout
    this.updateLayout()

    // Calculate delta between snapshot and new layout
    // Start animation from snapshot position
}
```

### 3. mixTargetDelta (Per-Frame)

```ts
mixTargetDelta(progress: number) {
    // Interpolate between snapshot box and target box
    // Apply mixValues for visual properties
    // Schedule render
}
```

### 4. completeAnimation (Cleanup)

```ts
completeAnimation() {
    this.resumingFrom = undefined
    this.currentAnimation = undefined
    this.animationValues = undefined
    // Call onExitComplete if in stack
}
```

---

## Relevant Source Files

| File                                                         | Purpose                               |
| ------------------------------------------------------------ | ------------------------------------- |
| `motion-dom/src/projection/node/create-projection-node.ts`   | Core ProjectionNode implementation    |
| `motion-dom/src/projection/shared/stack.ts`                  | NodeStack for shared layoutId         |
| `motion-dom/src/projection/animation/mix-values.ts`          | Value interpolation during transition |
| `motion-dom/src/projection/styles/scale-border-radius.ts`    | borderRadius scale correction         |
| `motion-dom/src/projection/styles/scale-box-shadow.ts`       | boxShadow scale correction            |
| `motion-dom/src/projection/geometry/delta-calc.ts`           | FLIP delta calculation                |
| `framer-motion/src/components/LayoutGroup/index.tsx`         | LayoutGroup context provider          |
| `framer-motion/src/motion/index.tsx`                         | useLayoutId hook                      |
| `framer-motion/src/motion/features/layout/MeasureLayout.tsx` | React lifecycle integration           |
