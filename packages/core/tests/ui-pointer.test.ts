/**
 * Coverage is a byproduct, not the goal — real pointer capture / leave / swipe paths.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FlippingState, PageFlip } from '@gullabs/flipbook-core';
import { installPointerCaptureShims, makeHtmlBook, sizeElement } from './html-book-fixture';

const books: Array<{ destroy: () => void }> = [];

beforeEach(() => {
  installPointerCaptureShims();
});

afterEach(() => {
  while (books.length) books.pop()?.destroy();
  vi.useRealTimers();
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
      buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0,
      pointerType: 'mouse',
      ...init,
    }),
  );
}

describe('UI pointer paths', () => {
  test('pointerdown + move + up performs a corner click turn', () => {
    const { book: app } = book({ pageCount: 4, flippingTime: 0, swipeDistance: 80 });
    const dist = app.getBlockElement();
    const rect = app.getBoundsRect();
    const x = rect.left + rect.width - 6;
    const y = rect.top + 6;

    pointer('pointerdown', dist, { clientX: x, clientY: y });
    pointer('pointerup', dist, { clientX: x, clientY: y });

    expect(app.getCurrentPageIndex()).toBe(1);
    expect(app.getState()).toBe(FlippingState.READ);
  });

  test('horizontal swipe past swipeDistance calls flipNext', () => {
    const { book: app } = book({ pageCount: 4, flippingTime: 0, swipeDistance: 40 });
    const dist = app.getBlockElement();
    const rect = app.getBoundsRect();
    const y = rect.top + 40;
    const startX = rect.left + rect.width - 20;

    pointer('pointerdown', dist, { clientX: startX, clientY: y });
    // Fast left swipe (dx negative → next in LTR).
    pointer('pointerup', dist, { clientX: startX - 120, clientY: y + 5 });

    expect(app.getCurrentPageIndex()).toBe(1);
  });

  test('rtl swipe mapping: positive dx advances next', () => {
    const { book: app } = book({
      pageCount: 4,
      flippingTime: 0,
      swipeDistance: 40,
      readingDirection: 'rtl',
    });
    const dist = app.getBlockElement();
    const rect = app.getBoundsRect();
    const y = rect.top + 30;
    const startX = rect.left + 40;

    pointer('pointerdown', dist, { clientX: startX, clientY: y });
    pointer('pointerup', dist, { clientX: startX + 120, clientY: y });

    expect(app.getCurrentPageIndex()).toBe(1);
  });

  test('pointerleave while idle after a corner fold restores READ', () => {
    const { book: app } = book({ pageCount: 4, flippingTime: 0, foldCornerOnHover: true });
    const dist = app.getBlockElement();
    const rect = app.getBoundsRect();

    // Hover corner (no pointerdown) → showCorner.
    pointer('pointermove', dist, {
      clientX: rect.left + rect.width - 4,
      clientY: rect.top + 4,
      buttons: 0,
    });

    // Leave with no active pointer → onPointerLeave stopMove path.
    dist.dispatchEvent(
      new PointerEvent('pointerleave', {
        bubbles: true,
        pointerId: 1,
        pointerType: 'mouse',
      }),
    );

    expect(app.getState()).toBe(FlippingState.READ);
  });

  test('pointerleave during an active drag is ignored (no double stopMove)', () => {
    const { book: app } = book({ pageCount: 4, flippingTime: 0 });
    const dist = app.getBlockElement();
    const rect = app.getBoundsRect();
    const x = rect.left + rect.width - 8;
    const y = rect.top + 12;

    pointer('pointerdown', dist, { clientX: x, clientY: y });
    pointer('pointermove', dist, { clientX: x - 40, clientY: y + 10 });

    const stateDuringDrag = app.getState();
    dist.dispatchEvent(
      new PointerEvent('pointerleave', {
        bubbles: true,
        pointerId: 1,
        pointerType: 'mouse',
      }),
    );
    // Active pointer id is set → leave must not force READ mid-drag.
    expect(app.getState()).toBe(stateDuringDrag);

    pointer('pointerup', dist, { clientX: x - 40, clientY: y + 10 });
    expect(app.getState()).toBe(FlippingState.READ);
  });

  test('respectInteractiveContent skips interactive children (button / anchor)', () => {
    const { book: app, pages } = book({
      pageCount: 3,
      flippingTime: 0,
      respectInteractiveContent: true,
    });
    const btn = document.createElement('button');
    btn.textContent = 'go';
    pages[0]!.appendChild(btn);

    const rect = app.getBoundsRect();
    pointer('pointerdown', btn, {
      clientX: rect.left + rect.width - 5,
      clientY: rect.top + 5,
    });
    pointer('pointerup', btn, {
      clientX: rect.left + rect.width - 5,
      clientY: rect.top + 5,
    });

    // Handlers bail on button targets → no turn.
    expect(app.getCurrentPageIndex()).toBe(0);
  });

  test('useMouseEvents false leaves the book unresponsive to pointers', () => {
    const { book: app } = book({
      pageCount: 3,
      flippingTime: 0,
      pointerInput: [],
    });
    const dist = app.getBlockElement();
    const rect = app.getBoundsRect();

    pointer('pointerdown', dist, {
      clientX: rect.left + rect.width - 5,
      clientY: rect.top + 5,
    });
    pointer('pointerup', dist, {
      clientX: rect.left + rect.width - 5,
      clientY: rect.top + 5,
    });

    expect(app.getCurrentPageIndex()).toBe(0);
  });

  test('refreshHandlers after enabling mouse events binds again', () => {
    const { book: app } = book({
      pageCount: 3,
      flippingTime: 0,
      pointerInput: [],
    });

    app.updateSettings({ pointerInput: ['mouse', 'touch', 'pen'] });

    const dist = app.getBlockElement();
    const rect = app.getBoundsRect();
    pointer('pointerdown', dist, {
      clientX: rect.left + rect.width - 5,
      clientY: rect.top + 5,
    });
    pointer('pointerup', dist, {
      clientX: rect.left + rect.width - 5,
      clientY: rect.top + 5,
    });

    expect(app.getCurrentPageIndex()).toBe(1);
  });

  test('destroy restores host styles and removes wrapper', () => {
    const host = document.createElement('div');
    host.style.width = '50%';
    host.style.display = 'inline-block';
    document.body.appendChild(host);

    const pages = [0, 1, 2].map((i) => {
      const el = document.createElement('div');
      el.textContent = String(i);
      return el;
    });
    for (const p of pages) host.appendChild(p);

    const app = new PageFlip(host, { width: 200, height: 300, flippingTime: 0, sizing: 'fixed' });
    app.loadFromHTML(pages);
    expect(host.classList.contains('stf__parent')).toBe(true);

    app.destroy();
    expect(host.classList.contains('stf__parent')).toBe(false);
    expect(host.querySelector('.stf__wrapper')).toBeNull();
    expect(host.style.display).toBe('inline-block');
    expect(host.style.width).toBe('50%');
    host.remove();
  });

  test('allowTouchScroll false preventDefault on touch move', () => {
    const { book: app, host } = book({
      pageCount: 4,
      flippingTime: 0,
      allowTouchScroll: false,
    });
    expect(host.classList.contains('--lock-touch-scroll')).toBe(true);

    const dist = app.getBlockElement();
    const rect = app.getBoundsRect();
    const start = { x: rect.left + rect.width - 10, y: rect.top + 20 };

    dist.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerId: 7,
        pointerType: 'touch',
        clientX: start.x,
        clientY: start.y,
        button: 0,
      }),
    );
    const move = new PointerEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      pointerId: 7,
      pointerType: 'touch',
      clientX: start.x - 50,
      clientY: start.y + 5,
      buttons: 1,
    });
    dist.dispatchEvent(move);

    expect(move.defaultPrevented).toBe(true);
    expect(app.getState()).not.toBe(FlippingState.READ);

    app.destroy();
    expect(host.classList.contains('--lock-touch-scroll')).toBe(false);
  });

  test('allowTouchScroll true does not preventDefault while still READ', () => {
    const { book: app, host } = book({
      pageCount: 4,
      flippingTime: 0,
      allowTouchScroll: true,
    });
    expect(host.classList.contains('--lock-touch-scroll')).toBe(false);

    const dist = app.getBlockElement();
    const rect = app.getBoundsRect();
    const start = { x: rect.left + rect.width - 10, y: rect.top + 20 };

    dist.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerId: 7,
        pointerType: 'touch',
        clientX: start.x,
        clientY: start.y,
        button: 0,
      }),
    );
    const move = new PointerEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      pointerId: 7,
      pointerType: 'touch',
      clientX: start.x - 4,
      clientY: start.y + 2,
      buttons: 1,
    });
    dist.dispatchEvent(move);

    expect(move.defaultPrevented).toBe(false);
    expect(app.getState()).toBe(FlippingState.READ);
  });

  test('non-primary mouse button is ignored', () => {
    const { book: app } = book({ pageCount: 3, flippingTime: 0 });
    const dist = app.getBlockElement();
    const rect = app.getBoundsRect();

    dist.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 1,
        pointerType: 'mouse',
        button: 2,
        clientX: rect.left + rect.width - 5,
        clientY: rect.top + 5,
      }),
    );
    expect(app.getCurrentPageIndex()).toBe(0);
  });
});

/**
 * W1 — the host's `max-width` bounds the WIDEST SPREAD, not one page.
 *
 * `applyHostSize` stamps `min-width: minWidth * k` (k = 1 when `usePortrait`
 * allows a single-leaf layout, 2 otherwise) and `max-width: maxWidth * 2`. The
 * `2` looks like an oversight next to `k` and is not: `k` answers "how narrow
 * may this book legally be", and `usePortrait` genuinely lowers that floor to
 * one page — while the CEILING is two pages whatever `usePortrait` says,
 * because a `usePortrait` book is portrait only while it is NARROW
 * (`Render.computeBounds`: `blockWidth < minWidth * 2`) and becomes landscape
 * as soon as it is not.
 *
 * Applying `k` to the ceiling therefore does not tighten the bound, it removes
 * landscape: the host can no longer reach the width at which the book would
 * flip to two pages, so a `usePortrait` + `autoSize` + `stretch` book is
 * pinned to one leaf on a 4K display. These tests fail against that change.
 */
