# Triaged backlog — 2026-09-08

Maintainer-facing priority notes after an adversarial multi-auditor pass.

**Authoritative consumer voice (what Puddlebend wants, why, what degrades):**
[**requests/PUDDLEBEND-REQUESTS.md**](./requests/PUDDLEBEND-REQUESTS.md)
(`PB-01`…). Map those IDs here when scheduling work.

This file does **not** replace the request log — it records _our_ triage of
their asks. Checklist: [TODO.md](./TODO.md). Limits: [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md).

| Field                         | Meaning                                                             |
| ----------------------------- | ------------------------------------------------------------------- |
| **Status**                    | `ready` · `conditional` · `parked` · `rejected` · `product-owned`   |
| **Priority**                  | `P0-docs` (honesty, cheap) · `P2` · `P3-oss` · `later` · `never`    |
| **May touch locked surface?** | Only rows marked **ADR** — see [API-CONTRACT.md](./API-CONTRACT.md) |

**Auditor consensus (four independent reviews):**

- No **library code** item is ship-blocking for Puddlebend’s six-book account-free
  iOS phase against published **3.2.0**.
- Physical WKWebView dogfood is a **product release gate**, not an engine defect.
- Most audit “P1” items demote to docs, P2, conditional-on-evidence, or reject.
- Do not fund WebGL, PDF, audio-in-core, canvas restore, or demo-site vanity as
  if they were Puddlebend product needs.

---

## 0. Product-owned (not this repo)

| ID       | Item                                                                                                                              | Why it is not flipbook work                                                                                                                                         |
| -------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PO-1** | Physical iPhone/iPad WKWebView dogfood (curl, rotation mid-turn, Reduce Motion, background/jetsam, 20 open/close cycles)          | Real App Store gate. Simulator + Playwright WebKit already exercise the engine. File an engine bug only **after** `INITIALIZED`, with book, leaf, device/OS, build. |
| **PO-2** | Remove dead React-only keys from vanilla host settings (`lazyRadius`, `controls`, `liveRegion`, `useKeyboard` on core `PageFlip`) | Puddlebend `reader-web` footgun. Core silently ignores unknown keys today.                                                                                          |
| **PO-3** | Keep host image windowing; add host DOM windowing **only if** physical memory fails                                               | Do not wait for a speculative core lazy API.                                                                                                                        |
| **PO-4** | Keep web `deskClosedOffsetPx` + memoized `pageNodes` until a library recipe lands                                                 | Working product code; not a blocker.                                                                                                                                |
| **PO-5** | Read-along / narration product logic                                                                                              | Owner decision: audio stays out of core. Use `flip` / `changeState` / `visiblePages` until proven insufficient.                                                     |

---

## 1. Do next in this repo (honesty pass)

Cheap, high leverage, no contract change. Target a **3.2.x patch** or docs-only
commit on `main`.

| ID        | Priority | Status | Item                                                                                                                                                                                                                                               | Acceptance                                                                                              | Why / if skipped                                                                |
| --------- | -------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **FB-H1** | P0-docs  | ready  | **Strike stale lazyRadius OOM language** in `packages/react/tests/HTMLFlipBook.test.tsx` (and any README echo). Mark PRODUCT-BUG 2026-08-30 as **historical**; keep tests as revert-proof.                                                         | No present-tense “Still OOMs today”; lazy tests still pass.                                             | Agents rediscover a fixed bug and waste cycles or avoid a working feature.      |
| **FB-H2** | P0-docs  | ready  | **Document React-only surface** vs core `FlipOptions`: `lazyRadius`, `controls`, `liveRegion`, `useKeyboard`, `page` / `pageTransition`, event props. Vanilla `PageFlip` hosts must not expect them.                                               | README + API docs state the split; `examples/mobile-reader` or vanilla note shows host-owned windowing. | Mobile/spec already passed `lazyRadius: 2` into core — false memory confidence. |
| **FB-H3** | P0-docs  | ready  | **Document unknown settings behavior** on core: today extras are ignored after resolve; either keep and document, or (separate tiny change) reject unknown keys with `INVALID_SETTING`. Prefer document-first unless a consumer wants fail-closed. | One explicit sentence in README/Settings docs.                                                          | Silent ignore is how footguns survive.                                          |
| **FB-H4** | P0-docs  | ready  | **React children identity during animation** — document that page child list identity must stay stable across `turnProgress` ticks; point at a memoized example.                                                                                   | React package README “sharp edges” section.                                                             | Prevents “flipbook is flaky” mis-bugs; product web already paid the cost.       |
| **FB-H5** | P0-docs  | ready  | **Scrubber contract reminder** next to `turnProgress`: instant/RM turns emit nothing; no guaranteed terminal `1.0`; wire settle via `flip` / `changeState`.                                                                                        | Cross-link [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md); do not “fix” silence.                        | Hosts treat progress as a complete scrubber API.                                |

**Out of honesty pass:** inventing core DOM lazy, F06, WebGL, frame-time CI without device evidence.

---

## 2. Conditional (only with evidence)

