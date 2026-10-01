# ADR 0004 — Media in leaves: the engine copies safely, the host owns playback

**Status:** Accepted by the owner, 2026-09-30 (proposed 2026-09-28). The
engine half (options A and B below) shipped in 3.2.2; the playback stance
restates the standing "no audio in core" decision (PB-10 / FB-X1). The
resulting bundle ceilings (69 / 16.8 / 19.0 kB) were approved in the same
decision.

**Context:** Puddlebend's
[VIDEO-PAGES-REQUIREMENTS.md](../requests/VIDEO-PAGES-REQUIREMENTS.md) (17
use cases, requirements R-1…R-18, options A–G) and
[PB-11](../requests/PB-11-live-text-highlight.md).
**Host guide:** [MEDIA-PAGES.md](../MEDIA-PAGES.md).

## Decision

1. **A `<video>` in a soft leaf is supported content.** The portrait fold copy
   shows what the page shows and never becomes a second player (option A):
   - copied media is silenced (`src`, `autoplay`, `<source>` removed, then
     `load()`), because `cloneNode` copies `src` and a detached copy still
     fetches, decodes and, with `autoplay`, plays;
   - `<video>` becomes `<canvas data-stf-frame>`: the poster until the video
     has played (HTML "show poster" state), else the current frame. It carries
     the video's attributes and whole resolved style, so tag-selector layout
     survives; its backing store is box × DPR except under `object-fit: none`
     / `scale-down`;
   - `<audio>`, `<iframe>`, `<embed>`, `<object>` become an empty
     `<div data-stf-embed>` with the same attributes and resolved style, before
     the copy is attached, so nothing loads twice;
   - a cloned `<canvas>` stays unsupported (pixels are not copied).
2. **Interactive media does not start a fold** (option B): `video[controls]`,
   `audio[controls]`, `iframe`, `embed`, `object` are in
   `FLIPBOOK_INTERACTIVE_SELECTOR`, behind `respectInteractiveContent`.
3. **The engine never drives playback** (option F refused). No `mediaPolicy`
   setting, no `play` / `pause` / `load` / `currentTime` on host elements, no
   vendor `postMessage`.
4. **The host owns playback from existing signals** (option D). `changeState`
   → `user_fold` / `flipping` is dispatched before the portrait copy is taken,
   so it is the pre-copy signal R-10 asked for; option E (a new correlated
   `turnStarted` event) is not needed for pausing and stays FB-C3. The recipe
   ships as an example (`examples/media-pages/media.ts`), not as API; a React
   hook waits for a second consumer.
5. **Hard leaves (option C) and "do nothing" (option G)** remain documented
   fallbacks only.

## Why

- **Playback is product policy.** Resume vs restart, what autoplays on a
  phone, WCAG 1.4.2 / 2.2.2 controls and reduced-motion posters depend on the
  content. Core cannot choose them without choosing wrongly for someone.
- **Vendor players are unversioned protocols.** YouTube's `pauseVideo` and
  Vimeo's `pause` messages would tie a zero-dependency engine's releases to
  theirs.
- **Precedent.** Swiper leaves pausing to `slideChange` handlers; 3D FlipBook
  and FlipHTML5 make play-on-show / pause-on-hide opt-in per element; Reveal.js
  pauses by default only because it owns the whole page. (Sources in
  MEDIA-PAGES.md.)
- **The engine's own obligations are covered by A and B**: the copy is its
  creation, so making it faithful and inert is the engine's job; the original
  element is the host's.

## Consequences

- Hosts copy ~150 lines (`media.ts`) or write their own; `e2e/media-pages.spec.ts`
  proves the recipe in Chromium and WebKit, so the recommended wiring cannot
  silently rot.
- A hover peel copies the leaf at `fold_corner`; the recipe does not pause on
  hover, so a drag that continues from a peel folds the frame from the hover.
- The size budget grew for A (owner-approved 69 / 16.8 / 19.0 kB, 2026-09-28).
- **Turn-start cost of the frame snapshot** — see below.

## Turn-start cost of the frame snapshot

`drawImage` of the current frame runs synchronously when the copy is taken.
Sizing the canvas to the box removed the memory cost (~33 MB → box × DPR)
but not the read-back of the source frame, which scales with the source.

Four ways to take the frame were measured on 2026-09-28 (Playwright,
headless, a playing video beside a 60 fps animation, 16–20 samples; medians,
Chromium main-thread ms / dropped frames per run):

| Approach                                          | 1080p, DPR 1 | 4K, DPR 1  | 4K, DPR 3   | WebKit 4K drops |
| ------------------------------------------------- | ------------ | ---------- | ----------- | --------------- |
| A. sync `drawImage(video)` (shipped)              | 2.5 ms       | 8.3 ms / 1 | 14.7 ms / 5 | 1 in 20         |
| B. `createImageBitmap(video, {resizeWidth, …})`   | —            | 8.7 ms / 1 | 12.2 ms / 5 | 9 in 20         |
| C. `createImageBitmap(video)`, then scaled draw   | —            | 8.5 ms / 0 | 8.0 ms / 5  | 10 in 20        |
| D. `new VideoFrame(video)` (WebCodecs), then draw | —            | 6.8 ms / 0 | 15.0 ms / 8 | 0 in 20         |

**Decision: keep A.** `createImageBitmap` does its read-back synchronously in
Chromium, so it moves nothing off the main thread, and it made WebKit worse.
`VideoFrame` removed WebKit's occasional drop but not Chromium's, and a second
code path is not worth ~one dropped frame in twenty. Every approach produced
pixels before the next frame, so the fold never shows a blank or poster frame
while waiting. The lever that works is the source: a 1080p rendition costs
about a third of a 4K one, and a leaf is a few hundred CSS pixels wide.
MEDIA-PAGES.md tells hosts to serve a rendition near the box size × DPR.
Revisit if a consumer measures a real device dropping frames at turn start
with a right-sized source.
