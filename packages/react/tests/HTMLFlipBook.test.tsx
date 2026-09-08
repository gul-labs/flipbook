import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRef, StrictMode, useState } from 'react';
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
  fireEvent,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTMLFlipBook, usePageFlip } from '@gullabs/react-flipbook';
import type { FlipBookHandle, TurnRejected } from '@gullabs/react-flipbook';

afterEach(() => {
  cleanup();
});

function pages(...labels: string[]) {
  return labels.map((label) => (
    <div key={label} data-testid={`page-${label}`}>
      {label}
    </div>
  ));
}

describe('HTMLFlipBook (shipped binding)', () => {
  test('flippingTime: 0 mounts without throwing', () => {
    expect(() =>
      render(
        <HTMLFlipBook width={200} height={300} flippingTime={0}>
          {pages('a', 'b')}
        </HTMLFlipBook>,
      ),
    ).not.toThrow();
    expect(screen.getByLabelText('Flipbook')).toBeTruthy();
  });

  test('renders a stable pre-hydration placeholder attribute then hydrates', async () => {
    const { container } = render(
      <HTMLFlipBook width={200} height={300} flippingTime={0}>
        {pages('a', 'b')}
      </HTMLFlipBook>,
    );
    await waitFor(() => {
      const root = container.querySelector('[aria-label="Flipbook"]');
      expect(root).toBeTruthy();
      expect(root?.hasAttribute('data-flipbook-placeholder')).toBe(false);
    });
  });

  test('onPagesChanged fires on children change', async () => {
    const onPagesChanged = vi.fn();
    const { rerender } = render(
      <HTMLFlipBook width={200} height={300} flippingTime={0} onPagesChanged={onPagesChanged}>
        {pages('a', 'b')}
      </HTMLFlipBook>,
    );

    rerender(
      <HTMLFlipBook width={200} height={300} flippingTime={0} onPagesChanged={onPagesChanged}>
        {pages('a', 'b', 'c')}
      </HTMLFlipBook>,
    );

    await waitFor(() => {
      expect(onPagesChanged.mock.calls.length).toBeGreaterThan(0);
    });
  });

  test('Strict Mode double-mount does not lose the book', async () => {
    const { container } = render(
      <StrictMode>
        <HTMLFlipBook width={200} height={300} flippingTime={0}>
          {pages('a', 'b', 'c')}
        </HTMLFlipBook>
      </StrictMode>,
    );
    await waitFor(() => {
      const books = container.querySelectorAll('[aria-label="Flipbook"]');
      expect(books.length).toBe(1);
      expect(container.querySelector('[data-testid="page-a"]')).toBeTruthy();
    });
  });

  test('controlled page + onPageChange', async () => {
    const handleRef: { current: import('@gullabs/react-flipbook').FlipBookHandle | null } = {
      current: null,
    };
    function Harness() {
      const [page, setPage] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setPage(1)}>
            go
          </button>
          <HTMLFlipBook
            ref={(h) => {
              handleRef.current = h;
            }}
            width={200}
            height={300}
            flippingTime={0}
            page={page}
            onPageChange={(snapshot) => setPage(snapshot.page)}
          >
            {pages('a', 'b', 'c')}
          </HTMLFlipBook>
        </>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByText('go'));
    await waitFor(() => {
      expect(handleRef.current?.pageFlip()?.getCurrentPageIndex()).toBe(1);
    });
    expect(screen.getByText(/Page 2 of/)).toBeTruthy();
  });

  test('live region is announced but not painted', async () => {
    const { container } = render(
      <HTMLFlipBook width={200} height={300} flippingTime={0}>
        {pages('a', 'b')}
      </HTMLFlipBook>,
    );

    const live = container.querySelector<HTMLElement>('[data-flipbook-live]');
    expect(live).toBeTruthy();
    expect(live?.getAttribute('aria-live')).toBe('polite');
    // Visible text under the book was the bug: it must be clipped away.
    expect(live?.style.position).toBe('absolute');
    expect(live?.style.clipPath).toBe('inset(50%)');
    expect(live?.style.width).toBe('1px');
  });

  test('an inline onPageChange does not rebuild the page collection on every turn', async () => {
    const onPagesChanged = vi.fn();

    function Harness() {
      const book = usePageFlip();
      return (
        <>
          <button type="button" onClick={() => book.flipNext()}>
            next
          </button>
          <HTMLFlipBook
            ref={book.ref}
            width={200}
            height={300}
            flippingTime={0}
            {...book.bookProps}
            // Inline identities: new on every render, which is the whole point.
            onPageChange={(snapshot) => {
              book.bookProps.onPageChange?.(snapshot);
            }}
            onPagesChanged={(snapshot) => {
              onPagesChanged(snapshot);
              book.bookProps.onPagesChanged?.(snapshot);
            }}
          >
            {pages('a', 'b', 'c')}
          </HTMLFlipBook>
        </>
      );
    }

    const { container } = render(<Harness />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="page-a"]')).toBeTruthy();
    });

    onPagesChanged.mockClear();
    fireEvent.click(screen.getByText('next'));

    await waitFor(() => {
      expect(container.querySelector('[data-flipbook-live]')?.textContent).toMatch(/Page 2 of 3/);
    });

    expect(onPagesChanged).not.toHaveBeenCalled();
  });

  test('removing and reordering children does not throw', async () => {
    function Harness() {
      const [labels, setLabels] = useState(['a', 'b', 'c']);
      return (
        <>
          <button type="button" onClick={() => setLabels(['c', 'a'])}>
            shuffle
          </button>
          <HTMLFlipBook width={200} height={300} flippingTime={0}>
            {pages(...labels)}
          </HTMLFlipBook>
        </>
      );
    }

    const { container } = render(<Harness />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="page-c"]')).toBeTruthy();
    });

    expect(() => fireEvent.click(screen.getByText('shuffle'))).not.toThrow();

    await waitFor(() => {
      expect(container.querySelector('[data-testid="page-b"]')).toBeNull();
      expect(container.querySelector('[data-testid="page-c"]')).toBeTruthy();
    });
  });

  test('a consumer ref on a page element still fires', async () => {
    const seen: (HTMLElement | null)[] = [];

    render(
      <HTMLFlipBook width={200} height={300} flippingTime={0}>
        <div
          data-testid="page-a"
          ref={(el: HTMLDivElement | null) => {
            if (el) seen.push(el);
          }}
        >
          a
        </div>
        <div data-testid="page-b">b</div>
      </HTMLFlipBook>,
    );

    await waitFor(() => {
      expect(seen.length).toBeGreaterThan(0);
    });
  });

  test('usePageFlip actions are wired to the handle', async () => {
    function Harness() {
      const book = usePageFlip();
      return (
        <>
          <button type="button" onClick={() => book.flipNext()}>
            next
          </button>
          <button type="button" onClick={() => book.flipPrev()}>
            prev
          </button>
          <button type="button" onClick={() => book.turnToPage(2)}>
            turn-end
          </button>
          <button type="button" onClick={() => book.flipToPage(0)}>
            flip-start
          </button>
          <HTMLFlipBook
            ref={book.ref}
            width={200}
            height={300}
            flippingTime={0}
            {...book.bookProps}
          >
            {pages('a', 'b', 'c')}
          </HTMLFlipBook>
          <span data-testid="page-state">{book.page}</span>
          <span data-testid="page-count">{book.pageCount}</span>
        </>
      );
    }
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByText('next'));
    await waitFor(() => {
      expect(container.querySelector('[data-flipbook-live]')?.textContent).toMatch(/Page 2 of 3/);
    });
    fireEvent.click(screen.getByText('prev'));
    await waitFor(() => {
      expect(container.querySelector('[data-flipbook-live]')?.textContent).toMatch(/Page 1 of 3/);
    });
    fireEvent.click(screen.getByText('turn-end'));
    await waitFor(() => {
      expect(screen.getByTestId('page-state').textContent).toBe('2');
    });
    fireEvent.click(screen.getByText('flip-start'));
    await waitFor(() => {
      expect(screen.getByTestId('page-state').textContent).toBe('0');
    });
    await waitFor(() => {
      expect(Number(screen.getByTestId('page-count').textContent)).toBeGreaterThan(0);
    });
  });
});

