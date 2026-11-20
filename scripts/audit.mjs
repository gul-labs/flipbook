#!/usr/bin/env node
/**
 * Dependency audit gate that cannot be fooled by a degraded advisory service.
 *
 * WHY THIS DOES NOT JUST CALL `pnpm audit`
 * ----------------------------------------
 * `pnpm audit` is not trustworthy when npm's advisory service misbehaves, and it
 * misbehaves in both directions. Measured against the 2026-09-04 incident:
 *
 *   - `pnpm audit --json` exits 0 and prints
 *     `{"advisories":{},"metadata":{"vulnerabilities":{"high":0,...}}}`.
 *   - `pnpm audit --audit-level=high` exits 0 and prints
 *     "No known vulnerabilities found" when the service answers HTTP 503.
 *   - The same command exits 1 on a socket timeout, which is indistinguishable
 *     from a genuine high-severity finding.
 *
 * So it reports CLEAN when it has checked nothing, and reports what looks like a
 * finding when it has merely failed to connect. A gate built on its exit code is
 * either a false sense of security or a merge blocker, depending on which way
 * npm happens to be failing that hour.
 *
 * HOW THIS IS DIFFERENT
 * ---------------------
 * We query the advisory service ourselves and include a canary in THE SAME
 * REQUEST as the real query: a package version with a permanent, well-known
 * advisory. If the response does not flag the canary, that response is not
 * trustworthy — whether it arrived as 503, as an empty body, or as a 200 with a
 * degraded dataset — and its silence about everything else means nothing.
 *
 * A canary sent as a separate probe would not be enough. The service flaps, so
 * one request can succeed while the next is degraded. Riding along in the same
 * request is what makes a "clean" answer provable.
 *
 * The registry matches requested versions to advisories. Only the canary
 * package needs a local range check to distinguish the injected version from
 * real installed versions; all other package matches come from the registry.
 *
 * THREE OUTCOMES, NEVER CONFLATED
 * -------------------------------
 *   CLEAN         trustworthy response, nothing at or above threshold  -> exit 0
 *   VULNERABLE    trustworthy response, findings at or above threshold -> exit 1
 *   UNDETERMINED  no trustworthy response after retries                -> see below
 *
 * UNDETERMINED claims neither safety nor danger. By default it warns loudly and
 * exits 0: this repo's exposure to the same database is independently and
 * continuously covered by Dependabot, which does not use this endpoint, so
 * blocking every merge on a third-party outage buys no security. Set
 * `AUDIT_REQUIRE_VERDICT=1` to fail closed instead.
 *
 * Usage: node scripts/audit.mjs [--audit-level=high] [--lockfile=pnpm-lock.yaml] [--prod]
 *
 * --prod is supported only inside a pnpm WORKSPACE: it takes the production
 * tree from `pnpm ls` for the workspace containing the current directory and
 * requires --lockfile (default pnpm-lock.yaml) to be that workspace's own
 * lockfile, next to its pnpm-workspace.yaml. A standalone project without a
 * pnpm-workspace.yaml is refused, not guessed at.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const require_ = createRequire(import.meta.url);
const yaml = require_('yaml');
const semver = require_('semver');

const LEVELS = ['info', 'low', 'moderate', 'high', 'critical'];

// lodash 4.17.20 carries CVE-2021-23337 (command injection, high). Published
// advisories are not retracted, so any healthy response flags this version.
const CANARY = { name: 'lodash', version: '4.17.20' };

const ENDPOINT =
  process.env.AUDIT_CANARY_URL ?? 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';

const RETRIES = Number(process.env.AUDIT_RETRIES ?? 5);
const BASE_DELAY_MS = Number(process.env.AUDIT_BASE_DELAY_MS ?? 2000);
const TIMEOUT_MS = Number(process.env.AUDIT_TIMEOUT_MS ?? 20000);

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const level = arg('audit-level', 'high');
const lockfilePath = arg('lockfile', 'pnpm-lock.yaml');

if (!LEVELS.includes(level)) {
  fail(`unknown --audit-level=${level}; expected one of ${LEVELS.join(', ')}`);
}
const threshold = LEVELS.indexOf(level);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(message) {
  console.error(`audit gate: ${message}`);
  process.exit(1);
}

/** GitHub Actions annotation, plain text elsewhere. */
function warn(message) {
  console.error(process.env.GITHUB_ACTIONS ? `::warning::${message}` : `WARNING: ${message}`);
}

