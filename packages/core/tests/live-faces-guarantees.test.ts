/**
 * PB-11 — live-text highlight guarantees (G1–G6) and the video fold copy.
 *
 * Each assertion calls the shipped engine. A test that rebuilt cloneNode
 * itself would stay green if Page.newTemporaryCopy stopped copying data-*.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FlippingState } from '@gullabs/flipbook-core';
import { installPointerCaptureShims, makeHtmlBook } from './html-book-fixture';
import { Page } from '../src/Page/Page';
import { testFlip, testPage, testRender } from './engine-access';
import { isInteractivePointerTarget } from '../src/interactive';

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
  const b = makeHtmlBook(opts);
  books.push(b);
  return b;
}

function pointer(
  type: string,
  target: EventTarget,
  x: number,
  y: number,
  pointerType: 'mouse' | 'touch' | 'pen' = 'mouse',
): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      pointerType,
      clientX: x,
      clientY: y,
    }),
  );
}

function dragToFold(
  app: ReturnType<typeof book>['book'],
  pointerType: 'mouse' | 'touch' | 'pen' = 'mouse',
) {
  const dist = app.getBlockElement();
  const rect = app.getBoundsRect();
  const y = rect.top + rect.height - 8;
  pointer('pointerdown', dist, rect.left + rect.width - 6, y, pointerType);
  pointer('pointermove', dist, rect.left + rect.width - 40, y, pointerType);
  pointer('pointermove', dist, rect.left + rect.width - 120, y, pointerType);
}

describe('G1 — clone preserves every data-* at clone time', () => {
  test('nested data attributes on the original equal the clone at copy time', () => {
    const { book: app, pages } = book({ pageCount: 4, flippingTime: 0 });
    pages[0]!.innerHTML =
      '<p data-block="1"><span data-token-id="0/1/L2" data-reading="1">line</span></p>';
    pages[0]!.dataset.leaf = 'cover';
    app.updateFromHtml(pages);

    const page = testPage(app, 0) as Page;
    const clone = page.newTemporaryCopy().getElement();
    const originalSpan = pages[0]!.querySelector('span')!;
    const cloneSpan = clone.querySelector('span')!;

    for (const name of originalSpan.getAttributeNames().filter((n) => n.startsWith('data-'))) {
      expect(cloneSpan.getAttribute(name)).toBe(originalSpan.getAttribute(name));
    }
    expect(clone.dataset.leaf).toBe('cover');
    page.hideTemporaryCopy();
  });
});

describe('G2 — engine does not rewrite clone-descendant attributes', () => {
  test('a data-reading set mid-flip survives until the clone is removed', () => {
    const { book: app, pages } = book({ pageCount: 4, flippingTime: 0 });
    pages[0]!.innerHTML = '<span data-token-id="0/1/L1">line</span>';
    app.updateFromHtml(pages);

    const page = testPage(app, 0) as Page;
    const clone = page.newTemporaryCopy().getElement();
    const span = clone.querySelector('span')!;
    span.setAttribute('data-reading', '1');
    span.setAttribute('aria-current', 'true');

    page.draw();
    expect(span.getAttribute('data-reading')).toBe('1');
    expect(span.getAttribute('aria-current')).toBe('true');
    expect(clone.getAttribute('data-stf-clone')).toBe('');

    page.hideTemporaryCopy();
    expect(clone.isConnected).toBe(false);
  });
});

describe('G3 — clone shares the container and leaves on turn end and cancel', () => {
  test('querySelectorAll sees two tokens during the fold and one after read', () => {
    const { book: app, pages } = book({ pageCount: 4, flippingTime: 0, foldCornerOnHover: false });
    pages[0]!.innerHTML = '<span data-token-id="x">line</span>';
    app.updateFromHtml(pages);

    const container = app.getBlockElement();
    expect(container.querySelectorAll('[data-token-id="x"]')).toHaveLength(1);

    dragToFold(app);
    expect(app.getState()).not.toBe(FlippingState.READ);
    expect(container.querySelectorAll('[data-token-id="x"]')).toHaveLength(2);

    const rect = app.getBoundsRect();
    pointer('pointerup', container, rect.left + 4, rect.top + rect.height - 8);
    expect(app.getState()).toBe(FlippingState.READ);
    expect(container.querySelectorAll('[data-token-id="x"]')).toHaveLength(1);
  });

  test('cancelTurn removes the clone', () => {
    const { book: app, pages } = book({
      pageCount: 4,
      flippingTime: 800,
      foldCornerOnHover: false,
    });
    pages[0]!.innerHTML = '<span data-token-id="x">line</span>';
    app.updateFromHtml(pages);
    const container = app.getBlockElement();

    dragToFold(app);
    expect(container.querySelectorAll('[data-stf-clone]')).toHaveLength(1);
    expect(app.cancelTurn()).toBe(true);
    expect(app.getState()).toBe(FlippingState.READ);
    expect(container.querySelectorAll('[data-stf-clone]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-token-id="x"]')).toHaveLength(1);
  });
});

describe('G4 — a plain span is a turn surface, not an interactive control', () => {
  test.each(['mouse', 'touch', 'pen'] as const)(
    '%s hit on a span starts a turn when interactive content is not respected',
    (pointerType) => {
      const { book: app, pages } = book({
        pageCount: 4,
        flippingTime: 0,
        respectInteractiveContent: false,
        flipOnClick: 'anywhere',
        foldCornerOnHover: false,
      });
      const span = document.createElement('span');
      span.textContent = 'words';
      pages[0]!.appendChild(span);
      app.updateFromHtml(pages);

      const rect = app.getBoundsRect();
      pointer('pointerdown', span, rect.left + rect.width - 8, rect.top + 8, pointerType);
      pointer('pointermove', span, rect.left + rect.width - 80, rect.top + 8, pointerType);
      expect(app.getState()).toBe(FlippingState.USER_FOLD);
    },
  );

  test('respectInteractiveContent does not treat a plain span as interactive', () => {
    const span = document.createElement('span');
    expect(isInteractivePointerTarget(span)).toBe(false);

    const { book: app, pages } = book({
      pageCount: 4,
      flippingTime: 0,
      respectInteractiveContent: true,
      flipOnClick: 'anywhere',
      foldCornerOnHover: false,
    });
    pages[0]!.appendChild(span);
    app.updateFromHtml(pages);
    const rect = app.getBoundsRect();
    pointer('pointerdown', span, rect.left + rect.width - 8, rect.top + 8);
    pointer('pointermove', span, rect.left + rect.width - 80, rect.top + 8);
    expect(app.getState()).toBe(FlippingState.USER_FOLD);
  });
});

describe('G5 — engine stylesheet does not re-enable selection', () => {
  test('block rule keeps user-select and touch-callout none, including on the clone', () => {
    const { book: app, pages } = book({ pageCount: 4, flippingTime: 0 });
    pages[0]!.innerHTML = '<span>story</span>';
    app.updateFromHtml(pages);
    const page = testPage(app, 0) as Page;
    const clone = page.newTemporaryCopy().getElement();
    const block = app.getBlockElement();

    const sheet = [...document.querySelectorAll('style')]
      .map((node) => node.textContent ?? '')
      .join('');
    expect(sheet).toContain('user-select:none');
    expect(sheet).toContain('-webkit-touch-callout:none');
    expect(sheet).not.toContain('user-select:text');

    expect(block.contains(clone)).toBe(true);
    expect(clone.style.userSelect).not.toBe('text');
    page.hideTemporaryCopy();
  });
});

describe('G6 — changeState brackets the clone', () => {
  function watch(app: ReturnType<typeof book>['book']) {
    const order: string[] = [];
    app.on('changeState', ({ data }) => {
      const clones = app.getBlockElement().querySelectorAll('[data-stf-clone]').length;
      order.push(`${data.state}:${clones}`);
    });
    return order;
  }

  test('a completed drag announces user_fold before the clone and read after removal', () => {
    const { book: app, pages } = book({ pageCount: 4, flippingTime: 0, foldCornerOnHover: false });
    pages[0]!.innerHTML = '<span data-token-id="x">line</span>';
    app.updateFromHtml(pages);
    const order = watch(app);

    dragToFold(app);
    const rect = app.getBoundsRect();
    pointer('pointerup', app.getBlockElement(), rect.left + 4, rect.top + rect.height - 8);

    expect(order[0]).toBe('user_fold:0');
    expect(order[order.length - 1]).toBe('read:0');
    expect(app.getBlockElement().querySelector('[data-stf-clone]')).toBeNull();
  });

  // PB-11 G6 asks for `read` after the clone is removed on BOTH paths. A
  // cancelled fold face has nothing left to clear once it is gone, and keeping
  // it through the listener let a turn chained from that `read` lose its own
  // copy (see the chaining tests below).
  test('cancelTurn announces read after the clone is removed', () => {
    const { book: app, pages } = book({
      pageCount: 4,
      flippingTime: 800,
      foldCornerOnHover: false,
    });
    pages[0]!.innerHTML = '<span data-token-id="x">line</span>';
    app.updateFromHtml(pages);
    const order = watch(app);

    // Synchronous frames for the whole drag, so the clone has been drawn and
    // booked in the renderer's shown set before the cancel.
    const realRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (cb) => {
      cb(0);
      return 1;
    };
    try {
      dragToFold(app);
      expect(app.getBlockElement().querySelector('[data-stf-clone]')).not.toBeNull();
      expect(app.cancelTurn()).toBe(true);
    } finally {
      globalThis.requestAnimationFrame = realRaf;
    }

    expect(order).toEqual(['user_fold:0', 'read:0']);
    expect(app.getBlockElement().querySelectorAll('[data-stf-clone]')).toHaveLength(0);
  });

  test('flipNext announces flipping before the clone, and a cancel before any frame removes it', () => {
    const { book: app, pages } = book({
      pageCount: 4,
      flippingTime: 800,
      foldCornerOnHover: false,
    });
    pages[0]!.innerHTML = '<span data-token-id="x">line</span>';
    app.updateFromHtml(pages);
    const order = watch(app);

    expect(app.flipNext()).toBe(true);
    expect(app.getBlockElement().querySelector('[data-stf-clone]')).not.toBeNull();
    expect(app.cancelTurn()).toBe(true);
    expect(order).toEqual(['flipping:0', 'read:0']);
    expect(app.getBlockElement().querySelector('[data-stf-clone]')).toBeNull();
  });
});

/** Own the rAF queue so a turn can be stopped between two specific frames. */
function installRafQueue(): { flush: (ticks?: number) => void; restore: () => void } {
  const queued: FrameRequestCallback[] = [];
  const realRaf = globalThis.requestAnimationFrame;
  const realCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    queued.push(cb);
    return queued.length;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {
    queued.length = 0;
  }) as typeof globalThis.cancelAnimationFrame;
  let clock = 0;
  return {
    flush(ticks = 200) {
      for (let i = 0; i < ticks && queued.length > 0; i += 1) {
        const batch = queued.splice(0, queued.length);
        clock += 16;
        for (const cb of batch) cb(clock);
      }
    },
    restore() {
      globalThis.requestAnimationFrame = realRaf;
      globalThis.cancelAnimationFrame = realCancel;
    },
  };
}

