---
name: stable-control-position
description: |
  Keep a control in place while it is being operated: using it must never move it. Use when a toggle, segmented control, select, or button changes which sibling controls are shown, when a button label changes length after a click (counts, "Run" → "Cancel"), or when a right-aligned toolbar reflows as its contents change.
---

# Stable Control Position

## Rule

Operating a control must not change that control's position. The pointer, finger, or keyboard focus is already on it; if it moves, the next click lands on something else, repeated toggling becomes a chase, and the user loses their place.

The rule covers the control's own effects: content it shows or hides, labels it changes, layout it triggers. Other controls may move when this one changes things, as long as they are not the one in use.

## Common causes

- **Edge-aligned groups.** In a right-aligned toolbar (`margin-left: auto`, `justify-content: flex-end`), every control left of a changing one shifts when it appears, disappears, or changes width. A mode switch that hides a field to its right moves itself.
- **Variable-width labels.** "Run (12)" becomes "Run (142)", "Start" becomes "Cancel", a count gains a digit.
- **Content inserted before the control.** A banner, error line, or result row appears above or to the left of the control that caused it.
- **Wrapping.** A row that wraps differently after the change moves controls to another line.

## Patterns

1. **Anchor to the stable edge.** Put a control whose use changes its neighbours on the side that does not move, usually the leading edge right after the title, and let the changing controls follow it toward the flexible side.

   ```tsx
   <header className="flex items-center gap-3">
     <h1>Connectivity</h1>
     {/* Changing mode shows or hides Repeats; anchored here, the switch itself never moves. */}
     <ModeSwitch value={mode} onChange={setMode} />
     <div className="ml-auto flex items-center gap-2">
       <EgressSelect />
       {mode === "quick" && <RepeatsSelect />}
       <RunButton />
     </div>
   </header>;
   ```

2. **Reserve the space.** When the control's own content changes, reserve the widest variant (stable-width labels, `tabular-nums` for counts) so its box does not resize.

3. **Keep the slot, change the state.** Prefer disabling or emptying a dependent control over removing it when it sits on the same line as the control that toggles it.

4. **Swap in place.** Controls that replace each other ("Run" ↔ "Cancel") occupy the same slot, aligned to the edge that stays put.

5. **Insert away from the pointer.** Place feedback the control produces after it in reading order (below or to the trailing side), or in reserved space, never before it.

## Check

Operate each control several times in a row without moving the pointer. Every activation must land on the same control, in the same state flow, at every viewport width.
