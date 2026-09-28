import { describe, expect, test } from 'vitest';
import { COMMIT_TURN, EMIT_STATE, SET_SPREAD_INDEX, GET_COLLECTION } from '../src/internal';
import { FlipCorner } from '@gullabs/flipbook-core';
import { Flip } from '../src/Flip/Flip';
import { FlipDirection } from '../src/Flip/Flip';
import type { Render } from '../src/Render/Render';

type Options = {
  readingDirection?: 'ltr' | 'rtl';
  spreadCount?: number;
  currentSpread?: number;
  orientation?: 'portrait' | 'landscape';
};

/**
 * Minimal engine harness: the assertions are about which FlipDirection the
 * controller resolves, so the collection and render are stubs.
 */
function makeFlip(options?: Options) {
  const directions: FlipDirection[] = [];

  const collection = {
    spread: options?.currentSpread ?? 1,
    getCurrentSpreadIndex() {
      return this.spread;
    },
    getSpreadCount() {
      return options?.spreadCount ?? 8;
    },
    getSpreadIndexByPage(page: number) {
      return page < 0 ? null : page;
    },
    [SET_SPREAD_INDEX](index: number) {
      this.spread = index;
    },
    getFlippingPage() {
      // A live leaf, not a portrait copy: Flip drops a copy through its owner.
      return {
        id: 'flip',
        getDensity: () => 'soft',
        setDrawingDensity() {},
        getCopyOwner: () => null,
      };
    },
    getBottomPage() {
      return { id: 'bottom', getDensity: () => 'soft', setDrawingDensity() {} };
    },
    nextBy() {
      return null;
    },
    prevBy() {
      return null;
    },
  };

  const render = {
    finishAnimation() {},
    convertToPage(pos: { x: number; y: number }) {
      return pos;
    },
    convertToBook(pos: { x: number; y: number }) {
      return pos;
    },
    getRect() {
      return { left: 0, top: 0, width: 800, height: 600, pageWidth: 400 };
    },
    getOrientation() {
      return options?.orientation ?? 'landscape';
    },
    setDirection(direction: FlipDirection) {
      directions.push(direction);
    },
    setPageRect() {},
    setBottomPage() {},
    setFlippingPage() {},
    setShadowData() {},
    startAnimation(frames: Array<() => void>, _duration: number, onEnd: () => void) {
      const last = frames[frames.length - 1];
      if (last) last();
      onEnd();
    },
    clearShadow() {},
  };

  const app = {
    [GET_COLLECTION]: () => collection,
    getSettings: () => ({
      flipOnClick: 'anywhere',
      flippingTime: 0,
      respectReducedMotion: true,
      readingDirection: options?.readingDirection ?? ('ltr' as const),
      foldCornerOnHover: true,
    }),
    getCurrentPageIndex: () => collection.spread,
    getPageCount: () => options?.spreadCount ?? 8,
    turnToPrevPage() {},
    turnToNextPage() {},
    [COMMIT_TURN]() {},
    [EMIT_STATE]() {},
  };

  const flip = new Flip(render as unknown as Render, app as never);
  return { flip, collection, directions };
}

describe('reading direction applies to user-originated points', () => {
  test('ltr: the right half of the book turns forward', () => {
    const { flip, directions } = makeFlip();
    flip.start({ x: 700, y: 10 });
    expect(directions[0]).toBe(FlipDirection.FORWARD);
  });

  test('ltr: the left half turns back', () => {
    const { flip, directions } = makeFlip();
    flip.start({ x: 100, y: 10 });
    expect(directions[0]).toBe(FlipDirection.BACK);
  });

  test('rtl: the hit test is mirrored, so the left half turns forward', () => {
    const { flip, directions } = makeFlip({ readingDirection: 'rtl' });
    flip.start({ x: 100, y: 10 });
    expect(directions[0]).toBe(FlipDirection.FORWARD);
  });

  test('rtl: the right half turns back', () => {
    const { flip, directions } = makeFlip({ readingDirection: 'rtl' });
    flip.start({ x: 700, y: 10 });
    expect(directions[0]).toBe(FlipDirection.BACK);
  });

  test('rtl does not invert programmatic turns', () => {
    const { flip, directions } = makeFlip({ readingDirection: 'rtl' });
    flip.flipNext(FlipCorner.TOP);
    expect(directions[0]).toBe(FlipDirection.FORWARD);

    const back = makeFlip({ readingDirection: 'rtl' });
    back.flip.flipPrev(FlipCorner.TOP);
    expect(back.directions[0]).toBe(FlipDirection.BACK);
  });
});

describe('turns are bounded by spreads, not page indices', () => {
  test('no forward turn from the last spread', () => {
    // Landscape: the final spread can hold two pages, so `currentPageIndex`
    // (spread[0]) is still below `pageCount - 1` there. Upstream let the turn
    // start and then read one past the end of the spread list.
    const { flip } = makeFlip({ spreadCount: 3, currentSpread: 2 });
    expect(flip.flipNext(FlipCorner.TOP)).toBe(false);
  });

  test('forward turn allowed from the second-to-last spread', () => {
    const { flip } = makeFlip({ spreadCount: 3, currentSpread: 1 });
    expect(flip.flipNext(FlipCorner.TOP)).toBe(true);
  });

  test('no back turn from the first spread', () => {
    const { flip } = makeFlip({ spreadCount: 3, currentSpread: 0 });
    expect(flip.flipPrev(FlipCorner.TOP)).toBe(false);
  });
});
