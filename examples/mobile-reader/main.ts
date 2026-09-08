import { FLIPBOOK_CSS, PageFlip } from '@gullabs/flipbook-core';

const engineCss = document.createElement('style');
engineCss.id = 'flipbook-engine-css';
engineCss.textContent = FLIPBOOK_CSS;
document.head.appendChild(engineCss);

const root = document.getElementById('book');
const host = document.getElementById('host');
if (!(root instanceof HTMLElement) || !(host instanceof HTMLElement)) {
  throw new Error('#book and #host are required');
}

const pageNodes = [...root.querySelectorAll<HTMLElement>('.page')];
const fullMarkup = new Map<HTMLElement, string>();
for (const page of pageNodes) {
  const slot = page.querySelector<HTMLElement>('[data-lazy="full"]');
  if (slot) fullMarkup.set(page, slot.innerHTML);
}
const tokenIds = [...root.querySelectorAll<HTMLElement>('[data-token-id]')]
  .map((el) => el.dataset.tokenId)
  .filter((id): id is string => Boolean(id));

const params = new URLSearchParams(window.location.search);
const reducedMotionOn = params.get('reducedMotion') !== '0';

const book = new PageFlip(root, {
  width: 400,
  height: 520,
  sizing: 'responsive',
  minWidth: 220,
  maxWidth: 520,
  minHeight: 280,
  maxHeight: 680,
  usePortrait: true,
  hardCovers: true,
  flippingTime: Number(params.get('flippingTime') ?? 700),
  pageBackground: '#fffaf0',
  injectStyles: false,
  flipOnClick: 'never',
  foldCornerOnHover: false,
  respectInteractiveContent: true,
  allowTouchScroll: false,
  pointerInput: ['mouse', 'touch'],
  readingDirection: params.get('rtl') === '1' ? 'rtl' : 'ltr',
  respectReducedMotion: reducedMotionOn,
});

(window as unknown as { flipbook: PageFlip }).flipbook = book;

const status = document.getElementById('status');
const prevBtn = document.getElementById('prev');
const nextBtn = document.getElementById('next');
const rtlBtn = document.getElementById('rtl-toggle');
const motionBtn = document.getElementById('motion-toggle');
const hostWidth = document.getElementById('host-width');
const highlightSheet = document.getElementById('highlight-sheet');

const LAZY_SPREAD_RADIUS = 1;

function pagesPerSpread(): number {
  return book.getOrientation() === 'portrait' ? 1 : 2;
}

function hydrateLazyWindow(): void {
  const visible = book.getVisiblePages();
  if (visible.length === 0) return;
  const perSpread = pagesPerSpread();
  const reach = LAZY_SPREAD_RADIUS * perSpread;
  const lo = Math.max(0, Math.min(...visible) - reach);
  const hi = Math.min(pageNodes.length - 1, Math.max(...visible) + reach);

  for (let i = 0; i < pageNodes.length; i += 1) {
    const page = pageNodes[i];
    if (!page) continue;
    const slot = page.querySelector<HTMLElement>('[data-lazy="full"]');
    const markup = fullMarkup.get(page);
    if (!slot || markup === undefined) continue;

    const inWindow = i >= lo && i <= hi;
    if (inWindow) {
      if (slot.dataset.hydrated !== '1') {
        slot.innerHTML = markup;
        slot.dataset.hydrated = '1';
      }
    } else if (slot.dataset.hydrated !== '0') {
      slot.innerHTML = '<p class="lazy-placeholder">Nearby spread — content parked.</p>';
      slot.dataset.hydrated = '0';
    }
  }
}

const writeChrome = (): void => {
  const visible = book.getVisiblePages().map((i) => i + 1);
  const shown = visible.length === 0 ? '—' : visible.join('–');
  if (status) {
    status.textContent = `pages ${shown} of ${book.getPageCount()} · ${book.getOrientation()} · ${book.getSettings().readingDirection}`;
  }
  if (prevBtn instanceof HTMLButtonElement) prevBtn.disabled = !book.canTurn('prev');
  if (nextBtn instanceof HTMLButtonElement) nextBtn.disabled = !book.canTurn('next');
  hydrateLazyWindow();
};

book.on('flip', (event) => {
  document.body.dataset['page'] = String(event.data.page);
  writeChrome();
});
book.on('changeOrientation', (event) => {
  document.body.dataset['orientation'] = event.data.orientation;
  writeChrome();
});
book.on('loaded', (event) => {
  document.body.dataset['orientation'] = event.data.orientation;
  document.body.dataset['ready'] = '1';
  writeChrome();
});

book.loadFromHTML(pageNodes);
hydrateLazyWindow();

prevBtn?.addEventListener('click', () => {
  book.flipPrev();
});
nextBtn?.addEventListener('click', () => {
  book.flipNext();
});

rtlBtn?.addEventListener('click', () => {
  const next = book.getSettings().readingDirection === 'rtl' ? 'ltr' : 'rtl';
  book.updateSettings({ readingDirection: next });
  if (rtlBtn instanceof HTMLButtonElement) {
    rtlBtn.textContent = `Page progression: ${next.toUpperCase()}`;
  }
  writeChrome();
});

motionBtn?.addEventListener('click', () => {
  const next = !book.getSettings().respectReducedMotion;
  book.updateSettings({ respectReducedMotion: next });
  if (motionBtn instanceof HTMLButtonElement) {
    motionBtn.textContent = `Reduced motion: ${next ? 'on' : 'off'}`;
  }
});

hostWidth?.addEventListener('input', () => {
  if (!(hostWidth instanceof HTMLInputElement)) return;
  host.style.width = `${hostWidth.value}px`;
});

let tokenCursor = 0;
let highlightTimer = 0;

function paintHighlight(tokenId: string | undefined): void {
  if (!(highlightSheet instanceof HTMLStyleElement)) return;
  if (tokenId === undefined || tokenId === '') {
    highlightSheet.textContent = '';
    document.body.dataset['highlight'] = '';
    return;
  }
  highlightSheet.textContent = `[data-token-id="${CSS.escape(tokenId)}"] { background: #ffe08a; }`;
  document.body.dataset['highlight'] = tokenId;
}

function startNarrationClock(): void {
  window.clearInterval(highlightTimer);
  highlightTimer = window.setInterval(() => {
    const id = tokenIds[tokenCursor % Math.max(tokenIds.length, 1)];
    tokenCursor += 1;
    paintHighlight(id);
  }, 700);
}

startNarrationClock();

document.body.dataset['fontReady'] = '0';
window.setTimeout(() => {
  const face = new FontFace('StoryDisplay', "local('Georgia'), local('Times New Roman')");
  void face
    .load()
    .then((loaded) => {
      document.fonts.add(loaded);
    })
    .catch(() => undefined)
    .finally(() => {
      document.body.dataset['fontReady'] = '1';
    });
}, 450);

if (rtlBtn instanceof HTMLButtonElement) {
  rtlBtn.textContent = `Page progression: ${book.getSettings().readingDirection.toUpperCase()}`;
}
if (motionBtn instanceof HTMLButtonElement) {
  motionBtn.textContent = `Reduced motion: ${book.getSettings().respectReducedMotion ? 'on' : 'off'}`;
}