function undetermined(reason) {
  const message =
    `dependency audit UNDETERMINED — ${reason}. This is NOT a clean result: no ` +
    `vulnerability check was completed. Dependabot covers the same advisory ` +
    `database independently.`;
  if (process.env.AUDIT_REQUIRE_VERDICT === '1') {
    fail(`${message} AUDIT_REQUIRE_VERDICT=1 set.`);
  }
  warn(message);
  process.exit(0);
}

/**
 * The lockfile's documents, classified: exactly one `workspace` document and
 * at most one `env` document (null when absent, e.g. a pnpm 10 lockfile).
 *
 * pnpm 11+ with a pinned `packageManager` writes TWO documents: first an "env
 * lockfile" whose only importer entries are `packageManagerDependencies` /
 * `configDependencies` (it locks the pnpm binary itself), then the workspace
 * lockfile. Both carry `lockfileVersion`, `importers` and `packages`, so
 * neither position nor top-level keys tell them apart; the importer contents
 * do. `yaml.parse` refuses a multi-document file outright ("Source contains
 * multiple documents"), which is how this gate broke under pnpm 12.
 *
 * BOTH documents are audited. `pnpm audit` on 12.21.0 sends the env
 * document's packages (`pnpm` and every `@pnpm/exe.*` binary) to the bulk
 * advisory endpoint, with and without `--prod` (measured against a local
 * capture registry), so a gate that skipped them would check less than the
 * command it replaces. The package manager runs in CI with the publish
 * token, so it is in scope.
 *
 * Both kinds are recognised POSITIVELY, never by elimination:
 *   workspace  a `settings` mapping (pnpm always writes it there) and a
 *              non-empty `importers` mapping;
 *   env        no `settings`, and a non-empty `importers` mapping whose every
 *              importer holds only `packageManagerDependencies` /
 *              `configDependencies`.
 * A document that is neither, for instance an env-like document whose
 * `importers` is empty or missing, is refused rather than taken for the
 * workspace: that is how a lockfile holding only pnpm could otherwise audit
 * clean having checked nothing of the workspace.
 *
 * In every document, each `snapshots` key (peer suffix removed) must name a
 * `packages` entry. That holds for every real lockfile checked (this repo's
 * pnpm 12 and pnpm 10 lockfiles, gul-labs/any-llm's pnpm 12 lockfile), and the
 * collector reads `packages`, so a dependency present only in `snapshots`
 * would otherwise be skipped silently.
 *
 * Fails closed: a YAML error in any document, a document that is neither kind,
 * an inconsistent snapshot, no workspace document, more than one workspace
 * document, or more than one env document, all refuse to choose. Auditing the
 * wrong document would report CLEAN for packages that were never checked.
 */
