# API contract — the 3.0 lock

**Status: LOCKED (2026-08-30).** Judged from the consumer's chair: someone who
`npm i`s this to ship a reader, styles it with their design system, draws their
own chrome, and deep-links pages. Every item below carries a verdict. **The
surface is frozen**: reviews may find bugs in the implementation of this
contract, but may not propose surface changes — those are filed in
[TODO.md](./TODO.md).

The rule used throughout: **an API is right when the consumer's obvious code is
correct code.** Where the obvious code was wrong (styling the leaf root, deriving
`canGoNext` from the head index, reading `page` as "the visible page"), the
surface changed to make the obvious code right. Where the obvious code already
works, the surface locks as-is regardless of internal untidiness.

---

## 1. The consumer jobs, and whether the surface serves them

### Job 1 — "Render a book and make it look like mine" ✅ (docs missing)

The styling contract as built is genuinely good, and it is the part the review
rounds have been most stale about:

- **The paper is a CSS custom property.** `pageBackground` flows into
  `--stf-paper`, painted as an image layer over an opaque base.

  > **CORRECTED 2026-08-31 (Puddlebend consumer report, Issue 1 + Codex
  > adversarial reviews task-mtgwoxvq / task-mtgzp05z).** The original text
  > promised the `::before` paper sat "behind the leaf's own background" so a
  > consumer's root `background` would win. That was never physically true: a
  > drawn leaf carries an inline `z-index` and the stylesheet's
  > `preserve-3d`, making it a stacking context, inside which a negative-z
  > pseudo paints ABOVE the root's own background. Worse, hanging ALL opacity
  > on the pseudo left the element that receives the fold's
  > `transform`+`clip-path` transparent, which alpha-blended in landscape —
  > the report's release blocker. The corrected rule: **every drawn leaf root
  > carries the structural pair inline** (`background-color:#fff` + a
  > `var(--stf-paper)` gradient); per-page colour goes through
  > `pageBackground`/`--stf-paper` or an inner element, never the root's own
  > background. "Opaque paper, always" is Job 1 and outranks a root-paint
  > ownership that was never actually delivered.

- **The engine no longer owns `display`** and no longer wipes inline styles.
  Hiding is `visibility`-based, so a consumer's `display:flex` on a page
  survives. (Delta B3 shipped the `display` half; its second half — deleting
  the inline root `background-color` — was REVERSED by the 2026-08-31
  correction above: the inline structural pair is the opacity guarantee.)
- **The engine owns exactly** `position/left/top/width/height/clip-path` (+
  `z-index`, transforms during a fold) **and the paper pair**
  (`background-color` + `background-image`, always the structural
  `#fff` + `var(--stf-paper)` gradient) **on the leaf root**, and nothing
  else.

**LOCKED contract (amended 2026-08-31, see the correction above):** the engine
owns leaf-root _layout and paper_ (the inline structural pair); the consumer
owns leaf _content_ and paints through `pageBackground` / `--stf-paper` or an
inner element. Stable, documented selectors: `.stf__parent`,
`.stf__block`, `.stf__item`, `.--shown`, `.--left`/`.--right`,
`[data-density]`, `--stf-paper`. Everything else in the stylesheet is
unstable.

**Missing: the README section that states this.** That is the single
highest-value unshipped artifact in the repo (see §5).

### Job 2 — "Colors" ✅ after one structural fix

`pageBackground` accepts modern CSS (`oklch`, `color-mix`, `var()`) via
`CSS.supports`, rejects declaration injection, and errors loudly instead of
painting silent white. Right design. The remaining verified hole — translucent
values sneaking past the alpha parser (`var(--x, transparent)`,
`rgb(0 0 0 / calc(.5))`, `color-mix` with transparency) — is fixed
**structurally, not by a smarter parser** (§4, B3): the `::before` paper
layer paints the consumer's value _over an opaque base_, so opacity holds by
construction for every syntax CSS will ever grow. The translucency parser is
then deleted, not extended. Validation keeps only the two checks that must stay
static: injection safety and "is this a color at all".

### Job 3 — "Draw my own chrome" ✅ after payload addition

