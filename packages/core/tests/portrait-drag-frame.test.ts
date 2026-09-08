/**
 * X1 and X3 (historical portrait-drag audit).
 *
 * X1 — **a portrait BACK drag could not be small and could not be cancelled**,
 * in LTR as well as RTL. A portrait book's single visible leaf sits on the
 * RIGHT half of the bounds rect, but both local↔global conversions anchored the
 * fold frame at `left + width / 2` — that leaf's LEFT edge — for BOTH fold
 * sides. That is the correct spine for a FORWARD fold and one whole `pageWidth`
 * short for a BACK one, so the entire visible leaf mapped to negative local x:
 * a 30 px inward drag on its left edge read `-30` and 57.5 % progress, and
 * `Flip.stopMove` commits on `pos.x <= 0`. The same displacement moved what was
 * drawn — the leaf underneath starts at local `{ x: pageWidth }`, a page-width
 * off the left of the book.
 *
 * X3 — `drawShadow: false` set mid-fold left the shadow already on screen
 * frozen there in HTML mode: `setShadowData` returned without clearing.
 *
 * The bar these tests are written to:
 *
 *  - **Progress, not just coordinates.** The defect is that a small drag reads
 *    as a large one, so a test that only checked local x could pass while the
 *    fold was still wrong. Every drag asserts its progress, and asserts what
 *    releasing it does to the page index.
 *  - **The same physical inset measures the same fold on either edge.** Portrait
 *    FORWARD was always right, so it is the control the BACK numbers are held
 *    against — a "fix" that moved the forward frame instead fails here.
 *  - **Landscape is asserted alongside**, because the obvious wrong variant is
 *    to re-anchor BACK unconditionally, which moves the orientation this repo's
 *    golden screenshots pin.
 *  - **Both conversions.** Re-anchoring only `convertToPage` leaves the fold
 *    measuring correctly and DRAWING a page-width off, so the round trip and
 *    the real translate the renderer writes for the leaf underneath are both
 *    asserted.
 *  - **Preconditions before behaviour.** Six times in this repo a fixture has
 *    been built where the wrong value coincided with the right one, so the
 *    orientation, the page index, the exact rect, the visible leaf's real
 *    on-screen box, and which fold side a drag actually opens are all asserted
 *    before anything is concluded from them.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, test } from 'vitest';
import { Orientation, PageDensity } from '@gullabs/flipbook-core';
import type { PageFlip } from '@gullabs/flipbook-core';
import { Page } from '../src/Page/Page';
import { makeHtmlBook } from './html-book-fixture';
import { testFlip, testRender, testPage } from './engine-access';
import { FlipDirection } from '../src/Flip/Flip';

const books: Array<{ destroy: () => void }> = [];

afterEach(() => {
  while (books.length) books.pop()?.destroy();
});

type Reading = 'ltr' | 'rtl';
type DrawableRender = { drawFrame: () => void };

/**
 * PORTRAIT: 200×300 pages in a 380 px host, so `usePortrait` wins. Bounds are
 * `{ left: -110, width: 400, pageWidth: 200 }` and the single visible leaf
 * occupies book-global x ∈ [90, 290] — the rect's RIGHT half.
 */
function portraitBook(readingDirection: Reading = 'ltr', initialPage = 2): PageFlip {
  const b = makeHtmlBook({
    pageCount: 6,
    flippingTime: 0,
    initialPage,
    readingDirection,
    usePortrait: true,
  });
  books.push(b);
  return b.book;
}

/** LANDSCAPE, same page size in a 500 px host: two real 200 px halves. */
function landscapeBook(readingDirection: Reading = 'ltr', initialPage = 2): PageFlip {
  const b = makeHtmlBook({
    pageCount: 6,
    flippingTime: 0,
    initialPage,
    readingDirection,
    usePortrait: false,
    hostWidth: 500,
  });
  books.push(b);
  return b.book;
}

