/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * X4, X5, X6, X7 (historical teardown/capture audit).
 *
 * Four defects that only show up at the seams — a teardown that races the
 * render loop, a pointer capture that failed, a `destroy()` that reshuffles the
 * consumer's DOM, and an input mode that forgot half its job.
 *
 * Every test here was observed FAILING with its fix reverted, and against a
 * deliberately subtly-wrong variant of the fix (AGENTS.md §2). Where the
 * subtly-wrong variant is the interesting part, the comment says what it was.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PageFlip, PageFlipError, FlippingState } from '@gullabs/flipbook-core';

import { installPointerCaptureShims, makeHtmlBook, makePages } from './html-book-fixture';
import { testCollection, testUI } from './engine-access';

const books: Array<{ destroy: () => void }> = [];

function book(opts?: Parameters<typeof makeHtmlBook>[0]) {
  const b = makeHtmlBook(opts);
  books.push(b);
  return b;
}

/* ------------------------------------------------------------------ *
 * A hand-driven rAF, so "the frame that was already scheduled" is a
 * thing the test can actually run. A real rAF cannot be asked to
 * deliver exactly one more frame after a teardown.
 * ------------------------------------------------------------------ */

let pendingFrame: ((timer: number) => void) | null = null;
let realRaf: typeof globalThis.requestAnimationFrame | undefined;
let realCancelRaf: typeof globalThis.cancelAnimationFrame | undefined;

function installFakeRaf(): void {
  realRaf = globalThis.requestAnimationFrame;
  realCancelRaf = globalThis.cancelAnimationFrame;

  let nextId = 0;
  globalThis.requestAnimationFrame = ((cb: (timer: number) => void): number => {
    pendingFrame = cb;
    nextId += 1;
    return nextId;
  }) as typeof globalThis.requestAnimationFrame;

  globalThis.cancelAnimationFrame = ((): void => {
    pendingFrame = null;
  }) as typeof globalThis.cancelAnimationFrame;
}

function restoreRaf(): void {
  if (realRaf) globalThis.requestAnimationFrame = realRaf;
  if (realCancelRaf) globalThis.cancelAnimationFrame = realCancelRaf;
  pendingFrame = null;
}

/** Run the frame the loop has scheduled, exactly as the browser would. */
function tick(timer: number): void {
  const frame = pendingFrame;
  if (frame === null) throw new Error('no frame scheduled — did the render loop start?');
  pendingFrame = null;
  frame(timer);
}

beforeEach(() => {
  installPointerCaptureShims();
});

afterEach(() => {
  while (books.length) books.pop()?.destroy();
  restoreRaf();
  vi.restoreAllMocks();
});

/* ================================================================== *
 * X4
 * ================================================================== */

/**
 * X4 — `destroy()` from an `onFlip` handler.
 *
 * The render loop runs `onAnimateEnd` (which is what emits `flip`) and then
 * drew ONE more frame unconditionally. That trailing frame reads engine state
 * back out — the HTML renderer iterates `getPageCollection()`, the canvas one
 * asks `getUI()` for the backing scale — so nulling both threw a
 * `PageFlipError('DESTROYED')` out of the consumer's rAF callback for doing
 * exactly what the destroy contract documents.
 *
 * `Render` now declines both the trailing draw and the loop re-arm once the
 * loop generation has moved (`stop()` bumps it, and `destroy()` calls `stop()`),
 * so the frame does not happen at all. These tests are what keeps that true:
 * revert either `Render` guard and the two below fail.
 *
 * The bar (per the brief): destroy from inside a real `onFlip` on a real
 * engine, and assert that nothing escapes the rAF callback. Asserting only
 * that `destroy()` itself does not throw proves nothing at all — it never did.
 */
