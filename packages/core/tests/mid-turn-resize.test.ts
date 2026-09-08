/**
 * F02 / F03 — automatic resize while a turn is in flight.
 *
 * Drives the real `ResizeObserver` / `visualViewport` path (`UI.onResize` →
 * `UI.update` → `Render.update`), not a rest-state `book.update()` helper.
 * Orientation-flip mid-turn is first: that is the path that also rebuilds
 * spreads via `ADOPT_ORIENTATION`.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FlippingState } from '@gullabs/flipbook-core';
import type { PageFlip } from '@gullabs/flipbook-core';
import { installPointerCaptureShims, makeHtmlBook, sizeElement } from './html-book-fixture';
import { testFlip } from './engine-access';

let resizeObservers: Array<() => void> = [];
let visualViewportListeners: Array<() => void> = [];

class FakeResizeObserver {
  public constructor(private readonly cb: () => void) {
    resizeObservers.push(() => {
      this.cb();
    });
  }
  public observe(): void {
    /* the element does not matter; tests fire the callback directly */
  }
  public disconnect(): void {
    /* nothing retained */
  }
  public unobserve(): void {
    /* nothing retained */
  }
}

const books: Array<{ destroy: () => void }> = [];

beforeEach(() => {
  installPointerCaptureShims();
  resizeObservers = [];
  visualViewportListeners = [];
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
});

afterEach(() => {
  while (books.length) books.pop()?.destroy();
  Reflect.deleteProperty(globalThis, 'ResizeObserver');
  Reflect.deleteProperty(window, 'visualViewport');
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const landscape = {
  pageCount: 6,
  hostWidth: 520,
  hostHeight: 300,
  width: 200,
  height: 300,
  flippingTime: 800,
  usePortrait: true,
};

function book(opts: Parameters<typeof makeHtmlBook>[0] = {}) {
  const b = makeHtmlBook({ ...landscape, ...opts });
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

/** Open a forward USER_FOLD from the bottom-right corner; leave the pointer down. */
function startForwardDrag(app: PageFlip): void {
  const rect = app.getBoundsRect();
  const y = rect.top + rect.height - 8;
  pointer(app, 'pointerdown', { clientX: rect.left + rect.width - 6, clientY: y });
  pointer(app, 'pointermove', { clientX: rect.left + rect.width - 40, clientY: y });
  pointer(app, 'pointermove', { clientX: rect.left + rect.width - 120, clientY: y });
}

function startBackDrag(app: PageFlip): void {
  const rect = app.getBoundsRect();
  const y = rect.top + rect.height / 2;
  pointer(app, 'pointerdown', { clientX: rect.left + 8, clientY: y });
  pointer(app, 'pointermove', { clientX: rect.left + 40, clientY: y });
  pointer(app, 'pointermove', { clientX: rect.left + 120, clientY: y });
}

function fireResizeObservers(): void {
  expect(resizeObservers.length, 'ResizeObserver was never installed').toBeGreaterThan(0);
  for (const fire of resizeObservers) fire();
}

function stubRafQueue(): FrameRequestCallback[] {
  const queued: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    queued.push(cb);
    return queued.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    /* cancelAnimation does not drop the loop via this; leave the queue */
  });
  return queued;
}

/**
 * Run already-queued loop callbacks. `timestamp` is the rAF clock: a large
 * value after cancel must overshoot and commit if `this.animation` was left
 * live (`onAnimateEnd`). Caps re-arms so a loop that never parks fails.
 */
function flushQueuedRaf(queued: FrameRequestCallback[], timestamp = 16): void {
  for (let i = 0; i < 20 && queued.length > 0; i += 1) {
    const batch = queued.splice(0, queued.length);
    for (const cb of batch) cb(timestamp);
  }
  expect(queued, 'rAF kept re-arming after cancel — loop did not park').toHaveLength(0);
}

function resizeHost(fixture: ReturnType<typeof makeHtmlBook>, width: number, height = 300): void {
  sizeElement(fixture.host, width, height);
  sizeElement(fixture.book.getBlockElement(), width, height);
  fireResizeObservers();
}

function cloneCount(app: PageFlip, pages: HTMLElement[]): number {
  const block = app.getBlockElement();
  return [...block.querySelectorAll<HTMLElement>('.stf__item')].filter((el) => !pages.includes(el))
    .length;
}

function installVisualViewport(): void {
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: {
      addEventListener: (_type: string, cb: () => void) => visualViewportListeners.push(cb),
      removeEventListener: () => undefined,
    },
  });
}

