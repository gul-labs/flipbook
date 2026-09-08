# Migration from `page-flip` / `react-pageflip`

`@gullabs/flipbook-core` 3.0.0 replaces `page-flip@2.0.7`;
`@gullabs/react-flipbook` 3.0.0 replaces `react-pageflip@2.0.3`. `width` and
`height` stay required; everything else is optional. This document is the
complete map from the upstream surface to the 3.0 one. The API itself is
specified in [`docs/API-CONTRACT.md`](./docs/API-CONTRACT.md).

## Install

```bash
npm uninstall react-pageflip page-flip && npm i @gullabs/react-flipbook
```

Vanilla engine:

```bash
npm uninstall page-flip && npm i @gullabs/flipbook-core
```

```ts
// before
import { PageFlip } from 'page-flip';
import HTMLFlipBook from 'react-pageflip';

// after
import { PageFlip } from '@gullabs/flipbook-core';
import HTMLFlipBook from '@gullabs/react-flipbook';
```

## The renames — nothing lost, only respelled

Every renamed setting keeps its capability; the old name stated something the
code contradicted. Each is a compile-time break — the old key is a type error
for TypeScript consumers. JavaScript callers passing an old key get the
default behavior for the new one, so migrate the spelling, don't alias it.

| Upstream (2.x)                 | 3.0                                               | Why it moved                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `showCover: boolean`           | `hardCovers: boolean`                             | It is the layout switch for the whole book (covers shown alone, hard), not a visibility toggle.                                                                       |
| `size: 'stretch' \| 'fixed'`   | `sizing: 'responsive' \| 'fixed'`                 | `'stretch'` described the mechanism; `'responsive'` describes the behavior.                                                                                           |
| `startPage: number`            | `initialPage: number`                             | Read once at load; the new name says so.                                                                                                                              |
| `direction: 'ltr' \| 'rtl'`    | `readingDirection: 'ltr' \| 'rtl'`                | It inverts reading order, never pointer coordinates — the fold still follows the finger.                                                                              |
| `useMouseEvents: boolean`      | `pointerInput: PointerKind[]`                     | The boolean gated the one pointer path, so `false` silently killed touch and pen too. `false` → `[]`, `true` → `['mouse', 'touch', 'pen']` (exported `ALL_POINTERS`). |
| `disableFlipByClick: boolean`  | `flipOnClick: 'anywhere' \| 'corners' \| 'never'` | The boolean could not express "corners only" or "never"; `disableFlipByClick: true` still flipped on corner clicks.                                                   |
| `showPageCorners: boolean`     | `foldCornerOnHover: boolean`                      | The corners were always visible; this enables the hover peel.                                                                                                         |
| `clickEventForward: boolean`   | `respectInteractiveContent: boolean`              | Nothing was ever forwarded — the engine declines to start a fold on buttons, links and form controls.                                                                 |
| `mobileScrollSupport: boolean` | `allowTouchScroll: boolean`                       | The check is `pointerType !== 'mouse'` — it covers pen and desktop touchscreens, not a device class.                                                                  |
| `maxHeight`                    | `maxHeight` — **now implemented**                 | Upstream declared it and never read it. A responsive book can now be height-capped, symmetric with `maxWidth`.                                                        |

Methods: **`PageFlip.flip(page, corner?)` is now `flipToPage(page, corner?)`** —
the animated counterpart of `turnToPage`, named like it. The two navigation
triads differ **only** in animation: `flipToPage` / `flipNext` / `flipPrev`
animate; `turnToPage` / `turnToNextPage` / `turnToPrevPage` are instant. The
absolute forms (`*ToPage`) throw `PageFlipError` on an invalid target; the
relative forms return `boolean` and emit `turnRejected` instead — calling
"next" at the end of the book is normal UI, not an exception.

