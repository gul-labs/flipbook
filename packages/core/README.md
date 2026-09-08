# @gullabs/flipbook-core

Framework-agnostic HTML page-curl engine. Maintained fork of StPageFlip.
**Zero runtime dependencies.** License: **MPL-2.0**.

Full monorepo docs (install recipes, styling, events, accessibility, SSR/CSP):

- https://github.com/gul-labs/flipbook#readme
- Migration from `page-flip@2.x`: https://github.com/gul-labs/flipbook/blob/main/MIGRATION.md
- Locked API surface: https://github.com/gul-labs/flipbook/blob/main/docs/API-CONTRACT.md
- Known limitations: https://github.com/gul-labs/flipbook/blob/main/docs/KNOWN-LIMITATIONS.md

```bash
npm i @gullabs/flipbook-core
```

```ts
import { PageFlip } from '@gullabs/flipbook-core';
// Optional under a strict CSP — default is runtime style injection:
// import '@gullabs/flipbook-core/style.css';

const pageFlip = new PageFlip(root, { width: 400, height: 600 });
pageFlip.loadFromHTML(pages);
// HTML only — loadFromImages / canvas mode were removed in 3.0.0.
// Pictures: put <img alt="…"> inside the HTML page elements.
```

## Essentials

| Topic        | Rule                                                                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Paper color  | `pageBackground` (default `#fff`) → `--stf-paper`. Opacity is structural.                                                           |
| Leaf styling | Style an **inner** wrapper; the engine owns layout + paper on the leaf root.                                                        |
| Stylesheet   | Default injects CSS. CSP: `injectStyles: false` + ship `style.css` / `FLIPBOOK_CSS`.                                                |
| Navigation   | `flipToPage` / `flipNext` / `flipPrev` animate; `turnTo*` are instant. Relative turns return `boolean` and may emit `turnRejected`. |
| Progress     | `turnProgress` while a fold moves; completion is `flip` / `changeState`, not a final progress tick.                                 |
| Cancel       | `cancelTurn()` aborts an in-flight turn without committing.                                                                         |
| Queries      | `getVisiblePages()`, `canTurn(dir)`, `getPageCount()`, `getCurrentPageIndex()`, `isReady()`, `isAnimating()`.                       |

## Error codes

Public failures throw `PageFlipError` with a stable `code` and `kind`
(`usage` | `lifecycle` | `internal`). Setting failures also set `err.setting`.

| Code                 | Kind      | When                                                    |
| -------------------- | --------- | ------------------------------------------------------- |
| `INVALID_SETTING`    | usage     | A setting failed validation (`err.setting` names which) |
| `INVALID_PAGE`       | usage     | Page index out of range                                 |
| `PAGE_NOT_IN_SPREAD` | usage     | Page exists but is in no spread                         |
| `INVALID_INDEX`      | usage     | Internal array access out of range                      |
| `WRONG_MODE`         | usage     | Reserved after canvas removal; not thrown by HTML today |
| `DESTROYED`          | lifecycle | Called after `destroy()`                                |
| `NOT_LOADED`         | lifecycle | API used before load finished                           |
| `DETACHED_PAGE`      | lifecycle | A page element left the document mid-turn               |
| `NO_ANIMATION_FRAME` | lifecycle | Animation frame list was empty                          |
| `COLLINEAR_SEGMENTS` | internal  | Geometry: segments are collinear                        |
| `DEGENERATE_SEGMENT` | internal  | Geometry: a segment has zero length                     |
| `FLIP_SETUP`         | internal  | Could not prepare flipping/bottom pages                 |
| `INVALID_SPREAD`     | internal  | Spread index invalid during a turn                      |
| `RENDER_SETUP`       | internal  | Shadow/DOM render setup failed                          |
| `PAGE_FLIP`          | internal  | Generic / unspecified                                   |

`flipNext` / `flipPrev` return `boolean` (`false` = did not start) and emit
`turnRejected` when refused — that is not an exception path.

## License

**MPL-2.0** — file-level copyleft. Your application is not Covered Software
when you only import and call the public API. Distribution of the engine
(including bundled browser JS) requires source availability + notice; for the
unmodified npm package, point at https://github.com/gul-labs/flipbook.

Copyright (c) 2026 Gul Labs, with upstream Nodlik MIT notices in
[LICENSE](https://github.com/gul-labs/flipbook/blob/main/packages/core/LICENSE).