describe('F02 — observer path while a turn is in flight', () => {
  test('orientation flip mid-turn (landscape → portrait) cancels to the committed page', () => {
    const fixture = book();
    const app = fixture.book;
    expect(app.getOrientation()).toBe('landscape');
    expect(app.getCurrentPageIndex()).toBe(0);

    const flips: number[] = [];
    app.on('flip', (e) => flips.push(e.data.page));

    startForwardDrag(app);
    expect(testFlip(app)?.getCalculation()).not.toBeNull();
    expect(app.getState()).toBe(FlippingState.USER_FOLD);

    const beforePage = app.getCurrentPageIndex();
    const beforeRect = app.getBoundsRect();

    resizeHost(fixture, 260);

    expect(app.getOrientation()).toBe('portrait');
    expect(app.getBoundsRect()).not.toEqual(beforeRect);
    expect(app.getCurrentPageIndex()).toBe(beforePage);
    expect(flips).toEqual([]);
    expect(app.getState()).toBe(FlippingState.READ);
    expect(testFlip(app)?.getCalculation() ?? null).toBeNull();
    expect(cloneCount(app, fixture.pages)).toBe(0);
    expect(app.isAnimating()).toBe(false);
  });

  test('orientation flip mid-turn during a BACK drag also stays on the committed page', () => {
    const fixture = book();
    const app = fixture.book;
    app.turnToPage(2);
    expect(app.getCurrentPageIndex()).toBe(2);

    const flips: number[] = [];
    app.on('flip', (e) => flips.push(e.data.page));

    startBackDrag(app);
    expect(testFlip(app)?.getCalculation()).not.toBeNull();

    resizeHost(fixture, 260);

    expect(app.getOrientation()).toBe('portrait');
    expect(app.getCurrentPageIndex()).toBe(2);
    expect(flips).toEqual([]);
    expect(testFlip(app)?.getCalculation() ?? null).toBeNull();
    expect(cloneCount(app, fixture.pages)).toBe(0);
  });

  test('same-orientation width change mid-drag cancels without advancing', () => {
    const fixture = book();
    const app = fixture.book;
    startForwardDrag(app);
    const before = app.getCurrentPageIndex();
    const beforeRect = app.getBoundsRect();

    // 480 is still landscape (fixed 200px pages need 400px for two leaves).
    resizeHost(fixture, 480);

    expect(app.getOrientation()).toBe('landscape');
    expect(app.getBoundsRect()).not.toEqual(beforeRect);
    expect(app.getCurrentPageIndex()).toBe(before);
    expect(app.getState()).toBe(FlippingState.READ);
    expect(testFlip(app)?.getCalculation() ?? null).toBeNull();
  });

  test('responsive same-orientation resize changes pageWidth and still cancels', () => {
    const fixture = book({
      sizing: 'responsive',
      minWidth: 100,
      maxWidth: 400,
      minHeight: 100,
      maxHeight: 500,
      hostWidth: 520,
      hostHeight: 400,
    });
    const app = fixture.book;
    expect(app.getOrientation()).toBe('landscape');
    const beforeWidth = app.getBoundsRect().pageWidth;
    expect(beforeWidth).toBeGreaterThan(200);

    startForwardDrag(app);
    expect(testFlip(app)?.getCalculation()).not.toBeNull();

    resizeHost(fixture, 480, 400);

    expect(app.getOrientation()).toBe('landscape');
    expect(app.getBoundsRect().pageWidth).not.toBe(beforeWidth);
    expect(app.getState()).toBe(FlippingState.READ);
    expect(testFlip(app)?.getCalculation() ?? null).toBeNull();
    expect(app.getCurrentPageIndex()).toBe(0);
  });

  test('orientation-changing resize does not throw if a listener destroys', () => {
    const fixture = book();
    const app = fixture.book;
    startForwardDrag(app);
    app.on('changeState', () => {
      if (!app.isDestroyed()) app.destroy();
    });

    expect(() => resizeHost(fixture, 260)).not.toThrow();
    expect(app.isDestroyed()).toBe(true);
  });

  test('a listener that starts a new turn after cancel sees the adopted pageWidth', () => {
    const fixture = book({
      sizing: 'responsive',
      flippingTime: 0,
      minWidth: 100,
      maxWidth: 400,
      minHeight: 100,
      maxHeight: 500,
      hostWidth: 520,
      hostHeight: 400,
    });
    const app = fixture.book;
    startForwardDrag(app);

    let nested = false;
    app.on('changeState', (e) => {
      if (e.data.state === FlippingState.READ && !nested && !app.isDestroyed()) {
        nested = true;
        app.flipNext();
      }
    });

    resizeHost(fixture, 480, 400);

    expect(app.isDestroyed()).toBe(false);
    expect(app.getCurrentPageIndex()).toBe(2);
    expect(app.getBoundsRect().pageWidth).toBe(240);
  });

  test('nested flipNext during orientation-changing resize uses the portrait step', () => {
    const fixture = book({ flippingTime: 0 });
    const app = fixture.book;
    expect(app.getOrientation()).toBe('landscape');
    startForwardDrag(app);

    let nested = false;
    app.on('changeState', (e) => {
      if (e.data.state === FlippingState.READ && !nested && !app.isDestroyed()) {
        nested = true;
        expect(app.flipNext()).toBe(true);
      }
    });

    resizeHost(fixture, 260);

    expect(app.getOrientation()).toBe('portrait');
    // Landscape next from 0 is spread [0,1]→[2,3]. Portrait next is 0→1.
    expect(app.getCurrentPageIndex()).toBe(1);
  });

  test('programmed animation: resize cancels and a stale completion cannot commit', () => {
    const queued = stubRafQueue();
    const fixture = book({ flippingTime: 1000, respectReducedMotion: false });
    const app = fixture.book;
    // Rest-state draw stamps `Render.timer` so startAnimation's startedAt is
    // in the past. Do not flush while a fold is live (jsdom clip-path overflow).
    flushQueuedRaf(queued, 0);

    const flips: number[] = [];
    app.on('flip', (e) => flips.push(e.data.page));

    expect(app.flipNext()).toBe(true);
    expect(app.isAnimating()).toBe(true);
    expect(queued.length, 'flipNext never scheduled a frame').toBeGreaterThan(0);

    resizeHost(fixture, 260);

    expect(app.getCurrentPageIndex()).toBe(0);
    expect(flips).toEqual([]);
    expect(app.getState()).toBe(FlippingState.READ);
    expect(app.isAnimating()).toBe(false);

    // The loop callback queued while the turn was live. If cancel left
    // `this.animation` in place, 1s+ overshoots flippingTime and onAnimateEnd
    // would commit. `app.update()` is not those callbacks.
    flushQueuedRaf(queued, 1_000_000);
    expect(app.getCurrentPageIndex()).toBe(0);
    expect(flips).toEqual([]);
    expect(app.getState()).toBe(FlippingState.READ);
  });

  test('snap-back in flight: resize cancels the return animation without a flip', () => {
    const queued = stubRafQueue();
    const fixture = book({ flippingTime: 1000, respectReducedMotion: false });
    const app = fixture.book;
    flushQueuedRaf(queued, 0);

    const rect = app.getBoundsRect();
    const y = rect.top + rect.height - 8;
    pointer(app, 'pointerdown', { clientX: rect.left + rect.width - 6, clientY: y });
    pointer(app, 'pointermove', { clientX: rect.left + rect.width - 40, clientY: y });
    expect(testFlip(app)?.getCalculation()).not.toBeNull();

    testFlip(app)?.stopMove();
    expect(app.isAnimating()).toBe(true);
    expect(queued.length, 'stopMove never scheduled a frame').toBeGreaterThan(0);

    const flips: number[] = [];
    app.on('flip', (e) => flips.push(e.data.page));

    resizeHost(fixture, 480);

    expect(app.getCurrentPageIndex()).toBe(0);
    expect(flips).toEqual([]);
    expect(app.getState()).toBe(FlippingState.READ);
    expect(app.isAnimating()).toBe(false);
    expect(testFlip(app)?.getCalculation() ?? null).toBeNull();

    flushQueuedRaf(queued, 1_000_000);
    expect(app.getCurrentPageIndex()).toBe(0);
    expect(flips).toEqual([]);
    expect(app.getState()).toBe(FlippingState.READ);
  });

  test('zero-sized hide/reveal keeps the last bounds and does not cancel at rest', () => {
    const fixture = book();
    const app = fixture.book;
    const restFlips: number[] = [];
    app.on('flip', (e) => restFlips.push(e.data.page));
    const before = app.getBoundsRect();

    resizeHost(fixture, 0, 0);

    expect(app.getOrientation()).toBe('landscape');
    expect(app.getBoundsRect().pageWidth).toBe(before.pageWidth);
    expect(restFlips).toEqual([]);
    expect(app.getState()).toBe(FlippingState.READ);

    resizeHost(fixture, 520, 300);
    expect(app.getOrientation()).toBe('landscape');
    expect(app.getCurrentPageIndex()).toBe(0);
    expect(restFlips).toEqual([]);
  });

  test('pointercancel mid-drag then a bounds change still cannot commit later', () => {
    const queued = stubRafQueue();
    const fixture = book({ flippingTime: 1000, respectReducedMotion: false });
    const app = fixture.book;
    flushQueuedRaf(queued, 0);

    startForwardDrag(app);
    expect(testFlip(app)?.getCalculation()).not.toBeNull();

    const rect = app.getBoundsRect();
    pointer(app, 'pointercancel', {
      clientX: rect.left + rect.width - 120,
      clientY: rect.top + rect.height - 8,
    });

    expect(app.getState()).toBe(FlippingState.READ);
    expect(testFlip(app)?.getCalculation() ?? null).toBeNull();

    const flips: number[] = [];
    app.on('flip', (e) => flips.push(e.data.page));

    resizeHost(fixture, 260);
    flushQueuedRaf(queued, 1_000_000);

    expect(app.getCurrentPageIndex()).toBe(0);
    expect(flips).toEqual([]);
    expect(app.getState()).toBe(FlippingState.READ);
  });

  test('at-rest orientation-preserving observer resize stays silent', () => {
    const fixture = book();
    const app = fixture.book;
    app.turnToPage(2);
    const flips: number[] = [];
    app.on('flip', (e) => flips.push(e.data.page));

    resizeHost(fixture, 500);

    expect(app.getOrientation()).toBe('landscape');
    expect(app.getCurrentPageIndex()).toBe(2);
    expect(flips).toEqual([]);
    expect(app.getState()).toBe(FlippingState.READ);
  });
});

describe('F02 — visualViewport that does not change container bounds', () => {
  test('is silent at rest', () => {
    installVisualViewport();
    const fixture = book();
    expect(visualViewportListeners.length).toBeGreaterThan(0);

    const app = fixture.book;
    const flips: number[] = [];
    app.on('flip', (e) => flips.push(e.data.page));
    const before = app.getBoundsRect();

    for (const cb of visualViewportListeners) cb();

    expect(app.getBoundsRect()).toEqual(before);
    expect(flips).toEqual([]);
    expect(app.getState()).toBe(FlippingState.READ);
  });

  test('is a no-op mid-drag: the fold stays live', () => {
    installVisualViewport();
    const fixture = book();
    const app = fixture.book;
    startForwardDrag(app);
    expect(testFlip(app)?.getCalculation()).not.toBeNull();

    const flips: number[] = [];
    app.on('flip', (e) => flips.push(e.data.page));
    const before = app.getBoundsRect();

    for (const cb of visualViewportListeners) cb();

    expect(app.getBoundsRect()).toEqual(before);
    expect(flips).toEqual([]);
    expect(testFlip(app)?.getCalculation()).not.toBeNull();
    expect(app.getState()).toBe(FlippingState.USER_FOLD);
  });
});