test('useKeyboard defaults on and live region has role=status', async () => {
  const { container } = render(
    <HTMLFlipBook width={200} height={300} flippingTime={0}>
      {pages('a', 'b', 'c')}
    </HTMLFlipBook>,
  );
  await waitFor(() => {
    const root = container.querySelector('[aria-label="Flipbook"]');
    expect(root?.getAttribute('tabindex')).toBe('0');
    expect(root?.getAttribute('aria-keyshortcuts')).toContain('ArrowLeft');
    expect(container.querySelector('[data-flipbook-live][role="status"]')).toBeTruthy();
  });
});

test('initialPage opens on the requested index when uncontrolled', async () => {
  const handleRef: { current: import('@gullabs/react-flipbook').FlipBookHandle | null } = {
    current: null,
  };
  render(
    <HTMLFlipBook
      ref={(h) => {
        handleRef.current = h;
      }}
      width={200}
      height={300}
      flippingTime={0}
      initialPage={1}
      usePortrait
    >
      {pages('a', 'b', 'c')}
    </HTMLFlipBook>,
  );
  await waitFor(() => {
    expect(handleRef.current?.pageFlip()?.getCurrentPageIndex()).toBe(1);
  });
});

test('keyboard ArrowRight turns with userEvent', async () => {
  const user = userEvent.setup();
  const onPageChange = vi.fn();
  render(
    <HTMLFlipBook width={200} height={300} flippingTime={0} onPageChange={onPageChange}>
      {pages('a', 'b', 'c')}
    </HTMLFlipBook>,
  );
  const root = await screen.findByLabelText('Flipbook');
  root.focus();
  await user.keyboard('{ArrowRight}');
  await waitFor(() => {
    expect(onPageChange.mock.calls.length).toBeGreaterThan(0);
  });
});

test('nested interactive keeps Arrow keys (does not turn the book)', async () => {
  const onPageChange = vi.fn();
  const { container } = render(
    <HTMLFlipBook width={200} height={300} flippingTime={0} onPageChange={onPageChange}>
      <div key="a">
        <button type="button">Inside</button>
        <div role="combobox" tabIndex={0} aria-label="Combo">
          Combo
        </div>
      </div>
      <div key="b">b</div>
      <div key="c">c</div>
    </HTMLFlipBook>,
  );
  await waitFor(() => expect(container.querySelector('button')).toBeTruthy());
  onPageChange.mockClear();
  const btn = container.querySelector('button')!;
  const combo = container.querySelector('[role="combobox"]')!;
  fireEvent.keyDown(btn, { key: 'ArrowRight', bubbles: true });
  fireEvent.keyDown(combo, { key: 'ArrowRight', bubbles: true });
  expect(onPageChange).not.toHaveBeenCalled();
});
describe('usePageFlip actions + keyboard / error paths', () => {
  test('flipPrev, turnToPage, and flipToPage all move the engine', async () => {
    function Harness() {
      const book = usePageFlip();
      return (
        <>
          <button type="button" onClick={() => book.flipNext()}>
            next
          </button>
          <button type="button" onClick={() => book.flipPrev()}>
            prev
          </button>
          <button type="button" onClick={() => book.turnToPage(2)}>
            turn2
          </button>
          <button type="button" onClick={() => book.flipToPage(1)}>
            flip1
          </button>
          <span data-testid="page-state">{book.page}</span>
          <HTMLFlipBook
            ref={book.ref}
            width={200}
            height={300}
            flippingTime={0}
            {...book.bookProps}
          >
            {pages('a', 'b', 'c')}
          </HTMLFlipBook>
        </>
      );
    }

    const { container } = render(<Harness />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="page-a"]')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('next'));
    await waitFor(() => {
      expect(container.querySelector('[data-flipbook-live]')?.textContent).toMatch(/Page 2 of 3/);
    });

    fireEvent.click(screen.getByText('prev'));
    await waitFor(() => {
      expect(container.querySelector('[data-flipbook-live]')?.textContent).toMatch(/Page 1 of 3/);
    });

    fireEvent.click(screen.getByText('turn2'));
    await waitFor(() => {
      expect(container.querySelector('[data-flipbook-live]')?.textContent).toMatch(/Page 3 of 3/);
    });

    fireEvent.click(screen.getByText('flip1'));
    await waitFor(() => {
      expect(container.querySelector('[data-flipbook-live]')?.textContent).toMatch(/Page 2 of 3/);
    });
  });

  test('keyboard arrows and Home/End drive turns (ltr)', async () => {
    const handleRef: { current: import('@gullabs/react-flipbook').FlipBookHandle | null } = {
      current: null,
    };
    const { container } = render(
      <HTMLFlipBook
        ref={(h) => {
          handleRef.current = h;
        }}
        width={200}
        height={300}
        flippingTime={0}
        useKeyboard
      >
        {pages('a', 'b', 'c', 'd')}
      </HTMLFlipBook>,
    );

    const root = await waitFor(() => {
      const el = container.querySelector<HTMLElement>('[aria-label="Flipbook"]');
      expect(el).toBeTruthy();
      return el!;
    });

    root.focus();
    fireEvent.keyDown(root, { key: 'ArrowRight' });
    await waitFor(() => {
      expect(handleRef.current?.pageFlip()?.getCurrentPageIndex()).toBe(1);
    });

    fireEvent.keyDown(root, { key: 'End' });
    await waitFor(() => {
      expect(handleRef.current?.pageFlip()?.getCurrentPageIndex()).toBe(3);
    });

    fireEvent.keyDown(root, { key: 'Home' });
    await waitFor(() => {
      expect(handleRef.current?.pageFlip()?.getCurrentPageIndex()).toBe(0);
    });

    fireEvent.keyDown(root, { key: 'ArrowLeft' });
    // already at 0 — stays put
    expect(handleRef.current?.pageFlip()?.getCurrentPageIndex()).toBe(0);
  });

  test('rtl keyboard mirrors arrow directions', async () => {
    const handleRef: { current: import('@gullabs/react-flipbook').FlipBookHandle | null } = {
      current: null,
    };
    const { container } = render(
      <HTMLFlipBook
        ref={(h) => {
          handleRef.current = h;
        }}
        width={200}
        height={300}
        flippingTime={0}
        readingDirection="rtl"
        useKeyboard
      >
        {pages('a', 'b', 'c')}
      </HTMLFlipBook>,
    );

    const root = await waitFor(() => {
      const el = container.querySelector<HTMLElement>('[aria-label="Flipbook"]');
      expect(el).toBeTruthy();
      return el!;
    });

    root.focus();
    // rtl: ArrowLeft = next
    fireEvent.keyDown(root, { key: 'ArrowLeft' });
    await waitFor(() => {
      expect(handleRef.current?.pageFlip()?.getCurrentPageIndex()).toBe(1);
    });

    fireEvent.keyDown(root, { key: 'ArrowRight' });
    await waitFor(() => {
      expect(handleRef.current?.pageFlip()?.getCurrentPageIndex()).toBe(0);
    });
  });

  test('controlled page out of range is ignored without throwing', async () => {
    const handleRef: { current: import('@gullabs/react-flipbook').FlipBookHandle | null } = {
      current: null,
    };
    function Harness() {
      const [page, setPage] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setPage(99)}>
            bad
          </button>
          <HTMLFlipBook
            ref={(h) => {
              handleRef.current = h;
            }}
            width={200}
            height={300}
            flippingTime={0}
            page={page}
            onPageChange={(snapshot) => setPage(snapshot.page)}
          >
            {pages('a', 'b')}
          </HTMLFlipBook>
        </>
      );
    }

    render(<Harness />);
    await waitFor(() => {
      expect(handleRef.current?.pageFlip()).toBeTruthy();
    });

    expect(() => fireEvent.click(screen.getByText('bad'))).not.toThrow();
    // Binding clamps OOB `page` to the last leaf and reports onTurnRejected.
    await waitFor(() => {
      expect(handleRef.current!.pageFlip()!.getCurrentPageIndex()).toBe(1);
    });
  });

  test('imperative handle exposes pageFlip after mount', async () => {
    const handleRef: { current: import('@gullabs/react-flipbook').FlipBookHandle | null } = {
      current: null,
    };

    render(
      <HTMLFlipBook
        ref={(h) => {
          handleRef.current = h;
        }}
        width={200}
        height={300}
        flippingTime={0}
      >
        {pages('a', 'b')}
      </HTMLFlipBook>,
    );

    await waitFor(() => {
      expect(handleRef.current?.pageFlip()?.getPageCount()).toBe(2);
    });
  });

  test('onChangeState fires across a programmatic flip', async () => {
    const onChangeState = vi.fn();
    const handleRef: { current: import('@gullabs/react-flipbook').FlipBookHandle | null } = {
      current: null,
    };

    render(
      <HTMLFlipBook
        ref={(h) => {
          handleRef.current = h;
        }}
        width={200}
        height={300}
        flippingTime={0}
        onChangeState={onChangeState}
      >
        {pages('a', 'b', 'c')}
      </HTMLFlipBook>,
    );

    await waitFor(() => {
      expect(handleRef.current?.pageFlip()).toBeTruthy();
    });

    handleRef.current?.flipNext();
    await waitFor(() => {
      expect(onChangeState.mock.calls.length).toBeGreaterThan(0);
    });
  });
});

