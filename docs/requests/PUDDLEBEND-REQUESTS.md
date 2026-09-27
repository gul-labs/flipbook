# Feature & defect requests from Puddlebend

**From:** Puddlebend (picture-book house; ages 2–7 catalogue)  
**To:** GulLabs flipbook maintainers (`@gullabs/flipbook-core`, `@gullabs/react-flipbook`)  
**Date:** 2026-09-08  
**Consumer pin today:** **3.2.0**  
**Surfaces we ship:**

| Surface                                                      | Binding                                                  | Where                            |
| ------------------------------------------------------------ | -------------------------------------------------------- | -------------------------------- |
| iPhone/iPad public reader (six books, offline, account-free) | Vanilla **`PageFlip`** + `loadFromHTML` inside WKWebView | Puddlebend `packages/reader-web` |
| Web / desk storefront reader                                 | **`HTMLFlipBook`** (React)                               | Puddlebend `apps/web`            |

This file is the **consumer request log**. Each item is written so flipbook owners can triage without reading our monorepo. Internal flipbook checklist form may mirror IDs in [`../TODO.md`](../TODO.md); priority guidance from our audit is in [`../TRIAGED-BACKLOG.md`](../TRIAGED-BACKLOG.md).

### How to read priority (our ask, not your ship bar)

| Our label         | Meaning for flipbook                                                          |
| ----------------- | ----------------------------------------------------------------------------- |
| **Need now**      | Blocks honest use or creates false confidence we will mis-ship on             |
| **Want soon**     | We already work around it; library support would cut cost/risk                |
| **When evidence** | Do not build yet; open if we bring device proof or a new product phase        |
| **Nice / OSS**    | Helps the library product; does not unblock our six-book iOS reader           |
| **Not requested** | Explicitly out of scope for us — please do not schedule as “Puddlebend needs” |

### Filing bar (both sides)

We will file a **defect** against flipbook only after our reader reaches `INITIALIZED`, with book id, leaf id, device/OS, and build. Host/WebView handshake failures are ours.

---

## Need now

### PB-01 — Document that several “settings” are React-only (vanilla core ignores them)

|                      |                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Type**             | Docs / API honesty (optional tiny fail-closed behavior later)                                                                                                                                                                                                                                                                                                                                                                              |
| **Package**          | core + react + README                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Problem**          | Our mobile host constructs `new PageFlip(host, { ...readerSettings })` with `lazyRadius`, `controls`, `liveRegion`, and `useKeyboard` copied from the product spec. Those exist on **`HTMLFlipBook` only**. Core `FlipOptions` has no such keys. Unknown keys are **silently ignored**. We believed we had DOM lazy-loading (`lazyRadius: 2`) on iPad; we do not — every leaf still mounts.                                                |
| **What we need**     | 1. README + settings docs: clear table **Core `FlipOptions` vs React-only props**. 2. Call out `lazyRadius`, `controls`, `liveRegion`, `useKeyboard`, controlled `page` / `pageTransition` as React-only. 3. One sentence on unknown core keys (ignored today). Optional later: reject unknown keys with `INVALID_SETTING` so CI fails closed. 4. Vanilla / mobile-reader example note: “window DOM yourself; `lazyRadius` will not help.” |
| **Acceptance**       | A new vanilla host cannot reasonably believe `lazyRadius` works on `PageFlip`. React docs still describe lazy correctly.                                                                                                                                                                                                                                                                                                                   |
| **Why we need it**   | Memory and “ready” semantics for a WKWebView picture book are load-bearing. Silent no-ops make our release evidence lie.                                                                                                                                                                                                                                                                                                                   |
| **If not supported** | We keep shipping settings that do nothing; the next longer book or denser HTML leaf jetsams on device and we debug “flipbook lazy” for days. Agents and humans keep copying the dead knobs into new hosts.                                                                                                                                                                                                                                 |
| **Workaround today** | Host-side image windowing only; full HTML leaf list still mounts. We will strip dead keys on our side regardless.                                                                                                                                                                                                                                                                                                                          |
| **Suggested triage** | Patch docs on 3.2.x; no API break required.                                                                                                                                                                                                                                                                                                                                                                                                |

