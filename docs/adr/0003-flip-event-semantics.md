# ADR 0003 — `flip` means the page changed, not the spread repainted

**Status:** Accepted, 2026-08-30. Decided by an agent under [`AGENTS.md`](../../AGENTS.md) §5:
pre-publish, an API decision is a normal design decision made with a Codex
signoff, a domain expert, and this record of the rejected alternatives.
**Confirmed by the owner** the same day — see "Settled by the owner".

**Related:** [ADR 0002](./0002-remove-canvas-mode.md).

## Decision

`flip` fires **only when `getCurrentPageIndex()` actually changes.**

`PageCollection.showSpread` guards the dispatch, not the assignment —
`currentPageIndex = headIdx` stays unconditional. That is the whole change.

`clear()` continues to emit no `flip`, unchanged and deliberately.

## The defect

`showSpread` ended with two unconditional lines, inherited verbatim from
upstream `page-flip@2.0.7` (verified: `git show
upstream-page-flip-2.0.7:packages/core/src/Collection/PageCollection.ts` is
byte-identical here). `updatePageIndex` is a bare `dispatch('flip', …)`. So
`flip` meant **"`showSpread` ran"** — the render's left/right page references
were re-stamped — while its name, its own JSDoc ("a page number change event"),
and every consumer binding treat it as "the page changed".

Upstream never documented that. It was an accident of implementation.

Measured consequences, each traced to a public entry point:

- Mounting a `<HTMLFlipBook>` fired `onPageChange` twice, before any turn.
- `updateSettings({ drawShadow: false })` fired `flip`.
- `turnToPage(currentIndex)` fired `flip`.
- An orientation change that _preserved_ the head (landscape `[2,3]` → portrait
  `[2]`) fired `flip(2)` at a reader already on page 2.
- And the one that surfaced it: abandoning an in-flight fold on a mid-turn
  `direction` change repaints the unchanged spread, so consumers received
  `changeState: READ` then `flip: 0` for a turn that **never committed** —
  enough to drive controlled state, analytics, or an `onFlip` auto-advance.

Not a symptom, and worth recording because it was asserted in the first draft of
this ADR and is false: a **same-orientation resize does not emit `flip`**.
`Render.update` calls `app.updateOrientation()` only inside
`if (this.orientation !== orientation)`, and never calls `pages.show()` itself.

## Why this change cannot break a real turn

Within one spread table, **spread index ↔ head index is a bijection**. Portrait
pushes `[i]` for every `i`; landscape pushes disjoint, strictly ascending
groups. Two distinct spreads never share a `spread[0]`.

So in a fixed orientation, "the spread changed" and "`currentPageIndex` changed"
are the same predicate. Every real turn — `showNext`, `showPrev`, `turnToPage`
to a different spread, an animated turn's `onAnimateEnd` — necessarily moves the
index. The new rule is provably conservative: it can suppress a repaint
announcement and nothing else. That is what makes it the right change this close
to a first publish rather than a risky one.

The bijection holds only _within_ one table, which is why orientation gets its
own answer below.

## Two consequences that are correct but must be stated

**A book opening at page 0 now emits no `flip` on load at all** —
`currentPageIndex` is initialised to `0`, so nothing changes. The mount noise
disappears entirely rather than halving. Seed initial UI state from **`loaded`**
(every load, including the first) or **`ready`** (once per engine) — both carry
a `BookSnapshot` with the resolved page and count. Upstream's single `init`
event was split into those two. Adding a first-emit `flip` exception was
rejected: it would re-create precisely the mount noise being removed.

**An orientation change that MOVES the head still emits**, and should.
`flip`'s payload _is_ `getCurrentPageIndex()`; if that value changes and no
event says so, every consumer caching it is silently stale — the desync class
this repo has already paid for twice. Suppressing it would instead oblige every
consumer to know that `changeOrientation` implies a possible index move.

Known ordering quirk, pre-existing and unchanged: `updateOrientation` calls
`update()` — and therefore emits `flip` — **before** dispatching
`changeOrientation`, so the `flip` arrives while the consumer still believes the
old orientation. Recorded here so it is found rather than rediscovered.

## Why `clear()` stays silent

It moves the index 4 → 0 and emits **`pagesChanged`** (the 3.0 merge of
upstream `update` + `collectionRebuild`), no `flip`. Three reasons it must stay
that way:

1. **"The index changed" is not well-defined there.** The collection's internal
   `currentPageIndex` is still 4, while `getCurrentPageIndex()` already reports
   0 for an empty book via `resolvedPageIndex`. A rule implemented in
   `showSpread` sees 4; the consumer sees 0. `flip(0)` would report a transition
   the collection never made.
2. **`flip: 0` on an empty book names a page that does not exist** —
   `getPage(0)` throws `INVALID_PAGE`.
3. **Clearing is not a turn.** `pagesChanged` says the collection was replaced;
   `flip` means the reader moved. Adding `flip` to `clear` would contradict this
   ADR while claiming to implement it.

## Every path that can move the head — exhaustively

C5. The decision above is only as good as the list of places it applies, and
that list was never written down. All three entries into `showSpread()` and all
six callers that reach them are enumerated here so a new one cannot be added
without noticing it needs a baseline.

`PageCollection.showSpread()` has exactly three callers:

| Entry           | Moves the head?                            | Announces?        |
| --------------- | ------------------------------------------ | ----------------- |
| `showNext()`    | yes, by one spread                         | yes — a real turn |
| `showPrev()`    | yes, by one spread                         | yes — a real turn |
| `show(pageNum)` | only if `pageNum` is in a different spread | guarded           |

Everything else reaches the head through `show()`, and every one of those
callers needs a deliberate answer to "what is the baseline here":