The event map is clean and locks: eight events, one snapshot shape.
`ready`/`loaded` distinguish first load from reload; `pagesChanged` replaced the
always-fired-together pair; `turnRejected` carries `direction`, `targetPage`,
`landedOn`, `code`. `flip` never fires for a repaint (ADR 0003).

One addition (§4, C4): **`visiblePages: number[]` joins `BookSnapshot`.**
Chrome's whole question is "what is on screen"; today the payload answers "the
spread head" and the consumer must make a second live call. With `visiblePages`
in the snapshot, "Page 3–4 of 12" is renderable from any event payload alone,
and the hook stops assembling state from two sources (closes Codex #7 in the
cheap direction — the expensive `getSnapshot()` redesign is rejected, the events
_are_ the snapshot channel).

**ADDITIVE 2026-08-31 (PLAN-3.1 Campaign C):** `turnProgress` joins
`FlipbookEventMap` as `{ progress: number; direction: 'next' | 'prev' }`, with
React `onTurnProgress` receiving the unwrapped payload. Fires while a turn or
user fold is in flight (value stream from fold position updates — not a frame
clock); never for instant turns (`flippingTime: 0` / reduced motion) or hover
corner peels. Direction is semantic page-index order (still `'next'` under
RTL). No synthetic terminal `1.0` / `0` — completion is `flip` / `changeState`.
Locked surface statement gains this event; removals and shape changes remain
forbidden.

### Job 4 — "Control the book" ✅ after one rename + one rule

Two symmetric triads, locked:

|              | to a page                                        | next                | prev                |
| ------------ | ------------------------------------------------ | ------------------- | ------------------- |
| **animated** | `flipToPage(p, corner?)` _(renamed from `flip`)_ | `flipNext(corner?)` | `flipPrev(corner?)` |
| **instant**  | `turnToPage(p)`                                  | `turnToNextPage()`  | `turnToPrevPage()`  |

**ADDITIVE.** `cancelTurn(): boolean` abandons an in-flight drag, programmed
curl, snap-back or hover fold without committing. Returns `false` when idle,
unloaded or destroyed. The React handle returns `false` before mount. Not
finish, pause, resume, or jump; does not emit `flip`.

Core throws typed errors (catchable at the call site); the React handle returns
`boolean` and reports through `onTurnRejected`. That split is deliberate and
documented, not unified (two audiences).

**LOCKED query rule** (fixes the "four failure conventions" finding): _content
queries are total, layout queries throw._ `getPageCount()` → 0,
`getCurrentPageIndex()` → 0, `getVisiblePages()` → `[]`, `canTurn()` → false,
`getPageElement()` → null, `isReady()`/`isAnimating()` → false — never a throw,
for any engine state. `getOrientation()`, `getBoundsRect()`,
`getBlockElement()` throw `NOT_LOADED`/`DESTROYED`, because there is no honest
empty answer for layout that does not exist. Mutators: absolute navigation
throws on invalid input; relative navigation reports refusal by boolean +
`turnRejected` (delta C8 makes the instant pair conform). One rule a consumer
can hold.

`isReady()` becomes `pageCount > 0 && loaded && !destroyed` — an empty portal
shell is not a book you can turn (§4, C3).

### Job 5 — "Customize behavior" ✅ locks as-is

All 23 settings lock with their current names, defaults, and validation. The
renames were right (each old name stated something false), the strict
validation is right (`'false'` is truthy), the authored-vs-resolved split is
right, and `LiveSetting` rejecting `hardCovers`/`initialPage` updates at
_compile time_ is the best version of that rule. `updateSettings` is live for
everything else. **No aliases** — MIGRATION.md is the migrator's tool; aliases
freeze the old lies into the `.d.ts` forever.

One addition (§4, C5): **`injectStyles?: boolean`** (default `true`).
Under a strict CSP, runtime `<style>` injection is dead on arrival; the shipped
`style.css` + `FLIPBOOK_CSS` export are the escape, but there is no way to tell
the engine "don't try". One boolean completes the CSP story.

### Job 6 — a11y ✅ locks as-is

`controls: 'auto' | 'visible' | 'none'` with the skip-link default,
`controlLabels`, `roleDescription`, `liveRegion` + `liveRegionText`, keyboard
turning, pinch-zoom preserved. This is a real accessibility story, better than
anything upstream had. **`pageLabel` is deferred to 3.1**: `liveRegionText`
already lets a consumer label front matter correctly today, so 3.1 can design
the first-class API without blocking 3.0 (README recipe now).

