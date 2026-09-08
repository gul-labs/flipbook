# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Before making any change, read [`AGENTS.md`](AGENTS.md)** — working
> standards for AI agents in this repo, written from the actual mistakes made
> during the 3.0.0 push (coordination, test honesty, scope discipline,
> release verification). This file covers what the code is; that one covers
> how to work on it.

## What this is

A maintained fork of the abandoned [Nodlik/StPageFlip](https://github.com/Nodlik/StPageFlip) (`page-flip@2.0.7`) and [Nodlik/react-pageflip](https://github.com/Nodlik/react-pageflip) (`2.0.3`), merged into one pnpm monorepo and published by GulLabs as `@gullabs/flipbook-core` + `@gullabs/react-flipbook`, starting at **3.0.0**.

The point of the fork is to fix upstream's long-standing bugs **inside the engine** rather than by monkey-patching private methods from outside.

Upstream import points are tagged: `upstream-page-flip-2.0.7`, `upstream-react-pageflip-2.0.3`. Diff against those to see what the fork actually changed.

## Commands

```bash
pnpm install            # pnpm 10.34.5, Node >=22.18.0 (.nvmrc pins 24)
pnpm test               # vitest run, both projects
pnpm build              # tsup per package (see caveat below)
pnpm typecheck          # tsc --noEmit per package
pnpm lint               # eslint flat config, repo-wide
pnpm size               # size-limit on the packed html engine (64.1 kB raw / 15.8 kB brotli / 17.8 kB gzip)
node ./scripts/check-isolated-types.mjs   # pnpm-isolated consumer type fixture
```

Single test file / single test:

```bash
pnpm vitest run packages/core/tests/portrait-back.test.ts
pnpm vitest run --project react -t 'onUpdate fires'
```

Vitest uses `projects`: `core` (node env, `packages/core/tests`) and `react` (jsdom, `packages/react/tests`). Both alias `@gullabs/flipbook-core` / `@gullabs/react-flipbook` to **`src/`**, so unit tests never exercise the built `dist`.

`tsc` does **not** honour those aliases, and used to resolve the same imports
through `node_modules` to `dist/index.d.ts` — so `pnpm typecheck` graded the
test suite against whatever `pnpm build` last emitted. The three
test-including tsconfigs now carry a matching `paths` mapping. Do not add one
to `packages/react/tsconfig.json`: tsup reads it for the dts build. The
published `.d.ts` is still the contract and is still guarded, by
`fixtures/isolated-consumer`, which resolves the built `dist/index.d.ts` with
`skipLibCheck: false`. Note it LINKS the workspace (`workspace:*`) rather than
installing a packed tarball, so it proves the emitted types resolve and
typecheck — not that the `files` list or the `exports` map are correct. Only
`pnpm pack` proves those.

Playwright (`e2e/`) runs in CI on Chromium and WebKit. Its `webServer` builds
the packages and the vanilla example itself, so a bare run works:

```bash
pnpm exec playwright install --with-deps chromium webkit
pnpm test:e2e
```

Golden screenshot baselines are per-platform and both sets are committed;
CI compares against the `-linux` ones. Regenerate those in CI's own container
with `pnpm test:e2e:golden:update:linux` (see `e2e/README.md`).

## Architecture

Two packages, one direction of dependency: `react` → `core` (`workspace:*`). Core has **zero runtime dependencies** and must stay that way.

### Core engine (`packages/core/src`)

`PageFlip` is the façade and the event emitter (extends `EventObject`). It owns four collaborators created in `loadFromHTML` (canvas mode was removed — ADR 0002; there is no `loadFromImages`):

- **`UI`** — all DOM contact. One Pointer Events path (no separate mouse/touch), `ResizeObserver` + `visualViewport`. It builds `.stf__parent > .stf__wrapper > .stf__block` and **moves the caller's page elements into `.stf__block`**. Styles are injected at runtime by `ensureFlipbookStyles()` (`styles.ts`) and also shipped as `@gullabs/flipbook-core/style.css`.
- **`Render`** — the rAF loop, layout rect, orientation detection, shadows, z-order, and the local↔global coordinate conversion.
- **`Flip`** — the flip state machine (`READ` / `FOLD_CORNER` / `USER_FOLD` / `FLIPPING`), delegating math to `FlipCalculation`.
- **`PageCollection`** — pages, spreads (portrait = 1 page per spread, landscape = 2), and which leaf is the mover vs the leaf underneath. (`HTMLPageCollection` remains a one-release internal alias.)

The former abstract/concrete pairs (`UI`/`HTMLUI`, `Page`/`HTMLPage`,
`Render`/`HTMLRender`, and `PageCollection`/`HTMLPageCollection`) are
**collapsed** — see `docs/ABSTRACTION-BOUNDARY.md` and `docs/PLAN-3.1.md`. The
abstract bases were never a renderer seam: `Render` holds ~78% of the renderer
and is DOM-bound (`offsetWidth` measurement, a `navigator.userAgent` sniff,
pixel-space conversion). Do not re-open inheritance at these lines.

`PageFlip` answers questions rather than handing out its collaborators:
`getVisiblePages()`, `canTurn(dir)`, `getBlockElement()`, `getPageElement(i)`,
`isReady()`, `isAnimating()`. The old `getRender` / `getUI` /
`getPageCollection` / `getFlipController` / `getPage` getters are symbol-keyed
internals now — they leaked a mutable model (`getPages()` returned the live
array) and forced the React binding to reimplement spread rules that then
drifted. Add a façade answer; never re-open a collaborator getter.

Input flows `UI` → `PageFlip.startUserTouch/userMove/userStop` → `Flip.fold/flip/showCorner/stopMove` → `Render.startAnimation(frames)` → per-frame `Flip.do()` → `Page.draw()`. Page turns are committed by the animation's `onAnimateEnd` calling `PageFlip.turnToNextPage/turnToPrevPage`.

The fork's fixes are factored into small, unit-testable modules so the
invariants can be locked down: `geometry.ts`, `Collection/flippingPage.ts`,
`Render/bottomPage.ts`, `Render/pageBackground.ts`, `reducedMotion.ts`,
`errors.ts`. Prefer extending those over inlining logic back into
`Flip`/`Render`. They are NO LONGER exported from the public barrel — tests
deep-import from `../src/`, and testability never justified the export.

### React binding (`packages/react/src`)

`HTMLFlipBook.tsx` is the whole binding (`forwardRef`, `'use client'`). Its structure is load-bearing and easy to break:

- children are wrapped, each page element written into an INDEX-KEYED slot
  (`slotsRef`); a null slot after commit means that child never called its ref,
  and `readNodes()` throws `DETACHED_PAGE` naming it. Append-order collection
  silently produced a SHORTER list than the page list, so every index the
  binding computed was against a different list than the engine's;
- one effect constructs/destroys the engine, keyed on `remountKeyOf(props)`
  (`hardCovers`, `initialPage` — the only genuinely construction-time settings).
  `width`/`height` are live, and so is `sizing`: it was in the key and is not,
  because `updateSettings` recalculates layout for it and remounting lost the
  current page for a change the engine absorbs;
- one effect binds event handlers **before** calling `loadFromHTML`/`updateFromHtml` — this ordering is the §4.3 `onUpdate` fix, do not reorder;
- one effect pushes runtime-updatable settings via `engine.updateSettings(partial)`;
- one effect drives the controlled `page` prop.

React owns the page elements and **portals** them into the engine's `.stf__block`, so React's recorded parent matches the real one. `UI.updateItems` adopts and releases individual leaves rather than wiping the block. Any change to how children are keyed, reordered, or removed risks a React/DOM ownership conflict — verify in a browser, not just jsdom. See "Who owns which DOM node".

## Invariants that must not regress

These encode the flagship fixes; there are unit tests for each, but the tests passed downstream while the live behavior was broken, so **verify visually too**.

- **Portrait BACK animates a temporary copy of the _current_ leaf**, not `pages[current - 1]` (`getPortraitFlippingPage`). Hard pages return `this` from `newTemporaryCopy()` and stay on the vendor previous-leaf path.
- **The local curl is identical for both directions**, ending at `to.x = -pageWidth` (`portraitCurlLocal`). BACK reads as a rightward on-screen curl only because `convertPageToGlobal` mirrors x. A "smarter" back curl with `to.x > pageWidth` re-creates the slide-in regression.
- **The bottom page is skipped only when `flippingPage === bottomPage`** (`shouldDrawBottomPage`), i.e. the hard-cover case — not "portrait AND back" as upstream did.
- **The fold is opaque** via `pageBackground` (default `#fff`), applied to the temporary copy and to `Page.draw`.
- **`flippingTime: 0` is instant, not an error**; `respectReducedMotion` (default true) makes turns instant under `prefers-reduced-motion`. Instant turns run `onAnimateEnd` synchronously inside `startAnimation` — anything that inspects `calc`/state after calling `flip()` must not treat that as failure. `Flip.flip/flipNext/flipPrev` return a boolean for exactly this reason.
- **`turnToPage` / `flipToPage` throw `PageFlipError`** instead of silently
  landing one page forward. `flip` / `Flip.flipToPage` ALSO return a boolean —
  `false` only when a newer turn overtook this one, which is not an error and
  was previously indistinguishable from success.
- **No `window`/`document` at module scope** (SSR); guard with `typeof … === 'undefined'`. `packages/core/tests/ssr-import.test.ts` runs in the node environment to enforce this.
- **Engine state is nullable inside, non-null at the boundary.** `pages`,
  `render` and `ui` only exist after a load, so they are typed `| null`; the
  public getters keep non-null signatures and throw `PageFlipError('NOT_LOADED')`.
  Do not "simplify" either half — `!` hands callers `undefined`, and `| null`
  getters break every consumer for a state they cannot observe.
- **The fold's opacity is STRUCTURAL, not validated.** There is no opacity
  check any more, deliberately: two generations of alpha parser were defeated
  in turn (the first did not understand `rgb(0 0 0 / 50%)`, the second fell to
  `calc(.5)` alphas, `color-mix(… transparent 50% …)` and `var()` fallbacks),
  and every parser is one CSS release from a syntax it has not met.
  `.stf__item::before` now composites `var(--stf-paper, #fff)` OVER an opaque
  base, so a translucent value blends with white instead of revealing the page
  underneath. `pageBackground` validation checks only injection safety and "is
  it a colour at all" — do not re-add an opacity check and do not remove the
  `::before` layer.
- **`react` stays a peer dependency (`>=18`)** and the shipped types must survive pnpm's isolated `node_modules` — that is what `fixtures/isolated-consumer` guards.
- **Turns are bounded by spreads, not page indices.** `getCurrentPageIndex()` is `spread[0]`, so in landscape it is below `pageCount - 1` even on the last spread; checking pages there let a turn start and read past the end of the spread list.
- **`readingDirection: 'rtl'` mirrors the turn direction, never the pointer coordinates.** Mirroring coordinates makes the fold run away from the finger; the inversion belongs in `Flip.getDirectionByPoint` (user input) and `UI.swipeDirection`, and programmatic turns pass an explicit direction so they stay index-ordered.
- **A setting must be read where it is used, not cached at construction.**
  `updateSettings` mutates the shared settings object in place, so `Render` and
  `UI` see changes for free — unless someone copies a value into a field.
  `swipeDistance` shipped cached and silently ignored every runtime update.
  Engine `updateSettings` refuses a changed `hardCovers` or `initialPage`
  (baked in at load), and its parameter type is `LiveSetting`, so passing one
  is a compile error rather than a runtime warning. The React binding remounts
  on `hardCovers` and `initialPage` (`remountKeyOf`).
- **Core compiles under `strictNullChecks`.** The published `.d.ts` is the contract; do not silence a null with a cast that makes a public getter lie.

## Who owns which DOM node

This is the subtlety that breaks bindings. React renders the page elements, but
the engine styles and positions them, and they physically live inside the
engine's `.stf__block`. They are therefore **portalled** into that block
(`createPortal`) rather than rendered as children of the component root: React's
recorded parent has to match the real one, or removing / reordering children
throws `NotFoundError`. Two consequences to preserve:

- The mount effect calls `engine.loadFromHTML([])` to build the DOM shell before
  any page exists, so the portal has a target. Pages arrive via `updateFromHtml`.
- `UI.updateItems` adopts and releases individual leaves; it must never wipe
  `.stf__block` wholesale (that also deletes the render's shadow elements and
  nodes React still owns).

The collection is rebuilt **only when the page nodes themselves change**
(reference comparison against `loadedNodes`). Every flip re-renders the parent
and hands the effect new React elements for the same DOM nodes; rebuilding there
tears the book down mid-animation.

## Known gaps in the current state

- **Bundle size.** The packed HTML engine is **64.07 kB raw / 15.72 kB brotli /
  17.72 kB gzip** against ceilings of **64.1 / 15.8 / 17.8 kB**, re-ratcheted
  after F03 mid-turn resize cancel + F05 `cancelTurn`. An
  agent may not raise ceilings without cause (AGENTS.md §2). Re-measure with
  `pnpm size` before quoting these. The §5 target of 35 kB minified is
  **retired**: upstream `page-flip@2.0.7` is itself 44,058 B minified (measured
  from its published tarball), so that target asked this fork to be ~20% smaller
  than the thing it forks while doing strictly more. See
  `docs/QUALITY_BAR_CLIMB.md` for the measured comparison, and `AGENTS.md` §2
  for the policy: dead code always goes, working code never goes to buy bytes,
  and a correctness fix may spend the headroom **and say so**.
- **TypeScript is pinned below latest.** 6.0.3, not 7.0.2, because
  typescript-eslint 8.68 declares `typescript: <6.1.0` and TS 7 would install
  cleanly and then silently disable every type-aware rule. `ignoreDeprecations`
  in `tsconfig.base.json` is a shim for tsup hard-coding `baseUrl` into its dts
  build; drop it when tsup stops.
- **The release path needs an `NPM_TOKEN` secret.** Publishing uses the token +
  provenance path, matching `gul-labs/any-llm`. Moving to npm trusted publishing
  is worthwhile but needs per-package setup on npmjs.com first — see
  `RELEASING.md`.
- **pnpm is 10.34.5, not 11.** pnpm 11 enables `minimumReleaseAge` by default,
  which rejects lockfile entries for anything published in the last day — so CI
  would fail `--frozen-lockfile` on someone else's release schedule. Note this
  diverges from any-llm (pnpm 9 / Node 20); the fix there is to bring that repo
  up, since Node 20 went end-of-life in April 2026.

## Deferred design work

`docs/WEBGL_RENDERER.md` records the analysis behind a 3D renderer, deferred by
the owner on 2026-08-28. Read it before proposing one, and before proposing a
renderer plug-in system — its conclusion is that `Render` is the wrong seam and
a headless state controller is the right one, which is not the obvious answer.

## Releasing and licensing

Publishing runs from `.github/workflows/release.yml` (Changesets + npm provenance) on pushes to `main`, never from a laptop. Both packages move together (`fixed` in `.changeset/config.json`). The first 3.0.0 publish comes from the already-committed versions with no pending changeset; later releases go through `pnpm exec changeset`.

`LICENSE`/`NOTICE` must keep the upstream Nodlik MIT notices verbatim alongside GulLabs' own, and the README must keep the "forked from" attribution. Every engine fix should reference its upstream issue in `CHANGELOG.md`, and any change to the drop-in `HTMLFlipBook` prop surface must be documented in `MIGRATION.md`.