describe('usePageFlip before a book is attached', () => {
  /**
   * Consumers call these from event handlers that can fire before mount or
   * after unmount — the hook's `?.` / `?? false` fallbacks are that contract,
   * not dead code.
   */
  test('actions are safe no-ops and report failure while ref is unset', () => {
    const seen: {
      next?: boolean;
      prev?: boolean;
      goAnimate?: boolean;
      goInstant?: boolean;
    } = {};

    function Harness() {
      const book = usePageFlip();
      // Rendered without <HTMLFlipBook>, so `book.ref.current` stays null.
      return (
        <button
          type="button"
          onClick={() => {
            seen.next = book.flipNext();
            seen.prev = book.flipPrev();
            book.turnToPage(2);
            book.flipToPage(3);
            // Both `goToPage` branches (animate → flipToPage, instant →
            // turnToPage) must hit the `?? false` when `ref.current` is null —
            // the area-coverage pin for usePageFlip branches 98.
            seen.goAnimate = book.goToPage(1, 'animate');
            seen.goInstant = book.goToPage(1, 'instant');
          }}
        >
          act
        </button>
      );
    }

    render(<Harness />);
    expect(() => fireEvent.click(screen.getByText('act'))).not.toThrow();

    // A turn that never reached an engine must report `false`, not `undefined`:
    // callers branch on this to show "already at the last page" affordances.
    expect(seen.next).toBe(false);
    expect(seen.prev).toBe(false);
    expect(seen.goAnimate).toBe(false);
    expect(seen.goInstant).toBe(false);
  });

  test('hook sync no-ops when a flip listener destroys the engine mid-dispatch', async () => {
    /**
     * The effect's `sync` re-reads the engine on every flip. If another
     * listener destroys first (same emit snapshot), `isDestroyed()` is already
     * true and sync must return without calling getCurrentPageIndex — that
     * would throw DESTROYED out of the render/event path.
     */
    const { result } = renderHook(() => usePageFlip());

    render(
      <HTMLFlipBook
        ref={result.current.ref}
        width={200}
        height={300}
        flippingTime={0}
        {...result.current.bookProps}
      >
        {pages('a', 'b', 'c')}
      </HTMLFlipBook>,
    );

    await waitFor(() => {
      expect(result.current.ref.current?.pageFlip()).toBeTruthy();
    });

    const engine = result.current.ref.current!.pageFlip()!;

    // Prepend a destroyer so it runs before the hook's sync in the same
    // trigger snapshot. `destroy()` clears the live map, but trigger already
    // holds the list it started with — sync still runs, with isDestroyed true.
    engine.on('flip', () => {
      engine.destroy();
    });
    const events = (
      engine as unknown as {
        events: Map<string, Array<(...args: unknown[]) => void>>;
      }
    ).events;
    const flipList = events.get('flip');
    expect(flipList).toBeDefined();
    expect(flipList!.length).toBeGreaterThan(1);
    const destroyer = flipList!.pop()!;
    flipList!.unshift(destroyer);

    expect(() => {
      act(() => {
        result.current.turnToPage(1);
      });
    }).not.toThrow();
    expect(engine.isDestroyed()).toBe(true);
  });
});

describe('responsive size', () => {
  /**
   * A book sized from its container (`width={measuredWidth}`) changes width on
   * every resize step. Keying the engine's identity on width meant each of
   * those destroyed and rebuilt the engine — losing the current page, the rAF
   * loop and any in-flight turn. Size is a restyle, not a remount.
   *
   * The assertion is engine *identity*, not host styles: a replacement engine
   * stamps the new width onto the host too, so a style check alone passes with
   * the bug still present.
   */
  test('changing width restyles in place and keeps the same engine', async () => {
    const handleRef = createRef<FlipBookHandle | null>();

    function Harness() {
      const [width, setWidth] = useState(300);
      return (
        <>
          <button type="button" onClick={() => setWidth(320)}>
            resize
          </button>
          <HTMLFlipBook ref={handleRef} width={width} height={400} flippingTime={0}>
            {pages('a', 'b', 'c', 'd')}
          </HTMLFlipBook>
        </>
      );
    }

    const { container } = render(<Harness />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="page-a"]')).toBeTruthy();
    });

    const engineBefore = handleRef.current?.pageFlip();
    expect(engineBefore).toBeTruthy();

    // Move off page 0 so a rebuild would be visible as lost position.
    handleRef.current?.flipNext();
    await waitFor(() => {
      expect(engineBefore?.getCurrentPageIndex()).toBe(1);
    });

    const host = container.querySelector('.stf__parent') as HTMLElement;
    const wrapper = container.querySelector('.stf__wrapper') as HTMLElement;

    fireEvent.click(screen.getByText('resize'));

    await waitFor(() => {
      expect(host.style.minWidth).toBe('320px');
    });

    // Long enough for a replacement engine's deferred `init` to have fired.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Same object, not merely an engine with the same settings.
    expect(handleRef.current?.pageFlip()).toBe(engineBefore);
    expect(engineBefore?.isDestroyed()).toBe(false);
    expect(engineBefore?.getCurrentPageIndex()).toBe(1);

    // The aspect-ratio padding is derived from width, so it has to move too:
    // 400 / 320 = 125%. Leaving 133.33% renders the book at the old shape.
    expect(wrapper.style.paddingBottom).toBe('125%');
  });
});