function classifyLockfileDocuments(text, path) {
  const ENV_IMPORTER_KEYS = new Set(['packageManagerDependencies', 'configDependencies']);
  const isMapping = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const nonEmptyMapping = (v) => isMapping(v) && Object.keys(v).length > 0;
  const isWorkspaceDocument = (doc) => isMapping(doc.settings) && nonEmptyMapping(doc.importers);
  const isEnvDocument = (doc) =>
    !('settings' in doc) &&
    nonEmptyMapping(doc.importers) &&
    Object.values(doc.importers).every(
      (importer) =>
        nonEmptyMapping(importer) &&
        Object.keys(importer).every((key) => ENV_IMPORTER_KEYS.has(key)),
    );

  const workspaceDocuments = [];
  const envDocuments = [];
  for (const [index, document] of yaml.parseAllDocuments(text).entries()) {
    if (document.errors.length > 0) {
      fail(`lockfile ${path} document ${index + 1}: ${document.errors[0].message}`);
    }
    const doc = document.toJS();
    if (doc === null || doc === undefined) continue; // an empty `---` section
    if (!isMapping(doc) || !('lockfileVersion' in doc)) {
      fail(
        `lockfile ${path} document ${index + 1} is not a pnpm lockfile document; refusing to guess`,
      );
    }
    const kind = isWorkspaceDocument(doc) ? 'workspace' : isEnvDocument(doc) ? 'env' : null;
    if (kind === null) {
      fail(
        `lockfile ${path} document ${index + 1} is neither a workspace document (settings + ` +
          'importers) nor a package-manager document (importers holding only ' +
          'packageManagerDependencies/configDependencies); refusing to guess',
      );
    }
    if (doc.snapshots !== undefined && !isMapping(doc.snapshots)) {
      fail(`lockfile ${path} document ${index + 1}: \`snapshots\` is not a mapping`);
    }
    const packageKeys = new Set(Object.keys(isMapping(doc.packages) ? doc.packages : {}));
    const orphan = Object.keys(doc.snapshots ?? {}).find(
      (k) => !packageKeys.has(k) && !packageKeys.has(withoutResolutionSuffix(k)),
    );
    if (orphan !== undefined) {
      fail(
        `lockfile ${path} document ${index + 1}: snapshot ${JSON.stringify(orphan)} has no ` +
          '`packages` entry, so it would not be audited; refusing to report clean',
      );
    }
    (kind === 'env' ? envDocuments : workspaceDocuments).push(doc);
  }
  if (envDocuments.length > 1) {
    fail(
      `lockfile ${path} has ${envDocuments.length} package-manager (env) documents; ` +
        'refusing to pick one',
    );
  }
  if (workspaceDocuments.length === 0) {
    fail(`lockfile ${path} has no workspace lockfile document; refusing to report clean`);
  }
  if (workspaceDocuments.length > 1) {
    fail(
      `lockfile ${path} has ${workspaceDocuments.length} workspace lockfile documents; ` +
        'refusing to pick one',
    );
  }
  return { workspace: workspaceDocuments[0], env: envDocuments[0] ?? null };
}

/**
 * A lockfile key without its trailing peer / patch resolution suffix:
 * `react-dom@19.3.1(react@19.3.1)` -> `react-dom@19.3.1`,
 * `next@16.4.6(react-dom@19.3.1(react@19.3.1))(react@19.3.1)` -> `next@16.4.6`,
 * `foo@1.0.0(patch_hash=abc123)` -> `foo@1.0.0`.
 *
 * Only balanced `(...)` groups at the END of the key whose content is a peer
 * (`name@version…`) or a `patch_hash=` are removed. A `(` that is part of the
 * key itself is kept: `widget@file:widget(copy).tgz` stays whole (its last
 * character is not `)`), which splitting at the first `(` got wrong.
 */
function withoutResolutionSuffix(key) {
  const SUFFIX = /^(?:patch_hash=[\w-]+|(?:@[^\s()@/]+\/)?[^\s()@/]+@.+)$/;
  let rest = key;
  while (rest.endsWith(')')) {
    let depth = 0;
    let open = -1;
    for (let i = rest.length - 1; i >= 0; i--) {
      if (rest[i] === ')') depth++;
      else if (rest[i] === '(' && --depth === 0) {
        open = i;
        break;
      }
    }
    if (open <= 0 || !SUFFIX.test(rest.slice(open + 1, -1))) break;
    rest = rest.slice(0, open);
  }
  return rest;
}

function readLockfile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    fail(`could not read lockfile ${path}: ${error?.message ?? error}`);
  }
  return classifyLockfileDocuments(text, path);
}