describe('X4 destroying from an onFlip handler survives the frame already in flight', () => {
  test('HTML mode: the trailing frame finds an empty engine, not a throw', () => {
    installFakeRaf();

    const { book: app } = book({ pageCount: 6, flippingTime: 300, usePortrait: true });

    const flips: number[] = [];
    app.on('flip', (e) => {
      flips.push(e.data.page);
      app.destroy();
    });

    expect(app.flipNext()).toBe(true);

    // Frame 0: the animation binds its clock and plays its first frame. The
    // book is still very much alive here.
    tick(0);
    expect(flips).toHaveLength(0);

    // The clock overshoots the frame list: the loop plays the final frame,
    // commits the turn (→ `flip` → the handler destroys the book) and THEN
    // calls `drawFrame()`. This is the whole defect, in one call.
    expect(() => tick(100_000)).not.toThrow();

    // Not vacuous: the handler really ran, and it really destroyed the book.
    expect(flips).toHaveLength(1);
    expect(app.isDestroyed()).toBe(true);
  });

  test('destroy() is unconditional: the guarded accessors report DESTROYED at once', () => {
    const { book: app } = book({ pageCount: 4 });

    app.destroy();

    // Synchronously, with no grace window of any kind. The engine no longer
    // keeps inert stand-ins alive for a trailing frame, because `Render`
    // declines that frame outright (see the test above).
    expect(() => testCollection(app)).toThrow(PageFlipError);
    expect(() => testUI(app)).toThrow(PageFlipError);
  });
});

/* ================================================================== *
 * X5
 * ================================================================== */

/**
 * X5 — a gesture whose `setPointerCapture` failed.
 *
 * The capture call is wrapped in `try`/`catch` because capture is optional, but
 * `activePointerId` was recorded either way and `onPointerLeave` returned early
 * whenever an id was set. So where capture fails, dragging out of the block
 * produced no `pointerup`, no leave handling, and a fold that followed a
 * button-less cursor for the life of the book.
 */