/** Book-global x of the visible portrait leaf's own edges. */
function leafEdges(book: PageFlip): { left: number; right: number } {
  const rect = book.getBoundsRect();
  return { left: rect.left + rect.pageWidth, right: rect.left + rect.width };
}

function flipOf(book: PageFlip) {
  const flip = testFlip(book);
  if (flip === null) throw new Error('no flip controller');
  return flip;
}

function drawOneFrame(book: PageFlip): void {
  (testRender(book) as unknown as DrawableRender).drawFrame();
}

/**
 * Drag along a path of book-global x values and report what the engine made of
 * it. A path rather than a single point because `FlipCalculation` clamps a fold
 * that jumps straight to the spine — a real gesture arrives as a sequence of
 * pointer moves, and so does this one.
 */
function drag(book: PageFlip, xs: number[]) {
  const flip = flipOf(book);
  const y = book.getBoundsRect().top + 20;
  let last = { x: xs[0] ?? 0, y };

  for (const x of xs) {
    last = { x, y };
    flip.fold(last);
  }

  const calc = flip.getCalculation();
  if (calc === null) throw new Error('fold did not open a calculation');

  return {
    flip,
    calc,
    side: calc.getDirection(),
    localX: testRender(book).convertToPage(last).x,
    position: calc.getPosition(),
    progress: calc.getFlippingProgress(),
  };
}

/** One-shot fold, for the small drags where no clamping is in play. */
function foldAt(book: PageFlip, x: number) {
  return drag(book, [x]);
}

/* ------------------------------------------------------------------ *
 * Preconditions
 * ------------------------------------------------------------------ */

describe('the fixtures are what the assertions assume', () => {
  test('portrait: page 2 of 6, and ONE leaf occupying the rect’s right half', () => {
    for (const reading of ['ltr', 'rtl'] as const) {
      const book = portraitBook(reading);

      expect(book.getOrientation(), reading).toBe(Orientation.PORTRAIT);
      expect(book.getCurrentPageIndex(), reading).toBe(2);
      expect(book.getBoundsRect(), reading).toEqual({
        left: -110,
        top: 0,
        width: 400,
        height: 300,
        pageWidth: 200,
      });

      // The leaf's real on-screen box, off the element the engine laid out —
      // not a restatement of the arithmetic above. This is the claim the whole
      // fix rests on: the visible leaf is the RIGHT half of the bounds rect,
      // so a BACK fold's spine is its right edge and not `left + width / 2`.
      drawOneFrame(book);
      const el = (testPage(book, 2) as Page | null)?.getElement();
      expect(el?.style.left, reading).toBe('90px');
      expect(el?.style.width, reading).toBe('200px');
      expect(leafEdges(book), reading).toEqual({ left: 90, right: 290 });

      // ...and the two candidate anchors are a whole pageWidth apart, so the
      // pre-fix and post-fix frames cannot coincide in this fixture.
      const rect = book.getBoundsRect();
      expect(rect.left + rect.width - (rect.left + rect.width / 2), reading).toBe(200);
    }
  });

  test('landscape: page 2 of 6, symmetric 200 px halves meeting at x = 250', () => {
    const book = landscapeBook();

    expect(book.getOrientation()).toBe(Orientation.LANDSCAPE);
    expect(book.getCurrentPageIndex()).toBe(2);
    expect(book.getBoundsRect()).toEqual({
      left: 50,
      top: 0,
      width: 400,
      height: 300,
      pageWidth: 200,
    });
  });

  test('the drags below open the fold side they claim to', () => {
    // Portrait hit-testing gives BACK only the first `width / 5` (80 px) of the
    // leaf, so every "back" inset used here must stay inside that; otherwise
    // the numbers would be measuring a forward fold and agreeing with the
    // broken code by accident.
    const back = portraitBook();
    expect(foldAt(back, leafEdges(back).left + 30).side).toBe(FlipDirection.BACK);
    expect(testRender(back).getDirection()).toBe(FlipDirection.BACK);

    const forward = portraitBook();
    expect(foldAt(forward, leafEdges(forward).right - 30).side).toBe(FlipDirection.FORWARD);
    expect(testRender(forward).getDirection()).toBe(FlipDirection.FORWARD);
  });
});

