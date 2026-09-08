/**
 * Four historical canvas/HTML pointer defects (I-series audit):
 *
 *  - U2: `pointercancel` was bound to `onPointerUp`, so an OS-level pointer
 *        cancellation ran the SWIPE branch and could COMMIT a page turn the
 *        user's gesture was aborted out of.
 *  - U7: `HTMLPage.drawSoft` built its clip polygon by appending and then
 *        `slice(0, -2)`. With no non-null points in `state.area` that leaves
 *        the literal `polygon)` — invalid CSS, dropped by the browser — so the
 *        flipping leaf paints as a FULL UNCLIPPED RECTANGLE for that frame.
 *  - U8: `newTemporaryCopy` appended the clone via `parentElement?.`, so a
 *        detached leaf produced a copy that was never in the document and a
 *        turn that animated nothing, silently.
 *  - U1: `HTMLUI.clear()` handed the consumer's nodes back still dressed as
 *        engine leaves — `stf__item`, `--soft/--left/--simple`, and an inline
 *        `position:absolute` / `clip-path` / `transform` written wholesale by
 *        `draw`.
 *
 * Fixture discipline (this repo has shipped fixtures where the wrong value
 * coincided with the right one five separate times): every behavioural
 * assertion below is preceded by a precondition proving the fixture is in the
 * regime where broken and fixed differ.
 *
 *  - U2 asserts that the IDENTICAL gesture ended with `pointerup` really does
 *    commit a turn. Without that, "cancel did not turn the page" is satisfied
 *    by a gesture that was never a swipe.
 *  - U7 asserts that a genuine 4-vertex fold produces a polygon of NON-ZERO
 *    area, so the zero-area claim about the degenerate frame means something.
 *  - U8 asserts the attached leaf's clone really is appended next to it, so
 *    the throw is about detachment and not about clones being unsupported.
 *  - U1 gives one leaf a consumer inline style, a consumer class, a class
 *    added while the book is live, AND a pre-existing `--left`, then asserts
 *    the leaf was genuinely dressed before release.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FlippingState, PageDensity, PageFlip, PageFlipError } from '@gullabs/flipbook-core';
import { testFlip, testPage } from './engine-access';
import { Page } from '../src/Page/Page';
import {
  installPointerCaptureShims,
  makeHtmlBook,
  makePages,
  sizeElement,
} from './html-book-fixture';

const books: Array<{ destroy: () => void }> = [];

beforeEach(() => {
  installPointerCaptureShims();
});

afterEach(() => {
  while (books.length) books.pop()?.destroy();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

function book(opts?: Parameters<typeof makeHtmlBook>[0]) {
  const b = makeHtmlBook(opts);
  books.push(b);
  return b;
}

function pointer(
  type: string,
  target: EventTarget,
  init: PointerEventInit & { clientX: number; clientY: number },
): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      button: 0,
      buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
      pointerType: 'mouse',
      ...init,
    }),
  );
}

/** A hover: no button held, no gesture in progress. */
function hover(target: EventTarget, clientX: number, clientY: number): void {
  target.dispatchEvent(
    new PointerEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      button: -1,
      buttons: 0,
      pointerType: 'mouse',
      clientX,
      clientY,
    }),
  );
}

/* ------------------------------------------------------------------ *
 * U2 — a cancelled pointer abandons the turn, never commits it
 * ------------------------------------------------------------------ */

/**
 * One fast right-to-left drag that clears `swipeDistance` inside the swipe
 * timeout, ended by `endType`. Returns the book so the caller can inspect it.
 */
function swipeGesture(endType: 'pointerup' | 'pointercancel'): PageFlip {
  const { book: app } = book({ pageCount: 6, flippingTime: 0, swipeDistance: 30 });
  const dist = app.getBlockElement();
  const rect = app.getBoundsRect();

  const y = rect.top + 20;
  const startX = rect.left + rect.width - 10;

  pointer('pointerdown', dist, { clientX: startX, clientY: y });
  pointer('pointermove', dist, { clientX: startX - 60, clientY: y });
  pointer(endType, dist, { clientX: startX - 120, clientY: y });

  return app;
}