**`flippingTime` now means what it says on every page size.** Upstream scaled
the duration by pixel path length against a magic 1000 px reference, so
`flippingTime: 800` ran ~560 ms on a 350 px phone leaf — phone flips were
silently faster than desktop. A full turn now runs for exactly the configured
time everywhere; a drag released mid-fold still settles in proportion to the
distance it has left. If you were compensating (scaling the setting up by
`1000 / (2 × pageWidth)`), delete the compensation.

New settings, all optional: `pageBackground` (paper color, default `#fff`),
`respectReducedMotion` (default `true` — turns become instant under
`prefers-reduced-motion`), `injectStyles` (default `true` — set `false` under a
strict CSP and ship the exported `style.css` / `FLIPBOOK_CSS` yourself),
`swipeDistance`, and `flippingTime: 0` now means **instant** (upstream threw).

## Events — one shape everywhere

Every payload is now an object; no handler receives a bare number.

| Upstream event                   | 3.0                                                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `init` (fired once per **load**) | `ready` (once per engine) + `loaded` (every load, including the first)                                     |
| `flip` (number payload)          | `flip` (`BookSnapshot`) — fires only when the page actually changes, never for a repaint (ADR 0003)        |
| `update` + `collectionRebuild`   | `pagesChanged` (`BookSnapshot`) — they always fired together with the same data                            |
| `changeOrientation` (string)     | `changeOrientation` (`{ orientation }`)                                                                    |
| `changeState` (string)           | `changeState` (`{ state }`)                                                                                |
| —                                | `turnRejected` (`{ reason, direction, targetPage, landedOn, code? }`)                                      |
| —                                | `turnProgress` (`{ progress, direction }`) — fold stream while a turn/drag is live; React `onTurnProgress` |

`BookSnapshot` is `{ page, pageCount, orientation, visiblePages }`. `page` is
the spread **head** — the first leaf on screen; `visiblePages` is every leaf on
screen in index order (one in portrait, two in landscape, one for a cover), so
"Page 3–4 of 12" renders from the event alone. Core `on()` handlers receive a
`WidgetEvent` (payload on `e.data`); React handlers receive the payload
directly.

`turnRejected.reason` is
`'boundary' | 'disabled' | 'superseded' | 'notReady' | 'invalidPage' | 'setup'`.
`direction` says which button to disable, `targetPage` what was asked for,
`landedOn` where a clamped navigation actually ended up.

**The highest-risk change:** `flip` used to fire on every repaint, including
mount. A book opening at page 0 now emits **no** `flip` at all. If you seeded
initial page state from the first `flip`, use `loaded` — its snapshot carries
the resolved index and the real `pageCount` (killing "Page 1 of 0"). An
out-of-range `initialPage` is clamped into the book, and `loaded` reports where
the book actually landed, not what you asked for.

## Errors — one code, two machine-readable axes

The eight `INVALID_*` codes (`INVALID_SIZE`, `INVALID_DIMENSIONS`,
`INVALID_BOUNDS`, `INVALID_BOOLEAN`, `INVALID_FLIPPING_TIME`,
`INVALID_SWIPE_DISTANCE`, `INVALID_Z_INDEX`, `INVALID_SHADOW_OPACITY`)
collapsed into **`INVALID_SETTING`** with:

- **`err.setting`** — the offending key (`'flippingTime'`, `'width'`, …), so
  highlighting the bad field no longer means parsing the message;
- **`err.kind`** — `'usage'` (you can fix it) | `'lifecycle'` (the engine was
  not in a state to serve the call) | `'internal'` (an engine invariant broke;
  report it), derived from the code so the two cannot drift.

```ts
catch (e) {
  if (e instanceof PageFlipError && e.kind !== 'internal') showToUser(e.setting ?? e.code);
}
```

Validation is strict and loud: booleans must be real booleans (`'false'`, `0`,
`1` throw — upstream accepted them and `'false'` was truthy, so shadows stayed
on), numbers must be finite (`{ width: undefined }` used to render an invisible
`NaN`-sized book with no error), and an explicit `undefined` means "use the
default" rather than clobbering it.

