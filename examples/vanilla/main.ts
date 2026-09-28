import { PageFlip, PageFlipError } from '@gullabs/flipbook-core';

const root = document.getElementById('book');
if (!(root instanceof HTMLElement)) {
  throw new Error('#book root element is required');
}

// Responsive: the book fits the host and drops to one leaf below minWidth*2,
// which is where the portrait back-curl this fork exists to fix actually happens.
const params = new URLSearchParams(window.location.search);

if (params.get('golden') === '1') {
  document.body.classList.add('golden');
}

const swipeDistanceParam = params.get('swipeDistance');
const swipeDistance =
  swipeDistanceParam !== null && swipeDistanceParam !== '' ? Number(swipeDistanceParam) : undefined;

// `lazyRadius`, `controls`, `liveRegion`, `useKeyboard`, and controlled `page`
// are React-only. Unknown keys passed here are ignored. This host mounts
// every `.page`. A portrait curl freezes `<video>` as a canvas and strips
// `<audio>`; `video[controls]` does not start a fold. Playback stays here.
const book = new PageFlip(root, {
  width: 400,
  height: 300,
  sizing: 'responsive',
  minWidth: 260,
  maxWidth: 800,
  minHeight: 200,
  maxHeight: 600,
  usePortrait: true,
  hardCovers: params.get('cover') === '1',
  readingDirection: params.get('rtl') === '1' ? 'rtl' : 'ltr',
  flippingTime: Number(params.get('flippingTime') ?? 600),
  pageBackground: '#ffffff',
  respectReducedMotion: params.get('reducedMotion') !== '0',
  ...(swipeDistance !== undefined && !Number.isNaN(swipeDistance) ? { swipeDistance } : {}),
  // Query name kept for existing e2e URLs; the setting is `flipOnClick`.
  flipOnClick: params.get('disableFlipByClick') === '1' ? 'corners' : 'anywhere',
});

(window as unknown as { flipbook: PageFlip }).flipbook = book;

const status = document.getElementById('status');
const prevBtn = document.getElementById('prev');
const nextBtn = document.getElementById('next');
const firstBtn = document.getElementById('first');

const writeChrome = () => {
  const visible = book.getVisiblePages().map((i) => i + 1);
  const shown = visible.length === 0 ? '—' : visible.join('–');
  if (status) {
    status.textContent = `pages ${shown} of ${book.getPageCount()} · ${book.getOrientation()}`;
  }
  if (prevBtn instanceof HTMLButtonElement) prevBtn.disabled = !book.canTurn('prev');
  if (nextBtn instanceof HTMLButtonElement) nextBtn.disabled = !book.canTurn('next');
  if (firstBtn instanceof HTMLButtonElement) firstBtn.disabled = !book.canTurn('prev');
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
book.on('turnRejected', (event) => {
  if (status) {
    status.textContent = `rejected ${event.data.reason} · pages ${book
      .getVisiblePages()
      .map((i) => i + 1)
      .join('–')} of ${book.getPageCount()}`;
  }
});

// `loaded` is synchronous inside loadFromHTML — bind first or data-ready never sets.
book.loadFromHTML([...root.querySelectorAll<HTMLElement>('.page')]);

prevBtn?.addEventListener('click', () => {
  book.flipPrev();
});
nextBtn?.addEventListener('click', () => {
  book.flipNext();
});
firstBtn?.addEventListener('click', () => {
  try {
    book.turnToPage(0);
    writeChrome();
  } catch (error) {
    if (!(error instanceof PageFlipError)) throw error;
  }
});
