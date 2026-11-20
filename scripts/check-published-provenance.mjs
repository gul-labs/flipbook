#!/usr/bin/env node
/**
 * Fail the Release job while any published version of a workspace package
 * carries no npm provenance attestation.
 *
 * WHY THIS EXISTS
 * ---------------
 * Under pnpm 9/10, `changeset publish` reached `npm publish`, and npm honoured
 * `NPM_CONFIG_PROVENANCE=true`. pnpm 11+ publishes natively, and provenance now
 * comes only from npm trusted publishing (the OIDC exchange pnpm attempts on
 * every publish). A publish can still go out WITHOUT an attestation and exit 0:
 * measured with pnpm 12.21.0 against a local fake registry, when the exchange
 * works but pnpm's visibility lookup (`GET /-/package/<name>/visibility`)
 * fails, pnpm prints "[WARN] Skipped setting provenance: …" and uploads the
 * tarball unattested. A static token, if one were configured, is another such
 * path. Nothing else in the job turns red.
 *
 * WHAT IT CHECKS
 * --------------
 *   1. Every version changesets/action reports as published in THIS run
 *      (`PUBLISHED_PACKAGES`). It must exist on the registry and be attested;
 *      a 404 is retried, because a new version takes a while to be visible.
 *   2. Every public workspace package (`packages/<dir>/package.json`) at its
 *      manifest version. If the registry has that version it must be attested;
 *      a 404 for a version this run did not report means "not published yet".
 *
 * (2) closes the rerun hole: if a first run publishes core unattested and fails
 * on react, a rerun reports only react, and a check of (1) alone would go
 * green with core still unattested. With (2) an unattested version keeps the
 * job red on every run until a new version supersedes it.
 *
 * A version document without provenance is re-read within the same bounded
 * retry window before it is reported MISSING, in case a registry replica
 * serves the version before its attestation metadata. The report states the
 * registry evidence only; it does not guess how the version was published.
 *
 * FOUR OUTCOMES, NEVER CONFLATED
 * ------------------------------
 *   VERIFIED     every version checked is attested or not published -> exit 0
 *   MISSING      a version exists and has no provenance                -> exit 1
 *   UNVERIFIED   a version document could not be read after retries   -> exit 1
 *   BAD INPUT    the inputs are absent or malformed                    -> exit 1
 *
 * UNVERIFIED fails closed, unlike the audit gate's UNDETERMINED: this runs after
 * a publish that has already happened, so there is no merge to unblock.
 *
 * Inputs (environment; argv[2] may carry PUBLISHED_PACKAGES instead):
 *   CHANGESETS_PUBLISHED   'true' or 'false': changesets/action's `published`.
 *   PUBLISHED_PACKAGES     its `published-packages` JSON array of {name,version};
 *                          must be non-empty when CHANGESETS_PUBLISHED is 'true'.
 *   PROVENANCE_WORKSPACE   repository root to read packages/* from (default: cwd).
 * Pass them through the environment in a workflow, never by interpolating
 * `${{ }}` into the command line.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

function badInput(message) {
  console.error(`provenance check: BAD INPUT — ${message}`);
  process.exit(1);
}

const REGISTRY = (process.env.PROVENANCE_REGISTRY_URL ?? 'https://registry.npmjs.org').replace(
  /\/+$/,
  '',
);
if (!URL.canParse(REGISTRY) || !/^https?:$/.test(new URL(REGISTRY).protocol)) {
  badInput(`PROVENANCE_REGISTRY_URL=${JSON.stringify(REGISTRY)} is not an http(s) URL`);
}

/**
 * A tuning variable, or its default. Validated rather than passed through
 * `Number()`: `PROVENANCE_RETRIES=0` or `=abc` used to run the fetch loop zero
 * times and die on a TypeError, exiting non-zero by accident instead of with a
 * named outcome.
 */
