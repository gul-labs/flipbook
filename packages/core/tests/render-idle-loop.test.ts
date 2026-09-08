/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * R8 — the render loop parks when there is nothing to draw, **and wakes for
 * everything that can make there be something**.
 *
 * `render-loop.test.ts` drives `Render` directly through a stub app; this file
 * drives a REAL `PageFlip` in jsdom, because the interesting half of R8 is not
 * the parking (three lines) but the wake-up paths, and those run through `UI`,
 * `Flip` and `PageCollection` — none of which know the scheduler exists. A test
 * that called `render.requestFrame()` itself would prove nothing about them.
 *
 * The dangerous failure is the inverse of the one being fixed: a book that
 * stops drawing and never restarts is far worse than one that draws forever.
 * So every test here is written as "park, then prove this specific input brings
 * it back", and the parked state is asserted first — an assertion that a frame
 * was scheduled is vacuous if one was pending anyway.
 *
 * jsdom has no `ResizeObserver` and no `visualViewport`, so the resize tests
 * install their own before the book is built and drive the real handler.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ADOPT_ORIENTATION, GET_UI, INVALIDATE_FOLD_GEOMETRY } from '../src/internal';

import { PageFlip } from '@gullabs/flipbook-core';
import { Render } from '../src/Render/Render';
import type { PageFlip as PageFlipType } from '../src/PageFlip';
import { Settings, type FlipSetting } from '../src/Settings';
import { testRender } from './engine-access';
import {
  installPointerCaptureShims,
  makeHtmlBook,
  makePages,
  sizeElement,
} from './html-book-fixture';

/* ------------------------------------------------------------------ *
 * A hand-driven requestAnimationFrame
 * ------------------------------------------------------------------ */

let queue: Array<(timer: number) => void> = [];
let clock = 0;
let realRaf: typeof globalThis.requestAnimationFrame;
let realCancel: typeof globalThis.cancelAnimationFrame;
let resizeObservers: Array<() => void> = [];

/** Is a frame currently scheduled? */
function scheduled(): boolean {
  return queue.length > 0;
}

/** Run every scheduled frame once, 16 ms apart. Returns how many ran. */
function runFrames(limit = 1): number {
  let ran = 0;

  while (queue.length > 0 && ran < limit) {
    const frame = queue.shift();
    clock += 16;
    ran += 1;
    frame?.(clock);
  }

  return ran;
}

/**
 * Run frames until the loop stops asking for more.
 *
 * `limit` is the negative control: against the unfixed engine the loop re-arms
 * unconditionally, so this never converges and returns `limit`.
 */
function settle(limit = 200): number {
  let ran = 0;

  while (queue.length > 0 && ran < limit) ran += runFrames(1);

  return ran;
}

class FakeResizeObserver {
  public constructor(private readonly cb: () => void) {
    resizeObservers.push(() => {
      this.cb();
    });
  }
  public observe(): void {
    /* the element does not matter here; the callback is invoked directly */
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

  queue = [];
  resizeObservers = [];
  clock = 0;

  realRaf = globalThis.requestAnimationFrame;
  realCancel = globalThis.cancelAnimationFrame;

  globalThis.requestAnimationFrame = ((cb: (timer: number) => void): number => {
    queue.push(cb);
    return queue.length;
  }) as typeof globalThis.requestAnimationFrame;

  globalThis.cancelAnimationFrame = (() => {
    // Deliberately inert: a browser cannot cancel a callback it has already
    // dispatched, and R3 allows the API to be missing entirely. The generation
    // guard, not the cancel, is what must hold.
  }) as typeof globalThis.cancelAnimationFrame;
});

afterEach(() => {
  while (books.length) books.pop()?.destroy();
  globalThis.requestAnimationFrame = realRaf;
  globalThis.cancelAnimationFrame = realCancel;
  Reflect.deleteProperty(globalThis, 'ResizeObserver');
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/**
 * A settled book: loaded, drawn, and asking for no further frames.
 *
 * `flippingTime` is never 0 here — an instant turn commits synchronously inside
 * `startAnimation` and never reaches the loop this file is about.
 */
function settledBook(opts: Parameters<typeof makeHtmlBook>[0] = {}): PageFlip {
  const b = makeHtmlBook({ pageCount: 6, flippingTime: 1000, ...opts });
  books.push(b);

  const ran = settle();

  // FIXTURE CHECK, and the C1 assertion itself: the loop converged. Against the
  // unfixed engine this is 200 — `settle`'s limit — because `loop` re-arms'
  // whether or not anything changed.
  expect(ran).toBeLessThan(20);
  expect(scheduled()).toBe(false);

  return b.book;
}

/** Dispatch one pointer event on the engine's own dist element. */
function pointer(
  book: PageFlip,
  type: string,
  init: PointerEventInit & { clientX: number; clientY: number },
): void {
  book.getBlockElement().dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      button: 0,
      pointerType: 'mouse',
      ...init,
    }),
  );
}

