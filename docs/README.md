# Docs

Live option/event demos live in `examples/` (vanilla, Vite React, Next.js App Router).
The engine is **HTML only** — canvas / images mode was removed ([ADR 0002](./adr/0002-remove-canvas-mode.md)).

The Next.js example is the SSR-safety proof: `<HTMLFlipBook>` renders a stable
`data-flipbook-placeholder` node before hydration.

| Doc                                                            | What it is                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------------- |
| [ADR 0002](./adr/0002-remove-canvas-mode.md)                   | Canvas mode removed (accepted, implemented)                |
| [ADR 0001](./adr/0001-image-page-api.md)                       | Image-page API — **superseded** by 0002                    |
| [CANVAS_FIRST_CLASS.md](./CANVAS_FIRST_CLASS.md)               | Nine-phase canvas plan — **superseded**, kept as inventory |
| [WEBGL_RENDERER.md](./WEBGL_RENDERER.md)                       | 3D renderer analysis, deferred                             |
| [QUALITY_BAR_CLIMB.md](./QUALITY_BAR_CLIMB.md)                 | Lint/type strictness climb + measured size                 |
| [LIVE-PAGE-FACES.md](./LIVE-PAGE-FACES.md)                     | What stays live on a page during a curl (F04)              |
| [MOBILE_LIVE_HTML_PROPOSAL.md](./MOBILE_LIVE_HTML_PROPOSAL.md) | Mobile live-HTML plan (F06 deferred)                       |

A Starlight/GitHub Pages site is a post-3.0.0 minor.