### Job 7 — SSR, deep links, migration ✅ API-complete, docs-empty

Controlled `page` + `pageTransition: 'instant'` _is_ the deep-link API; no
module-scope DOM access _is_ the SSR story; `usePageFlip` is the uncontrolled
convenience. All three exist and none is documented. Docs work, not API work
(§5).

---

## 2. The inventory, item by item

### Core barrel (`@gullabs/flipbook-core`)

| Export                                                                                                                     | Verdict                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PageFlip`, `PageFlipError`                                                                                                | **LOCK**                                                                                                                                                              |
| `PageFlipErrorCode`, `PageFlipErrorKind` (types)                                                                           | **LOCK** — the code union + `kind` axis + `setting` key is a genuinely good error model                                                                               |
| `FlipOptions`, `FlipSetting`, `LiveSetting`, `SizeMode`, `ReadingDirection`, `FlipOnClick`, `PointerKind`, `ALL_POINTERS`  | **LOCK**                                                                                                                                                              |
| `FlipCorner`, `FlippingState`, `Orientation`, `PageDensity` (as values)                                                    | **LOCK as values.** Codex wanted type-only; rejected — value enums give JS consumers autocomplete and spare magic strings. They are vocabulary, not extension points. |
| Event types (`WidgetEvent`, `FlipbookEventMap`, `FlipbookEventName`, `BookSnapshot`, `TurnRejected`, `TurnRejectedReason`) | **LOCK** (+ `visiblePages` on `BookSnapshot`, C4)                                                                                                                     |
| `Point`, `Rect`, `PageRect` (types)                                                                                        | **LOCK** — data types for `getBoundsRect`                                                                                                                             |
| `ensureFlipbookStyles`, `FLIPBOOK_CSS`                                                                                     | **LOCK** — the CSP/self-hosting story requires both                                                                                                                   |
| `FLIPBOOK_INTERACTIVE_SELECTOR`, `isInteractivePointerTarget`                                                              | **LOCK** — documentation-as-code for `respectInteractiveContent`; a consumer testing "will a drag start here" needs the same predicate the engine uses                |
| `DEFAULT_PAGE_BACKGROUND`                                                                                                  | **LOCK**                                                                                                                                                              |

**The barrel prune and the class-pair collapses are done.** Implementation
classes and fold algorithms are internal; nothing public names them.
[WEBGL_RENDERER.md](./WEBGL_RENDERER.md) established `Render` is the wrong
extension seam. Remaining internal hygiene (headless-controller seam) is in
[TODO.md](./TODO.md) and invisible through this contract.

### `PageFlip` methods

| Group           | Members                                                                                                                                                                                          | Verdict                                                                                                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lifecycle       | `constructor`, `loadFromHTML`, `updateFromHtml`, `updateSettings`, `update`, `clear`, `destroy`, `isDestroyed`                                                                                   | **LOCK**                                                                                                                                                                                                                                                   |
| Navigation      | the two triads (§1 Job 4)                                                                                                                                                                        | **LOCK** after `flip`→`flipToPage` rename (C2)                                                                                                                                                                                                             |
| Queries         | `getPageCount`, `getCurrentPageIndex`, `getVisiblePages`, `canTurn`, `getPageElement`, `isReady`, `isAnimating`, `getState`, `getOrientation`, `getBoundsRect`, `getSettings`, `getBlockElement` | **LOCK** under the totality rule (C1) with cloned returns (C6)                                                                                                                                                                                             |
| Events          | `on`, `once`, `off`                                                                                                                                                                              | **LOCK** — typed map, snapshot dispatch, `once` cancellable by the original ref: platform-correct                                                                                                                                                          |
| Synthetic input | `startUserTouch`, `userMove`, `userStop`                                                                                                                                                         | **LOCK as public, documented "advanced".** This is the only way to drive turns from a custom gesture system (a carousel integration, kiosk hardware, tests) — that is a _control_ capability consumers were promised, not a leak.                          |
| Wiring          | `attachMode`, `replacePages`, `getBlock`                                                                                                                                                         | **DEMOTE to symbol-keyed internal** (C7). Public signatures naming unexported types (`UI`, `Render`, `PageCollection`) recreate the exact defect the barrel prune fixed, and both can make public getters lie — they meet the `internal.ts` stopping rule. |

### React (`@gullabs/react-flipbook`)

| Item                                                                                                                                                                                                                          | Verdict                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `HTMLFlipBook` props = `FlipOptions` (minus w/h re-declared) + controlled `page`/`pageTransition` + a11y props + unwrapped event handlers                                                                                     | **LOCK**                                      |
| `FlipBookHandle` — all-boolean, `pageFlip()` escape hatch documented as "engine rules apply"                                                                                                                                  | **LOCK**                                      |
| `usePageFlip` — uncontrolled + actions; `FlipbookState` with `page`, `pageCount`, `orientation`, `canGoNext/Prev`, `visiblePages`, `lastRejection`; `goToPage` action; direct engine subscription immune to prop-spread order | **LOCK**                                      |
| Re-exports: everything a React consumer's code can mention resolves from this one package                                                                                                                                     | **LOCK** (already fixed; keep the guard test) |

---

## 3. Rejected surface changes (do not reopen)

- **Deprecated aliases** for renamed settings — the old names lied; a major is
  the one chance to stop.
- **Unify core throws with React booleans**, or `WidgetEvent` with unwrapped
  props — two audiences, deliberately; document the seam.
- **`getSnapshot()` / atomic-state redesign** — the events carry the snapshot;
  C4 closes the real gap for a fraction of the surface.
- **Restore `loadFromImages` / any images API** — that is canvas (ADR 0002).
  Pictures are `<img>` in HTML pages.
- **Loosen strict validation** — `'false'` is truthy; the throw is the feature.
- **Type-only enums / two-export barrel** — ergonomics beat minimalism here.
- **Publishing `Render`/`UI`/`Page` for extension** — dead-end `extends` is
  worse than no seam; the real seam is a headless controller (3.1+, see
  `docs/WEBGL_RENDERER.md`).

---

## 4. The delta — what must change so the lock is true

Ordered by consumer cost; each lands with a revert-proven test. **B-items are
behavior bugs, C-items are contract conformance.**

- **B1 — The turn verb completes on the instant path (P7, verified at HEAD).**
  On a ready book with `canTurn('next') === true`, `flipNext()` returns `false`
  with `turnRejected { reason: 'setup', code: 'COLLINEAR_SEGMENTS' }` — the
  terminal fold pose produces collinear segments in `Helper.intersectLines`,
  which throws a real `PageFlipError` that `FlipCalculation` (correctly) does
  not swallow. An instant turn (`flippingTime: 0`, `respectReducedMotion`,
  deep links) runs _only_ that terminal frame, so the exact path a11y depends
  on is the one that always fails. Fix: the terminal/collinear pose is a
  _completed fold_, not an error — resolve it as success (or a `GeometryAbort`
  the completion path handles), never a rejection. Locked with it, the honesty
  rule chrome depends on: **on a ready book, `canTurn(d)` true ⇒
  `flipNext`/`flipPrev` succeeds.** Pin: `consumer-audit.test.ts` "BUG:
  flipNext…" (passes today, asserting the failure — invert it).
- **B2 — Hard back cover is shown alone (verified).** `createSpread()` singles
  out the last leaf when `isShowCover && length > 1`, mirroring leaf 0 — a
  5-leaf cover book becomes `[0], [1,2], [3], [4]`. `hardCovers` doc already
  promises exactly this.
- **B3 — the styling contract becomes true, not just the opacity half**
  (expanded per Codex signoff #2). Four parts, one invariant — the engine
  paints paper _behind_ consumer content and touches nothing else:
  1. The `::before` paper paints the consumer's value over an opaque base
     (two-layer background: `background-color:#fff` under
     `background-image:linear-gradient(var(--stf-paper), var(--stf-paper))` —
     or equivalent). Delete `isOpaquePageBackground` and the `translucent`
     rejection; keep injection-safety and is-a-color validation.
  2. ~~Delete the inline `background-color` write on container leaf roots~~
     **REVERSED 2026-08-31 (see the §1 Job 1 correction).** This item shipped
     and was then found to be the landscape release blocker: hanging all
     opacity on the `z-index:-1` pseudo left the element that carries the
     fold's `transform`+`clip-path` transparent, and the "per-page root
     background wins" premise it served was never physically true (drawn
     leaves are stacking contexts; the pseudo paints above the root's own
     background). Current rule: EVERY drawn leaf root — container and
     replaced alike — carries the inline structural pair
     (`background-color:#fff` + `linear-gradient(var(--stf-paper,#fff),…)`).
     Do not re-delete it to satisfy this ledger entry; the pins are
     `styling-contract.test.ts` B3.2/B3.3 and the landscape e2e opacity test.
  3. **Delete `.stf__item.--shown { display: block }`** — at (0,2,0) it beats
     a consumer's `.page { display: flex }`, contradicting Job 1's display
     promise. `visibility` already carries show/hide; an absolutely
     positioned leaf is block-level without help.
  4. Tests pin the contract from the consumer's side: a class-styled flex
     page stays flex; per-page paper goes through `--stf-paper` (the
     root-`background`-wins clause is reversed with item 2 above); a
     translucent `pageBackground` still yields an opaque leaf.
     Kills the verified hole for `var()` fallbacks, `color-mix`, `calc()`
     alphas, and every future syntax, while _accepting_ strictly more valid
     CSS.
