# flipbook

**The maintained page-flip.** A modern fork of StPageFlip + react-pageflip with the mobile back-curl finally fixed.

<p align="center">
  <img src="docs/images/hero.jpg" alt="Hardcover picture book mid-curl: the current leaf peels away and the previous illustration is already there underneath." width="100%">
</p>

Forked from [Nodlik/StPageFlip](https://github.com/Nodlik/StPageFlip) and [Nodlik/react-pageflip](https://github.com/Nodlik/react-pageflip) (both MIT), merged and maintained by [GulLabs](https://github.com/gul-labs). Upstream notices live in [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).

<p align="center">
  <a href="https://github.com/gul-labs/flipbook/actions/workflows/ci.yml"><img src="https://github.com/gul-labs/flipbook/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/gul-labs/flipbook"><img src="https://api.scorecard.dev/projects/github.com/gul-labs/flipbook/badge" alt="OpenSSF Scorecard"></a>
  <a href="https://www.npmjs.com/package/@gullabs/flipbook-core"><img src="https://img.shields.io/npm/v/%40gullabs%2Fflipbook-core.svg" alt="npm @gullabs/flipbook-core"></a>
  <a href="https://www.npmjs.com/package/@gullabs/react-flipbook"><img src="https://img.shields.io/npm/v/%40gullabs%2Freact-flipbook.svg" alt="npm @gullabs/react-flipbook"></a>
  <a href="https://www.npmjs.com/package/@gullabs/flipbook-core"><img src="https://img.shields.io/npm/types/%40gullabs%2Fflipbook-core.svg" alt="TypeScript types"></a>
  <a href="./packages/core/LICENSE"><img src="https://img.shields.io/badge/core-MPL--2.0-blue.svg" alt="core: MPL-2.0"></a>
  <a href="./packages/react/LICENSE"><img src="https://img.shields.io/badge/react-MIT-blue.svg" alt="react: MIT"></a>
  <img src="https://img.shields.io/badge/core-zero%20runtime%20deps-0f172a.svg" alt="Zero runtime dependencies">
</p>

On a phone, a back swipe must curl the **current** leaf away and show the previous leaf underneath. Upstream slides the previous page in from the left. That is the bug this fork exists to kill — in the engine, not with a monkey-patch.

Fixed in the HTML engine. Covered by tests that fail if the fix is reverted.

Canvas / images mode was **removed** in 3.0.0 ([ADR 0002](./docs/adr/0002-remove-canvas-mode.md)): `loadFromImages`, `ImageFlipBook`, and related APIs are gone (compile-time break — see [MIGRATION.md](./MIGRATION.md)).

---

## Packages

| Package                                                                            | Path             | Role                                                      |
| ---------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------- |
| [`@gullabs/flipbook-core`](https://www.npmjs.com/package/@gullabs/flipbook-core)   | `packages/core`  | Framework-agnostic curl engine (HTML). Zero runtime deps. |
| [`@gullabs/react-flipbook`](https://www.npmjs.com/package/@gullabs/react-flipbook) | `packages/react` | React 18/19 binding. `react` peer `>=18`.                 |

### Browser support

| Browser                    | Status                                                                |
| -------------------------- | --------------------------------------------------------------------- |
| Chromium (Chrome, Edge, …) | Supported — unit + Playwright e2e                                     |
| Safari / iOS (WebKit)      | Supported — Playwright WebKit e2e (portrait back-curl lives here)     |
| Firefox                    | Expected to work (Pointer Events + modern CSS); **not** in CI e2e yet |
| IE / legacy Edge           | Not supported                                                         |

Needs a evergreen browser with **Pointer Events**, `ResizeObserver`, and CSS
`clip-path`. No IE polyfill path.

---

## Portrait is a peel, not a slide

<p align="center">
  <img src="docs/images/phone.jpg" alt="Child holding a phone; the on-screen picture-book leaf curls away to the right like paper, fox illustration remaining underneath." width="420">
</p>

One 2:3 leaf. Swipe left for next, right for previous. Back must peel the page you are looking at. Hard covers stay hard. Reduced motion makes the turn instant instead of throwing.

On a desk, the book is a two-leaf spread. Mouse and corners work the way the vendor always did.

<p align="center">
  <img src="docs/images/desk.jpg" alt="Open landscape picture book on a walnut desk, two-page forest-to-meadow spread, a mouse cursor folding the top-right corner." width="100%">
</p>

---

## Opaque paper

<p align="center">
  <img src="docs/images/fold.jpg" alt="Macro of a turning leaf: cream paper is fully opaque, watercolor printed on the surface, nothing ghosting through from below." width="100%">
</p>

The fold and its temporary copy fill with `pageBackground` (default `#fff`). Underlying type does not bleed through the curl.

---

## Why this fork

| Bug                                                                                        | Upstream                                                                                                              | Fixed in                                  |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Portrait back-curl slides in instead of peeling the current leaf                           | [StPageFlip #49](https://github.com/Nodlik/StPageFlip/issues/49), [#9](https://github.com/Nodlik/StPageFlip/issues/9) | 3.0.0                                     |
| Fold is transparent; underlying text bleeds through                                        | engine                                                                                                                | 3.0.0                                     |
| Collection-rebuild event never fires (`removeHandlers` → `updateFromHtml` → `setHandlers`) | react-pageflip 2.0.3 (`onUpdate`)                                                                                     | 3.0.0 (`pagesChanged` / `onPagesChanged`) |
| `flippingTime: 0` throws in the constructor                                                | Settings.getSettings                                                                                                  | 3.0.0                                     |
| `flipToPage` swallows errors and lands one page forward                                    | Flip.flipToPage empty catch                                                                                           | 3.0.0                                     |
| Shipped types lose `react` under pnpm isolated `node_modules`                              | react-pageflip `index.d.ts`                                                                                           | 3.0.0                                     |

Also: Pointer Events (one input path), `ResizeObserver` + `visualViewport`, `respectReducedMotion` (default on), SSR-safe imports, keyboard turning (Arrow/Home/End, default on — pass `useKeyboard={false}` to disable), `readingDirection: 'rtl'` (turn direction only — the fold still follows the finger), controlled `page` + `usePageFlip()`, `once()` on the event emitter.

### What it costs

Measured from the published artifacts, both terser-minified, zero runtime dependencies:

|                                            | raw (min) |    gzip |  brotli |
| ------------------------------------------ | --------: | ------: | ------: |
| `page-flip@2.0.7` (upstream)               |   44.1 kB | 10.4 kB |  9.3 kB |
| `@gullabs/flipbook-core` HTML engine (3.1) |   63.3 kB | 17.6 kB | 15.5 kB |

Larger than upstream because of RTL, reduced motion, typed errors, validation,
and the portrait back-curl fix. This is not a smaller drop-in replacement; it is
a maintained one. CI ceilings on the packed HTML engine are **64.1 kB raw /
15.8 kB brotli / 17.8 kB gzip** (raised for F03 mid-turn resize cancel + F05
`cancelTurn`; AGENTS.md §2).

Reproduce with `npm pack page-flip@2.0.7` and `pnpm build && pnpm size`.

---

## Install

```bash
npm uninstall react-pageflip page-flip && npm i @gullabs/react-flipbook
```

Vanilla:

```bash
npm uninstall page-flip && npm i @gullabs/flipbook-core
```

`width` and `height` stay required. Everything else is optional. Breaking changes: [`MIGRATION.md`](./MIGRATION.md). Publish notes: [`RELEASING.md`](./RELEASING.md).

---

## Usage

**Core**

```js
import { PageFlip } from '@gullabs/flipbook-core';

const pageFlip = new PageFlip(root, { width: 400, height: 600 });
pageFlip.loadFromHTML(pages);
// Pictures: <img alt="…"> inside the HTML page elements.
```

**React**

```tsx
import { useState } from 'react';
import HTMLFlipBook, { type BookSnapshot } from '@gullabs/react-flipbook';

export function Book() {
  // Seed the counter from onLoaded — it carries the real pageCount and the
  // resolved page, so the label never renders "Page 1 of 0". onPageChange
  // fires only for real turns, never on mount.
  const [book, setBook] = useState({ page: 0, pageCount: 0 });
  const sync = (s: BookSnapshot) => setBook({ page: s.page, pageCount: s.pageCount });

  return (
    <>
      <p>
        Page {book.page + 1} of {book.pageCount}
      </p>
      <HTMLFlipBook
        width={300}
        height={500}
        pageBackground="var(--paper, #fff)"
        onLoaded={sync}
        onPageChange={sync}
      >
        {/* Host element required. Paper is on this root; face colour lives inside. */}
        <div>
          <div style={{ height: '100%', padding: 16 }}>Page 1</div>
        </div>
        <div>
          <img
            src="/pages/2.jpg"
            alt="Title page"
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        </div>
      </HTMLFlipBook>
    </>
  );
}
```

### Examples

| Example            | Path                   | What it shows                               |
| ------------------ | ---------------------- | ------------------------------------------- |
| Vanilla HTML       | `examples/vanilla/`    | HTML pages, golden / gesture e2e host       |
| Vite + React       | `examples/vite-react/` | Picture book, RTL chrome, controlled `page` |
| Next.js App Router | `examples/nextjs/`     | SSR placeholder → hydrate, real curl        |

---

## Styling

The engine owns the page **root**; you own everything inside it. Every draw
writes position, size, clip and the paper layer onto the leaf element itself,
so colors, padding and typography belong on an **inner wrapper** — a
`background` on the root loses to the engine's paper.

```html
<div class="my-page">
  <!-- root: the engine's -->
  <div class="my-page-inner">…yours…</div>
</div>
```

**Paper.** `pageBackground` (default `#fff`) paints every leaf and the fold of
a turning page. Any CSS color works — including `var(--paper, #fff)` and
translucent values: opacity is structural (your color composites over an
opaque base), so a see-through fold cannot ship by accident. The value lands
on the leaf as the `--stf-paper` custom property.

**Stable selectors** — these class names are API and safe to target:

| Selector                | What it is                                                       |
| ----------------------- | ---------------------------------------------------------------- |
| `.stf__parent`          | The host you (or the binding) passed in                          |
| `.stf__wrapper`         | Aspect-ratio wrapper                                             |
| `.stf__block`           | Page container — the node `getBlockElement()` returns            |
| `.stf__item`            | A leaf root (your page element, adopted)                         |
| `.stf__item.--shown`    | A leaf currently on screen (visibility axis — no `display` rule) |
| `.--left` / `.--right`  | Which half of a landscape spread the leaf sits in                |
| `.--hard` / `.--simple` | Hard (cover) vs paper leaf                                       |

Your own `className` / `style` on a page element are preserved — the engine
adds its classes next to yours and never wipes the node.

**Branding the built-in controls.** With `controls="visible"`, the previous /
next buttons carry `data-flipbook-control="prev|next"` inside a
`[data-flipbook-controls]` container, and the keyboard-focusable book root
carries `[data-flipbook-kb]`. Style them by attribute; label them via
`controlLabels={{ previous: '…', next: '…' }}`.

**Center seam / gutter** (the shadow where two pages meet on a desk): overlay
it — the book's stacking is stable under `startZIndex`, so an absolutely
positioned element down the horizontal center of the host with
`mix-blend-mode: multiply` and a symmetric gradient reads as the spine and
never intercepts input (`pointer-events: none`). A built-in `--stf-gutter` is
on the 3.1 list.

```css
.spine {
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  width: 48px;
  transform: translateX(-50%);
  pointer-events: none;
  mix-blend-mode: multiply;
  background: linear-gradient(to right, transparent, rgb(0 0 0 / 0.18), transparent);
}
```

---

## Recipes and common mistakes

**Deep link / resume.** Controlled `page` + `pageTransition="instant"` is the
URL path; animate is an in-app turn:

```tsx
<HTMLFlipBook
  page={pageFromUrl}
  pageTransition="instant"
  onPageChange={(s) => history.replaceState(null, '', `#page-${s.page}`)}
  width={300}
  height={500}
>
  …
</HTMLFlipBook>
```

**Hard covers with visible controls.**

```tsx
<HTMLFlipBook width={300} height={500} hardCovers controls="visible">
  <div>{/* front cover — shown alone, turns rigidly */}</div>
  <div>…</div>
  <div>{/* back cover — also shown alone */}</div>
</HTMLFlipBook>
```

**Front-matter page labels.** `liveRegionText` renders the screen-reader
announcement, so roman-numeral front matter announces correctly:

```tsx
liveRegionText={(page, pageCount) =>
  page < 4 ? `Page ${['i', 'ii', 'iii', 'iv'][page]}` : `Page ${page - 3} of ${pageCount - 4}`
}
```

**Turn progress / scrubber thumb.** Subscribe to `turnProgress` (React:
`onTurnProgress`) instead of rAF-polling `getState()`. Progress is geometric
completion in `[0, 1]`; `direction` is semantic page-index order (`'next'`
still means higher indices under RTL). Instant turns and hover peels emit
nothing — treat `flip` / `changeState` as completion, never the last progress
tick.

```ts
// Core
book.on('turnProgress', ({ data }) => {
  scrubber.value = data.progress; // 0…1 while the fold moves
});
book.on('flip', () => {
  scrubber.value = 1; // committed — progress does not synthesise a final 1.0
});
```

```tsx
// React
<HTMLFlipBook
  width={300}
  height={500}
  onTurnProgress={({ progress }) => setThumb(progress)}
  onPageChange={() => setThumb(1)}
>
  …
</HTMLFlipBook>
```

### Events

| Core event          | React prop            | Payload                                              | Notes                                                                               |
| ------------------- | --------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `flip`              | `onPageChange`        | `BookSnapshot`                                       | Real page change only (never a repaint)                                             |
| `changeOrientation` | `onChangeOrientation` | `{ orientation }`                                    | Portrait / landscape                                                                |
| `changeState`       | `onChangeState`       | `{ state }`                                          | `read` / `user_fold` / `fold_corner` / `flipping`                                   |
| `ready`             | `onReady`             | `BookSnapshot`                                       | Once per engine                                                                     |
| `loaded`            | `onLoaded`            | `BookSnapshot`                                       | Every load, including the first                                                     |
| `pagesChanged`      | `onPagesChanged`      | `BookSnapshot`                                       | Collection replaced                                                                 |
| `turnRejected`      | `onTurnRejected`      | `{ reason, direction, targetPage, landedOn, code? }` | Turn did not start                                                                  |
| `turnProgress`      | `onTurnProgress`      | `{ progress: number; direction: 'next' \| 'prev' }`  | Fold position stream; silent on instant turns / hover peel; not a completion signal |

**Mistakes the API catches loudly:**

- **Settings are validated strictly.** `'false'` strings, `NaN` dimensions,
  negative times all throw `PageFlipError` with `code: 'INVALID_SETTING'` and
  the offending key on `err.setting` — a book that cannot work fails at
  construction, not as an invisible `NaNpx` box.
- **`page` without `onPageChange` is a locked book.** The engine turns, your
  prop snaps it back. Controlled means both halves.
- **`sizing: 'fixed'` plus authored bounds throws.** Under fixed, min/max
  derive from `width`/`height`; delete the bounds.
- **Don't seed page state from `onPageChange`.** It fires only for real turns
  — use `onLoaded`, which carries the resolved page and count.
- **Don't feed `initialPage` from live URL state.** It is a remount key: a
  turn that writes the URL hands back a new `initialPage`, which rebuilds the
  engine at exactly animation end — a flicker on every turn. Freeze the deep
  link at mount, or use controlled `page` + `onPageChange` (live, never
  remounts). The binding warns in dev when it sees this pattern.
- **Style an inner wrapper, not the leaf root.** See Styling above.

---

## Accessibility

- **`useKeyboard`** — ArrowLeft/Right, Home, End. Default is on for copy-paste demos; set `false` if you ship your own labeled controls.
- **`aria-label`** names the book (default `"Flipbook"`).
- **`liveRegion`** announces page changes (`role="status"`). Override with `liveRegionText`.
- **`respectReducedMotion`** (engine, default `true`) — turns become instant under `prefers-reduced-motion`.
- **`readingDirection: 'rtl'`** inverts turn direction only, never pointer coordinates.
- **`controls`** — `'auto'` (skip-link, default), `'visible'`, or `'none'` if you render your own.
- Vanilla: wire `flipNext` / `flipPrev` to your own buttons; listen for `turnRejected` when a turn does not start.

---

## SSR, CSP, RTL

- **SSR.** Imports are side-effect-safe (no `window`/`document` at module
  scope). The React binding renders a `data-flipbook-placeholder` shell on the
  server with **no leaves** — you own the no-JS content — and builds the real
  book after hydration.
- **CSP.** The engine injects its stylesheet at runtime by default. Under a
  strict `style-src`, pass `injectStyles={false}` and ship the exported
  stylesheet yourself: `import '@gullabs/flipbook-core/style.css'` (or inline
  the exported `FLIPBOOK_CSS` string with your nonce).
- **RTL.** `readingDirection: 'rtl'` inverts _turn direction_ only — click,
  corner, swipe, and keyboard all move backwards through page order — but the
  fold always follows the finger; pointer coordinates are never mirrored.

The full public surface, and the map from upstream's getters to it, is in
[`MIGRATION.md`](./MIGRATION.md#the-supported-façade). One rule worth repeating:
a React host portals its page elements into `getBlockElement()`, always — that
node is the only supported mount target.

---

## Development

Node `>=22` (`.nvmrc` pins 24). Package manager is **pnpm**.

```bash
pnpm install
pnpm quality:ci
```

See [`CONTRIBUTING.md`](./CONTRIBUTING.md), [`AGENTS.md`](./AGENTS.md), and
[`ROADMAP.md`](./ROADMAP.md). Other GulLabs open source:
[github.com/gul-labs](https://github.com/gul-labs).

---

## License

Licensed per package — Copyright (c) 2026 Gul Labs, with upstream Nodlik MIT
notices retained in [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).

| Package                   | License                            |                   |
| ------------------------- | ---------------------------------- | ----------------- |
| `@gullabs/flipbook-core`  | [MPL-2.0](./packages/core/LICENSE) | the flip engine   |
| `@gullabs/react-flipbook` | [MIT](./packages/react/LICENSE)    | the React binding |

**What MPL-2.0 means for you.** It is file-level copyleft, not application
copyleft. Your application is not subject to it: you may install the engine,
ship it inside a closed-source product, and sell that product, and MPL-2.0
places no license requirement on the code you write around it.

The one way a file of yours becomes Covered is if you put Covered Software into
it — copy engine code into your own module and that module is a Modification.
Importing, wrapping, configuring or calling the public API does not, so in
normal use the boundary is exactly the engine's own files.

**Nothing is triggered until you distribute.** MPL-2.0's obligations are
distribution-triggered, not modification-triggered. Fork the engine, rewrite it,
run it on an internal tool forever — if you never distribute it, you owe
nothing. Private and internal use carries no obligation of any kind.

**When you do distribute, two duties attach**, and only ever to the Covered
Software — the engine's own files — never to the rest of your application:

- **Distributing the engine's source** (§3.1) — modified or not — must be
  under MPL-2.0, carrying the license notice and without restricting
  recipients' rights in that source. Modification is not what triggers this;
  distribution is.
- **Distributing the engine in built form** (§3.2) requires that the
  corresponding Source Code Form be available _and_ that recipients be informed
  how to obtain it. Both, for each distribution — not a one-off. Note this
  includes serving bundled JavaScript from a website: shipping client-side code
  to a browser is distribution.

In the common case — `npm install`, bundle, deploy, engine unmodified — the
source-availability half is already met by
<https://github.com/gul-labs/flipbook>, which is the Source Code Form and is
offered under MPL-2.0. (The npm package is not: it ships `dist` only, so it is
Executable Form. Point people at the repository, not at the tarball.) What
remains yours is the notice: carry a line in your licenses/acknowledgements such as “includes
@gullabs/flipbook-core, MPL-2.0, source at
https://github.com/gul-labs/flipbook”. Most bundlers' license plugins emit this
automatically. Note the notice accompanies each distribution, and it depends on
that source staying reachable — if this repository ever disappeared you would
need to make the corresponding source available yourself.

If you modified the engine, the source you point at must be _your_ version:
publish those files under MPL-2.0, per §3.1, and point your notice at them
rather than at this repository.

The practical test for whether you have modifications to publish is whether you
edit files under
`packages/core/src`.

## Trademark

"GulLabs", "@gullabs", the GulLabs name and the GulLabs logo are trademarks of
GulLabs. The licenses above grant rights to the code, not to the marks.

You may state that your project uses or is built on `@gullabs/flipbook-core`.
You may not use the GulLabs name or marks to name, brand or promote a fork or a
derived product in a way that suggests it is the official project or endorsed by
GulLabs. Forks are welcome — please rename them.
