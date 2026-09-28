# PB-11 — Live-text highlight contract: guarantees we build on, and the tests we ask for

**From:** Puddlebend (picture-book house; ages 2–7 catalogue)
**To:** GulLabs flipbook maintainers (`@gullabs/flipbook-core`, `@gullabs/react-flipbook`)
**Date:** 2026-09-27
**Consumer pin:** 3.2.1 (web `HTMLFlipBook`, iOS vanilla `PageFlip`)
**Priority (our label):** Want soon
**Type:** Documented guarantees + engine-side regression tests. No new API. No audio, cues, karaoke or auto-flip in core (owner decision, unchanged; see PB-10).

Companion documents on our side: `puddlebend/docs/live-text/SPEC.md` (LT-9), `RESEARCH.md` §B.

## Why now

We are moving the website reader from per-page JPEG leaves to the same live HTML leaves the iOS reader uses, and adding a line-level "Read to me" wash: one `<span data-token-id="<leaf>/<block>/L<n>">` per typeset line, and a narration clock that marks the line being read. `docs/LIVE-PAGE-FACES.md` is the contract we rely on. The clone and input behaviour below exists today, but needs engine-side regression tests. G6 records the actual event order rather than promising an unavailable pre-clone signal.

## What we do (so you can see the seam)

- We **do not** rewrite a stylesheet rule per line (the documented example). Rewriting a rule keyed on `[data-token-id]` makes every token on every mounted page a style-recalc candidate in Blink and a tree walk in WebKit; a picture book mounts 30–60 leaves × ≤ 12 lines. Instead the clock runs `container.querySelectorAll('[data-token-id="<id>"]')` and toggles `data-reading` (and `aria-current`) on each match — the original **and** any temporary fold clone, since the clone copied the attribute. Style comes from one static rule:

  ```css
  [data-token-id][data-reading] {
    background-color: var(--wash);
    box-shadow: 0 0 0 2px var(--wash);
    border-radius: 4px;
  }
  [data-flipping] [data-token-id] {
    transition: none;
  }
  ```

- The wash never changes geometry (bleed by `box-shadow`, no padding/margin), so nothing the engine measured moves.
- We never swap page nodes per cue; React state for the wash does not exist. `PageCollection` is never rebuilt by the wash.
- Non-visible leaves get `inert` + `aria-hidden` on our wrapper from `visiblePages`; the clone's `inert`/`aria-hidden`/`pointer-events: none` from the engine is what we expect and rely on.

## Guarantees we ask you to document and test

| #   | Guarantee                                                                                                                                                                                                                                                                                                 | Why we need it                                                                                                                      | Suggested engine test                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| G1  | `newTemporaryCopy()` uses `cloneNode(true)` (or equivalent) and **preserves every `data-*` attribute** present at clone time on every descendant.                                                                                                                                                         | Our token ids and any `data-reading` already set must be on the fold face.                                                          | Fixture page with nested `data-*`; assert the clone's attributes equal the original's at clone time.                             |
| G2  | The engine **never resets or rewrites attributes on descendants of a clone** during its lifetime (only its own root: `data-stf-clone`, `aria-hidden`, `inert`, `pointer-events`).                                                                                                                         | We set `data-reading` on the clone after cloning when the line changes mid-turn.                                                    | Set an attribute on a clone descendant mid-`flipping`; assert it survives to clone removal.                                      |
| G3  | The clone lives **inside the same container subtree** as the original (so a consumer `querySelectorAll` on the book container finds both), and is removed after a completed turn or `cancelTurn()`.                                                                                                       | Our lookup scope.                                                                                                                   | Assert `container.querySelectorAll('[data-token-id="x"]').length === 2` during a turn and `=== 1` after the next render cleanup. |
| G4  | `respectInteractiveContent: false` + `flipOnClick: "anywhere"` (web) still starts a turn when the pointer lands on a text node / inline `<span>` inside the page, in mouse, touch and pen input; `respectInteractiveContent: true` (iOS settings) does **not** treat a plain `<span>` as interactive.     | Live text covers much of the tap zone; a parent taps on the words.                                                                  | Playwright click/tap on a `<span>` inside a page in both modes.                                                                  |
| G5  | On WebKit/iOS, a page whose content sets `user-select: none; -webkit-touch-callout: none` shows **no selection or callout** after a 600 ms press and the press still counts as a turn (or as nothing, per settings) — i.e. the engine does not re-enable selection on page faces or clones.               | Long-press must never select the story text in flip mode.                                                                           | WebKit fixture: long-press on text; assert `window.getSelection().isCollapsed` and no `selectionchange` with a non-empty range.  |
| G6  | `Flip.start()` may insert the clone **before** `changeState` emits `user_fold` / `flipping`. On normal completion, `read` may fire **before** the next render removes the clone. `changeState` reports engine state, not clone DOM lifetime; it must return to `read` after completion or `cancelTurn()`. | Our stage sets `data-flipping` (transition off) from `changeState`; it must not use that event as a pre-clone or post-removal hook. | Assert the actual state sequence and clone presence at each event for a completed and a cancelled turn.                          |
| G7  | `LIVE-PAGE-FACES.md` documents the **attribute-toggle pattern** beside the stylesheet pattern, with the invalidation trade-off and the two-element lookup, and states that Range-based and Highlight-API highlighting do not cover the clone.                                                             | Consumers keep re-discovering this.                                                                                                 | Docs.                                                                                                                            |

## What we are not asking for

- A highlight API, a narration clock, cue types, or auto-flip in core (PB-10 stands: park until a written repro shows `changeState` + `flip` + `visiblePages` racing under a real clock).
- A font/resource readiness hook (`isReady()` staying "pages loaded" is fine; the host owns `document.fonts.load`).
- A DOM lazy window for React (PB-09 unchanged).

## Acceptance

- G1–G6 each have an engine-side test that fails when the behaviour changes; G7 is in the docs. If the host needs a pre-clone notification, that is PB-10's separate event-map amendment, not a guarantee of `changeState`.
- No API change; 3.2.x patch or 3.3 docs/test release.

## If not supported

We keep relying on undocumented behaviour; a future `Page.newTemporaryCopy` refactor (say, a canvas snapshot instead of `cloneNode`) would erase the wash on the fold face with no failing test on either side. We would only notice on device.

## Repro / evidence we can provide

Our offline Playwright harness (`puddlebend/packages/reader-web/tests/browser/highlight.spec.ts`, task T5.4) exercises a cue boundary during a turn against 3.2.1 and can be pointed at a candidate build.
