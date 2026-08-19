# Spring Physics and Inertia

Deep reference on Motion's spring and inertia generators, the underlying physics, and the two mutually exclusive parameter APIs. Load this when writing spring transitions, reviewing drag end behavior, or debugging "feels bouncy in the wrong way".

## Spring as a second-order ODE

A damped harmonic oscillator:

```
m * x''(t) + c * x'(t) + k * x(t) = 0
```

Where `x(t)` is displacement from target (so as `t → ∞`, `x → 0`). Parameters:

- `m` — **mass**. Higher mass = more inertia.
- `c` — **damping coefficient** (the viscous friction).
- `k` — **stiffness**. Higher stiffness = faster return to target.

Two derived quantities drive the closed-form solution:

```
ω_n = sqrt(k / m)       # undamped natural angular frequency
ζ   = c / (2 * sqrt(m*k))  # damping ratio
```

`ζ` classifies the system:

- `ζ < 1` — **underdamped**. Oscillates with decaying amplitude.
- `ζ = 1` — **critically damped**. Fastest return without oscillation.
- `ζ > 1` — **overdamped**. Slow return, no oscillation.

The damped natural frequency (relevant only when `ζ < 1`):

```
ω_d = ω_n * sqrt(1 - ζ²)
```

## Motion's closed-form implementation

`packages/motion-dom/src/animation/generators/spring.ts` implements all three regimes as separate branches, not numerical integration. This is faster and more accurate for long-duration springs.

### Underdamped (`ζ < 1`)

Position:

```
x(t) = exp(-ζ * ω_n * t) * (A * sin(ω_d * t) + B * cos(ω_d * t))
```

With initial conditions `x(0) = x₀` and `x'(0) = v₀`:

```
B = x₀
A = (v₀ + ζ * ω_n * x₀) / ω_d
```

Final displayed value: `target + x(t)` (or `from + (target - from - x(t))` depending on sign convention in the code).

### Critically damped (`ζ = 1`)

```
x(t) = (C + D * t) * exp(-ω_n * t)
```

Small-value animations trigger tighter `restDelta` / `restSpeed` via the `isGranularScale` check (around lines 274–280 of `spring.ts`). The check is `|initialDelta| < 5` — based on the size of the animation's value range, not on the damping ratio.

### Overdamped (`ζ > 1`)

Uses `sinh` / `cosh` or an equivalent two-exponential form:

```
x(t) = A * exp(-ω_+ * t) + B * exp(-ω_- * t)
```

Where `ω_± = ζω_n ± ω_n * sqrt(ζ² - 1)`.

## Rest conditions

The animation does not integrate forever. It completes when **both**:

- `|v(t)| < restSpeed`
- `|x(t)| < restDelta`

Defaults (from `springDefaults` in `spring.ts`):

- `restSpeed.default`: 2 units/sec.
- `restSpeed.granular`: 0.01 units/sec.
- `restDelta.default`: 0.5.
- `restDelta.granular`: 0.005.

The `isGranularScale` branch switches to the granular thresholds when `|initialDelta| < 5` — i.e. small-value animations like opacity 0→1 or scale 0.98→1. Without this switch, the default `restDelta: 0.5` would snap a 0→1 animation to rest almost immediately; with it, tiny animations settle visually correctly while large pixel animations keep the looser threshold and finish faster.

Overriding can be necessary when:

- Animating an integer target where any sub-pixel residue is visible — tighten `restDelta`.
- Animating a very long travel where even `0.5` looks prematurely done — loosen `restDelta`.
- Debugging a spring that terminates too early on an unusual value range.

## Two input APIs, mutually exclusive

Motion supports two ways to describe a spring. They map to the same underlying math but come from different mental models.

### Physical API: `stiffness`, `damping`, `mass`

Direct ODE parameters. The code path is straightforward:

```
ω_n = sqrt(stiffness / mass)
ζ   = damping / (2 * sqrt(mass * stiffness))
```

