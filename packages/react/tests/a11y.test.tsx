import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRef } from 'react';
import { act, cleanup, render, waitFor, fireEvent } from '@testing-library/react';
import { HTMLFlipBook } from '@gullabs/react-flipbook';
import type { FlipBookHandle } from '@gullabs/react-flipbook';
import { ensureFlipbookStyles } from '@gullabs/flipbook-core';

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

function bookRoot(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('[aria-label="Flipbook"]');
  expect(el).toBeTruthy();
  return el!;
}

/**
 * jsdom measures everything as 0×0, so the orientation the engine picks is an
 * accident. Suites that care give the block a real size, exactly as
 * `HTMLFlipBook.test.tsx` does.
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

const PORTRAIT_BLOCK = { width: 300, height: 300 };
const LANDSCAPE_BLOCK = { width: 900, height: 300 };

/**
 * The book's keyboard shortcuts are the UNMODIFIED Arrow/Home/End keys.
 * Modified ones belong to the browser, and swallowing them (the handler calls
 * `preventDefault`) removes navigation the keyboard user depends on:
 * Alt+ArrowLeft/Right is Back/Forward, Cmd+ArrowLeft is Back on macOS, and
 * Ctrl+Home / Ctrl+End is "top / bottom of document" — the standard way out of
 * a widget for a screen-reader user.
 */
describe('modified shortcuts belong to the browser, not the book', () => {
  test('Alt / Ctrl / Meta arrows neither turn the page nor get preventDefault-ed', async () => {
    const ref = createRef<FlipBookHandle>();
    const { container } = render(
      <HTMLFlipBook width={200} height={300} flippingTime={0} ref={ref}>
        {pages('a', 'b', 'c', 'd')}
      </HTMLFlipBook>,
    );

    const root = await waitFor(() => bookRoot(container));
    await waitFor(() => {
      expect(ref.current?.pageFlip()?.getPageCount()).toBe(4);
    });
    root.focus();

    // `fireEvent` returns false when the event was canceled, so this asserts
    // BOTH halves of the defect: the book must not act, and must not eat the
    // key. A fix that only skipped the turn would still block Back.
    const modifiers = [{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }];
    for (const modifier of modifiers) {
      expect(fireEvent.keyDown(root, { key: 'ArrowRight', ...modifier })).toBe(true);
      expect(fireEvent.keyDown(root, { key: 'ArrowLeft', ...modifier })).toBe(true);
    }
    expect(ref.current?.pageFlip()?.getCurrentPageIndex()).toBe(0);

    // Ctrl+End is "end of document", not "last page of this book".
    expect(fireEvent.keyDown(root, { key: 'End', ctrlKey: true })).toBe(true);
    expect(ref.current?.pageFlip()?.getCurrentPageIndex()).toBe(0);

    // Control: the very same key, unmodified, still turns — so the test cannot
    // pass by the handler being broken outright.
    expect(fireEvent.keyDown(root, { key: 'ArrowRight' })).toBe(false);
    await waitFor(() => {
      expect(ref.current?.pageFlip()?.getCurrentPageIndex()).toBe(1);
    });
  });
});

/**
 * Who owns an Arrow key is decided by FOCUS, not by a selector.
 *
 * The handler used to consult `FLIPBOOK_INTERACTIVE_SELECTOR` — a list built
 * for pointer targets (what must not start a fold). Anything focusable that is
 * not on that list had its arrow keys stolen and canceled.
 */
