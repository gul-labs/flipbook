# TODO — open backlog

**Consumer requests (requirements, justification, degrade-if-missing):**
[**requests/PUDDLEBEND-REQUESTS.md**](./requests/PUDDLEBEND-REQUESTS.md) — start
here when triaging what Puddlebend actually asked for.

Maintainer priority notes: [TRIAGED-BACKLOG.md](./TRIAGED-BACKLOG.md).  
This page is the **checklist** of open items beside the locked 3.0 surface
([API-CONTRACT.md](./API-CONTRACT.md)).

| Section                  | May reopen locked surface?          |
| ------------------------ | ----------------------------------- |
| Honesty / docs (do next) | No                                  |
| API additions            | No — additive only                  |
| Contract amendments      | **Yes — owner + ADR required**      |
| Conditional              | Evidence gate first                 |
| Internal / architecture  | No (unless it changes public types) |
| Examples & OSS polish    | No                                  |

Accepted constraints that are **not** work items:
[KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md).  
Rejected / never: TRIAGED-BACKLOG §5.

---

## Honesty / docs — do next (FB-H1…H5)

- [ ] **FB-H1** Strike stale lazyRadius “Still OOMs today” comments; mark
      PRODUCT-BUG 2026-08-30 historical; keep revert-proof tests.
- [ ] **FB-H2** Document React-only props vs core `FlipOptions` (`lazyRadius`,
      `controls`, `liveRegion`, `useKeyboard`, controlled `page`, …).
- [ ] **FB-H3** Document core unknown-settings behavior (ignored today);
      optional later: reject unknown keys with `INVALID_SETTING`.
- [ ] **FB-H4** Document stable React page-child identity across `turnProgress`.
- [ ] **FB-H5** Cross-link scrubber contract: `turnProgress` silence on
      instant/RM; settle via `flip` / `changeState` (not a “fix”).

---

## API additions (additive)

- [ ] **FB-A4 `validateFlipOptions(options): FlipSetting`** — pure preflight
      sharing `Settings.resolve` rules, so a CMS/config pipeline can reject bad
      book JSON in CI without a DOM. Until then: construction throws
      `INVALID_SETTING` with a `setting` key. **Watch bundle ceiling.**
- [ ] **FB-O6 Controls styling seam** — `controlsClassName` or a
      `renderControls` slot so design systems paint the built-in buttons without
      forking a11y. 3.0 answer: `controls="visible"` + stable
      `data-flipbook-kb` / `data-flipbook-controls` attributes.
- [ ] **FB-A2 Spread-space position** — `getSpreadCount()` / current spread
      index on the façade, for scrubbers and PDF-style pagers. Does **not**
      replace host publication-key maps.
- [ ] **`<FlipPage>` wrapper** — inner-slot page primitive so consumers never
      learn the leaf-root layout rule the hard way (style an inner wrapper).
- [ ] **`pageLabel` first-class API** — front-matter numbering ("iv") for the
      live region and chrome. 3.0 recipe: `liveRegionText`.
- [ ] **Shadow color tokens** (`--stf-shadow-*`) — brand fold shadows the way
      `--stf-paper` brands the paper.
- [ ] **`--stf-paper-base` token** — opaque ground under translucent paper is
      hard `#fff` today; dark themes wash out. Additive token (validated
      opaque) preserves the structural opacity guarantee.
- [ ] **Built-in center seam / gutter shading** — opt-in landscape spine
      (`--stf-gutter-*` or a `spine` setting). Consumers overlay their own
      today (see API contract spine recipe).
- [ ] **FB-A3 `allowTextSelection` setting** — **parked** until a product needs
      book-mode copy. `.stf__block` sets `user-select: none` for drag
      correctness; wrong for full-HTML text pages a reader may copy from.
      Needs design (drag vs selection arbitration). Not required while hosts
      use a non-engine accessible mode for selectable text.
