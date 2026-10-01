/**
 * Flip state-machine defects I1 / I3 / I5 / I8, driven through the real HTML
 * engine. Nothing here stubs `startAnimation`, `Render` or the collection: the
 * whole point of these four is that the unit-level story looked fine while the
 * live object was wrong.
 *
 * Each test asserts what the CALLER ASKED FOR, not what the current pipeline
 * happens to produce — I5 in particular is masked in the live app by the
 * mirror-image bug in `UI.swipeDirection`'s corner test (I6), and a test'
 * written against the composed behaviour would go green on either.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, test } from 'vitest';
import { FlipCorner, FlippingState, Orientation, PageDensity } from '@gullabs/flipbook-core';
import { FlipCalculation } from '../src/Flip/FlipCalculation';
import { makeHtmlBook } from './html-book-fixture';
import { testCollection, testFlip, testRender } from './engine-access';
import { FlipDirection } from '../src/Flip/Flip';

const books: Array<{ destroy: () => void }> = [];

afterEach(() => {
  while (books.length) books.pop()?.destroy();
});

function book(opts?: Parameters<typeof makeHtmlBook>[0]) {
  const b = makeHtmlBook(opts);
  books.push(b);
  return b;
}

/**
 * A book whose bounds rect has a NON-ZERO `top`: 300-tall pages centred in a
 * 600-tall host. That offset is the whole of I5 — on a `top: 0` fixture the
 * broken and the fixed y coincide and the test proves nothing, so every I5
 * assertion below is preceded by an assertion that `top` is really 150.
 */
function centredBook(opts?: Parameters<typeof makeHtmlBook>[0]) {
  return book({
    width: 200,
    height: 300,
    hostWidth: 380,
    hostHeight: 600,
    ...opts,
  });
}

describe('I1 — a refused fold must not strand the state machine', () => {
  test('a forward drag on the last page ends in READ, not USER_FOLD', () => {
    const { book: app } = book({ pageCount: 4, initialPage: 3, flippingTime: 0 });
    const flip = testFlip(app)!;
    const rect = app.getBoundsRect();

    expect(app.getCurrentPageIndex()).toBe(3);
    expect(app.getOrientation()).toBe(Orientation.PORTRAIT);

    const down = { x: rect.left + rect.width - 5, y: rect.top + 10 };
    const moved = { x: rect.left + rect.width - 45, y: rect.top + 12 };

    app.startUserTouch(down);
    app.userMove(moved, false); // > 5px, so PageFlip calls fold()

    // Mid-drag, and this is the assertion that matters: a refused fold must
    // never announce USER_FOLD. `UI.onPointerMove` calls `preventDefault()` on
    // every move while the state is not READ, so announcing a fold that is not
    // happening is exactly what stops the page scrolling under a finger — and
    // settling back to READ on release does not undo it.
    expect(flip.getCalculation()).toBeNull();
    expect(flip.getState()).toBe(FlippingState.READ);

    app.userStop(moved, false);

    // The turn was refused (there is no page 4), so nothing may have moved.
    expect(app.getCurrentPageIndex()).toBe(3);
    expect(flip.getCalculation()).toBeNull();
    // ...and the book must be usable again.
    expect(flip.getState()).toBe(FlippingState.READ);
  });

  test('a refused fold does not kill corner hover for the rest of the session', () => {
    const { book: app } = book({ pageCount: 4, initialPage: 3, flippingTime: 1000 });
    const flip = testFlip(app)!;
    const rect = app.getBoundsRect();

    const down = { x: rect.left + rect.width - 5, y: rect.top + 10 };
    const moved = { x: rect.left + rect.width - 45, y: rect.top + 12 };
    app.startUserTouch(down);
    app.userMove(moved, false);
    app.userStop(moved, false);

    // Go somewhere a turn IS possible, without touching the flip state.
    app.turnToPage(0);
    expect(app.getCurrentPageIndex()).toBe(0);

    // Hover the corner. `showCorner` only works from READ / FOLD_CORNER, so a
    // state stuck in USER_FOLD makes this a permanent no-op.
    app.userMove({ x: rect.left + rect.width - 3, y: rect.top + 3 }, false);

    expect(flip.getState()).toBe(FlippingState.FOLD_CORNER);
  });

  test('rtl: a right-edge drag at page 0 is refused and still returns to READ', () => {
    const { book: app } = book({ pageCount: 4, flippingTime: 0, readingDirection: 'rtl' });
    const flip = testFlip(app)!;
    const rect = app.getBoundsRect();

    const down = { x: rect.left + rect.width - 5, y: rect.top + 10 };
    const moved = { x: rect.left + rect.width - 45, y: rect.top + 12 };

    app.startUserTouch(down);
    app.userMove(moved, false);
    app.userStop(moved, false);

    expect(app.getCurrentPageIndex()).toBe(0);
    expect(flip.getState()).toBe(FlippingState.READ);
  });

  test('stopMove hands the state back even when no calculation is open', () => {
    // The second half of I1, exercised on its own: `start()` is public and
    // resets `calc` before it can refuse, so a caller can legitimately reach
    // "announced state, no calculation". The release path must still settle.
    const { book: app } = book({ pageCount: 4, flippingTime: 1000 });
    const flip = testFlip(app)!;
    const rect = app.getBoundsRect();

    const inside = { x: rect.left + rect.width - 40, y: rect.top + 40 };
    flip.fold(inside);
    expect(flip.getState()).toBe(FlippingState.USER_FOLD);
    expect(flip.getCalculation()).not.toBeNull();

    // Refused: BACK from page 0. `start()` reset `calc` on the way in.
    //
    // The point must be on the LEFT part of the visible leaf, which in
    // portrait starts one `pageWidth` into the bounds rect — the rect's left
    // half is phantom. This used to read `rect.left + 2`, a point in that
    // phantom half that `getDirectionByPoint` called BACK only because its
    // portrait test had no lower bound (FL2); the assertion below was right
    // for the wrong reason.
    app.turnToPage(0);
    expect(flip.start({ x: rect.left + rect.pageWidth + 2, y: rect.top + 10 })).toBe(false);
    expect(flip.getCalculation()).toBeNull();

    flip.stopMove();
    expect(flip.getState()).toBe(FlippingState.READ);
  });
});

describe('I3 — flipToPage must not publish a phantom spread index', () => {
  test('the public index and the spread agree while a turn is in flight', () => {
    const { book: app } = book({ pageCount: 8, flippingTime: 1000 });
    const collection = testCollection(app);

    expect(app.getCurrentPageIndex()).toBe(0);

    app.flipToPage(5);

    // Mid-animation the book has not moved yet, and both accessors must say so.
    expect(app.getCurrentPageIndex()).toBe(0);
    expect(collection.getCurrentSpreadIndex()).toBe(0);
  });

  test('a second flipToPage mid-turn lands on the page it asked for', () => {
    const { book: app } = book({ pageCount: 8, flippingTime: 1000 });

    app.flipToPage(5);
    app.flipToPage(2); // finish-then-restart: the first turn commits, then we go to 2

    testRender(app).finishAnimation();

    expect(app.getCurrentPageIndex()).toBe(2);
  });

  test('a single flipToPage still lands exactly on its target', () => {
    const { book: app } = book({ pageCount: 8, flippingTime: 1000 });

    app.flipToPage(6);
    testRender(app).finishAnimation();
    expect(app.getCurrentPageIndex()).toBe(6);

    app.flipToPage(1);
    testRender(app).finishAnimation();
    expect(app.getCurrentPageIndex()).toBe(1);
  });
});

describe('I5 — a programmatic corner survives the global→book conversion', () => {
  test('the fixture really is vertically centred', () => {
    const { book: app } = centredBook({ pageCount: 6 });
    const rect = app.getBoundsRect();

    // If this is 0 the whole test is vacuous: the bug is the missing `top`.
    expect(rect.top).toBe(150);
    expect(rect.height).toBe(300);
  });

  test('flipNext(BOTTOM) turns the BOTTOM corner on a centred book', () => {
    const { book: app } = centredBook({ pageCount: 6, flippingTime: 1000 });
    const flip = testFlip(app)!;

    expect(app.getBoundsRect().top).toBe(150);

    expect(flip.flipNext(FlipCorner.BOTTOM)).toBe(true);
    expect(flip.getCalculation()!.getCorner()).toBe(FlipCorner.BOTTOM);
  });

  test('flipNext(TOP) still turns the TOP corner', () => {
    const { book: app } = centredBook({ pageCount: 6, flippingTime: 1000 });
    const flip = testFlip(app)!;

    expect(app.getBoundsRect().top).toBe(150);

    expect(flip.flipNext(FlipCorner.TOP)).toBe(true);
    expect(flip.getCalculation()!.getCorner()).toBe(FlipCorner.TOP);
  });

  test('flipPrev(BOTTOM) turns the BOTTOM corner on a centred book', () => {
    const { book: app } = centredBook({ pageCount: 6, flippingTime: 1000, initialPage: 3 });
    const flip = testFlip(app)!;

    expect(app.getBoundsRect().top).toBe(150);

    expect(flip.flipPrev(FlipCorner.BOTTOM)).toBe(true);
    expect(flip.getCalculation()!.getCorner()).toBe(FlipCorner.BOTTOM);
  });
});