describe('a focused descendant keeps its own arrow keys', () => {
  test('tabindex region, media element and iframe are not the book’s to steal', async () => {
    const ref = createRef<FlipBookHandle>();
    const { container } = render(
      <HTMLFlipBook width={200} height={300} flippingTime={0} ref={ref}>
        <div key="a">
          <div tabIndex={0} data-testid="scroller" style={{ overflow: 'auto' }}>
            scrollable
          </div>
          <video data-testid="clip" controls />
          <iframe data-testid="frame" title="embedded" />
        </div>
        <div key="b">b</div>
        <div key="c">c</div>
      </HTMLFlipBook>,
    );

    await waitFor(() => {
      expect(ref.current?.pageFlip()?.getPageCount()).toBe(3);
    });

    for (const id of ['scroller', 'clip', 'frame']) {
      const el = container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      expect(el).toBeTruthy();
      // Not canceled: the element's own default behaviour (scrolling the
      // region, seeking the video, moving inside the frame) survives.
      expect(fireEvent.keyDown(el!, { key: 'ArrowRight', bubbles: true })).toBe(true);
      expect(ref.current?.pageFlip()?.getCurrentPageIndex()).toBe(0);
    }
  });
});

/**
 * WCAG 2.4.3. `inert` landing on an ancestor of `document.activeElement` blurs
 * it and focus resets to `<body>` — the keyboard user is silently moved to the
 * top of the document mid-read.
 *
 * HONEST LIMIT: jsdom does not implement `inert` at all, so it never performs
 * that blur. These tests therefore prove that the component MOVES focus to its
 * own root at the right moment (and only then); they cannot prove the browser
 * would otherwise have dropped it. The blur itself is browser behaviour and
 * belongs in `e2e/` — see the report.
 */
describe('focus survives a turn that inerts the leaf holding it', () => {
  useMeasuredLayout();

  test('portrait: focus moves to the book root, not to <body>', async () => {
    blockSize = PORTRAIT_BLOCK;
    const ref = createRef<FlipBookHandle>();
    const { container } = render(
      <HTMLFlipBook width={200} height={300} flippingTime={0} usePortrait ref={ref}>
        <div key="a" data-testid="page-a">
          <button type="button" data-testid="on-page">
            Buy
          </button>
        </div>
        <div key="b" data-testid="page-b">
          b
        </div>
        <div key="c" data-testid="page-c">
          c
        </div>
      </HTMLFlipBook>,
    );

    const root = await waitFor(() => bookRoot(container));
    const onPage = await waitFor(() => {
      const el = container.querySelector<HTMLElement>('[data-testid="on-page"]');
      expect(el).toBeTruthy();
      return el!;
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="page-b"]')?.hasAttribute('inert')).toBe(true);
    });

    onPage.focus();
    expect(document.activeElement).toBe(onPage);

    act(() => {
      ref.current?.flipNext();
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="page-a"]')?.hasAttribute('inert')).toBe(true);
    });
    expect(document.activeElement).toBe(root);
    expect(document.activeElement).not.toBe(document.body);
  });

  test('landscape: leaving a two-leaf spread rescues focus from either leaf', async () => {
    blockSize = LANDSCAPE_BLOCK;
    const ref = createRef<FlipBookHandle>();
    const { container } = render(
      <HTMLFlipBook width={200} height={300} flippingTime={0} ref={ref}>
        <div key="a" data-testid="page-a">
          a
        </div>
        <div key="b" data-testid="page-b">
          <button type="button" data-testid="on-page">
            Buy
          </button>
        </div>
        <div key="c" data-testid="page-c">
          c
        </div>
        <div key="d" data-testid="page-d">
          d
        </div>
      </HTMLFlipBook>,
    );

    const root = await waitFor(() => bookRoot(container));
    await waitFor(() => {
      expect(container.querySelector('[data-testid="page-c"]')?.hasAttribute('inert')).toBe(true);
      // leaf b is the SECOND leaf of the opening spread, so it starts tabbable
      expect(container.querySelector('[data-testid="page-b"]')?.hasAttribute('inert')).toBe(false);
    });

    const onPage = container.querySelector<HTMLElement>('[data-testid="on-page"]')!;
    onPage.focus();
    expect(document.activeElement).toBe(onPage);

    act(() => {
      ref.current?.flipNext();
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="page-b"]')?.hasAttribute('inert')).toBe(true);
    });
    expect(document.activeElement).toBe(root);
  });

  /*
   * The two negative controls. A rescue that fires whenever ANY leaf is inert,
   * or whenever focus is anywhere at all, would pass the tests above and steal
   * focus from the rest of the page — a far worse bug than the one being fixed.
   */
  test('focus OUTSIDE the book is never taken, even though leaves are inert', async () => {
    blockSize = PORTRAIT_BLOCK;
    const outside = document.createElement('button');
    outside.setAttribute('data-testid', 'outside');
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    const ref = createRef<FlipBookHandle>();
    const { container } = render(
      <HTMLFlipBook width={200} height={300} flippingTime={0} usePortrait ref={ref}>
        {pages('a', 'b', 'c')}
      </HTMLFlipBook>,
    );

    await waitFor(() => {
      expect(container.querySelector('[data-testid="page-b"]')?.hasAttribute('inert')).toBe(true);
    });
    expect(document.activeElement).toBe(outside);

    act(() => {
      ref.current?.flipNext();
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="page-a"]')?.hasAttribute('inert')).toBe(true);
    });
    expect(document.activeElement).toBe(outside);

    outside.remove();
  });

  test('focus on a leaf that is STILL visible is left alone when the effect re-runs', async () => {
    blockSize = PORTRAIT_BLOCK;

    function Harness({ extra }: { extra: boolean }) {
      return (
        <HTMLFlipBook width={200} height={300} flippingTime={0} usePortrait>
          <div key="a" data-testid="page-a">
            <button type="button" data-testid="on-page">
              Buy
            </button>
          </div>
          <div key="b" data-testid="page-b">
            b
          </div>
          {extra ? (
            <div key="c" data-testid="page-c">
              c
            </div>
          ) : null}
        </HTMLFlipBook>
      );
    }

    const { container, rerender } = render(<Harness extra={false} />);
    const onPage = await waitFor(() => {
      const el = container.querySelector<HTMLElement>('[data-testid="on-page"]');
      expect(el).toBeTruthy();
      return el!;
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="page-b"]')?.hasAttribute('inert')).toBe(true);
    });

    onPage.focus();
    expect(document.activeElement).toBe(onPage);

    // Adding a leaf re-runs the inert effect without moving the spread. Leaf a
    // is still the visible one, so nothing should touch focus.
    rerender(<Harness extra />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="page-c"]')).toBeTruthy();
    });
    expect(document.activeElement).toBe(onPage);
  });
});