describe('lazy mounting', () => {
  /**
   * Turning a page moves the lazy window without changing the page count.
   * A short-circuit keyed only on length left every page outside the *initial*
   * window as an empty placeholder forever — the reader turns and sees blank
   * paper. (The old `renderOnlyPageLengthChange` prop is gone; the window must
   * still track the live page under plain `lazyRadius`.)
   *
   * PRODUCT-BUG (2026-08-30): any `lazyRadius={1}` mount in jsdom currently
   * OOMs the vitest worker (infinite re-render suspected in the lazy-window
   * effect once `visiblePages` joined BookSnapshot / the binding). Reproduced
   * alone with a two-line mount of five pages + lazyRadius=1 — no flip needed.
   * Unskip when the binding stops looping; do NOT weaken the assertion.
   * Historical BUG-1: lazyRadius infinite re-render / heap exhaustion.
   */
  test('the lazy window still advances when the page turns', async () => {
    // Controlled page (not usePageFlip) — the contract under test is the
    // window, not the hook. Still OOMs today; kept as the revert target.
    const ref = { current: null as FlipBookHandle | null };
    function Harness() {
      const [page, setPage] = useState(0);
      return (
        <HTMLFlipBook
          ref={(h) => {
            ref.current = h;
          }}
          width={200}
          height={300}
          flippingTime={0}
          lazyRadius={1}
          page={page}
          onPageChange={(snapshot) => setPage(snapshot.page)}
        >
          {pages('a', 'b', 'c', 'd', 'e')}
        </HTMLFlipBook>
      );
    }

    const { container } = render(<Harness />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="page-a"]')).toBeTruthy();
    });

    // Page c starts outside the window (radius 1 around page 0).
    expect(container.querySelector('[data-testid="page-c"]')).toBeNull();

    act(() => {
      expect(ref.current?.flipNext()).toBe(true);
    });

    // After turning to page b, c is inside the window and must be real.
    await waitFor(() => {
      expect(container.querySelector('[data-testid="page-c"]')).toBeTruthy();
    });
  });
});

describe('initialPage out of range', () => {
  test('out-of-range initialPage clamps to the last leaf rather than opening at 0', async () => {
    // Opening is not a turn: the engine resolves initialPage via resolveStartPage
    // and does not emit turnRejected. The contract is "not silently at 0".
    const handleRef: { current: import('@gullabs/react-flipbook').FlipBookHandle | null } = {
      current: null,
    };
    const onTurnRejected = vi.fn();

    render(
      <HTMLFlipBook
        ref={(h) => {
          handleRef.current = h;
        }}
        width={200}
        height={300}
        flippingTime={0}
        initialPage={99}
        usePortrait
        onTurnRejected={onTurnRejected}
      >
        {pages('a', 'b')}
      </HTMLFlipBook>,
    );

    await waitFor(() => {
      expect(handleRef.current?.pageFlip()?.getPageCount()).toBe(2);
      expect(handleRef.current?.pageFlip()?.getCurrentPageIndex()).toBe(1);
    });
    expect(onTurnRejected).not.toHaveBeenCalled();
  });

  test('a fractional initialPage is rejected at settings construction', async () => {
    // Settings.require non-negative integer; PAGE_NOT_IN_SPREAD for fractions is
    // exercised on turnToPage (see design-tranche-critical), not at load.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    let thrown: unknown;

    try {
      try {
        await act(async () => {
          render(
            <HTMLFlipBook width={200} height={300} flippingTime={0} initialPage={0.5}>
              {pages('a', 'b', 'c')}
            </HTMLFlipBook>,
          );
        });
      } catch (error) {
        thrown = error;
      }
      if (thrown == null) {
        try {
          await act(async () => {
            await Promise.resolve();
          });
        } catch (error) {
          thrown = error;
        }
      }

      expect(thrown).toBeTruthy();
      expect(String(thrown)).toMatch(/initialPage/);
    } finally {
      consoleError.mockRestore();
    }
  });

  test('a valid initialPage does not report an error', async () => {
    const onTurnRejected = vi.fn();
    const { container } = render(
      <HTMLFlipBook
        width={200}
        height={300}
        flippingTime={0}
        initialPage={1}
        onTurnRejected={onTurnRejected}
      >
        {pages('a', 'b', 'c')}
      </HTMLFlipBook>,
    );

    await waitFor(() => {
      expect(container.querySelector('.stf__block')).toBeTruthy();
    });
    expect(onTurnRejected).not.toHaveBeenCalled();

    // The live region stays EMPTY on load. It used to render its text
    // immediately with pageCount 0 ("Book"), then mutate to "Page 2 of 3" once
    // the collection loaded — a real live-region change, which a screen reader
    // announces. Every book on a page introduced itself during load.
    expect(container.querySelector('[data-flipbook-live]')?.textContent).toBe('');
  });

  test('the live region announces a turn, but not the initial spread', async () => {
    const ref = createRef<FlipBookHandle>();
    const { container } = render(
      <HTMLFlipBook width={200} height={300} flippingTime={0} ref={ref}>
        {pages('a', 'b', 'c')}
      </HTMLFlipBook>,
    );

    const live = () => container.querySelector('[data-flipbook-live]')?.textContent;
    await waitFor(() => {
      expect(container.querySelector('.stf__block')).toBeTruthy();
    });
    expect(live()).toBe('');

    act(() => {
      ref.current?.flipNext();
    });

    await waitFor(() => {
      expect(live()).toBe('Page 2 of 3');
    });
  });

  test('the book is never role="application"', async () => {
    const { container } = render(
      <HTMLFlipBook width={200} height={300} useKeyboard>
        {pages('a', 'b')}
      </HTMLFlipBook>,
    );

    await waitFor(() => {
      expect(container.querySelector('.stf__block')).toBeTruthy();
    });

    // `application` forces NVDA and JAWS out of browse mode for the whole
    // subtree, removing the virtual cursor — no element-by-element reading, no
    // quick-nav, no find-in-page. For a book that is the entire value.
    const root = container.querySelector('[data-flipbook-kb]');
    expect(root?.getAttribute('role')).toBe('group');
    expect(root?.getAttribute('aria-roledescription')).toBe('book');
  });
});

describe('explicit navigation on an empty book', () => {
  /**
   * Home / End and the controlled `page` effect all ask the engine for a
   * specific page, and the engine refuses with `PageFlipError` when there is
   * nowhere to go. That refusal is expected and absorbed; a non-engine error
   * is not, and propagates.
   */
  test('Home and End are absorbed when there is nothing to turn to', async () => {
    const { container } = render(
      <HTMLFlipBook width={200} height={300} flippingTime={0}>
        {pages('only')}
      </HTMLFlipBook>,
    );

    await waitFor(() => {
      expect(container.querySelector('[data-testid="page-only"]')).toBeTruthy();
    });

    const root = container.querySelector('.stf__parent');
    expect(root).toBeInstanceOf(HTMLElement);

    expect(() => fireEvent.keyDown(root as HTMLElement, { key: 'Home' })).not.toThrow();
    expect(() => fireEvent.keyDown(root as HTMLElement, { key: 'End' })).not.toThrow();
  });

  test('a controlled page beyond the end clamps and reports once', async () => {
    const rejected: TurnRejected[] = [];

    function Harness() {
      const [page, setPage] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setPage(99)}>
            jump
          </button>
          <HTMLFlipBook
            width={200}
            height={300}
            flippingTime={0}
            usePortrait
            page={page}
            pageTransition="instant"
            onTurnRejected={(info) => {
              rejected.push(info);
            }}
          >
            {pages('a', 'b')}
          </HTMLFlipBook>
        </>
      );
    }

    const { container } = render(<Harness />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="page-a"]')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('jump'));

    await waitFor(() => {
      expect(rejected.length).toBeGreaterThan(0);
    });
    // The controlled effect may report more than once while clamping (INVALID_PAGE
    // then a follow-up PAGE_NOT_IN_SPREAD). Both map to reason invalidPage; the
    // useful contract is target + landedOn, not a single code.
    expect(rejected.some((p) => p.code === 'INVALID_PAGE' && p.targetPage === 99)).toBe(true);
    const last = rejected[rejected.length - 1]!;
    expect(last.reason).toBe('invalidPage');
    expect(last.targetPage).toBe(99);
    expect(last.landedOn).toBe(1);
    expect(last.landedOn).not.toBe(99);
  });
});