- [ ] **FB-A1 Closed-book centering** — documented recipe first
      (`changeState` + `visiblePages` + `turnProgress`); `centerClosedBook`
      option only if the recipe stays painful. Engine parking the cover in the
      right half of the stage is physically correct; consumers hand-build
      slide-to-center today.

---

## Contract amendments (owner + ADR first)

These are **not** silent additive work. They change `FlipbookEventMap` or
other locked surface and need an explicit contract amendment before code.

- [ ] **FB-C3 Correlated turn lifecycle events (F06)** — optional
      `turnStarted` / terminal pair with a turn id for narration hosts.
      **Gate:** read-along authorized **and** `flip`/`changeState`
      insufficient. **Not required for basic WebView rendering. No audio in
      core.** See [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md).

---

## Conditional (evidence first)

- [ ] **FB-C1 Frame-time gate** — Playwright fixture measuring p95 rAF / LoAF
      during a curl on realistic leaf HTML ([QUALITY.md](./QUALITY.md)).
      Bytes are gated; frame cost is not. **Gate:** physical hitching evidence
      **or** explicit owner quality-tooling ask. Write-count already
      unit-capped (~44 mid-fold).
- [ ] **FB-C2 Core/HTML lazy window** (or safe vanilla recipe). **Gate:**
      physical jetsam after host image windowing is exhausted. Do not build
      “just in case” for 26–28-leaf picture books. `lazyRadius` remains
      **React-only** until then.

---

## Internal / architecture

- [ ] **Headless-controller renderer seam** — real extension point for a
      second (WebGL) renderer per [WEBGL_RENDERER.md](./WEBGL_RENDERER.md).
      Do not publish `Render` instead. WebGL package is **owner-deferred / not
      scheduled** (analysis only until scheduled).
- [ ] **Binding-owned leaf hosts** — engine still stamps classes/inline styles
      on consumer-rendered roots (two-owner DOM). Cleaner ownership is
      4.0-shaped and breaking for DOM-selector consumers; design first — not
      active implementation.

---

## Examples & OSS polish

- [ ] **Hosted demo + docs site** — #1 public-product gap for a visual library
      (library-as-product; not a Puddlebend App Store need).
- [ ] **StackBlitz / one-click repro starters**
- [ ] **Firefox in Playwright e2e** (Chromium + WebKit already gate)
- [ ] **Split the vanilla demo from the e2e harness** — `window.flipbook` and
      `?golden=1` are harness, not consumer teaching material. Low priority.
- [ ] **Public coverage badge** — lcov uploads in CI; wire Codecov/Coveralls
      (or equivalent) if a public % badge is still wanted.
- [x] **OpenSSF Scorecard Action + README badge** — already landed
      (`.github/workflows/scorecard.yml` + root README badge).

**Parked later (not default work):** Vue/Svelte adapters; Android WebView CI
when product Android is scheduled; generic RN adapter after a product bridge is
proven extractable.

---

## Done recently (do not re-open)

Kept only so agents do not rediscover closed work:

- [x] Class-pair collapses (`Page`/`UI`/`Render` + collection) — 2026-08-31
- [x] Frame-discipline campaign (resting redraw 0 writes; mid-fold ~44) — 2026-08-31
- [x] `turnProgress` / `onTurnProgress` — 2026-08-31
- [x] Façade methods (`getVisiblePages`, `canTurn`, …) and barrel prune
- [x] Mobile live-HTML F01–F05 (fixture, resize cancel, live faces, docs)
- [x] Mobile audit A1–A4 (orientation reentrancy, controls keyboard, audit
      canary filter, reduced-motion demo label)
- [x] `foldFill` size-1 memo; Linux golden `$IMAGE` brace
- [x] lazyRadius infinite-render/OOM (PRODUCT-BUG 2026-08-30) — **fixed**;
      tests pass; only stale comments remain (FB-H1)
- [x] Next.js example real `flippingTime` — `examples/nextjs` uses
      `flippingTime={500}` (no longer instant-only demo)
