# SF Pro centring — measured reference

The off-centre behaviour described in [SKILL.md](../SKILL.md) is measured here against the macOS system font (`-apple-system` / `system-ui` → `SFNS.ttf`). All numbers are derived from two independent sources: direct font-file inspection via fontTools, and pixel-scan of Chrome's actual rendered output.

## 1. Font metrics — read directly from the font file

```
$ python3 -c "from fontTools.ttLib import TTFont; ..."  /System/Library/Fonts/SFNS.ttf
```

| metric                                        | UPM units | em ratio    | source field              |
| --------------------------------------------- | --------- | ----------- | ------------------------- |
| Units per em (UPM)                            | 2048      | —           | `head.unitsPerEm`         |
| hhea ascender                                 | 1980      | **0.9668**  | `hhea.ascent`             |
| hhea descender                                | −432      | **−0.2109** | `hhea.descent`            |
| hhea lineGap                                  | 0         | 0           | `hhea.lineGap`            |
| OS/2 typo ascender                            | 1980      | 0.9668      | `OS/2.sTypoAscender`      |
| OS/2 typo descender                           | −432      | −0.2109     | `OS/2.sTypoDescender`     |
| OS/2 typo lineGap                             | 0         | 0           | `OS/2.sTypoLineGap`       |
| OS/2 win ascent                               | 1980      | 0.9668      | `OS/2.usWinAscent`        |
| OS/2 win descent                              | 432       | 0.2109      | `OS/2.usWinDescent`       |
| **cap-height**                                | 1443      | **0.7046**  | `OS/2.sCapHeight`         |
| x-height                                      | 1077      | 0.5259      | `OS/2.sxHeight`           |
| `USE_TYPO_METRICS` flag (`fsSelection` bit 7) | —         | **0 (off)** | `OS/2.fsSelection & 0x80` |

Notes:

- All three ascender/descender tables (hhea, OS/2 typo, OS/2 win) carry **identical** values for SFNS. Browser-platform metric selection is irrelevant for this font.
- `line-height: normal` resolves to `(A + D + lineGap)/UPM = (1980 + 432 + 0)/2048 = 1.178`. `leading-none` (`line-height: 1`) is therefore ~17.8 % tighter than the designer's natural spacing.
- `SFNSMono.ttf` carries identical hhea metrics (1980 / −432 / 0) and identical cap-height (1443).

## 2. Chrome's measureText() — what the browser reports

Chrome on macOS, opening `-apple-system` via canvas `measureText('P')`, reports slightly different ratios from raw fontTools — the browser likely picks per-platform metrics through Core Text and integer-rounds them:

| size | fontBoundingBoxAscent | em       | fontBoundingBoxDescent | em       | actualBoundingBoxAscent (cap of "P") | em     |
| ---- | --------------------- | -------- | ---------------------- | -------- | ------------------------------------ | ------ |
| 128  | 122                   | 0.953125 | 31                     | 0.242188 | 90.19                                | 0.7046 |
| 256  | 244                   | 0.953125 | 62                     | 0.242188 | 180.38                               | 0.7046 |
| 512  | 488                   | 0.953125 | 124                    | 0.242188 | 360.75                               | 0.7046 |

So Chrome's effective A = 0.953, D = 0.242 — not the 0.9668 / 0.2109 the font file claims. cap-height matches the file at 0.7046.

The difference (0.967 vs 0.953 for A) is a Core Text vs hhea-direct quirk; the rest of this document uses **Chrome's reported values** since those are what the layout actually uses.

## 3. CSS spec formulas (CSS 2.1 §10.8.1 / CSS Inline Layout L3 §5.3)

For an inline box with font-size `F` and line-height `L`:

```
leading        = L − (A + D)        ← A, D are font's ascender and descender, in px
half_leading   = leading / 2        ← may be negative
inline_box_h   = L                  ← exactly line-height, regardless of font metrics
baseline_y     = A + half_leading   ← position of baseline, measured from inline_box top
                = (A − D + L) / 2
```

Strut: a phantom inline of the IFC-establishing block's first available font and line-height. Mandatory in every line box. Spec literally calls it "strut".