/**
 * `touch-action: pan-y` alone tells the browser that vertical panning is the
 * only gesture it may handle — which disables pinch-to-zoom across the whole
 * book. Magnification is how a low-vision reader reads a picture book (WCAG
 * 1.4.4 / 1.4.10).
 *
 * HONEST LIMIT: this asserts the declaration that ships in the stylesheet the
 * engine injects. Only a real browser can prove the gesture works; jsdom has no
 * compositor and does not even parse `touch-action`.
 */
describe('the injected stylesheet does not disable pinch-to-zoom', () => {
  test('.stf__parent allows pinch-zoom alongside pan-y', () => {
    ensureFlipbookStyles();
    const sheet = document.head.querySelector<HTMLStyleElement>('style[data-gullabs-flipbook]');
    expect(sheet).toBeTruthy();

    const parentRule = /\.stf__parent\{([^}]*)\}/.exec(sheet!.textContent ?? '');
    expect(parentRule).toBeTruthy();
    const declarations = parentRule?.[1] ?? '';

    // Both the standard property and the legacy -ms- alias, and both keywords:
    // dropping `pan-y` would hand vertical scrolling back to the engine (which
    // does not implement it), and dropping `pinch-zoom` is the defect itself.
    for (const property of ['touch-action', '-ms-touch-action']) {
      const value = new RegExp(`(?:^|;)${property}:([^;]*)`).exec(declarations)?.[1];
      expect(value, `${property} is declared`).toBeTruthy();
      expect(value!.split(/\s+/).filter(Boolean).sort()).toEqual(['pan-y', 'pinch-zoom']);
    }
  });

  test('allowTouchScroll false keeps pinch-zoom while dropping pan-y', () => {
    ensureFlipbookStyles();
    const sheet = document.head.querySelector<HTMLStyleElement>('style[data-gullabs-flipbook]');
    const lockRule = /\.stf__parent\.--lock-touch-scroll\{([^}]*)\}/.exec(sheet!.textContent ?? '');
    expect(lockRule).toBeTruthy();
    const declarations = lockRule?.[1] ?? '';
    for (const property of ['touch-action', '-ms-touch-action']) {
      const value = new RegExp(`(?:^|;)${property}:([^;]*)`).exec(declarations)?.[1];
      expect(value!.split(/\s+/).filter(Boolean)).toEqual(['pinch-zoom']);
    }
  });
});