describe('R8 — an untouched book stops drawing', () => {
  test('a loaded, idle book converges and asks for no more frames', () => {
    const book = settledBook();

    // Not just "no frame pending": nothing has scheduled one on the way out
    // either, and the book is still alive and answerable.
    expect(scheduled()).toBe(false);
    expect(book.getCurrentPageIndex()).toBe(0);
  });

  test('the parked loop is genuinely parked, not stopped', () => {
    // The distinction matters: `stop()` is teardown and cannot be resumed by a
    // state change, a park must be. Anything below would fail if parking had
    // been implemented as `stop()`.
    const book = settledBook();

    testRender(book).update();

    expect(scheduled()).toBe(true);
  });
});

describe('R8 — every wake-up path', () => {
  test('a programmatic turn wakes it, and the turn completes', () => {
    const book = settledBook();

    expect(book.flipNext()).toBe(true);
    expect(scheduled()).toBe(true);

    const ran = settle();
    expect(ran).toBeGreaterThan(1);
    // The turn actually committed — the loop stayed awake for the whole
    // animation, which is the thing a too-eager park would break.
    expect(book.getCurrentPageIndex()).toBeGreaterThan(0);
    expect(scheduled()).toBe(false);
  });

  test('a drag wakes it on every pointer move', () => {
    const book = settledBook();
    const rect = book.getBoundsRect();
    const x = rect.left + rect.width - 8;
    const y = rect.top + 12;

    pointer(book, 'pointerdown', { clientX: x, clientY: y });
    // `pointerdown` alone changes no renderer state; the fold starts on the
    // first move past the 5 px threshold.
    settle();
    expect(scheduled()).toBe(false);

    pointer(book, 'pointermove', { clientX: x - 60, clientY: y + 10, buttons: 1 });
    expect(scheduled()).toBe(true);
    settle();

    // …and again for the next move, from a parked state.
    pointer(book, 'pointermove', { clientX: x - 90, clientY: y + 14, buttons: 1 });
    expect(scheduled()).toBe(true);

    settle();
    pointer(book, 'pointerup', { clientX: x - 90, clientY: y + 14 });
    expect(scheduled()).toBe(true);
  });

  test('a corner hover wakes it', () => {
    const book = settledBook({ foldCornerOnHover: true });
    const rect = book.getBoundsRect();

    pointer(book, 'pointermove', {
      clientX: rect.left + rect.width - 4,
      clientY: rect.top + 4,
      buttons: 0,
    });

    expect(scheduled()).toBe(true);
  });

  test('a ResizeObserver callback wakes it', () => {
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;

    const book = settledBook();
    expect(resizeObservers.length).toBeGreaterThan(0);
    void book;

    for (const fire of resizeObservers) fire();

    expect(scheduled()).toBe(true);
  });

  test('the window-resize fallback wakes it where ResizeObserver is missing', () => {
    // jsdom has no `ResizeObserver`, so this is the path `UI.observeResize`
    // actually takes here — and the one every older WebView takes.
    expect(typeof ResizeObserver).toBe('undefined');

    const book = settledBook();
    void book;

    window.dispatchEvent(new Event('resize'));

    expect(scheduled()).toBe(true);
  });

  test('a visualViewport resize wakes it', () => {
    const listeners: Array<() => void> = [];
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        addEventListener: (_type: string, cb: () => void) => listeners.push(cb),
        removeEventListener: () => undefined,
      },
    });

    try {
      const book = settledBook();
      void book;
      expect(listeners.length).toBeGreaterThan(0);

      for (const cb of listeners) cb();

      expect(scheduled()).toBe(true);
    } finally {
      Reflect.deleteProperty(window, 'visualViewport');
    }
  });

  test('an orientation change wakes it', () => {
    const book = settledBook({ width: 200, height: 300, hostWidth: 380, usePortrait: true });
    const before = book.getOrientation();

    // Widen past two page widths: landscape. `UI.setOrientationStyle` →
    // `UI.update()` → `Render.update()` is the path under test.
    const dist = book.getBlockElement();
    Object.defineProperty(dist, 'offsetWidth', { configurable: true, get: () => 900 });
    testRender(book).update();

    expect(book.getOrientation()).not.toBe(before);
    expect(scheduled()).toBe(true);
  });

  test('replacing the pages wakes it', () => {
    const book = settledBook();

    book.updateFromHtml(makePages(4));

    expect(scheduled()).toBe(true);
    settle();
    expect(book.getPageCount()).toBe(4);
  });

  test('emptying the book wakes it', () => {
    // The `pageCount === 0` branch takes `releasePages()` instead of `show()`,
    // so it is a different wake-up path from the one above.
    const book = settledBook();

    book.clear();

    expect(scheduled()).toBe(true);
  });

  test('an INSTANT turn wakes it, and the committed spread is painted', () => {
    // `flippingTime: 0` commits synchronously inside `startAnimation`, so there
    // is no animation left for the loop to notice — the wake has to come from
    // the commit itself. This is the path `prefers-reduced-motion` takes, and
    // the one where a scheduler keyed on "is an animation running" paints
    // nothing at all.
    const book = settledBook({ flippingTime: 0 });

    expect(book.flipNext()).toBe(true);
    expect(book.getCurrentPageIndex()).toBeGreaterThan(0);
    expect(scheduled()).toBe(true);

    const render = testRender(book) as unknown as { drawFrame: () => void };
    let draws = 0;
    const realDraw = render.drawFrame.bind(render);
    render.drawFrame = (): void => {
      draws += 1;
      realDraw();
    };

    settle();
    expect(draws).toBeGreaterThan(0);
  });

  test('updateSettings wakes it', () => {
    const book = settledBook();

    book.updateSettings({ width: 220 });

    expect(scheduled()).toBe(true);
  });

  test('PageFlip.update() wakes it', () => {
    const book = settledBook();

    book.update();

    expect(scheduled()).toBe(true);
  });
});