Defaults: `stiffness: 100`, `damping: 10`, `mass: 1`. That gives `ζ ≈ 0.5`, moderately bouncy.

Use when:

- You want explicit control over physics.
- You need velocity hand-off (see below).
- You have a design system with canonical spring tokens.

### Perceptual API: two variants

There are **two** perceptual paths in `getSpringOptions`, and they use different math. Reading `spring.ts` around lines 171–218:

**Variant A — `visualDuration` + `bounce`** (closed-form, no iteration):

```
const root      = (2 * Math.PI) / (visualDuration * 1.2);
const stiffness = root * root;
const damping   = 2 * clamp(0.05, 1, 1 - (bounce ?? 0)) * Math.sqrt(stiffness);
```

Motion derives `stiffness` and `damping` directly from `visualDuration` via a fixed factor, then scales damping by `(1 - bounce)`. No Newton iteration is involved.

**Variant B — `duration` + `bounce`** (numerical, via `findSpring`):

```
findSpring({ ...options, velocity: 0 })
  // approximateRoot (Newton's method) finds ω_n such that the envelope
  // exp(-ζ ω_n t) reaches a perceptual threshold at t = duration.
```

Only this path calls `approximateRoot`. The `findSpring` algorithm is a Framer-ported implementation (see comment around lines 67–69 of `spring.ts`).

**`durationKeys` is `['duration', 'bounce']`** — it does not include `visualDuration`. The switch between variants is:

```
if (!hasPhysics(options) && hasDurationOrBounce(options)) {
  if (options.visualDuration) {
    // variant A — closed-form
  } else {
    // variant B — findSpring / Newton
  }
}
```

### Bounce mapping

In variant A the damping coefficient includes `(1 - bounce)` directly (clamped to `[0.05, 1]`). So:

- `bounce: 0` → damping multiplier 1 → critically damped, no overshoot.
- `bounce: 0.5` → damping multiplier 0.5 → gentle bounce.
- `bounce: 1` → damping multiplier 0.05 (clamped) → heavy oscillation.

The common shorthand `ζ ≈ 1 - bounce` captures this within the normal range, but the clamp at `0.05` prevents a literal zero-damping spring.

### How the two API families interact

**They do not blend.** The physical keys (`stiffness`, `damping`, `mass`) take precedence over perceptual keys. The check in `getSpringOptions` (around lines 180–184 of `spring.ts`):

```
// physicsKeys = ['stiffness', 'damping', 'mass']
// durationKeys = ['duration', 'bounce']
if (!isSpringType(options, physicsKeys) && isSpringType(options, durationKeys)) {
  // go into perceptual path
}
// else: physical wins, perceptual keys ignored
```

Reviewers should flag any transition with both sets:

```ts
// Ambiguous — physical silently wins, bounce is ignored.
transition: { type: 'spring', stiffness: 200, duration: 0.3, bounce: 0.2 }
```

Pick one. Recommended modern form:

```ts
transition: { type: 'spring', visualDuration: 0.4, bounce: 0.25 }
```

## Velocity and interruption

When a running spring is interrupted (`animate` called again on the same value), the new spring must handle:

- The current position (not the original `from`).
- The current velocity (not zero).

### Physical API: velocity is carried over

The physical path reads `motionValue.getVelocity()` at the start of the new animation and uses it as `v₀`. The result: interruption looks natural — a spring being redirected mid-flight accelerates smoothly toward the new target without resetting.

### Perceptual API: initial velocity is zeroed

Both perceptual variants zero the initial velocity before deriving spring parameters. From `getSpringOptions` (around line 185 of `spring.ts`):

```
// Time-defined springs should ignore inherited velocity.
springOptions.velocity = 0;
```

This is intentional: the duration estimate is derived assuming the motion starts from rest. Using a non-zero velocity would make `visualDuration` or `duration` a lie.

