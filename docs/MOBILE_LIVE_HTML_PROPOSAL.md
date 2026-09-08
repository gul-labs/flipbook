# Proposal: mobile support for live HTML books

Date: 2026-09-07. Status: **approved by the owner on 2026-09-07 with the conditions in "Review record" below.** Proposed work for the flipbook library owner. No engine changes or device compatibility claims are made by this document. Do not use Claude.

## Objective

Make the owned flipbook library a dependable renderer for live HTML picture books in desktop browsers and mobile WebViews: WKWebView on iPad/iPhone first, Android WebView next. Books contain separate illustrations and real text, with future narration highlighting, translated editions, and right-to-left text. A stack of rendered page images is not the target workload.

We own the library and can change its architecture and public interfaces. The recommendation is to preserve the HTML renderer, fix demonstrated lifecycle/geometry defects, and add useful lifecycle APIs deliberately. A full native renderer or headless rewrite is not required merely to display HTML inside a native app.

The immediate consumer is Puddlebend. Its first mobile app has an offline public catalogue, one available English edition per book, and no production narration yet. The library must be tested with live-text and highlighting fixtures so this narrow POC does not hide future problems. Test fixtures are not claims of published translated/narrated content.

## Scope and ownership

| Library owns                                            | Consumer app owns                                               |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| Curl geometry, painting, page faces, pointer handling   | Book content, artwork, text, language editions and fonts        |
| Binding/spread rules and authoritative engine snapshots | Mapping stable content IDs to engine leaf indexes               |
| Turn lifecycle and noncommitting cancellation           | Audio playback clock, narration timing and highlight policy     |
| React DOM ownership, lazy mounting and cleanup          | Native navigation, local assets, WebView bridge and recovery    |
| Generic browser examples, contracts and regressions     | Accounts, purchases, consent, downloads and analytics decisions |

Do not add Puddlebend-specific book schemas, Clerk, Expo, audio services, or native dependencies to the core browser engine. Keep core runtime dependencies at zero. A future reusable React Native adapter can be a separate package after the consumer proves its contract; it is not part of the first engine fix.

## Source evidence

These references describe the inspected checkout. Recheck line locations before implementation; source risks below have not been reproduced on physical devices.

| Observation                                                        | Source                                                                                  | Consequence                                                                                      |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| React binding already portals actual HTML descendants              | `packages/react/src/HTMLFlipBook.tsx:1231`                                              | HTML text support does not need a new renderer. Preserve page-node identity and React ownership. |
| A turn captures page dimensions in its calculation                 | `packages/core/src/Flip/Flip.ts:373`                                                    | An active fold assumes the captured geometry.                                                    |
| Automatic resize replaces render bounds through a different path   | `packages/core/src/Render/Render.ts:816`, `packages/core/src/UI/UI.ts:625`              | Same-orientation resizing and rotation may leave stale fold geometry. Reproduction required.     |
| Explicit settings updates have cancellation handling               | `packages/core/src/PageFlip.ts:933`                                                     | Inspect whether this invariant belongs at a shared geometry-change boundary.                     |
| Temporary page faces are DOM clones                                | `packages/core/src/Page/Page.ts:216`, `packages/core/src/Collection/flippingPage.ts:28` | Later mutations to the original text/class do not automatically update the copy.                 |
| Clone creation precedes ordinary turning-state notification        | `packages/core/src/Flip/Flip.ts:138`, `packages/core/src/Flip/Flip.ts:212`              | `changeState` is not a pre-copy hook.                                                            |
| Public jumping can finish an outgoing animation                    | `packages/core/src/PageFlip.ts:1098`                                                    | `turnToPage` is not a safe substitute for cancelling without committing.                         |
| Existing events report page changes, state, rejection and progress | `packages/core/src/Event/EventObject.ts:67`                                             | A cancelled drag need not emit `flip`; `flip` is not a universal terminal-turn event.            |
| Reentrant turns can bypass an intermediate READ notification       | `packages/core/src/Flip/Flip.ts:874`                                                    | Do not infer exactly one terminal result by counting READ events.                                |

Existing capabilities to retain: HTML pages, live settings/update methods, ResizeObserver and visualViewport integration, lazy mounting by spreads, reduced motion, hard covers, RTL, accessible controls, parked idle rendering and destruction cleanup. Engine readiness already requires pages; it does not promise that fonts and images have decoded.

## Priority 1 — Mobile compatibility fixture and resize proof

### F01: Build one representative live-book fixture

Suggested location: `examples/mobile-reader/`, with supporting assertions in `e2e/mobile-live-html.spec.ts`. These paths are proposed additions, not existing files.

Include:

