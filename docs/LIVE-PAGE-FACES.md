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

Hard pages return `this` from `newTemporaryCopy()` and do not clone. Landscape
spread turns fold the live leaf; only portrait soft leaves are copied.

### Media in the copy

Before this fix, a cloned `<video>` was a second player (a second request,
a second decoder, and its own audio). The engine now replaces each cloned
`<video>` with a
`<canvas data-stf-frame>` painted from the original's current frame via
`drawImage`. If the original has no frame yet, the canvas is a blank box of
the same size and records `data-stf-poster` when a poster URL was set — it
does not fetch that URL. `<audio>` is removed from the clone. A cloned
`<canvas>` is **unsupported**: `cloneNode` does not copy pixels, and a
snapshot is not taken (a tainted canvas cannot be painted anyway). The
original element is not paused, seeked, or reloaded.

The frame is frozen at clone time. The original keeps playing underneath.
Landscape does not clone, so a spread turn keeps the live element.

Marking a video leaf `data-density="hard"` avoids the copy entirely and loses
the soft curl. That is a host fallback, not the supported path.

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

### Attribute toggle (same contract, cheaper invalidation)

Rewriting a rule keyed on `[data-token-id]` makes every token on every mounted
page a style-recalc candidate. For a book that mounts dozens of leaves, toggle
an attribute on the matches instead and keep one static rule:

```css
[data-token-id][data-reading] {
  background-color: var(--wash);
}
[data-flipping] [data-token-id] {
  transition: none;
}
```

```js
for (const el of container.querySelectorAll(`[data-token-id="${CSS.escape(id)}"]`)) {
  el.toggleAttribute('data-reading', el.dataset.tokenId === id);
}
```

The lookup returns **two** elements while a portrait curl is up: the original
and the clone (`data-stf-clone`), because the clone is in the same container.
After a completed turn's `read` listener returns, the count is one. A
`cancelTurn()` `read` listener still sees two: the clone is removed when that
listener returns, and the count is one only after `cancelTurn()` itself
returns. The engine does not rewrite attributes on clone descendants, so a
toggle set after the copy survives until the clone is removed.

`changeState` emits `user_fold` or `flipping` **before** the clone is inserted.
A completed turn emits `read` **after** the clone is removed. A cancelled turn
(`cancelTurn()`) emits `read` **while the clone is still in the container**, so
a host can clear `data-reading` on the fold face, and removes the clone when
that listener returns. A host that sets `data-flipping` from `user_fold` /
`flipping` therefore turns transitions off before the fold face exists.

The trade-off: the stylesheet pattern needs no per-cue DOM writes and paints a
clone taken mid-cue automatically. The attribute pattern writes one attribute
per match per cue, including the clone if the cue changes mid-turn, and does
not restyle tokens the clock never touches.

### Range and Highlight API

A DOM `Range`, and the CSS Custom Highlight API (`Highlight` / `::highlight`),
are attached to the original tree. They do not cover the clone. Create a range
or a highlight per visual representation, or use one of the two patterns above.

Any span fallback must preserve shaping, whitespace, line breaking and reading
order — especially for Arabic. The English fixture is not proof that every
script works.

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
