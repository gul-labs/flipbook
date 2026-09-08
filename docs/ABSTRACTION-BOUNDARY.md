# Public/internal boundary and the renderer abstraction

**Status:** settled and implemented (façade methods + class-pair collapses,
2026-08-30 / 2026-08-31).

## Principle

A symbol belongs in the public API if a consumer needs it to do something the
library is _for_, and the library intends to keep it working. Everything else
is internal.

**Testability never justifies a public export.** Vitest aliases the package
name to `src`; tests deep-import. Publishing an algorithm so a test can name it
converts a convenience into a compatibility promise.

## What the core package exports

`packages/core/src/index.ts` is the whole public API (the `exports` map blocks
deep imports). In short:

| Category               | Examples                                                                          | Verdict                                                          |
| ---------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Façade + data          | `PageFlip`, settings types, errors, events, enums, geometry types, styles helpers | **Public**                                                       |
| Implementation classes | `Render`, `UI`, `Page`, `PageCollection`, `Flip`, fold maths                      | **Internal** (symbol-keyed where the binding still needs a seam) |

## Façade answers questions; it does not hand out collaborators

Consumers were reaching through `getRender` / `getUI` / `getPageCollection` /
`getPage` and reimplementing spread rules (wrong in landscape, wrong with hard
covers). The façade now answers directly:

| Method                           | Replaces                                        |
| -------------------------------- | ----------------------------------------------- |
| `getVisiblePages(): number[]`    | spread-index dance + duplicated `spreadPages()` |
| `getBlockElement(): HTMLElement` | `getUI().getDistElement()`                      |
| `getPageElement(i)`              | reaching through `getPage(i)` for the DOM node  |
| `isReady(): boolean`             | `getFlipController() !== null`                  |
| `canTurn(direction): boolean`    | consumers deriving bounds from page indices     |
| `isAnimating(): boolean`         | inspecting internal flip state                  |

The old collaborator getters are symbol-keyed internals. Add a façade answer;
never re-open a collaborator getter.

## Class pairs collapsed

The former abstract/concrete pairs (`UI`/`HTMLUI`, `Page`/`HTMLPage`,
`Render`/`HTMLRender`, `PageCollection`/`HTMLPageCollection`) are **one class
each**. The abstract bases were never a renderer seam: `Render` held ~78% of
the renderer and was DOM-bound (`offsetWidth`, Safari sniff, pixel conversion).
A WebGL renderer extending it would inherit the wrong half.

**Collapsing is reversible; publishing an extension point is not.** The right
seam for a second renderer is a headless state controller over the spread model
plus a progress signal — not `Render`. See [WEBGL_RENDERER.md](./WEBGL_RENDERER.md).

Do not re-open inheritance at these lines.