describe('X5 a drag that never captured must still end when it leaves the book', () => {
  function drag(app: PageFlip): { dist: HTMLElement; x: number; y: number } {
    const dist = app.getBlockElement();
    const rect = app.getBoundsRect();

    return { dist, x: rect.left + rect.width - 8, y: rect.top + 12 };
  }

  function pointer(
    type: string,
    target: EventTarget,
    init: PointerEventInit & { clientX?: number; clientY?: number } = {},
  ): void {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        pointerType: 'mouse',
        ...init,
      }),
    );
  }

  test('setPointerCapture throwing does not leave the engine folded forever', () => {
    const { book: app } = book({ pageCount: 4, flippingTime: 0 });
    const { dist, x, y } = drag(app);

    // The browser refuses the capture. Chrome does this for a pointer that is
    // no longer active; some engines do it for a detached target.
    vi.spyOn(dist, 'setPointerCapture').mockImplementation(() => {
      throw new DOMException('InvalidPointerId');
    });

    pointer('pointerdown', dist, { clientX: x, clientY: y });
    pointer('pointermove', dist, { clientX: x - 40, clientY: y + 10 });

    // Precondition: the drag is genuinely in progress. Without this the test
    // would pass on a book that never folded at all.
    expect(app.getState()).toBe(FlippingState.USER_FOLD);

    // The finger leaves the block. With no capture this is the LAST event this
    // element will see for this pointer — no `pointerup` is coming.
    pointer('pointerleave', dist, { buttons: 1 });

    expect(app.getState()).toBe(FlippingState.READ);
  });

  test('a capture silently DECLINED counts as no capture', () => {
    // The subtly-wrong variant this catches: `pointerCaptured = true` whenever
    // `setPointerCapture` did not throw. A UA is allowed to decline a capture
    // without throwing — a pointer that is no longer active, an element just
    // detached — and believing the call is the same bug as swallowing the
    // throw was. jsdom has no `hasPointerCapture`, so both spellings agree
    // there and only this test separates them.
    const { book: app } = book({ pageCount: 4, flippingTime: 0 });
    const { dist, x, y } = drag(app);

    vi.spyOn(dist, 'setPointerCapture').mockImplementation(() => {
      /* accepted, and quietly ignored */
    });
    dist.hasPointerCapture = () => false;

    pointer('pointerdown', dist, { clientX: x, clientY: y });
    pointer('pointermove', dist, { clientX: x - 40, clientY: y + 10 });
    expect(app.getState()).toBe(FlippingState.USER_FOLD);

    pointer('pointerleave', dist, { buttons: 1 });

    expect(app.getState()).toBe(FlippingState.READ);
  });

  test('a captured drag still ignores pointerleave (the fix must not overreach)', () => {
    // The subtly-wrong variant this catches: "just always cancel on leave".
    // That re-opens the double-snap-back the early return exists to prevent,
    // and kills every legitimate drag that crosses the block's edge.
    const { book: app } = book({ pageCount: 4, flippingTime: 0 });
    const { dist, x, y } = drag(app);

    pointer('pointerdown', dist, { clientX: x, clientY: y });
    pointer('pointermove', dist, { clientX: x - 40, clientY: y + 10 });

    const during = app.getState();
    expect(during).toBe(FlippingState.USER_FOLD);

    pointer('pointerleave', dist, { buttons: 1 });

    expect(app.getState()).toBe(during);
  });

  test('lostpointercapture without a following leave abandons the fold', () => {
    const { book: app } = book({ pageCount: 4, flippingTime: 0 });
    const { dist, x, y } = drag(app);

    pointer('pointerdown', dist, { clientX: x, clientY: y });
    pointer('pointermove', dist, { clientX: x - 40, clientY: y + 10 });
    expect(app.getState()).toBe(FlippingState.USER_FOLD);

    pointer('lostpointercapture', dist);

    expect(app.getState()).toBe(FlippingState.READ);
    expect(app.getCurrentPageIndex()).toBe(0);
  });

  test('lostpointercapture from pointerup does not abandon a completed swipe', () => {
    const { book: app } = book({ pageCount: 4, flippingTime: 0 });
    const { dist, x, y } = drag(app);

    pointer('pointerdown', dist, { clientX: x, clientY: y });
    pointer('pointermove', dist, { clientX: x - 40, clientY: y + 10 });
    expect(app.getState()).toBe(FlippingState.USER_FOLD);

    // `releasePointerCapture` fires lostpointercapture synchronously. That
    // must not convert a real up into cancel.
    pointer('pointerup', dist, { clientX: x - 40, clientY: y + 10, buttons: 0 });

    expect(app.getState()).toBe(FlippingState.READ);
    expect(app.getCurrentPageIndex()).toBe(1);
  });

  test('lostpointercapture then leave is idempotent (already abandoned)', () => {
    const { book: app } = book({ pageCount: 4, flippingTime: 0 });
    const { dist, x, y } = drag(app);

    pointer('pointerdown', dist, { clientX: x, clientY: y });
    pointer('pointermove', dist, { clientX: x - 40, clientY: y + 10 });
    expect(app.getState()).toBe(FlippingState.USER_FOLD);

    pointer('lostpointercapture', dist);
    pointer('pointerleave', dist, { buttons: 1 });

    expect(app.getState()).toBe(FlippingState.READ);
  });

  test('leaving without any gesture still only unfolds a hover', () => {
    const { book: app } = book({ pageCount: 4, flippingTime: 0, foldCornerOnHover: true });
    const { dist, x, y } = drag(app);

    dist.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        pointerId: 1,
        button: -1,
        buttons: 0,
        pointerType: 'mouse',
        clientX: x,
        clientY: y,
      }),
    );
    expect(app.getState()).toBe(FlippingState.FOLD_CORNER);

    pointer('pointerleave', dist, { buttons: 0 });

    expect(app.getState()).toBe(FlippingState.READ);
  });
});

/* ================================================================== *
 * X6
 * ================================================================== */

/**
 * X6 — `clear()` re-appended released leaves at the END of the host.
 *
 * The fixture deliberately puts consumer markup BOTH BEFORE AND AFTER the
 * pages. With trailing markup only, a fix that appends to the end coincides
 * with the right answer and the test proves nothing — which has happened here
 * six times.
 */