---

### PB-02 — Remove present-tense “lazyRadius still OOMs” language (defect is fixed)

|                      |                                                                                                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Type**             | Docs / test comment hygiene                                                                                                                                                                                                             |
| **Package**          | react tests (and any README echo)                                                                                                                                                                                                       |
| **Problem**          | `HTMLFlipBook` tests still say PRODUCT-BUG / “Still OOMs today” for `lazyRadius`. On current main those tests **pass** in ~50ms. Our engineers and agents treat the comment as a live blocker and avoid or re-investigate a fixed path. |
| **What we need**     | Rewrite comments to **historical** PRODUCT-BUG 2026-08-30; keep tests as revert-proof regression. No present-tense OOM claim.                                                                                                           |
| **Acceptance**       | Grep for “Still OOMs” / “currently OOMs” is empty (or only in CHANGELOG history).                                                                                                                                                       |
| **Why we need it**   | Shared library honesty; we consume your tests as contract signal.                                                                                                                                                                       |
| **If not supported** | Continued false risk; wasted triage; reluctance to use React lazy on web if we ever enable it.                                                                                                                                          |
| **Suggested triage** | Trivial docs PR.                                                                                                                                                                                                                        |

---

### PB-03 — Document scrubber / progress contract next to `turnProgress`

|                      |                                                                                                                                                                                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Type**             | Docs (behavior already correct)                                                                                                                                                                                                                                                          |
| **Package**          | core events + react `onTurnProgress`                                                                                                                                                                                                                                                     |
| **Problem**          | Our web desk stage slides the closed cover using `onTurnProgress` so the floor shadow does not jump. Instant / reduced-motion turns emit **no** progress; there is no guaranteed terminal `1.0`; hover peel is silent. That is fine if documented beside the API; easy to misuse if not. |
| **What we need**     | Short “how to build a scrubber / mid-turn UI” note: progress stream **plus** `flip` / `changeState` for commit; link [KNOWN-LIMITATIONS.md](../KNOWN-LIMITATIONS.md). Do **not** change silence semantics without an ADR.                                                                |
| **Acceptance**       | A reader implementing desk chrome from the docs alone does not expect progress on `flippingTime: 0`.                                                                                                                                                                                     |
| **Why we need it**   | We already paid for correct wiring; the next surface (or contributor) will not.                                                                                                                                                                                                          |
| **If not supported** | Mid-turn UI jumps under Reduce Motion; “progress stuck” bugs filed as engine defects.                                                                                                                                                                                                    |
| **Suggested triage** | Docs only.                                                                                                                                                                                                                                                                               |

---

### PB-04 — Document stable React page-child identity during `turnProgress`

|                      |                                                                                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Type**             | Docs (+ optional dev-only warning later)                                                                                                                                                                                   |
| **Package**          | react                                                                                                                                                                                                                      |
| **Problem**          | If page `children` get a new array/element identity every progress tick, the binding rebuilds slots and can tear the book mid-curl. Our web reader **memoizes** `pageNodes` for this reason. Mobile vanilla is unaffected. |
| **What we need**     | React README “sharp edges”: memoize page nodes; do not put per-frame state in the parent that recreates children. Point at a minimal example. Optional: dev warning if slot node identity churns while `isAnimating()`.    |
| **Acceptance**       | Documented; example does not recreate children on progress.                                                                                                                                                                |
| **Why we need it**   | Prevents a class of “flipbook is flaky” bugs when someone adds chrome state.                                                                                                                                               |
| **If not supported** | Recurring blank page / frozen curl on React hosts; blamed on core.                                                                                                                                                         |
| **Workaround today** | `useMemo` on page nodes + isolate progress state below the book parent.                                                                                                                                                    |
| **Suggested triage** | Docs first; warning optional.                                                                                                                                                                                              |

---

## Want soon