function tuning(name, fallback, { integer }) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  const shapeOk = integer ? /^[1-9]\d*$/.test(raw.trim()) : /^\d+(?:\.\d+)?$/.test(raw.trim());
  if (!shapeOk || !Number.isFinite(value) || value <= 0) {
    badInput(`${name}=${JSON.stringify(raw)} must be a positive ${integer ? 'integer' : 'number'}`);
  }
  return value;
}

const RETRIES = tuning('PROVENANCE_RETRIES', 6, { integer: true });
const BASE_DELAY_MS = tuning('PROVENANCE_BASE_DELAY_MS', 5000, { integer: false });
const TIMEOUT_MS = tuning('PROVENANCE_TIMEOUT_MS', 20000, { integer: false });

// npm's own name rule (lowercase, URL-safe, optional @scope/), and a version
// that is at least shaped like semver. Anything else is refused rather than
// spliced into a URL.
const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;
const validEntry = (entry) =>
  entry !== null &&
  typeof entry === 'object' &&
  typeof entry.name === 'string' &&
  typeof entry.version === 'string' &&
  NAME.test(entry.name) &&
  VERSION.test(entry.version);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readPublished() {
  const flag = process.env.CHANGESETS_PUBLISHED;
  if (flag !== 'true' && flag !== 'false') {
    badInput(
      `CHANGESETS_PUBLISHED=${JSON.stringify(flag)} must be 'true' or 'false' ` +
        "(changesets/action's `published` output)",
    );
  }
  const raw = process.argv[2] ?? process.env.PUBLISHED_PACKAGES ?? '';
  let list = [];
  if (raw.trim() !== '') {
    try {
      list = JSON.parse(raw);
    } catch (error) {
      badInput(`publishedPackages is not JSON: ${error?.message ?? error}`);
    }
  }
  if (!Array.isArray(list)) {
    badInput(`publishedPackages must be an array (got ${JSON.stringify(list)})`);
  }
  if (flag === 'true' && list.length === 0) {
    badInput(
      'CHANGESETS_PUBLISHED is true but no published packages were given. The publish step ' +
        'reported that it published, so an empty list means the check cannot run, not that it passed.',
    );
  }
  for (const entry of list) {
    if (!validEntry(entry))
      badInput(`not a {name, version} package entry: ${JSON.stringify(entry)}`);
  }
  return list;
}

function readWorkspacePackages() {
  const root = resolve(process.env.PROVENANCE_WORKSPACE ?? process.cwd());
  const dir = join(root, 'packages');
  if (!existsSync(dir)) badInput(`no packages/ directory under ${root}`);
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(dir, entry.name, 'package.json');
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      badInput(`${manifestPath} is not JSON: ${error?.message ?? error}`);
    }
    if (manifest.private === true) continue;
    const pkg = { name: manifest.name, version: manifest.version };
    if (!validEntry(pkg))
      badInput(`${manifestPath} has no valid name/version (${JSON.stringify(pkg)})`);
    found.push(pkg);
  }
  if (found.length === 0) badInput(`no public workspace packages found under ${dir}`);
  return found;
}

/** `@scope/name` -> `@scope%2Fname`, the form the registry documents. */
const encodeName = (name) =>
  name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);

/**
 * One read of the registry's version document.
 * Returns { doc } | { notFound: true } | { error, retryable }.
 */
async function fetchVersionDoc(name, version) {
  const url = `${REGISTRY}/${encodeName(name)}/${encodeURIComponent(version)}`;
  let response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { error: `request failed: ${error?.message ?? error}`, retryable: true };
  }
  if (response.status === 404) return { notFound: true };
  if (response.status === 429 || response.status >= 500) {
    return { error: `HTTP ${response.status}`, retryable: true };
  }
  if (!response.ok) return { error: `HTTP ${response.status}`, retryable: false };
  try {
    return { doc: await response.json() };
  } catch (error) {
    return { error: `response is not JSON: ${error?.message ?? error}`, retryable: true };
  }
}

