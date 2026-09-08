/**
 * Shared FIXED-size HTML book harness for jsdom integration tests.
 * Coverage is a byproduct — helpers only size the host so geometry is real.
 *
 * Uses the post-design-tranche `FlipOptions` names only (`sizing`, `hardCovers`,
 * `foldCornerOnHover`, `readingDirection`, `flipOnClick`, `pointerInput`, …).
 * Unknown legacy keys must not be spread into the constructor: `resolve`
 * ignores them and the suite silently tests the wrong configuration.
 */
import { PageFlip } from '@gullabs/flipbook-core';
import type { FlipOptions } from '@gullabs/flipbook-core';

export type BookOpts = Partial<FlipOptions> & {
  pageCount?: number;
  hostWidth?: number;
  hostHeight?: number;
};

/** jsdom reports 0×0 boxes; FIXED size still needs a non-zero dist box for stretch paths. */
export function sizeElement(el: HTMLElement, width: number, height: number): void {
  Object.defineProperty(el, 'offsetWidth', { configurable: true, get: () => width });
  Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => height });
  el.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: height,
      right: width,
      width,
      height,
      toJSON() {
        return {};
      },
    }) as DOMRect;
}

export function makePages(count: number, hardFirst = false): HTMLElement[] {
  return Array.from({ length: count }, (_, i) => {
    const el = document.createElement('div');
    el.dataset.page = String(i);
    el.textContent = `page-${i}`;
    if (hardFirst && i === 0) el.dataset.density = 'hard';
    return el;
  });
}

export function makeHtmlBook(opts: BookOpts = {}): {
  host: HTMLElement;
  book: PageFlip;
  pages: HTMLElement[];
  destroy: () => void;
} {
  const width = opts.width ?? 200;
  const height = opts.height ?? 300;
  // FIXED + host narrower than 2×pageWidth forces portrait when usePortrait is on.
  const hostW = opts.hostWidth ?? Math.max(1, width * 2 - 20);
  const hostH = opts.hostHeight ?? height;
  const pageCount = opts.pageCount ?? 4;

  const host = document.createElement('div');
  document.body.appendChild(host);
  sizeElement(host, hostW, hostH);

  const pages = makePages(pageCount, Boolean(opts.hardCovers));
  for (const p of pages) host.appendChild(p);

  const {
    pageCount: _pageCount,
    hostWidth: _hostWidth,
    hostHeight: _hostHeight,
    ...setting
  } = opts;

  const book = new PageFlip(host, {
    width,
    height,
    sizing: 'fixed',
    flippingTime: 0,
    usePortrait: true,
    drawShadow: true,
    foldCornerOnHover: true,
    pageBackground: '#fff',
    ...setting,
  });

  book.loadFromHTML(pages);

  // Public façade: the leaves live in `.stf__block` (getBlockElement).
  const dist = book.getBlockElement();
  sizeElement(dist, hostW, hostH);
  // Bounds depend on dist offset*; force a layout pass.
  book.update();

  return {
    host,
    book,
    pages,
    destroy() {
      book.destroy();
      host.remove();
    },
  };
}

const pointerCaptures = new WeakMap<Element, Set<number>>();

/**
 * jsdom's capture methods are missing or no-ops. An empty `setPointerCapture`
 * plus a missing `hasPointerCapture` made the engine treat capture as success
 * (`pointerCaptured = true` when the query is absent), so `pointerleave`
 * tests were lying. Track ids the way a real UA would.
 */
export function installPointerCaptureShims(): void {
  const proto = HTMLElement.prototype;
  if (typeof proto.hasPointerCapture === 'function') return;

  proto.setPointerCapture = function setPointerCapture(id: number): void {
    let ids = pointerCaptures.get(this);
    if (!ids) {
      ids = new Set();
      pointerCaptures.set(this, ids);
    }
    ids.add(id);
  };
  proto.releasePointerCapture = function releasePointerCapture(id: number): void {
    const ids = pointerCaptures.get(this);
    if (ids?.has(id) !== true) return;
    ids.delete(id);
    this.dispatchEvent(
      new PointerEvent('lostpointercapture', {
        bubbles: true,
        cancelable: true,
        pointerId: id,
        pointerType: 'mouse',
      }),
    );
  };
  proto.hasPointerCapture = function hasPointerCapture(id: number): boolean {
    return pointerCaptures.get(this)?.has(id) === true;
  };
}