/* ------------------------------------------------------------------ *
 * X1 — measuring
 * ------------------------------------------------------------------ */

describe('X1 — a portrait BACK drag is measured against its own leaf', () => {
  test('a 30 px inward drag is a 30 px fold on EITHER edge of the visible leaf', () => {
    const inset = 30;
    const edges = leafEdges(portraitBook());

    const back = foldAt(portraitBook(), edges.left + inset);
    const forward = foldAt(portraitBook(), edges.right - inset);

    // Local x is the distance from the folded leaf's spine, so a finger
    // `inset` px inside that leaf's free edge sits at `pageWidth - inset`.
    expect(back.localX).toBeCloseTo(200 - inset, 5);
    expect(back.position.x).toBeCloseTo(200 - inset, 5);
    expect(back.progress).toBeCloseTo(7.5, 5);

    // FORWARD was never broken, and is the control: the same physical inset on
    // the opposite edge of the SAME leaf has to read identically.
    expect(back.localX).toBeCloseTo(forward.localX, 5);
    expect(back.progress).toBeCloseTo(forward.progress, 5);
  });

  test('progress tracks the drag instead of starting past half way', () => {
    const edges = leafEdges(portraitBook());

    // The pre-fix frame reported 51.25 / 57.5 / 70 % for these three.
    for (const [inset, expected] of [
      [5, 1.25],
      [30, 7.5],
      [80, 20],
    ] as const) {
      const { progress } = foldAt(portraitBook(), edges.left + inset);
      expect(progress, `inset ${inset}`).toBeCloseTo(expected, 5);
      expect(progress, `inset ${inset}`).toBeLessThan(50);
    }
  });

  test('a small portrait BACK drag releases WITHOUT turning the page', () => {
    for (const inset of [5, 30, 80]) {
      const book = portraitBook();
      const before = book.getCurrentPageIndex();

      const { flip, progress } = foldAt(book, leafEdges(book).left + inset);
      expect(progress, `inset ${inset}`).toBeLessThan(50);

      flip.stopMove();

      expect(book.getCurrentPageIndex(), `inset ${inset}`).toBe(before);
    }
  });

  test('a portrait BACK drag carried to the spine still commits the turn', () => {
    // The other half of the claim: the fold has not merely been made
    // impossible to complete. `flippingTime: 0` makes the turn instant.
    const book = portraitBook();
    const edges = leafEdges(book);

    const { flip, progress, position } = drag(book, [
      edges.left + 10,
      edges.left + 80,
      edges.left + 150,
      edges.right + 10,
    ]);

    expect(position.x).toBeLessThanOrEqual(0);
    expect(progress).toBeGreaterThan(50);

    flip.stopMove();
    expect(book.getCurrentPageIndex()).toBe(1);
  });

  test('portrait FORWARD is untouched: small cancels, full commits', () => {
    const small = portraitBook();
    const smallFold = foldAt(small, leafEdges(small).right - 30);
    expect(smallFold.side).toBe(FlipDirection.FORWARD);
    expect(smallFold.progress).toBeCloseTo(7.5, 5);
    smallFold.flip.stopMove();
    expect(small.getCurrentPageIndex()).toBe(2);

    const large = portraitBook();
    const edges = leafEdges(large);
    const largeFold = drag(large, [
      edges.right - 10,
      edges.right - 80,
      edges.right - 150,
      edges.left - 10,
    ]);
    expect(largeFold.side).toBe(FlipDirection.FORWARD);
    expect(largeFold.progress).toBeGreaterThanOrEqual(50);
    largeFold.flip.stopMove();
    expect(large.getCurrentPageIndex()).toBe(3);
  });

  test('rtl portrait measures the same fold on the same physical edge', () => {
    // I2 made rtl match ltr; X1 must not pull them apart again. The turn
    // DIRECTION is mirrored under rtl, the geometry is not.
    for (const inset of [5, 30, 80]) {
      const ltr = portraitBook('ltr');
      const rtl = portraitBook('rtl');

      const a = foldAt(ltr, leafEdges(ltr).left + inset);
      const b = foldAt(rtl, leafEdges(rtl).left + inset);

      expect(b.side, `inset ${inset}`).toBe(a.side);
      expect(b.localX, `inset ${inset}`).toBeCloseTo(a.localX, 5);
      expect(b.progress, `inset ${inset}`).toBeCloseTo(a.progress, 5);
      expect(a.progress, `inset ${inset}`).toBeLessThan(50);
    }
  });

  test('a small rtl portrait drag on that edge also releases without turning', () => {
    const book = portraitBook('rtl');
    const before = book.getCurrentPageIndex();

    foldAt(book, leafEdges(book).left + 30).flip.stopMove();

    expect(book.getCurrentPageIndex()).toBe(before);
  });
});