### PB-05 — Closed-book centering recipe or `centerClosedBook` option

|                                    |                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Type**                           | Docs recipe first; additive setting optional                                                                                                                                                                                                                                                                                                                                                                                |
| **Package**                        | core (+ react if setting)                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Problem**                        | With hard covers, a closed book correctly sits in the **right half** of the landscape stage (spine geometry). On a wide desk storefront that reads as “book shoved off-centre.” We implement `deskClosedOffsetPx(turnProgress, …)` in product code so the stage slides while the cover opens and the shadow tracks the curl.                                                                                                |
| **What we need**                   | **Minimum:** documented recipe using `changeState`, `visiblePages`, `turnProgress` / `onTurnProgress`, and settle events — including front cover and lone hard back cover (spread head math). **Better:** opt-in `centerClosedBook` (or equivalent) that performs the slide without each consumer reinventing N-3 back-cover head rules. Must not break physical spine placement for hosts that want the raw engine layout. |
| **Acceptance**                     | A new desk host can center the closed book without copying our proprietary offset function; mobile single-leaf portrait unchanged.                                                                                                                                                                                                                                                                                          |
| **Why we need it**                 | Parent discovery is the web desk reader. Off-centre hardcover looks unfinished for a luxury press brand.                                                                                                                                                                                                                                                                                                                    |
| **If not supported**               | Every consumer maintains fragile progress math; back-cover edge cases regress (we already fixed N-3 once). Visual polish drifts between apps.                                                                                                                                                                                                                                                                               |
| **Workaround today**               | Puddlebend `deskClosedOffsetPx` + isolated turn state (tested).                                                                                                                                                                                                                                                                                                                                                             |
| **Not a mobile App Store blocker** | Our iOS host CSS-centers the stage differently.                                                                                                                                                                                                                                                                                                                                                                             |
| **Suggested triage**               | P2 additive; recipe before new setting.                                                                                                                                                                                                                                                                                                                                                                                     |

---

### PB-06 — Public spread count / current spread index on the façade

|                                  |                                                                                                                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Type**                         | Additive API                                                                                                                                                                                                                          |
| **Package**                      | core (`PageFlip`) + react handle if applicable                                                                                                                                                                                        |
| **Problem**                      | Collection already has `getSpreadCount()` / spread index internally. Public façade exposes `getCurrentPageIndex`, `getVisiblePages`, `canTurn` — not spread space. Chrome that says “spread 3 of 8” must poke internals or re-derive. |
| **What we need**                 | `getSpreadCount(): number` and `getCurrentSpreadIndex(): number` (names flexible) on `PageFlip`, documented, tested.                                                                                                                  |
| **Acceptance**                   | Type-safe public methods; match collection; no need to import internal collection types.                                                                                                                                              |
| **Why we need it**               | Generic pagers and accessibility chrome; fewer off-by-ones at hard-cover singleton spreads.                                                                                                                                           |
| **If not supported**             | Hosts keep private math; some will misuse leaf index as spread index in landscape.                                                                                                                                                    |
| **What this does _not_ replace** | Our `buildSpreadMap` over **publication leaf keys** (desk pads, phone subset, `?spread=` URLs). That stays product binding.                                                                                                           |
| **Suggested triage**             | Small additive P2; watch bundle ceiling.                                                                                                                                                                                              |

---

### PB-07 — `validateFlipOptions(options)` without a DOM

|                      |                                                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Type**             | Additive API                                                                                                                                          |
| **Package**          | core                                                                                                                                                  |
| **Problem**          | Invalid settings throw only at `PageFlip` construction (needs host element). Our export/CI pipelines want to reject bad book JSON before any browser. |
| **What we need**     | Pure `validateFlipOptions` / `resolveFlipOptions` sharing the same rules as construction; same `INVALID_SETTING` + `setting` key.                     |
| **Acceptance**       | Node test can validate a settings object with no `document`.                                                                                          |
| **Why we need it**   | Fail book configs in CI, not on a child’s first open.                                                                                                 |
| **If not supported** | We either duplicate validation (drift) or discover bad settings only in WebView.                                                                      |
| **Suggested triage** | P2; **measure size** — packed engine is near the 66 kB raw ceiling.                                                                                   |