/** The mover the running turn draws: the element the reader actually sees fold. */
function moverElement(app: ReturnType<typeof book>['book']): HTMLElement | null {
  // Private slot, read-only: the turn's own mover, not a DOM query that a
  // stale detached clone could satisfy.
  const flip = testFlip(app) as unknown as { flippingPage: Page | null } | null;
  return flip?.flippingPage?.getElement() ?? null;
}

describe('a turn chained onto a finished portrait turn keeps its own copy', () => {
  test('flipNext during a snap-back: the new copy survives the next frame', () => {
    const raf = installRafQueue();
    try {
      const { book: app } = book({ pageCount: 4, flippingTime: 400, foldCornerOnHover: false });
      raf.flush();
      const block = app.getBlockElement();
      const rect = app.getBoundsRect();
      const y = rect.top + rect.height - 8;

      // A short drag, drawn once so the first copy is booked as shown, then
      // released on the right half: a snap-back, not a turn.
      pointer('pointerdown', block, rect.left + rect.width - 6, y);
      pointer('pointermove', block, rect.left + rect.width - 20, y);
      pointer('pointermove', block, rect.left + rect.width - 30, y);
      raf.flush(1);
      pointer('pointerup', block, rect.left + rect.width - 30, y);
      raf.flush(1);
      expect(app.getState()).not.toBe(FlippingState.READ);

      // Finishes the snap-back (its copy is dropped before `read`), then
      // copies the SAME leaf again for the new turn.
      expect(app.flipNext()).toBe(true);
      raf.flush(1);
      expect(moverElement(app)?.isConnected).toBe(true);
      expect(block.querySelectorAll('[data-stf-clone]')).toHaveLength(1);

      raf.flush();
      expect(app.getCurrentPageIndex()).toBe(1);
      expect(block.querySelectorAll('[data-stf-clone]')).toHaveLength(0);
    } finally {
      raf.restore();
    }
  });

  test('a read listener that turns after cancelTurn gets a visible fold', () => {
    const raf = installRafQueue();
    try {
      const { book: app } = book({ pageCount: 4, flippingTime: 400, foldCornerOnHover: false });
      raf.flush();
      const block = app.getBlockElement();
      expect(app.flipNext()).toBe(true);
      raf.flush(2);

      let chained = false;
      app.on('changeState', ({ data }) => {
        if (data.state !== 'read' || chained) return;
        chained = true;
        expect(app.flipNext()).toBe(true);
      });
      expect(app.cancelTurn()).toBe(true);
      expect(chained).toBe(true);

      raf.flush(1);
      expect(moverElement(app)?.isConnected).toBe(true);
      raf.flush();
      expect(app.getCurrentPageIndex()).toBe(1);
      expect(block.querySelectorAll('[data-stf-clone]')).toHaveLength(0);
    } finally {
      raf.restore();
    }
  });

  test('a cancel with nothing folded does not reach into a later turn', () => {
    const raf = installRafQueue();
    try {
      const { book: app } = book({ pageCount: 6, flippingTime: 400, foldCornerOnHover: false });
      raf.flush();
      const block = app.getBlockElement();
      const rect = app.getBoundsRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;

      // A pointer down with no fold: `cancelTurn` has work (the gesture) but
      // the book is already READ, so no `read` is emitted.
      pointer('pointerdown', block, cx, cy);
      expect(app.cancelTurn()).toBe(true);
      pointer('pointerup', block, cx, cy);

      let chained = false;
      app.on('changeState', ({ data }) => {
        if (data.state !== 'read' || chained) return;
        chained = true;
        app.flipNext();
      });
      expect(app.flipNext()).toBe(true);
      for (let i = 0; i < 200 && !chained; i += 1) raf.flush(1);
      expect(chained).toBe(true);

      raf.flush(1);
      expect(moverElement(app)?.isConnected).toBe(true);
      raf.flush();
      expect(app.getCurrentPageIndex()).toBe(2);
      expect(block.querySelectorAll('[data-stf-clone]')).toHaveLength(0);
    } finally {
      raf.restore();
    }
  });
});