- **B5 — Instant navigation settles the in-flight turn (story-book, verified).**
  `turnToPage` calls `pages.show(page)` with no settle, so a curl in flight
  when the jump lands still runs its `onAnimateEnd` and commits a relative
  turn afterwards — overwriting the position the caller asked for. The
  animated path already has the finish-then-restart policy
  (`Flip.finishOutgoingTurn`); the instant triad gets the same one. This is
  mandatory, not polish: story-book's `jumpToLeaf` works around it today with
  `api.getRender().finishAnimation()` + `turnToPage`, and `getRender()` is
  now symbol-keyed — without this fix the flagship consumer's
  scrubber/deep-link jump has no correct expression in 3.0. Locked rule:
  **after `turnToPage(n)` returns, the book is on `n`'s spread and stays
  there** — no later commit from a superseded animation may move it.
  **Re-entry is specified** (Codex signoff #1, tightened round 2): settling
  the outgoing turn commits it and emits `flip` synchronously, and a listener
  may react. The rule is a **barrier, not a cleanup** — a cancel-afterwards
  cannot catch a nested `flippingTime: 0` turn that commits inside the
  dispatch. For the duration of the jump's synchronous window, **every turn
  request from inside its dispatch is refused** — animated, instant, relative
  or absolute alike — returning `false`/no-op. **Refusals inside the barrier
  do not emit during the window** (round-3 #1: a `turnRejected` listener that
  requests a turn would otherwise recurse forever — refusal → event → request
  → refusal); the synchronous `false` is the caller's answer, and the engine
  emits **at most one** `turnRejected { reason: 'superseded' }` after the
  jump settles, iff anything was refused. The recursion case gets its own
  test: a `turnRejected` listener that calls `flipNext` must terminate with
  the book on `n` and exactly one superseded event. The jump wins uniformly. This
  deliberately differs from the animated path's newest-turn-wins refusal —
  that rule exists because a superseded _animated_ turn's geometry was
  computed against a spread the book has left; `show(n)` has no geometry to
  stale. **Lifecycle is revalidated after the settle** (round-2 #3): if a
  listener destroyed the engine, cleared it, or replaced the collection
  during the dispatch, the jump stops without effect and without error — the
  book it was asked about no longer exists, and that teardown was the
  caller's own listener acting on newer information. Both re-entry cases get
  revert-proven tests.
- **B4 — CLOSED AT HEAD (Codex signoff #5, verified).** The false `forwardRef`
  warning is already removed, and a child whose ref slot is still null after
  commit gets a precise `DETACHED_PAGE` throw naming the index — louder and
  better than the warning this delta originally asked for. Nothing to build;
  the ledger rows for P2/B3-examples point here.
- **C1 — Query totality rule** — make `getPageCount`/`getCurrentPageIndex`
  total (0 pre-load) to match the rest; document the layout-queries-throw half.
- **C2 — Rename core `flip(page, corner)` → `flipToPage(page, corner)`** — the
  React handle already uses the right name; the two triads become symmetric.
- **C3 — `isReady()`** additionally requires `getPageCount() > 0` (resolves
  P12: "ready" on the empty portal shell).
- **C4 — `BookSnapshot.visiblePages: number[]`** — derived at emit time from
  the collection (the engine already owns the rule).
- **C5 — `injectStyles?: boolean` setting** (default `true`) for strict-CSP
  hosts. **Construction-time, end to end** (Codex signoff #3, tightened
  round 2): styles are injected at load, so this is not a live setting — it
  joins `hardCovers`/`initialPage` in the `LiveSetting` `Omit` (a runtime
  `updateSettings({ injectStyles })` is a compile error) and joins the React
  binding's `remountKeyOf`, so a prop change rebuilds the engine instead of
  silently no-opping. Tests (round-3 #2 — a false-only mount proves nothing
  about the remount key): in a clean document, mount through React with
  `injectStyles={false}` and assert no `<style data-gullabs-flipbook>`; then
  rerender the same tree with `injectStyles={true}` and assert the style
  appears — observable only if the prop participates in `remountKeyOf` — plus
  a `@ts-expect-error` pinning `updateSettings({ injectStyles })` as a
  compile error. **And the runtime half** (round-4): the type `Omit` binds
  only TypeScript callers, so engine `updateSettings` also **refuses a
  changed `injectStyles` at runtime** with `INVALID_SETTING` — the same
  construction-time refusal it already applies to `hardCovers` and
  `initialPage` — with a JS-shaped test (an untyped call passing
  `{ injectStyles: false }` must throw, not silently no-op).
- **C6 — Clone the two observation returns** — `getSettings()` returns a copy
  (spread + frozen `pointerInput` slice), `getBoundsRect()` returns a copy.
  Mutating an observation must not mutate the engine (verified Codex #5).
- **C7 — Symbol-key `attachMode`, `replacePages`, `getBlock`** per the
  `internal.ts` stopping rule; public signatures may no longer name unexported
  types. Also resolves P11 (dual `getBlock`/`getBlockElement`): one public
  name remains, and it is the portal target.
- **C8 — The instant relative turns get an honest boundary** (Codex signoff
  #4). `turnToNextPage`/`turnToPrevPage` currently delegate to a silent
  boundary no-op, so a direct core consumer cannot tell success from refusal
  — the exact chrome-lies failure the animated triad already solved. Locked:
  they return `boolean` and emit `turnRejected { reason: 'boundary' }` at the
  edge, exactly like `flipNext`/`flipPrev` — the two triads differ **only**
  in animation. (The Job 4 "all mutators throw" sentence is narrowed
  accordingly: absolute navigation throws on invalid input; relative
  navigation reports refusal by boolean + event.)

## 5. The docs the contract obligates (release blockers, not API work)

README rewrite: quickstart whose obvious code is correct (counter via
`onLoaded`, killing "Page 1 of 0"), the **Styling** section (§1 Job 1 contract

- stable selector table + "style an inner wrapper" rule), common-mistakes
  (strict validation, `page` without `onPageChange` is a locked book), deep-link
  recipe (controlled `page` + `'instant'`), SSR note, CSP note, RTL note,
  `controls="visible"` + `hardCovers` example, front-matter labels via
  `liveRegionText`. MIGRATION.md covers every rename plus `flip`→`flipToPage`.

Also required of the docs surface:

- **MIGRATION matches the live façade** — no deleted getters (`getUI`,
  `getRender`); `public-surface.test.ts` allowlist is the source of truth.
- **One portal sentence**: a React host portals into `getBlockElement()`,
  always.
- **Styling the built-in controls**: `controls="visible"` + stable
  `data-flipbook-kb` / `data-flipbook-controls` attributes; the render-prop
  seam is [TODO.md](./TODO.md), not this release.

## 6. Deferred (additive / internal)

The canonical backlog is **[TODO.md](./TODO.md)**. Headlines: `pageLabel`,
`validateFlipOptions`, controls styling seam, spread-space position,
`<FlipPage>`, shadow / paper-base tokens, headless-controller renderer seam,
F06 turn lifecycle. None reopens this locked surface.

`turnProgress` / `onTurnProgress` already shipped (additive under Job 3).
Class-pair collapses are done (internal). Accepted constraints that are not
work items: [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md).

## 7. Historical triage

Pre-publish B/H/P findings (example authoring, test writing, consumer expert)
were dispositioned against this contract. Ship-bar items closed; remaining
additive work is in TODO; rejected items are in §3 and KNOWN-LIMITATIONS.
The original review write-ups are gone from the tree (git history only).

## 8. The acceptance consumer — story-book

`/Volumes/SSD/code/work/story-book` is the real product this fork serves: a
picture-book reader (Next.js, desk spread / phone single-leaf, deep-linked
`?spread=` URLs, its own chrome and gesture layer). Its migration branch
(`story-book-flipbook-3`) already builds against an Aug-28 3.0 tarball —
pre-design-tranche — and is moving from image-only leaves to **full HTML
pages**. Its reader (`apps/web/components/reader/book-reader.tsx`) is the
acceptance test for this contract: **3.0 ships when this component works on
the released tarballs with no engine monkey-patching.**

What it needs, and where the contract covers it:

| story-book need                                                           | Coverage                                                                                                                                                 |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portrait BACK curl on phones without `installPortraitBackCurl`            | The flagship engine fix; migration branch already deleted the patch. Real-phone verification remains the release gate.                                   |
| Reduced-motion / instant turns (`flippingTime`, `respectReducedMotion`)   | **Delta B1 (P7)** — currently the instant path fails; this consumer's a11y users hit it directly                                                         |
| Instant jump during an 800 ms curl (spread dots, deep-link restore)       | **Delta B5** — `turnToPage` settles the in-flight turn; replaces the now-unreachable `getRender().finishAnimation()` workaround                          |
| Own gesture layer on phones (engine pointers off, taps/swipes classified) | `pointerInput: []` — the capability `useMouseEvents: false` only delivered by accident                                                                   |
| Center seam / `BookSpine` gutter overlay on the desk spread               | Root `className`/`style` preserved (locked), `startZIndex` + wrapper stacking stable; **§5 gains the spine-overlay recipe**; built-in gutter is TODO 3.1 |
| Closed-cover half-page offset, cover-as-leaf-0                            | `hardCovers` + delta B2                                                                                                                                  |
| Deep link + desk↔phone remount restore (`startPage`, `onInit`)            | `initialPage` + `ready`/`loaded` snapshots; leaf↔spread mapping stays app-side by design                                                                 |
| `onFlip(e.data: number)` leaf index for URL sync                          | `onPageChange(snapshot)` — richer, one shape                                                                                                             |
| Full-bleed `<img>` leaves migrating to full-HTML pages                    | The Job 1 styling contract + README section; leaf content is untouched by the engine                                                                     |
| `WidgetEvent` type import from the React package                          | Kept (the §7 rejection is validated by this real import)                                                                                                 |
| `pageBackground: '#f4efe6'` paper                                         | Passes; delta B3 makes the opacity guarantee structural                                                                                                  |

**Migration notes this consumer forces into MIGRATION.md:**

- Its exact current props `sizing: 'fixed'` (as `size="fixed"`) **plus**
  `minWidth/maxWidth/minHeight/maxHeight` now **throw `INVALID_SETTING`** —
  correctly, the bounds were dead config under fixed sizing — and MIGRATION
  must show the one-line fix (delete the bounds) rather than let the first
  mount of the migrated reader be a crash.
- The renames it hits: `startPage`→`initialPage`, `size`→`sizing`,
  `showCover`→`hardCovers`, `useMouseEvents`→`pointerInput`,
  `showPageCorners`→`foldCornerOnHover`, `mobileScrollSupport`→`allowTouchScroll`,
  `clickEventForward`→`respectInteractiveContent`, `disableFlipByClick`→`flipOnClick`,
  `onFlip`→`onPageChange`, `onInit`→`onReady`/`onLoaded`.
- §5 gains the **spine/gutter overlay recipe** (absolutely positioned overlay
  above the book root at `left: 50%`, `pointer-events: none`, engine stacking
  contained by a `position: relative; z-index` wrapper — story-book's
  `BookSpine` is the reference implementation).

The release-plan dogfood step runs **this app** against the packed tarballs —
a synthetic demo proves less than the consumer the fork exists for.
