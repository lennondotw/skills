# Figma Browser Visual Compare Evals

This directory stores repository-owned repro fixtures and evaluation evidence used to develop the
`figma-browser-visual-compare` skill. These files are not copied into initialized user workspaces.

Each fixture keeps the run script, measurements, report, and grouped expected, actual, and diff
images together:

```text
<subject>/
  iteration-NNN/
    <comparison-name>/
      01-expected-figma@4x.png
      02-actual-chromium@4x.png
      03-diff-pixelmatch.png
    run.mts
    measurements.json
    report.json
```

To reproduce a fixture, initialize the skill workspace, copy the fixture's `run.mts` into a new
`runs-local/<subject>/iteration-NNN/` directory, start the referenced browser target, and run the
script from that workspace so its pinned dependencies are available.

All committed images must remain Git LFS objects through the repository-level `.gitattributes`
rules.
