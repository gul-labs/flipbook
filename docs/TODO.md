# TODO — open backlog

Canonical list of work that sits **below the locked 3.0 surface**
([API-CONTRACT.md](./API-CONTRACT.md)). Everything here is additive or internal.
A item that needs a breaking change goes to the owner first.

Accepted constraints that are **not** work items live in
[KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md).

## API additions (additive)

- [ ] **`validateFlipOptions(options): FlipSetting`** — pure preflight sharing
      `Settings.resolve` rules, so a CMS/config pipeline can reject bad book
      JSON in CI without a DOM. Until then: construction throws
      `INVALID_SETTING` with a `setting` key.
- [ ] **Controls styling seam** — `controlsClassName` or a `renderControls`
      slot so design systems paint the built-in buttons without forking a11y.
      3.0 answer: `controls="visible"` + stable `data-flipbook-kb` /
      `data-flipbook-controls` attributes.
- [ ] **Spread-space position** — `getSpreadCount()` / current spread index on
      the façade, for scrubbers and PDF-style pagers.
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
- [ ] **`allowTextSelection` setting** — `.stf__block` sets `user-select: none`
      for drag correctness; wrong for full-HTML text pages a reader may copy
      from. Needs design (drag vs selection arbitration).
- [ ] **`centerClosedBook` option** — engine parks a closed book in the right
      half of the stage; consumers hand-build slide-to-center. At minimum: a
      documented recipe with `changeState` + `visiblePages`.
- [ ] **Correlated turn lifecycle events (F06)** — optional `turnStarted` /
      terminal pair with a turn id for narration hosts. Touches the locked
      event map; needs contract amendment + changeset. Not required for basic
      WebView rendering. See [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md).

## Internal / architecture

- [ ] **Headless-controller renderer seam** — real extension point for a
      second (WebGL) renderer per [WEBGL_RENDERER.md](./WEBGL_RENDERER.md).
      Do not publish `Render` instead.
- [ ] **Binding-owned leaf hosts** — engine still stamps classes/inline styles
      on consumer-rendered roots (two-owner DOM). Cleaner ownership is
      4.0-shaped and breaking for DOM-selector consumers; design first.
- [ ] **Frame-time gate** — Playwright fixture measuring p95 rAF during a curl
      (see [QUALITY.md](./QUALITY.md)). Bytes are gated; frame cost is not.

## Examples & repo polish

- [ ] **Next.js example gets a real `flippingTime`** — the App Router demo
      currently proves instant page swap more than the product.
- [ ] **Split the vanilla demo from the e2e harness** — `window.flipbook` and
      `?golden=1` are harness, not consumer teaching material. Low priority.
- [ ] **Hosted demo + docs site** — #1 public-product gap for a visual library.
- [ ] **StackBlitz / one-click repro starters**
- [ ] **Firefox in Playwright e2e** (Chromium + WebKit already gate)
- [ ] **OpenSSF Scorecard Action + public coverage badge**

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
