'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { HTMLFlipBook, usePageFlip } from '@gullabs/react-flipbook';

/**
 * App Router: SSR emits `data-flipbook-placeholder`; after hydration the engine
 * builds `.stf__*` and portals leaves into `.stf__block`.
 *
 * Engine writes paper onto the page ROOT (`background-color` / `--stf-paper`).
 * Chapter colour and padding live on an inner wrapper. Children must be host
 * elements so the binding can ref them — a missing host throws.
 */

const leafRoot: CSSProperties = { boxSizing: 'border-box', height: '100%' };

const leafInner = (bg: string): CSSProperties => ({
  boxSizing: 'border-box',
  height: '100%',
  background: bg,
  padding: 20,
  fontFamily: 'system-ui, sans-serif',
  fontSize: 18,
  fontWeight: 600,
});

export default function Page() {
  const book = usePageFlip(0, { hardCovers: true });
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  const shown = book.visiblePages.map((i) => i + 1).join('–') || '—';

  return (
    <main
      style={{
        padding: 24,
        fontFamily: 'system-ui, sans-serif',
        maxWidth: 720,
      }}
    >
      <h1 style={{ marginTop: 0 }}>Next.js App Router</h1>
      <p style={{ color: '#555', maxWidth: 520 }}>
        SSR emits <code>data-flipbook-placeholder</code> with <strong>no leaves</strong>. You own
        no-JS content. After hydration the book curls — real <code>flippingTime</code>, not instant.{' '}
        <code>controls</code>, <code>lazyRadius</code>, and controlled <code>page</code> are
        React-only; core <code>PageFlip</code> ignores them.
      </p>
      <p style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }}>
        {hydrated ? 'hydrated' : 'ssr'} · pages {shown} of {book.pageCount} · {book.orientation}
      </p>

      <HTMLFlipBook
        ref={book.ref}
        width={300}
        height={400}
        sizing="fixed"
        flippingTime={500}
        controls="visible"
        pageBackground="#ffffff"
        {...book.bookProps}
        style={{ maxWidth: 600 }}
        aria-label="Next.js flipbook demo"
      >
        <div style={leafRoot}>
          <div style={leafInner('#ffe4e1')}>Cover</div>
        </div>
        <div style={leafRoot}>
          <div style={leafInner('#e0f0ff')}>One</div>
        </div>
        <div style={leafRoot}>
          <div style={leafInner('#e6ffe6')}>Two</div>
        </div>
        <div style={leafRoot}>
          <div style={leafInner('#fff5cc')}>Back</div>
        </div>
      </HTMLFlipBook>
    </main>
  );
}
