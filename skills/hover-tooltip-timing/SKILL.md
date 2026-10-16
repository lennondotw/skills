---
name: hover-tooltip-timing
description: |
  Timing, grouping, and hit-target rules for hover tooltips and hover cards: hover-intent delay, immediate dismissal, a warm-up window that makes the next tooltip in the same group open instantly, per-group delay state, and continuous hit targets. Use when building or reviewing tooltips in dense tables, toolbars, charts, or icon rows, especially when tooltips feel slow to scan, flicker between neighbours, linger after the pointer leaves, or pop open in unrelated places.
---

# Hover Tooltip Timing

A hover tooltip should cost nothing to ignore and nothing to scan. The first one waits until the pointer clearly rests; once the user is reading tooltips, the next one in the same set appears at once; leaving dismisses immediately.

## Model

Each **delay group** (a set of related triggers: one table column, one toolbar, all info icons) runs this state machine:

| State | Enter when                        | Pointer enters a trigger                      |
| ----- | --------------------------------- | --------------------------------------------- |
| Cold  | Start, or the warm window expired | Open after the **hover-intent delay**         |
| Open  | A tooltip in the group is showing | **Transfer**: re-anchor and swap content now  |
| Warm  | The group's tooltip just closed   | Open **immediately**, without entrance motion |

- **Hover-intent delay** (open delay): how long the pointer must rest before the first tooltip opens. It filters out pointers passing over on their way elsewhere.
- **Immediate dismissal**: the tooltip closes the moment the pointer leaves the trigger. No close delay, no lingering exit animation.
- **Warm window** (skip-delay or grace period): after closing, the group stays warm for a short window. Each close restarts the window; when it runs out, the group is cold again and the next tooltip waits for the full delay.
- **Transfer**: moving straight from one trigger to another in the same open group moves one popup instance to the new anchor with new content, with no close-and-reopen flicker.

## Recommended values

| Parameter                     | Value    | Notes                                                 |
| ----------------------------- | -------- | ----------------------------------------------------- |
| Hover-intent delay            | 200 ms   | 150–300 ms; data-cell tooltips may go to 300 ms       |
| Delay for explicit info icons | 100 ms   | Pointing at a dedicated "i" is deliberate             |
| Close delay                   | 0 ms     | Dismiss on leave                                      |
| Warm window                   | 500 ms   | Measured from the last close; restarts on every close |
| Entrance motion (cold)        | ≤ 100 ms | Opacity plus a slight scale (0.97 → 1)                |
| Entrance motion (warm)        | none     | Appear in place                                       |
| Exit motion                   | none     | Or ≤ 50 ms                                            |

## Grouping

- **Scope warm state to related content.** Triggers that answer the same kind of question share a group: one table column, one icon toolbar, all inline info icons on a page.
- **Never share warm state across unrelated content.** If every tooltip on the page shares one group, hovering a column header makes an unrelated card or icon pop open instantly as the pointer passes by. One global provider usually means one global group; create one group, and one popup instance, per set.
- Give each group its own timer, popup instance, and delay; nothing leaks between groups.

## Hit targets

Warm state only helps if the pointer can travel between triggers without leaving them.

- **Tile the triggers.** In tables, make the whole cell the trigger, not the text inside it; adjacent cells in a column then touch, and moving along the column never passes through a dead zone that closes the tooltip.
- **Extend small triggers.** For icons, add an invisible hit layer (absolutely positioned pseudo-element) that fills the row height and half of the gap to each neighbour, so stacked or adjacent icons meet edge to edge without changing layout.
- **Make the label part of the target.** "VPN (i)" works better as one trigger than an isolated 14 px icon.

## The popup

- **Non-interactive.** A hover tooltip ignores the pointer (`pointer-events: none`) and is not kept open by hovering it, so it never covers or steals the next trigger.
- **Place it off the path of travel**: beside or above the trigger with a small offset (4–8 px), not over the neighbouring triggers the pointer moves to next.
- **Keyboard parity**: focus shows the tooltip, Escape dismisses it, and the content is exposed to assistive technology (e.g. `aria-describedby`). Essential information must not live only in a tooltip.
- **Reduced motion**: drop the scale and keep only an opacity change, or none.

## Library notes

- Base UI: `Tooltip.Provider` has `delay`, `closeDelay`, and `timeout` (the warm window), but it groups every tooltip below it. For per-set groups, use one `Tooltip.createHandle()` and one `Tooltip.Root` per group with detached `Tooltip.Trigger`s (content via `payload`), and track the warm window per group yourself; Base UI marks instant openings across roots with `data-instant`, not reopenings of the same root.
- Radix: `TooltipProvider` exposes `delayDuration` and `skipDelayDuration`; nest separate providers to separate groups.

## Review checklist

- [ ] The first tooltip waits for the hover-intent delay; passing over triggers opens nothing.
- [ ] Leaving a trigger closes its tooltip immediately.
- [ ] Moving along a column or row of triggers transfers without flicker or gaps.
- [ ] Returning within the warm window reopens instantly without entrance motion; after it, the delay applies again.
- [ ] Hovering one group never makes another group open instantly.
- [ ] Popups ignore the pointer and do not cover the next trigger.
