#!/usr/bin/env bash
# Regenerate the Linux golden baselines that CI compares against.
#
# Screenshot baselines are per-platform: Playwright looks for
# `<name>-<project>-<platform>.png`, so baselines written on macOS are invisible
# to an ubuntu-latest runner, and the test fails with "A snapshot doesn't
# exist". This generates them in the official Playwright image for the pinned
# version (Ubuntu noble, browsers baked in), a reproducible stand-in for the CI
# runner. It is NOT the image CI uses: CI runs directly on `ubuntu-latest`
# after `playwright install --with-deps`, so fonts and system libraries can
# differ, and a baseline generated here can still fail on the runner. Check
# the first CI run after regenerating.
#
# Usage: pnpm test:e2e:golden:update:linux
set -euo pipefail

PW_VERSION="$(node -p "require('@playwright/test/package.json').version")"
IMAGE="mcr.microsoft.com/playwright:v${PW_VERSION}-noble"
# The pnpm the repo pins (`packageManager`, e.g. "pnpm@12.21.0"), without any
# "+sha…" integrity suffix. Installed inside the image below.
PNPM_VERSION="$(node -p "require(process.argv[1]).packageManager.replace(/^pnpm@/, '').split('+')[0]" \
  "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/package.json")"
case "$PNPM_VERSION" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "Could not read a pnpm version from package.json packageManager (got '${PNPM_VERSION}')." >&2; exit 1 ;;
esac
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Start Docker Desktop and retry." >&2
  exit 1
fi

echo "Staging a clean copy of the worktree (no node_modules / dist)…"
tar --exclude=node_modules \
    --exclude=.git \
    --exclude='**/dist' \
    --exclude='**/.next' \
    --exclude='**/size-check' \
    --exclude=test-results \
    --exclude=playwright-report \
    --exclude=coverage \
    -cf - -C "$REPO_ROOT" . | (cd "$STAGE" && tar xf -)

echo "Running golden suite in ${IMAGE}…"
# The Playwright webServer command shells out to `pnpm`, which is not in the
# image. Corepack used to provide it, but Node stopped bundling corepack in
# v25, and the v1.65 images ship Node 26. Install the pinned pnpm with the
# image's own npm instead, so `pnpm` is on PATH for the webServer too.
docker run --rm -v "$STAGE":/work -w /work -e CI=1 -e PNPM_VERSION="$PNPM_VERSION" "$IMAGE" bash -lc '
  set -euo pipefail
  npm install --global --no-fund --no-audit "pnpm@${PNPM_VERSION}" >/dev/null
  test "$(pnpm --version)" = "${PNPM_VERSION}"
  pnpm install --frozen-lockfile
  pnpm exec playwright test e2e/golden-flip.spec.ts --update-snapshots
'

echo "Copying *-linux.png baselines back…"
cp "$STAGE"/e2e/golden-flip.spec.ts-snapshots/*-linux.png \
   "$REPO_ROOT"/e2e/golden-flip.spec.ts-snapshots/

echo "Done. Review the diff before committing — a changed baseline is either a"
echo "real rendering regression or an intended visual change."
