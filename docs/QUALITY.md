# Quality gates and bundle size

Working rules: [`AGENTS.md`](../AGENTS.md). Architecture: [`CLAUDE.md`](../CLAUDE.md).

Lint / type strictness climb (Phases A–D: `no-unsafe-*`,
`noUncheckedIndexedAccess`, `no-unnecessary-condition`, optional ratchets) is
**done**. Current floors only move **up**. Run `pnpm quality:ci` — that is the
definition of done.

## Bundle size

### Measured baseline (post canvas removal)

Both artifacts are terser-minified. Upstream measured from its published
tarball (`npm pack page-flip@2.0.7`).

|                                                          | raw (min) |   gzip | brotli |
| -------------------------------------------------------- | --------: | -----: | -----: |
| `page-flip@2.0.7` (upstream)                             |    44,058 | 10,360 |  9,261 |
| `@gullabs/flipbook-core` HTML engine (early post-canvas) |    56,015 | 15,395 | 13,734 |

Re-measure with `pnpm size` before quoting current numbers. Owner-approved
ceilings as of 2026-09-08: **66 kB raw / 16.1 kB brotli / 18.2 kB gzip**.

**The old "≤ 35 kB minified" target is retired.** Upstream itself is 44 kB;
that target asked this fork to be smaller while doing more.

### Policy (`AGENTS.md` §2)

1. Dead code always goes.
2. Working code never goes to buy bytes.
3. A correctness fix or feature may spend the headroom — and say so in the
   commit message.
4. If a size gate fires, ask **why it grew**, not what can be deleted.

`scripts/pack-html-engine.mjs` concatenates shipped chunks into one envelope.
That is a **drift signal** (accidental dependency, broken tree-shake), not the
per-consumer payload a bundler emits for `import { PageFlip }`.

Helper-name golf and error-message shortening buy almost nothing after terser
mangles module-internal symbols — measure before spending readability.

### Peer context

At ~12–18 kB gzip the engine sits between Splide (~11 kB) and Swiper (20–47 kB),
above headless carousels that leave controls to the host. Reasonable for a
widget that owns page geometry, curl rendering, DOM ownership, pointer input
and responsive layout.

Splitting RTL / reduced motion behind opt-in subpaths was considered and
rejected: they are small conditionals threaded through `Flip` / `UI` /
`Render`, not separable modules.

## Open: frame-time gate

Bytes are gated to high precision; **frame cost during a curl is not measured**.
That is the wrong priority for a flipbook.

Proposed (not built — see [TODO.md](./TODO.md)): deterministic Playwright
fixture on pinned Chromium, ordinary HTML pages, scripted forward/back flip:

| Metric                                      | Threshold |
| ------------------------------------------- | --------- |
| p95 rAF interval during a flip              | ≤ 20 ms   |
| p99 rAF interval during a flip              | ≤ 33 ms   |
| Long Animation Frames > 50 ms during a flip | 0         |
| Pointer/key to first visual response        | ≤ 100 ms  |

Do **not** claim the library "passes INP". INP is a field metric for the host
page. This repo can honestly claim a bounded frame profile in its own fixture.
