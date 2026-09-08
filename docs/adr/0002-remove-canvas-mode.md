# ADR 0002 — Remove canvas mode

**Status:** Accepted by the owner, 2026-08-29. **Implemented** on
`feat/gullabs-flipbook-3.0` (canvas source, tests, stubs, size ceilings).

**Supersedes:** the pre-3.0 canvas-first-class plan and ADR 0001 (image-page
API for canvas — never published; removed with canvas).
**Related:** [`../WEBGL_RENDERER.md`](../WEBGL_RENDERER.md).

## Decision

1. **Canvas mode is removed entirely.** `CanvasRender`, `CanvasUI`,
   `ImagePageCollection`, `ImagePage`, `canvasLeaf.ts`, `Render/imageFit.ts`,
   `canvas-loader.ts`, `ImageFlipBook`, the canvas e2e suite and fixtures, and
   the `imageFit` / `imageInset` settings all go.
2. **A future renderer is contemplated, but not via these classes.** The
   abstract/concrete pairs were later collapsed into single HTML classes
   ([ABSTRACTION-BOUNDARY.md](../ABSTRACTION-BOUNDARY.md)); the right future
   seam is a headless controller ([WEBGL_RENDERER.md](../WEBGL_RENDERER.md)),
   not subclassing `Render`.
3. **`loadFromImages` / `updateFromImages` are deleted.** No runtime stubs and
   no `'CANVAS_REMOVED'` code. A method that only throws still appears on the
   published `.d.ts` and defers failure to production; deletion makes the break
   a **compile-time** error for typed consumers. (An earlier draft of this ADR
   kept throwing stubs; that approach is rejected.)

## Why

### The one-line version

**HTML mode delegates to the browser. Canvas mode reimplements the browser.**

Content complexity and code complexity are not the same thing. HTML pages may
contain arbitrarily complex content, but the engine handles none of it — it
positions a box and the browser does the rest. Canvas content is trivial (this
fork restricted it to images and blank leaves) and the engine must handle _all_
of it, because a canvas is one opaque bitmap with a `drawImage` call and no
services attached.

### What that cost, measured on the work actually done

| Job                      | HTML mode                         | Canvas mode                                                                                                                                                                                                                                     |
| ------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fit an image to the page | `object-fit: contain`             | a whole module (`Render/imageFit.ts`): contain/cover/fill maths, source-rect cropping, non-finite intrinsic-size guards                                                                                                                         |
| Load an image            | `<img src>`                       | a load state machine: `complete && naturalWidth`, `onerror`, a `failed` flag, handler ordering before `src`                                                                                                                                     |
| Show a broken image      | the browser's built-in icon       | a hand-drawn vector glyph, deliberately avoiding `arc` so it cannot be confused with the loading spinner                                                                                                                                        |
| Accessible name          | `alt="…"`                         | required `alt` in descriptors, a three-valued named/decorative/unknown distinction, `getPageAltText` accessors, a visually hidden semantic mirror with `aria-posinset`/`aria-setsize`, `aria-hidden` on the canvas — and still worse than `alt` |
| Cross-origin images      | works                             | taints the canvas; needs `crossOrigin` (C7)                                                                                                                                                                                                     |
| High-DPI screens         | automatic                         | manual `devicePixelRatio` backing-store scaling                                                                                                                                                                                                 |
| Memory                   | the browser evicts decoded images | ours to manage — the entire content of Phase 3                                                                                                                                                                                                  |

Restricting canvas to images did not make it simple. It made it _possible_:
text on a canvas requires line breaking, font loading and fallback,
hyphenation, bidi and selection — a text-layout engine. Everything remaining
after that wall is still a reimplementation job.

### The correctness argument, which beats the bundle argument

The bundle saving is real but modest: canvas is already a lazily-imported chunk,
so an HTML-only consumer never downloads it. What they pay eagerly is the
validator, the loader shim and the mode-switching machinery threaded through
`PageFlip` — on the order of 1–2 kB, not the chunk's ~10 kB.

The decisive argument is that **we cannot get it right, and the failures repeat**:

- Two bugs found in `ImageFlipBook` on 2026-08-29 — a book that permanently
  vanishes when `showCover` changes, and a controlled `page` silently rewritten
  to the spread head — were both defects `HTMLFlipBook` had already found and
  fixed. The canvas binding shipped the pre-fix version of each.
- An independent accessibility review found the canvas a11y story
  **unimplementable as shipped**: the alt text existed only on an unexported
  class inside the lazy chunk.

That is the structural cost of a second renderer that re-solves what the first
one solved, and gets it wrong on the way. It is a permanent bug factory, and
removing it removes a class of defect rather than an instance.

### Cross-environment risk

Canvas puts this project in the business of matching browser behaviour across
engines, devices and pixel ratios — with no browser to fall back on when they
disagree. That is not a business this project is equipped to be in.

## The one real use case, and why canvas is still the wrong answer

Node count. HTML mode puts every page in the DOM, so a 500-page book is 500
elements. That is genuine, and it is the one thing canvas actually bought.

The right answer is **virtualising HTML mode** — keep the current spread and its
neighbours in the DOM and recycle the rest. Smaller than the six remaining
canvas phases, benefits every consumer rather than those who chose the worse
mode, and keeps `alt`, find-in-page, CSS and selection. Deferred, not scheduled;
raise it only if a real book makes node count hurt.

## Arguments against, recorded so they are not re-discovered

- **It is inherited public API.** Upstream `page-flip@2.0.7` shipped
  `loadFromImages` publicly (though its README never mentions canvas once). True
  — but 3.0.0 is a major, is not published, and already breaks that signature.
  This is the cheapest moment the decision will ever be available; after publish
  it is permanent.
- **Phase 2 was just implemented.** Sunk cost. Shipping it to avoid the feeling
  of waste is the actual error.

Neither survives contact.

## Consequences

**Open inventory items that disappear with canvas** (7): A2 (hard-page canvas
rendering), A3 (fit modes), A4 (image error event), D1 (canvas accessibility),
G3 (eager resource model), F1 (React binding for images), F3 (canvas example).
Also Codex round 11 blocker #3 (canvas-loader ownership transition), and the
four known-wrong `canvas-phase2.spec.ts` e2e tests.

**Also removed:** the `imageError` event that was specified but never
implemented, lazy loading, eviction, disposal, the scheduler contract, and the
`58 → 62 kB` size-ceiling raise made for Phase 2 — that headroom should be
reclaimed and the ceilings lowered again once the removal lands.

**Not affected — and this matters most.** The §4.1 portrait back-flip fix, the
reason this fork exists, lives in the flip state machine and shared collection
and render helpers, **not** in a renderer. Removing canvas does not touch it.

## Follow-ups decided at implementation

- **`portraitBackCurl` / `portraitForwardCurl` removed** with the canvas work
  (owner-approved): dead argument-less aliases of `portraitCurlLocal`.

## Deliberately NOT decided here

- Whether HTML mode gets virtualisation.
