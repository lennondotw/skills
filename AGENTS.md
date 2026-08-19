# Repository Instructions

## Scope

This repository publishes reusable, app-independent agent skills.

## Layout

- Put each installable skill under `skills/<name>/` with `SKILL.md` as its entrypoint.
- Put repository-owned evaluations under `evals/<name>/`, outside installable skill folders.
- Keep repository tooling under `scripts/` as TypeScript `.mts` files executed with `tsx`.

## Requirements

- Use lowercase kebab-case names and keep frontmatter `name` equal to the skill directory name.
- Keep public skill content self-contained and suitable for public distribution.
- Keep validation limited to repository structure and file format. Do not add content inspection or
  sensitive-term rules to the validator.
- Add a regression eval before changing behavior when a reproducible failure is known.

## Verification

Run `pnpm check` before committing. Keep commits small, focused, and conventionally named.
