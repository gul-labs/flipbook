# Agent standards for this repo

Rules for any AI agent (Claude, Codex, Cursor, or other) working in this
codebase. Every rule below exists because an agent broke it here during the
3.0.0 push and another agent had to find and fix the damage. Read `CLAUDE.md`
first for architecture; this file is about **how to work**, not what the code
does.

## 1. Coordination

- **Check whether another agent is active before editing.** `git status`, then
  look at file mtimes (`stat -f "%Sm" <file>`). If files you plan to touch
  changed in the last few minutes and you didn't change them, stop and ask the
  user who owns what. _What happened: two agents edited `UI.ts` concurrently
  and shipped two parallel pointer-capture implementations (`activePointerId`
  and `capturedPointerId`) in one file._
- **Never discard another agent's uncommitted work.** `git checkout -- .`,
  `git restore`, and deleting untracked files destroy changes git cannot
  recover — there is no stash, no dangling commit, nothing to `fsck` for. A
  reviewing agent wiped an in-progress relicensing this way and it had to be
  redone from scratch. If you believe uncommitted changes are wrong, stop and
  ask; if you must clear the tree, `git stash -u` first so it is recoverable.
- **Never commit another agent's uncommitted work inside your own commit.**
  Stage only paths you changed; `git add -A` is how unrelated in-flight work
  gets frozen into your commit message's story.
- **Stay in your assigned area.** If you were given the engine, don't "quickly
  fix" CI. Flag it instead.

## 2. Correctness over green

- **A test that passes while the live behavior is broken is a liability.** Do
  not stub the exact mechanism under test (`startAnimation` as a no-op in a
  test about animation completion), and do not weaken an assertion until it
  passes. If you can't make the real assertion pass, say so. _What happened:
  golden e2e "tests" wrote screenshots and asserted nothing; a controlled-page
  test was loosened until it passed without the engine turning at all._
- **Revert-prove every fix. This is a gate, not a habit.** For each fix: write
  the test, **revert the fix**, **observe the test FAIL**, restore, observe it
  pass. Then try at least one **hostile variant** — a subtly wrong fix that a
  careless reader would accept — and confirm the test still fails. Put the
  observation in the commit message: what you reverted and what the failure
  actually said.

  A test written after a fix, never run against the broken code, proves only
  that it agrees with whatever you just wrote. **Fourteen tests in this repo
  passed against broken code**, and the root cause was identical every time: the
  fixture took a shortcut that skipped the code path the fix lived on. See §4
  for the specific traps.

  Three rules that are not negotiable, because each one has already failed here:

  1. **Verify the revert LANDED.** A scripted revert that silently no-ops turns
     "the test passed with the fix removed" into a false clean bill of health.
     This happened: an RE-4 revert-prove "passed" because the edit never
     applied. Assert the anchor count, and grep the file afterwards.
  2. **A fix to your own fix needs this MORE, not less.** RE-2 and RE-3 skipped
     it and both were regressions — a fix that "obviously" repairs a known bug
     is exactly where confidence outruns evidence. There is no such thing as a
     fix too small to revert-prove.
  3. **If you cannot make a test discriminate, say so and explain why.** An
     honestly reported gap is worth more than a green tick; a green tick over a
     gap is a lie that outlives you. Report it rather than deleting or weakening
     the assertion.

- **Edit through a tool that fails on an ambiguous anchor.** Use the editor's
  own string-replace, which errors when the anchor is not unique. Do **not**
  hand-roll edits with `sed`, or with a `python` `str.replace` that does not
  assert the match count — that is how three edits in a single day landed in the
  wrong place, one of them putting an assertion inside an unrelated test block
  where it referenced a variable that did not exist there.

  A mis-targeted edit is worse than a failed one: it produces _phantom
  findings_. Downstream review then reasons about code that was never written,
  and the wasted work compounds silently. If you must script an edit, assert
  the anchor occurs **exactly once** before replacing, and verify the result
  afterwards. Never `replace_all` on a source file without reading every site.

- **Do not raise a budget to make a gate green** — but do not delete working
  code to avoid raising one either. Both are the same mistake: treating the
  number as the goal. The size ceiling was ratcheted 35→45→47→48 by agents who
  wanted a green build, and then a later agent removed a public helper to buy
  back 40 bytes. Neither asked what the number was for.

  What the numbers actually are: the spec (§5) says **≤ 35 kB minified** and
  that target is **retired** (upstream itself is 44 kB). The packed HTML engine
  ceilings are **66 kB raw / 16.1 kB brotli / 18.2 kB gzip** (2026-09-08,
  owner-approved after mobile live-HTML work), set with headroom for a real
  feature rather than pinned to wherever the code happened to sit. Closing the
  35 kB number would mean removing features (RTL, a11y, the index and null
  guards), not shaving identifiers. See `docs/QUALITY.md`.

  So, in order:

  1. **Dead code goes, always.** `foldFillCss` had no caller left; removing it
     is hygiene, not budget management, and needs no justification.
  2. **Working code never goes to buy bytes.** A public helper someone might
     reasonably call, a feature, a guard — deleting one of those to fit a
     number is trading real value for an arbitrary one. `isOpaquePageBackground`
     was removed for 40 bytes and had to be put back.
  3. **A correctness fix or a feature may spend the headroom.** Take it, and
     report the delta in the commit message. That is what headroom is for.
  4. **If the alarm fires, ask why it grew**, not what can be deleted. An
     unexplained jump is a bad import or a duplicated dependency — that is the
     accident this catches. Deliberate growth that needs more room than exists
     is a budget conversation with the owner (§5), not a reason to abandon the
     work.

  Coverage thresholds and lint severity are different: those only ratchet
  toward strict.