describe('an OS-cancelled drag removes the copy (G3 on the pointercancel path)', () => {
  test.each(['pointercancel', 'lostpointercapture'])(
    '%s mid-fold: read with 0 clones, and no frozen fold drawn afterwards',
    (type) => {
      const raf = installRafQueue();
      try {
        const { book: app } = book({ pageCount: 4, flippingTime: 400, foldCornerOnHover: false });
        raf.flush();
        const block = app.getBlockElement();
        const order: string[] = [];
        app.on('changeState', ({ data }) => {
          order.push(`${data.state}:${block.querySelectorAll('[data-stf-clone]').length}`);
        });

        dragToFold(app, 'touch');
        raf.flush(2);
        expect(block.querySelectorAll('[data-stf-clone]')).toHaveLength(1);

        const rect = app.getBoundsRect();
        pointer(type, block, rect.left + rect.width - 120, rect.top + rect.height - 8, 'touch');
        raf.flush(5);

        expect(order).toEqual(['user_fold:0', 'read:0']);
        expect(block.querySelectorAll('[data-stf-clone]')).toHaveLength(0);
        // Private slot: the renderer must not keep drawing the dropped fold.
        const render = testRender(app) as unknown as { flippingPage: unknown };
        expect(render.flippingPage).toBeNull();

        // The next turn still works and cleans up after itself.
        expect(app.flipNext()).toBe(true);
        raf.flush();
        expect(app.getCurrentPageIndex()).toBe(1);
        expect(block.querySelectorAll('[data-stf-clone]')).toHaveLength(0);
      } finally {
        raf.restore();
      }
    },
  );
});