describe('X6 destroy() hands the pages back where it found them', () => {
  function hostWithSurroundingMarkup(pageCount: number): {
    host: HTMLElement;
    before: HTMLElement;
    after: HTMLElement;
    pages: HTMLElement[];
  } {
    const host = document.createElement('div');
    document.body.appendChild(host);

    const before = document.createElement('header');
    before.dataset.role = 'before';
    const after = document.createElement('footer');
    after.dataset.role = 'after';

    const pages = makePages(pageCount);

    host.appendChild(before);
    for (const p of pages) host.appendChild(p);
    host.appendChild(after);

    return { host, before, after, pages };
  }

  function order(host: HTMLElement): string[] {
    return Array.from(host.children).map((el) => {
      const role = (el as HTMLElement).dataset.role;
      if (role !== undefined) return role;
      const page = (el as HTMLElement).dataset.page;
      return page !== undefined ? `page-${page}` : el.className || el.tagName.toLowerCase();
    });
  }

  test('the consumer’s own markup keeps its position around the pages', () => {
    const { host, pages } = hostWithSurroundingMarkup(4);
    const expected = order(host);

    // Sanity: the fixture really does bracket the pages.
    expect(expected).toEqual(['before', 'page-0', 'page-1', 'page-2', 'page-3', 'after']);

    const app = new PageFlip(host, { width: 200, height: 300, sizing: 'fixed' });
    app.loadFromHTML(pages);

    // Precondition: the engine adopted them, so releasing is meaningful.
    const dist = app.getBlockElement();
    for (const p of pages) expect(p.parentElement).toBe(dist);

    app.destroy();

    expect(order(host)).toEqual(expected);
    host.remove();
  });

  test('a page whose original follower is gone falls back without reordering the rest', () => {
    const { host, after, pages } = hostWithSurroundingMarkup(3);

    const app = new PageFlip(host, { width: 200, height: 300, sizing: 'fixed' });
    app.loadFromHTML(pages);

    // The consumer removed their trailing markup while the book was live, so
    // the last page's recorded anchor no longer exists. Everything else must
    // still come back in order — this is what pins the "verify the anchor,
    // don't trust it" half of the fix.
    after.remove();

    app.destroy();

    expect(order(host)).toEqual(['before', 'page-0', 'page-1', 'page-2']);
    host.remove();
  });
});

/* ================================================================== *
 * X7
 * ================================================================== */

/**
 * X7 — `setHandlers()` early-returned on `pointerInput: []`, so
 * `dragstart` was never bound in that mode. Turning off pointer-driven page
 * turning is not a request to let the browser drag a ghost copy of the artwork
 * out of the page.
 */
describe('X7 the native drag ghost is suppressed regardless of useMouseEvents', () => {
  function dragStartWasPrevented(app: PageFlip): boolean {
    const dist = app.getBlockElement();
    const event = new Event('dragstart', { bubbles: true, cancelable: true });

    dist.dispatchEvent(event);

    return event.defaultPrevented;
  }

  test('pointerInput: [] still prevents dragstart', () => {
    const { book: app } = book({ pageCount: 4, pointerInput: [] });

    expect(dragStartWasPrevented(app)).toBe(true);
  });

  test('pointerInput: full list still prevents dragstart (no regression)', () => {
    const { book: app } = book({
      pageCount: 4,
      pointerInput: ['mouse', 'touch', 'pen'],
    });

    expect(dragStartWasPrevented(app)).toBe(true);
  });

  test('a runtime switch to pointerInput: [] keeps the suppression', () => {
    // `refreshHandlers()` unbinds everything and rebinds — the rebind is where
    // the early return used to drop `dragstart` on the floor.
    const { book: app } = book({
      pageCount: 4,
      pointerInput: ['mouse', 'touch', 'pen'],
    });

    app.updateSettings({ pointerInput: [] });

    expect(dragStartWasPrevented(app)).toBe(true);
  });

  test('after destroy() nothing is listening any more', () => {
    const { host, pages } = (() => {
      const h = document.createElement('div');
      document.body.appendChild(h);
      const p = makePages(3);
      for (const el of p) h.appendChild(el);
      return { host: h, pages: p };
    })();

    const app = new PageFlip(host, { width: 200, height: 300, pointerInput: [] });
    app.loadFromHTML(pages);
    const dist = app.getBlockElement();
    app.destroy();

    const event = new Event('dragstart', { bubbles: true, cancelable: true });
    dist.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    host.remove();
  });
});