## The supported façade

The engine's public surface is exactly this, pinned by
`packages/core/tests/public-surface.test.ts`:

- **Load:** `loadFromHTML`, `updateFromHtml`, `clear`, `destroy`
- **Navigate:** `flipToPage` / `flipNext` / `flipPrev` (animated),
  `turnToPage` / `turnToNextPage` / `turnToPrevPage` (instant), `canTurn`,
  `cancelTurn` (abandon in-flight work without committing; not finish/pause/jump)
- **Query:** `getPageCount`, `getCurrentPageIndex`, `getVisiblePages`,
  `getOrientation`, `getBoundsRect`, `getSettings`, `getState`,
  `getBlockElement`, `getPageElement`, `isReady`, `isAnimating`, `isDestroyed`
- **Live settings:** `updateSettings`, `update`
- **Input plumbing** (for custom gesture hosts): `startUserTouch`, `userMove`,
  `userStop`
- **Events:** `on`, `off`, `once`

**`getUI()`, `getRender()`, `getPageCollection()`, `getFlipController()` and
`getPage()` are gone**, along with the `Render` / `Page` / `PageCollection` /
`Settings` class exports. They handed out live internal objects whose mutation
could desync the book from its own getters, and they advertised an extension
point that dead-ended (`class MyRenderer extends Render` compiled, but nothing
could install it). Every question they answered has a direct façade answer:

| You called                                    | Use instead                                                          |
| --------------------------------------------- | -------------------------------------------------------------------- |
| `getUI().getDistElement()`                    | `getBlockElement()`                                                  |
| `getPageCollection().getPage(n).getElement()` | `getPageElement(n)`                                                  |
| `getPageCollection()` spread math             | `getVisiblePages()`, `canTurn(dir)`                                  |
| `getRender().getRect()`                       | `getBoundsRect()` (a copy — mutation-inert)                          |
| `getRender().finishAnimation()`               | `turnToPage(n)` — instant turns settle any in-flight animation first |
| `getFlipController()` state checks            | `isAnimating()`, `isReady()`, `getState()`                           |

`getSettings()` and `getBoundsRect()` return **copies**; writing to them does
nothing. Go through `updateSettings()`.

Content queries are **total**: `getPageCount()` / `getCurrentPageIndex()` /
`getVisiblePages()` answer `0` / `0` / `[]` on an unloaded or destroyed book —
an answer chrome can render. Layout queries (`getOrientation`,
`getBoundsRect`, `getBlockElement`) still throw `NOT_LOADED` / `DESTROYED`,
because no honest empty answer exists for layout that was never computed.
`isReady()` additionally requires at least one page, so chrome does not flash
live controls over an empty shell.

One sentence on the React binding's DOM contract: **a React host portals its
page elements into `getBlockElement()`, always** — that node is the engine's
page container and the only supported mount target.

## Canvas / images mode removed (ADR 0002)

The second renderer is deleted. No runtime stub, no `'CANVAS_REMOVED'` code —
callers fail at compile time. Gone: `loadFromImages`, `updateFromImages`,
`ImageFlipBook`, `imageFit`, `imageInset`, `getPageAltText(s)`, and the whole
canvas implementation. The engine is HTML-only: pictures are `<img alt="…">`
inside HTML page elements.

## Sizing

`sizing: 'fixed'` pins the bounds to `width` × `height`. Passing an authored
`minWidth` / `maxWidth` / `minHeight` / `maxHeight` alongside `sizing: 'fixed'`
now **throws `INVALID_SETTING`** — those bounds derive from `width`/`height`
under fixed and used to be silently overwritten. If you are migrating a
`size: 'fixed'` book that also passed bounds, delete the bounds.

`sizing: 'responsive'` respects all four bounds, and the max fallback can no
longer land below an authored min (the book could previously never reach its
own declared minimum, silently).

