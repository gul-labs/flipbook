import { StrictMode, useCallback, useMemo, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { HTMLFlipBook, usePageFlip, type PageState } from '@gullabs/react-flipbook';

/**
 * What a reader app actually reaches for:
 *   - `usePageFlip()` for chrome (visible pages, canGoNext/Prev)
 *   - `controls="visible"` when you do not draw your own buttons
 *   - `hardCovers` for a picture book
 *   - `readingDirection` for RTL
 *   - controlled `page` + `onPageChange` for a URL / resume position
 *
 * Engine writes position/size/clip/`background-color` (paper) on the page ROOT.
 * Put chapter colour, padding, and images on an INNER node — or accept paper
 * as the face. Children must be host elements (`div`, …) that forward a ref;
 * otherwise the binding throws.
 */

const leafRoot: CSSProperties = {
  boxSizing: 'border-box',
  height: '100%',
};

const leafInner = (bg: string): CSSProperties => ({
  boxSizing: 'border-box',
  height: '100%',
  background: bg,
  padding: 16,
  fontFamily: 'system-ui, sans-serif',
  fontSize: 18,
  fontWeight: 600,
});

function svgDataUri(label: string, fill: string, ink = '#111'): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="420" viewBox="0 0 560 420">
    <rect width="560" height="420" fill="${fill}"/>
    <text x="280" y="220" text-anchor="middle" font-family="system-ui,sans-serif" font-size="48" font-weight="700" fill="${ink}">${label}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function pagesLabel(visible: number[], pageCount: number): string {
  const shown = visible.map((i) => i + 1);
  if (shown.length === 0) return `— of ${pageCount}`;
  return `${shown.join('–')} of ${pageCount}`;
}

function PictureBook() {
  const book = usePageFlip(0, { hardCovers: true });

  const pages = useMemo(
    () => [
      { src: svgDataUri('Cover', '#c45c26', '#fff7ed'), alt: 'Cover — warm terracotta field' },
      { src: svgDataUri('Fox', '#f4ecd8'), alt: 'A fox illustration on cream paper' },
      { src: svgDataUri('Meadow', '#d8efe4'), alt: 'A green meadow spread' },
      { src: svgDataUri('End', '#1e293b', '#e2e8f0'), alt: 'Back matter on slate' },
    ],
    [],
  );

  return (
    <section style={{ marginBottom: 48 }}>
      <h2 style={{ margin: '0 0 8px' }}>Picture book — hard covers, built-in controls</h2>
      <p style={{ margin: '0 0 12px', color: '#555', maxWidth: 520 }}>
        Pictures are HTML <code>&lt;img alt&gt;</code>. <code>controls=&quot;visible&quot;</code> is
        the previous/next a browse-mode screen reader can actually use. <code>hardCovers</code>{' '}
        shows the first and last leaves alone.
      </p>
      <p style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, color: '#333' }}>
        pages {pagesLabel(book.visiblePages, book.pageCount)} · {book.orientation}
      </p>
      <HTMLFlipBook
        ref={book.ref}
        width={280}
        height={210}
        sizing="fixed"
        flippingTime={500}
        controls="visible"
        controlLabels={{ previous: 'Previous page', next: 'Next page' }}
        pageBackground="var(--paper, #f4ecd8)"
        {...book.bookProps}
        style={{ maxWidth: 560 }}
        aria-label="Picture book"
      >
        {pages.map((p) => (
          <div key={p.alt} style={leafRoot}>
            <img
              src={p.src}
              alt={p.alt}
              style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }}
            />
          </div>
        ))}
      </HTMLFlipBook>
    </section>
  );
}