describe('an instant jump from a turn-setup listener supersedes that turn', () => {
  test.each(['flipping', 'user_fold'])(
    'turnToPage inside changeState(%s) lands on its page, and the outer turn is dropped',
    (state) => {
      const raf = installRafQueue();
      try {
        const { book: app } = book({ pageCount: 6, flippingTime: 400, foldCornerOnHover: false });
        raf.flush();
        const block = app.getBlockElement();
        const flips: number[] = [];
        app.on('flip', ({ data }) => flips.push(data.page));
        let jumped = false;
        app.on('changeState', ({ data }) => {
          if (data.state !== state || jumped) return;
          jumped = true;
          app.turnToPage(4);
        });

        if (state === 'flipping') {
          expect(app.flipNext()).toBe(false);
        } else {
          dragToFold(app, 'touch');
          const rect = app.getBoundsRect();
          pointer('pointerup', block, rect.left + 4, rect.top + rect.height - 8, 'touch');
        }
        raf.flush();

        expect(jumped).toBe(true);
        expect(flips).toEqual([4]);
        expect(app.getCurrentPageIndex()).toBe(4);
        expect(app.getState()).toBe(FlippingState.READ);
        expect(block.querySelectorAll('[data-stf-clone]')).toHaveLength(0);
      } finally {
        raf.restore();
      }
    },
  );
});