## Lifecycle behavior changes

Each of these replaces a silent failure with a reported one.

### A destroyed engine is observably dead

`destroy()` drops the internal collection, renderer and UI, and **unbinds every
event listener**. Layout queries and absolute navigation throw `DESTROYED`;
content queries answer empty; `flipNext` / `flipPrev` / `turnToNextPage` /
`turnToPrevPage` return `false` (they still report `turnRejected` with
`code: 'DESTROYED'`, but your listeners were unbound with the engine — register
after `destroy()` if you genuinely want to observe post-mortem refusals).
Cleanup-shaped calls (`destroy`, `update`, `updateSettings`, `updateFromHtml`)
stay safe no-ops, because tearing down twice is normal. Guard late callbacks
with `isDestroyed()`.

`DESTROYED` is deliberately distinct from `NOT_LOADED`: the remedy differs —
"load first" versus "this instance can only be replaced".

### Instant turns settle in-flight animation

`turnToPage` / `turnToNextPage` / `turnToPrevPage` on a book mid-animation
**finish the running turn first**, then jump — a deep-link during a curl can no
longer land between states. A turn superseded this way emits one
`turnRejected` with `reason: 'superseded'`. Re-entrant turns started from
inside your own handlers during the jump are refused silently (`false`).

### `clear()` emits

`clear()` emits `pagesChanged` with `pageCount: 0`, and content queries answer
zero afterwards. Branch on `pageCount === 0` if your handler assumed
`pagesChanged` always meant "new pages arrived".

### Construction-time settings

`hardCovers`, `initialPage` and `injectStyles` are consumed while the book is
built, **and in the React binding they are remount keys — changing one
rebuilds the engine.**

**The URL-sync footgun (read this if your reader is deep-linkable):** do NOT
feed `initialPage` from live route state (`useSearchParams`, `location`).
Every turn that writes the URL hands back a new `initialPage`, and a changed
`initialPage` remounts the engine — so every turn tears the book down at
exactly animation end, which presents as "the destination page flickers".
Freeze the deep link once at mount (`useRef(initialSpreadFromUrl)`), or drive
position with the controlled `page` + `onPageChange` pair, which is live and
never remounts. The binding emits a dev-mode `console.warn` when the engine
remounts within one second of a turn, because that pattern is almost always
this bug.

`updateSettings` refuses a changed value for them — the value is kept
out of the live settings so `getSettings()` stays honest, and a
`console.warn` reports it; echoing back the current value (spreading a whole
settings object) stays silent. Compile-time too: they are absent from the
exported `LiveSetting` type. To change one,
construct a new `PageFlip`; the React binding remounts automatically when the
corresponding props change. Everything else — including `width`/`height`,
`readingDirection`, `pointerInput`, `flipOnClick` — is live.

### Listener semantics

- `once(name, fn)` fires at most once and is removed **before** it runs;
  `off(name, fn)` cancels it by the same reference.
- `off(name, fn)` removes exactly one registration; `off(name)` still removes
  all of them.
- A throwing listener no longer silences the listeners after it: every
  listener runs, the first error throws synchronously from the emitting call,
  the rest surface as uncaught errors.
- `on`/`off` are typed to `FlipbookEventMap` — a typo'd event name is a
  compile error instead of a listener that never fires.

### The render loop is scheduled on demand

An idle book makes no `requestAnimationFrame` calls. The engine wakes itself
for everything that changes what is drawn; if you mutate a page's DOM and need
the engine to re-measure, call `update()`.

## Styling

