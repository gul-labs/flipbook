# @gullabs/react-flipbook

React 18/19 binding for [`@gullabs/flipbook-core`](https://www.npmjs.com/package/@gullabs/flipbook-core).
Maintained fork of react-pageflip. License: **MIT** (engine dependency is MPL-2.0).

Full monorepo docs:

- https://github.com/gul-labs/flipbook#readme
- Migration from `react-pageflip@2.x`: https://github.com/gul-labs/flipbook/blob/main/MIGRATION.md
- Locked API surface: https://github.com/gul-labs/flipbook/blob/main/docs/API-CONTRACT.md
- Live page faces (narration / highlight): https://github.com/gul-labs/flipbook/blob/main/docs/LIVE-PAGE-FACES.md

```bash
npm i @gullabs/react-flipbook
# pulls @gullabs/flipbook-core; react is a peer (>=18)
```

## Quickstart

```tsx
import { useState } from 'react';
import HTMLFlipBook, { type BookSnapshot } from '@gullabs/react-flipbook';

export function Book() {
  // Seed from onLoaded. onPageChange fires only for real turns, never on mount.
  const [book, setBook] = useState<{ page: number; pageCount: number } | null>(null);
  const sync = (s: BookSnapshot) => setBook({ page: s.page, pageCount: s.pageCount });

  return (
    <>
      <p>{book ? `Page ${book.page + 1} of ${book.pageCount}` : 'Loading…'}</p>
      <HTMLFlipBook width={300} height={500} onLoaded={sync} onPageChange={sync}>
        {/* Host element required. Style content on an INNER wrapper — the
            engine owns layout + paper on the leaf root. */}
        <div>
          <div style={{ height: '100%', padding: 16 }}>Page 1</div>
        </div>
        <div>
          <div style={{ height: '100%', padding: 16 }}>Page 2</div>
        </div>
      </HTMLFlipBook>
    </>
  );
}
```

## First-hour rules

1. **`onLoaded` for the initial counter** — `onPageChange` / core `flip` do not
   fire on mount (only when the page index actually changes).
2. **Style an inner wrapper**, not the leaf root. The engine writes position,
   size, clip, and paper onto the root every draw.
3. **Controlled `page` needs `onPageChange`** — otherwise the engine turns and
   your prop snaps it back (a locked book).
4. **Do not drive `initialPage` from live URL state** — it is a remount key.
   Freeze the deep link at mount, or use controlled `page`.

## Common props and events

| Prop / event            | Role                                                                        |
| ----------------------- | --------------------------------------------------------------------------- |
| `width` / `height`      | Required page size                                                          |
| `page` + `onPageChange` | Controlled page (optional `pageTransition`: `'animate'` \| `'instant'`)     |
| `onLoaded` / `onReady`  | Initial / once-per-engine snapshot (`page`, `pageCount`, `visiblePages`, …) |
| `onTurnProgress`        | Fold progress `0…1` while animating or dragging (silent on instant turns)   |
| `onTurnRejected`        | Turn did not start (`reason`, `direction`, `targetPage`, `landedOn`)        |
| `controls`              | `'auto'` \| `'visible'` \| `'none'`                                         |
| `hardCovers`            | Cover leaves shown alone, hard density                                      |
| `pageBackground`        | Paper color (any CSS color; opacity is structural)                          |
| `injectStyles`          | Default `true`; set `false` under strict CSP and import core `style.css`    |

Handle methods (`ref` → `FlipBookHandle`):

| Method                  | Role                                                |
| ----------------------- | --------------------------------------------------- |
| `flipNext` / `flipPrev` | Animate relative turn (`boolean`)                   |
| `flipToPage(n)`         | Animate to page (`boolean`)                         |
| `turnToPage(n)`         | Instant jump (`boolean`)                            |
| `cancelTurn()`          | Abandon in-flight turn without committing           |
| `destroy()`             | Tear down the engine **and** retire the React shell |
| `pageFlip()`            | Escape hatch → core `PageFlip \| null`              |

Queries such as `getPageCount` / `getVisiblePages` live on the **engine**
(`pageFlip()?.getPageCount()`) or on `usePageFlip()` state — not on the handle.
Prefer `destroy()` on the handle over `pageFlip()?.destroy()`: the latter tears
the engine down but does not retire the React shell until the next render.

## License

MIT for this package. The engine (`@gullabs/flipbook-core`) is MPL-2.0 — see
https://github.com/gul-labs/flipbook/blob/main/packages/core/LICENSE.

Copyright (c) 2026 Gul Labs.
