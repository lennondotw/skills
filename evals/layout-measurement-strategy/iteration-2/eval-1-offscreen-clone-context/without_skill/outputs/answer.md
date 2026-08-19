# Why your offscreen-clone measurements come back short

## Short version

Your clone is measured **outside the context that determines its height**. When you
`document.body.appendChild(clone)`, you strip the node away from:

1. The **container-query context** — so any `@container` rules (your "compact density"
   spacing/font-size) stop matching and the row falls back to its default, roomier or
   tighter styles.
2. The **CSS custom property inheritance chain** — the `--space-*` / `--font-size-*`
   variables are defined on the feed container (or a theme wrapper), not on `:root`, so
   the clone resolves them to their fallbacks (or nothing), changing padding, line-height
   and font-size.
3. The **width constraint** — a `position:absolute` element with `height:auto` and no
   explicit width shrink-wraps to content, so text wraps differently (usually onto fewer
   lines) than it does in the real fixed-width column. Fewer wrapped lines = shorter.

Any one of these makes the measured height wrong. All three compound, and the
container-query one is exactly why "compact density" is the worst offender: compact
density is _implemented_ as a container-query (or a class on the container that variables
key off), and that whole mechanism is dead once the node lives on `<body>`.

`getBoundingClientRect()` itself is fine — but it also **excludes margins**, so if your
rows have vertical margins those are silently dropped too.

---

## The root cause in detail

### Container queries resolve against the nearest container ancestor

`@container` rules match against the size of the nearest ancestor that established a
containment context (`container-type: inline-size` / `size`). Your real rows sit inside
the feed container, so `@container (max-width: …)` (or a named container query) resolves
against _that_ element's width.

When the clone is a direct child of `<body>`, there is no container ancestor anymore
(unless `<body>` happens to be one, which it isn't). Every `@container` block that styled
the row — tighter padding, smaller line-height, condensed font-size in compact mode —
simply doesn't apply. The clone renders with the "no container query matched" baseline,
which is a different height.

This is structural: it has nothing to do with a bug in your clone code. A container query
is a function of ancestry, and you severed the ancestry.

### Custom properties are inherited, not global

`--row-padding`, `--row-font-size`, `--line-height`, etc. are almost certainly declared on
the container or a theme root (`.feed`, `[data-density="compact"]`, `.theme-…`), not on
`:root`. Custom properties inherit down the tree. On `<body>` the clone is _above_ /
_outside_ the element that declares them, so `var(--row-padding, 8px)` falls back to its
default, or computes to `initial` (which for an unregistered property means the value is
invalid and the declaration using it is dropped). Either way spacing and type size differ,
so height differs.

### No width → different wrapping

Absolutely-positioned, `height:auto`, no `width`: the box is shrink-to-fit. Your real
column has a definite width. Different width → different line breaks in text → different
number of line boxes → different height. This alone can make a 3-line row measure as
2 lines.

### Fonts

If you measure before web fonts have loaded, you measure fallback-font metrics. After the
swap, real rows are taller/shorter. `document.fonts.ready` must resolve first.

### Margins

`getBoundingClientRect().height` = border-box height. It does **not** include margins and
does not account for margin-collapsing. If rows contribute vertical margin to their
position, you're under-counting per row.

---

## What to do instead

Two viable strategies. I recommend **measuring in-context** if you must pre-measure, and
strongly recommend **measure-after-render (dynamic virtualization)** as the robust default.

### Option A (recommended): measure the _real_ rows after render, cache, and correct

This is what mature virtualizers (TanStack Virtual, react-virtual, react-window's
`VariableSizeList` with measurement) do. Don't try to predict height from a detached
clone at all. Instead:

1. Start every unmeasured row with an **estimated** height.
2. Render the rows that fall in the viewport _inside the real container_.
3. Measure their actual DOM box with `ResizeObserver` (handles font swaps, image loads,
   density toggles, resize — all automatically).
4. Write the measured height into a cache keyed by item id, and reflow positions.

Because the row is rendered in its true home, container queries match, variables inherit,
width is correct, fonts are loaded — the measurement is simply correct, by construction.

```ts
// heightCache keyed by stable item id
const heightCache = new Map<string, number>();

function RowMeasurer({
  id,
  estimate,
  onMeasure,
  children,
}: {
  id: string;
  estimate: number;
  onMeasure: (id: string, height: number) => void;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      // offsetHeight = border-box; add margins since rect/offset exclude them
      const cs = getComputedStyle(el);
      const marginY = parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
      const h = el.getBoundingClientRect().height + marginY;
      if (h && Math.abs(h - (heightCache.get(id) ?? -1)) > 0.5) {
        heightCache.set(id, h);
        onMeasure(id, h);
      }
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [id, onMeasure]);

  return (
    <div ref={ref} data-row-id={id} style={{ contain: "layout" }}>
      {children}
    </div>
  );
}
```

Wait for fonts once at the list level so the first measurement isn't fallback-font:

```ts
React.useEffect(() => {
  let alive = true;
  document.fonts.ready.then(() => {
    if (alive) remeasureAll(); // re-run measurement / invalidate cache
  });
  return () => {
    alive = false;
  };
}, []);
```

If you'd rather not build this, use **TanStack Virtual** (`@tanstack/react-virtual`) with
`measureElement` — it does exactly this: estimate, render, `ResizeObserver`-measure,
correct. It's the least-surprising path for a feed with variable, theme-dependent heights.

### Option B: pre-measure, but do it _in context_

If your architecture genuinely needs a height before the row is ever mounted (e.g. you
compute the full scroll height up front), then keep the measurement node **inside the real
container** rather than on `<body>`, and give it the real width.

```ts
// Create ONE reusable measurement host, once, as a child of the actual feed container
// (the element that owns the container-query context AND the custom properties).
function createMeasurer(container: HTMLElement) {
  const host = document.createElement("div");
  // Hidden but still laid out. Do NOT use display:none (no layout) or
  // position:absolute without width (wrong wrapping).
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    visibility: hidden;
    pointer-events: none;
    contain: layout size style;
  `;
  container.appendChild(host); // <-- key: inside the container, not body
  return host;
}