describe('W1 — host max-width is the two-page bound', () => {
  const stretch = {
    pageCount: 4,
    sizing: 'responsive' as const,
    autoSize: true,
    usePortrait: true,
    width: 300,
    height: 400,
    minWidth: 400,
    maxWidth: 600,
    minHeight: 200,
    maxHeight: 900,
    flippingTime: 0,
  };

  test('the host may grow to two maximum-width pages', () => {
    const { book: app, host } = book({ ...stretch, hostWidth: 500, hostHeight: 400 });
    const setting = app.getSettings();

    // FIXTURE CHECK: `usePortrait` is on, so `minWidth` took k = 1. If it had
    // not, the asymmetry this test is about would not exist to assert.
    expect(host.style.minWidth).toBe(`${String(setting.minWidth)}px`);

    expect(host.style.maxWidth).toBe(`${String(setting.maxWidth * 2)}px`);
  });

  test('the ceiling clears the landscape threshold — or the book can never be landscape', () => {
    // `Render.computeBounds` goes portrait below `minWidth * 2`. A ceiling
    // under that threshold makes the portrait test unconditionally true.
    const { book: app, host } = book({ ...stretch, hostWidth: 500, hostHeight: 400 });
    const setting = app.getSettings();

    // maxWidth (600) is BELOW minWidth * 2 (800) on purpose: this is the
    // configuration where `maxWidth * k` and `maxWidth * 2` disagree about
    // whether landscape exists at all.
    expect(setting.maxWidth).toBeLessThan(setting.minWidth * 2);
    expect(parseFloat(host.style.maxWidth)).toBeGreaterThanOrEqual(setting.minWidth * 2);
  });

  test('at that ceiling the book really is two full-width pages', () => {
    // The bound is tight, not slack: at exactly `maxWidth * 2` the spread fills
    // the host and each page is at its own maximum.
    const { book: app } = book({ ...stretch, hostWidth: 1200, hostHeight: 900 });
    const dist = app.getBlockElement();
    sizeElement(dist, 1200, 900);
    app.update();

    expect(app.getOrientation()).toBe('landscape');
    expect(app.getBoundsRect().pageWidth).toBe(600);
    expect(app.getBoundsRect().width).toBe(1200);
  });
});