- Portrait cover, inside cover, several live-text/illustration pages and back cover.
- A long paragraph, a delayed local font, a large illustration, and a text/background plate.
- A short RTL-script sample and independently controlled page-progression direction.
- Stable text identifiers and a fake narration clock highlighting words or phrases.
- Explicit next/previous controls, reduced-motion mode, and a resizable host.
- A lazy window that includes neighboring spreads; exercise a single cover opening onto two leaves.

Use owned synthetic/public fixture content; no customer material, external fonts, remote scripts or real audio generation. Bundle exported engine CSS. For drag-only reading set `flipOnClick: 'never'`, `foldCornerOnHover: false`, `respectInteractiveContent: true`, deliberate pointer kinds and `allowTouchScroll: false`; do not accidentally demonstrate different behavior through defaults. Accessible scrolling mode belongs outside the curl engine.

Acceptance: DOM contains visible real story text, no whole-page raster substitution, no duplicate accessible page copies, correct portrait/back/RTL turns, stable child node identities, no collection replacement per highlight/frame, and no idle animation loop.

### F02: Reproduce automatic resize while turning

Run the real ResizeObserver path during forward/back drag, programmed animation and snap-back. Cover same-orientation width changes, portrait/landscape transition, zero-sized hide/reveal and pointer cancellation. Record the committed page and active geometry before/after each transition.

The source suggests stale dimensions, but this is not yet a confirmed visual defect. Do not label it fixed without a discriminating failure. If it passes, retain the regression test and document why the existing path is safe.

### F03: Fix a confirmed geometry transition defect

Preferred behavior when bounds invalidate an active curl: cancel to the last committed page, clear transient faces/shadows, reset pointer/fold/animation state, then apply the new geometry. A resize must not silently advance the book or allow an old completion callback to commit afterward.

Implement at the shared geometry transition used by observed resizing and explicit updates. Do not rebuild every page collection on each observer callback, disable iPad resizing, or swallow geometry exceptions. Preserve existing zero-size handling and reentrancy protections.

Acceptance: failing fixture passes; reverting the fix demonstrably fails; at least one plausible incomplete fix also fails. Existing portrait-back, hard-cover, RTL, reduced-motion, React ownership and teardown regressions pass.

## Priority 2 — Live page-face and highlighting contract

### F04: Document and test what stays live during a curl

The engine borrows the original page and may create a visual clone. The clone already remains inert and aria-hidden. Clarify that cloning preserves current DOM attributes/text but does not create another React-managed component or synchronize subsequent mutations.

First test a simple consumer-owned solution: stable text IDs with one style rule outside all page subtrees. A selector such as `[data-token-id="sample-en-page3-word8"]` styles original and cloned elements together. Generate selectors from validated identifiers using CSS escaping. Updating the shared rule avoids per-word React updates and a new engine synchronization feature.

For range-based highlighting, create ranges for each visual representation; a range attached to the original DOM does not target the clone. Any token/span fallback must preserve text shaping, whitespace, line breaking and reading order, especially for Arabic. Do not assume the English demo proves every script works.

Do not replace a page's language/text mid-curl. The consumer should wait for an idle boundary or cancel, load the new font/content, and restore a stable semantic position. Resource readiness belongs to the host; existing update methods should be sufficient unless a fixture proves a gap. Do not add a generic MutationObserver or automatic text reflow engine without a requirement.

Acceptance: highlights behave consistently on all visible faces during forward/back turns; no duplicate speech/focus targets, text-node churn or collection rebuilds; language replacement does not retain stale geometry. Document supported/unsupported dynamic descendants honestly.

## Priority 3 — Recommended additive lifecycle features

These improve long-term mobile/audio integration. They are not prerequisites for the current no-audio POC, which can destroy/remount the reader on suspension. Keep them in separate changes from the resize fix and follow the repository's public API review/release process.

### F05: Add `cancelTurn(): boolean`

Proposed public facade and React handle method:

```ts
cancelTurn(): boolean;
```

Required behavior:

1. Synchronously abandon an active drag, programmed curl, snap-back or hover fold without committing its target.
2. Preserve the currently committed page; clear temporary faces, shadows, active pointer capture and fold/animation state.
3. Prevent previously scheduled callbacks from committing after cancellation.
4. Return true when work was cancelled, false when idle, uninitialized or destroyed. The React handle safely returns false before mount.
5. Emit no fabricated page-change event. Repeated cancellation is harmless.
6. Cancellation is not finish, pause, resume, or jump. Name and documentation must preserve that distinction.

Reuse internal cancellation/abandon/reset logic through one authoritative implementation. Test callbacks that start a new turn or destroy the engine; protect the newer generation without allowing the old one to commit.

### F06: Add correlated turn lifecycle events

