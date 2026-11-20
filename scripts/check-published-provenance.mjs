#!/usr/bin/env node
/**
 * Fail the Release job when a package it just published carries no npm
 * provenance attestation.
 *
 * WHY THIS EXISTS
 * ---------------
 * Under pnpm 9/10, `changeset publish` reached `npm publish`, and npm honoured
 * `NPM_CONFIG_PROVENANCE=true`. pnpm 11 replaced that with a native publish
 * that reads `provenance` only from the `--provenance` CLI flag, and
 * `changeset publish` calls `pnpm publish` with a fixed argument list, so the
 * flag cannot be passed. Provenance now comes only from npm trusted publishing
 * (the OIDC exchange pnpm attempts on every publish), which has to be
 * configured per package on npmjs.com. When it is not, the publish still
 * SUCCEEDS — through the `NPM_TOKEN` fallback — and simply ships without an
 * attestation. Nothing in the job turns red. `gul-labs/any-llm` 0.14.0 went out
 * exactly that way.
 *
 * So after `changesets/action` reports `published == 'true'`, this reads the
 * registry's own record of each published version and requires
 * `dist.attestations.provenance` to be there. It cannot un-publish anything
 * (npm versions are immutable); its job is to make the gap loud on the run
 * that created it rather than on the day someone checks.
 *
 * FOUR OUTCOMES, NEVER CONFLATED
 * ------------------------------
 *   VERIFIED     every version doc read, every one attested         -> exit 0
 *   MISSING      a version doc was read and has no provenance       -> exit 1
 *   UNVERIFIED   a version doc could not be read after retries      -> exit 1
 *   BAD INPUT    the publishedPackages list is absent or malformed  -> exit 1
 *
 * UNVERIFIED fails closed, unlike the audit gate's UNDETERMINED: this runs once,
 * after a publish that has already happened, so there is no merge to unblock
 * and no later run that will look again. A 404 is retried, because a version
 * can take a short while to become visible after `PUT` returns.
 *
 * Usage:
 *   PUBLISHED_PACKAGES='[{"name":"@scope/pkg","version":"1.2.3"}]' \
 *     node scripts/check-published-provenance.mjs
 *   node scripts/check-published-provenance.mjs '<same JSON>'
 *
 * The JSON is the `published-packages` output of changesets/action@v2 (v1
 * called it `publishedPackages`; "publishedPackages" below means that list). Pass it
 * through the environment in a workflow, never by interpolating `${{ }}` into
 * the command line.
 */

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function badInput(message) {
  console.error(`provenance check: BAD INPUT — ${message}`);
  process.exit(1);
}

function readPublished() {
  const raw = process.argv[2] ?? process.env.PUBLISHED_PACKAGES;
  if (raw === undefined || raw.trim() === '') {
    badInput(
      'no publishedPackages given (argv[2] or PUBLISHED_PACKAGES). The publish step reported ' +
        'that it published, so an empty list means the check cannot run, not that it passed.',
    );
  }
  let list;
  try {
    list = JSON.parse(raw);
  } catch (error) {
    badInput(`publishedPackages is not JSON: ${error?.message ?? error}`);
  }
  if (!Array.isArray(list) || list.length === 0) {
    badInput(`publishedPackages must be a non-empty array (got ${JSON.stringify(list)})`);
  }
  for (const entry of list) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof entry.name !== 'string' ||
      typeof entry.version !== 'string' ||
      !NAME.test(entry.name) ||
      !VERSION.test(entry.version)
    ) {
      badInput(`not a {name, version} package entry: ${JSON.stringify(entry)}`);
    }
  }
  return list;
}

/** `@scope/name` -> `@scope%2Fname`, the form the registry documents. */
const encodeName = (name) =>
  name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);

/**
 * The registry's version document, or a reason it could not be read.
 * Returns { doc } or { error, retryable }.
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
  if (response.status === 404) {
    return { error: 'HTTP 404 (not visible yet, or never published)', retryable: true };
  }
  if (response.status === 429 || response.status >= 500) {
    return { error: `HTTP ${response.status}`, retryable: true };
  }
  if (!response.ok) {
    return { error: `HTTP ${response.status}`, retryable: false };
  }
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
    return `registry returned ${JSON.stringify(doc.name)}@${JSON.stringify(doc.version)}, not the version that was published`;
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

const published = readPublished();
const missing = [];
const unverified = [];

for (const { name, version } of published) {
  let result;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    result = await fetchVersionDoc(name, version);
    if (result.doc || !result.retryable) break;
    if (attempt < RETRIES) {
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
      console.error(
        `provenance check: ${name}@${version}: ${result.error}; retrying in ${delay}ms (${attempt}/${RETRIES})`,
      );
      await sleep(delay);
    }
  }

  if (!result.doc) {
    unverified.push(`${name}@${version}: ${result.error}`);
    continue;
  }
  const problem = provenanceProblem(result.doc, name, version);
  if (problem) {
    missing.push(`${name}@${version}: ${problem}`);
  } else {
    console.log(
      `provenance check: ${name}@${version} attested (${result.doc.dist.attestations.provenance.predicateType})`,
    );
  }
}

if (missing.length > 0) {
  console.error(
    `provenance check: MISSING — ${missing.length} published version(s) carry no provenance attestation:`,
  );
  for (const m of missing) console.error(`  ${m}`);
  console.error(
    'From the Release job this means the publish went out through the NPM_TOKEN fallback.\n' +
      'Configure npm trusted publishing for each package (see RELEASING.md); the published\n' +
      'version itself cannot be changed.',
  );
}
if (unverified.length > 0) {
  console.error(
    `provenance check: UNVERIFIED — could not read ${unverified.length} version document(s) after ${RETRIES} attempts:`,
  );
  for (const u of unverified) console.error(`  ${u}`);
  console.error('This is NOT a pass: provenance was not checked for these versions.');
}
if (missing.length > 0 || unverified.length > 0) process.exit(1);

console.log(
  `provenance check: VERIFIED — ${published.length} published version(s), every one attested.`,
);