describe('R8 — the loop must not park one frame early', () => {
  test('the frame that ends a turn is drawn before the loop parks', () => {
    const book = settledBook();
    const render = testRender(book) as unknown as { drawFrame: () => void };

    // ONE trace for both, because the ordering is the assertion. Counting
    // draws separately proves nothing: the broken variants draw plenty of
    // frames, they just stop before the last one.
    const trace: string[] = [];
    const realDraw = render.drawFrame.bind(render);
    render.drawFrame = (): void => {
      trace.push('draw');
      realDraw();
    };
    book.on('flip', () => trace.push('commit'));

    book.flipNext();
    settle();

    expect(trace.filter((e) => e === 'commit')).toHaveLength(1);

    // The turn's landing geometry is painted AFTER the commit. A loop that
    // parks the moment the animation ends — before the trailing `drawFrame`,
    // or before the extra frame the committed state asks for — ends this trace
    // on 'commit', and the reader is left looking at the pre-turn spread until
    // they touch the book again.
    expect(trace[trace.length - 1]).toBe('draw');
    expect(trace.lastIndexOf('draw')).toBeGreaterThan(trace.indexOf('commit'));
    expect(scheduled()).toBe(false);
  });
});

describe('R8 — a stopped loop stays stopped', () => {
  test('destroy() cannot be undone by a late frame request', () => {
    const b = makeHtmlBook({ pageCount: 4, flippingTime: 1000 });
    settle();

    const render = testRender(b.book);
    b.book.destroy();
    queue = [];

    // A stale caller holding the render — an async consumer, a pending effect.
    // Reached through a cast because `requestFrame` is deliberately protected:
    // this is the engine's own scheduler, not published surface.
    (render as unknown as { requestFrame: () => void }).requestFrame();

    expect(scheduled()).toBe(false);

    b.host.remove();
  });
});

/* ------------------------------------------------------------------ *
 * Canvas mode: the one renderer that must NOT park
 * ------------------------------------------------------------------ */

class ProbeRender extends Render {
  public frameDraws = 0;

  public constructor(app: PageFlipType, setting: FlipSetting, element: HTMLElement) {
    super(app, setting, element);
  }

  protected drawFrame(): void {
    this.frameDraws += 1;
  }