async function measureRow(
  host: HTMLElement,
  rowNode: HTMLElement,
  contentWidth: number, // the REAL content-box width of a row in this container
) {
  await document.fonts.ready; // don't measure fallback metrics

  host.style.width = `${contentWidth}px`; // match wrapping
  host.replaceChildren(rowNode);

  const el = host.firstElementChild as HTMLElement;
  const cs = getComputedStyle(el);
  const marginY = parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
  const height = el.getBoundingClientRect().height + marginY;

  host.replaceChildren();
  return height;
}
```

Critical points for Option B:

- **The host must be a descendant of the same container** whose width the `@container`
  rules key off, and which declares the spacing/font custom properties. If your density
  variables live on a `[data-density]` wrapper, the host must be inside _that_ too. When in
  doubt, mount the host next to a real row.
- **Set an explicit width** equal to the real row's content-box width, so wrapping matches.
  Read it from a real row / the container once: `container.clientWidth` minus horizontal
  padding, or `getComputedStyle` on an existing row.
- **`visibility: hidden`, not `display: none`.** `display:none` produces no layout and
  `getBoundingClientRect()` returns all zeros. `visibility:hidden` still lays out.
- **Re-measure on relevant changes**: density toggle, viewport resize (container width
  changes → container queries re-evaluate → heights change), and font load. Invalidate the
  cache on each.
- Prefer moving the _actual_ React-rendered subtree into the host over hand-cloning, so the
  computed styles are identical. If you must `cloneNode(true)`, remember clones don't carry
  canvas contents, form state, or `::before/::after`-dependent JS, but they _do_ inherit CSS
  from their new position — which is exactly why position matters.

---

## Concretely, to fix your current bug immediately

1. Stop appending to `document.body`. Append your measurement host **inside the feed
   container** (and inside the density wrapper if separate). This alone fixes the
   compact-density discrepancy and the general shortness, because container queries and
   custom properties will resolve correctly.
2. Give the host an **explicit width** matching the real row content width so text wraps
   the same.
3. `await document.fonts.ready` before the first measurement pass.
4. **Add vertical margins** to `getBoundingClientRect().height`.
5. Re-measure (invalidate cache) on **container resize** and **density change** — both
   change container-query outcomes.

But if you can, migrate to Option A / TanStack Virtual. Predicting variable, theme- and
width-dependent heights from a detached node is inherently fragile; measuring the real
rendered row with a `ResizeObserver` and correcting is the approach that stays correct as
themes, densities, fonts, and breakpoints change.
