/**
 * Input-layer defects I4, I6, I10, I11, I19 (historical pointer audit).
 *
 * Every test here is written to fail with its fix reverted AND with a
 * plausible half-fix in place — see the comments marking what each assertion
 * is guarding against.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FlipCorner, FlippingState } from '@gullabs/flipbook-core';
import { installPointerCaptureShims, makeHtmlBook } from './html-book-fixture';
import { testFlip } from './engine-access';

const books: Array<{ destroy: () => void }> = [];

beforeEach(() => {
  installPointerCaptureShims();
});

afterEach(() => {
  while (books.length) books.pop()?.destroy();
  vi.restoreAllMocks();
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

describe('I4 destroy() must not take the caller’s pages with it', () => {
  test('adopted page elements are handed back to the host, not deleted', () => {
    const { book: app, host, pages } = book({ pageCount: 4 });

    // Precondition: the engine really did adopt them (otherwise the test
    // proves nothing about release).
    const dist = app.getBlockElement();
    for (const page of pages) expect(page.parentElement).toBe(dist);

    // A node the engine did NOT adopt: this is what React's portal does —
    // it renders straight into the block, and the engine must not touch it.
    const portalled = document.createElement('div');
    portalled.dataset.owner = 'react';
    dist.appendChild(portalled);

    app.destroy();

    // The block itself is gone...
    expect(host.querySelector('.stf__block')).toBeNull();

    // ...but every adopted page survives, back under the host we took it from.
    // `parentElement === host` (not merely `isConnected`) is what catches a
    // "release" that reparents to document.body or leaves them in a detached
    // block.
    for (const page of pages) {
      expect(page.isConnected).toBe(true);
      expect(page.parentElement).toBe(host);
    }
    expect(host.children.length).toBeGreaterThanOrEqual(pages.length);

    // The non-adopted node must NOT have been handed to the host: releasing
    // everything inside the block is the subtly-wrong variant, and it moves a
    // node out from under React's recorded parent.
    expect(portalled.parentElement).not.toBe(host);
  });
});

describe('I6 swipe corner is decided in book space', () => {
  test('an upper-half swipe on a vertically centred book turns the TOP corner', () => {
    const { book: app } = book({
      pageCount: 4,
      width: 200,
      height: 300,
      hostWidth: 380,
      hostHeight: 600,
      swipeDistance: 40,
      flippingTime: 0,
    });

    const rect = app.getBoundsRect();
    // Fixture guard: the whole defect is the missing `rect.top`. If the book
    // is not inset, the wrong answer coincides with the right one.
    expect(rect.top).toBeGreaterThan(0);
    expect(rect.height).toBe(300);

    const dist = app.getBlockElement();
    const flipNext = vi.spyOn(app, 'flipNext');

    // 30px below the book's top edge: element y = 180, book y = 30.
    // The buggy comparison is 180 >= 150 -> BOTTOM.
    const y = rect.top + 30;
    const startX = rect.left + rect.width - 20;

    pointer('pointerdown', dist, { clientX: startX, clientY: y });
    pointer('pointerup', dist, { clientX: startX - 120, clientY: y });

    expect(flipNext).toHaveBeenCalledTimes(1);
    expect(flipNext).toHaveBeenCalledWith(FlipCorner.TOP);
  });

  test('a lower-half swipe still turns the BOTTOM corner', () => {
    const { book: app } = book({
      pageCount: 4,
      width: 200,
      height: 300,
      hostWidth: 380,
      hostHeight: 600,
      swipeDistance: 40,
      flippingTime: 0,
    });

    const rect = app.getBoundsRect();
    expect(rect.top).toBeGreaterThan(0);

    const dist = app.getBlockElement();
    const flipNext = vi.spyOn(app, 'flipNext');

    // book y = 280: genuinely the bottom half.
    const y = rect.top + 280;
    const startX = rect.left + rect.width - 20;

    pointer('pointerdown', dist, { clientX: startX, clientY: y });
    pointer('pointerup', dist, { clientX: startX - 120, clientY: y });

    expect(flipNext).toHaveBeenCalledWith(FlipCorner.BOTTOM);
  });
});

describe('I10 unbinding handlers mid-gesture cancels the gesture', () => {
  test('a settings toggle during a drag does not leave the fold glued to the cursor', () => {
    const { book: app } = book({ pageCount: 4, flippingTime: 0 });
    const dist = app.getBlockElement();
    const rect = app.getBoundsRect();

    pointer('pointerdown', dist, { clientX: rect.left + rect.width - 6, clientY: rect.top + 6 });
    pointer('pointermove', dist, { clientX: rect.left + rect.width - 80, clientY: rect.top + 40 });
    expect(app.getState()).toBe(FlippingState.USER_FOLD);

    // refreshHandlers() -> removeHandlers() in the middle of the gesture.
    app.updateSettings({ pointerInput: [] });
    app.updateSettings({ pointerInput: ['mouse', 'touch', 'pen'] });

    expect(app.getState()).toBe(FlippingState.READ);

    // ...and the engine no longer thinks a finger is down: a button-less hover
    // in the MIDDLE of the page (nowhere near a corner) must fold nothing.
    // This is what catches a half-fix that clears `touchPoint` locally but
    // leaves `PageFlip.isUserTouch` set.
    hover(dist, rect.left + rect.width / 2, rect.top + rect.height / 2);
    expect(app.getState()).toBe(FlippingState.READ);

    // No turn was committed by the cancellation.
    expect(app.getCurrentPageIndex()).toBe(0);
  });
});

describe('I11 only the pointer that started the gesture drives it', () => {
  test('a second pointer neither captures, drives, nor ends the gesture', () => {
    const { book: app } = book({ pageCount: 4, flippingTime: 0 });
    const dist = app.getBlockElement();
    const rect = app.getBoundsRect();

    const capture = vi.spyOn(dist, 'setPointerCapture');
    const release = vi.spyOn(dist, 'releasePointerCapture');

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

    const flip = testFlip(app);
    const held = { ...flip!.getCalculation()!.getPosition() };

    // Finger 2 lands. It must not take the capture...
    pointer('pointerdown', dist, {
      pointerId: 2,
      clientX: rect.left + 20,
      clientY: rect.top + rect.height - 20,
    });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(1);

    // ...must not move the fold (a pinch-zoom used to drag the page)...
    pointer('pointermove', dist, {
      pointerId: 2,
      clientX: rect.left + 30,
      clientY: rect.top + rect.height - 30,
    });
    expect(flip!.getCalculation()!.getPosition()).toEqual(held);
    expect(app.getState()).toBe(FlippingState.USER_FOLD);

    // ...and lifting it must not end the gesture or commit a turn.
    pointer('pointerup', dist, {
      pointerId: 2,
      clientX: rect.left + 30,
      clientY: rect.top + rect.height - 30,
    });
    expect(app.getState()).toBe(FlippingState.USER_FOLD);
    expect(release).not.toHaveBeenCalledWith(2);
    expect(app.getCurrentPageIndex()).toBe(0);

    // The owning pointer still ends it.
    pointer('pointerup', dist, {
      pointerId: 1,
      clientX: rect.left + rect.width - 80,
      clientY: rect.top + 40,
    });
    expect(release).toHaveBeenCalledWith(1);
    expect(app.getState()).toBe(FlippingState.READ);
  });

  test('hover still works with no gesture in progress', () => {
    const { book: app } = book({ pageCount: 4, flippingTime: 0 });
    const dist = app.getBlockElement();
    const rect = app.getBoundsRect();

    // An arbitrary pointer id, never seen in a pointerdown.
    dist.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        pointerId: 77,
        button: -1,
        buttons: 0,
        pointerType: 'mouse',
        clientX: rect.left + rect.width - 6,
        clientY: rect.top + 6,
      }),
    );

    expect(app.getState()).toBe(FlippingState.FOLD_CORNER);
  });
});

describe('I19 hovering an interactive target does not fold the corner over it', () => {
  test('a link in the page corner is not covered by the hover fold', () => {
    const { book: app, pages } = book({ pageCount: 4, flippingTime: 0 });
    const rect = app.getBoundsRect();
    const page = pages[0];
    if (!page) throw new Error('fixture produced no pages');

    const link = document.createElement('a');
    link.href = 'https://example.com';
    link.textContent = 'buy';
    page.appendChild(link);

    const cornerX = rect.left + rect.width - 6;
    const cornerY = rect.top + 6;

    // Hovering the link: no fold.
    hover(link, cornerX, cornerY);
    expect(app.getState()).toBe(FlippingState.READ);

    // Fixture guard: the same coordinates on a NON-interactive target really
    // are a corner, so the assertion above is about the target, not the point.
    hover(page, cornerX, cornerY);
    expect(app.getState()).toBe(FlippingState.FOLD_CORNER);

    // And moving from the page onto the link puts the corner back down.
    hover(link, cornerX, cornerY);
    expect(app.getState()).not.toBe(FlippingState.FOLD_CORNER);
  });
});
