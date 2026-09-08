/**
 * Real-world consumer audit against the *published* public surface only.
 *
 * No deep imports of Settings / Render / Flip / HTMLPageCollection. If a
 * consumer cannot do it from `@gullabs/flipbook-core`, it is not in this file.
 *
 * Findings that fail a claim or block a product use case are recorded in
 * historical product-bug findings from the test-writing round.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, test } from 'vitest';
import {
  PageFlip,
  PageFlipError,
  FlippingState,
  ALL_POINTERS,
  SizeMode,
  ensureFlipbookStyles,
  FLIPBOOK_CSS,
  isInteractivePointerTarget,
  DEFAULT_PAGE_BACKGROUND,
} from '@gullabs/flipbook-core';
import type { BookSnapshot, TurnRejected } from '@gullabs/flipbook-core';
import { makeHtmlBook, makePages, sizeElement } from './html-book-fixture';

afterEach(() => {
  document.body.innerHTML = '';
});

function host(w = 400, h = 300): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  sizeElement(el, w, h);
  return el;
}

function loadBook(opts: Parameters<typeof makeHtmlBook>[0] = {}): ReturnType<typeof makeHtmlBook> {
  return makeHtmlBook({ flippingTime: 0, usePortrait: true, pageCount: 6, ...opts });
}

/* -------------------------------------------------------------------------- */
/* Lifecycle a reader product actually uses                                   */
/* -------------------------------------------------------------------------- */

describe('consumer: book lifecycle', () => {
  test('isReady is false before load and true after; destroy kills it', () => {
    const el = host();
    const book = new PageFlip(el, { width: 200, height: 300, flippingTime: 0 });
    expect(book.isReady()).toBe(false);
    expect(book.isDestroyed()).toBe(false);

    // C1: content queries are TOTAL — a book that is not loaded has zero
    // pages, and that is an answer, not an error. Chrome renders "Page 1 of
    // 0" states from these without guards.
    expect(book.getPageCount()).toBe(0);
    expect(book.getCurrentPageIndex()).toBe(0);

    book.loadFromHTML(makePages(4));
    expect(book.isReady()).toBe(true);
    expect(book.getPageCount()).toBe(4);
    expect(book.getCurrentPageIndex()).toBe(0);

    book.destroy();
    expect(book.isDestroyed()).toBe(true);
    expect(book.isReady()).toBe(false);
    // Total after destroy too — same rule, any engine state.
    expect(book.getPageCount()).toBe(0);
    expect(book.getCurrentPageIndex()).toBe(0);
    // Layout queries keep throwing: no honest empty answer exists.
    expect(() => book.getBoundsRect()).toThrow(PageFlipError);
  });

  test('ready once, loaded every time, pagesChanged on collection swap', () => {
    const { book, destroy } = loadBook({ pageCount: 4 });
    const timeline: string[] = [];
    book.on('ready', (e) => timeline.push(`ready:${e.data.pageCount}`));
    book.on('loaded', (e) => timeline.push(`loaded:${e.data.pageCount}`));
    book.on('pagesChanged', (e) => timeline.push(`pages:${e.data.pageCount}`));

    // First load already happened in makeHtmlBook — re-bind after the fact only
    // sees later events. Fresh book for open path:
    destroy();

    const el = host();
    const b = new PageFlip(el, { width: 200, height: 300, flippingTime: 0, usePortrait: true });
    const t2: string[] = [];
    b.on('ready', (e) => t2.push(`ready:${e.data.pageCount}`));
    b.on('loaded', (e) => t2.push(`loaded:${e.data.pageCount}`));
    b.on('pagesChanged', (e) => t2.push(`pages:${e.data.pageCount}`));

    b.loadFromHTML(makePages(3));
    expect(t2).toEqual(['ready:3', 'loaded:3']);

    b.updateFromHtml(makePages(5));
    expect(t2).toEqual(['ready:3', 'loaded:3', 'pages:5']);

    b.loadFromHTML(makePages(2));
    expect(t2).toEqual(['ready:3', 'loaded:3', 'pages:5', 'loaded:2']);

    b.destroy();
  });

  test('once(flip) fires one turn then detaches', () => {
    const { book, destroy } = loadBook({ pageCount: 4 });
    let flips = 0;
    book.once('flip', () => {
      flips += 1;
    });
    // Instant turns via turnToPage still announce flip (ADR 0003).
    book.turnToPage(1);
    book.turnToPage(2);
    expect(flips).toBe(1);
    destroy();
  });
});