Line box: contains all aligned inline boxes plus the strut.

```
line_box_above_baseline = max over all inlines of (A_i + half_leading_i)
line_box_below_baseline = max over all inlines of (D_i + half_leading_i)
line_box_height = line_box_above_baseline + line_box_below_baseline
                ≥ strut_inline_box_height
```

Visible cap of an uppercase glyph (no descenders):

```
cap_top      = baseline_y − cap_height
cap_bottom   = baseline_y                    ← caps sit on baseline
cap_centre   = baseline_y − cap_height / 2
```

Centring offset (cap centre vs inline-box centre, when child wins the line box):

```
cap_centre − box_centre = (A − D + L)/2 − cap_height/2 − L/2
                        = (A − D − cap_height) / 2
                                                              ← independent of L
```

Plugging in Chrome's metrics for SFNS:

```
(0.953 − 0.242 − 0.7046) / 2 = +0.0032 em
```

So when the child's inline box wins the line box (flex item, or IFC where child font-size ≥ parent strut), cap centres should sit **+0.003 em below box geometric centre** — sub-pixel at typical sizes.

## 4. Measured — full-page screenshot, ImageMagick / Pillow pixel-scan

Method: each variant is rendered with a single "P", solid black on a white container with a 1-px outline. A Pillow scan walks the cropped container region row by row, locates the topmost and bottommost rows containing any pixel < 100 grey value (= ink), and reports the cap's ink bounds in CSS pixels.

