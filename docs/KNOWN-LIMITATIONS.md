# Known limitations

Accepted current behavior and deferred-with-cause items. These are **not**
silent bugs. Open work that we still intend to do lives in [TODO.md](./TODO.md).

## Interaction

### Rotated / skewed host hit-testing

`UI.getMousePos` recovers translation and scale from
`getBoundingClientRect()` + `offsetWidth` only. Under an ancestor `rotate()` or
`skew()`, the fold runs away from the finger.

**Why unfixed:** full `DOMMatrix` inversion costs bundle bytes; no in-tree
consumer places the book on a rotated surface. Revisit when one does.

### `turnProgress` is not a complete scrubber

| Situation                                       | `turnProgress`                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `flippingTime: 0` / reduced-motion instant turn | **No events**                                                                                          |
| Corner hover peel (`FOLD_CORNER`)               | **No events**                                                                                          |
| Animated turn / drag                            | `progress ∈ [0, 1]`, no promise of a terminal `1.0`                                                    |
| Snap-back cancel                                | Progress falls; **no** synthetic `0`                                                                   |
| Turn completes                                  | Use core `flip` / `changeState` (React: `onPageChange` / `onChangeState`) — not a final `turnProgress` |

Wire scrubbers to **`turnProgress` + a completion event** (`flip` / `onPageChange`).

## Rendering / DOM ownership

### Two-owner leaf DOM

The engine stamps classes and inline layout styles on consumer-rendered page
roots; React portals those roots into `.stf__block`. This is the live model.
Binding-owned host wrappers would be cleaner but break DOM-selector consumers
— filed as 4.0-shaped in TODO.

**Contract:** style an **inner** wrapper, not the leaf root. The engine owns
`position` / `left` / `top` / `width` / `height` / `clip-path` on the root.
See also [LIVE-PAGE-FACES.md](./LIVE-PAGE-FACES.md).

### Mid-fold paint residue

Resting redraw is **0** style writes. Mid-fold soft landscape still pays ~**44**
recorded writes/frame (was 106). Remaining cost is the working set whose values
change every frame (flipping leaf + shadows). Static-leaf `simpleDraw` still
runs for string-build / class checks even when the memo hits. Does not scale
with page count; deferred until a real device profile shows it matters.

### Engine style memo mid-animation

After the frame-discipline work, `Page.applyEngineStyle` skips when the stamp
string is unchanged. A consumer who mutates engine-owned inline properties
**during** an animation only gets overwritten on the next frame whose stamp
differs. Normal React/vanilla usage is unaffected.

## Mobile / live HTML

### F06 correlated turn lifecycle — deferred

Optional `turnStarted` / terminal events with a turn id are **not** shipped.
`READ` is not an exactly-once completion contract and cannot substitute for
turn IDs or a pre-clone notification. Basic WebView rendering does not need
them. Adding them is a locked-surface amendment — see TODO.

### Clone is a snapshot

During a curl the fold face is a `cloneNode(true)` snapshot. Later mutations to
the original do not propagate. Highlight via a **document stylesheet** on stable
token ids, not per-word React re-renders that swap page nodes. Full contract:
[LIVE-PAGE-FACES.md](./LIVE-PAGE-FACES.md).

## Deliberately rejected

Do not re-open without owner approval:

| Idea                                             | Why not                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| Restore `loadFromImages` / canvas                | Removed on purpose ([ADR 0002](./adr/0002-remove-canvas-mode.md)) |
| Deprecated aliases for renamed settings          | 3.0 is a major; `MIGRATION.md` is the tool                        |
| Unify core throws with React booleans            | Two audiences on purpose                                          |
| Loosen `INVALID_BOOLEAN` / strict settings       | `'false'` is a truthy string                                      |
| Publish `Render` / `UI` / `Page` for subclassing | Wrong seam; see [WEBGL_RENDERER.md](./WEBGL_RENDERER.md)          |
