# Security Policy

## Supported versions

Security fixes land on `main` and ship with the next release of the affected package. Pre-1.0 / fork-stabilization releases do not receive long-lived backport branches. Upgrade to the latest version of the package you use.

## Reporting a vulnerability

**Do not open a public issue.**

Report privately through [GitHub Security Advisories](https://github.com/gul-labs/flipbook/security/advisories/new).

We aim to acknowledge within a few business days. Please include:

- Affected package and version
- A minimal reproduction or a clear description of the impact
- Whether you believe the issue is already being exploited

We will coordinate a fix and a public advisory before any disclosure.

## Scope — XSS / HTML sinks

This library renders page-flip UI in the browser. **There is no built-in HTML sanitization.** Nodes are moved or cloned as-is into the engine DOM.

Treat untrusted page content the same way you would any user-controlled DOM: sanitize **before** handing nodes to the engine.

| Sink                     | API                                                      | Risk                                                                                                                                                                                                                                                                           |
| ------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HTML page elements       | `PageFlip.loadFromHTML(items)` / `updateFromHtml(items)` | Caller-owned elements are adopted into `.stf__block`                                                                                                                                                                                                                           |
| React children           | `<HTMLFlipBook>{children}</HTMLFlipBook>`                | Same DOM ownership path via portal                                                                                                                                                                                                                                             |
| Image URLs in HTML pages | Consumer `<img src>` inside `loadFromHTML` pages         | Same as any app-controlled image URL — engine does not fetch image lists                                                                                                                                                                                                       |
| Fold fill color          | setting `pageBackground`                                 | Rejected at settings resolve with `INVALID_SETTING` (declaration breakers / non-colours). Draw-time normalizer still falls back to `#fff` if a value somehow bypasses the boundary. Not a script XSS sink in modern browsers; still treat untrusted config as untrusted input. |

Correct method names use camelCase `loadFromHTML` / `updateFromHtml` (not `loadFromHtml`).

## Releases and CI

- Releases publish from GitHub Actions. The Release workflow is triggered by a successful run of the CI workflow (gitleaks + `pnpm audit --prod` + `quality:ci`) and re-runs `pnpm preflight` immediately before publishing. See [`RELEASING.md`](./RELEASING.md).
- Publish uses an **npm automation token** stored as the `NPM_TOKEN` repository secret, plus [npm provenance](https://docs.npmjs.com/generating-provenance-statements) (`id-token: write` + `NPM_CONFIG_PROVENANCE=true`). Provenance is signed with the Actions OIDC identity, but the publish itself authenticates with the long-lived token — this repository is **not** yet on npm trusted publishing. Migrating requires per-package setup on npmjs.com first; see [`RELEASING.md`](./RELEASING.md).
- CI runs `gitleaks` on every pull request and on `main`.
- Dependabot opens weekly PRs for npm and GitHub Actions.
- Install lifecycle scripts are allow-listed via `pnpm.onlyBuiltDependencies` in the root `package.json`.

## Supply chain

- Prefer installing from the published npm packages once `@gullabs/*` are released from this repository.
- Do not paste production secrets into issues, PRs, or sample code.
- Published package tarballs ship **`dist/` only** (no `src/`).