describe('portrait flipToPage(n) curls the leaf on screen to reveal page n', () => {
  test.each([
    { from: 0, to: 4 },
    { from: 4, to: 0 },
  ])('flipToPage($to) from $from: mover copies page $from, bottom is page $to', ({ from, to }) => {
    const raf = installRafQueue();
    try {
      const { book: app } = book({
        pageCount: 6,
        flippingTime: 400,
        foldCornerOnHover: false,
        initialPage: from,
      });
      raf.flush();
      expect(app.getCurrentPageIndex()).toBe(from);

      expect(app.flipToPage(to)).toBe(true);
      raf.flush(2);
      const flip = testFlip(app) as unknown as {
        flippingPage: Page | null;
        bottomPage: Page | null;
      } | null;
      const mover = flip?.flippingPage?.getElement();
      expect(mover?.hasAttribute('data-stf-clone')).toBe(true);
      expect(mover?.dataset.page).toBe(String(from));
      expect(flip?.bottomPage?.getElement().dataset.page).toBe(String(to));

      raf.flush();
      expect(app.getCurrentPageIndex()).toBe(to);
    } finally {
      raf.restore();
    }
  });
});

describe('a completed turn drops its copy before flip', () => {
  test('a flip listener sees one token, and a turn chained from it draws alone', () => {
    const raf = installRafQueue();
    try {
      const { book: app, pages } = book({
        pageCount: 6,
        flippingTime: 300,
        foldCornerOnHover: false,
      });
      pages[0]!.innerHTML = '<span data-token-id="x">line</span>';
      app.updateFromHtml(pages);
      raf.flush();
      const block = app.getBlockElement();
      const atFlip: number[] = [];
      let chained = false;
      app.on('flip', () => {
        atFlip.push(block.querySelectorAll('[data-token-id="x"]').length);
        if (chained) return;
        chained = true;
        expect(app.flipNext()).toBe(true);
      });

      expect(app.flipNext()).toBe(true);
      for (let i = 0; i < 200 && !chained; i += 1) raf.flush(1);
      expect(atFlip).toEqual([1]);

      raf.flush(1);
      const clones = block.querySelectorAll('[data-stf-clone]');
      expect(clones).toHaveLength(1);
      expect(clones[0]).toBe(moverElement(app));
      expect((clones[0] as HTMLElement).dataset.page).toBe('1');

      raf.flush();
      expect(app.getCurrentPageIndex()).toBe(2);
      expect(block.querySelectorAll('[data-stf-clone]')).toHaveLength(0);
    } finally {
      raf.restore();
    }
  });
});

describe('a completed turn leaves no per-turn render state (Z4)', () => {
  test('the fold rect, mover and bottom page are all dropped', () => {
    const raf = installRafQueue();
    try {
      const { book: app } = book({ pageCount: 4, flippingTime: 200, foldCornerOnHover: false });
      raf.flush();
      expect(app.flipNext()).toBe(true);
      raf.flush(2);
      const render = testRender(app) as unknown as {
        pageRect: unknown;
        flippingPage: unknown;
        bottomPage: unknown;
      };
      expect(render.pageRect).not.toBeNull();
      raf.flush();
      expect(app.getCurrentPageIndex()).toBe(1);
      expect([render.pageRect, render.flippingPage, render.bottomPage]).toEqual([null, null, null]);
    } finally {
      raf.restore();
    }
  });
});

describe('a refused turn over a live fold tears the fold down', () => {
  test.each([2, 10])(
    'grab a flipNext after %i frames, swipe back at page 0: read, no clone left',
    (frames) => {
      const raf = installRafQueue();
      try {
        const { book: app } = book({ pageCount: 6, flippingTime: 400, foldCornerOnHover: false });
        raf.flush();
        const block = app.getBlockElement();
        const rect = app.getBoundsRect();
        const y = rect.top + rect.height - 8;

        expect(app.flipNext()).toBe(true);
        raf.flush(frames);
        // Re-grab mid-turn and sweep right fast: released as a swipe toward
        // `prev`, which page 0 refuses.
        pointer('pointerdown', block, rect.left + rect.width / 2, y);
        pointer('pointermove', block, rect.left + rect.width - 30, y);
        pointer('pointermove', block, rect.left + rect.width - 4, y);
        expect(app.getState()).toBe(FlippingState.USER_FOLD);
        pointer('pointerup', block, rect.left + rect.width - 4, y);
        raf.flush();

        expect(app.getState()).toBe(FlippingState.READ);
        expect(app.getCurrentPageIndex()).toBe(0);
        expect(block.querySelectorAll('[data-stf-clone]')).toHaveLength(0);
        const render = testRender(app) as unknown as { flippingPage: unknown };
        expect(render.flippingPage).toBeNull();
      } finally {
        raf.restore();
      }
    },
  );

  test('a parked hover peel under a refused flipPrev returns to read', () => {
    const raf = installRafQueue();
    try {
      const { book: app } = book({ pageCount: 6, flippingTime: 200, foldCornerOnHover: true });
      raf.flush();
      const block = app.getBlockElement();
      const rect = app.getBoundsRect();
      block.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          pointerId: 1,
          pointerType: 'mouse',
          buttons: 0,
          clientX: rect.left + rect.width - 4,
          clientY: rect.top + rect.height - 4,
        }),
      );
      raf.flush();
      expect(app.getState()).toBe(FlippingState.FOLD_CORNER);
      expect(block.querySelectorAll('[data-stf-clone]')).toHaveLength(1);

      expect(app.flipPrev()).toBe(false);
      raf.flush();
      expect(app.getState()).toBe(FlippingState.READ);
      expect(block.querySelectorAll('[data-stf-clone]')).toHaveLength(0);
    } finally {
      raf.restore();
    }
  });
});