The practical effect: interrupting a perceptual spring with another perceptual spring causes a small but visible velocity discontinuity. For UI animations this is usually invisible; for high-motion affordances (drag snap, scroll snap) it can be jarring.

**Rule**: if you need velocity continuity through interruptions, use the physical API.

## `duration` vs `visualDuration`

Older docs and some examples still use `duration` inside spring transitions. Differences:

- `duration` — total animation time including settling. The spring may continue oscillating near zero for a significant fraction of this.
- `visualDuration` — time until the oscillation envelope is perceptually flat. The actual math runs longer but the motion "looks done".

Prefer `visualDuration` for all new code. It matches designer intuition. `duration` remains for backward compatibility.

## Bounce vs dampingRatio

The relationship:

```
bounce = 1 - ζ     # approximately, within the valid range
```

- `bounce: 0` → `ζ = 1`, critically damped. No overshoot. Fastest monotonic settle.
- `bounce: 0.5` → `ζ = 0.5`, gentle bounce (3–4 visible oscillations).
- `bounce: 1` → `ζ ≈ 0`, near-undamped. Many oscillations, bad for UI.

Typical design system tokens:

- Transient feedback (button press, hover): `bounce: 0.1–0.2`.
- Content enter / exit: `bounce: 0.2–0.3`.
- Playful / branded animations: `bounce: 0.4–0.6`.
- Physics-reference (dropped ball, deformation): `bounce: 0.6–0.8`.

## `inertia` and `decay`

The `inertia` generator (`packages/motion-dom/src/animation/generators/inertia.ts`) is not a spring. It models exponential friction decay via a moving asymptote:

```
amplitude = power * velocity
idealTarget = origin + amplitude
target      = modifyTarget ? modifyTarget(idealTarget) : idealTarget
// If modifyTarget changed the target, recompute amplitude so the curve lands on it:
if (target !== idealTarget) amplitude = target - origin

latest(t) = target - amplitude * exp(-t / timeConstant)
delta(t)  = -amplitude * exp(-t / timeConstant)
```

So `latest(0) = target - amplitude = origin`, and `latest(∞) = target`. The curve approaches `target` exponentially.

Parameters (from `spring.ts` defaults):

- `velocity` — initial velocity. Usually derived from `MotionValue.getVelocity()`. Default `0`.
- `power` — multiplier on velocity. Higher = travels further. Default `0.8`.
- `timeConstant` — decay `τ` in ms. Default **`325`**.
- `modifyTarget` — function to snap the natural target to a grid / discrete value.
- `min`, `max` — bounds. When crossed, inertia switches to a spring hand-off.
- `bounceStiffness`, `bounceDamping` — physical spring params for the hand-off phase. Beyond bounds, `restDelta` is relaxed so the spring can settle against the constraint.

### Two-phase animation

1. **Friction phase**: the exponential decay above, terminating when `|delta(t)| <= restDelta` (i.e. the gap to the target is within the rest threshold). The `restDelta` used here is inherited from the caller (often `springDefaults.restDelta`).
2. **Spring phase** (on boundary cross, if `min` / `max` are set): hands off to a physical spring using `bounceStiffness` / `bounceDamping` with the current position and velocity. This produces the "bounce against constraint" feel of rubber-banded drag.

`replace-transition-type.ts` aliases `decay` → `inertia`, so `type: 'decay'` is a historical synonym.

### When inertia is correct

- **Drag release with momentum**. Default for `drag`. `type: 'spring'` loses the asymmetric friction-then-bounce feel.
- **Scroll snap to a grid**. Pair with `modifyTarget: (t) => Math.round(t / 80) * 80`.
- **Fling-to-dismiss** with `min: -Infinity, max: Infinity` so no spring hand-off occurs.

## Keyframes generator

`packages/motion-dom/src/animation/generators/keyframes.ts` handles `type: 'keyframes'` and the default tween with `keyframes` arrays.