describe('I8 — the landscape density override is temporary', () => {
  function landscapeBook(flippingTime: number) {
    // hardCovers + 6 pages: created densities are [hard, soft, soft, soft, soft,
    // hard], so the cover and its neighbour genuinely differ and the fix-up
    // really fires. A fixture where they already matched would pass either way.
    return book({
      pageCount: 6,
      hardCovers: true,
      usePortrait: false,
      width: 200,
      height: 300,
      hostWidth: 420,
      hostHeight: 600,
      flippingTime,
    });
  }

  test('the fixture creates genuinely mixed densities in landscape', () => {
    const { book: app } = landscapeBook(0);
    expect(app.getOrientation()).toBe(Orientation.LANDSCAPE);

    const pages = testCollection(app);
    expect(pages.getPage(0).getDensity()).toBe(PageDensity.HARD);
    expect(pages.getPage(1).getDensity()).toBe(PageDensity.SOFT);
    expect(pages.getPage(5).getDensity()).toBe(PageDensity.HARD);
  });

  test('the override IS applied while the turn is in flight', () => {
    const { book: app } = landscapeBook(1000);
    const flip = testFlip(app)!;

    expect(flip.flipNext(FlipCorner.TOP)).toBe(true);

    // The soft page next to the hard cover has to bend like a hard page for the
    // duration of the turn — a "fix" that simply dropped this would be wrong.
    expect(testCollection(app).getPage(1).getDrawingDensity()).toBe(PageDensity.HARD);
  });

  test('every drawing density is back to its created value after the turn', () => {
    const { book: app } = landscapeBook(0);
    const pages = testCollection(app);

    expect(testFlip(app)!.flipNext(FlipCorner.TOP)).toBe(true);

    for (let i = 0; i < pages.getPageCount(); i++) {
      const page = pages.getPage(i);
      expect([i, page.getDrawingDensity()]).toStrictEqual([i, page.getDensity()]);
    }
  });

  test('the NEIGHBOUR is restored too, on the turn where the neighbour is the soft one', () => {
    // Forward onto the trailing single-page spread: the flipping page is the
    // hard last page and the *neighbour* is the soft one, so restoring only the
    // flipping page (whose created density is hard anyway) would look fine here
    // and still leave page 4 hard forever.
    const { book: app } = landscapeBook(0);
    const pages = testCollection(app);

    app.turnToPage(3);
    expect(pages.getCurrentSpreadIndex()).toBe(2);
    expect(pages.getPage(4).getDensity()).toBe(PageDensity.SOFT);
    expect(pages.getPage(5).getDensity()).toBe(PageDensity.HARD);

    expect(testFlip(app)!.flipNext(FlipCorner.TOP)).toBe(true);

    expect(pages.getPage(4).getDrawingDensity()).toBe(PageDensity.SOFT);
  });

  test('a soft page can still curl after several landscape turns', () => {
    const { book: app } = landscapeBook(0);
    const flip = testFlip(app)!;
    const pages = testCollection(app);

    flip.flipNext(FlipCorner.TOP);
    flip.flipNext(FlipCorner.TOP);
    flip.flipPrev(FlipCorner.TOP);

    expect(pages.getPage(1).getDrawingDensity()).toBe(PageDensity.SOFT);
    expect(pages.getPage(2).getDrawingDensity()).toBe(PageDensity.SOFT);
  });
});

describe('R4 (real path): a turn chained from onFlip survives the old callback', () => {
  test('flipNext() called from an onFlip listener actually commits', async () => {
    const { book: flip } = book({ pageCount: 6, flippingTime: 40 });

    // Prime the frame clock: an animation binds its start to the first frame it
    // is drawn on, but the loop still has to be running.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const seen: number[] = [];
    let chained = false;
    flip.on('flip', (e) => {
      seen.push(e.data.page);
      if (!chained) {
        chained = true;
        // `turnToNextPage()` emits this SYNCHRONOUSLY from inside the old
        // turn's completion callback. Starting a turn here is the exact
        // re-entrancy that the teardown below used to destroy.
        flip.flipNext();
      }
    });

    flip.flipNext();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }

    // Before the fix the second turn's calc, flipping page and state were all
    // cleared by the FIRST turn's callback, so it animated to nothing and never
    // committed: the book stopped one page short, with no error anywhere.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(flip.getCurrentPageIndex()).toBeGreaterThanOrEqual(2);
    expect(flip.getState()).toBe(FlippingState.READ);
  });
});

describe('I9 — leaving a corner must not announce READ over a live snap-back', () => {
  /**
   * A book big enough that the corner bands and the "not a corner" middle are
   * genuinely distinct: 200x300 portrait leaf, `operatingDistance` 72.1.
   */
  function hoverBook() {
    return book({ pageCount: 6, flippingTime: 1000, foldCornerOnHover: true });
  }

  test('the state stays FOLD_CORNER until the snap-back finishes', () => {
    const { book: app } = hoverBook();
    const flip = testFlip(app)!;
    const rect = app.getBoundsRect();

    const states: string[] = [];
    app.on('changeState', (e) => states.push(e.data.state));

    // Hover the top-right corner: the fold peels in.
    app.userMove({ x: rect.left + rect.width - 3, y: rect.top + 3 }, false);
    expect(flip.getState()).toBe(FlippingState.FOLD_CORNER);
    expect(states).toEqual(['fold_corner']);

    // Now move off the corner, into the vertical middle of the leaf — which is
    // not a corner by either band — while the fold-in animation is still
    // running. `showCorner`'s exit branch starts the snap-back.'
    app.userMove({ x: rect.left + rect.width - 100, y: rect.top + rect.height / 2 }, false);

    // Reverted fix: `setState(READ)` ran BEFORE `stopMove()` started that
    // snap-back, so the book claimed to be reading while a calculation was
    // still live and animating. `UI.onPointerMove` reads READ as "not
    // flipping", so the next pointer move re-entered `showCorner`, found
    // `calc !== null` and jumped straight to `do()` — the releasing fold
    // snapping onto the pointer.
    expect(flip.getCalculation()).not.toBeNull();
    expect(flip.getState()).toBe(FlippingState.FOLD_CORNER);
    expect(states).toEqual(['fold_corner']);
  });

  test('…and READ is announced once the fold has actually settled', () => {
    // The guard against the lazy version of the fix — deleting the `setState`
    // and leaving nothing to hand the state back. The book must still settle.
    const { book: app } = hoverBook();
    const flip = testFlip(app)!;
    const rect = app.getBoundsRect();

    const states: string[] = [];
    app.on('changeState', (e) => states.push(e.data.state));

    app.userMove({ x: rect.left + rect.width - 3, y: rect.top + 3 }, false);
    app.userMove({ x: rect.left + rect.width - 100, y: rect.top + rect.height / 2 }, false);

    // A second move off the corner commits the snap-back through
    // `finishAnimation()` — the same thing the render loop would do a frame
    // later, without waiting on rAF.
    app.userMove({ x: rect.left + rect.width - 100, y: rect.top + rect.height / 2 }, false);

    expect(flip.getState()).toBe(FlippingState.READ);
    expect(flip.getCalculation()).toBeNull();
    expect(states).toEqual(['fold_corner', 'read']);

    // No page was turned by any of it.
    expect(app.getCurrentPageIndex()).toBe(0);
  });

  test('a corner hover with nothing to snap back still settles immediately', () => {
    // `stopMove()`'s other path: the fold was refused, so there is no'
    // calculation and no animation, and READ has to be handed back at once
    // rather than waiting for an animation that will never run.
    const { book: app } = book({ pageCount: 4, initialPage: 3, flippingTime: 1000 });
    const flip = testFlip(app)!;
    const rect = app.getBoundsRect();

    // Forward corner on the last spread: `start()` refuses it.
    app.userMove({ x: rect.left + rect.width - 3, y: rect.top + 3 }, false);
    expect(flip.getState()).toBe(FlippingState.READ);

    app.userMove({ x: rect.left + rect.width - 100, y: rect.top + rect.height / 2 }, false);
    expect(flip.getState()).toBe(FlippingState.READ);
    expect(flip.getCalculation()).toBeNull();
  });
});

