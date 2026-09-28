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

A cloned `<video>` would be a second player: `cloneNode` copies `src`, and
that alone starts a request, a decoder and, with `autoplay`, audio, even on a
detached copy. The engine strips each copied media element (`src`,
`autoplay`, `<source>`, then `load()`) and replaces each cloned `<video>` with
a `<canvas data-stf-frame>` showing what the page shows: the poster until the
video has played, otherwise the current frame via `drawImage`. The canvas
carries the video's attributes (`class`, `id`, `data-*`; not `width` /
`height`) and its whole resolved style inline, so rules written against the
`video` tag still position, size, round and fit it. Its backing store is the
box × `devicePixelRatio`, not the video's native resolution, except under
`object-fit: none` / `scale-down`, which paint the frame 1:1. A poster is
painted as the canvas background from the URL the original is already
displaying, and recorded in `data-stf-poster`.

`<audio>`, `<iframe>`, `<embed>` and `<object>` in the clone are replaced by an
empty `<div data-stf-embed>` with the same attributes and resolved style
before the clone is attached, so they never load a second time. The fold
shows a blank box where the embed or player is.

A cloned `<canvas>` is **unsupported**: `cloneNode` does not copy pixels, and a
snapshot is not taken (a tainted canvas cannot be painted anyway). Media inside
a shadow root, and custom elements that start playback when connected, are not
handled. The original element is not paused, seeked, or reloaded.

The frame is frozen at clone time. The original keeps playing underneath.
Landscape does not clone, so a spread turn keeps the live element.

Marking a video leaf `data-density="hard"` avoids the copy entirely and loses
the soft curl. That is a host fallback, not the supported path.

Playback (pausing on turn start, embeds, autoplay rules) is the host's:
[MEDIA-PAGES.md](./MEDIA-PAGES.md).

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
When `flip` or `read` fires — a completed turn or `cancelTurn()` — the count
is one: a settling turn drops its copy before it commits.
The engine does not rewrite attributes on clone descendants, so a toggle set
after the copy survives until the clone is removed.

`changeState` emits `user_fold` or `flipping` **before** the clone is inserted,
and `read` **after** it is removed, on a completed turn and on `cancelTurn()`.
A host that sets `data-flipping` from `user_fold` / `flipping` therefore turns
transitions off before the fold face exists. With `foldCornerOnHover` (the
default), a hover peel announces `fold_corner` before it copies the leaf, and a
drag that continues from that peel announces `user_fold` with the copy already
present, so set `data-flipping` on every state that is not `read`. Clear `data-reading` on `read`:
the fold face is already gone, which is what keeps a turn chained from that
listener from losing its own copy.

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
