# Artifact contract

Use this contract as a small common vocabulary. The iteration script remains code-as-config and may add fields that help explain its component.

## Completed comparison

```text
runs-local/<subject>/iteration-NNN/
  <comparison-name>/
    01-expected-figma@4x.png
    02-actual-chromium@4x.png
    03-diff-pixelmatch.png
  run.mts
  measurements.json
  report.json
```

Use `.mts` and run it with `tsx`. One iteration script may produce several comparison groups.

## Preflight failure

If expected and actual dimensions differ, do not resize, pad, or pixelmatch automatically. Keep the iteration as diagnostic evidence with only `run.mts`, `measurements.json`, and `report.json`. Set `report.json.status` to `blocked-before-diff` and record the expected size, actual size, classified cause, and intended next correction. A comparison group is complete only when all three canonical PNGs exist at equal dimensions.

## measurements.json

```json
{
  "capture": {
    "background": "#f5f5f5",
    "deviceScaleFactor": 4,
    "viewport": { "width": 480, "height": 160 },
    "browserClip": { "x": 38, "y": 48, "width": 404, "height": 68 },
    "expectedPixels": { "width": 1616, "height": 272 },
    "actualPixels": { "width": 1616, "height": 272 },
    "semanticAnchor": "layout-box top-left",
    "effectInsets": { "top": 8, "right": 10, "bottom": 12, "left": 10 },
    "normalization": null
  },
  "figma": { "target": {}, "ancestorChain": [], "subtree": {} },
  "browser": { "targetRect": {}, "captureRect": {}, "ancestorChain": [], "subtree": {} },
  "adaptiveCheck": {
    "availableWidth": 320,
    "documentOverflow": false,
    "clipped": false,
    "notes": ""
  }
}
```

Use focused simplified nodes and computed styles. Omit irrelevant properties rather than serializing the whole file or DOM.

## report.json

```json
{
  "status": "completed",
  "figmaFileKey": "...",
  "generatedAt": "...",
  "scale": 4,
  "threshold": 0.02,
  "maxAllowedDiffPercent": 1,
  "maxDiffPercent": 0.42,
  "passed": true,
  "results": [
    {
      "state": "comparison-name",
      "expected": "comparison-name/01-expected-figma@4x.png",
      "actual": "comparison-name/02-actual-chromium@4x.png",
      "diff": "comparison-name/03-diff-pixelmatch.png",
      "size": "1616x272",
      "mismatchedPixels": 1846,
      "totalPixels": 439552,
      "diffPercent": 0.42
    }
  ],
  "inspection": {
    "order": ["diff", "expected", "actual"],
    "largestRegion": "text glyph edges",
    "classification": "rasterization-only"
  }
}
```

Pixelmatch defaults to excluding pixels it classifies as antialiasing. Yellow or faint pixels may remain visible in the diff even when the counted mismatch is zero. Treat the ratio as one signal and inspect all three images.