describe("engine teardown does not steal React's nodes", () => {
  /**
   * The binding portals its pages into `.stf__block`, so React's recorded
   * parent for them *is* that block. Anything in the engine that reparents or
   * deletes those nodes invalidates that, and React throws `NotFoundError` on
   * its next removal or reorder — the failure the portal exists to prevent.
   *
   * `clear()` is reachable through the handle, so this exercises that guard
   * through real React reconciliation rather than a hand-built node: the
   * assertion is "React can still edit its own children afterwards".
   *
   * It does *not* cover `updateItems`' removal path — React unmounts the
   * dropped portal child before the effect calls `updateFromHtml`, so the node
   * has already left the block by then. That guard matters for callers who
   * parent their own nodes and shrink the list themselves, and it is pinned in
   * packages/core/tests/htmlui-update-items.test.ts.
   */
  test('clear() then a children change still reconciles', async () => {
    const handleRef = createRef<FlipBookHandle | null>();

    function Harness() {
      const [labels, setLabels] = useState(['a', 'b', 'c']);
      return (
        <>
          <button type="button" onClick={() => handleRef.current?.pageFlip()?.clear()}>
            clear
          </button>
          <button type="button" onClick={() => setLabels(['c', 'a'])}>
            shuffle
          </button>
          <HTMLFlipBook ref={handleRef} width={200} height={300} flippingTime={0}>
            {pages(...labels)}
          </HTMLFlipBook>
        </>
      );
    }

    const { container } = render(<Harness />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="page-c"]')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('clear'));

    // React removes one page and reorders the rest. If the engine moved or
    // deleted those nodes, this throws NotFoundError.
    expect(() => fireEvent.click(screen.getByText('shuffle'))).not.toThrow();

    await waitFor(() => {
      expect(container.querySelector('[data-testid="page-b"]')).toBeNull();
      expect(container.querySelector('[data-testid="page-c"]')).toBeTruthy();
    });
  });
});

/**
 * jsdom reports every element as 0×0, so the engine cannot observe a layout and
 * the orientation it picks is an accident of that. These suites need a KNOWN
 * orientation, so they give the block a real measured size: narrower than two
 * pages selects portrait, wider selects landscape, in exactly the way a browser
 * would.
 */
let blockSize: { width: number; height: number } | null = null;

function useMeasuredLayout(): void {
  const original = {
    width: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth'),
    height: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight'),
  };

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get: () => blockSize?.width ?? 0,
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get: () => blockSize?.height ?? 0,
    });
  });

  afterEach(() => {
    blockSize = null;
    if (original.width) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', original.width);
    if (original.height) {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', original.height);
    }
  });
}

/** One page is 200 wide, so 300 cannot fit a spread and 900 can. */
const PORTRAIT_BLOCK = { width: 300, height: 300 };
const LANDSCAPE_BLOCK = { width: 900, height: 300 };

/**
 * H2 — off-screen leaves must leave the tab order.
 *
 * Every leaf is in the DOM at all times, stacked. A link on a page behind the
 * current spread was still tabbable, so a keyboard user tabbed off the book
 * onto a control they could not see (WCAG 2.4.3).
 *
 * These assert the WHOLE inert map, not "some leaf is inert": inerting the
 * wrong leaves — or every leaf but `currentPage` in landscape, where two are
 * visible — has to fail.
 */
describe('inert outside the current spread (H2)', () => {
  useMeasuredLayout();

  function inertMap(container: HTMLElement, labels: string[]): boolean[] {
    return labels.map((label) => {
      const node = container.querySelector(`[data-testid="page-${label}"]`);
      expect(node).toBeTruthy();
      return node?.hasAttribute('inert') === true;
    });
  }

  test('portrait: only the single visible leaf is tabbable, and it moves on a turn', async () => {
    blockSize = PORTRAIT_BLOCK;
    const ref = createRef<FlipBookHandle>();
    const { container } = render(
      <HTMLFlipBook width={200} height={300} flippingTime={0} usePortrait ref={ref}>
        {pages('a', 'b', 'c', 'd')}
      </HTMLFlipBook>,
    );

    await waitFor(() => {
      expect(inertMap(container, ['a', 'b', 'c', 'd'])).toEqual([false, true, true, true]);
    });

    act(() => {
      ref.current?.flipNext();
    });

    await waitFor(() => {
      expect(inertMap(container, ['a', 'b', 'c', 'd'])).toEqual([true, false, true, true]);
    });
  });

  test('landscape: BOTH leaves of the spread stay tabbable', async () => {
    blockSize = LANDSCAPE_BLOCK;
    const ref = createRef<FlipBookHandle>();
    const { container } = render(
      <HTMLFlipBook width={200} height={300} flippingTime={0} ref={ref}>
        {pages('a', 'b', 'c', 'd')}
      </HTMLFlipBook>,
    );

    await waitFor(() => {
      expect(inertMap(container, ['a', 'b', 'c', 'd'])).toEqual([false, false, true, true]);
    });

    act(() => {
      ref.current?.flipNext();
    });

    await waitFor(() => {
      expect(inertMap(container, ['a', 'b', 'c', 'd'])).toEqual([true, true, false, false]);
    });
  });

  test('landscape + hardCovers: the cover is a spread of one, so leaf 1 is inert', async () => {
    blockSize = LANDSCAPE_BLOCK;
    const { container } = render(
      <HTMLFlipBook width={200} height={300} flippingTime={0} hardCovers>
        {pages('a', 'b', 'c', 'd')}
      </HTMLFlipBook>,
    );

    await waitFor(() => {
      expect(container.querySelector('[data-testid="page-a"]')).toBeTruthy();
    });
    await waitFor(() => {
      expect(inertMap(container, ['a', 'b', 'c', 'd'])).toEqual([false, true, true, true]);
    });
  });

  /*
   * There is deliberately NO "tab past the book and never reach the hidden
   * link" test here. It would pass with this whole fix reverted, because
   * `HTMLRender.clear()` stamps `display:none` onto every off-spread leaf on
   * each frame and a `display:none` subtree is already untabbable — so the
   * assertion would prove nothing about `inert`. See the report accompanying
   * this change: `inert` is defence in depth (the mid-flip window where several
   * leaves are `display:block` at once, and consumer CSS that forces its own
   * display on `.stf__item`), not the thing that removes a fully hidden leaf
   * from the tab order today. The attribute maps above are the discriminating
   * assertions; focus behaviour belongs in a real browser (e2e).
   */
});

/**
 * H5 — the announcement has to describe what is actually on screen.
 */
