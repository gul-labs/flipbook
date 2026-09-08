# Roadmap

Ship bar for **3.0.0** is locked in [`docs/API-CONTRACT.md`](./docs/API-CONTRACT.md).
What follows is the **post-3.0** backlog — additive or internal only. Anything
that needs a breaking change goes to the owner first.

## Near term

Tracked in detail in [`docs/TODO.md`](./docs/TODO.md):

- Hosted demo + docs site (the #1 public-product gap for a visual library)
- StackBlitz / one-click repro starters
- Firefox in Playwright e2e (Chromium + WebKit already gate)
- Additive API: `validateFlipOptions`, controls styling seam, spread-space
  position, `pageLabel`, shadow / paper-base tokens, `allowTextSelection`
- OpenSSF Scorecard Action + public coverage badge
- (done) Sponsor button + GitHub Issue Forms
- (done) Class-pair collapses, frame discipline, `turnProgress`
- (done) Mobile live-HTML F01–F05

## Later

- Headless-controller renderer seam → optional WebGL path
  ([`docs/WEBGL_RENDERER.md`](./docs/WEBGL_RENDERER.md) — deferred by owner)
- Binding-owned leaf hosts (4.0-shaped DOM ownership)
- Vue / Svelte adapters — positioning choice, not a default
- Correlated turn lifecycle events (F06) — locked-surface amendment

## Not planned

- Storybook, Discord, commitlint, all-contributors as first work — ornaments
  until a hosted flip demo exists
- DCO / CLA — inbound=outbound in `CONTRIBUTING.md` is enough
- Canvas / `loadFromImages` — removed in 3.0 (ADR 0002)

## How to follow along

- Issues and PRs on this repo
- Release notes in [`CHANGELOG.md`](./CHANGELOG.md)
- npm: [`@gullabs/flipbook-core`](https://www.npmjs.com/package/@gullabs/flipbook-core),
  [`@gullabs/react-flipbook`](https://www.npmjs.com/package/@gullabs/react-flipbook)