The engine owns the page **root** (position, size, clip, and paper via
`--stf-paper`); your colors and padding go on an **inner element**. The full
contract — stable selectors, the `--stf-paper` custom property, CSP setup —
lives in the [README's Styling section](./README.md#styling). Two migration
notes:

- A `background` you set on the leaf root itself now loses to the engine's
  paper layer. Move it to an inner wrapper (correct on 2.x too — the engine
  rewrote root styles there as well, just less predictably). Every drawn leaf
  root carries the paper inline — an opaque base plus your `pageBackground`
  as a `var(--stf-paper)` image layer — so the element the fold transforms
  and clips is opaque on every compositor, not only its pseudo-element.
- `pageBackground` accepts any CSS color, including `var()` and translucent
  values — opacity of the fold is structural (an opaque base layer under your
  paper color), no longer a parser gate.

Hard leaves are still declared with `data-density="hard"` on the page element.
`hardCovers: true` hardens **both** covers regardless of page-count parity, and
a hard back cover is shown alone in its landscape spread, like the front.

## React binding

Handler renames (all receive payloads directly, no `.data`):

| react-pageflip 2.x                 | 3.0                                       |
| ---------------------------------- | ----------------------------------------- |
| `onFlip`                           | `onPageChange` (`BookSnapshot`)           |
| `onInit`                           | `onReady` + `onLoaded`                    |
| `onUpdate` / `onCollectionRebuild` | `onPagesChanged`                          |
| `onNavigationError`                | `onTurnRejected`                          |
| `onChangeOrientation` (string)     | `onChangeOrientation` (`{ orientation }`) |
| `onChangeState` (string)           | `onChangeState` (`{ state }`)             |

- **Controlled `page`:** pass `page` + `onPageChange`. `page` without
  `onPageChange` is a locked book — the engine turns, your prop snaps it back.
  `pageTransition="instant"` is the deep-link / `popstate` path; omit it (or
  pass `"animate"`) for in-app turns.
- **`usePageFlip()`** is the uncontrolled hook: spread `bookProps` onto the
  component (never pass `page={book.page}` alongside it). It returns `page`,
  `pageCount`, `orientation`, `visiblePages`, `canGoNext`, `canGoPrev`,
  `lastRejection`, plus actions `flipNext`, `flipPrev`, `goToPage(n, mode?)`.
  The 2.x-era `setPage` / `setPageCount` setters are gone — they desynced
  derived state; `goToPage` actually turns the book.
- **The imperative handle** is `ref.current.pageFlip()` → the engine (or
  `null` before mount, after unmount, and after `destroy()`). Handle actions
  are deliberately forgiving where the engine throws: before mount / after
  unmount they no-op or return `false`, because effects that fire early are
  normal code.
- **`ref.current.destroy()`** tears the engine down while the component stays
  mounted. The portal drops, Next/Prev become `aria-disabled`, and further
  turns report `onTurnRejected({ code: 'DESTROYED' })` — not `NOT_LOADED`
  (that means "load first"; this instance cannot be revived). Unmount already
  destroys; you do not need this then. Revival is unmount or a remount key
  (`hardCovers` / `initialPage` / `injectStyles`). Calling `destroy()` on the
  engine from `pageFlip()` does not retire the React shell until the next
  render — use the handle method.
- `useKeyboard` defaults to **`true`** (ArrowLeft/Right, Home, End); pass
  `false` if you ship your own labeled controls. `controls` is
  `'auto'` (skip-link) | `'visible'` | `'none'`, with `controlLabels` for i18n.
- The binding remounts the engine when `hardCovers`, `initialPage` or
  `injectStyles` change; everything else updates live.
- `react` is a **peer dependency** (`>=18`), and the shipped types survive
  pnpm's isolated `node_modules`.

## Portrait back-curl

The reason this fork exists, and no consumer patch is required: portrait BACK
animates a temporary copy of the **current** leaf — the corrected curl —
instead of sliding the previous leaf in from the left
([StPageFlip #49](https://github.com/Nodlik/StPageFlip/issues/49)). The fold is
opaque; hard covers stay on the rigid path. If you were monkey-patching
`getFlippingPage` or friends from outside, delete the patch — the seams it
needed no longer exist, deliberately.