---

### PB-11 — Live-text highlight contract: guarantees we build on, tests we ask for

Full request: [PB-11-live-text-highlight.md](PB-11-live-text-highlight.md) (2026-09-27).

|                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Type**             | Documented guarantees + engine-side regression tests; no API change; nothing about audio, cues or karaoke in core (PB-10 stands)                                                                                                                                                                                                                                                                                                                                                      |
| **Package**          | core (`Page.newTemporaryCopy`, pointer handling) + docs (`LIVE-PAGE-FACES.md`)                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Problem**          | Our web reader is moving to live HTML leaves (one `<span data-token-id>` per typeset line) with a "Read to me" line wash toggled as an attribute on the original **and** the fold clone. We rely on: clones preserving `data-*`; the engine never rewriting clone descendants; the clone living in the same container; taps on text still turning; `user-select:none` respected on WebKit; `changeState` order around clone insert/remove. None of it is tested on the engine's side. |
| **What we need**     | G1–G6 tests and G7 docs as listed in the full request.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Acceptance**       | Each guarantee has a test that fails when it changes; docs show the attribute-toggle pattern beside the stylesheet one with the invalidation trade-off.                                                                                                                                                                                                                                                                                                                               |
| **If not supported** | A future clone refactor (canvas snapshot, attribute filtering) erases the wash on the fold face with no failing test anywhere; we notice on device.                                                                                                                                                                                                                                                                                                                                   |
| **Workaround today** | Our own Playwright harness exercises a cue boundary during a turn against 3.2.1; it can be pointed at a candidate build.                                                                                                                                                                                                                                                                                                                                                              |
| **Suggested triage** | P2 tests/docs on 3.2.x; no size impact.                                                                                                                                                                                                                                                                                                                                                                                                                                               |

---

## When evidence (do not build on speculation)

### PB-08 — Frame-time / jank CI gate on realistic HTML leaves

|                                                       |                                                                                                                                                                                                                            |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Type**                                              | Quality tooling                                                                                                                                                                                                            |
| **Package**                                           | e2e / CI                                                                                                                                                                                                                   |
| **Problem**                                           | Bytes and mid-fold **write counts** are gated; **frame cost** during a curl is not. KNOWN-LIMITATIONS still cites ~44 style writes/frame mid-fold. We have **no physical jank profile** yet proving six short books hitch. |
| **What we need _if_ we (or you) see device hitching** | Playwright fixture on realistic leaf HTML: p95/p99 rAF and long-animation-frame budgets per [QUALITY.md](../QUALITY.md). Fail CI on regression.                                                                            |
| **Acceptance**                                        | Named thresholds; real-ish pages (text + image), not empty divs only.                                                                                                                                                      |
| **Why we might need it**                              | Premium feel; richer live-HTML leaves later will regress silently if only byte size is watched.                                                                                                                            |
| **If never added**                                    | Jank can land via “correct” features; we only catch it in TestFlight anger.                                                                                                                                                |
| **If added too early**                                | Noise and thrash without product evidence.                                                                                                                                                                                 |
| **Our gate to activate the ask**                      | Physical iPhone/iPad profile shows hitching on real catalogue HTML **or** flipbook owner wants the gate as library policy.                                                                                                 |
| **Suggested triage**                                  | Conditional; not a six-book code feature.                                                                                                                                                                                  |

---

### PB-09 — DOM-level lazy window for **vanilla** `PageFlip` (or a safe recipe)

