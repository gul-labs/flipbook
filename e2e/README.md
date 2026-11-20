# Browser tests

The engine's flagship fixes — the portrait back-curl (§4.1) and the opaque fold
(§4.2) — cannot be proven by unit tests alone. They passed downstream while the
live book still showed the slide-in, which is why this suite exists.

There are **two layers**. Both run under Chromium and WebKit (WebKit is not
optional: iOS Safari is where the upstream bug lives).

## 1. Invariants (`flip-invariants.spec.ts`)

Read the fold straight off the running engine and assert structure:

- the leaf being animated is a **copy of the current page**, not the previous
  one, and the previous leaf is painted underneath it;
- the turning leaf is **opaque**;
- the fold travels **rightward on screen** across a backward drag;
- landscape spreads, hard covers, and `direction: 'rtl'` behave.

Invariants explain _why_ a frame is wrong. They are cheap and stable across
cosmetic CSS tweaks.

## 2. Golden frames (`golden-flip.spec.ts`) — §8.2

Screenshot comparison is the **only reliable pixel guard** for §4.1 / §4.2.
Committed baselines live next to the spec under Playwright's default snapshot
dirs (`*-snapshots/`, one set per project).

Coverage:

| Case                        | Frames                      |
| --------------------------- | --------------------------- |
| portrait × forward / back   | 25% / 50% / 75% of the flip |
| landscape × forward / back  | 25% / 50% / 75% of the flip |
| hard-cover open (landscape) | 25% / 50% / 75% of the flip |

### How frames are posed

1. Drive `examples/vanilla` with `?golden=1&flippingTime=1000&reducedMotion=0`
   (and `cover=1` for the hard-cover case).
2. Hold a real pointer drag from the forward/back **top** corner (same geometry
   the invariant suite uses for direction; top corner gives a full peel).
3. Move to 25 / 50 / 75 % of the distance across the book, then screenshot
   **while the button is still down** so the mid-fold pose is still. Assert the
   fold is engaged (`getFlippingProgress() > 1`) so a no-op drag cannot green.
4. Capture a **padded clip around `#book`** (not the element alone): portrait
   BACK paints the curl outside the leaf box, and an element screenshot would
   green-pass a blank white rectangle.
5. `maxDiffPixelRatio: 0.05` — enough for antialias / shadow-gradient drift,
   tight enough that a slide-in or translucent fold fails.

Pointer-path fraction is the stable stand-in for “% of `flippingTime`”: free-
running `flip()` + wall-clock sampling races the rAF loop across GPUs. Do
**not** set Playwright `animations: 'disabled'` at the config level for the
whole suite — the turn must actually fold under the pointer.

### Commands

```bash
pnpm exec playwright install chromium webkit
pnpm test:e2e                 # invariants + goldens
pnpm test:e2e:golden          # goldens only
pnpm test:e2e:golden:update   # rewrite baselines after an intentional visual change
```

Baselines are browser-specific (`chromium` / `webkit` suffixes). Update them on
the same OS family CI uses when possible; `maxDiffPixelRatio: 0.05` absorbs
small GPU differences, not a redesigned page.

The suite's query string also configures the book for invariants:
`?cover=1`, `?rtl=1`, `?flippingTime=0`.

## 3. Gesture e2e (`gestures.spec.ts`) — §8.3

Pointer-path coverage unit tests cannot honestly simulate (especially
`stopMove` re-entry after a mid-curl release). Uses `test.use({ hasTouch: true })`
inside the file — no extra Playwright project — so golden baselines stay
untouched.

| Case          | What it asserts                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Real touch    | `page.touchscreen.tap` on the forward edge turns the page                                                              |
| Long swipe    | Horizontal swipe past `swipeDistance` (default 30) within 250ms completes a turn                                       |
| Short swipe   | Drag under `swipeDistance` (`?swipeDistance=80` in the test) cancels; page stays put                                   |
| Tap zones     | Edge tap turns when flip-by-click is on; with `?disableFlipByClick=1` (`flipOnClick: 'corners'`) only corner taps turn |
| Drag mid-curl | Fold engages (`user_fold`); release completes or cancels via `stopMove`; no stuck fold, blank book, or double-turn     |

```bash
pnpm exec playwright test e2e/gestures.spec.ts
```

Extra vanilla query params for this suite: `?swipeDistance=N`,
`?disableFlipByClick=1` (maps to `flipOnClick: 'corners'`; plus the shared
`?flippingTime=0`).

The vanilla Vite config aliases `@gullabs/flipbook-core` to `packages/core/src`
so the suite exercises the engine source (same as unit tests), not a mid-flight
minified `dist`.

## Golden baselines are per-platform

Playwright resolves a screenshot baseline as
`<name>-<project>-<platform>.png`, so a baseline written on macOS is invisible
to CI's `ubuntu-latest` runner — the test fails with "A snapshot doesn't
exist", it does not silently pass. Both sets are committed:

- `*-chromium-darwin.png` / `*-webkit-darwin.png` — local development on macOS
- `*-chromium-linux.png` / `*-webkit-linux.png` — what CI compares against

Regenerate the Linux set inside the official Playwright image for the pinned
version (requires Docker running). That image is a reproducible stand-in for
the CI runner, not what CI uses: CI runs on `ubuntu-latest` after
`playwright install --with-deps`, so fonts and system libraries can differ and
a baseline generated in the image can still fail on the runner. Check the first
CI run after regenerating.

```bash
pnpm test:e2e:golden:update:linux
```

That script stages a clean copy of the worktree, installs and builds inside
`mcr.microsoft.com/playwright:v<version>-noble`, runs the golden suite with
`--update-snapshots`, and copies the `*-linux.png` files back. Never hand-copy
macOS baselines to Linux names: font rasterisation and antialiasing differ, and
you would be blessing a diff you never looked at.

Update the macOS set with `pnpm test:e2e:golden:update`.

**Review every baseline change.** A changed golden is either a real rendering
regression or an intended visual change — decide which before committing.