describe('I10 — the corner band and the direction split cannot disagree', () => {
  /**
   * A leaf 100 wide and 600 tall. The ratio is the whole test: the band is a
   * fifth of the page DIAGONAL, so it exceeds `pageWidth` as soon as
   * `height > pageWidth * sqrt(24)` (~4.9x) — here 121.7 against a 100-wide
   * leaf. At ordinary proportions the clamp is inert and the fixture would
   * prove nothing.
   */
  function tallNarrowPortrait(opts?: Parameters<typeof makeHtmlBook>[0]) {
    return book({ width: 100, height: 600, pageCount: 6, ...opts });
  }

  test('the middle of a tall narrow leaf is not a corner', () => {
    const { book: app } = tallNarrowPortrait();
    const flip = testFlip(app)!;
    const rect = app.getBoundsRect();

    expect(app.getOrientation()).toBe(Orientation.PORTRAIT);
    expect(rect.pageWidth).toBe(100);
    // The precondition, asserted rather than assumed: without it this whole
    // describe block is a test of ordinary proportions, where both derivations
    // already agree.
    expect(Math.sqrt(rect.pageWidth ** 2 + rect.height ** 2) / 5).toBeGreaterThan(rect.pageWidth);

    // The visible leaf occupies the RIGHT half of the portrait bounds rect.
    const leaf = (offset: number, y: number) => ({
      x: rect.left + rect.width - rect.pageWidth + offset,
      y: rect.top + y,
    });

    // Reverted fix: `operatingDistance` (121.7) covers the entire 100-wide
    // leaf, so every one of these is a "corner" — the middle of the page
    // hover-peels, and `disableFlipByClick` stops restricting anything.
    expect(flip.isPointOnCorners(leaf(50, 5))).toBe(false);
    expect(flip.isPointOnCorners(leaf(50, rect.height - 5))).toBe(false);
    expect(flip.isPointOnCorners(leaf(45, 5))).toBe(false);

    // AMENDED, and the amendment is the point. `leaf(55)` used to be asserted
    // false, which held only because the two bands shared the LEFT band's
    // bound (the 40 px split). Bounding the right band by the midline instead
    // — the fix for the forward corner Codex measured on a 100x200 leaf, and
    // the same rule Z2 applies on y — puts offset 55 inside the right band at
    // 45 px from its own edge.
    //
    // That is the intended tiling, not a hole: the bands meet the midline from
    // opposite sides and stop, exactly as the y bands do, and the midline
    // itself belongs to neither. The property this block is named for survives
    // and is asserted above and below — the MIDDLE (offsets 40 through 50) is
    // not a corner, and the two bands do not overlap.
    expect(flip.isPointOnCorners(leaf(55, 5))).toBe(true);
    expect(flip.isPointOnCorners(leaf(49, 5))).toBe(false);

    // …while the actual corners are all still corners.
    expect(flip.isPointOnCorners(leaf(5, 5))).toBe(true);
    expect(flip.isPointOnCorners(leaf(95, 5))).toBe(true);
    expect(flip.isPointOnCorners(leaf(5, rect.height - 5))).toBe(true);
    expect(flip.isPointOnCorners(leaf(95, rect.height - 5))).toBe(true);
  });

  test('every accepted point folds the leaf its own half of the split names', () => {
    // The invariant, swept rather than sampled: a point in the BACK half of the
    // book may only qualify through the band on the BACK edge, and vice versa.
    // A band that reaches across the split is what makes an inner-edge hover
    // peel the opposite edge.
    const { book: app } = tallNarrowPortrait();
    const flip = testFlip(app)!;
    const rect = app.getBoundsRect();

    const visibleLeft = rect.width - rect.pageWidth;
    // The portrait split: the leading 2/5 of the leaf turns BACK, the rest
    // FORWARD. Derived from the split alone — not from the clamp — so the test
    // states the contract rather than restating the implementation.
    const splitOffset = (rect.pageWidth * 2) / 5;

    const backCorners: number[] = [];
    const forwardCorners: number[] = [];

    for (let offset = 1; offset < rect.pageWidth; offset += 1) {
      const point = { x: rect.left + visibleLeft + offset, y: rect.top + 5 };
      if (!flip.isPointOnCorners(point)) continue;

      const backHalf = offset <= splitOffset;
      (backHalf ? backCorners : forwardCorners).push(offset);

      // A corner band may not reach further from its own outer edge than the
      // split does from the same edge — otherwise a point the split assigns to
      // one leaf qualifies as a corner of the other. Reverted fix: the band is
      // 121.7 on a 100-wide leaf, so offset 50 lands in the FORWARD half while
      // sitting 50 from its own (right) edge, half the leaf away.
      //
      // Bounded per edge, because the split is asymmetric: the LEFT band may
      // not reach the split (40), the RIGHT band may not reach the midline
      // (50). Asserting the left bound on both sides is what wrongly rejected
      // the forward corner on a 100x200 leaf; asserting the right band's own
      // distance to the split (60) instead would let the two bands meet and
      // make the whole leaf a corner again.
      const distanceToOwnEdge = backHalf ? offset : rect.pageWidth - offset;
      const ownBound = backHalf ? splitOffset : rect.pageWidth / 2;
      expect(distanceToOwnEdge).toBeLessThanOrEqual(ownBound);
    }

    // The bands may touch the midline but never cross it, so no offset can
    // qualify through both. This is what the `visibleSpan / 2` term buys and
    // the reason the far-side-of-the-split bound was rejected: that one sums
    // the two bands to the full leaf.
    expect(Math.max(...backCorners)).toBeLessThan(Math.min(...forwardCorners));

    // Both corners still exist — a band clamped to nothing would satisfy the
    // loop above vacuously.
    expect(backCorners.length).toBeGreaterThan(0);
    expect(forwardCorners.length).toBeGreaterThan(0);
    // …and there is a real stretch of leaf between them that is not a corner.
    expect(backCorners.length + forwardCorners.length).toBeLessThan(rect.pageWidth - 10);
  });

  test('the FORWARD corner is not shrunk to the BACK band (100x200)', () => {
    // Codex's case, and the one the shared clamp got wrong. The leaf is 100x200
    // so `operatingDistance` is 44.7 and the 2/5 split is 40 — the narrow range
    // where the diagonal heuristic reaches PAST the split on the back side and
    // not on the forward side. At ordinary proportions neither bound binds and
    // this fixture proves nothing, which is why it is not 200x300.
    const { book: app } = book({ pageCount: 6, width: 100, height: 200 });
    const flip = testFlip(app)!;
    const rect = app.getBoundsRect();

    expect(app.getOrientation()).toBe(Orientation.PORTRAIT);
    const operatingDistance = Math.sqrt(rect.pageWidth ** 2 + rect.height ** 2) / 5;
    const splitOffset = (rect.pageWidth * 2) / 5;
    // The precondition: the heuristic must sit strictly between the split and
    // the midline, or the two clamps agree and the test cannot discriminate.
    expect(operatingDistance).toBeGreaterThan(splitOffset);
    expect(operatingDistance).toBeLessThan(rect.pageWidth / 2);

    const leafLeft = rect.left + rect.width - rect.pageWidth;
    const at = (offset: number) => ({ x: leafLeft + offset, y: rect.top + 5 });

    // 43 px in from the right edge: 57 px into the leaf, well clear of the
    // 40 px split, and a corner by the heuristic. Clamping it to the BACK
    // band's 40 rejected it — a corner that refuses to peel, and under
    // `disableFlipByClick` a click that does nothing.
    expect(flip.isPointOnCorners(at(rect.pageWidth - 43))).toBe(true);

    // …and the band still stops short of the midline, so the middle of the
    // leaf is not a corner from either side.
    expect(flip.isPointOnCorners(at(50))).toBe(false);
    expect(flip.isPointOnCorners(at(rect.pageWidth - 46))).toBe(false);
    expect(flip.isPointOnCorners(at(41))).toBe(false);

    // The back corner is unchanged: the split still bounds it, because a band
    // reaching past the split is the I10 defect.
    expect(flip.isPointOnCorners(at(39))).toBe(true);
  });

  test('ordinary proportions are untouched', () => {
    // The clamp must be inert where the diagonal already fits inside the leaf —
    // otherwise it is not a fix, it is a narrowing of every book's corners.
    const { book: app } = book({ pageCount: 6, width: 200, height: 300 });
    const flip = testFlip(app)!;
    const rect = app.getBoundsRect();

    // `operatingDistance` is 72.1 against a 200-wide leaf and a 2/5 split at 80.
    const leafLeft = rect.left + rect.width - rect.pageWidth;

    expect(flip.isPointOnCorners({ x: leafLeft + 70, y: rect.top + 5 })).toBe(true);
    expect(flip.isPointOnCorners({ x: leafLeft + 74, y: rect.top + 5 })).toBe(false);
    expect(flip.isPointOnCorners({ x: leafLeft + 195, y: rect.top + 5 })).toBe(true);
    expect(flip.isPointOnCorners({ x: leafLeft + 100, y: rect.top + rect.height / 2 })).toBe(false);
  });

  test('a mid-leaf click is refused when disableFlipByClick is on', () => {
    // The user-facing half, through the public surface: `PageFlip` gates
    // `disableFlipByClick` on exactly this predicate, so a band that swallows
    // the whole leaf makes the setting silently inert.
    const { book: app } = tallNarrowPortrait({ flipOnClick: 'corners' });
    const rect = app.getBoundsRect();

    const rejected: string[] = [];
    app.on('turnRejected', (e) => rejected.push(e.data.reason));

    const mid = {
      x: rect.left + rect.width - rect.pageWidth / 2,
      y: rect.top + rect.height / 2,
    };
    app.startUserTouch(mid);
    app.userStop(mid, false);

    expect(rejected).toEqual(['disabled']);
    expect(app.getCurrentPageIndex()).toBe(0);
  });
});

