/**
 * Controlled `page` against real animated turns, and the lazy placeholder's
 * ownership of the page root. Each case drives the shipped binding and the
 * shipped engine under a queued requestAnimationFrame, so "the turn animated"
 * means frames actually played between the prop change and the commit.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { createRef, useState } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { HTMLFlipBook } from '@gullabs/react-flipbook';
import type { FlipBookHandle } from '@gullabs/react-flipbook';

afterEach(() => {
  cleanup();
});

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
        clock += 20;
        act(() => {
          for (const cb of batch) cb(clock);
        });
      }
    },
    restore() {
      globalThis.requestAnimationFrame = realRaf;
      globalThis.cancelAnimationFrame = realCancel;
    },
  };
}

interface HarnessApi {
  setPage: (page: number) => void;
  /** `onPageChange` payloads. */
  seen: number[];
  /** Every `page` value the consumer rendered with. */
  rendered: number[];
}

function mountControlled() {
  const handle = createRef<FlipBookHandle>();
  const api: HarnessApi = { setPage: () => {}, seen: [], rendered: [] };

  function Harness() {
    const [page, setPage] = useState(0);
    api.setPage = setPage;
    api.rendered.push(page);
    return (
      <HTMLFlipBook
        ref={handle}
        width={200}
        height={300}
        flippingTime={400}
        page={page}
        usePortrait
        onPageChange={(snapshot) => {
          api.seen.push(snapshot.page);
          setPage(snapshot.page);
        }}
      >
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="page">
            {i}
          </div>
        ))}
      </HTMLFlipBook>
    );
  }

  render(<Harness />);
  return { handle, api };
}

describe('controlled page animates and settles on the newest value', () => {
  test('a controlled change with inline children animates instead of snapping', async () => {
    const raf = installRafQueue();
    try {
      const { handle, api } = mountControlled();
      await waitFor(() => expect(handle.current?.pageFlip()?.isReady()).toBe(true));
      raf.flush();

      act(() => api.setPage(1));
      raf.flush(2);
      const engine = handle.current!.pageFlip()!;
      // Two frames into a 400 ms turn: still turning, still on page 0.
      expect(engine.getState()).toBe('flipping');
      expect(engine.getCurrentPageIndex()).toBe(0);

      raf.flush();
      expect(engine.getCurrentPageIndex()).toBe(1);
      expect(api.seen).toEqual([1]);
    } finally {
      raf.restore();
    }
  });

  test('rapid changes 1, 2, 3, 4 land on 4 and never report a page backwards', async () => {
    const raf = installRafQueue();
    try {
      const { handle, api } = mountControlled();
      await waitFor(() => expect(handle.current?.pageFlip()?.isReady()).toBe(true));
      raf.flush();

      for (const page of [1, 2, 3, 4]) {
        act(() => api.setPage(page));
        raf.flush(1);
      }
      raf.flush();

      expect(handle.current!.pageFlip()!.getCurrentPageIndex()).toBe(4);
      // The consumer's own state never steps back to a page it moved past.
      for (let i = 1; i < api.rendered.length; i += 1) {
        expect(api.rendered[i], `rendered ${api.rendered.join(',')}`).toBeGreaterThanOrEqual(
          api.rendered[i - 1]!,
        );
      }
      expect(api.seen[api.seen.length - 1]).toBe(4);
    } finally {
      raf.restore();
    }
  });

  test('a controlled turn cancelled by a live size change is re-issued', async () => {
    const raf = installRafQueue();
    try {
      const { handle, api } = mountControlled();
      await waitFor(() => expect(handle.current?.pageFlip()?.isReady()).toBe(true));
      raf.flush();

      act(() => api.setPage(2));
      raf.flush(2);
      expect(handle.current!.pageFlip()!.getState()).toBe('flipping');
      // A live width change mid-turn cancels the fold (geometry changed). Made
      // on the ENGINE, as a ResizeObserver-driven relayout is: no React render
      // happens, so nothing but the binding's own `read` handling can re-run
      // the controlled effect.
      act(() => {
        handle.current!.pageFlip()!.updateSettings({ width: 201 });
      });
      raf.flush();

      expect(handle.current!.pageFlip()!.getVisiblePages()).toContain(2);
    } finally {
      raf.restore();
    }
  });
});

describe('lazy placeholders keep the engine-owned page root', () => {
  test('a leaf crossing the lazy window keeps stf__item and its density class', async () => {
    const raf = installRafQueue();
    try {
      const handle = createRef<FlipBookHandle>();
      render(
        <HTMLFlipBook ref={handle} width={200} height={300} flippingTime={0} lazyRadius={1}>
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="page">
              {i}
            </div>
          ))}
        </HTMLFlipBook>,
      );
      await waitFor(() => expect(handle.current?.pageFlip()?.isReady()).toBe(true));
      raf.flush();

      for (let i = 0; i < 4; i += 1) {
        act(() => {
          handle.current!.flipNext();
        });
        raf.flush();
      }
      for (let i = 0; i < 4; i += 1) {
        act(() => {
          handle.current!.flipPrev();
        });
        raf.flush();
      }

      const engine = handle.current!.pageFlip()!;
      for (let i = 0; i < 8; i += 1) {
        const el = engine.getPageElement(i)!;
        expect(el.classList.contains('stf__item'), `leaf ${i} classes: ${el.className}`).toBe(true);
      }
    } finally {
      raf.restore();
    }
  });
});