| ID        | Priority        | Status      | Item                                                                                                                | Gate before starting                                                                                                                                     | Acceptance                                                                                                                 |
| --------- | --------------- | ----------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **FB-C1** | P2              | conditional | **Playwright frame-time gate** (p95/p99 rAF, LoAF) on realistic leaf HTML — [QUALITY.md](./QUALITY.md)              | Named **physical** profile shows hitching on real book HTML, **or** owner explicitly wants the gate as library quality tooling without product pressure. | CI fixture fails on regression; empty-div-only fixtures do not invent urgency. Mid-fold ~44 writes already unit-ceilinged. |
| **FB-C2** | P2              | conditional | **Core/HTML lazy page window** (or documented vanilla recipe that unmounts far leaves safely with curl/clone rules) | Physical WKWebView **jetsam / memory** failure on a real catalogue size after host image windowing is exhausted.                                         | Far leaves not in DOM; turn to them still paints; no mid-curl blank paper; LIVE-PAGE-FACES still holds.                    |
| **FB-C3** | later + **ADR** | conditional | **F06 correlated turn lifecycle** (`turnStarted` / terminal + turn id)                                              | Read-along / narration authorized **and** `flip` + `changeState` proven insufficient for host correlation.                                               | Optional events; **no** audio, cues, karaoke, auto-flip in core. Locked-surface amendment first.                           |

---

## 3. Additive library P2 (product-serving when cheap)

Small API/docs that reduce consumer reinventing. Not App Store blockers.

| ID        | Priority | Status | Item                                                                                                                                         | Notes                                                                                                                                                 |
| --------- | -------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **FB-A1** | P2       | ready  | **Closed-book centering recipe** (`changeState` + `visiblePages` + `turnProgress`); consider `centerClosedBook` only if recipe stays painful | Engine parking cover in right half is physically correct. Web desk uses `deskClosedOffsetPx` today. Mobile CSS-centers the stage — different problem. |
| **FB-A2** | P2       | ready  | **Façade `getSpreadCount()` + current spread index** thin wrappers over collection                                                           | Does **not** replace host publication-key maps (desk pads, phone subsets, `?spread=`).                                                                |
| **FB-A3** | P2       | parked | **`allowTextSelection`** with drag-vs-selection arbitration                                                                                  | Kids curl mode should not select; Puddlebend accessible mode has no engine. Re-open only if a product requires book-mode copy.                        |
| **FB-A4** | P2       | ready  | **`validateFlipOptions(options)`** pure preflight (no DOM)                                                                                   | CMS/CI; already on TODO. Watch **bundle ceiling** (~670 B raw headroom under the 69 kB ceiling after the 2026-09-28 media hardening).                 |

---

## 4. OSS growth P3 (do not confuse with product need)