function InteractiveBook() {
  const book = usePageFlip(0);
  const [state, setState] = useState<PageState>('read');
  const [rtl, setRtl] = useState(false);
  const [locked, setLocked] = useState(false);
  const [plays, setPlays] = useState(0);

  const onChangeState = useCallback((info: { state: PageState }) => {
    setState(info.state);
  }, []);

  const turning = locked || state !== 'read';

  return (
    <section style={{ marginBottom: 48 }}>
      <h2 style={{ margin: '0 0 8px' }}>Your own chrome — RTL, hotspot, lock</h2>
      <p style={{ margin: '0 0 12px', color: '#555', maxWidth: 520 }}>
        <code>usePageFlip</code> is uncontrolled — never pass <code>page={'{book.page}'}</code>. A{' '}
        <code>&lt;button&gt;</code> on the leaf does not start a fold, and neither does a{' '}
        <code>&lt;video controls&gt;</code>, <code>&lt;audio controls&gt;</code>,{' '}
        <code>&lt;iframe&gt;</code>, <code>&lt;embed&gt;</code>, or <code>&lt;object&gt;</code>. A
        video without controls still swipes. A portrait curl freezes video as a canvas and strips
        audio; play and pause stay in this component. Lock is three live knobs, not a freeze of{' '}
        <code>page</code>.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <button type="button" onClick={() => book.flipPrev()} disabled={turning || !book.canGoPrev}>
          Prev
        </button>
        <button type="button" onClick={() => book.flipNext()} disabled={turning || !book.canGoNext}>
          Next
        </button>
        <button type="button" onClick={() => book.goToPage(0, 'instant')} disabled={locked}>
          First
        </button>
        <button type="button" onClick={() => book.goToPage(2)} disabled={locked}>
          Go to leaf 3
        </button>
        <button type="button" onClick={() => setRtl((v) => !v)} aria-pressed={rtl}>
          RTL: {rtl ? 'on' : 'off'}
        </button>
        <button type="button" onClick={() => setLocked((v) => !v)} aria-pressed={locked}>
          Lock: {locked ? 'on' : 'off'}
        </button>
      </div>
      <p
        data-demo-status=""
        style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, color: '#333' }}
      >
        pages {pagesLabel(book.visiblePages, book.pageCount)} · {state} · plays {plays} · rejected{' '}
        {book.lastRejection ? book.lastRejection.reason : '—'}
      </p>
      <HTMLFlipBook
        ref={book.ref}
        width={280}
        height={360}
        sizing="fixed"
        flippingTime={400}
        readingDirection={rtl ? 'rtl' : 'ltr'}
        {...book.bookProps}
        controls="none"
        useKeyboard={!locked}
        flipOnClick={locked ? 'never' : 'anywhere'}
        pointerInput={locked ? [] : ['mouse', 'touch', 'pen']}
        onChangeState={onChangeState}
        style={{ maxWidth: 560 }}
        aria-label="Interactive HTML flipbook"
      >
        <div style={leafRoot}>
          <div style={leafInner('#ffe4e1')}>One</div>
        </div>
        <div style={leafRoot}>
          <div style={leafInner('#e0f0ff')}>
            Two
            <div style={{ marginTop: 12 }}>
              <button type="button" onClick={() => setPlays((n) => n + 1)}>
                Play (must not fold)
              </button>
            </div>
          </div>
        </div>
        <div style={leafRoot}>
          <div style={leafInner('#e6ffe6')}>Three</div>
        </div>
        <div style={leafRoot}>
          <div style={leafInner('#fff5cc')}>Four</div>
        </div>
      </HTMLFlipBook>
    </section>
  );
}

function ControlledBook() {
  const [page, setPage] = useState(0);
  const [visible, setVisible] = useState<number[]>([]);
  const [pageCount, setPageCount] = useState(0);
  const [instant, setInstant] = useState(true);

  return (
    <section>
      <h2 style={{ margin: '0 0 8px' }}>Controlled page — resume / deep link</h2>
      <p style={{ margin: '0 0 12px', color: '#555', maxWidth: 520 }}>
        Own <code>page</code> and <code>onPageChange</code>. Do not use <code>usePageFlip</code>{' '}
        here. Instant is <code>popstate</code> / a shared URL; animate is an in-app turn.{' '}
        <code>page</code> is the spread head — chrome uses <code>visiblePages</code>.
      </p>
      <div style={{ marginBottom: 12 }}>
        <button type="button" onClick={() => setInstant((v) => !v)} aria-pressed={instant}>
          pageTransition: {instant ? 'instant' : 'animate'}
        </button>
      </div>
      <p style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, color: '#333' }}>
        {pagesLabel(visible, pageCount)} · head {page}
      </p>
      <HTMLFlipBook
        width={280}
        height={200}
        sizing="fixed"
        flippingTime={400}
        page={page}
        pageTransition={instant ? 'instant' : 'animate'}
        onPageChange={(snapshot) => {
          setPage(snapshot.page);
          setPageCount(snapshot.pageCount);
          setVisible(snapshot.visiblePages);
        }}
        onLoaded={(snapshot) => {
          setPage(snapshot.page);
          setPageCount(snapshot.pageCount);
          setVisible(snapshot.visiblePages);
        }}
        controls="visible"
        style={{ maxWidth: 560 }}
        aria-label="Controlled flipbook"
      >
        <div style={leafRoot}>
          <div style={leafInner('#fde68a')}>A</div>
        </div>
        <div style={leafRoot}>
          <div style={leafInner('#bfdbfe')}>B</div>
        </div>
        <div style={leafRoot}>
          <div style={leafInner('#bbf7d0')}>C</div>
        </div>
        <div style={leafRoot}>
          <div style={leafInner('#fecaca')}>D</div>
        </div>
      </HTMLFlipBook>
    </section>
  );
}

function App() {
  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ marginTop: 0 }}>@gullabs/react-flipbook</h1>
      <PictureBook />
      <InteractiveBook />
      <ControlledBook />
    </main>
  );
}

const rootEl = document.getElementById('root');
if (!(rootEl instanceof HTMLElement)) {
  throw new Error('#root element is required');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