Proposed names and payloads, not existing APIs:

```ts
type TurnStarted = {
  turnId: number; // monotonic within one engine instance
  from: BookSnapshot;
  direction: 'next' | 'prev';
};

type TurnFinished = {
  turnId: number;
  outcome: 'committed' | 'returned' | 'cancelled' | 'superseded';
  snapshot: BookSnapshot;
};
```

- Emit `turnStarted` after accepting a reading turn and before creating its first temporary face. Rejected boundary/not-ready requests receive no turn ID.
- Emit exactly one `turnFinished` per started turn: committed destination; dragged back to origin; explicit cancellation/resize/disposal; or replacement by a newer turn.
- Zero-duration/reduced-motion turns emit both synchronously in order.
- Preserve an outgoing terminal event when a listener starts another turn. Do not clear the newer turn while finishing the old one.
- Hover decoration is not a reading turn. If a hover copy is reused for a reading turn, explicitly refresh/reconcile that face after the start notification, or document a separate face lifecycle. Do not advertise a universal pre-clone guarantee that excludes an existing hover copy without saying so.
- Start is notification-only initially, not an asynchronous veto or consent mechanism. Specify behavior for reentrant cancellation/destruction before continuing setup.
- React forwards typed payloads through stable callback refs without rebinding/rebuilding pages. Keep existing `flip`, state, rejection and progress contracts compatible.
- Turn IDs are transient engine coordination values, not analytics identifiers. DOM-bearing events stay inside the renderer; bridge consumers serialize data only.

Before implementing, write an event-order table for each accepted/rejected/returned/cancelled/superseded path. Add types, React props, public exports, docs and migration notes together. Do not obtain a lifecycle event by emitting an extra READ or changing the meaning of `flip`.

## Validation and release sequence

| Order | Work                   | Required evidence                                                                |
| ----- | ---------------------- | -------------------------------------------------------------------------------- |
| 1     | F01 live fixture       | Compiled example, DOM/assertion checks, representative screenshots               |
| 2     | F02 resize proof       | Reproduction or documented existing correctness through the actual observer path |
| 3     | F03 conditional fix    | Failing-before/passing-after and hostile-variant evidence                        |
| 4     | F04 live face contract | Highlight/shaping/ownership/accessibility checks and consumer guidance           |
| 5     | F05 cancellation       | Optional additive API tests including stale callbacks and reentrancy             |
| 6     | F06 lifecycle          | Optional per-path ordering tests and exactly-once terminal outcomes              |
| 7     | Quality/package        | `pnpm quality:ci`, built/packed CJS/ESM/types/exports, bundle-size delta         |
| 8     | Mobile acceptance      | Physical WKWebView first; Android WebView separately before claiming support     |

Browser automation is not physical-device validation. Puddlebend can supply the native host; the library owner can complete browser fixtures and source fixes independently. Device checks must include iPad rotation/window resizing, older supported hardware, VoiceOver, actual local fonts/assets, interruption during drag, process loss/remount and repeated full-book reads. Android needs its own touch, TalkBack, resize and renderer-recovery evidence. Record device, OS/WebView version, library build and workload.

Follow this repo's existing regression and package rules, including verified revert-prove and hostile variants. Do not lower coverage, size or visual acceptance bars to pass. Inspect the actual packed packages, not only source aliases. The owner controls versioning, licensing and npm publication. Puddlebend consumes an exact released version or supplied reproducible tarballs; no machine-specific global links or copied engine source.

## Not proposed in this work

No Swift/Skia renderer, HTML-to-native-view translator, broad inheritance revival, automatic narration/translation, app-store submission, or license change. A future native renderer would justify extracting a platform-independent controller/geometry contract; do that when there is a real second renderer with demonstrated requirements.

## Owner handoff checklist

- [ ] F01 representative live HTML fixture exists.
- [ ] F02 resize risk reproduced or ruled out with evidence.
- [ ] F03 fixes only demonstrated failures, with regression proof.
- [ ] F04 live-face behavior documented and tested.
- [ ] F05 cancellation accepted/implemented or explicitly deferred.
- [ ] F06 lifecycle accepted/implemented or explicitly deferred.
- [ ] Existing web/React behavior and package contracts preserved.
- [ ] Quality results and size impact recorded.
- [ ] Device support claims distinguish tested from unverified platforms.
- [ ] Consumer receives exact artifact/version and migration instructions.

Report each item as implemented, validated, deferred or blocked with evidence. This proposal does not itself authorize publishing or assert that any potential defect has been reproduced.

## Review record