- **Quality gates must measure something.** A "quality" script that checks
  files exist, or two size-limit entries that both measure brotli while
  claiming one is raw, is theater. If you add a gate, prove it can fail: break
  the thing, watch the gate go red, fix it back.
- **A gate you did not wire up is not a gate.** `scripts/check-coverage-areas.mjs`
  was written with per-file floors, given an npm script, and left out of
  `quality:ci` — so nobody noticed it failed on the very code that shipped it.
  Adding a check means adding it to `quality:ci` _and_ watching it run.
- **Never push with the gate red.** `pnpm quality:ci` is the definition of done.
  It has been pushed red three separate times: an unformatted markdown file, a
  size budget the committed code already exceeded, and a coverage floor the
  committed code missed. Run it; do not assume.
- **Optimising for a number must be justified against what it costs.** Helper
  names were golfed to `iseg`/`lim`/`ang` and error messages to "Bad page" to
  chase a raw-byte budget. Measured return: **19 bytes** — because those symbols
  are module-internal and terser already mangles them. Measure the win before
  you spend readability on it, and prefer the metric consumers actually pay
  (transfer size) over a proxy.

## 3. Scope of a change

- **Every behavior change goes in the commit message and, if user-visible, in
  `CHANGELOG.md`.** _What happened: `preventDefault` on mouse pointerdown, a
  new `pointerleave` handler, and removal of the opaque background from
  `simpleDraw` all rode along unmentioned in a commit about four other fixes._
- **Every public API change gets a `MIGRATION.md` entry** — including type-level
  changes. Making `loadFromImages` return a `Promise`, or exposing
  `attachMode`/`replacePages` as public, is API. If a member is public only for
  internal wiring, mark it `@internal`.
- **Autofixes are reviewed, not trusted.** Run `eslint --fix` per-rule or
  per-file and read the diff. _What happened: a blanket `prefer-template` fix
  mangled template literals into `` `--${  density}` `` across the Page
  renderers._
- **Audit every line you read, not just the lines you change.** You have the
  file open and the context loaded; that is the cheapest a defect will ever be
  to find. _What happened: reading `ImagePage` to plan the portrait-curl fix led
  to `CanvasUI`, which sized its backing store in CSS pixels — every canvas book
  rendered at half resolution on a 2× display. (Canvas mode has since been
  removed — ADR 0002 — but the lesson stands: the file you opened is the
  cheapest a defect will ever be.)_
  - Record what you find **with `file:line` and a stated failure mode**, in the
    relevant plan doc or `CHANGELOG.md`, _before_ deciding whether to fix it.
  - Fix in place only when it is the same failure family and the fix is small.
    Otherwise it becomes its own unit of work — do not silently widen a change,
    and do not silently drop the finding either.
  - An unrecorded bug is indistinguishable from one nobody noticed. Upstream
    #44 and #56 both survived that way, in code this repo had already read.
  - **A guess recorded as a finding is worse than no finding.** No file:line, no
    finding. _What happened: an unmeasured "~27 kB" upstream baseline (really
    44,058 B) produced a "73% larger" figure, and both drove real work before
    anyone packed the tarball._

## 4. Engine-specific traps

These are the mistakes specific to this codebase. `CLAUDE.md` has the full
invariant list; these are the ones agents actually got wrong:

- **Nullability is a boundary design, not a style choice.** Internals that
  don't exist before `loadFromHTML` are `| null` **privately**; public getters
  keep non-null signatures and throw `PageFlipError('NOT_LOADED')`. Do not
  "clean up" either half: definite-assignment `!` makes the published `.d.ts`
  lie (callers get `undefined` at runtime), and nullable public getters break
  every consumer for a state they can't observe. Both directions were tried
  here; both were wrong.
- **RTL means the turn direction, never the pointer coordinates.** Mirroring x
  in `getMousePos` makes the fold run away from the finger. The inversion
  lives in `Flip.getDirectionByPoint` and `UI.swipeDirection`; programmatic
  turns pass an explicit direction. If you touch one input path, check all
  four: click, corner fold, drag, swipe.
- **React owns the page elements; the engine only borrows them.** Never
  `innerHTML = ''` inside `.stf__block`, never reparent nodes React rendered
  without going through the portal structure in `HTMLFlipBook.tsx`. Symptom of
  getting this wrong: `NotFoundError` on child removal.