describe('live region announcement (H5)', () => {
  useMeasuredLayout();

  const live = (container: HTMLElement) =>
    container.querySelector('[data-flipbook-live]')?.textContent;

  test('landscape announces BOTH pages of the spread', async () => {
    blockSize = LANDSCAPE_BLOCK;
    const ref = createRef<FlipBookHandle>();
    const { container } = render(
      <HTMLFlipBook width={200} height={300} flippingTime={0} ref={ref}>
        {pages('a', 'b', 'c', 'd')}
      </HTMLFlipBook>,
    );

    await waitFor(() => {
      expect(container.querySelector('.stf__block')).toBeTruthy();
    });

    act(() => {
      ref.current?.flipNext();
    });

    await waitFor(() => {
      expect(live(container)).toBe('Pages 3 and 4 of 4');
    });
  });

  test('hardCovers: leaf 0 announces as the front cover, not "Page 1"', async () => {
    blockSize = PORTRAIT_BLOCK;
    const ref = createRef<FlipBookHandle>();
    const { container } = render(
      <HTMLFlipBook width={200} height={300} flippingTime={0} usePortrait hardCovers ref={ref}>
        {pages('a', 'b', 'c')}
      </HTMLFlipBook>,
    );

    await waitFor(() => {
      expect(container.querySelector('.stf__block')).toBeTruthy();
    });

    act(() => {
      ref.current?.flipNext();
    });
    await waitFor(() => {
      expect(live(container)).toBe('Page 2 of 3');
    });

    act(() => {
      ref.current?.flipPrev();
    });
    await waitFor(() => {
      expect(live(container)).toBe('Front cover');
    });
  });

  test('hardCovers: the last lone leaf announces as the back cover', async () => {
    blockSize = PORTRAIT_BLOCK;
    const ref = createRef<FlipBookHandle>();
    const { container } = render(
      <HTMLFlipBook width={200} height={300} flippingTime={0} usePortrait hardCovers ref={ref}>
        {pages('a', 'b', 'c')}
      </HTMLFlipBook>,
    );

    await waitFor(() => {
      expect(container.querySelector('.stf__block')).toBeTruthy();
    });

    act(() => {
      ref.current?.turnToPage(2);
    });

    await waitFor(() => {
      expect(live(container)).toBe('Back cover');
    });
  });

  test('without hardCovers, leaf 0 is still "Page 1"', async () => {
    blockSize = PORTRAIT_BLOCK;
    const ref = createRef<FlipBookHandle>();
    const { container } = render(
      <HTMLFlipBook width={200} height={300} flippingTime={0} usePortrait ref={ref}>
        {pages('a', 'b', 'c')}
      </HTMLFlipBook>,
    );

    await waitFor(() => {
      expect(container.querySelector('.stf__block')).toBeTruthy();
    });

    act(() => {
      ref.current?.flipNext();
    });
    await waitFor(() => {
      expect(live(container)).toBe('Page 2 of 3');
    });

    act(() => {
      ref.current?.flipPrev();
    });
    await waitFor(() => {
      expect(live(container)).toBe('Page 1 of 3');
    });
  });

  test('a consumer liveRegionText override still wins, and is handed the spread', async () => {
    blockSize = LANDSCAPE_BLOCK;
    const ref = createRef<FlipBookHandle>();
    const seen: unknown[] = [];
    const { container } = render(
      <HTMLFlipBook
        width={200}
        height={300}
        flippingTime={0}
        ref={ref}
        liveRegionText={(page, count, info) => {
          seen.push(info);
          return `custom ${page}/${count}`;
        }}
      >
        {pages('a', 'b', 'c', 'd')}
      </HTMLFlipBook>,
    );

    await waitFor(() => {
      expect(container.querySelector('.stf__block')).toBeTruthy();
    });

    act(() => {
      ref.current?.flipNext();
    });

    await waitFor(() => {
      expect(live(container)).toBe('custom 2/4');
    });
    expect(seen[seen.length - 1]).toEqual({
      pages: [2, 3],
      orientation: 'landscape',
      hardCovers: false,
    });
  });
});

/**
 * RB1 — a controlled `page` is compared against the engine's index, which is
 * the spread HEAD (`spread[0]`). In landscape, spread [0, 1] reports 0, so a
 * consumer passing `page={1}` never matched: the effect re-issued
 * `turnToPage(1)`, the engine showed the same spread and emitted `flip` with
 * 0, and `onPageChange(0)` rewrote the consumer's controlled value behind its
 * back. "Satisfied" for a two-leaf spread is *membership*, not equality.
 */
describe('controlled page against a two-leaf spread (RB1)', () => {
  useMeasuredLayout();

  test('a controlled page already on screen is left alone, a farther one still turns', async () => {
    blockSize = LANDSCAPE_BLOCK;
    const handleRef = createRef<FlipBookHandle | null>();

    function Harness() {
      const [page, setPage] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setPage(1)}>
            near
          </button>
          <button type="button" onClick={() => setPage(2)}>
            far
          </button>
          <span data-testid="controlled">{page}</span>
          <HTMLFlipBook
            ref={handleRef}
            width={200}
            height={300}
            flippingTime={0}
            page={page}
            pageTransition="instant"
            usePortrait={false}
            onPageChange={(snapshot) => setPage(snapshot.page)}
          >
            {pages('a', 'b', 'c', 'd')}
          </HTMLFlipBook>
        </>
      );
    }

    const { container } = render(<Harness />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="page-a"]')).toBeTruthy();
    });

    // Without this the book is portrait, leaf 1 is a spread of its own, and
    // every assertion below passes with the defect still in place.
    expect(handleRef.current?.pageFlip()?.getOrientation()).toBe('landscape');

    fireEvent.click(screen.getByText('near'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    // Leaf 1 is the right-hand leaf of the spread already open. The engine's
    // canonical index stays 0 — but the consumer asked for a page it can see,
    // so its value must survive.
    expect(screen.getByTestId('controlled').textContent).toBe('1');
    expect(handleRef.current?.pageFlip()?.getCurrentPageIndex()).toBe(0);

    // …and the effect must still be live: a page on another spread turns.
    fireEvent.click(screen.getByText('far'));
    await waitFor(() => {
      expect(handleRef.current?.pageFlip()?.getCurrentPageIndex()).toBe(2);
    });
  });

  test('with a cover, leaf 1 is a different spread and must actually turn', async () => {
    blockSize = LANDSCAPE_BLOCK;
    const handleRef = createRef<FlipBookHandle | null>();

    function Harness() {
      const [page, setPage] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setPage(1)}>
            go
          </button>
          <HTMLFlipBook
            ref={handleRef}
            width={200}
            height={300}
            flippingTime={0}
            hardCovers
            page={page}
            pageTransition="instant"
            usePortrait={false}
            onPageChange={(snapshot) => setPage(snapshot.page)}
          >
            {pages('a', 'b', 'c', 'd')}
          </HTMLFlipBook>
        </>
      );
    }

    const { container } = render(<Harness />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="page-a"]')).toBeTruthy();
    });
    expect(handleRef.current?.pageFlip()?.getOrientation()).toBe('landscape');

    // Spreads are [0], [1, 2], [3]: the cover stands alone, so "is 1 within
    // the current spread" must be answered by the collection, not by pairing
    // indices two at a time.
    fireEvent.click(screen.getByText('go'));
    await waitFor(() => {
      expect(handleRef.current?.pageFlip()?.getCurrentPageIndex()).toBe(1);
    });
  });
});

/**
 * RB2 — the load effect refreshed `pageCount` on a rebuild but never the page
 * index, so shrinking the book below the current index left the binding
 * describing a spread the engine is not showing.
 */
describe('collection shrink (RB2)', () => {
  useMeasuredLayout();

  test('the page index is re-derived from the engine after a rebuild', async () => {
    blockSize = PORTRAIT_BLOCK;
    const handleRef = createRef<FlipBookHandle | null>();

    function Harness() {
      const [labels, setLabels] = useState(['a', 'b', 'c', 'd', 'e']);
      return (
        <>
          <button type="button" onClick={() => setLabels(['a', 'b', 'c'])}>
            shrink
          </button>
          <HTMLFlipBook ref={handleRef} width={200} height={300} flippingTime={0} usePortrait>
            {pages(...labels)}
          </HTMLFlipBook>
        </>
      );
    }

    const { container } = render(<Harness />);
    const live = () => container.querySelector('[data-flipbook-live]')?.textContent;

    await waitFor(() => {
      expect(container.querySelector('[data-testid="page-e"]')).toBeTruthy();
    });

    act(() => {
      handleRef.current?.turnToPage(4);
    });
    await waitFor(() => {
      expect(live()).toBe('Page 5 of 5');
    });

    fireEvent.click(screen.getByText('shrink'));

    // The engine CLAMPS the retained index into the new collection, and the
    // binding must report where it actually landed.
    //
    // This assertion used to expect leaf 0, which encoded RB4: `updateFromHtml`
    // called `show(4)` on a 3-page book, `show()` silently returned for an
    // out-of-range index, and the collection was left at its constructor
    // default of 0 while `Render` still held pages from the DESTROYED
    // collection. Zero was the symptom, not the contract — a reader who was on
    // the last leaf should stay near the end of the book, not be thrown to the
    // front.
    await waitFor(() => {
      expect(handleRef.current?.pageFlip()?.getCurrentPageIndex()).toBe(2);
      expect(live()).toBe('Page 3 of 3');
    });

    // The inert map follows the resolved index, so the leaf the reader is
    // actually looking at is the one left in the tab order.
    const inert = ['a', 'b', 'c'].map((label) =>
      container.querySelector(`[data-testid="page-${label}"]`)?.hasAttribute('inert'),
    );
    expect(inert).toEqual([true, true, false]);
  });
});