describe('a copy that cannot be made hands the state back', () => {
  test('flipNext on a detached leaf is rejected and the book stays READ', () => {
    const { book: app, pages } = book({
      pageCount: 4,
      flippingTime: 400,
      foldCornerOnHover: false,
    });
    const rejected: string[] = [];
    app.on('turnRejected', ({ data }) => rejected.push(data.code ?? ''));
    pages[0]!.remove();

    expect(app.flipNext()).toBe(false);
    expect(rejected).toEqual(['DETACHED_PAGE']);
    expect(app.getState()).toBe(FlippingState.READ);
    expect(testFlip(app)!.getCalculation()).toBeNull();
    expect(app.getBlockElement().querySelector('[data-stf-clone]')).toBeNull();
  });
});

describe('video fold copy — no second player, no audio from the copy', () => {
  // jsdom has no media pipeline; `load()` only logs "not implemented". The
  // spy still records which elements it was called on.
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  });

  test('portrait clone replaces video with a canvas and strips audio', () => {
    const { book: app, pages } = book({ pageCount: 4, flippingTime: 0 });
    const video = document.createElement('video');
    video.src = 'clip.mp4';
    video.autoplay = true;
    video.muted = false;
    video.setAttribute('poster', 'still.jpg');
    video.width = 120;
    video.height = 80;
    const audio = document.createElement('audio');
    audio.src = 'narration.mp3';
    audio.autoplay = true;
    pages[0]!.append(video, audio);
    app.updateFromHtml(pages);

    const load = vi.mocked(HTMLMediaElement.prototype.load);
    const page = testPage(app, 0) as Page;
    const clone = page.newTemporaryCopy().getElement();

    expect(clone.querySelector('video')).toBeNull();
    expect(clone.querySelector('audio')).toBeNull();
    expect(clone.querySelector('canvas[data-stf-frame]')).not.toBeNull();
    expect(pages[0]!.querySelector('video')).toBe(video);
    expect(video.paused).toBe(true);
    expect(video.currentTime).toBe(0);
    // The original is never reloaded. Each COPY is: that is what aborts the
    // fetch its copied `src` started while detached.
    expect(load.mock.contexts).not.toContain(video);
    expect(load.mock.contexts).not.toContain(audio);
    expect(load.mock.contexts).toHaveLength(2);
    for (const copy of load.mock.contexts as HTMLMediaElement[]) {
      expect(copy.hasAttribute('src')).toBe(false);
      expect(copy.hasAttribute('autoplay')).toBe(false);
      expect(copy.isConnected).toBe(false);
    }
    expect(video.getAttribute('src')).toBe('clip.mp4');
    expect(video.autoplay).toBe(true);
    page.hideTemporaryCopy();
  });

  test('a copied <source> list is emptied before the copy is dropped', () => {
    const { book: app, pages } = book({ pageCount: 4, flippingTime: 0 });
    pages[0]!.innerHTML =
      '<video autoplay loop><source src="a.webm" type="video/webm"><source src="a.mp4"></video>';
    app.updateFromHtml(pages);

    const load = vi.mocked(HTMLMediaElement.prototype.load);
    const page = testPage(app, 0) as Page;
    page.newTemporaryCopy();

    const copy = load.mock.contexts[0] as HTMLVideoElement;
    expect(copy).not.toBe(pages[0]!.querySelector('video'));
    expect(copy.querySelector('source')).toBeNull();
    expect(copy.hasAttribute('autoplay')).toBe(false);
    expect(pages[0]!.querySelectorAll('source')).toHaveLength(2);
    page.hideTemporaryCopy();
  });

  test("the frame canvas keeps the video's attributes, layout box and fit", () => {
    const { book: app, pages } = book({ pageCount: 4, flippingTime: 0 });
    const video = document.createElement('video');
    video.src = 'clip.mp4';
    video.id = 'hero';
    video.className = 'cover';
    video.setAttribute('style', 'object-fit: cover; object-position: 10% 20%; border-radius: 8px');
    video.dataset.tokenId = 'v1';
    video.width = 1920;
    video.height = 1080;
    Object.defineProperty(video, 'offsetWidth', { get: () => 320 });
    Object.defineProperty(video, 'offsetHeight', { get: () => 180 });
    Object.defineProperty(video, 'readyState', { get: () => 2 });
    Object.defineProperty(video, 'videoWidth', { get: () => 3840 });
    Object.defineProperty(video, 'videoHeight', { get: () => 2160 });
    pages[0]!.append(video);
    app.updateFromHtml(pages);

    const original = HTMLCanvasElement.prototype.getContext;
    const draws: number[][] = [];
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string) {
      if (type !== '2d') return original.call(this, type);
      return {
        drawImage(_s: CanvasImageSource, ...rect: number[]) {
          draws.push(rect);
        },
      } as unknown as CanvasRenderingContext2D;
    } as typeof HTMLCanvasElement.prototype.getContext;
    const dpr = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });

    try {
      const page = testPage(app, 0) as Page;
      const canvas = page.newTemporaryCopy().getElement().querySelector('canvas')!;

      expect(canvas.hasAttribute('data-stf-frame')).toBe(true);
      expect(canvas.id).toBe('hero');
      expect(canvas.className).toBe('cover');
      expect(canvas.dataset.tokenId).toBe('v1');
      expect(canvas.hasAttribute('src')).toBe(true);
      expect(canvas.hasAttribute('width')).toBe(true);
      expect(canvas.style.borderRadius).toBe('8px');
      expect(canvas.style.width).toBe('320px');
      expect(canvas.style.height).toBe('180px');
      expect(canvas.style.boxSizing).toBe('border-box');
      expect(canvas.style.objectFit).toBe('cover');
      expect(canvas.style.objectPosition).toBe('10% 20%');
      // Layout size × DPR, in the video's aspect ratio — not 3840x2160.
      expect([canvas.width, canvas.height]).toEqual([640, 360]);
      expect(draws).toEqual([[0, 0, 640, 360]]);
      page.hideTemporaryCopy();
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
      Object.defineProperty(window, 'devicePixelRatio', { value: dpr, configurable: true });
    }
  });

  test('a video with no frame yet folds its poster, sized like the video', () => {
    const { book: app, pages } = book({ pageCount: 4, flippingTime: 0 });
    const video = document.createElement('video');
    video.setAttribute('preload', 'none');
    video.setAttribute('poster', 'https://cdn.example/still.jpg');
    video.style.backgroundColor = 'black';
    Object.defineProperty(video, 'offsetWidth', { get: () => 400 });
    Object.defineProperty(video, 'offsetHeight', { get: () => 300 });
    pages[0]!.append(video);
    app.updateFromHtml(pages);

    const page = testPage(app, 0) as Page;
    const canvas = page.newTemporaryCopy().getElement().querySelector('canvas')!;
    expect(canvas.getAttribute('data-stf-poster')).toBe('https://cdn.example/still.jpg');
    expect(canvas.style.backgroundImage).toContain('https://cdn.example/still.jpg');
    expect(canvas.style.backgroundRepeat).toBe('no-repeat');
    expect(canvas.style.backgroundColor).toBe('black');
    expect(canvas.style.width).toBe('400px');
    page.hideTemporaryCopy();
  });

  test('iframe, embed and object are replaced by a sized box before the copy is attached', () => {
    const { book: app, pages } = book({ pageCount: 4, flippingTime: 0 });
    pages[0]!.innerHTML =
      '<p>text <iframe class="yt" data-token-id="e1" src="https://www.youtube.com/embed/x"></iframe></p>' +
      '<embed src="a.swf"><object data="a.pdf"><embed src="fallback.pdf"></object>';
    const frame = pages[0]!.querySelector('iframe')!;
    Object.defineProperty(frame, 'offsetWidth', { get: () => 560 });
    Object.defineProperty(frame, 'offsetHeight', { get: () => 315 });
    app.updateFromHtml(pages);

    const attached: Element[] = [];
    const observer = new MutationObserver((records) => {
      for (const r of records)
        for (const n of Array.from(r.addedNodes)) attached.push(n as Element);
    });
    observer.observe(app.getBlockElement(), { childList: true, subtree: true });

    const page = testPage(app, 0) as Page;
    const clone = page.newTemporaryCopy().getElement();
    observer
      .takeRecords()
      .forEach((r) => Array.from(r.addedNodes).forEach((n) => attached.push(n as Element)));
    observer.disconnect();

    expect(clone.querySelector('iframe, embed, object')).toBeNull();
    // The clone was attached once, already free of embeds.
    expect(attached).toEqual([clone]);
    const box = clone.querySelector<HTMLElement>('div[data-stf-embed].yt')!;
    expect(box.dataset.tokenId).toBe('e1');
    expect(box.style.display).toBe('inline-block');
    expect(box.style.width).toBe('560px');
    expect(box.style.height).toBe('315px');
    expect(clone.querySelectorAll('[data-stf-embed]').length).toBeGreaterThanOrEqual(3);
    expect(pages[0]!.querySelector('iframe')).toBe(frame);
    page.hideTemporaryCopy();
  });

  test('a ready frame is drawn onto the clone canvas and a failed draw does not throw', () => {
    const { book: app, pages } = book({ pageCount: 4, flippingTime: 0 });
    const video = document.createElement('video');
    video.src = 'clip.mp4';
    Object.defineProperty(video, 'readyState', { get: () => 2 });
    Object.defineProperty(video, 'videoWidth', { get: () => 16 });
    Object.defineProperty(video, 'videoHeight', { get: () => 9 });
    Object.defineProperty(video, 'offsetWidth', { get: () => 160 });
    Object.defineProperty(video, 'offsetHeight', { get: () => 90 });
    pages[0]!.append(video);
    app.updateFromHtml(pages);

    const drawn: CanvasImageSource[] = [];
    const original = HTMLCanvasElement.prototype.getContext;
    // jsdom has no canvas. The platform context is what drawImage runs on;
    // the assertion is that the shipped clone asks that context to paint the
    // original video, not a second media element.
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string) {
      if (type !== '2d') return original.call(this, type);
      return {
        drawImage(source: CanvasImageSource) {
          drawn.push(source);
        },
      } as unknown as CanvasRenderingContext2D;
    } as typeof HTMLCanvasElement.prototype.getContext;

    const page = testPage(app, 0) as Page;
    const clone = page.newTemporaryCopy().getElement();
    expect(drawn[0]).toBe(video);
    expect(clone.querySelector('video')).toBeNull();
    page.hideTemporaryCopy();
    HTMLCanvasElement.prototype.getContext = original;
  });

  test('landscape spread turn folds the live video (no clone)', () => {
    const { book: app, pages } = book({
      pageCount: 4,
      flippingTime: 800,
      usePortrait: false,
      hostWidth: 800,
      foldCornerOnHover: false,
    });
    const video = document.createElement('video');
    video.src = 'clip.mp4';
    pages[0]!.append(video);
    app.updateFromHtml(pages);
    expect(app.getOrientation()).toBe('landscape');

    dragToFold(app);
    expect(app.getBlockElement().querySelector('[data-stf-clone]')).toBeNull();
    expect(pages[0]!.querySelector('video')).toBe(video);
    app.cancelTurn();
  });
});