| Caller                             | Baseline                                    | Emits                                                                                                                                                                                                         |
| ---------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PageFlip.update()`                | unchanged — same collection                 | only when an orientation change re-canonicalises the head, which it must                                                                                                                                      |
| `UI.cancelGesture()`               | unchanged — repaint after an abandoned fold | no                                                                                                                                                                                                            |
| `PageFlip.turnToPage(page)`        | unchanged — a real navigation               | **only if the head moves** — `turnToPage(currentIndex)` emits nothing, which is the defect this ADR opens with, and in landscape `turnToPage(1)` from spread `[0, 1]` is silent too, the head already being 0 |
| `PageFlip.replacePages`            | `INHERIT_PAGE_INDEX(outgoing)`              | only if the head really moved                                                                                                                                                                                 |
| `PageFlip.updateFromHtml`          | `INHERIT_PAGE_INDEX(current)`               | only if the head really moved                                                                                                                                                                                 |
| `PageFlip.attachMode` — reload     | `INHERIT_PAGE_INDEX(outgoing)`              | only if the head really moved                                                                                                                                                                                 |
| `PageFlip.attachMode` — first load | `SEED_OPENING_INDEX(start)`                 | no — opening is not turning                                                                                                                                                                                   |

The last row is C2, and the distinction between the last two rows is the whole
of it: a reload carries the outgoing index because the reader was somewhere,
while a first load has nowhere to have come from and must be seeded with the
head it is about to show. An **emptied** outgoing collection counts as a first
load — `clear()` does not null `PageFlip.pages`, so `=== null` alone missed it.

### One writer that does not go through `show()`

`PageCollection[SET_SPREAD_INDEX]` — `Flip`'s seam — writes `currentSpreadIndex`
**without** calling `showSpread()`, so it moves neither the head nor the
announcement. It is listed here because it is the one way the two indices can
legitimately disagree, and because "moves the head by one spread" above is not
true of `showNext`/`showPrev` when `Flip` has re-based first: `Flip` installs
the destination spread before committing, so the commit moves by one from
THERE, not from where the reader was.

That is also why it is symbol-keyed. From outside it produced a book displaying
one spread while believing it was on another, whose next forward turn was a
silent refusal.

The rule a new caller should apply: if a reader could have been looking at a
different page a moment ago, seed the outgoing index and let the guard decide.
If they could not — a mount, a first load — seed the head being shown, so the
guard stays silent.

## Alternatives rejected

**(b) Keep `flip` as-is; add a new event for real turns.** Ships the bug
permanently and names the workaround: the correct event becomes the obscure one
while `flip` — the one every consumer binds, the one `onFlip`/`onPageChange` map
to — stays wrong forever. It also forces `HTMLFlipBook` to either remap
`onPageChange` (the same behaviour change with more surface) or ship a knowingly
noisy one. The only argument for it is compatibility, and there are no consumers
yet.

**(c) Fix only the abandon path so it does not repaint.** Treats the symptom
that happened to be noticed; the mount double-fire, `turnToPage(sameIndex)`, the
settings push and the head-preserving re-spread all survive. It also pushes the
fix into several places that must each remember not to repaint, which is the
"every caller must remember" shape this codebase has repeatedly refactored away
from. And it is wrong on its own terms: after an abandoned fold the spread
genuinely **must** be repainted. What must not happen is the announcement.

**(d) Filter duplicates in the React binding.** The worst option. It leaves the
published, standalone engine lying to every non-React consumer, including this
repo's own vanilla example; it duplicates state in the file CLAUDE.md flags as
load-bearing and easy to break; and it cannot filter honestly — the binding
cannot tell `flip(2)` from an orientation re-spread (must pass) from `flip(2)`
after a no-op `turnToPage(2)` (must not) without re-deriving the engine's state.
Fixing a truth problem in the layer that consumes the truth.

**(e) Fire on _spread_ change rather than index change.** The closest rival. It
differs in exactly one case: landscape `[2,3]` → portrait `[2]`, where the
spread index moves but the head does not. Emitting there tells a consumer "you
flipped to page 2" when they were already on page 2 — a false positive in the
one place `changeOrientation` already covers. Rejected because the payload is
the page index, so the payload is what the predicate should be about.

**(f) Keep the unconditional emit, widen the payload to
`{ page, previous, reason }`.** A breaking change to `FlipbookEventMap['flip']`
and to `onFlip`'s public type that makes every consumer write the filter the
engine should write once. Recorded because "add context instead of suppressing"
is a plausible instinct.

**(g) Thread a `reason`/origin through `showSpread` and emit only for
turn-originated shows.** Strictly more machinery — an argument threaded through
four call chains — for a worse answer at the one place it differs: an
orientation re-spread is not turn-originated, so it would be suppressed, which
the section above argues against.

## Consequences

- `MIGRATION.md` gets a loud entry. Silently altering an inherited event's
  firing conditions is the highest-risk fork divergence there is: it compiles,
  it type-checks, every test that does not count events passes, and it surfaces
  in a consumer's analytics weeks later.
- **Correction, 2026-08-30.** This section originally said anyone using `flip`
  as a "the book repainted" signal should use `update`, "which legitimately
  means exactly that", and that nobody loses a capability. **That was wrong.**
  `dispatch('update', …)` exists at exactly one site — inside
  `dispatchCollectionChange` — so it fires only when the page collection is
  replaced or cleared, never on a repaint, a resize, or `PageFlip.update()`
  (which shares its name and does not cause it). A consumer following that
  advice binds a handler that never fires for the thing they wanted.

  There is at present **no repaint event**, and a consumer who was using `flip`
  as one does lose that capability. `update` is misnamed for what it does and is
  a candidate for renaming or removal; a real repaint signal is a separate
  question. Left stated rather than quietly patched, because this instruction
  shipped in the document that justifies the change.

- **No change is needed in `HTMLFlipBook.tsx` or `usePageFlip.ts`.** That is a
  finding, not an omission: both already re-derive index and count from the
  engine on **`pagesChanged`** (the 3.0 name for upstream `collectionRebuild`)
  rather than trusting the flip stream, which is why they survive untouched.

## Settled by the owner

**`onPageChange` is not an initialization event.** Owner decision, 2026-08-30,
and it removes the only question this ADR had left open.

The question had been whether the downstream consumer seeds its initial page
from the first `onPageChange` rather than from `onInit` — the one path where
this change is observable as a loss. The answer makes that moot: a consumer
doing so was relying on the defect, not on a contract. `flip` fired at mount
because `showSpread` announced every repaint, which was never intentional and
was never documented, here or upstream.

Worth recording WHY the wrong path was the easy one, because it is a design
lesson rather than a user error. Three things pointed at `onPageChange`:

- it fired at mount, so it appeared to cover initialization;
- it is the handler a consumer needs anyway, for turns;
- it hands over a bare `number`, while `onInit` hands over the raw event and
  expects the caller to reach into `e.data.page`.

So the correct event was the second handler, with the more awkward payload,
telling you something you appeared to already have. `usePageFlip` shows the same
instinct from the inside: it never binds `onReady`/`onLoaded` only for
initialization side-effects it already has from `initialPage`, and re-derives
on **`pagesChanged`** (and turn events) rather than treating `onPageChange` as
mount.

That asymmetry is now the only thing making the right path harder than the wrong
one, and it is worth revisiting — but as its own decision, not folded into this
one. It is recorded here so the next person finds it.