describe('U2 pointercancel abandons the gesture instead of completing it', () => {
  test('the same swipe commits on pointerup', () => {
    // PRECONDITION for the test below: this gesture really is a swipe that the
    // engine turns a page on. Without this, "cancel did not turn" is vacuous.
    const app = swipeGesture('pointerup');

    expect(app.getCurrentPageIndex()).toBe(1);
    expect(app.getState()).toBe(FlippingState.READ);
  });

  test('pointercancel commits nothing and leaves no fold behind', () => {
    const app = swipeGesture('pointercancel');

    // The turn the user aborted out of must NOT have happened.
    expect(app.getCurrentPageIndex()).toBe(0);

    // ...and the engine must not be left mid-fold. This is what catches a
    // half-fix that only releases the pointer capture, or one that routes to
    // `userStop(pos, true)` without abandoning the calculation: both leave the
    // state machine in USER_FOLD.
    expect(app.getState()).toBe(FlippingState.READ);

    const flip = testFlip(app);
    expect(flip?.getCalculation() ?? null).toBeNull();

    // ...and the engine no longer believes a finger is down. A button-less
    // hover in the MIDDLE of the spread (nowhere near a corner) must fold
    // nothing; if `isUserTouch` were still set it would drag the fold.
    const rect = app.getBoundsRect();
    hover(app.getBlockElement(), rect.left + rect.width / 2, rect.top + rect.height / 2);
    expect(app.getState()).toBe(FlippingState.READ);
  });

  test('a cancelled slow drag past the midpoint does not complete the turn either', () => {
    const { book: app } = book({ pageCount: 6, flippingTime: 0, swipeDistance: 30 });
    const dist = app.getBlockElement();
    const rect = app.getBoundsRect();
    const y = rect.top + 20;
    const startX = rect.left + rect.width - 10;

    // Dragged well past the leaf's midpoint but still inside the block: this
    // is the regime where a `stopMove()` snap would carry the turn FORWARD
    // rather than back.
    const deepX = rect.left + rect.width / 2 + 20;

    pointer('pointerdown', dist, { clientX: startX, clientY: y });
    // Stepped, the way a real drag arrives. One giant jump leaves the leaf's
    // reachable region and the calculation drops the fold.
    for (let x = startX; x >= deepX; x -= 10) {
      pointer('pointermove', dist, { clientX: x, clientY: y });
    }
    expect(app.getState()).toBe(FlippingState.USER_FOLD);

    pointer('pointercancel', dist, { clientX: deepX, clientY: y });

    expect(app.getState()).toBe(FlippingState.READ);
    expect(app.getCurrentPageIndex()).toBe(0);
  });

  test('a cancel from a pointer that never owned the gesture is ignored', () => {
    const { book: app } = book({ pageCount: 6, flippingTime: 0 });
    const dist = app.getBlockElement();
    const rect = app.getBoundsRect();

    pointer('pointerdown', dist, {
      pointerId: 1,
      clientX: rect.left + rect.width - 6,
      clientY: rect.top + 6,
    });
    pointer('pointermove', dist, {
      pointerId: 1,
      clientX: rect.left + rect.width - 80,
      clientY: rect.top + 40,
    });
    expect(app.getState()).toBe(FlippingState.USER_FOLD);

    // A second, unrelated pointer is cancelled. The owning gesture survives.
    pointer('pointercancel', dist, {
      pointerId: 2,
      clientX: rect.left + 20,
      clientY: rect.top + rect.height - 20,
    });
    expect(app.getState()).toBe(FlippingState.USER_FOLD);

    // And the owner's own cancel still ends it.
    pointer('pointercancel', dist, {
      pointerId: 1,
      clientX: rect.left + rect.width - 80,
      clientY: rect.top + 40,
    });
    expect(app.getState()).toBe(FlippingState.READ);
    expect(app.getCurrentPageIndex()).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * U7 — a degenerate fold area clips to nothing, never to everything
 * ------------------------------------------------------------------ */

/** The `clip-path` value out of an element's inline style, or null. */
function clipPathOf(el: HTMLElement): string | null {
  const match = /clip-path:\s*([^;]+)/i.exec(el.style.cssText);
  return match?.[1]?.trim() ?? null;
}

/**
 * Parse a `polygon(...)` value into vertices, rejecting anything a browser
 * would drop. Throws with the offending string so a failure is readable.
 */
function polygonVertices(value: string): Array<[number, number]> {
  const shape = /^polygon\(\s*(.*?)\s*\)$/i.exec(value);
  if (!shape) throw new Error(`not a polygon(): ${JSON.stringify(value)}`);

  const body = shape[1] ?? '';
  if (body === '') throw new Error(`empty polygon(): ${JSON.stringify(value)}`);

  return body.split(',').map((pair) => {
    const coords = /^\s*(-?[\d.]+)px\s+(-?[\d.]+)px\s*$/.exec(pair);
    if (!coords) throw new Error(`bad vertex ${JSON.stringify(pair)} in ${JSON.stringify(value)}`);
    return [Number(coords[1]), Number(coords[2])];
  });
}

/** Shoelace area. Zero means the clip shows nothing. */
function polygonArea(points: Array<[number, number]>): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(sum) / 2;
}

describe('U7 drawSoft never emits an invalid clip-path', () => {
  test('a real fold area produces a polygon enclosing area (fixture precondition)', () => {
    const { book: app } = book({ pageCount: 4, flippingTime: 0 });
    const page = testPage(app, 0) as Page;

    page.setArea([
      { x: 0, y: 0 },
      { x: 180, y: 10 },
      { x: 160, y: 300 },
      { x: 0, y: 300 },
    ]);
    page.setPosition({ x: 20, y: 0 });
    page.setAngle(0);
    page.draw(PageDensity.SOFT);

    const clip = clipPathOf(page.getElement());
    expect(clip).not.toBeNull();

    const vertices = polygonVertices(clip!);
    expect(vertices).toHaveLength(4);
    // The whole point of the degenerate assertion below is that this number is
    // normally large. If a fold clipped nothing to begin with, that test would
    // pass against the broken implementation too.
    expect(polygonArea(vertices)).toBeGreaterThan(1000);
  });

  test('an empty area clips the leaf to nothing, not to the whole rectangle', () => {
    const { book: app } = book({ pageCount: 4, flippingTime: 0 });
    const page = testPage(app, 0) as Page;

    page.setArea([]);
    page.setPosition({ x: 20, y: 0 });
    page.setAngle(0);
    page.draw(PageDensity.SOFT);

    const el = page.getElement();
    const clip = clipPathOf(el);

    // Pre-fix this is the literal string `polygon)`, which a browser drops —
    // and a dropped clip-path is not "no fold", it is NO CLIP: the leaf paints
    // as a full opaque rectangle across the spread.
    expect(clip).not.toBeNull();
    expect(clip).not.toMatch(/^none$/i);

    // Parses (so the browser keeps it) and encloses nothing (so it shows
    // nothing). `polygon)` and `polygon()` both throw here; a page-rect
    // fallback parses fine and fails on the area.
    const vertices = polygonVertices(clip!);
    expect(vertices.length).toBeGreaterThanOrEqual(3);
    expect(polygonArea(vertices)).toBe(0);

    // (`-webkit-clip-path` is asserted in the e2e/browser tests; jsdom's CSSOM
    // drops the prefixed property from `cssText` entirely, so asserting it here
    // would only be asserting a jsdom limitation.)
  });

  test('an area of only null points is the same case', () => {
    const { book: app } = book({ pageCount: 4, flippingTime: 0 });
    const page = testPage(app, 0) as Page;

    // PRECONDITION: these are the entries the renderers skip, so the loop
    // really does produce zero vertices from a non-empty array.
    page.setArea([null, null]);
    page.setPosition({ x: 0, y: 0 });
    page.setAngle(0);
    page.draw(PageDensity.SOFT);

    const clip = clipPathOf(page.getElement());
    expect(clip).not.toBeNull();
    expect(polygonArea(polygonVertices(clip!))).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * U8 — a detached leaf is an error, not an invisible turn
 * ------------------------------------------------------------------ */

describe('U8 newTemporaryCopy refuses a detached page element', () => {
  test('an attached leaf clones next to itself (fixture precondition)', () => {
    const { book: app } = book({ pageCount: 4, flippingTime: 0, initialPage: 2 });
    const page = testPage(app, 2) as Page;

    // The HARD branch returns `this` and never appends; this must be the SOFT
    // path or the test proves nothing about the append.
    expect(page.getDensity()).toBe(PageDensity.SOFT);

    const copy = page.newTemporaryCopy() as Page;
    expect(copy).not.toBe(page);
    expect(copy.getElement().parentElement).toBe(page.getElement().parentElement);
    expect(copy.getElement().isConnected).toBe(true);

    page.hideTemporaryCopy();
    expect(page.getTemporaryCopy()).toBeNull();
  });

  test('a detached leaf throws PageFlipError instead of animating nothing', () => {
    const { book: app } = book({ pageCount: 4, flippingTime: 0, initialPage: 2 });
    const page = testPage(app, 2) as Page;
    const el = page.getElement();

    // A React unmount racing the turn: the node leaves the block while the
    // engine still holds the Page.
    el.remove();
    expect(el.parentElement).toBeNull();

    let thrown: unknown = null;
    try {
      page.newTemporaryCopy();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PageFlipError);
    expect((thrown as PageFlipError).code).toBe('DETACHED_PAGE');

    // Nothing half-built was left behind: pre-fix a copy existed and was
    // returned, and this is also what catches a guard placed at the append
    // instead of before the clone.
    expect(page.getTemporaryCopy()).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * U1 — released leaves are handed back undressed
 * ------------------------------------------------------------------ */

/** One real render-loop frame, so the leaves are drawn by the engine itself. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

/**
 * A LANDSCAPE book — both leaves of the first spread get drawn, so the release
 * assertions cover a `--left` page and a `--right` one.
 */
function dressedBook(): { app: PageFlip; host: HTMLElement; pages: HTMLElement[] } {
  const width = 200;
  const height = 300;
  const hostW = width * 2 + 60;
  const hostH = height;

  const host = document.createElement('div');
  document.body.appendChild(host);
  sizeElement(host, hostW, hostH);

  const pages = makePages(4);

  for (const p of pages) {
    p.classList.add('my-page');
    p.style.borderRadius = '8px';
    host.appendChild(p);
  }

  // A consumer class that COLLIDES with one of the engine's own names. The
  // engine adds `--left` / `--right` itself, and it must not walk off with a
  // class it did not put there.
  pages[0]!.classList.add('--left');

  const app = new PageFlip(host, {
    width,
    height,
    sizing: 'fixed',
    flippingTime: 0,
    usePortrait: false,
    drawShadow: true,
    pageBackground: '#fff',
  });

  app.loadFromHTML(pages);
  sizeElement(app.getBlockElement(), hostW, hostH);
  app.update();

  return { app, host, pages };
}

describe('U1 destroy() returns the consumer’s nodes undressed', () => {
  test('engine classes and engine inline styles come off; the consumer’s survive', async () => {
    const { app, host, pages } = dressedBook();
    const leaf = pages[0]!;

    // Let the engine's own render loop paint a frame. Nothing is stubbed: this
    // is `HTMLRender.drawFrame` -> `HTMLPage.simpleDraw` writing real cssText.
    await nextFrame();

    // PRECONDITIONS. The leaf really is dressed as an engine page, otherwise
    // "not dressed after destroy" is true of a book that never drew.
    expect(leaf.classList.contains('stf__item')).toBe(true);
    expect(leaf.classList.contains('--soft')).toBe(true);
    // Named individually so the post-conditions below cannot be vacuous:
    // `simpleDraw` writes exactly these, and they are all absent from a
    // consumer's untouched leaf.
    expect(leaf.style.position).toBe('absolute');
    expect(leaf.style.left).not.toBe('');
    expect(leaf.style.width).toBe('200px');
    expect(leaf.style.height).toBe('300px');
    // NF4: draw applies engine props surgically and leaves the consumer's
    // border-radius alone (the old wholesale cssText wipe is gone).
    expect(leaf.style.borderRadius).toBe('8px');

    // A class the consumer toggles WHILE the book is live. Restoring
    // `className` from the adoption-time snapshot would silently drop this.
    leaf.classList.add('is-current');

    // A node the engine never adopted: React's portal renders straight into
    // the block, and release must not touch it.
    const dist = app.getBlockElement();
    const portalled = document.createElement('div');
    portalled.className = 'stf__item --soft';
    portalled.style.cssText = 'position:absolute;left:12px';
    dist.appendChild(portalled);

    app.destroy();

    // Handed back to the host (I4) ...
    expect(leaf.parentElement).toBe(host);

    // ... and undressed (U1).
    expect(leaf.classList.contains('stf__item')).toBe(false);
    expect(leaf.classList.contains('--soft')).toBe(false);
    expect(leaf.classList.contains('--hard')).toBe(false);
    expect(leaf.classList.contains('--right')).toBe(false);
    expect(leaf.classList.contains('--simple')).toBe(false);

    // The consumer's own class survives, and so does the one they added after
    // the book was built.
    expect(leaf.classList.contains('my-page')).toBe(true);
    expect(leaf.classList.contains('is-current')).toBe(true);

    // The colliding class was theirs. Stripping every engine name blindly is
    // the obvious wrong variant and it fails here.
    expect(leaf.classList.contains('--left')).toBe(true);

    // Inline style is back to what the consumer had, not blanked and not left
    // absolutely positioned. `cssText = ''` is the other obvious wrong variant
    // and it fails on the border-radius.
    expect(leaf.style.borderRadius).toBe('8px');
    expect(leaf.style.position).toBe('');
    expect(leaf.style.left).toBe('');
    expect(leaf.style.width).toBe('');
    expect(leaf.style.height).toBe('');
    expect(leaf.style.backgroundColor).toBe('');

    // Every other adopted leaf is undressed too, and none of them kept a
    // `--left` they never had.
    for (const other of pages.slice(1)) {
      expect(other.classList.contains('stf__item')).toBe(false);
      expect(other.classList.contains('--left')).toBe(false);
      expect(other.classList.contains('--right')).toBe(false);
      expect(other.style.borderRadius).toBe('8px');
      expect(other.style.position).toBe('');
    }

    // The non-adopted node is untouched: releasing everything inside the block
    // is the failure the `adopted` set exists to prevent.
    expect(portalled.classList.contains('stf__item')).toBe(true);
    expect(portalled.style.position).toBe('absolute');

    host.remove();
  });

  test('a leaf dropped by updateItems is undressed before it is discarded', async () => {
    const { app, host, pages } = dressedBook();
    const dropped = pages[3]!;

    // Draw, then turn to the second spread so the leaf about to be dropped has
    // actually been painted — an undrawn leaf would prove nothing about style
    // restoration.
    await nextFrame();
    app.turnToPage(2);
    await nextFrame();

    expect(dropped.classList.contains('stf__item')).toBe(true);
    expect(dropped.style.position).toBe('absolute');
    // Surgical engine styles (NF4) leave consumer declarations alone while the
    // leaf is dressed — a cssText wipe would have blanked border-radius here.
    expect(dropped.style.borderRadius).toBe('8px');

    app.updateFromHtml(pages.slice(0, 3));

    expect(dropped.isConnected).toBe(false);
    expect(dropped.classList.contains('stf__item')).toBe(false);
    expect(dropped.classList.contains('my-page')).toBe(true);
    expect(dropped.style.borderRadius).toBe('8px');
    expect(dropped.style.position).toBe('');

    app.destroy();
    host.remove();
  });
});

/* ------------------------------------------------------------------ *
 * Y3 — `pointerleave` filters by pointer id like every other handler
 * ------------------------------------------------------------------ */

/**
 * A book in the ONLY regime where `onPointerLeave` acts on a gesture: capture
 * was requested and did NOT take. With a live capture the handler returns early
 * whatever the id is, so a fixture that let capture succeed could not tell the
 * fix from the bug — it would be the `flippingTime: 0` mistake in another
 * costume.
 */
function uncapturedDragBook(): { app: PageFlip; dist: HTMLElement } {
  const { book: app } = book({ pageCount: 6, flippingTime: 0 });
  const dist = app.getBlockElement();

  // A UA that declines this particular capture without throwing — the case
  // `pointerCaptured` exists for.
  dist.hasPointerCapture = () => false;

  const rect = app.getBoundsRect();
  pointer('pointerdown', dist, {
    pointerId: 1,
    clientX: rect.left + rect.width - 6,
    clientY: rect.top + 6,
  });
  pointer('pointermove', dist, {
    pointerId: 1,
    clientX: rect.left + rect.width - 80,
    clientY: rect.top + 40,
  });

  return { app, dist };
}

describe('Y3 pointerleave only ends the gesture it belongs to', () => {
  test('the owning pointer leaving an UNCAPTURED gesture still ends it (precondition)', () => {
    // Without this, "the other pointer did not end it" is satisfied by a
    // handler that ends nothing at all, in a fixture where the branch is
    // unreachable.
    const { app, dist } = uncapturedDragBook();
    expect(app.getState()).toBe(FlippingState.USER_FOLD);

    dist.dispatchEvent(new PointerEvent('pointerleave', { pointerId: 1, pointerType: 'mouse' }));

    expect(app.getState()).toBe(FlippingState.READ);
    expect(testFlip(app)?.getCalculation() ?? null).toBeNull();
    expect(app.getCurrentPageIndex()).toBe(0);
  });

  test('a SECOND pointer leaving does not abandon the owner’s in-flight drag', () => {
    const { app, dist } = uncapturedDragBook();
    expect(app.getState()).toBe(FlippingState.USER_FOLD);

    const progress = testFlip(app)?.getCalculation()?.getFlippingProgress();
    // The fold is genuinely open and part-way: "unchanged" has to mean
    // something, and 0 or 100 would be reached by a dropped fold too.
    expect(progress).toBeGreaterThan(0);
    expect(progress).toBeLessThan(100);

    // A hover mouse on a hybrid device walks off the block while the finger is
    // still down. Pre-fix this landed in the uncaptured branch and cancelled
    // the drag.
    dist.dispatchEvent(new PointerEvent('pointerleave', { pointerId: 2, pointerType: 'mouse' }));

    expect(app.getState()).toBe(FlippingState.USER_FOLD);
    expect(testFlip(app)?.getCalculation()?.getFlippingProgress()).toBe(progress);

    // ...and the drag is still live: it keeps tracking its own pointer.
    const rect = app.getBoundsRect();
    pointer('pointermove', dist, {
      pointerId: 1,
      clientX: rect.left + rect.width - 140,
      clientY: rect.top + 60,
    });
    expect(testFlip(app)?.getCalculation()?.getFlippingProgress()).toBeGreaterThan(progress!);

    // And the owner's own leave still ends it.
    dist.dispatchEvent(new PointerEvent('pointerleave', { pointerId: 1, pointerType: 'mouse' }));
    expect(app.getState()).toBe(FlippingState.READ);
  });

  test('with no gesture in flight ANY pointer’s leave still unfolds a hover corner', () => {
    // The filter must pass the no-gesture case through. `activePointerId !==
    // e.pointerId` is the obvious wrong spelling of this fix and it fails here:
    // `null !== 2` would return early and leave the corner folded up forever.
    const { book: app } = book({ pageCount: 6, flippingTime: 0, foldCornerOnHover: true });
    const dist = app.getBlockElement();
    const rect = app.getBoundsRect();

    hover(dist, rect.left + rect.width - 4, rect.top + rect.height - 4);
    expect(app.getState()).toBe(FlippingState.FOLD_CORNER);

    dist.dispatchEvent(new PointerEvent('pointerleave', { pointerId: 2, pointerType: 'mouse' }));

    expect(app.getState()).toBe(FlippingState.READ);
  });
});
