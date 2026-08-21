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

| Skill                            | Focus                                                                  |
| -------------------------------- | ---------------------------------------------------------------------- |
| `avoid-layout-magic-numbers`     | Replace unexplained fixed dimensions with explicit layout contracts.   |
| `backdrop-filter-rounded-clip`   | Split tint and blur layers to avoid rounded glass edge artifacts.      |
| `boundary-driven-defense`        | Parse at system boundaries and trust validated internal types.         |
| `check-domain-availability`      | Check domain availability directly through authoritative RDAP data.    |
| `component-sizing-strategy`      | Separate intrinsic component size from container-owned layout.         |
| `css-border-stroke-strategy`     | Choose CSS stroke techniques with explicit layout trade-offs.          |
| `expanded-touch-target`          | Expand compact controls without changing their visible footprint.      |
| `fade-glass-by-strength`         | Animate glass strength without dirty partial-opacity blur.             |
| `figma-browser-visual-compare`   | Compare measured Figma references with real browser rendering.         |
| `flex-default-containers`        | Account for wrapper and typography defaults in flex layouts.           |
| `focus-outline-shape`            | Make focus rings follow the intended control geometry.                 |
| `hover-action-focus-navigation`  | Reconcile hover-revealed actions with keyboard focus.                  |
| `icon-opacity-on-layer`          | Fade an icon layer without darkening intersecting strokes.             |
| `immutable-dialog-lifecycle`     | Preserve dialog identity through exit animations.                      |
| `intent-derived-ui-state`        | Store durable intent and derive context-dependent UI state.            |
| `intersection-sentinel-band`     | Give infinite-scroll look-ahead a real geometric extent.               |
| `keep-elements-in-flow`          | Prefer resilient flow layout over coordinate-driven positioning.       |
| `layout-measurement-strategy`    | Measure intrinsic browser layout in its real rendering context.        |
| `motion-expert`                  | Design and debug Motion animations across its complete engine.         |
| `motion-flip-drift`              | Diagnose Motion layout projection drift and resize artifacts.          |
| `motion-layout-animations`       | Understand and debug Motion layout and shared-element projection.      |
| `nested-corner-geometry`         | Keep nested rounded corners geometrically concentric.                  |
| `pointer-drag-release`           | End pointer drags even when the release event never arrives.           |
| `preserve-backdrop-filter`       | Prevent animated ancestors from breaking backdrop sampling.            |
| `react-best-practices`           | Apply robust React component, state, effect, and performance patterns. |
| `reserve-line-height`            | Reserve one line without layout shift when content appears.            |
| `seamless-hit-target`            | Expand hit targets without changing visible or focus geometry.         |
| `stable-width-button`            | Reserve dynamic label width to prevent button jitter.                  |
| `standalone-divider-spacer`      | Keep dividers and fixed gaps independent from content elements.        |
| `tailwind-consolidate-classes`   | Consolidate static utility classes in class-merging helpers.           |
| `visual-interaction-repro-first` | Reproduce rendering-dependent defects before changing implementation.  |
| `web-layout-best-practices`      | Apply resilient CSS and Storybook layout patterns.                     |
| `web-ui-standards`               | Apply accessible responsive UI and design-system standards.            |
| `zero-height-side-element`       | Add side content without increasing a row's block size.                |

## Evaluation

Repository-owned evaluations live under `evals/<skill-name>/`, outside installable skill folders.
Behavioral contracts and their retained run artifacts cover `figma-browser-visual-compare`,
`layout-measurement-strategy`, and `pointer-drag-release`. Other skills receive structural and
format validation in CI.

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