describe('F7 — flipping to a page already on screen is a declared no-op', () => {
  /** Landscape, so a spread holds two pages and the case can exist at all. */
  function landscapeBook(opts?: Parameters<typeof makeHtmlBook>[0]) {
    return book({
      pageCount: 6,
      width: 200,
      height: 300,
      hostWidth: 420,
      hostHeight: 300,
      flippingTime: 0,
      ...opts,
    });
  }

  test('flip() to the partner half of the current spread does nothing, quietly', () => {
    const { book: app } = landscapeBook();
    const pages = testCollection(app);

    expect(app.getOrientation()).toBe(Orientation.LANDSCAPE);

    const spread = pages.getCurrentSpreadIndex();
    const partner = 1;
    // The precondition: page 1 really is the OTHER half of the spread page 0 is
    // on. On a portrait fixture this test would be vacuous.
    expect(pages.getSpreadIndexByPage(partner)).toBe(spread);

    const events: string[] = [];
    app.on('flip', () => events.push('flip'));
    app.on('changeState', (e) => events.push(`state:${e.data.state}`));
    app.on('turnRejected', (e) => events.push(`rejected:${e.data.reason}`));

    expect(() => {
      app.flipToPage(partner);
    }).not.toThrow();

    // Nothing animated, nothing was rejected, and the postcondition of the call
    // — "page 1 is visible" — held before it and holds after it.
    expect(events).toEqual([]);
    expect(pages.getCurrentSpreadIndex()).toBe(spread);
    expect(app.getCurrentPageIndex()).toBe(0);
    expect(pages.getSpreadIndexByPage(partner)).toBe(pages.getCurrentSpreadIndex());
  });

  test('the same call to a page on a DIFFERENT spread still turns', () => {
    // The discriminator: without it the test above is satisfied by an engine
    // that has stopped turning pages altogether.
    const { book: app } = landscapeBook();
    const pages = testCollection(app);

    app.flipToPage(3);

    expect(pages.getCurrentSpreadIndex()).toBe(1);
    expect(pages.getSpreadIndexByPage(3)).toBe(pages.getCurrentSpreadIndex());
  });

  test('a page that is in no spread still throws', () => {
    // The no-op is for a request that is ALREADY satisfied; a request that
    // cannot be satisfied keeps failing loudly.
    const { book: app } = landscapeBook();

    expect(() => {
      app.flipToPage(99);
    }).toThrow();
  });
});

describe('Z1 — a corner hover must not park the fold past the spine', () => {
  /**
   * A 50x300 leaf: narrow enough that the OLD flat 50px peel parked the fold at
   * local `x = 0`, which is exactly what `stopMove()` reads as "carried across
   * the spine". Restated as constants so a fixture that stopped being narrow
   * shows up as a precondition failure rather than as a silent pass.
   */
  const NARROW = { left: -35, top: 0, width: 100, height: 300, pageWidth: 50 } as const;

  function narrowBook(opts?: Parameters<typeof makeHtmlBook>[0]) {
    return book({ width: 50, height: 300, pageCount: 6, initialPage: 0, ...opts });
  }

  /** Inside the FORWARD corner band of the narrow leaf, at the top. */
  const HOVER = { x: NARROW.left + NARROW.width - 2, y: NARROW.top + 2 };
  /** Middle of the leaf: in neither corner band, on either axis. */
  const AWAY = { x: NARROW.left + 75, y: NARROW.top + 150 };

  function assertNarrowFixture(app: ReturnType<typeof book>['book']): void {
    expect(app.getOrientation()).toBe(Orientation.PORTRAIT);
    expect(app.getBoundsRect()).toEqual(NARROW);
    // The leaf is at most as wide as the old constant — that inequality IS the
    // defect's precondition.
    expect(NARROW.pageWidth).toBeLessThanOrEqual(50);
    const flip = testFlip(app)!;
    expect(flip.isPointOnCorners(HOVER)).toBe(true);
    expect(flip.isPointOnCorners(AWAY)).toBe(false);
  }

  test('the parked pose stays strictly inside the leaf', () => {
    // A REAL duration: `animateFlippingTo` installs frames rather than running
    // them, and `finishAnimation()` below lands the last one — which is the
    // parked pose, and the same call the hover-exit path makes.
    const { book: app } = narrowBook({ flippingTime: 1000 });
    const flip = testFlip(app)!;
    assertNarrowFixture(app);

    flip.showCorner(HOVER);
    expect(flip.getState()).toBe(FlippingState.FOLD_CORNER);

    testRender(app).finishAnimation();

    const calc = flip.getCalculation();
    expect(calc).not.toBeNull();

    // The pose, pinned against a calculation seeded at the destination the fix
    // computes: `min(50, pageWidth / 2, height / 2)` = 25, so `x = 50 - 25`.
    const parked = new FlipCalculation(
      FlipDirection.FORWARD,
      FlipCorner.TOP,
      NARROW.pageWidth,
      NARROW.height,
    );
    expect(parked.calc({ x: NARROW.pageWidth - 25, y: 25 })).toBe(true);
    expect(calc!.getPosition()).toEqual(parked.getPosition());

    // …and the property that actually matters: the corner is still on the
    // reader's side of the spine, so `stopMove()` cannot read it as a commit.
    expect(calc!.getPosition().x).toBeGreaterThan(0);

    // The negative control. Seeded at the OLD destination — a flat 50 — the
    // very same calculation parks AT the spine, which is the pose that turned
    // the page. Without this the assertion above could be satisfied by a
    // fixture that was never narrow enough to break.
    const flat = new FlipCalculation(
      FlipDirection.FORWARD,
      FlipCorner.TOP,
      NARROW.pageWidth,
      NARROW.height,
    );
    expect(flat.calc({ x: NARROW.pageWidth - 50, y: 50 })).toBe(true);
    expect(flat.getPosition().x).toBeLessThanOrEqual(0);
    expect(flat.getPosition()).not.toEqual(parked.getPosition());
  });

  test('hovering a corner and moving away turns nothing', () => {
    const { book: app } = narrowBook({ flippingTime: 1000 });
    const flip = testFlip(app)!;
    assertNarrowFixture(app);
    expect(app.getCurrentPageIndex()).toBe(0);

    flip.showCorner(HOVER);
    expect(flip.getState()).toBe(FlippingState.FOLD_CORNER);

    // The exit: `showCorner` off the corner runs `finishAnimation()` (landing
    // the parked pose) and then `stopMove()`, which starts either a snap-back
    // or a turn. Landing THAT animation is what tells the two apart — asserting
    // the index straight after the exit passes on a real duration whether or
    // not a turn was started.
    flip.showCorner(AWAY);
    testRender(app).finishAnimation();

    expect(app.getCurrentPageIndex()).toBe(0);
    expect(flip.getState()).toBe(FlippingState.READ);
    expect(flip.getCalculation()).toBeNull();
  });

  test('a drag that really does cross the spine still commits', () => {
    // The other end of the same test: `stopMove`'s `pos.x <= 0` is what makes a'
    // genuine drag past the middle turn the page, so a "fix" that clamped or
    // qualified THAT test would pass the case above and fail here.
    const { book: app } = narrowBook({ flippingTime: 1000 });
    const flip = testFlip(app)!;
    assertNarrowFixture(app);

    flip.fold(HOVER);
    expect(flip.getState()).toBe(FlippingState.USER_FOLD);
    // Dragged well past the spine, at the far left of the host.
    flip.fold({ x: NARROW.left - 40, y: NARROW.top + 2 });
    expect(flip.getCalculation()!.getPosition().x).toBeLessThanOrEqual(0);

    flip.stopMove();
    testRender(app).finishAnimation();

    expect(app.getCurrentPageIndex()).toBe(1);
    expect(flip.getState()).toBe(FlippingState.READ);
  });

  test('an ordinary leaf keeps the full 50px peel', () => {
    // The clamp is inert at ordinary proportions: 200x300 keeps `min(50, 100,
    // 150) = 50`, so this is the assertion that the fix is a bound and not a
    // rewrite of the affordance.
    const { book: app } = book({ width: 200, height: 300, pageCount: 6, flippingTime: 1000 });
    const flip = testFlip(app)!;
    const rect = app.getBoundsRect();
    expect(rect).toEqual({ left: -110, top: 0, width: 400, height: 300, pageWidth: 200 });

    flip.showCorner({ x: rect.left + rect.width - 2, y: rect.top + 2 });
    testRender(app).finishAnimation();

    const reference = new FlipCalculation(
      FlipDirection.FORWARD,
      FlipCorner.TOP,
      rect.pageWidth,
      rect.height,
    );
    expect(reference.calc({ x: rect.pageWidth - 50, y: 50 })).toBe(true);
    expect(flip.getCalculation()!.getPosition()).toEqual(reference.getPosition());
  });

  test('a short leaf peels towards its own corner, not across the middle', () => {
    // The vertical half of the same bound. On a 400x60 leaf the old flat 50 put
    // a BOTTOM peel's destination at `y = 10` — the TOP tenth of the leaf.
    const { book: app } = book({ width: 400, height: 60, pageCount: 6, flippingTime: 1000 });
    const flip = testFlip(app)!;
    const rect = app.getBoundsRect();
    expect(rect.pageWidth).toBe(400);
    expect(rect.height).toBe(60);
    expect(rect.height / 2).toBeLessThan(50);

    flip.showCorner({ x: rect.left + rect.width - 2, y: rect.top + rect.height - 2 });
    const calc = flip.getCalculation()!;
    expect(calc.getCorner()).toBe(FlipCorner.BOTTOM);

    testRender(app).finishAnimation();

    // `min(50, 200, 30) = 30`, so the destination is `y = 60 - 30 = 30`: the
    // boundary of the bottom half, never above it.
    const parked = new FlipCalculation(
      FlipDirection.FORWARD,
      FlipCorner.BOTTOM,
      rect.pageWidth,
      rect.height,
    );
    expect(parked.calc({ x: rect.pageWidth - 30, y: rect.height - 30 })).toBe(true);
    expect(calc.getPosition()).toEqual(parked.getPosition());
    expect(calc.getPosition().y).toBeGreaterThanOrEqual(rect.height / 2);
  });
});