Key facts:

- `times` array (optional) specifies when each keyframe occurs as a fraction of `duration`. If omitted, keyframes distribute evenly except when `duration` suggests a bias (0 and 1 are always first and last).
- `ease` can be a single function or an array of length `keyframes.length - 1`. An array applies a different ease to each segment.
- Internally, `interpolate(absoluteTimes, keyframeValues, { ease })` builds a single function sampled each frame.
- `done` when `t >= duration`.

This is the standard tween path. Unlike spring/inertia, it has a fixed `duration`.

## Easing functions

Motion ships a complete easing library in `packages/motion-utils/src/easing/`. All are available as strings (`'easeIn'`, `'backOut'`, etc.) or as direct imports.

| Easing                           | Behavior                                                         |
| -------------------------------- | ---------------------------------------------------------------- |
| `linear`                         | `t` — constant velocity.                                         |
| `easeIn`, `easeOut`, `easeInOut` | Standard CSS cubic-bezier equivalents.                           |
| `circIn`, `circOut`, `circInOut` | `1 - sin(acos(p))` — strong late acceleration.                   |
| `backIn`, `backOut`, `backInOut` | Overshoot via a cubic-bezier with control points outside [0, 1]. |
| `anticipate`                     | Small reverse before forward motion. Good for attention.         |
| `cubicBezier(x1, y1, x2, y2)`    | Arbitrary cubic bezier (Newton's method for inversion).          |
| `steps(n, direction)`            | CSS `steps()` equivalent — quantize to n frames.                 |

Modifiers:

- `reverseEasing(easing)` — reverse in time.
- `mirrorEasing(easing)` — apply forward in first half, reverse in second half.

### Custom easing

Any function `(progress: number) => number` works. Must map `[0, 1]` to a value (typically `[0, 1]`, but overshoot is allowed). Keep it pure; Motion calls it many times per second.

### WAAPI easing limitation

When an animation is offloaded to WAAPI (see animation-engine.md), easing must be expressible in CSS. The mapping (`packages/motion-dom/src/animation/waapi/easing/map-easing.ts`):

- String name (`'easeOut'`) → CSS name.
- Cubic-bezier array → `cubic-bezier(...)` string.
- Custom function → sampled into `linear(...)` (supported in Chromium 113+). Falls back to `'ease-out'` if the browser lacks `linear()` support.

If you write a complex custom easing expecting GPU acceleration, verify it sampled correctly — a fallback to `ease-out` can make the animation feel different.

## Decision tree for picking a transition type

```
Is the animation "continuous"? (redirectable mid-flight, user-driven)
├── Yes → type: 'spring' (physical API, for velocity hand-off)
└── No  → Is the duration critical to the design?
         ├── Yes → type: 'tween' with duration + ease
         └── No  → type: 'spring' (perceptual API: visualDuration + bounce)

Is this drag / fling release?
└── type: 'inertia' (default; do not override unless you know why)

Is this a timeline with multiple keyframes?
└── type: 'keyframes' (explicit; or implicit when keyframes array has >2 values)
```

## Reference points

- Spring: `packages/motion-dom/src/animation/generators/spring.ts` (underdamped ~300–308, critical ~323–327, overdamped ~336–374, `findSpring` ~55–64, `getSpringOptions` ~171–218).
- Inertia: `packages/motion-dom/src/animation/generators/inertia.ts` (friction ~49–50, spring hand-off ~69–82).
- Keyframes: `packages/motion-dom/src/animation/generators/keyframes.ts` (~24–72).
- Transition type aliases: `packages/motion-dom/src/animation/utils/replace-transition-type.ts`.
- Easings: `packages/motion-utils/src/easing/*.ts`.
- WAAPI easing mapping: `packages/motion-dom/src/animation/waapi/easing/map-easing.ts`, `utils/linear.ts`, `utils/unsupported-easing.ts`.
