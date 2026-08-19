# Skills

Reusable agent skills distilled from real engineering failures and verified interaction patterns.
The catalog favors narrow, non-obvious rules that materially change an agent's implementation or
review decisions.

Each skill is self-contained under `skills/<name>/` and follows the Agent Skills `SKILL.md` format.

## Install

Install one skill globally:

```sh
npx skills add lennondotw/skills@pointer-drag-release -g -y
```

List the catalog before installing:

```sh
npx skills add lennondotw/skills --list
```

## Featured Skill

### `pointer-drag-release`

Build resize and drag interactions that do not stay stuck to the pointer when a release event goes
missing. The skill distinguishes normal completion from cancellation and covers pointer capture,
`buttons === 0` recovery, `lostpointercapture`, and multi-pointer ownership.

## Catalog

| Skill                           | Focus                                                             |
| ------------------------------- | ----------------------------------------------------------------- |
| `backdrop-filter-rounded-clip`  | Split tint and blur layers to avoid rounded glass edge artifacts. |
| `component-sizing-strategy`     | Separate intrinsic component size from container-owned layout.    |
| `fade-glass-by-strength`        | Animate glass strength without dirty partial-opacity blur.        |
| `focus-outline-shape`           | Make focus rings follow the intended control geometry.            |
| `hover-action-focus-navigation` | Reconcile hover-revealed actions with keyboard focus.             |
| `icon-opacity-on-layer`         | Fade an icon layer without darkening intersecting strokes.        |
| `immutable-dialog-lifecycle`    | Preserve dialog identity through exit animations.                 |
| `intent-derived-ui-state`       | Store durable intent and derive context-dependent UI state.       |
| `intersection-sentinel-band`    | Give infinite-scroll look-ahead a real geometric extent.          |
| `keep-elements-in-flow`         | Prefer resilient flow layout over coordinate-driven positioning.  |
| `motion-flip-drift`             | Diagnose Motion layout projection drift and resize artifacts.     |
| `nested-corner-geometry`        | Keep nested rounded corners geometrically concentric.             |
| `pointer-drag-release`          | End pointer drags even when the release event never arrives.      |
| `preserve-backdrop-filter`      | Prevent animated ancestors from breaking backdrop sampling.       |
| `reserve-line-height`           | Reserve one line without layout shift when content appears.       |
| `seamless-hit-target`           | Expand hit targets without changing visible or focus geometry.    |
| `stable-width-button`           | Reserve dynamic label width to prevent button jitter.             |
| `zero-height-side-element`      | Add side content without increasing a row's block size.           |

## Evaluation

Repository-owned evaluations live under `evals/<skill-name>/`, outside installable skill folders.
`pointer-drag-release` is the initial behavioral-evaluation pilot; the remaining skills currently
receive structural, metadata, formatting, and public-content validation in CI.

When a behavioral regression is found, add a failing eval before changing the skill. Do not require
the no-skill baseline to fail: base models improve, while the skill's behavioral contract should
remain stable.

## Development

```sh
pnpm install
pnpm check
```

## License

MIT