/* ------------------------------------------------------------------ *
 * X1 — drawing
 * ------------------------------------------------------------------ */

describe('X1 — the frame is re-anchored for DRAWING too, not only measuring', () => {
  test('local ↔ global round-trips on the portrait BACK frame', () => {
    // Re-anchoring `convertToPage` alone would leave the fold measuring
    // correctly and rendering a whole pageWidth to the left of the book.
    const book = portraitBook();
    const render = testRender(book);

    for (const x of [90, 150, 289]) {
      const local = render.convertToPage({ x, y: 40 }, FlipDirection.BACK);
      const global = render.convertToGlobal(local, FlipDirection.BACK);

      expect(global?.x, `x ${x}`).toBeCloseTo(x, 5);
      expect(global?.y, `x ${x}`).toBeCloseTo(40, 5);
    }
  });

  test('the portrait BACK frame runs spine → free edge across the visible leaf', () => {
    const book = portraitBook();
    const render = testRender(book);
    const edges = leafEdges(book);

    const spine = render.convertToGlobal({ x: 0, y: 0 }, FlipDirection.BACK);
    const free = render.convertToGlobal({ x: 200, y: 0 }, FlipDirection.BACK);

    expect(spine?.x).toBeCloseTo(edges.right, 5);
    expect(free?.x).toBeCloseTo(edges.left, 5);
  });

  test('the leaf underneath is drawn ON the visible page, not a page-width left', () => {
    // End to end, through the real renderer: `getBottomPagePosition()` is
    // `{ x: pageWidth }` for a BACK fold, and `HTMLPage.draw` converts it into
    // the element's translate. Pre-fix that translate was -110px — the page
    // revealing behind the fold sat entirely off the left of the book.
    const book = portraitBook();
    const edges = leafEdges(book);

    drag(book, [edges.left + 10, edges.left + 60]);
    drawOneFrame(book);

    const under = (testPage(book, 1) as Page | null)?.getElement();
    expect(under?.classList.contains('--shown')).toBe(true);
    expect(under?.style.transform).toContain(`translate3d(${edges.left}px,0px,0)`);
  });
});

/* ------------------------------------------------------------------ *
 * X1 — landscape must not move
 * ------------------------------------------------------------------ */