|                                           |                                                                                                                                                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Type**                                  | Feature or documented recipe                                                                                                                                                                                                               |
| **Package**                               | core (or docs + example only)                                                                                                                                                                                                              |
| **Problem**                               | React has `lazyRadius`. Our **shipping** iOS path is vanilla core and mounts **all 26–28 leaves** as HTML. Image decode is host-windowed; DOM is not.                                                                                      |
| **What we need _if_ device memory fails** | Either: (a) core API to keep far leaves out of the DOM without blank paper on turn-in, respecting clone/LIVE-PAGE-FACES rules; or (b) a blessed vanilla recipe that does the same without fighting `updateFromHtml` / collection identity. |
| **Acceptance**                            | Turn into a previously far leaf paints real content; mid-curl faces stay correct; no collection teardown storm.                                                                                                                            |
| **Why we might need it**                  | WKWebView jetsam on larger catalogues or denser leaves.                                                                                                                                                                                    |
| **If not supported when jetsam hits**     | We invent host DOM windowing under pressure; high chance of curl/blank regressions.                                                                                                                                                        |
| **If built before evidence**              | Complexity and size spend we do not need for six short books.                                                                                                                                                                              |
| **Our gate**                              | Physical jetsam after image windowing is exhausted, with traces.                                                                                                                                                                           |
| **Suggested triage**                      | Conditional P2; **not** “Need now.”                                                                                                                                                                                                        |

---

### PB-10 — Correlated turn lifecycle events (F06) — narration phase only

|                                                       |                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Type**                                              | **Locked-surface amendment** (ADR required)                                                                                                                                                                                                                                            |
| **Package**                                           | core event map + react bindings                                                                                                                                                                                                                                                        |
| **Problem**                                           | Future “Read to me” / page-synced narration is **Puddlebend product work** (audio must **not** live in flipbook — owner decision). We may still need **exactly-once turn correlation** (start id + terminal commit/cancel) if `changeState` / `flip` race under real narration clocks. |
| **What we need _if_ current events fail in practice** | Optional `turnStarted` / terminal pair with a stable **turn id**; cancel vs commit distinguishable; no audio, cues, karaoke, or auto-flip in core.                                                                                                                                     |
| **Acceptance**                                        | ADR + tests; existing hosts unaffected if they ignore new events.                                                                                                                                                                                                                      |
| **Why we might need it**                              | Narration hosts must not double-fire or miss settles.                                                                                                                                                                                                                                  |
| **If not supported when narration ships**             | Brittle host state machines; desync between native chrome and HTML; child hears wrong page.                                                                                                                                                                                            |
| **If added now**                                      | Contract churn for a phase we have not authorized.                                                                                                                                                                                                                                     |
| **Our gate**                                          | Narration scheduled **and** documented attempt to use `flip` + `changeState` + `visiblePages` fails with a written repro.                                                                                                                                                              |
| **Suggested triage**                                  | Park until gate; do **not** put sound in core.                                                                                                                                                                                                                                         |

---

## Nice / OSS (library product — not our App Store need)

We support these as GulLabs library growth. **None** unblock the six-book iOS reader.

| ID        | Request                                      | Why it helps the ecosystem                  | If missing                                |
| --------- | -------------------------------------------- | ------------------------------------------- | ----------------------------------------- |
| **PB-O1** | Hosted demo + docs site                      | Evaluators and bug reports need a live curl | You stay an “internal fork” in practice   |
| **PB-O2** | StackBlitz starters                          | Faster external repros                      | Issues without runnable cases             |
| **PB-O3** | Firefox in Playwright e2e                    | We may serve web readers there              | Firefox-only CSS/pointer bugs in the wild |
| **PB-O4** | `--stf-paper-base` / `--stf-shadow-*` tokens | Brandable paper without fighting opacity    | Dark themes wash out; hosts hack CSS      |
| **PB-O5** | Opt-in spine/gutter shading                  | Desk demos look finished                    | Each host overlays                        |
| **PB-O6** | Controls styling seam                        | Design systems keep a11y controls           | Fork or `controls: none` + rebuild        |
| **PB-O7** | `pageLabel` API                              | Front matter “iv” in live regions           | `liveRegionText` recipes only             |
| **PB-O8** | `<FlipPage>` wrapper                         | Stop styling leaf roots                     | Onboarding footguns                       |
| **PB-O9** | Split vanilla demo from e2e harness          | Teach consumers, not test globals           | Confusion in examples                     |

