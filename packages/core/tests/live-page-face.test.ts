/**
 * F04 — live page-face contract during a curl.
 *
 * Cloning is `cloneNode(true)`: attributes and text at clone time survive;
 * later mutations on the original do not. The clone is scenery (aria-hidden,
 * inert). Consumer highlighting is a stylesheet outside page subtrees keyed on
 * stable token ids — not an engine feature.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { installPointerCaptureShims, makeHtmlBook } from './html-book-fixture';
import { testPage } from './engine-access';
import { Page } from '../src/Page/Page';

const books: Array<{ destroy: () => void }> = [];

beforeEach(() => {
  installPointerCaptureShims();
});

afterEach(() => {
  while (books.length) books.pop()?.destroy();
  document.body.innerHTML = '';
});

function book(opts?: Parameters<typeof makeHtmlBook>[0]) {
  const b = makeHtmlBook(opts);
  books.push(b);
  return b;
}

function clonesIn(app: ReturnType<typeof book>['book'], pages: HTMLElement[]): HTMLElement[] {
  const block = app.getBlockElement();
  return [...block.querySelectorAll<HTMLElement>('.stf__item')].filter((el) => !pages.includes(el));
}

describe('F04 — clone is a snapshot, not a live React tree', () => {
  test('cloneNode preserves token ids and text at the moment of copy', () => {
    const { book: app, pages } = book({ pageCount: 4, flippingTime: 0 });
    pages[0]!.innerHTML = '<p><span data-token-id="sample-en-page3-word8">river</span> stone</p>';
    app.updateFromHtml(pages);

    const page = testPage(app, 0) as Page;
    const copy = page.newTemporaryCopy() as Page;
    const clone = copy.getElement();

    expect(clone.querySelector('[data-token-id="sample-en-page3-word8"]')?.textContent).toBe(
      'river',
    );
    expect(clone.getAttribute('aria-hidden')).toBe('true');
    expect(clone.hasAttribute('inert')).toBe(true);
    expect(pages[0]!.hasAttribute('aria-hidden')).toBe(false);

    page.hideTemporaryCopy();
  });

  test('later mutations on the original do not sync into the clone', () => {
    const { book: app, pages } = book({ pageCount: 4, flippingTime: 0 });
    pages[0]!.innerHTML = '<span data-token-id="w1">Mara</span>';
    app.updateFromHtml(pages);

    const page = testPage(app, 0) as Page;
    const copy = page.newTemporaryCopy() as Page;
    const clone = copy.getElement();

    pages[0]!.innerHTML = '<span data-token-id="w1" lang="ar">مارا</span>';
    pages[0]!.lang = 'ar';

    expect(clone.textContent).toContain('Mara');
    expect(clone.textContent).not.toContain('مارا');
    expect(clone.querySelector('[data-token-id="w1"]')?.getAttribute('lang')).toBeNull();

    page.hideTemporaryCopy();
  });

  test('a shared token-id stylesheet paints original and clone together', () => {
    const { book: app, pages } = book({ pageCount: 4, flippingTime: 0 });
    const token = 'sample-en-page3-word8';
    pages[0]!.innerHTML = `<span data-token-id="${token}">river</span>`;
    app.updateFromHtml(pages);

    const sheet = document.createElement('style');
    sheet.textContent = `[data-token-id="${CSS.escape(token)}"] { background-color: rgb(255, 224, 138); }`;
    document.head.appendChild(sheet);

    const page = testPage(app, 0) as Page;
    const copy = page.newTemporaryCopy() as Page;
    const originalSpan = pages[0]!.querySelector<HTMLElement>(`[data-token-id="${token}"]`);
    const cloneSpan = copy.getElement().querySelector<HTMLElement>(`[data-token-id="${token}"]`);
    expect(originalSpan).not.toBeNull();
    expect(cloneSpan).not.toBeNull();
    expect(getComputedStyle(originalSpan!).backgroundColor).toBe('rgb(255, 224, 138)');
    expect(getComputedStyle(cloneSpan!).backgroundColor).toBe('rgb(255, 224, 138)');

    page.hideTemporaryCopy();
    sheet.remove();
  });

  test('a real fold paints the shared token rule on original and clone', () => {
    const { book: app, pages } = book({ pageCount: 6, flippingTime: 0 });
    const token = 'sample-en-page3-word8';
    pages[0]!.innerHTML = `<span data-token-id="${token}">river</span>`;
    app.updateFromHtml(pages);

    const sheet = document.createElement('style');
    sheet.textContent = `[data-token-id="${CSS.escape(token)}"] { background-color: rgb(255, 224, 138); }`;
    document.head.appendChild(sheet);

    const dist = app.getBlockElement();
    const rect = app.getBoundsRect();
    const y = rect.top + rect.height - 8;
    const fire = (type: string, x: number) =>
      dist.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          button: 0,
          buttons: type === 'pointerup' ? 0 : 1,
          pointerType: 'mouse',
          clientX: x,
          clientY: y,
        }),
      );

    fire('pointerdown', rect.left + rect.width - 6);
    fire('pointermove', rect.left + rect.width - 40);
    fire('pointermove', rect.left + rect.width - 120);

    const originalSpan = pages[0]!.querySelector<HTMLElement>(`[data-token-id="${token}"]`);
    expect(originalSpan).not.toBeNull();
    expect(getComputedStyle(originalSpan!).backgroundColor).toBe('rgb(255, 224, 138)');

    const clones = clonesIn(app, pages);
    expect(clones.length).toBeGreaterThan(0);
    const cloneSpan = clones
      .map((c) => c.querySelector<HTMLElement>(`[data-token-id="${token}"]`))
      .find((el) => el !== null);
    expect(cloneSpan).not.toBeUndefined();
    expect(getComputedStyle(cloneSpan!).backgroundColor).toBe('rgb(255, 224, 138)');

    originalSpan!.textContent = 'changed';
    expect(cloneSpan!.textContent).toBe('river');

    fire('pointerup', rect.left + rect.width - 120);
    sheet.remove();
  });

  test('clones are not duplicate speech or focus targets during a real fold', () => {
    const { book: app, pages } = book({ pageCount: 6, flippingTime: 0 });
    const spoken = document.createElement('p');
    spoken.id = 'story-line';
    spoken.textContent = 'Mara found a smooth stone';
    pages[0]!.appendChild(spoken);
    app.updateFromHtml(pages);

    const dist = app.getBlockElement();
    const rect = app.getBoundsRect();
    const y = rect.top + rect.height - 8;
    const fire = (type: string, x: number) =>
      dist.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          button: 0,
          buttons: type === 'pointerup' ? 0 : 1,
          pointerType: 'mouse',
          clientX: x,
          clientY: y,
        }),
      );

    fire('pointerdown', rect.left + rect.width - 6);
    fire('pointermove', rect.left + rect.width - 40);
    fire('pointermove', rect.left + rect.width - 120);

    const clones = clonesIn(app, pages);
    expect(clones.length).toBeGreaterThan(0);
    for (const clone of clones) {
      expect(clone.getAttribute('aria-hidden')).toBe('true');
      expect(clone.hasAttribute('inert')).toBe(true);
    }
    expect(document.getElementById('story-line')).toBe(spoken);

    fire('pointerup', rect.left + rect.width - 120);
  });
});