/**
 * A lockfile document's `packages`, merged into `into` as name -> Set(versions).
 * pnpm lockfile v9 keys look like `name@version` or
 * `@scope/name@version(peer@1.2.3)`; the parenthetical is a peer-resolution
 * suffix and is not part of the version.
 */
function addLockfilePackages(doc, into) {
  for (const rawKey of Object.keys(doc?.packages ?? {})) {
    const key = withoutResolutionSuffix(rawKey);
    const at = key.lastIndexOf('@');
    if (at <= 0) continue;
    const name = key.slice(0, at);
    const version = key.slice(at + 1);
    if (!name || !version) continue;
    if (!into.has(name)) into.set(name, new Set());
    into.get(name).add(version);
  }
  return into;
}

/**
 * Every resolved package in both lockfile documents.
 *
 * TRUST BOUNDARY: this reads `packages` (and checks `snapshots` against it); it
 * does not re-validate that every importer's references resolve to an entry.
 * The lockfile it audits is the one `pnpm install --frozen-lockfile` has
 * already accepted in the same job, which performs that resolution; and the CI
 * gate itself (`pnpm audit:gate`) uses `--prod`, which takes the tree from
 * `pnpm ls` rather than from this reader.
 */
function readInstalledPackages(lockfile, path) {
  const packages = addLockfilePackages(lockfile.workspace, new Map());
  if (packages.size === 0) fail(`lockfile ${path} lists no packages; refusing to report clean`);
  return addLockfilePackages(lockfile.env, packages);
}

/**
 * One bulk query, with the canary folded in. Returns the advisory map only if
 * the canary came back flagged, otherwise null meaning "not trustworthy".
 */
async function queryWithCanary(payload) {
  const body = {
    ...payload,
    [CANARY.name]: [...new Set([...(payload[CANARY.name] ?? []), CANARY.version])],
  };

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    warn(`advisory service returned HTTP ${response.status}`);
    return null;
  }

  const data = await response.json();
  const canaryHits = data?.[CANARY.name];
  const canaryFlagged =
    Array.isArray(canaryHits) &&
    canaryHits.some(
      (a) =>
        LEVELS.includes(a?.severity) &&
        typeof a?.vulnerable_versions === 'string' &&
        semver.validRange(a.vulnerable_versions) !== null &&
        semver.satisfies(CANARY.version, a.vulnerable_versions),
    );

  if (!canaryFlagged) {
    warn(
      `advisory service did not flag the canary ${CANARY.name}@${CANARY.version}; ` +
        `treating this response as untrustworthy rather than clean`,
    );
    return null;
  }
  return data;
}

/**
 * Production-only closure, for repos whose policy is that a dev-only advisory
 * never reaches a consumer. Uses pnpm's own resolution rather than trying to
 * re-derive prod reachability from the lockfile by hand.
 */
async function readProductionPackages() {
  const { spawn } = await import('node:child_process');
  const json = await new Promise((resolve) => {
    const child = spawn('pnpm', ['ls', '-r', '--prod', '--depth', 'Infinity', '--json'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out : null));
  });
  if (!json) fail('could not enumerate production dependencies via `pnpm ls`');

  let importers;
  try {
    importers = JSON.parse(json);
  } catch (error) {
    fail(`could not parse \`pnpm ls\` output: ${error?.message ?? error}`);
  }

  const packages = new Map();
  const visit = (deps) => {
    for (const [name, info] of Object.entries(deps ?? {})) {
      const version = info?.version;
      if (typeof version === 'string' && version.length > 0) {
        if (!packages.has(name)) packages.set(name, new Set());
        packages.get(name).add(version);
      }
      if (info?.dependencies) visit(info.dependencies);
    }
  };
  for (const importer of Array.isArray(importers) ? importers : []) {
    visit(importer?.dependencies);
    visit(importer?.optionalDependencies);
  }
  if (packages.size === 0) {
    fail('`pnpm ls --prod` reported no production packages; refusing to report clean');
  }
  return packages;
}