---

## Explicitly not requested (please do not schedule as Puddlebend)

| Item                                                               | Why we are **not** asking                                                                                      |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Audio, TTS, karaoke, auto-flip, cue engines in core                | Product decision: read-along is ours; curl engine stays a curl engine                                          |
| Haptics API in core                                                | We can `vibrate` on `changeState` in the host if wanted                                                        |
| WebGL / 3D curl package                                            | Live HTML + token highlight + a11y matter more; owner already deferred                                         |
| PDF / pdf.js page adapter                                          | Our editions are live HTML leaves, not PDF rasters                                                             |
| Restore canvas / `loadFromImages`                                  | Removed on purpose (ADR 0002); fights live text                                                                |
| “Fix” `turnProgress` to always emit 0…1 including instant turns    | Would break the intentional reduced-motion contract; we settle via `flip` / `changeState`                      |
| Loosen strict boolean / settings validation                        | Silent `'false'` strings already burned consumers                                                              |
| Treat missing **physical WKWebView dogfood** as a flipbook rewrite | That proof is **our** release gate on device; file defects only with post-INIT repros                          |
| Generic React Native flipbook package **now**                      | Our `ReaderWebView` must prove out first; extract later if reusable                                            |
| `allowTextSelection` for the kids curl mode **now**                | Ages 2–7 curl path should not select; we ship **accessible mode without the engine** for large selectable text |

---

## Defect watch (not open until reproduced on device)

We are **not** asserting these as open engine bugs today. Simulator + Playwright WebKit journeys pass for our six books on 3.2.0.

| Watch                                                               | Our action                                                                             |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Physical iPhone/iPad curl, rotation mid-turn, Reduce Motion, jetsam | Product acceptance matrix; open flipbook issue only after `INITIALIZED` with artifacts |
| RTL edition on device                                               | Unit/e2e cover engine RTL; we still owe device dogfood when we ship RTL packs          |
| Portrait back-curl / fold opacity                                   | Treated **fixed** in 3.2; re-open only with golden/repro regression                    |

---

## Our current workarounds (context for maintainers)

| Workaround                                           | Where                        | Maps to request                                |
| ---------------------------------------------------- | ---------------------------- | ---------------------------------------------- |
| Strip / stop trusting `lazyRadius` on vanilla mobile | `reader-web` settings + host | PB-01, PB-09                                   |
| Host image prepare window (± leaves)                 | `reader-web` host            | PB-09                                          |
| `deskClosedOffsetPx` + progress isolation            | web reader                   | PB-05, PB-03                                   |
| Memoized page nodes under `HTMLFlipBook`             | web reader                   | PB-04                                          |
| `cancelTurn` on resize + destroy                     | mobile host                  | Uses 3.2 correctly — thank you                 |
| Accessible mode = no engine, selectable text         | mobile host                  | Why PB allowTextSelection is not requested now |
| `buildSpreadMap` on publication keys                 | web                          | Why PB-06 does not delete product maps         |

---

## Suggested flipbook owner triage order

1. **PB-01, PB-02, PB-03, PB-04** — docs honesty (this week; no feature risk).
2. **PB-05, PB-06, PB-07** — small additive / recipe when cutting a minor.
3. **PB-08, PB-09, PB-10** — only when gates fire.
4. **PB-O\*** — when growing the library as a public product.
5. Never schedule the **Not requested** table as our demand.

---

## Contact / product facts

- Brand: Puddlebend — high-end picture books; public surfaces must not read as an AI pipeline.
- Phase: six public books, seven friends, account-free iOS reader; Android later.
- Engine pin: `@gullabs/flipbook-core` / `@gullabs/react-flipbook` **3.2.0**.
- Consumer audit notebook (evidence only): Puddlebend `docs/mobile/flipbook-audit.md`.
- We own: layouts, edition binding, narration policy, native chrome, WKWebView bridge.
- You own: curl geometry, pointer fold, page-face lifecycle, public browser events, React binding.
