# Live page faces during a curl

Status: implemented. Honest contract for HTML books whose pages contain real
text, not a stack of page rasters. Related limits:
[KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md).

## What the engine does

A turn borrows the original page node and may create a **temporary visual
copy** (`Page.newTemporaryCopy` → `cloneNode(true)`).

|                   | Original                                                                         | Clone                                                              |
| ----------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| DOM               | The consumer's node, still React-owned when using the binding                    | A new node, `data-stf-clone`, never a second React tree            |
| Attributes / text | Live                                                                             | Snapshot of whatever was in the tree **at clone time**             |
| Accessibility     | Unchanged                                                                        | `aria-hidden="true"`, `inert`, `pointer-events: none`              |
| Later mutations   | Apply to the original                                                            | **Do not** propagate                                               |
| `#id` lookups     | First match in tree order — the original, because the clone is appended after it | Duplicate ids are left in place so `#id` CSS still paints the fold |

Hard pages return `this` from `newTemporaryCopy()` and do not clone.

## Supported: token-id stylesheet highlighting

Keep stable identifiers on the tokens (`data-token-id="sample-en-page3-word8"`).
Put **one style rule outside every page subtree** and rewrite that rule as the
narration clock moves:

```css
[data-token-id='sample-en-page3-word8'] {
  background: #ffe08a;
}
```

Generate the selector with `CSS.escape`. Because the clone copied the
attribute, the same rule paints original and fold faces without a React update
per word and without an engine synchronization API.

Range-based highlighting is **not** that. A `Range` attached to the original
DOM does not cover the clone. Create a range (or equivalent) per visual
representation. Any span fallback must preserve shaping, whitespace, line
breaking and reading order — especially for Arabic. The English fixture is not
proof that every script works.

## Unsupported

- **Replacing language, font or page text mid-curl.** The clone keeps the old
  snapshot; the original can change under it and the fold will disagree. Wait
  for idle (`getState() === 'read'`) or call `cancelTurn()`, then load the new
  content and restore a stable semantic position.
- **A generic MutationObserver or automatic reflow engine.** Not provided.
  Resource readiness (fonts decoded, images loaded) belongs to the host.
  `isReady()` means pages are loaded, not that fonts have decoded.
- **Treating the clone as a second accessible page.** It is scenery. Do not
  strip that, and do not advertise it as a live region.

## React ownership

The binding portals page elements into `.stf__block`. Highlighting via a
document stylesheet does not replace those nodes, so it does not rebuild the
`PageCollection`. Per-word React re-renders that swap the page **node** will.

See `examples/mobile-reader/` for a consumer-owned fake narration clock that
only rewrites `#highlight-sheet`.