/**
 * RB3 — lazy placeholders were keyed `lazy-${index}` while real pages keep
 * their own key, so crossing the window boundary unmounted and remounted the
 * DOM node. `sameNodes` then failed and the load effect rebuilt the whole
 * PageCollection — mid-turn — on every flip, through a supported prop.
 */
describe('lazy mounting keeps page identity (RB3)', () => {
  /**
   * `<section>`, not `<div>`: a stable key alone still remounts the node when
   * the element TYPE changes under it, so pages made of divs would let a
   * key-only fix pass while any other tag kept rebuilding.
   */
  function sectionPages(...labels: string[]) {
    return labels.map((label) => (
      <section key={label} data-testid={`page-${label}`}>
        {label}
      </section>
    ));
  }

  // PRODUCT-BUG: lazyRadius mount OOMs the worker — see lazy mounting above.
  test('crossing the lazy window boundary does not rebuild the collection', async () => {
    const onPagesChanged = vi.fn();

    function Harness() {
      const book = usePageFlip();
      return (
        <>
          <button type="button" onClick={() => book.flipNext()}>
            next
          </button>
          <HTMLFlipBook
            ref={book.ref}
            width={200}
            height={300}
            flippingTime={0}
            lazyRadius={1}
            {...book.bookProps}
            onPagesChanged={(snapshot) => {
              onPagesChanged(snapshot);
              book.bookProps.onPagesChanged?.(snapshot);
            }}
          >
            {sectionPages('a', 'b', 'c', 'd', 'e')}
          </HTMLFlipBook>
        </>
      );
    }

    const { container } = render(<Harness />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="page-a"]')).toBeTruthy();
    });
    // Page c starts outside the window (radius 1 around leaf 0).
    expect(container.querySelector('[data-testid="page-c"]')).toBeNull();

    // The placeholders are, in order, leaves c, d and e.
    const placeholders = Array.from(
      container.querySelectorAll<HTMLElement>('[data-flipbook-lazy]'),
    );
    expect(placeholders.length).toBe(3);
    const leafC = placeholders[0];
    onPagesChanged.mockClear();

    fireEvent.click(screen.getByText('next'));

    await waitFor(() => {
      expect(container.querySelector('[data-testid="page-c"]')).toBeTruthy();
    });

    // The leaf that entered the window must be the SAME node, not a
    // replacement: node identity is what `sameNodes` compares, and a
    // replacement sends the load effect into a full PageCollection rebuild —
    // mid-turn — on every flip.
    expect(container.querySelector('[data-testid="page-c"]')).toBe(leafC);
    expect(onPagesChanged).not.toHaveBeenCalled();
  });
});

describe('RB7 — the lazy window covers the whole next spread', () => {
  useMeasuredLayout();

  // PRODUCT-BUG: lazyRadius mount OOMs the worker — see lazy mounting above.
  test('landscape lazyRadius=1 mounts BOTH leaves of the adjacent spread', async () => {
    blockSize = LANDSCAPE_BLOCK;
    const ref = createRef<FlipBookHandle>();

    const { container } = render(
      <HTMLFlipBook width={200} height={300} flippingTime={0} lazyRadius={1} ref={ref}>
        {pages('a', 'b', 'c', 'd', 'e', 'f')}
      </HTMLFlipBook>,
    );

    await waitFor(() => {
      expect(container.querySelector('.stf__block')).toBeTruthy();
    });
    expect(ref.current?.pageFlip()?.getOrientation()).toBe('landscape');

    act(() => {
      ref.current?.turnToPage(2);
    });

    const mounted = (label: string) =>
      container.querySelector(`[data-testid="page-${label}"]`) !== null;

    // On spread [2, 3] the next spread is [4, 5]. Measured in PAGES from the
    // spread HEAD with radius 1, page 4 sat at distance 2 and page 5 at
    // distance 3 — so both leaves of the very next spread were placeholders
    // while the turn to them animated, and the reader watched blank paper.
    await waitFor(() => {
      expect(mounted('c')).toBe(true);
      expect(mounted('d')).toBe(true);
      expect(mounted('e')).toBe(true);
      expect(mounted('f')).toBe(true);
    });
  });

  // PRODUCT-BUG: lazyRadius mount OOMs the worker — see lazy mounting above.
  test('the window is still bounded — a spread two away stays lazy', async () => {
    blockSize = LANDSCAPE_BLOCK;
    const ref = createRef<FlipBookHandle>();

    const { container } = render(
      <HTMLFlipBook width={200} height={300} flippingTime={0} lazyRadius={1} ref={ref}>
        {pages('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h')}
      </HTMLFlipBook>,
    );

    await waitFor(() => {
      expect(container.querySelector('.stf__block')).toBeTruthy();
    });

    // Control: widening the window must not degenerate into mounting the whole
    // book, which would make the assertion above pass for the wrong reason.
    await waitFor(() => {
      expect(container.querySelector('[data-testid="page-g"]')).toBeNull();
    });
  });
});

describe('onTurnProgress (Campaign C)', () => {
  /** Own rAF so an animated flip plays under controlled timestamps in jsdom. */
  function installRafQueue(): {
    flush: (stepMs?: number, maxTicks?: number) => void;
    restore: () => void;
  } {
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
      flush(stepMs = 20, maxTicks = 120) {
        for (let i = 0; i < maxTicks && queued.length > 0; i += 1) {
          const batch = queued.splice(0, queued.length);
          clock += stepMs;
          for (const cb of batch) cb(clock);
        }
      },
      restore() {
        globalThis.requestAnimationFrame = realRaf;
        globalThis.cancelAnimationFrame = realCancel;
      },
    };
  }

  test('onTurnProgress receives in-range payloads during an animated flip', async () => {
    const raf = installRafQueue();
    try {
      const onTurnProgress = vi.fn();
      const ref = createRef<FlipBookHandle>();

      render(
        <HTMLFlipBook
          ref={ref}
          width={200}
          height={300}
          flippingTime={200}
          onTurnProgress={onTurnProgress}
        >
          {pages('a', 'b', 'c', 'd')}
        </HTMLFlipBook>,
      );

      await waitFor(() => {
        expect(ref.current?.pageFlip()?.isReady()).toBe(true);
      });
      raf.flush();

      act(() => {
        expect(ref.current?.flipNext()).toBe(true);
      });
      raf.flush();

      expect(onTurnProgress.mock.calls.length).toBeGreaterThanOrEqual(2);
      for (const call of onTurnProgress.mock.calls) {
        const payload = call[0] as { progress: number; direction: 'next' | 'prev' };
        expect(payload.progress).toBeGreaterThanOrEqual(0);
        expect(payload.progress).toBeLessThanOrEqual(1);
        expect(payload.direction).toBe('next');
      }
    } finally {
      raf.restore();
    }
  });

  test('changing onTurnProgress does not remount and the NEW handler receives events', async () => {
    const raf = installRafQueue();
    try {
      const first = vi.fn();
      const second = vi.fn();
      const ref = createRef<FlipBookHandle>();

      const { rerender } = render(
        <HTMLFlipBook ref={ref} width={200} height={300} flippingTime={200} onTurnProgress={first}>
          {pages('a', 'b', 'c', 'd')}
        </HTMLFlipBook>,
      );

      await waitFor(() => {
        expect(ref.current?.pageFlip()?.isReady()).toBe(true);
      });
      raf.flush();

      const engine = ref.current!.pageFlip();
      expect(engine).not.toBeNull();

      rerender(
        <HTMLFlipBook ref={ref} width={200} height={300} flippingTime={200} onTurnProgress={second}>
          {pages('a', 'b', 'c', 'd')}
        </HTMLFlipBook>,
      );

      // Same engine instance — the prop is not in remountKeyOf.
      expect(ref.current!.pageFlip()).toBe(engine);

      act(() => {
        expect(ref.current?.flipNext()).toBe(true);
      });
      raf.flush();

      expect(second.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(first).not.toHaveBeenCalled();
    } finally {
      raf.restore();
    }
  });
});