/**
 * `--prod` combines two sources: the dependency tree `pnpm ls` reports for the
 * workspace containing the current directory, and the package-manager document
 * of `--lockfile`. Both must describe the same workspace, so a `--lockfile`
 * other than that workspace's own `pnpm-lock.yaml` is refused rather than
 * mixing one checkout's pnpm with another's tree.
 */
function assertOwnLockfile(path) {
  let dir = resolve(process.cwd());
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir);
    if (parent === dir) {
      fail(
        '--prod is supported only inside a pnpm workspace, and there is no pnpm-workspace.yaml ' +
          'at or above the current directory. A standalone project is not supported.',
      );
    }
    dir = parent;
  }
  const own = join(dir, 'pnpm-lock.yaml');
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  if (real(path) !== real(own)) {
    fail(
      `--prod is supported only for a workspace's own lockfile: it reads the dependency tree of ` +
        `the workspace at ${dir}, so --lockfile must be its ` +
        `own ${own}, not ${resolve(path)}`,
    );
  }
}

// The package manager is audited in both modes, as `pnpm audit` does: `pnpm
// ls --prod` never lists it, so its lockfile document is added explicitly.
if (args.includes('--prod')) assertOwnLockfile(lockfilePath);
const lockfile = readLockfile(lockfilePath);
const installed = args.includes('--prod')
  ? addLockfilePackages(lockfile.env, await readProductionPackages())
  : readInstalledPackages(lockfile, lockfilePath);
const payload = Object.fromEntries([...installed].map(([name, versions]) => [name, [...versions]]));

let advisories = null;
for (let attempt = 1; attempt <= RETRIES; attempt++) {
  try {
    advisories = await queryWithCanary(payload);
    if (advisories) break;
  } catch (error) {
    warn(`advisory query failed: ${error?.message ?? error}`);
  }
  if (attempt < RETRIES) {
    const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
    console.error(`audit gate: retrying in ${delay}ms (${attempt}/${RETRIES})`);
    await sleep(delay);
  }
}

if (!advisories) {
  undetermined(`npm's advisory service returned no trustworthy response after ${RETRIES} attempts`);
}

// Only the injected VERSION is synthetic. Another installed lodash version
// can match the same advisory, so deleting the entire package hides real bugs.
const realCanaryVersions = [...(installed.get(CANARY.name) ?? [])];
advisories[CANARY.name] = advisories[CANARY.name].filter((advisory) => {
  if (realCanaryVersions.length === 0) return false;
  const range = advisory.vulnerable_versions;
  if (typeof range !== 'string' || semver.validRange(range) === null) {
    undetermined('the canary package advisory has no valid vulnerable version range');
  }
  return realCanaryVersions.some((version) => {
    if (semver.valid(version) === null) {
      undetermined(`cannot match installed ${CANARY.name}@${version} to its advisory`);
    }
    return semver.satisfies(version, range, { includePrerelease: true });
  });
});

const findings = [];
for (const [name, list] of Object.entries(advisories)) {
  for (const advisory of list ?? []) {
    const severity = String(advisory?.severity ?? '').toLowerCase();
    const rank = LEVELS.indexOf(severity);
    if (rank >= threshold) {
      findings.push({
        name,
        severity,
        title: advisory?.title ?? '(untitled)',
        url: advisory?.url,
      });
    }
  }
}

if (findings.length > 0) {
  console.error(`audit gate: VULNERABLE — ${findings.length} finding(s) at or above "${level}":`);
  for (const f of findings) {
    console.error(
      `  ${f.severity.padEnd(8)} ${f.name}  ${f.title}${f.url ? `\n           ${f.url}` : ''}`,
    );
  }
  process.exit(1);
}

console.log(
  `audit gate: CLEAN — ${installed.size} packages checked against a canary-verified ` +
    `response, nothing at or above "${level}".`,
);
