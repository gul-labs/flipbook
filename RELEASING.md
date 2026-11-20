# Releasing

This monorepo uses [Changesets](https://github.com/changesets/changesets) for version management and publishing to npm. Publishing is done by GitHub Actions, not from a developer machine. The pipeline matches [`gul-labs/any-llm`](https://github.com/gul-labs/any-llm).

## Provenance

This repository is public, and every release is meant to carry an [npm provenance](https://docs.npmjs.com/generating-provenance-statements) attestation. Under pnpm 12 that attestation comes **only** from [npm trusted publishing](https://docs.npmjs.com/trusted-publishers), and trusted publishing is **required** for it.

**Required setup on npmjs.com, per package — not confirmed to exist yet.** For each of `@gullabs/flipbook-core` and `@gullabs/react-flipbook`: package → Settings → Trusted Publisher → GitHub Actions, organization `gul-labs`, repository `flipbook`, workflow file `release.yml`. Only the package owner can do this. **Until it is done for a package, the Release job cannot publish it at all**: there is no npm token in the workflow any more, so a failed trusted-publisher exchange leaves pnpm with no valid credential and the upload is rejected (rehearsed below). That is deliberate — no trusted publisher means no publish, never an unattested one.

Why there is no token: when a trusted publisher is configured, pnpm uses the OIDC exchange even with a token present (any-llm 0.17.0, and the rehearsal below), so a token's only effect would be to make an **unattested** publish possible whenever the exchange fails. The `NPM_TOKEN` repository secret is no longer read by any workflow; once both trusted publishers exist the owner can delete it (and should revoke the npm token behind it).

Why there is no `NPM_CONFIG_PROVENANCE` either: pnpm 9/10 published by shelling out to the npm CLI, which honoured that variable. pnpm 11+ publishes natively and reads `provenance` only from the `--provenance` CLI flag — not from the environment and not from `.npmrc` — and `changeset publish` calls `pnpm publish` with a fixed argument list, so the flag cannot be passed. `gul-labs/any-llm` hit exactly this: its first pnpm 11 release (0.14.0) shipped without an attestation, and it moved to trusted publishing.

An unattested version can still reach the registry without a token: pnpm 12.21.0 checks the package's visibility (`GET /-/package/<name>/visibility`) with the exchanged token before signing, and if that lookup fails it prints `[WARN] Skipped setting provenance: …` and uploads anyway, exit 0 (rehearsed). The `Verify npm provenance` step (`scripts/check-published-provenance.mjs`, self-tested by `pnpm test:provenance-gate` in `quality:ci`) is what catches that. On every Release run it reads `https://registry.npmjs.org/<name>/<version>` for every version changesets reports as published this run, **and** for every public workspace package at its manifest version; a version the registry has must carry an SLSA `dist.attestations.provenance`. A version this run did not report and the registry does not have is "not published yet". The second half means a version published unattested by an earlier, partly failed run keeps the job red on every later run until a new version supersedes it, instead of dropping out of the list on a rerun. A document without provenance is re-read within the same bounded window before it is reported, and the step fails closed if the registry cannot be read. To check a release by hand: `npm view @gullabs/<pkg>@<version> dist.attestations`.

The Release job also only runs when the CI run's commit (`workflow_run.head_sha`, which it checks out and builds) is the commit GitHub attributes the run to (`github.sha`, documented for `workflow_run` as the "Last commit on default branch"). If `main` moved on while CI ran, the stale run is skipped and the run for the newer commit releases, so the provenance never names a commit other than the one that was built.

### Publish rehearsal (local, against a fake registry)

Nobody can run the real publish path without publishing, so it was rehearsed on 2026-11-20 with pnpm 12.21.0 and @changesets/cli 3.0.3: a scratch copy of the repository with the packages renamed to a throwaway `@rehearsal/*` scope, `pnpm release` (build + `changeset publish`) run exactly as the workflow runs it, the registry pointed at a local fake through the `.npmrc` `setup-node` writes (`//<registry>/:_authToken=${NODE_AUTH_TOKEN}`), `GITHUB_ACTIONS=true`, a fake `ACTIONS_ID_TOKEN_REQUEST_URL`, and every non-local connection blocked (macOS `sandbox-exec` plus a refusing proxy). Observed:

| Scenario                                                                                   | What authenticated the upload                                | Result                                                                                                                               |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Exchange succeeds, static token present                                                    | the exchanged OIDC token (not the static one)                | uploads; provenance attempted                                                                                                        |
| Exchange succeeds, no token (unset, or setup-node's `XXXXX-XXXXX-XXXXX-XXXXX` placeholder) | the exchanged OIDC token                                     | uploads; provenance attempted                                                                                                        |
| Exchange fails (404 / 401), no token                                                       | pnpm still sends the PUT with the empty / placeholder bearer | rejected 401 by the fake (as npm rejects an invalid token), nothing stored, `pnpm release` exits 1 with `ERR_PNPM_FAILED_TO_PUBLISH` |
| Exchange fails, static token present                                                       | the static token                                             | uploads, **no provenance**                                                                                                           |

When the exchange succeeds and the visibility lookup says public, pnpm requests a second id token (audience `sigstore`) and fetches the sigstore TUF root from `tuf-repo-cdn.sigstore.dev`; with that blocked it fails the publish (`ERR_PNPM_PROVENANCE_SIGN`) **before** any upload. A signing failure therefore fails closed; a visibility-lookup failure does not (see above). changesets makes no authenticated pre-flight call: it runs `pnpm info <name> --json` per package (a GET that carries whatever credential the `.npmrc` resolves to), then publishes, then writes one `git-tag` event per published package to `CHANGESETS_OUTPUT`, which is where `changesets/action` gets `published-packages`. Not observed, because it needs the real services: npm's real exchange and visibility responses, sigstore signing, and npm's provenance verification on upload.

If the repository is ever made private again, npm will reject provenance bundles (`E422 Unsupported GitHub Actions source repository visibility: "private"`). Remove the trusted publishers, `id-token: write` and the verify step in that case.

When provenance is attached, npm compares the manifest `repository.url` against the provenance attestation's `sourceRepositoryURI` (derived from the Actions OIDC claims, which include `GITHUB_REPOSITORY`). The org/repo path must be exactly `gul-labs/flipbook`. The comparison is literal, so it is not satisfied by different casing, and **not** by a GitHub redirect from a former org name either. A `git+https://….git` form is valid npm metadata; change the path only. The emergency laptop path does not attach this provenance bundle, so this is a CI-publish constraint.

The Release workflow fails fast if any public package's `repository.url` path does not equal `GITHUB_REPOSITORY`, before `changeset publish` starts. `packages/core/tests/package-metadata.test.ts` asserts the same path on every public package and that this file lists each one. After an org/repo rename, update that test's `repoPath` first.

Registry provenance validation is not exercised by `npm publish --dry-run`. A rejected publish does not consume that package's version, so retry by rolling the path fix forward — never revert to a stale path. `changeset publish` is sequential: if a later package fails after an earlier one succeeded, the published versions are immutable. Before merging a metadata-only fix, verify with `npm view @gullabs/<pkg> version` and `git ls-remote --tags origin` and add a patch changeset for any version already on the registry. If a later Release still returns E422 after the path matches, check that the trusted-publisher exchange actually attached a bundle rather than mutating the URL shape.

## How it works

1. **Add a changeset** while you work — which packages, which semver bump, what changed. (`@gullabs/flipbook-core` and `@gullabs/react-flipbook` are `fixed` and always move together.)
2. **Open and merge the feature PR to `main`.** Feature-branch CI does not publish.
3. **Let the `Release` workflow run after `main` CI succeeds.** `.github/workflows/release.yml` is triggered by a successful `CI` workflow run on `main`.
4. **Changesets decides whether to version or publish:**
   - Pending `.changeset/*.md` files → `changesets/action` opens a "Version Packages" PR.
   - Versions already bumped and no pending changesets → `changesets/action` runs `pnpm release` and publishes unpublished versions through trusted publishing (OIDC; there is no token fallback), then the verify step checks them, and every workspace package version already on the registry, for a provenance attestation.

Do not block a normal CI release on local `npm whoami`. Local npm auth is only for the emergency manual path.

## Day-to-day: adding a changeset

```bash
# From the repo root, on your feature branch:
pnpm changeset
```

The CLI asks which packages changed, the bump level, and a one-line summary. Commit the file under `.changeset/` with the code.

Docs-only, CI-only, and internal-chore PRs do not need a changeset.

## Release flow

```
feature branch  →  PR + changeset file merged to main
                        ↓
              GitHub Actions: Release workflow
                        ↓
         changesets/action opens "Version Packages" PR
         (bumps package.json versions + writes CHANGELOGs)
                        ↓
         Maintainer reviews & squash-merges "Version Packages" PR
                        ↓
              GitHub Actions: Release workflow
                        ↓
         changesets/action publishes to npm
         (provenance only with a trusted publisher; verified, red without)
         GitHub Release tags are created automatically
```

There is also a valid fast path when the feature branch already includes the version commit:

```
feature branch  →  PR with code + package.json/CHANGELOG version bumps merged to main
                        ↓
              GitHub Actions: CI succeeds on main
                        ↓
              GitHub Actions: Release workflow
                        ↓
         changesets/action publishes the already-versioned unpublished packages
```

Use only one path per release:

- **Normal path:** commit `.changeset/*.md`, merge to `main`, then merge the generated "Version Packages" PR.
- **Pre-versioned path:** run `pnpm version-packages` on the feature branch, commit package/changelog updates, and merge that PR directly to `main`.

Do not keep both a pending changeset file and a committed version bump for the same change.

## Packages published

All packages are published to the `@gullabs` scope with `publishConfig.access = "public"`:

| Package                   | npm                                                   |
| ------------------------- | ----------------------------------------------------- |
| `@gullabs/flipbook-core`  | https://www.npmjs.com/package/@gullabs/flipbook-core  |
| `@gullabs/react-flipbook` | https://www.npmjs.com/package/@gullabs/react-flipbook |

## Repository secrets

None for npm. Publishing authenticates through npm trusted publishing (OIDC), configured per package on npmjs.com (see Provenance). The `NPM_TOKEN` secret, if it still exists, is not read by any workflow.

`GITHUB_TOKEN` is provided by GitHub Actions. `release.yml` passes it to
`changesets/action@v2` as the **`github-token` input** (v2 no longer reads
`GITHUB_TOKEN` from the environment).

For the emergency manual path only, a maintainer's own npm login is used; if a granular token is used there, its package permission must be **"All packages in selected scopes and organizations" → `@gullabs`** (npm's "Only select packages" list can only name packages that already exist), and it must not require an OTP, which non-interactive `changeset publish` cannot supply (`ERR_PNPM_OTP_NON_INTERACTIVE`, reported as `failed:needs-2fa`).

### What actually runs at publish time

`changeset publish` (@changesets/cli 3.0.3) detects pnpm and, per package, runs
`pnpm info <name> --json` (and `pnpm info <name>@<version> --json` when the
package is unknown) to decide what is unpublished, then runs, **in the package's
directory**, `pnpm publish --json --access public --tag latest --no-git-checks`.
It passes a tarball path only in `--from-pack-dir` artifact mode, which the
workflow does not use. Consequences:

- The **detached HEAD** this job checks out (`ref: workflow_run.head_sha`) is
  fine — `--no-git-checks` is passed for us.
- pnpm packs the package itself as part of `pnpm publish` (running `prepack`),
  so the uploaded tarball is produced by that invocation, not by a separate
  `pnpm pack`. `pnpm test:packed` (`scripts/check-packed-artifacts.mjs`) runs
  `pnpm pack` on the same tree with the same pnpm and inspects that tarball. In
  the rehearsal the uploaded tarballs were byte-identical to `pnpm pack` output
  for both packages, so the gate inspects an equivalent artifact; it is still a
  separate build, so it proves the build is right, not that a later upload is
  the same bytes.
- `workspace:*` in `@gullabs/react-flipbook`'s dependency on the core is
  rewritten to the concrete version in the uploaded manifest (rehearsed:
  `"@rehearsal/flipbook-core": "3.2.3"`).

For the very first publish, changesets asks the registry (`pnpm info`) whether
each version exists; a 404 means "not published", so both packages publish even
though there is no pending changeset and no version bump. It does **not**
no-op.

## Manual release (emergency)

```bash
pnpm build
pnpm version-packages
changeset publish   # requires npm login on this machine
```

Prefer CI. A laptop publish will not attach the same provenance as the Actions OIDC identity.

## Snapshot / pre-releases

```bash
pnpm changeset pre enter alpha
# ... commit changesets as normal ...
pnpm changeset pre exit   # when ready to graduate
```

## Rollback / yank

If a bad version reaches npm:

1. **Do not force-push** git tags that already published.
2. **Deprecate** the bad version on **both** fixed packages (they move together):

   ```bash
   npm deprecate @gullabs/flipbook-core@X.Y.Z "Broken release; use X.Y.Z+1"
   npm deprecate @gullabs/react-flipbook@X.Y.Z "Broken release; use X.Y.Z+1"
   ```

3. Open a **patch** release via Changesets that fixes the defect and publish through the normal Release workflow.
4. Unpublish is rarely allowed after 72h and is discouraged; prefer deprecate + patch.