| ID         | Priority | Status | Item                                                                                     |
| ---------- | -------- | ------ | ---------------------------------------------------------------------------------------- |
| **FB-O1**  | P3-oss   | ready  | Hosted demo + docs site (**#1 public-product gap** for the library as a product)         |
| **FB-O2**  | P3-oss   | ready  | StackBlitz / one-click repro starters (with demo)                                        |
| **FB-O3**  | P3-oss   | ready  | Firefox in Playwright e2e (Chromium + WebKit already gate)                               |
| **FB-O4**  | P3-oss   | ready  | `--stf-paper-base` + `--stf-shadow-*` tokens (dark theme / brand)                        |
| **FB-O5**  | P3-oss   | ready  | Opt-in spine / gutter shading                                                            |
| **FB-O6**  | P3-oss   | ready  | `controlsClassName` / `renderControls` seam                                              |
| **FB-O7**  | P3-oss   | ready  | First-class `pageLabel` (beyond `liveRegionText` recipe)                                 |
| **FB-O8**  | P3-oss   | ready  | `<FlipPage>` inner-slot primitive                                                        |
| **FB-O9**  | P3-oss   | ready  | Split vanilla demo from e2e harness (`window.flipbook` / `?golden=1`)                    |
| **FB-O10** | later    | parked | Vue / Svelte adapters after core stays stable                                            |
| **FB-O11** | later    | parked | Android WebView CI when product Android is scheduled                                     |
| **FB-O12** | later    | parked | Generic React Native adapter — only after a product WebView bridge is proven extractable |

---

## 5. Rejected / do-not-backlog

| ID         | Item                                                                                          | Reason                                                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **FB-X1**  | Audio, cues, karaoke, auto-flip in core                                                       | Owner: read-along is consumer-owned.                                                                                                  |
| **FB-X2**  | Haptics API in core                                                                           | Host `navigator.vibrate` on `changeState` / settle.                                                                                   |
| **FB-X3**  | WebGL renderer package / publish `Render` for subclassing                                     | Owner-deferred 2026-08-28; wrong seam; live HTML is the product path. Keep [WEBGL_RENDERER.md](./WEBGL_RENDERER.md) as analysis only. |
| **FB-X4**  | PDF / pdf.js adapter                                                                          | Prompt nostalgia; zero value to offline live-HTML editions; echoes removed canvas.                                                    |
| **FB-X5**  | Restore canvas / `loadFromImages`                                                             | [ADR 0002](./adr/0002-remove-canvas-mode.md).                                                                                         |
| **FB-X6**  | “Fix” `turnProgress` silence on instant / reduced-motion / hover peel                         | Documented contract; tests lock silence.                                                                                              |
| **FB-X7**  | Rotated / skewed host hit-testing                                                             | No in-tree consumer; DOMMatrix costs bytes against a tight ceiling. Stays [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md).             |
| **FB-X8**  | Binding-owned leaf hosts (4.0) mid-stream                                                     | Breaking; design-only later.                                                                                                          |
| **FB-X9**  | Loosen `INVALID_BOOLEAN` / settings contracts                                                 | Silent config lies.                                                                                                                   |
| **FB-X10** | Treat missing physical dogfood as a library rewrite mandate                                   | Product gate ≠ engine defect.                                                                                                         |
| **FB-X11** | Promote frame-time / F06 / core lazy / `allowTextSelection` to ship-blocking without evidence | Auditor consensus.                                                                                                                    |

---

## 6. Stale TODO cleanup (do not re-implement)

Verify and strike from [TODO.md](./TODO.md) when editing:

| Claim in old TODO                                | Reality (2026-09-08)                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Next.js example needs a real `flippingTime`      | Example already uses a non-zero duration — confirm and close.                         |
| OpenSSF Scorecard Action + public coverage badge | Scorecard workflow + README badge exist; only a **coverage** badge may still be open. |

---

## 7. Bundle ceiling warning

Measured packed HTML engine is **68,329 B raw / 16,712 B brotli / 18,937 B gzip** (2026-09-28, Node zlib defaults, after the portrait-clone media hardening), against owner ceilings of **69 / 16.8 / 19.0 kB**. Additive work (tokens, gutter, `validateFlipOptions`, any core lazy, DOMMatrix) has only **~670 B raw / ~90 B brotli / ~60 B gzip headroom** under the current ceilings. Policy remains [AGENTS.md](../AGENTS.md) §2: correctness may spend headroom and must say so; vanity must not.

---

## 8. Mapping from the consumer audit

| Audit ID                        | Auditor verdict                | Lands here as                      |
| ------------------------------- | ------------------------------ | ---------------------------------- |
| B-01 Physical WKWebView         | **REFRAME** product gate       | PO-1                               |
| B-02 No confirmed engine defect | **DROP** (non-finding)         | —                                  |
| P1-01 Frame-time                | **DEMOTE** conditional P2      | FB-C1                              |
| P1-02 lazyRadius no-op          | **SPLIT**                      | FB-H2/H3 + PO-2; core lazy = FB-C2 |
| P1-03 centerClosedBook          | **DEMOTE** P2                  | FB-A1                              |
| P1-04 turnProgress + F06        | **SPLIT**                      | FB-H5; F06 = FB-C3                 |
| P1-05 allowTextSelection        | **DROP** from P1               | FB-A3 parked                       |
| P1-06 getSpreadCount            | **DEMOTE** P2                  | FB-A2                              |
| P1-07 Stale OOM comments        | **DEMOTE** docs chore          | FB-H1                              |
| P1-08 Children identity         | **DEMOTE** docs                | FB-H4                              |
| P2-01…P2-09 (most)              | **ALREADY_TRACKED** / KEEP OSS | §4                                 |
| P2-10 WebGL                     | **REJECTED_BY_OWNER**          | FB-X3                              |
| P2-11 PDF / Vue                 | PDF never; Vue parked          | FB-X4 / FB-O10                     |
| P2-12 Sound/haptics core        | **REJECTED**                   | FB-X1/X2                           |
| P2-13 4.0 leaf hosts            | design later                   | FB-X8                              |
| P2-14 RN adapter                | product first                  | FB-O12                             |
| P2-15 Clone snapshot            | by design                      | KNOWN-LIMITATIONS                  |

---

## 9. Recommended sequence (maps to PB-*)

1. **PB-01…PB-04** honesty/docs (this week).
2. Consumer physical dogfood + dead settings — outside this repo.
3. **PB-05…PB-07** when cutting a minor.
4. **PB-08…PB-10** only when gates fire.
5. **PB-O\*** when selling the library as a product.

---

## 10. Sources

- Consumer request log: [requests/PUDDLEBEND-REQUESTS.md](./requests/PUDDLEBEND-REQUESTS.md).
- Four parallel audits, 2026-09-08 (blocking, P1, P2, consumer reality-check).
- Consumer audit notebook: `puddlebend/docs/mobile/flipbook-audit.md`.
- In-repo: [TODO.md](./TODO.md), [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md), [QUALITY.md](./QUALITY.md), [ROADMAP.md](../ROADMAP.md), [API-CONTRACT.md](./API-CONTRACT.md), [LIVE-PAGE-FACES.md](./LIVE-PAGE-FACES.md), [WEBGL_RENDERER.md](./WEBGL_RENDERER.md).