/* -------------------------------------------------------------------------- */
/* Navigation chrome a product builds                                         */
/* -------------------------------------------------------------------------- */

describe('consumer: canTurn + getVisiblePages for chrome', () => {
  test('portrait: canTurn tracks ends; visiblePages is one leaf', () => {
    const { book, destroy } = loadBook({ pageCount: 5, usePortrait: true });

    expect(book.canTurn('prev')).toBe(false);
    expect(book.canTurn('next')).toBe(true);
    expect(book.getVisiblePages()).toEqual([0]);

    book.turnToPage(4);
    expect(book.canTurn('next')).toBe(false);
    expect(book.canTurn('prev')).toBe(true);
    expect(book.getVisiblePages()).toEqual([4]);

    destroy();
  });

  test('landscape: last spread head is below pageCount-1 but canTurn next is false', () => {
    // The classic bug: enable next when head < pageCount-1.
    const { book, destroy } = loadBook({
      pageCount: 6,
      usePortrait: false,
      hostWidth: 900,
      hostHeight: 300,
    });

    expect(book.getOrientation()).toBe('landscape');
    book.turnToPage(4); // last spread [4,5]
    expect(book.getCurrentPageIndex()).toBe(4);
    expect(book.getVisiblePages()).toEqual([4, 5]);
    expect(book.canTurn('next')).toBe(false);
    expect(book.canTurn('prev')).toBe(true);

    destroy();
  });

  test('hardCovers: cover is a single-leaf spread', () => {
    const { book, destroy } = loadBook({
      pageCount: 5,
      usePortrait: false,
      hardCovers: true,
      hostWidth: 900,
      hostHeight: 300,
      initialPage: 0,
    });

    expect(book.getVisiblePages()).toEqual([0]);
    expect(book.canTurn('prev')).toBe(false);
    expect(book.canTurn('next')).toBe(true);

    destroy();
  });
});

/* -------------------------------------------------------------------------- */
/* Turn contract                                                              */
/* -------------------------------------------------------------------------- */

describe('consumer: turn contract', () => {
  test('flipNext/flipPrev boolean + turnRejected at boundary', () => {
    const { book, destroy } = loadBook({ pageCount: 2 });
    book.turnToPage(1);

    const rejected: TurnRejected[] = [];
    book.on('turnRejected', (e) => rejected.push(e.data));

    expect(book.flipNext()).toBe(false);
    expect(rejected).toEqual([
      expect.objectContaining({
        reason: 'boundary',
        direction: 'next',
        landedOn: 1,
      }),
    ]);

    destroy();
  });

  test('turnToPage throws INVALID_PAGE; flip(out of range) throws too', () => {
    const { book, destroy } = loadBook({ pageCount: 3 });

    expect(() => book.turnToPage(99)).toThrow(PageFlipError);
    try {
      book.turnToPage(99);
    } catch (e) {
      expect((e as PageFlipError).code).toBe('INVALID_PAGE');
    }

    expect(() => book.flipToPage(99)).toThrow(PageFlipError);

    destroy();
  });

  test('flip event carries BookSnapshot, not a bare page number', () => {
    const { book, destroy } = loadBook({ pageCount: 4 });
    const snaps: BookSnapshot[] = [];
    book.on('flip', (e) => snaps.push(e.data));

    book.turnToPage(1);
    expect(snaps).toHaveLength(1);
    const snap = snaps[0]!;
    expect(snap.page).toBe(1);
    expect(snap.pageCount).toBe(4);
    expect(snap.orientation === 'portrait' || snap.orientation === 'landscape').toBe(true);

    destroy();
  });

  /**
   * P7, FIXED — contract delta B1. The instant path runs only the terminal
   * animation frame, whose fold pose lies exactly on the page borders —
   * coincident segments. That pose is a COMPLETED fold, not an engine
   * invariant violation: the frame's draw is skipped (`GeometryAbort`) and
   * the commit runs. Locked rule: on a ready book, `canTurn(d)` true ⇒
   * `flipNext`/`flipPrev` succeeds.
   */
  test('flipNext turns on the instant path: canTurn true means the turn succeeds', () => {
    const { book, destroy } = loadBook({ pageCount: 4, flippingTime: 0 });
    const rejected: TurnRejected[] = [];
    book.on('turnRejected', (e) => rejected.push(e.data));

    expect(book.isReady()).toBe(true);
    expect(book.canTurn('next')).toBe(true);
    expect(book.flipNext()).toBe(true);
    expect(book.getCurrentPageIndex()).toBe(1);
    expect(rejected).toEqual([]);

    // And back — the BACK terminal pose is the same geometry mirrored.
    expect(book.canTurn('prev')).toBe(true);
    expect(book.flipPrev()).toBe(true);
    expect(book.getCurrentPageIndex()).toBe(0);
    expect(rejected).toEqual([]);

    destroy();
  });
});