/**
 * AN1 / AN2 — re-entrancy from the engine's own synchronous events.
 *
 * `finishAnimation()` and `setState()` both dispatch synchronously, and a
 * listener is entitled to start a turn from either. Both of these were found by
 * Codex running the BUILT engine, after unit tests that composed
 * `Render.startAnimation` callbacks directly went green: those tests never
 * touch `Flip.calc`, `turnGeneration` or `pendingTarget`, which is where the
 * two defects live. Everything below drives the public `PageFlip` surface.
 */
describe('AN1 — a turn started from `flip` beats the call that finished it', () => {
  test('the outer turn is refused rather than committing on top of the nested one', () => {
    // A REAL animation duration: with `flippingTime: 0` the turn is instant,
    // `calc` is null by the time the next call looks, and there is no outgoing
    // animation to finish — the race cannot be expressed.
    const { book: app } = book({ pageCount: 8, flippingTime: 400 });

    const seen: number[] = [];
    let chained = false;

    app.on('flip', (e) => {
      seen.push(e.data.page);
      // The ordinary auto-advance shape: chain the next turn from `onFlip`.
      if (chained) return;
      chained = true;
      app.flipNext();
    });

    const rejections: string[] = [];
    app.on('turnRejected', (e) => {
      rejections.push(e.data.reason);
    });

    app.flipNext(); // turn A, now animating
    expect(app.getCurrentPageIndex()).toBe(0);

    // Turn C, racing A. Finishing A emits `flip`, whose listener starts nested
    // turn B — and B is the reader's most recent intent.
    const started = app.flipNext();

    // Reverted fix: C overwrites B's `calc` and `pendingTarget`, C's
    // `startAnimation` then finishes B's still-running animation against C's
    // state so B commits C's destination, and C commits on top. Measured
    // against the built engine: page 3, events [1, 2, 3] — two commits for one
    // request, one of them a page the reader never asked for.
    expect(started).toBe(false);
    expect(seen).toEqual([1]);
    expect(app.getCurrentPageIndex()).toBe(1);

    // …and the nested turn is genuinely still running, not collateral damage.
    expect(testFlip(app)!.getCalculation()).not.toBeNull();
    expect(app.getState()).toBe(FlippingState.FLIPPING);

    // `boundary` would say the book is at its end. It is on page 1 of 8.
    expect(rejections).toEqual(['superseded']);
  });

  test('the refusal reason does not leak into the NEXT rejection', () => {
    const { book: app } = book({ pageCount: 4, flippingTime: 400 });

    let chained = false;
    app.on('flip', () => {
      if (chained) return;
      chained = true;
      app.flipNext();
    });

    const rejections: string[] = [];
    app.on('turnRejected', (e) => {
      rejections.push(e.data.reason);
    });

    app.flipNext();
    expect(app.flipNext()).toBe(false); // superseded

    // A genuine boundary refusal afterwards must report `boundary`. A sticky
    // field would report `superseded` for the rest of the book's life — and
    // `superseded` says "a newer turn is running", which is the opposite of
    // what a consumer disabling a "previous" button needs to hear.
    testFlip(app)!.abandon();
    app.turnToPage(0); // instant, no turn — put the book on the first spread
    expect(app.flipPrev()).toBe(false);

    expect(rejections).toEqual(['superseded', 'boundary']);
  });

  test('an unraced turn is untouched — the guard is not a blanket refusal', () => {
    const { book: app } = book({ pageCount: 8, flippingTime: 400 });

    // No listener chains anything, so finishing A moves no generation and C is
    // the ordinary finish-then-restart the engine has always done.
    expect(app.flipNext()).toBe(true);
    expect(app.flipNext()).toBe(true);
    expect(app.getCurrentPageIndex()).toBe(1);
  });

  test('an absolute turn overtaken by a nested one does not throw', () => {
    const { book: app } = book({ pageCount: 8, flippingTime: 400 });

    let chained = false;
    app.on('flip', () => {
      if (chained) return;
      chained = true;
      app.flipNext();
    });

    app.flipNext();

    // `PageFlip.flip` calls `flipToPage` directly, so a throw here reaches the
    // consumer uncaught — and the React binding drives it from the controlled
    // `page` prop on every change. Without the guard the phantom index is
    // computed against a spread the nested turn has already left, `runFlip`
    // refuses, and the caller gets `FLIP_SETUP` for a book working correctly.
    expect(() => {
      app.flipToPage(5);
    }).not.toThrow();

    expect(app.getCurrentPageIndex()).toBe(1);
  });
});

describe('AN2 — the state is true before it is announced', () => {
  test('a `changeState` listener observes the state being ENTERED', () => {
    const { book: app } = book({ pageCount: 4, flippingTime: 0 });
    const rect = app.getBoundsRect();

    const observed: string[] = [];
    app.on('changeState', (e) => {
      observed.push(`${e.data.state}:${app.getState()}`);
    });

    app.startUserTouch({ x: rect.left + rect.width - 5, y: rect.top + 10 });
    app.userMove({ x: rect.left + rect.width - 45, y: rect.top + 12 }, false);
    app.userStop({ x: rect.left + rect.width - 45, y: rect.top + 12 });

    // Reverted fix: `updateState` fired before `this.state` was assigned, so
    // every listener read the state the book was LEAVING — `read:fold_corner`
    // for the settle. `UI.onPointerMove` reads `getState()` to decide whether
    // to `preventDefault()`, so this is not only a listener-facing lie.
    expect(observed.length).toBeGreaterThan(0);
    for (const entry of observed) {
      const [announced, actual] = entry.split(':');
      expect(actual).toBe(announced);
    }
  });

  test('a turn started from the `read` announcement is not torn down', () => {
    const { book: app } = book({ pageCount: 8, flippingTime: 400 });

    let chained = false;
    let nestedStarted: boolean | null = null;

    app.on('changeState', (e) => {
      if (e.data.state !== 'read' || chained) return;
      chained = true;
      // The natural place to chain a turn: the book has just come to rest.
      nestedStarted = app.flipNext();
    });

    app.flipNext();
    testRender(app).finishAnimation();

    // Reverted fix: `setState(READ)` ran BEFORE `reset()`, so the listener's
    // `start()` installed a fresh calc, flipping page and animation and the
    // next line destroyed all of it. Measured: `flipNext()` returned true with
    // a live calculation, and once the listener returned the state was READ,
    // `calc` was null and the page had not moved — a turn that reported
    // success and never happened.
    expect(nestedStarted).toBe(true);
    expect(testFlip(app)!.getCalculation()).not.toBeNull();
    expect(app.getState()).toBe(FlippingState.FLIPPING);
  });
});

