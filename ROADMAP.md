# Roadmap

Ship bar for **3.0.0** is locked in [`docs/API-CONTRACT.md`](./docs/API-CONTRACT.md).

**Puddlebend consumer requests** (feature/defect asks with requirements and
degrade-if-missing): [`docs/requests/PUDDLEBEND-REQUESTS.md`](./docs/requests/PUDDLEBEND-REQUESTS.md).  
Maintainer triage notes: [`docs/TRIAGED-BACKLOG.md`](./docs/TRIAGED-BACKLOG.md).  
Checklist: [`docs/TODO.md`](./docs/TODO.md).

Anything that needs a breaking change or event-map amendment goes to the owner
first (ADR).

## This month (honesty — not features)

- Strike stale lazyRadius OOM comments (bug fixed; tests green).
- Document React-only settings vs core `FlipOptions` (stop vanilla footguns).
- Document `turnProgress` scrubber limits + stable React child identity.
- Document unknown core settings behavior (ignored today).
- **No** library rewrite for physical WKWebView dogfood — that is consumer
  acceptance. Engine bugs only with post-`INITIALIZED` repros.

## Near term (when touching a minor)

Tracked in detail in the triaged backlog + [`docs/TODO.md`](./docs/TODO.md):

- Hosted demo + docs site (the #1 public-product gap for a visual library)
- StackBlitz / one-click repro starters
- Firefox in Playwright e2e (Chromium + WebKit already gate)
- Additive API: `validateFlipOptions`, controls styling seam, spread-space
  position (`getSpreadCount`), `pageLabel`, shadow / paper-base tokens,
  `<FlipPage>`, closed-book centering **recipe** (option only if still painful)
- `allowTextSelection` — **parked** until a product needs book-mode copy
- Public coverage badge (Scorecard Action + README badge already landed)
- (done) Sponsor button + GitHub Issue Forms
- (done) OpenSSF Scorecard Action + README badge
- (done) Class-pair collapses, frame discipline, `turnProgress`
- (done) Mobile live-HTML F01–F05
- (done) Next.js example real `flippingTime` (`flippingTime={500}`)

## Conditional (evidence gates)

- Frame-time CI fixture — after physical jank evidence or explicit owner ask
  (bytes are gated; frame cost is not — see [`docs/QUALITY.md`](./docs/QUALITY.md))
- Core/HTML lazy window — after physical jetsam evidence
- F06 turn lifecycle ids — when read-along is authorized and current events fail
  (**no audio in core**; locked-surface amendment)

## Later / parked

- Vue / Svelte adapters — positioning choice, not a default
- Android WebView CI — when product Android is scheduled
- RN generic adapter — after a product WebView bridge is proven extractable
- Binding-owned leaf hosts (4.0-shaped DOM ownership) — design only
- Headless-controller renderer seam → optional WebGL path
  ([`docs/WEBGL_RENDERER.md`](./docs/WEBGL_RENDERER.md) — deferred by owner,
  not scheduled)

## Not planned (do not schedule)

- Storybook, Discord, commitlint, all-contributors as first work — ornaments
  until a hosted flip demo exists
- DCO / CLA — inbound=outbound in `CONTRIBUTING.md` is enough
- Canvas / `loadFromImages` — removed in 3.0
  ([ADR 0002](./docs/adr/0002-remove-canvas-mode.md))
- PDF adapter, sound/karaoke/auto-flip in core, haptics API in core
- Treating missing physical device dogfood as a core rewrite mandate
- “Fixing” intentional `turnProgress` silence on instant / reduced-motion turns

## How to follow along

- Issues and PRs on this repo
- Release notes in [`CHANGELOG.md`](./CHANGELOG.md)
- npm: [`@gullabs/flipbook-core`](https://www.npmjs.com/package/@gullabs/flipbook-core),
  [`@gullabs/react-flipbook`](https://www.npmjs.com/package/@gullabs/react-flipbook)