/* -------------------------------------------------------------------------- */
/* Settings a product customises                                              */
/* -------------------------------------------------------------------------- */

describe('consumer: settings surface', () => {
  test('getSettings reflects construction; updateSettings is live for flippingTime', () => {
    const { book, destroy } = loadBook({ flippingTime: 0 });
    expect(book.getSettings().flippingTime).toBe(0);
    expect(book.getSettings().pointerInput).toEqual([...ALL_POINTERS]);
    expect(book.getSettings().pageBackground).toBe(DEFAULT_PAGE_BACKGROUND);
    expect(book.getSettings().sizing).toBe(SizeMode.FIXED);

    book.updateSettings({ flippingTime: 200 });
    expect(book.getSettings().flippingTime).toBe(200);

    destroy();
  });

  test('updateSettings(getSettings()) round-trips without throwing', () => {
    const { book, destroy } = loadBook();
    expect(() => book.updateSettings(book.getSettings())).not.toThrow();
    destroy();
  });

  test('invalid construction throws PageFlipError with setting key', () => {
    const el = host();
    try {
      new PageFlip(el, {
        width: 200,
        height: 300,
        flippingTime: -1,
      });
      expect.unreachable('must throw');
    } catch (e) {
      expect(e).toBeInstanceOf(PageFlipError);
      expect((e as PageFlipError).code).toBe('INVALID_SETTING');
      expect((e as PageFlipError).setting).toBe('flippingTime');
    }
  });

  test('readingDirection rtl is accepted and reported', () => {
    const { book, destroy } = loadBook({ readingDirection: 'rtl' });
    expect(book.getSettings().readingDirection).toBe('rtl');
    // Index-ordered navigation (not mirrored coords) — use turnToPage while
    // flipNext is blocked by P7 COLLINEAR_SEGMENTS.
    book.turnToPage(1);
    expect(book.getCurrentPageIndex()).toBe(1);
    destroy();
  });
});

/* -------------------------------------------------------------------------- */
/* DOM integration                                                            */
/* -------------------------------------------------------------------------- */

describe('consumer: DOM hooks', () => {
  test('getBlockElement is the portal target; getPageElement returns leaf hosts', () => {
    const { book, pages, destroy } = loadBook({ pageCount: 3 });
    const block = book.getBlockElement();
    expect(
      block.classList.contains('stf__block') || block.querySelector('.stf__item'),
    ).toBeTruthy();

    const leaf0 = book.getPageElement(0);
    expect(leaf0).toBeTruthy();
    expect(pages).toContain(leaf0);

    expect(book.getPageElement(-1)).toBeNull();
    expect(book.getPageElement(99)).toBeNull();

    destroy();
  });

  test('getBlockElement is the ONE portal target; getBlock is gone (C7)', () => {
    const el = host();
    const book = new PageFlip(el, { width: 200, height: 300, flippingTime: 0 });
    book.loadFromHTML(makePages(2));
    // The dual-name trap is closed: the wiring getter is symbol-keyed now,
    // and the string key does not exist on the published surface.
    expect('getBlock' in book).toBe(false);
    expect(book.getBlockElement()).toBeInstanceOf(HTMLElement);
    expect(book.getBlockElement()).not.toBe(el);
    book.destroy();
  });

  test('styles helper injects CSS once', () => {
    ensureFlipbookStyles();
    expect(FLIPBOOK_CSS.length).toBeGreaterThan(100);
    expect(document.querySelector('style')?.textContent ?? '').toContain('stf__');
  });

  test('isInteractivePointerTarget is usable for custom chrome', () => {
    const root = document.createElement('div');
    root.innerHTML = `<button type="button"><span id="x">Go</span></button>`;
    document.body.appendChild(root);
    expect(isInteractivePointerTarget(root.querySelector('#x'))).toBe(true);
    expect(isInteractivePointerTarget(root)).toBe(false);
    root.remove();
  });
});