describe('V1 — a drag never inherits a fold the renderer was animating', () => {
  test('a reverse swipe refused at page zero settles the interrupted turn', () => {
    const { book: app } = book({ pageCount: 4, width: 200, height: 300, flippingTime: 400 });
    const flip = testFlip(app)!;
    const render = testRender(app);
    const rect = app.getBoundsRect();
    const leafLeft = rect.left + rect.width - rect.pageWidth;
    const states: FlippingState[] = [];
    app.on('changeState', (event) => states.push(event.data.state));

    expect(app.flipNext()).toBe(true);
    expect(app.getState()).toBe(FlippingState.FLIPPING);
    expect(render.isAnimating()).toBe(true);

    // The reverse swipe begins before the forward animation commits. Its BACK
    // fold must cancel that animation, but page zero has no BACK destination.
    const down = { x: leafLeft + 5, y: rect.top + 10 };
    const moved = { x: leafLeft + 45, y: rect.top + 12 };
    app.startUserTouch(down);
    app.userMove(moved, true);

    expect(render.isAnimating()).toBe(false);
    expect(flip.getCalculation()).toBeNull();
    expect(app.getCurrentPageIndex()).toBe(0);
    expect(app.getState()).toBe(FlippingState.READ);
    expect(states).toEqual([FlippingState.FLIPPING, FlippingState.READ]);

    // UI releases a recognized swipe with isSwipe=true, skipping stopMove.
    // The failed BACK request must not be needed to repair the engine state.
    app.userStop(moved, true);
    expect(app.flipPrev()).toBe(false);
    expect(app.getState()).toBe(FlippingState.READ);
    expect(app.flipNext()).toBe(true);
    expect(app.getState()).toBe(FlippingState.FLIPPING);
  });

  test('a boundary swipe request settles a drag that had folded the other way', () => {
    const { book: app } = book({ pageCount: 4, width: 200, height: 300, flippingTime: 400 });
    const flip = testFlip(app)!;
    const rect = app.getBoundsRect();
    const leafLeft = rect.left + rect.width - rect.pageWidth;
    const down = { x: leafLeft + rect.pageWidth - 5, y: rect.top + 10 };
    const moved = { x: leafLeft + rect.pageWidth - 45, y: rect.top + 12 };

    app.startUserTouch(down);
    app.userMove(moved, true);
    expect(app.getState()).toBe(FlippingState.USER_FOLD);
    expect(flip.getCalculation()).not.toBeNull();

    // The UI's fast-swipe branch skips stopMove and requests the semantic
    // direction. A BACK request at page zero must clear this live drag even
    // though the drag's own fold had been FORWARD.
    app.userStop(moved, true);
    expect(app.flipPrev()).toBe(false);
    expect(app.getCurrentPageIndex()).toBe(0);
    expect(flip.getCalculation()).toBeNull();
    expect(app.getState()).toBe(FlippingState.READ);
    expect(document.querySelectorAll('[data-stf-clone]')).toHaveLength(0);
  });

  /**
   * `flippingTime` has to be REAL. With `0` the peel-in and the snap-back both
   * complete synchronously inside `startAnimation`, `calc` is already null when
   * the drag arrives, and every assertion below passes against the unfixed
   * code — the shortcut that skips the path the fix lives on.
   */
  function hovered() {
    const { book: app } = book({
      pageCount: 8,
      initialPage: 2,
      width: 200,
      height: 300,
      flippingTime: 400,
    });
    const flip = testFlip(app)!;
    const rect = app.getBoundsRect();
    const leafLeft = rect.left + rect.width - rect.pageWidth;

    // Hover the RIGHT corner: a FORWARD fold peels in.
    app.userMove({ x: leafLeft + rect.pageWidth - 5, y: rect.top + 5 }, false);
    expect(app.getState()).toBe(FlippingState.FOLD_CORNER);
    expect(flip.getCalculation()?.getDirection()).toBe(FlipDirection.FORWARD);

    // Move off the corners: the snap-back starts and `calc` stays live for the
    // whole of it. This is the window the defect lives in, so assert it exists.
    app.userMove({ x: leafLeft + rect.pageWidth / 2, y: rect.top + rect.height / 2 }, false);
    expect(flip.getCalculation()).not.toBeNull();
    expect(testRender(app).isAnimating()).toBe(true);

    return { app, flip, rect, leafLeft };
  }

  test('a BACK drag begun during a corner snap-back folds BACK', () => {
    const { app, flip, rect, leafLeft } = hovered();

    app.startUserTouch({ x: leafLeft + 5, y: rect.top + 5 });
    app.userMove({ x: leafLeft + 45, y: rect.top + 8 }, false); // > 5px, so `fold()`

    expect(app.getState()).toBe(FlippingState.USER_FOLD);

    // Reverted fix: FORWARD. The reader drags the left edge and the RIGHT edge
    // peels, because `fold()` reused the hover's calculation rather than
    // building its own.
    expect(flip.getCalculation()?.getDirection()).toBe(FlipDirection.BACK);
  });

  test('the snap-back stops driving the fold, and cannot wipe it mid-drag', () => {
    const { app, flip, leafLeft, rect } = hovered();

    app.startUserTouch({ x: leafLeft + 5, y: rect.top + 5 });
    app.userMove({ x: leafLeft + 45, y: rect.top + 8 }, false);

    // The drag owns the leaf now: nothing else is scheduled against it.
    expect(testRender(app).isAnimating()).toBe(false);

    // Reverted fix: the snap-back is still in flight, so its `needReset`
    // completion nulls `calc` while the finger is still down — the gesture
    // dies partway through with no release and no `changeState`.
    testRender(app).finishAnimation();
    expect(flip.getCalculation()).not.toBeNull();
    expect(app.getState()).toBe(FlippingState.USER_FOLD);
  });

  test('a page grabbed mid-TURN does not commit behind the reader', () => {
    const { book: app } = book({
      pageCount: 8,
      initialPage: 2,
      width: 200,
      height: 300,
      flippingTime: 400,
    });
    const rect = app.getBoundsRect();
    const leafLeft = rect.left + rect.width - rect.pageWidth;

    app.flipNext();
    expect(app.getState()).toBe(FlippingState.FLIPPING);
    expect(testRender(app).isAnimating()).toBe(true);

    // The reader catches the turning leaf and drags it back towards its edge.
    app.startUserTouch({ x: leafLeft + rect.pageWidth - 20, y: rect.top + 5 });
    app.userMove({ x: leafLeft + rect.pageWidth - 8, y: rect.top + 8 }, false);
    app.userStop({ x: leafLeft + rect.pageWidth - 8, y: rect.top + 8 });
    testRender(app).finishAnimation();

    // Reverted fix: the turn's own animation was still running with
    // `isTurned: true`, so its completion committed regardless — the reader
    // pulled the page back and the book advanced anyway.
    expect(app.getCurrentPageIndex()).toBe(2);
  });

  test('a second drag begun during the FIRST drag’s snap-back folds its own way', () => {
    // The variant this test exists to kill: guarding on
    // `state !== USER_FOLD` instead of `render.isAnimating()`. It passes every
    // other assertion in this block, because a hover leaves the state at
    // FOLD_CORNER — but `stopMove()` does not announce READ until the
    // snap-back's `onAnimateEnd`, so throughout a RELEASED drag's snap-back the
    // state is still USER_FOLD and the state guard declines to rebuild.
    // `isAnimating()` is the property that actually distinguishes a fold the
    // reader is holding from one the renderer is moving.
    const { book: app } = book({
      pageCount: 8,
      initialPage: 2,
      width: 200,
      height: 300,
      flippingTime: 400,
    });
    const flip = testFlip(app)!;
    const rect = app.getBoundsRect();
    const leafLeft = rect.left + rect.width - rect.pageWidth;

    // A FORWARD drag from the right edge, released short of the spine so it
    // snaps back rather than committing.
    app.startUserTouch({ x: leafLeft + rect.pageWidth - 5, y: rect.top + 5 });
    app.userMove({ x: leafLeft + rect.pageWidth - 45, y: rect.top + 8 }, false);
    expect(flip.getCalculation()?.getDirection()).toBe(FlipDirection.FORWARD);

    app.userStop({ x: leafLeft + rect.pageWidth - 45, y: rect.top + 8 });

    // The window: the snap-back is in flight, `calc` is live, and the state has
    // NOT been handed back yet.
    expect(testRender(app).isAnimating()).toBe(true);
    expect(flip.getCalculation()).not.toBeNull();
    expect(app.getState()).toBe(FlippingState.USER_FOLD);

    // A new drag, on the opposite edge.
    app.startUserTouch({ x: leafLeft + 5, y: rect.top + 5 });
    app.userMove({ x: leafLeft + 45, y: rect.top + 8 }, false);

    expect(flip.getCalculation()?.getDirection()).toBe(FlipDirection.BACK);
    expect(testRender(app).isAnimating()).toBe(false);
  });

  test('an ordinary drag with nothing animating is untouched', () => {
    const { book: app } = book({ pageCount: 8, initialPage: 2, width: 200, height: 300 });
    const flip = testFlip(app)!;
    const rect = app.getBoundsRect();
    const leafLeft = rect.left + rect.width - rect.pageWidth;

    expect(testRender(app).isAnimating()).toBe(false);

    app.startUserTouch({ x: leafLeft + rect.pageWidth - 5, y: rect.top + 5 });
    app.userMove({ x: leafLeft + rect.pageWidth - 45, y: rect.top + 8 }, false);

    // The control: the guard must not cancel a fold that is the reader's own,
    // and a drag begun from rest must still build one.
    expect(app.getState()).toBe(FlippingState.USER_FOLD);
    expect(flip.getCalculation()?.getDirection()).toBe(FlipDirection.FORWARD);

    // …and it survives being continued, which a guard that fired every move
    // would break by rebuilding the calculation on each one.
    const calc = flip.getCalculation();
    app.userMove({ x: leafLeft + rect.pageWidth - 80, y: rect.top + 12 }, false);
    expect(flip.getCalculation()).toBe(calc);
  });
});