describe('X1 — landscape geometry is not touched', () => {
  test('a 30 px inward drag measures 30 px of fold on both landscape edges', () => {
    for (const edge of ['left', 'right'] as const) {
      const book = landscapeBook();
      const rect = book.getBoundsRect();
      const x = edge === 'left' ? rect.left + 30 : rect.left + rect.width - 30;

      const { localX, progress, side } = foldAt(book, x);

      expect(side, edge).toBe(edge === 'left' ? FlipDirection.BACK : FlipDirection.FORWARD);
      expect(localX, edge).toBeCloseTo(170, 5);
      expect(progress, edge).toBeCloseTo(7.5, 5);
    }
  });

  test('the landscape BACK frame is still anchored on the book’s spine', () => {
    const book = landscapeBook();
    const rect = book.getBoundsRect();
    const render = testRender(book);

    const spine = render.convertToGlobal({ x: 0, y: 0 }, FlipDirection.BACK);
    const free = render.convertToGlobal({ x: rect.pageWidth, y: 0 }, FlipDirection.BACK);

    expect(spine?.x).toBeCloseTo(rect.left + rect.width / 2, 5);
    expect(free?.x).toBeCloseTo(rect.left, 5);
  });

  test('a small landscape BACK drag cancels and a full one commits', () => {
    const small = landscapeBook();
    const smallFold = foldAt(small, small.getBoundsRect().left + 20);
    expect(smallFold.progress).toBeCloseTo(5, 5);
    smallFold.flip.stopMove();
    expect(small.getCurrentPageIndex()).toBe(2);

    const large = landscapeBook();
    const rect = large.getBoundsRect();
    const largeFold = drag(large, [
      rect.left + 10,
      rect.left + 80,
      rect.left + 150,
      rect.left + 210,
    ]);
    expect(largeFold.progress).toBeGreaterThan(50);
    largeFold.flip.stopMove();
    expect(large.getCurrentPageIndex()).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * X3
 * ------------------------------------------------------------------ */

describe('X3 — drawShadow: false mid-fold clears the shadow already drawn', () => {
  /** The HTML renderer's soft outer-shadow element. */
  function shadowDisplay(book: PageFlip): string {
    const el = book.getBlockElement().querySelector('.stf__outerShadow');
    return (el as HTMLElement | null)?.style.display ?? 'missing';
  }

  function foldMidway(book: PageFlip, inset: number): void {
    const edges = leafEdges(book);
    flipOf(book).fold({ x: edges.right - inset, y: 40 });
  }

  test('the fixture paints a real SOFT shadow to begin with', () => {
    const book = portraitBook();

    foldMidway(book, 40);

    // A hard leaf would take the hard-shadow path and never touch the element
    // inspected below.
    expect(testPage(book, 2)?.getDrawingDensity()).toBe(PageDensity.SOFT);

    drawOneFrame(book);
    expect(shadowDisplay(book)).toBe('block');
  });

  test('turning drawShadow off mid-fold stops the shadow on the next frame', () => {
    const book = portraitBook();

    foldMidway(book, 40);
    drawOneFrame(book);
    expect(shadowDisplay(book), 'precondition').toBe('block');

    book.updateSettings({ drawShadow: false });

    // The gesture continues — this is the mid-fold case, not a teardown.
    foldMidway(book, 80);
    drawOneFrame(book);

    expect(shadowDisplay(book)).toBe('none');
  });

  test('drawShadow: false from the start never paints one', () => {
    const b = makeHtmlBook({
      pageCount: 6,
      flippingTime: 0,
      initialPage: 2,
      usePortrait: true,
      drawShadow: false,
    });
    books.push(b);

    foldMidway(b.book, 40);
    drawOneFrame(b.book);

    expect(shadowDisplay(b.book)).not.toBe('block');
  });

  test('turning it back on mid-fold restores the shadow', () => {
    const book = portraitBook();

    foldMidway(book, 40);
    book.updateSettings({ drawShadow: false });
    foldMidway(book, 80);
    drawOneFrame(book);
    expect(shadowDisplay(book), 'precondition').toBe('none');

    book.updateSettings({ drawShadow: true });
    foldMidway(book, 120);
    drawOneFrame(book);

    expect(shadowDisplay(book)).toBe('block');
  });
});