/* -------------------------------------------------------------------------- */
/* Claims the README makes that must stay true                                */
/* -------------------------------------------------------------------------- */

describe('consumer: README claims', () => {
  test('flippingTime: 0 constructs and turnToPage is instant', () => {
    const { book, destroy } = loadBook({ flippingTime: 0 });
    expect(book.getSettings().flippingTime).toBe(0);
    book.turnToPage(1);
    expect(book.getCurrentPageIndex()).toBe(1);
    expect(book.getState()).toBe(FlippingState.READ);
    destroy();
  });

  test('pageBackground: translucent is accepted (structural opacity), injection still throws', () => {
    // B3: opacity holds by construction (the ::before opaque base), so a
    // translucent token is valid input. What must still fail loudly is a
    // value that could escape the style attribute it is written into.
    const el = host();
    expect(
      () =>
        new PageFlip(el, {
          width: 200,
          height: 300,
          pageBackground: 'rgba(255,255,255,0.3)',
        }),
    ).not.toThrow();

    expect(
      () =>
        new PageFlip(host(), {
          width: 200,
          height: 300,
          pageBackground: 'red;position:fixed',
        }),
    ).toThrow(PageFlipError);
  });

  test('off(event, fn) removes one listener without killing siblings', () => {
    const { book, destroy } = loadBook({ pageCount: 4 });
    const a: number[] = [];
    const b: number[] = [];
    const fa = (e: { data: BookSnapshot }) => a.push(e.data.page);
    const fb = (e: { data: BookSnapshot }) => b.push(e.data.page);
    book.on('flip', fa);
    book.on('flip', fb);
    book.off('flip', fa);
    book.turnToPage(1);
    expect(a).toEqual([]);
    expect(b).toEqual([1]);
    destroy();
  });
});

/* -------------------------------------------------------------------------- */
/* Gaps / awkwardness pinned as behaviour (not necessarily bugs)              */
/* -------------------------------------------------------------------------- */

describe('consumer: awkward public edges (documented)', () => {
  test('the wiring seams are closed; synthetic input stays public (C7)', () => {
    // The awkward edge this test used to document is gone: attachMode and
    // replacePages named unexported types in public signatures, and are
    // symbol-keyed now. The synthetic-input trio remains the supported
    // advanced surface for custom gesture layers.
    const { book, destroy } = loadBook();
    expect('attachMode' in book).toBe(false);
    expect('replacePages' in book).toBe(false);
    expect('getBlock' in book).toBe(false);
    expect(typeof book.startUserTouch).toBe('function');
    expect(typeof book.userMove).toBe('function');
    expect(typeof book.userStop).toBe('function');
    destroy();
  });

  test('isAnimating is false when idle after an instant turn', () => {
    const { book, destroy } = loadBook({ flippingTime: 0 });
    book.flipNext();
    expect(book.isAnimating()).toBe(false);
    destroy();
  });

  test('empty loadFromHTML is a shell: not ready for turns, no ready event', () => {
    const el = host();
    const book = new PageFlip(el, { width: 200, height: 300, flippingTime: 0 });
    const ready: unknown[] = [];
    book.on('ready', (e) => ready.push(e.data));
    book.loadFromHTML([]);
    expect(ready).toEqual([]);
    // C3: an empty portal shell is NOT a book you can turn — isReady answers
    // the question its name asks, and requires a page count.
    expect(book.isReady()).toBe(false);
    expect(book.flipNext()).toBe(false);
    book.destroy();
  });
});
