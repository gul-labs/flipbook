/**
 * F05 — public `cancelTurn()`.
 *
 * Thin wrapper over the same abandon path mid-turn resize and `updateSettings`
 * already use. Not finish, pause, resume, or jump.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FlippingState, PageFlip } from '@gullabs/flipbook-core';
import { installPointerCaptureShims, makeHtmlBook } from './html-book-fixture';
import { testFlip } from './engine-access';

const books: Array<{ destroy: () => void }> = [];

beforeEach(() => {
  installPointerCaptureShims();
});

afterEach(() => {
  while (books.length) books.pop()?.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function book(opts?: Parameters<typeof makeHtmlBook>[0]) {
  const b = makeHtmlBook({ pageCount: 6, flippingTime: 800, ...opts });
  books.push(b);
  return b;
}

function pointer(
  app: PageFlip,
  type: string,
  init: PointerEventInit & { clientX: number; clientY: number },
): void {
  app.getBlockElement().dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      button: 0,
      buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0,
      pointerType: 'mouse',
      ...init,
    }),
  );
}

function startForwardDrag(app: PageFlip): void {
  const rect = app.getBoundsRect();
  const y = rect.top + rect.height - 8;
  pointer(app, 'pointerdown', { clientX: rect.left + rect.width - 6, clientY: y });
  pointer(app, 'pointermove', { clientX: rect.left + rect.width - 40, clientY: y });
  pointer(app, 'pointermove', { clientX: rect.left + rect.width - 120, clientY: y });
}

function stubRafQueue(): FrameRequestCallback[] {
  const queued: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    queued.push(cb);
    return queued.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    /* leave the queue; cancelTurn must survive a late frame */
  });
  return queued;
}

function flushQueuedRaf(queued: FrameRequestCallback[], timestamp = 16): void {
  for (let i = 0; i < 20 && queued.length > 0; i += 1) {
    const batch = queued.splice(0, queued.length);
    for (const cb of batch) cb(timestamp);
  }
  expect(queued).toHaveLength(0);
}

describe('F05 — cancelTurn', () => {
  test('idle, uninitialized and destroyed return false', () => {
    const { book: app } = book({ flippingTime: 0 });
    expect(app.cancelTurn()).toBe(false);
    expect(app.cancelTurn()).toBe(false);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const unloaded = new PageFlip(host, { width: 200, height: 300 });
    expect(unloaded.cancelTurn()).toBe(false);

    app.destroy();
    expect(app.cancelTurn()).toBe(false);
    unloaded.destroy();
    host.remove();
  });

  test('abandons an in-flight drag without committing or emitting flip', () => {
    const { book: app } = book();
    const flips: number[] = [];
    app.on('flip', (e) => flips.push(e.data.page));

    startForwardDrag(app);
    expect(app.getState()).toBe(FlippingState.USER_FOLD);
    expect(app.cancelTurn()).toBe(true);

    expect(app.getCurrentPageIndex()).toBe(0);
    expect(app.getState()).toBe(FlippingState.READ);
    expect(testFlip(app)?.getCalculation() ?? null).toBeNull();
    expect(flips).toEqual([]);
    expect(app.cancelTurn()).toBe(false);
  });

  test('abandons a programmed curl; a stale completion cannot commit', () => {
    const queued = stubRafQueue();
    const { book: app } = book({ flippingTime: 1000, respectReducedMotion: false });
    flushQueuedRaf(queued, 0);

    const flips: number[] = [];
    app.on('flip', (e) => flips.push(e.data.page));

    expect(app.flipNext()).toBe(true);
    expect(app.isAnimating()).toBe(true);
    expect(app.cancelTurn()).toBe(true);

    expect(app.getCurrentPageIndex()).toBe(0);
    expect(app.isAnimating()).toBe(false);
    expect(app.getState()).toBe(FlippingState.READ);
    expect(testFlip(app)?.getCalculation() ?? null).toBeNull();
    expect(flips).toEqual([]);

    flushQueuedRaf(queued, 1_000_000);
    expect(app.getCurrentPageIndex()).toBe(0);
    expect(flips).toEqual([]);
  });

  test('abandons a hover fold', () => {
    const queued = stubRafQueue();
    const { book: app } = book({ foldCornerOnHover: true, flippingTime: 400 });
    flushQueuedRaf(queued, 0);

    const rect = app.getBoundsRect();
    pointer(app, 'pointermove', {
      clientX: rect.left + rect.width - 4,
      clientY: rect.top + 4,
      buttons: 0,
    });
    expect(testFlip(app)?.getCalculation()).not.toBeNull();
    expect(app.cancelTurn()).toBe(true);
    expect(app.getState()).toBe(FlippingState.READ);
    expect(app.getCurrentPageIndex()).toBe(0);
    expect(testFlip(app)?.getCalculation() ?? null).toBeNull();
    expect(app.isAnimating()).toBe(false);

    flushQueuedRaf(queued, 1_000_000);
    expect(app.getCurrentPageIndex()).toBe(0);
    expect(app.getState()).toBe(FlippingState.READ);
  });

  test('a changeState listener that starts a new turn keeps the new generation', () => {
    const { book: app } = book({ flippingTime: 0 });
    let nested = false;
    startForwardDrag(app);
    app.on('changeState', (e) => {
      if (e.data.state === FlippingState.READ && !nested) {
        nested = true;
        expect(app.flipNext()).toBe(true);
      }
    });

    expect(app.cancelTurn()).toBe(true);
    expect(app.getCurrentPageIndex()).toBe(1);
  });

  test('a changeState listener that destroys the engine is safe', () => {
    const { book: app } = book({ flippingTime: 0 });
    startForwardDrag(app);
    app.on('changeState', () => {
      if (!app.isDestroyed()) app.destroy();
    });

    expect(app.cancelTurn()).toBe(true);
    expect(app.isDestroyed()).toBe(true);
    expect(app.cancelTurn()).toBe(false);
  });
});
