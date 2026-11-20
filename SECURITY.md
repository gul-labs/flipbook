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

- Releases publish from GitHub Actions. The Release workflow is triggered by a successful run of the CI workflow (gitleaks + the canary-verified production audit `pnpm audit:gate` + `quality:ci`) and re-runs `pnpm preflight` immediately before publishing. See [`RELEASING.md`](./RELEASING.md).
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements) comes only from [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, `id-token: write`): pnpm 12 publishes natively and ignores `NPM_CONFIG_PROVENANCE`. Trusted publishing must be configured on npmjs.com for each package against `gul-labs/flipbook` / `release.yml`; whether it is, is **not confirmed**. Until it is, publishes authenticate with the long-lived **npm automation token** in the `NPM_TOKEN` secret and carry **no** provenance — and the Release job's provenance check then fails red. See [`RELEASING.md`](./RELEASING.md).
- Installs refuse any package version published less than 24 hours ago (`minimumReleaseAge: 1440` in `pnpm-workspace.yaml`, strict because it is set explicitly, and re-checked against every lockfile entry on frozen installs).
- CI runs `gitleaks` on every pull request and on `main`.
- Dependabot opens weekly PRs for npm and GitHub Actions.
- Dependency install lifecycle scripts are blocked unless allow-listed in `allowBuilds` in [`pnpm-workspace.yaml`](./pnpm-workspace.yaml). `pnpm preflight` fails if the allowlist is missing or if a stale `onlyBuiltDependencies` / `package.json` `pnpm` field reappears.

## Supply chain

- Prefer installing from the published npm packages once `@gullabs/*` are released from this repository.
- Do not paste production secrets into issues, PRs, or sample code.
- Published package tarballs ship **`dist/` only** (no `src/`).