/**
 * W2 — the wrapper reserves the book's aspect ratio with and without autoSize.
 *
 * `autoSize: false` means "the engine does not own the HOST's width" — it was
 * never a statement about the engine's own wrapper. Gating the ratio padding
 * on it collapsed `.stf__wrapper` to zero height, and `Render.computeBounds`
 * then centred the book on the wrapper's top edge (`top: -height/2`), drawing
 * the book half out of frame. Upstream 2.0.7 had the same defect; the old
 * story-book reader hid it inside the monkey-patch layer this fork deletes.
 */
describe('W2 — wrapper aspect ratio survives autoSize: false', () => {
  test('autoSize: false still reserves the spread ratio on the wrapper', () => {
    const { book: app, host } = book({
      width: 300,
      height: 400,
      autoSize: false,
      hostWidth: 600,
      hostHeight: 400,
      usePortrait: false,
    });

    const wrapper = host.querySelector('.stf__wrapper') as HTMLElement;
    // Landscape spread: height / (width * 2).
    expect(wrapper.style.paddingBottom).toBe(`${(400 / 600) * 100}%`);
    expect(app.getSettings().autoSize).toBe(false);
  });

  test('the ratio recomputes on a live size change', () => {
    const { book: app, host } = book({
      width: 300,
      height: 400,
      autoSize: false,
      hostWidth: 600,
      hostHeight: 400,
      usePortrait: false,
    });

    app.updateSettings({ width: 320, height: 400 });
    const wrapper = host.querySelector('.stf__wrapper') as HTMLElement;
    expect(wrapper.style.paddingBottom).toBe(`${(400 / 640) * 100}%`);
  });

  test('autoSize: true keeps its ratio (no regression)', () => {
    const { host } = book({
      width: 300,
      height: 400,
      autoSize: true,
      hostWidth: 600,
      hostHeight: 400,
      usePortrait: false,
    });

    const wrapper = host.querySelector('.stf__wrapper') as HTMLElement;
    expect(wrapper.style.paddingBottom).toBe(`${(400 / 600) * 100}%`);
  });
});