- **Effect dependencies are load-bearing.** An inline `onFlip={...}` must not
  rebuild the `PageCollection` — handlers dispatch through a ref, and the
  rebuild is gated on the page **nodes** changing by reference. If your change
  makes a flip re-run `updateFromHtml`, you broke it.
- **Instant turns (`flippingTime: 0`, reduced motion) run `onAnimateEnd`
  synchronously.** State inspected after `flip()` returns is post-animation
  state; treating that as failure re-creates a shipped bug.

## 5. Decisions that are not yours to make

Some choices are the repository owner's, and an agent making them autonomously
is a defect no matter how well-reasoned the change is.

- **Licensing.** The core's move from MIT to MPL-2.0 was authorised by the
  repository owner — do not "correct" it back. What is not an agent's call is
  _initiating_ a change like it. An agent relicensed the engine, rewrote
  LICENSE and NOTICE, stamped headers across 30 files and invented trademark
  language before anyone had approved it; a reviewing agent then reverted the
  lot and destroyed uncommitted work. Both halves were wrong. Propose, get a
  yes, then implement — and if you find licensing changes you did not make,
  ask before touching them.
- **Versioning and release timing**, publishing to npm, deprecating a version.
- **Anything that changes what a consumer is legally or contractually
  obliged to do.**

If you believe one of these should change, say so and stop. A paragraph of
justification in a commit message is not authorisation.

### The public API is not on that list, and the reason matters

This section used to read "**The public API surface.** Adding a prop or an event
is a product decision; propose it, don't ship it." That was too broad, and it
stalled the whole Phase 2 gate while agents shipped public API changes anyway
under a different justification — `PageFlipError.code` became a union and three
error codes were split (25fc897) on the argument that it costs nothing before
the first publish. That argument is sound. It cannot be sound for one public
change and not another.

The line is **irreversibility**, not surface. Until the first npm publish there
is no consumer and no compatibility debt, so an API decision is a normal design
decision: make it with the same rigour as any other — Codex signoff, a domain
expert, an ADR recording the rejected alternatives — and implement it. **After**
the first publish the same decision is one-way, and it moves back under the list
above.

Two things this does not license:

- Deciding a question whose answer depends on facts only the owner has, e.g. how
  the downstream consumer actually uses the library. Go and read that repo
  first; ask only what reading cannot answer.
- Skipping the write-up. An API decided by an agent must land with its rationale
  and its rejected alternatives in `docs/`, because the next agent needs to know
  what was considered and why — that is what makes it reversible in practice and
  not just in principle.

A pure taste call with no technically better answer is still worth surfacing —
as a recommendation the owner can veto, not as a question that blocks the work.

## 6. Toolchain and releases

- **Verify version compatibility beyond "it installs".** `pnpm install`
  succeeding is not evidence. TypeScript must stay inside typescript-eslint's
  declared peer range or every type-aware lint rule silently disables — the
  preflight (`scripts/quality.mjs`) now enforces this; do not delete or bypass
  that check to "unblock" an upgrade.
- **Release mechanics get verified against a working repo, not reasoned from
  memory.** The reference is `gul-labs/any-llm` (publishes `@gullabs/*` today).
  _What happened: an agent shipped an OIDC-only publish workflow with no
  trusted publisher registered and no token — it would have failed closed after
  tagging. Another flipped a changeset from `major` to `patch` "to keep 3.0.0"
  and would have published 3.0.1._
- **Do not describe infrastructure as existing when it requires external setup
  that hasn't happened.** Docs must say "this requires X on npmjs.com first",
  not present the aspiration as current state.
- **Prove the publish artifact.** Before touching release code: delete `dist/`,
  `pnpm pack` both packages, list the tarballs, load the CJS entry in plain
  Node. Empty-tarball and broken-require bugs are found here, not on npm.
- **CI runs Linux; your laptop does not.** Anything platform-shaped has to be
  verified for the runner, not just locally. Screenshot baselines are named
  `<name>-<project>-<platform>.png`, so a macOS-only set fails every CI run —
  regenerate with `pnpm test:e2e:golden:update:linux`. Likewise, each CI job is
  a fresh runner: `needs:` orders jobs, it does not share `dist/`, so a job that
  needs built packages must build them itself.
- **Definite assignment (`!`) is allowed only for a constructor invariant you
  can point at, and it must be pinned by a test.** `UI.distElement!` is sound
  because `PageFlip.ui` stays null until a load completes; `packages/core/tests/
lifecycle.test.ts` is what keeps that true. Without such a test, use the
  nullable-internals / guarded-accessor pattern in §4.

## 7. Before you hand back

Run the same bar CI runs, from the actual state of the tree:

```bash
pnpm quality:ci
```

Then report honestly: what you changed, what you verified and how, what you
did **not** do, and anything you noticed but left alone. "Done" with a failing
gate, or a summary that omits a behavior change, costs more than the fix.
