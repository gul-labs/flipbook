# Docs

Live option/event demos live in `examples/` (vanilla, Vite React, Next.js App
Router, mobile reader). The engine is **HTML only** — canvas / images mode was
removed ([ADR 0002](./adr/0002-remove-canvas-mode.md)).

| Doc                                                  | What it is                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| [API-CONTRACT.md](./API-CONTRACT.md)                 | Locked 3.0 public surface                                   |
| [TODO.md](./TODO.md)                                 | Open backlog (additive / internal only)                     |
| [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md)       | Accepted constraints and deferred-with-cause items          |
| [LIVE-PAGE-FACES.md](./LIVE-PAGE-FACES.md)           | What stays live on a page during a curl                     |
| [ABSTRACTION-BOUNDARY.md](./ABSTRACTION-BOUNDARY.md) | Why the façade answers questions; class pairs collapsed     |
| [WEBGL_RENDERER.md](./WEBGL_RENDERER.md)             | Deferred 3D renderer analysis (wrong seam = `Render`)       |
| [QUALITY.md](./QUALITY.md)                           | Bundle-size policy, measured baseline, open frame-time gate |
| [adr/0002](./adr/0002-remove-canvas-mode.md)         | Canvas mode removed                                         |
| [adr/0003](./adr/0003-flip-event-semantics.md)       | `flip` fires only when the page index changes               |

A hosted docs site is post-publish polish (see root [`ROADMAP.md`](../ROADMAP.md)).