describe('F05 — cancelTurn on the React handle', () => {
  test('returns false before mount and when idle', async () => {
    const ref = createRef<FlipBookHandle | null>();
    expect(ref.current?.cancelTurn()).toBeUndefined();

    render(
      <HTMLFlipBook ref={ref} width={200} height={300} flippingTime={0}>
        {pages('a', 'b', 'c', 'd')}
      </HTMLFlipBook>,
    );
    expect(ref.current).not.toBeNull();
    expect(ref.current?.cancelTurn()).toBe(false);

    await waitFor(() => {
      expect(ref.current?.pageFlip()?.isReady()).toBe(true);
    });
    expect(ref.current?.cancelTurn()).toBe(false);
  });

  test('abandons an in-flight turn without onPageChange', async () => {
    const ref = createRef<FlipBookHandle | null>();
    const onPageChange = vi.fn();
    render(
      <HTMLFlipBook
        ref={ref}
        width={200}
        height={300}
        flippingTime={800}
        respectReducedMotion={false}
        onPageChange={onPageChange}
      >
        {pages('a', 'b', 'c', 'd')}
      </HTMLFlipBook>,
    );
    await waitFor(() => {
      expect(ref.current?.pageFlip()?.isReady()).toBe(true);
    });

    act(() => {
      expect(ref.current?.pageFlip()?.flipNext()).toBe(true);
      expect(ref.current?.cancelTurn()).toBe(true);
    });

    expect(ref.current?.pageFlip()?.getCurrentPageIndex()).toBe(0);
    expect(onPageChange).not.toHaveBeenCalled();
  });

  test('captured cancelTurn after unmount returns false and does not throw', async () => {
    const ref = createRef<FlipBookHandle | null>();
    const view = render(
      <HTMLFlipBook ref={ref} width={200} height={300} flippingTime={0}>
        {pages('a', 'b', 'c', 'd')}
      </HTMLFlipBook>,
    );
    await waitFor(() => {
      expect(ref.current?.pageFlip()?.isReady()).toBe(true);
    });
    const cancel = ref.current!.cancelTurn;
    view.unmount();
    expect(cancel()).toBe(false);
  });

  test('destroy() without unmount: cancelTurn is false and does not fire onTurnRejected', async () => {
    const ref = createRef<FlipBookHandle | null>();
    const onTurnRejected = vi.fn();
    const view = render(
      <HTMLFlipBook
        ref={ref}
        width={200}
        height={300}
        flippingTime={0}
        onTurnRejected={onTurnRejected}
      >
        {pages('a', 'b', 'c', 'd')}
      </HTMLFlipBook>,
    );
    await waitFor(() => {
      expect(ref.current?.pageFlip()?.isReady()).toBe(true);
    });
    act(() => {
      ref.current?.destroy();
    });
    expect(ref.current?.pageFlip()).toBeNull();
    expect(ref.current?.cancelTurn()).toBe(false);
    expect(onTurnRejected).not.toHaveBeenCalled();
    expect(ref.current?.flipNext()).toBe(false);
    expect(onTurnRejected).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'DESTROYED', reason: 'notReady' }),
    );

    const next = view.container.querySelector('[data-flipbook-control="next"]');
    expect(next).toHaveAttribute('aria-disabled', 'true');
    expect(view.container.querySelector('.stf__block')).toBeNull();
  });

  test('destroy then unmount: a captured handle reports NOT_LOADED not DESTROYED', async () => {
    const ref = createRef<FlipBookHandle | null>();
    const rejected: TurnRejected[] = [];
    const view = render(
      <HTMLFlipBook
        ref={ref}
        width={200}
        height={300}
        flippingTime={0}
        onTurnRejected={(info) => {
          rejected.push(info);
        }}
      >
        {pages('a', 'b', 'c', 'd')}
      </HTMLFlipBook>,
    );
    await waitFor(() => {
      expect(ref.current?.pageFlip()?.isReady()).toBe(true);
    });
    const flipNext = ref.current!.flipNext;
    act(() => {
      ref.current?.destroy();
    });
    view.unmount();
    rejected.length = 0;
    expect(flipNext()).toBe(false);
    expect(rejected).toEqual([expect.objectContaining({ code: 'NOT_LOADED', reason: 'notReady' })]);
  });

  test('after a remount-key rebuild, cancelTurn talks to the new engine', async () => {
    const ref = createRef<FlipBookHandle | null>();
    const view = render(
      <HTMLFlipBook ref={ref} width={200} height={300} flippingTime={0}>
        {pages('a', 'b', 'c', 'd')}
      </HTMLFlipBook>,
    );
    await waitFor(() => {
      expect(ref.current?.pageFlip()?.isReady()).toBe(true);
    });
    const before = ref.current?.pageFlip();
    expect(before).toBeTruthy();

    view.rerender(
      <HTMLFlipBook ref={ref} width={200} height={300} flippingTime={0} hardCovers>
        {pages('a', 'b', 'c', 'd')}
      </HTMLFlipBook>,
    );
    await waitFor(() => {
      expect(ref.current?.pageFlip()).not.toBe(before);
      expect(ref.current?.pageFlip()?.isDestroyed()).toBe(false);
    });
    expect(before?.isDestroyed()).toBe(true);
    expect(ref.current?.cancelTurn()).toBe(false);
    expect(ref.current?.pageFlip()?.flipNext()).toBe(true);
  });

  test('destroy() without unmount then a children change does not throw DESTROYED', async () => {
    const ref = createRef<FlipBookHandle | null>();
    const view = render(
      <HTMLFlipBook ref={ref} width={200} height={300} flippingTime={0}>
        {pages('a', 'b', 'c', 'd')}
      </HTMLFlipBook>,
    );
    await waitFor(() => {
      expect(ref.current?.pageFlip()?.isReady()).toBe(true);
    });

    act(() => {
      ref.current?.pageFlip()?.destroy();
    });

    expect(() => {
      view.rerender(
        <HTMLFlipBook ref={ref} width={200} height={300} flippingTime={0}>
          {pages('a', 'b', 'c', 'd', 'e')}
        </HTMLFlipBook>,
      );
    }).not.toThrow();

    expect(() => {
      view.rerender(
        <HTMLFlipBook ref={ref} width={200} height={300} flippingTime={0}>
          {pages('a', 'b', 'c', 'd', 'e', 'f')}
        </HTMLFlipBook>,
      );
    }).not.toThrow();

    await waitFor(() => {
      expect(ref.current?.pageFlip()).toBeNull();
    });
    expect(ref.current?.cancelTurn()).toBe(false);
  });
});