  public reload(): void {
    /* nothing */
  }
}

function probeOn(dist: HTMLElement): ProbeRender {
  const setting = new Settings().resolve({ width: 200, height: 300 });
  Object.defineProperty(dist, 'offsetWidth', { configurable: true, get: () => 400 });
  Object.defineProperty(dist, 'offsetHeight', { configurable: true, get: () => 300 });

  const app = {
    [GET_UI]: () => ({ getDistElement: () => dist }),
    getSettings: () => setting,
    [ADOPT_ORIENTATION]: () => undefined,
    [INVALIDATE_FOLD_GEOMETRY]: () => undefined,
    isDestroyed: () => false,
  } as unknown as PageFlipType;

  return new ProbeRender(app, setting, dist);
}

describe('R8 — an idle HTML renderer parks', () => {
  test('an HTML dist element parks after the first frame', () => {
    const render = probeOn(document.createElement('div'));

    render.start();
    const ran = settle();

    expect(ran).toBe(1);
    expect(scheduled()).toBe(false);
  });

  test('needsContinuousFrames is false even for a canvas dist element', () => {
    // Hostile variant: the removed predicate was `dist instanceof HTMLCanvasElement`.
    // A div fixture would pass against that regression; a canvas fixture fails it.
    const render = probeOn(document.createElement('canvas'));
    expect(
      (render as unknown as { needsContinuousFrames: () => boolean }).needsContinuousFrames(),
    ).toBe(false);
  });
});

/**
 * Codex round 8 fresh findings — one frame action per frame index, and a
 * teardown that only undoes its own work.
 */
describe('a frame action runs at most once per frame index', () => {
  test('several ticks landing on the same index replay nothing', () => {
    const book = settledBook();
    const render = testRender(book);
    const played: number[] = [];

    render.startAnimation([() => played.push(0), () => played.push(1)], 1000, () => {
      /* no commit */
    });

    // Two frames over 1000 ms is a 500 ms frame, so 0 ms and 100 ms both round
    // to index 0. Reverted fix: [0, 0] — `lastPlayedIndex` guarded the
    // overshoot and forced-commit paths and not the ordinary one, so the
    // invariant its own docblock states was only half true.
    runFrames();
    clock += 100;
    runFrames();
    expect(played).toEqual([0]);

    // …and a later index still plays, so this is a dedupe and not a freeze.
    clock += 400;
    runFrames();
    expect(played).toEqual([0, 1]);

    book.destroy();
  });
});

describe('destroy() hands the host back unchanged', () => {
  function hostEl(): HTMLElement {
    const host = document.createElement('div');
    document.body.appendChild(host);
    sizeElement(host, 400, 300);
    return host;
  }

  test('a caller-owned `stf__parent` class survives teardown', () => {
    const host = hostEl();
    // The consumer styles their own container with the class — or mounts two
    // books through one wrapper.
    host.classList.add('stf__parent');

    const engine = new PageFlip(host, { width: 200, height: 300 });
    engine.loadFromHTML(makePages(4));
    engine.destroy();

    // Reverted fix: removed unconditionally, so a teardown that is only
    // supposed to undo its OWN work stripped a class the caller owns.
    expect(host.classList.contains('stf__parent')).toBe(true);
    host.remove();
  });

  test('the class the engine added is still removed', () => {
    const host = hostEl();
    const engine = new PageFlip(host, { width: 200, height: 300 });
    engine.loadFromHTML(makePages(4));
    expect(host.classList.contains('stf__parent')).toBe(true);

    engine.destroy();

    // The control: a guard that never removes would satisfy the test above.
    expect(host.classList.contains('stf__parent')).toBe(false);
    host.remove();
  });

  test('the consumer\u2019s `display` is not clobbered, at construction or on update', () => {
    const host = hostEl();
    host.style.display = 'flex';

    const engine = new PageFlip(host, { width: 200, height: 300 });
    engine.loadFromHTML(makePages(4));

    // Reverted fix: `applyHostSize` wrote `display: block` inline — redundant,
    // since `.stf__parent` already declares it, and unbeatable, since an inline
    // style outranks the consumer's own stylesheet where the class does not.
    expect(host.style.display).toBe('flex');

    // …and again on every runtime settings change, which is what made it
    // impossible to set afterwards either.
    engine.updateSettings({ width: 250 });
    expect(host.style.display).toBe('flex');

    engine.destroy();
    host.remove();
  });
});