/** Why `doc` does not prove provenance for name@version, or null if it does. */
function provenanceProblem(doc, name, version) {
  if (doc === null || typeof doc !== 'object') return 'version document is not an object';
  if (doc.name !== name || doc.version !== version) {
    return `registry returned ${JSON.stringify(doc.name)}@${JSON.stringify(doc.version)}, not the requested version`;
  }
  const provenance = doc.dist?.attestations?.provenance;
  if (provenance === undefined || provenance === null) {
    return 'dist.attestations.provenance is absent';
  }
  // npm records the SLSA predicate it verified. An object without one is not
  // evidence of anything.
  if (
    typeof provenance !== 'object' ||
    typeof provenance.predicateType !== 'string' ||
    !provenance.predicateType.startsWith('https://slsa.dev/provenance/')
  ) {
    return `dist.attestations.provenance is not an SLSA provenance record (got ${JSON.stringify(provenance)})`;
  }
  return null;
}

/**
 * Check one version. `mustExist` is true for versions this run reported as
 * published: for those a 404 is registry lag, not an answer.
 * Returns { state: 'attested' | 'unpublished' | 'missing' | 'unverified', detail }.
 */
async function check({ name, version, mustExist }) {
  let last;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    const result = await fetchVersionDoc(name, version);
    if (result.notFound && !mustExist) {
      return { state: 'unpublished', detail: 'HTTP 404: not published yet' };
    }
    if (result.doc) {
      const problem = provenanceProblem(result.doc, name, version);
      if (!problem) {
        return { state: 'attested', detail: result.doc.dist.attestations.provenance.predicateType };
      }
      last = { state: 'missing', detail: problem };
    } else if (result.notFound) {
      last = { state: 'unverified', detail: 'HTTP 404 (reported as published, not visible)' };
    } else {
      last = { state: 'unverified', detail: result.error };
      if (!result.retryable) return last;
    }
    if (attempt < RETRIES) {
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
      console.error(
        `provenance check: ${name}@${version}: ${last.detail}; re-reading in ${delay}ms (${attempt}/${RETRIES})`,
      );
      await sleep(delay);
    }
  }
  return last;
}

const published = readPublished();
const workspace = readWorkspacePackages();

// One target per name@version; reported versions are the strict kind.
const targets = new Map();
for (const p of workspace) targets.set(`${p.name}@${p.version}`, { ...p, mustExist: false });
for (const p of published) targets.set(`${p.name}@${p.version}`, { ...p, mustExist: true });

const outcome = { attested: [], unpublished: [], missing: [], unverified: [] };
for (const target of targets.values()) {
  const { state, detail } = await check(target);
  const line = `${target.name}@${target.version}: ${detail}`;
  outcome[state].push(line);
  if (state === 'attested')
    console.log(`provenance check: ${target.name}@${target.version} attested (${detail})`);
  if (state === 'unpublished') console.log(`provenance check: ${line}`);
}

if (outcome.missing.length > 0) {
  console.error(
    `provenance check: MISSING — ${outcome.missing.length} version(s) on the registry carry no provenance attestation:`,
  );
  for (const m of outcome.missing) console.error(`  ${m}`);
  console.error(
    'npm versions are immutable; this stays red until a new, attested version supersedes it.\n' +
      'See RELEASING.md for the trusted-publisher setup.',
  );
}
if (outcome.unverified.length > 0) {
  console.error(
    `provenance check: UNVERIFIED — could not establish ${outcome.unverified.length} version(s) after ${RETRIES} attempts:`,
  );
  for (const u of outcome.unverified) console.error(`  ${u}`);
  console.error('This is NOT a pass: provenance was not checked for these versions.');
}
if (outcome.missing.length > 0 || outcome.unverified.length > 0) process.exit(1);

console.log(
  `provenance check: VERIFIED — ${targets.size} version(s) checked: ` +
    `${outcome.attested.length} attested, ${outcome.unpublished.length} not published yet.`,
);
