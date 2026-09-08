# Mobile branch adversarial audit — 2026-09-08

Scope: all 16 commits from `origin/main` (`eb6836d`) through `f91a654`,
including dependency audit plumbing, F01–F05, follow-up engine/React changes,
fixtures, tests and public documentation. No Claude review was used for this
pass, as requested by the owner. No physical WebView compatibility claim.

## Findings recorded before fixes

- **A1 / P1 — orientation reentrancy uses the wrong spread.**
  `packages/core/src/Render/Render.ts:839` changes orientation before cancelling,
  but `PageFlip[ADOPT_ORIENTATION]` has not yet reconciled the collection's
  spread index or wrapper dimensions. From landscape page 4, a READ listener
  calling `flipNext()` during a portrait resize lands on page 3, not page 5.
  The existing page-zero regression hides this. Fix and prove nonzero pages,
  both orientations, animated turns and final wrapper geometry.
- **A2 / P2 — built-in controls lose keyboard navigation.**
  `packages/react/src/HTMLFlipBook.tsx:1215` (the descendant-target guard) rejects the reader's own
  Previous/Next buttons as though they were content widgets. Reproduced with
  the built React package: ArrowRight at page 2 moves to 3 from the root but
  stays at 2 from either control. Permit only this book's owned controls;
  preserve content widgets, nested books, modifiers and disabled keyboard mode.
- **A3 / P1 — canary filtering can hide a real lodash vulnerability.**
  `scripts/audit.mjs:245` deletes all lodash advisories unless the exact canary
  version is installed. A different vulnerable lodash version therefore gets
  a CLEAN result. Filter injected canary-only findings by the installed
  versions and each advisory's vulnerable range instead.
- **A4 / P2 — fixture motion control misstates actual motion.**
  `examples/mobile-reader/main.ts:138` toggles respect for the OS preference,
  not reduced motion itself. The label says “Reduced motion: on” while a host
  without an OS preference continues animated turns. Make the explicit demo
  mode control duration while continuing to honor OS reduced motion.

Previously found cancellation defects (pressed pointer ignored, throwing READ
listener skipping cleanup, fresh callback gesture erased) are addressed in
`f91a654`: the work detector includes `isUserTouch` and pointer reset precedes
READ. Their existing regressions were rerun and mutation-proved.

F06 remains deferred: optional correlated start/terminal events are not
necessary for basic WebView rendering. READ is not an exactly-once completion
contract and cannot substitute for turn IDs or a pre-clone notification.

## Validation

All findings below are resolved in this audit. Source locations in the findings
refer to the reviewed `f91a654` baseline; line numbers shift after fixes.

- `pnpm quality:ci`: passed, including build, typecheck, lint, formatting,
  audit-gate self-tests, coverage floors, size limits, isolated consumer types,
  and packed ESM/CJS artifact checks for both packages.
- Unit/integration tests: **1,056 passed across 66 files**. Coverage: 96.66%
  statements, 91.91% branches, 98.98% functions, 98.08% lines.
- `pnpm build:examples`: passed for vanilla, React, Next.js and mobile reader.
- `pnpm test:e2e`: **76 passed**, Chromium and WebKit on macOS. Existing
  screenshots passed without baseline changes. Focused-control navigation also
  passed in actual Chromium and WebKit sessions using the built React package.
- `pnpm audit:gate`: canary-verified CLEAN for 62 production packages, with no
  findings at or above the configured high threshold.
- `git diff --check`: passed.

Each mutation was checked to have landed, observed failing, and restored before
final green verification:

| Fix                             | Original defect observed                                                                                    | Hostile variant rejected                                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| A1 orientation                  | Restoring the original adoption order fails nonzero-page and final-wrapper assertions                       | Omitting spread rebasing fails destination assertions; cancelling before wrapper restyling fails geometry assertions |
| A2 keyboard                     | Restoring the root-only guard fails all four direction/control cases                                        | Trusting a data attribute lets an authored page button turn the book and fails its ownership assertion               |
| A3 real canary-package findings | Deleting every lodash advisory reports vulnerable 4.17.19 CLEAN                                             | Keeping every canary advisory reports safe 4.17.21 VULNERABLE                                                        |
| A3 canary verification          | Accepting any severity string fails all three malformed/nonmatching canary cases                            | Checking severity alone still fails the two range cases                                                              |
| A4 motion                       | Original demo keeps animating under its explicit reduced-motion mode                                        | Ignoring the OS preference fails the OS-reduced assertion; both proofs exercised the built fixture                   |
| Existing cancellation fixes     | Removing pressed-pointer detection fails cancellation; resetting after READ fails throwing-listener cleanup | Late reset erases a fresh gesture started by the READ listener                                                       |

The A6 failures were incorrect test expectations and a timer race. Exact page
assertions remain; the highlighting assertion now observes a stylesheet change
made after cloning. No runtime behavior was changed to satisfy those assertions.

No Linux browser run or physical iPad/Android WebView test was performed. Local
browser results do not establish native-device compatibility. No release,
version change, new public API, or F06 implementation is included.

## Additional findings from the full checks

- **A5 / build blocker:** clean archive build of `f91a654` is 65,650 bytes raw,
  15,984 brotli and 18,096 gzip, exceeding all three ceilings (64,200 / 15,800 /
  17,800). The commit's reported 64.16 kB is inaccurate. The orientation fix
  adds 196 / 34 / 31 bytes. The owner explicitly approved 66,000 / 16,100 /
  18,200-byte limits in this conversation, and both size gates now use them.
- **A6 / browser test failures:** `e2e/mobile-live-html.spec.ts:164` expects
  a committed forward drag from page 1 to stay at 1, then expects previous to
  land at 0. Chromium and WebKit correctly produce 2 and 1. Line 307 applies a
  single-element text assertion to ten originals (strict locator failure).
  Line 350 asserts a manually selected token after yielding to the narration
  timer (observed word 4 instead of word 1). Keep exact page expectations,
  target the original cover, and change/read the highlight stylesheet in one
  browser task after the clone exists. These are test defects, not grounds to
  weaken the engine or disable animation.
- **A3 supplemental:** `scripts/audit.mjs:163` treated any nonempty severity
  string as a verified canary, even with a missing/nonmatching vulnerable
  range. Three service-fixture cases incorrectly produced CLEAN; validate that
  an understood advisory actually covers the injected version.

## Commit coverage

| Reviewed commits                                                            | Area and disposition                                                                                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `399c462`, `b6417e2`                                                        | Optional peer installation and advisory-service trust. Verified effective pnpm setting; fixed A3 and reran the real production audit.            |
| `0d12429`, `befdd4c`, `2c6de1a`                                             | Approved scope, live-HTML fixture and highlighting contract. Fixed A4; exercised clone/original styling and pointer paths. F06 remains deferred. |
| `803c3b6`, `35a2011`, `159bfc7`, `3e73c3e`, `12cb565`, `ecef76b`, `f91a654` | Cancellation, geometry adoption, nested turns and dead React shell. Fixed A1; verified inherited cancellation fixes and full lifecycle tests.    |
| `d640cf5`                                                                   | Destroyed React engine handling. Full React suite and packed consumer checks pass.                                                               |
| `e5828a1`, `ade2e18`, `a45d300`                                             | Size gate and browser/observer regressions. Corrected A5/A6; observed actual rAF completion and reran all browser assertions.                    |

A2 predates this branch but was explicitly reported by the owner and is included
in the requested fixes. This review is evidence for the paths checked, not a
claim that no undiscovered defects remain.

## Size measurement method

The raw artifact and default Node zlib brotli/gzip measurements were obtained
from the same toolchain for the clean baseline and corrected build: 65,650 /
15,984 / 18,096 bytes before, 65,846 / 16,018 / 18,127 bytes after. `size-limit`
uses its own gzip settings and reports 18.07 kB gzip (65.85 kB raw and 16.02 kB
brotli); both compression measurements pass the approved ceilings. No working
feature was removed to buy space.