Measured cap-height was **0.7031 – 0.7051 em** across all sizes (matches font's 0.7046 cap-height within sub-pixel anti-aliasing noise).

### 4a. Same configurations at "large" font sizes (128 / 256 / 512 px)

Container `padding: 32–128 px ; background: white`. Parent inherits body's 14 px / 1.5 line-height.

| variant                                   | size            | offset (px)           | offset (em)              |
| ----------------------------------------- | --------------- | --------------------- | ------------------------ |
| A · default block + child lh:1.5          | 128 / 256 / 512 | +0.25 / +0.50 / +1.50 | +0.002 / +0.002 / +0.003 |
| B · default block + child lh:1            | 128 / 256 / 512 | +0.25 / +0.50 / +1.50 | +0.002 / +0.002 / +0.003 |
| C · parent lh:1, child inherits           | 128 / 256 / 512 | +0.25 / +0.50 / +1.50 | +0.002 / +0.002 / +0.003 |
| D · parent font-size matches child + lh:1 | 128 / 256 / 512 | +0.25 / +0.50 / +1.50 | +0.002 / +0.002 / +0.003 |
| E · flex + child lh:1.5                   | 128 / 256 / 512 | +0.25 / +0.50 / +1.50 | +0.002 / +0.002 / +0.003 |
| F · flex + child lh:1                     | 128 / 256 / 512 | +0.25 / +0.50 / +1.50 | +0.002 / +0.002 / +0.003 |

**All variants converge.** When the child's font-size dwarfs the parent's strut, the line box becomes child-dominated and the parent's IFC setup stops mattering. Offset is the universal +0.003 em sub-pixel artefact of the font's `(A − D − cap)/2` constant. This is **not** the real-world Eyebrow case.

### 4b. Original-shape problem — small child in large parent (9 : 14 ratio, blown up)

Container `padding: 64 px 128 px`. Parent font-size 200 px, child font-size 200 × 9/14 = 128.57 px. This recreates the Eyebrow-in-default-block aspect ratio at a measurable scale.

| variant                                               | container height (px) | measured offset (px) | offset (em, vs child) | predicted offset |
| ----------------------------------------------------- | --------------------- | -------------------- | --------------------- | ---------------- |
| A · default block + child lh:1.5                      | 428                   | **+25.50**           | +0.198                | +25.8            |
| B · default block + child lh:1                        | 428                   | **+25.50**           | +0.198                | +25.8            |
| C · parent lh:1 (font-size still 200), child inherits | 328                   | **+25.50**           | +0.198                | +26.3            |
| D · parent font-size **matches child** + lh:1         | 256.6                 | **+0.25**            | +0.002                | +0.4             |
| E · flex + child lh:1.5                               | 321                   | **0.00**             | 0.000                 | +0.1             |
| F · flex + child lh:1                                 | 256.6                 | **+0.25**            | +0.002                | +0.4             |

**This is the picture that matters.** Five take-aways:

1. **A == B**. `leading-none` on the inline child does nothing once the parent's strut dominates. Identical offset.
2. **A == C**. `leading-none` on the parent shrinks line-height from 1.5 to 1, but the strut's height is still `parent-font-size × 1` = 200 px — still larger than the child's 128.57 px box. Offset identical to variant A.
3. **D works** — but only because the parent's font-size was matched to the child. `parent-font-size × 1 = child-font-size`, so strut equals span and the offset collapses to the universal +0.002 em sub-pixel residual.
4. **E and F (flex) work** to within sub-pixel at all sizes, agreeing with D's residual.
5. The residual offset in D / E / F is `(A − D − cap_height) / 2 ≈ +0.003 em` — a font-design property of SF Pro, not a CSS bug. `text-box-trim: trim-both` removes even this.

### 4c. Implications for "fix" strategies

| strategy                                                         | works?  | why                                                                                                                                                                                                               |
| ---------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `display: block` on the inline primitive                         | partial | breaks the primitive's prose composability; doesn't fix the leading at the call site (`display: block` on a `<span>` makes it a block, but if the parent is still IFC with text siblings it doesn't help cleanly) |
| `leading-none` on the inline primitive                           | **no**  | parent's strut wins the line box regardless                                                                                                                                                                       |
| `leading-none` on the parent only                                | **no**  | parent's strut shrinks but its font-size still dominates if larger than child                                                                                                                                     |
| `leading-none` on parent **AND** match parent font-size to child | yes     | line-box collapses to child box; sub-pixel residual remains. Hard-couples parent's font to one child's size — fragile.                                                                                            |
| `display: flex; align-items: center` on the parent               | **yes** | kills the IFC entirely; flex centres margin box geometrically. Pair with `leading-none` on the child only if you also need to control its content-box height.                                                     |
| `text-box-trim: trim-both` on the inline                         | future  | Chrome 133+ / Safari 18.2+ / Firefox no                                                                                                                                                                           |

## 5. Measurement harness

The HTML harnesses are kept at:

- `/tmp/sf-pro-measure-v2.html` (large sizes, 6 variants × 3 sizes)
- `/tmp/sf-pro-measure-v4.html` (small-child-in-large-parent, 6 variants × 1 ratio)

Re-running:

1. Open the page in Chrome via the chrome-devtools MCP.
2. `evaluate_script(() => window.__cells)` to get device-pixel cell rects.
3. `take_screenshot --fullPage` to disk.
4. Run the Pillow pixel-scan in `/tmp/measure-venv` (Pillow + fontTools installed) against the rects.

Pixel-scan reproducibility:

```python
from PIL import Image
img = Image.open(path).convert('L')
region = img.crop((x, y, x+w, y+h))   # device-pixel cell rect
pixels = region.load()
ink_top = ink_bot = None
for row in range(INSET, region.height - INSET):
    for col in range(INSET, region.width - INSET):
        if pixels[col, row] < 100:    # threshold against anti-aliased fringe
            if ink_top is None: ink_top = row
            ink_bot = row
            break
```

## 6. Caveats this reference is honest about

- **DPR rounding** at 2x retains ~0.5 px residual noise at low sizes. The 128 / 256 / 512 sweep was specifically chosen so that the predicted offset is ≫ noise floor.
- **Anti-aliasing** at the cap's edges adds ±1 sub-pixel to ink bounds. The threshold of grey value 100 was chosen to pick up only solidly-rendered ink, not the AA fringe.
- **Chrome vs Safari vs Firefox** may differ on metric selection. All numbers here are Chrome on macOS. Safari should match (both use Core Text); Firefox uses its own font shaper and may diverge slightly.
- **Variable font instances**: SF on modern macOS is a variable font; metric values are constant across weights, so `font-weight: 700` should not change the geometry.
- **Bold "P" vs Regular "P"**: confirmed identical fontBoundingBox metrics via canvas at both weights.
