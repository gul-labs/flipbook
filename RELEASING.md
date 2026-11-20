# Releasing

This monorepo uses [Changesets](https://github.com/changesets/changesets) for version management and publishing to npm. Publishing is done by GitHub Actions, not from a developer machine. The pipeline matches [`gul-labs/any-llm`](https://github.com/gul-labs/any-llm).

## Provenance

This repository is public, and every release is meant to carry an [npm provenance](https://docs.npmjs.com/generating-provenance-statements) attestation. Under pnpm 12 that attestation comes **only** from [npm trusted publishing](https://docs.npmjs.com/trusted-publishers), and trusted publishing is **required** for it.

**Required setup on npmjs.com, per package — not confirmed to exist yet.** For each of `@gullabs/flipbook-core` and `@gullabs/react-flipbook`: package → Settings → Trusted Publisher → GitHub Actions, organization `gul-labs`, repository `flipbook`, workflow file `release.yml`. Only the package owner can do this. Until it is done for a package, the Release job still publishes it — through the `NPM_TOKEN` fallback — but **without** provenance, and the job's `Verify npm provenance on published packages` step then fails it red. That step cannot withdraw the published version; the red job is the signal to configure the trusted publisher before the next release.

Why there is no `NPM_CONFIG_PROVENANCE` any more: pnpm 9/10 published by shelling out to the npm CLI, which honoured that variable. pnpm 11+ publishes natively and reads `provenance` only from the `--provenance` CLI flag — not from the environment and not from `.npmrc` — and `changeset publish` calls `pnpm publish` with a fixed argument list, so the flag cannot be passed. `gul-labs/any-llm` hit exactly this: its first pnpm 11 release (0.14.0) shipped without an attestation, and it moved to trusted publishing. With `id-token: write`, pnpm attempts the OIDC exchange on every publish and attaches provenance from it; any-llm 0.17.0 was published that way, with `NPM_TOKEN` still set as the fallback, and carries an attestation.

The verify step (`scripts/check-published-provenance.mjs`, self-tested by `pnpm test:provenance-gate` in `quality:ci`) reads `https://registry.npmjs.org/<name>/<version>` for every version changesets reports as published, retrying while a new version is not yet visible, and fails unless `dist.attestations.provenance` is an SLSA provenance record. It fails closed if the registry cannot be read. To check a release by hand: `npm view @gullabs/<pkg>@<version> dist.attestations`.

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
   - Versions already bumped and no pending changesets → `changesets/action` runs `pnpm release` and publishes unpublished versions (trusted publishing via OIDC where configured, `NPM_TOKEN` as the fallback), then the verify step checks each one for a provenance attestation.

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

## Required repository secret

| Secret      | Description                                                                                                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NPM_TOKEN` | npm automation token with publish access to the `@gullabs` scope. Same token used to publish the other `@gullabs/*` packages. Generate at https://www.npmjs.com/settings → Access Tokens → Generate New Token → Automation. |

`GITHUB_TOKEN` is provided by GitHub Actions. `release.yml` passes it to
`changesets/action@v2` as the **`github-token` input** (v2 no longer reads
`GITHUB_TOKEN` from the environment). Until both packages have a trusted
publisher, the publish scripts still need token auth (and the token stays as the
fallback afterwards, until it is deliberately removed):

The workflow sets both `NODE_AUTH_TOKEN` (which the `.npmrc` written by `setup-node` expands) and `NPM_TOKEN` (which changesets reads). Setting only one fails publish with `ENEEDAUTH`.

### Scope the token to `@gullabs`, not to selected packages

This is the trap specific to a **first** publish, and it costs a full CI round
trip to discover. If you use a **granular access token**, its package permission
must be **"All packages in selected scopes and organizations" → `@gullabs`**.
npm's "Only select packages" list can only contain packages that already exist,
and neither `@gullabs/flipbook-core` nor `@gullabs/react-flipbook` does yet — so
a token scoped that way carries no permission for the name it is being used to
create, and publish fails `E403` on a package the token looks like it covers.
(The `@gullabs` scope itself must already exist; `gul-labs/any-llm` created it.)

A classic **automation** token has no such list and is fine. A classic
**publish** token is not: changesets runs non-interactively, so a token that
still wants an OTP fails `ERR_PNPM_OTP_NON_INTERACTIVE`, which changesets
reports as `failed:needs-2fa`.

### What actually runs at publish time

`changeset publish` detects pnpm and, per package, runs `pnpm pack` and then
`pnpm publish <tarball> --access public --tag latest --no-git-checks`. Three
consequences worth knowing:

- The **detached HEAD** this job checks out (`ref: workflow_run.head_sha`) is
  fine — `--no-git-checks` is passed for us.
- What ships is a **`pnpm pack` tarball**, which is exactly what
  `pnpm test:packed` (`scripts/check-packed-artifacts.mjs`) inspects, so that
  gate is checking the real artifact and not an approximation.
- `workspace:*` in `@gullabs/react-flipbook`'s dependency on the core is
  rewritten to the concrete version by `pnpm pack`. Verified in the packed
  manifest: `"@gullabs/flipbook-core": "3.0.0"`.

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