describe('book-owned controls share navigation shortcuts', () => {
  useMeasuredLayout();
  for (const direction of ['ltr', 'rtl'] as const) {
    for (const control of ['prev', 'next'] as const) {
      test(`${control} keeps arrow/Home/End navigation in ${direction}`, async () => {
        blockSize = PORTRAIT_BLOCK;
        const ref = createRef<FlipBookHandle>();
        const { container } = render(
          <HTMLFlipBook
            ref={ref}
            width={200}
            height={300}
            flippingTime={0}
            readingDirection={direction}
            controls="visible"
          >
            {pages('a', 'b', 'c', 'd')}
          </HTMLFlipBook>,
        );
        await waitFor(() => expect(ref.current?.pageFlip()?.isReady()).toBe(true));
        const button = container.querySelector<HTMLButtonElement>(
          `[data-flipbook-control="${control}"]`,
        )!;
        button.focus();
        expect(document.activeElement).toBe(button);
        expect(
          fireEvent.keyDown(button, { key: direction === 'ltr' ? 'ArrowRight' : 'ArrowLeft' }),
        ).toBe(false);
        await waitFor(() => expect(ref.current?.pageFlip()?.getCurrentPageIndex()).toBe(1));
        expect(document.activeElement).toBe(button);
        expect(fireEvent.keyDown(button, { key: 'End' })).toBe(false);
        await waitFor(() => expect(ref.current?.pageFlip()?.getCurrentPageIndex()).toBe(3));
        expect(
          fireEvent.keyDown(button, { key: direction === 'ltr' ? 'ArrowLeft' : 'ArrowRight' }),
        ).toBe(false);
        await waitFor(() => expect(ref.current?.pageFlip()?.getCurrentPageIndex()).toBe(2));
        expect(fireEvent.keyDown(button, { key: 'Home' })).toBe(false);
        await waitFor(() => expect(ref.current?.pageFlip()?.getCurrentPageIndex()).toBe(0));
        for (const modifier of [
          { altKey: true },
          { ctrlKey: true },
          { metaKey: true },
          { shiftKey: true },
        ]) {
          expect(fireEvent.keyDown(button, { key: 'End', ...modifier })).toBe(true);
        }
        expect(ref.current?.pageFlip()?.getCurrentPageIndex()).toBe(0);
      });
    }
  }

  test('an authored page button marked like a control still owns its keys', async () => {
    blockSize = PORTRAIT_BLOCK;
    const ref = createRef<FlipBookHandle>();
    const { getByText } = render(
      <HTMLFlipBook ref={ref} width={200} height={300} flippingTime={0}>
        <div key="a">
          <button data-flipbook-control="next" type="button">
            Content control
          </button>
        </div>
        <div key="b">b</div>
      </HTMLFlipBook>,
    );
    await waitFor(() => expect(ref.current?.pageFlip()?.isReady()).toBe(true));
    const button = getByText('Content control');
    button.focus();
    expect(fireEvent.keyDown(button, { key: 'ArrowRight' })).toBe(true);
    expect(ref.current?.pageFlip()?.getCurrentPageIndex()).toBe(0);
  });
});