Reviewed 2026-09-07 against `b6417e2` (`fix/drop-auto-install-peers`). Every
source citation in "Source evidence" resolved to the described code. Verdict:
**approved**, ordering F01 → F02 → F03 → F04 as written, with F05 and F06
approved in principle but gated as below.

Findings that sharpen the plan:

1. **F02 should be expected to reproduce, not merely suspected.**
   `packages/core/src/Flip/FlipCalculation.ts:37` documents the invariant
   "a resize builds a new `FlipCalculation`", but the only constructor call is
   `Flip.start()` (`packages/core/src/Flip/Flip.ts:373`). The observer path is
   `UI.onResize` → `UI.update` → `Render.update` and never touches the flip
   controller, while `updateSettings` cancels via `render.cancelAnimation()` +
   `flipController.abandon()` (`packages/core/src/PageFlip.ts:933`). Existing
   resize tests (`packages/core/tests/flip-event-semantics.test.ts`, `resizeTo`)
   only resize a book at rest. Revert-prove still applies: write the failing
   test first.
2. **F03 must stay silent at rest.** The cancellation must run only when a
   turn is in flight AND the adopted bounds actually changed (`Render.ts:816`
   gates adoption on `observed`). The at-rest tests assert no events on an
   orientation-preserving resize; a fix that abandons unconditionally breaks
   them. Keep the existing zero-size path untouched.
3. **F05 is a thin public wrapper.** The `cancelAnimation()` + `abandon()`
   pair already exists at five call sites in `PageFlip.ts`; `cancelTurn` should
   call that one path and return whether a calc/animation existed. `abandon()`
   emits `changeState: READ`, not `flip`, which is the behaviour F05 asks for
   and which `flip-event-semantics` already guards.
4. **F06 touches the locked event contract.** `FlipbookEventMap` is part of
   `docs/API-CONTRACT.md`. F06 requires a contract amendment, a changeset, and
   MIGRATION notes in the same PR. Defer it until a consumer has a concrete
   narration requirement; the no-audio POC does not need it.
5. **Size headroom is ~0.12 kB raw.** F03 may fit; F05 + F06 will not. Per
   AGENTS.md §2 the ceilings may be raised for a correctness fix or a
   deliberate public API, but the PR must say so with the measured delta.
   The proposal's "do not lower size bars" line should be read as "raise with
   cause, never silently".
6. **Consumer contract stays out of core.** Confirmed: no Puddlebend schema,
   no RN adapter, zero runtime deps. The `[data-token-id]` stylesheet approach
   in F04 works because `Page.ts:216` uses `cloneNode(true)`, so attributes
   survive into the temporary face.

Optional second opinion: a Codex adversarial pass on the F03 diff before merge,
per the repo's review preference. Not required for this document.

### Second review — 2026-09-07, Claude (Fable 5.1), against `b6417e2`

Re-verified every citation in "Source evidence" and findings 1–6 above against
the checkout. **Signed off. Implementer may proceed F01 → F02 → F03 → F04.**
F05 optional; F06 deferred. Conditions, all sharpenings rather than objections:

1. **Size is at the ceiling, not near it.** Measured `pnpm size` at `b6417e2`:
   raw 63.38 / 63.5 kB, brotli 15.56 / 15.6 kB, gzip 17.54 / 17.6 kB. F03 will
   not fit in 40 bytes of brotli. Do not pre-raise the ceilings to make the
   gate green (AGENTS.md §2). Land F03 with the measured delta in the PR body,
   first paying for it where hygiene allows, then raise by exactly the delta
   in the same PR with the correctness rationale. F01/F02 add no engine bytes.
2. **F03 seam is the app, not the renderer.** `Render.update` already calls
   back into the engine through `app[ADOPT_ORIENTATION]` when orientation
   changes; a bounds-changed callback of the same shape is the right hook.
   Do not put `cancelAnimation()` + `abandon()` inside `Render`, which does not
   own the flip controller. Gate on `observed && bounds changed && calc !== null`.
3. **Orientation flip mid-turn is the worst case; test it first.**
   `ADOPT_ORIENTATION` → `PageFlip.update()` → `pages.show()` runs while a
   flipping page and its clone exist. F02 must cover this path before the
   same-orientation width change, and record whether the clone survives.
4. **visualViewport resizes that do not change container bounds must be
   silent.** Pinch-zoom and Safari toolbar collapse fire `visualViewport`
   resize without the container box changing. Add that as an at-rest and
   mid-drag no-op assertion alongside the existing orientation-preserving
   resize tests in `flip-event-semantics.test.ts`.
5. **Fixture runs under headless Playwright, not the in-app browser pane.**
   A hidden pane has no `requestAnimationFrame`, so flip timing assertions
   there are meaningless. `e2e/` already uses Playwright; keep the new spec there.