describe('V2 — the corner test and the direction test agree on the boundary', () => {
  test('the leaf’s own left column is a corner, because it is a BACK click', () => {
    // `flippingTime: 0` so the turn below lands synchronously and can be read
    // off the page index — CLAUDE.md's instant-turn rule: nothing may treat a
    // null `calc` after `flip()` as failure.
    const { book: app } = book({
      pageCount: 6,
      width: 200,
      height: 300,
      initialPage: 2,
      flippingTime: 0,
    });
    const flip = testFlip(app)!;
    const rect = app.getBoundsRect();

    expect(app.getOrientation()).toBe(Orientation.PORTRAIT);
    const visibleLeft = rect.width - rect.pageWidth;

    // Exactly on the boundary in book coordinates — the leaf's first column
    // and the book's first row.
    const edge = { x: rect.left + visibleLeft, y: rect.top };

    // The direction test accepts it — asserted through the public surface, by
    // clicking it and watching which way the book goes: `leafPos >= 0` is BACK,
    // and `start()` reads `y >= height / 2` for the corner, so y = 0 is a valid
    // TOP. Reading `getDirectionByPoint` directly would mean widening a private
    // method for a test, which states the implementation rather than the
    // contract.
    expect(flip.flip(edge)).toBe(true);
    expect(app.getCurrentPageIndex()).toBe(1); // BACK from 2
    app.turnToPage(2);

    // Reverted fix: `>` on both, so the engine agreed this was a BACK click on
    // the book and refused it anyway. Under `disableFlipByClick` that is a
    // click on the very corner of the page that does nothing — and a rounded
    // touch coordinate lands on that column routinely.
    expect(flip.isPointOnCorners(edge)).toBe(true);
  });

  test('the far edges are inclusive too, and beyond them is still outside', () => {
    const { book: app } = book({ pageCount: 6, width: 200, height: 300, initialPage: 2 });
    const flip = testFlip(app)!;
    const rect = app.getBoundsRect();

    // The last column and the last row of the book.
    expect(flip.isPointOnCorners({ x: rect.left + rect.width, y: rect.top })).toBe(true);
    expect(flip.isPointOnCorners({ x: rect.left + rect.width, y: rect.top + rect.height })).toBe(
      true,
    );

    // One pixel past is off the book, and inclusivity must not have widened
    // that — a `>=`/`<=` pair with the wrong operand would.
    const visibleLeft = rect.width - rect.pageWidth;
    expect(flip.isPointOnCorners({ x: rect.left + rect.width + 1, y: rect.top })).toBe(false);
    expect(flip.isPointOnCorners({ x: rect.left + visibleLeft - 1, y: rect.top })).toBe(false);
    expect(flip.isPointOnCorners({ x: rect.left + rect.width, y: rect.top - 1 })).toBe(false);
    expect(
      flip.isPointOnCorners({ x: rect.left + rect.width, y: rect.top + rect.height + 1 }),
    ).toBe(false);
  });
});

describe('AN4 — a turn started from `changeState` cannot be overrun either', () => {
  /**
   * The window AN1's guard cannot reach. `finishOutgoingTurn()` runs BEFORE
   * `start()`; this one opens after it — `calc` is installed, no animation is
   * installed yet, and `setState(FLIPPING)` hands control to consumer code
   * standing exactly in between. A listener's `flipNext()` therefore finds a
   * live calculation with nothing to finish, concludes it superseded nothing,
   * and takes the book out from under a call that is still holding the
   * calculation it replaced.
   */
  test('the outer call is refused, and does not commit a second page', () => {
    const { book: app } = book({ pageCount: 8, flippingTime: 400 });

    const seen: number[] = [];
    let chained = false;

    app.on('flip', (e) => {
      seen.push(e.data.page);
    });
    app.on('changeState', (e) => {
      if (e.data.state !== 'flipping' || chained) return;
      chained = true;
      app.flipNext();
    });

    const started = app.flipNext();

    // Reverted fix, measured against the built engine: `true`, page 1
    // committed, `state: read`, and a ghost animation left running — then the
    // NEXT `flipNext()` committed page 2 immediately and page 3 at completion.
    // Two commits for one request.
    expect(started).toBe(false);
    expect(seen).toEqual([]);
    expect(app.getCurrentPageIndex()).toBe(0);

    // The nested turn is the one that owns the book, and it is intact.
    expect(app.getState()).toBe(FlippingState.FLIPPING);
    expect(testFlip(app)!.getCalculation()).not.toBeNull();
    expect(testRender(app).isAnimating()).toBe(true);

    // …and it lands normally, once, when it finishes.
    testRender(app).finishAnimation();
    expect(seen).toEqual([1]);
    expect(app.getCurrentPageIndex()).toBe(1);
  });

  test('an absolute turn overrun the same way does not throw or strand the index', () => {
    const { book: app } = book({ pageCount: 8, flippingTime: 400 });

    let chained = false;
    app.on('changeState', (e) => {
      if (e.data.state !== 'flipping' || chained) return;
      chained = true;
      app.flipNext();
    });

    // `PageFlip.flip` reaches `flipToPage` directly, so a throw here is
    // uncaught in the consumer — and the React binding drives it from the
    // controlled `page` prop.
    expect(() => {
      app.flipToPage(5);
    }).not.toThrow();

    // The phantom spread index is the collection's PUBLIC state. Leaving it
    // installed is what made a later `flipToPage` compute its direction from a
    // spread the book was never on.
    expect(testCollection(app).getCurrentSpreadIndex()).toBe(0);
    expect(app.getCurrentPageIndex()).toBe(0);

    testRender(app).finishAnimation();
    expect(app.getCurrentPageIndex()).toBe(1);
  });

  test('a `flipping` listener that starts NO turn is unaffected', () => {
    const { book: app } = book({ pageCount: 8, flippingTime: 400 });

    const states: string[] = [];
    app.on('changeState', (e) => states.push(e.data.state));

    // The control: the guard must fire on a moved generation, not on the mere
    // presence of a listener.
    expect(app.flipNext()).toBe(true);
    expect(states).toEqual(['flipping']);

    testRender(app).finishAnimation();
    expect(app.getCurrentPageIndex()).toBe(1);
  });
});

/**
 * Codex round 8 — ownership across an interruption.
 *
 * AN4 stopped a nested turn being OVERRUN. These are the other half: what the
 * interrupted turn leaves behind, and the two remaining places turn setup hands
 * control to consumer code. All four were reproduced against the built engine
 * before being fixed.
 */