describe('interactive media does not start a fold', () => {
  test('video[controls], audio[controls], iframe, embed and object are interactive', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<video id="v" controls></video><audio id="a" controls></audio><iframe id="f"></iframe><embed id="e"><object id="o"></object><video id="bare"></video><span id="s"></span>';
    document.body.append(root);
    for (const id of ['v', 'a', 'f', 'e', 'o']) {
      expect(isInteractivePointerTarget(root.querySelector(`#${id}`))).toBe(true);
    }
    expect(isInteractivePointerTarget(root.querySelector('#bare'))).toBe(false);
    expect(isInteractivePointerTarget(root.querySelector('#s'))).toBe(false);
  });

  test('a drag that starts on video[controls] stays in read; a controls-less video folds', () => {
    const { book: app, pages } = book({
      pageCount: 4,
      flippingTime: 0,
      respectInteractiveContent: true,
      foldCornerOnHover: false,
    });
    const controls = document.createElement('video');
    controls.controls = true;
    pages[0]!.append(controls);
    app.updateFromHtml(pages);
    const rect = app.getBoundsRect();
    pointer('pointerdown', controls, rect.left + rect.width - 8, rect.top + 8);
    pointer('pointermove', controls, rect.left + rect.width - 80, rect.top + 8);
    expect(app.getState()).toBe(FlippingState.READ);

    const bare = document.createElement('video');
    pages[1]!.append(bare);
    app.updateFromHtml(pages);
    app.turnToPage(1);
    pointer('pointerdown', bare, rect.left + rect.width - 8, rect.top + 8);
    pointer('pointermove', bare, rect.left + rect.width - 80, rect.top + 8);
    expect(app.getState()).toBe(FlippingState.USER_FOLD);
  });
});