describe('AN6 — an interrupted turn takes its destination with it', () => {
  test('a drag that grabs a `flip(page)` makes its OWN one-step turn', () => {
    const { book: app } = book({ pageCount: 8, width: 200, height: 300, flippingTime: 400 });
    const flip = testFlip(app)!;
    const rect = app.getBoundsRect();
    const leafLeft = rect.left + rect.width - rect.pageWidth;

    app.flipToPage(5);
    expect(testRender(app).isAnimating()).toBe(true);

    // The reader catches the moving leaf and carries it across the spine.
    app.startUserTouch({ x: leafLeft + rect.pageWidth - 20, y: rect.top + 5 });
    app.userMove({ x: leafLeft + rect.pageWidth - 60, y: rect.top + 8 }, false);
    app.userMove({ x: leafLeft - rect.pageWidth, y: rect.top + 10 }, false);
    app.userStop({ x: leafLeft - rect.pageWidth, y: rect.top + 10 });
    testRender(app).finishAnimation();

    // Reverted fix: 5. V1 cancels the `flip(5)` and resets the calculation, but
    // `pendingTarget` survived `reset()` — so the reader's own one-step turn
    // consumed a destination it never asked for. Their drag, someone else's
    // page.
    expect(app.getCurrentPageIndex()).toBe(1);
    expect(flip.getCalculation()).toBeNull();
  });

  test('an instant nested turn cannot leave the two spread getters disagreeing', () => {
    const { book: app } = book({ pageCount: 8, width: 200, height: 300, flippingTime: 0 });

    let chained = false;
    app.on('changeState', (e) => {
      if (e.data.state !== 'flipping' || chained) return;
      chained = true;
      app.flipNext();
    });

    expect(() => {
      app.flipToPage(5);
    }).not.toThrow();

    // Reverted fix: `getCurrentPageIndex() === 5` with
    // `getCurrentSpreadIndex() === 0`. The phantom spread was still installed
    // when `setState(FLIPPING)` dispatched, so the nested turn chose its pages
    // from a spread the book was not on and — being instant — committed off it,
    // after which the outer arm restored only the index. Two public getters
    // contradicting each other is not a state any consumer can reason about.
    const index = app.getCurrentPageIndex();
    const spread = testCollection(app).getCurrentSpreadIndex();
    expect(index).toBe(1);
    expect(spread).toBe(1);
    expect(testCollection(app).getSpreadIndexByPage(index)).toBe(spread);
  });

  test('the phantom spread is never observable from a `changeState` listener', () => {
    const { book: app } = book({ pageCount: 8, width: 200, height: 300, flippingTime: 400 });

    const seen: number[] = [];
    app.on('changeState', () => {
      // The `isDestroyed()` guard is not defensive padding — it is L8, found by
      // this very test. `destroy()` calls `abandon()`, which announces READ,
      // and Y2 deliberately clears listeners LAST so teardown's own events
      // still land. By then `pages` is null, so a listener that reads engine
      // state throws `DESTROYED` — and since E2 rethrows the first listener
      // error synchronously, that throw comes out of `book.destroy()` itself.
      if (app.isDestroyed()) return;
      seen.push(testCollection(app).getCurrentSpreadIndex());
    });

    app.flipToPage(5);

    // The phantom (spread 4) exists only so `start()` picks the DESTINATION
    // leaves. A listener that sees it is a listener that can act on it — which
    // is exactly how the contradiction above arose.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain(4);
    expect(seen.every((s) => s === 0)).toBe(true);
  });
});

describe('AN5 — the last two places turn setup calls out to consumer code', () => {
  test('a `user_fold` listener’s turn is not dragged by the finger that woke it', () => {
    const { book: app } = book({ pageCount: 8, width: 200, height: 300, flippingTime: 400 });
    const flip = testFlip(app)!;
    const rect = app.getBoundsRect();
    const leafLeft = rect.left + rect.width - rect.pageWidth;

    let chained = false;
    let nestedPos: string | null = null;

    app.on('changeState', (e) => {
      if (e.data.state !== 'user_fold' || chained) return;
      chained = true;
      app.flipNext();
      nestedPos = JSON.stringify(flip.getCalculation()?.getPosition());
    });

    app.startUserTouch({ x: leafLeft + rect.pageWidth - 5, y: rect.top + 5 });
    app.userMove({ x: leafLeft + rect.pageWidth - 45, y: rect.top + 8 }, false);

    // Reverted fix: {x:170,y:30} became {x:155,y:8} — the outer `do()` dragged
    // the NESTED turn's calculation, because `this.calc` is what it points at,
    // before that turn had rendered a single frame of its own.
    expect(nestedPos).not.toBeNull();
    expect(JSON.stringify(flip.getCalculation()?.getPosition())).toBe(nestedPos);
  });

  test('a `fold_corner` listener’s turn is not force-finished by the hover', () => {
    const { book: app } = book({
      pageCount: 8,
      initialPage: 2,
      width: 200,
      height: 300,
      flippingTime: 400,
    });
    const rect = app.getBoundsRect();
    const leafLeft = rect.left + rect.width - rect.pageWidth;

    let chained = false;
    app.on('changeState', (e) => {
      if (e.data.state !== 'fold_corner' || chained) return;
      chained = true;
      app.flipNext();
    });

    app.userMove({ x: leafLeft + rect.pageWidth - 5, y: rect.top + 5 }, false);

    // Reverted fix: the hover resumed, and `animateFlippingTo` opens by
    // finishing whatever is running — so the listener's turn was FORCE-FINISHED
    // and committed page 2 to 3, leaving `state: read`, `calc: null` and a ghost
    // animation scheduled against nothing. A hover is an affordance; it must
    // never be the thing that commits a page, least of all someone else's.
    expect(app.getCurrentPageIndex()).toBe(2);
    expect(app.getState()).toBe(FlippingState.FLIPPING);
    expect(testFlip(app)!.getCalculation()).not.toBeNull();
  });
});

/**
 * `Flip.checkState` — the guard `showCorner` opens with.
 *
 * A ~530-mutant sweep replaced its whole body with `{ void states; return
 * true; }` and the entire suite stayed green, this 1,482-line file included.
 * Its only call site is `showCorner`, whose own docblock calls the window it
 * protects "the most destructive of the three", and nothing asserted that a
 * hover arriving mid-turn is a no-op.
 *
 * A hover is an affordance. It must never commit a page, and it must never
 * yank a fold someone else's gesture is driving.
 *
 * `flippingTime` is real throughout: an instant turn is over before a hover can
 * land on it, so a `flippingTime: 0` fixture would pass against either code.
 */
describe('checkState — a hover arriving mid-turn is a no-op', () => {
  /** A hover: pointer up, no buttons, so `UI` routes it to `showCorner`. */
  function hover(app: ReturnType<typeof book>['book'], x: number, y: number): void {
    app.getBlockElement().dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'mouse',
        buttons: 0,
        clientX: x,
        clientY: y,
      }),
    );
  }

  test('a hover away from the corners during FLIPPING does not finish the turn', () => {
    const { book: app } = book({ pageCount: 6, initialPage: 0, flippingTime: 400 });
    const rect = app.getBoundsRect();

    expect(app.flipNext()).toBe(true);
    expect(app.getState()).toBe(FlippingState.FLIPPING);
    expect(app.getCurrentPageIndex()).toBe(0);

    // Mid-height, mid-leaf: `isPointOnCorners` is false here, so an unguarded
    // `showCorner` takes its else-branch — `render.finishAnimation()` followed
    // by `stopMove()`. `finishAnimation` runs the in-flight turn's
    // `onAnimateEnd`, which COMMITS the page. A mouse drifting across the book
    // would land the turn early and leave the state machine in READ.
    hover(app, rect.left + rect.width - rect.pageWidth / 2, rect.top + rect.height / 2);

    expect(app.getCurrentPageIndex()).toBe(0);
    expect(app.getState()).toBe(FlippingState.FLIPPING);
    expect(testFlip(app)!.getCalculation()).not.toBeNull();
  });

  test('a hover ON a corner during FLIPPING does not drag the in-flight fold', () => {
    const { book: app } = book({ pageCount: 6, initialPage: 0, flippingTime: 400 });
    const flip = testFlip(app)!;
    const rect = app.getBoundsRect();

    expect(app.flipNext()).toBe(true);
    const before = { ...flip.getCalculation()!.getPosition() };

    // On the corner and `calc !== null`, so an unguarded `showCorner` reaches
    // `this.do(convertToPage(globalPos))` — recomputing the running turn's
    // geometry from the POINTER. The fold jumps to wherever the mouse is.
    hover(app, rect.left + rect.width - 4, rect.top + 4);

    expect(flip.getCalculation()!.getPosition()).toEqual(before);
    expect(app.getState()).toBe(FlippingState.FLIPPING);
  });

  test('a hover during USER_FOLD does not steal the drag', () => {
    const { book: app } = book({ pageCount: 6, initialPage: 0, flippingTime: 400 });
    const flip = testFlip(app)!;
    const rect = app.getBoundsRect();

    // A real drag: down on the forward corner, then past the 5 px threshold.
    const startX = rect.left + rect.width - 8;
    const y = rect.top + 8;
    app.startUserTouch({ x: startX, y });
    app.userMove({ x: startX - 40, y: y + 4 }, false);
    expect(app.getState()).toBe(FlippingState.USER_FOLD);

    const before = { ...flip.getCalculation()!.getPosition() };

    // Delivered through the controller rather than a pointermove, because the
    // UI cannot produce this: while a pointer is captured every move is a
    // `fold`. It IS reachable through the public `userMove` surface (a custom
    // input layer, a synthetic gesture) and through any consumer holding the
    // controller, and `showCorner` is the guard that has to hold either way.
    flip.showCorner({ x: rect.left + rect.width - 4, y: rect.top + 4 });

    expect(flip.getCalculation()!.getPosition()).toEqual(before);
    expect(app.getState()).toBe(FlippingState.USER_FOLD);
  });

  test('…and the guard still lets a hover through from READ', () => {
    // The control. A guard that returned `false` unconditionally would satisfy
    // every assertion above and break the corner affordance entirely.
    const { book: app } = book({ pageCount: 6, initialPage: 0, flippingTime: 400 });
    const rect = app.getBoundsRect();

    expect(app.getState()).toBe(FlippingState.READ);
    hover(app, rect.left + rect.width - 4, rect.top + 4);

    expect(app.getState()).toBe(FlippingState.FOLD_CORNER);
    expect(testFlip(app)!.getCalculation()).not.toBeNull();
  });
});
