#!/usr/bin/env node
/**
 * Self-test for scripts/audit.mjs.
 *
 * The gate exists because npm's advisory service fails in ways that look like
 * success, so the gate itself has to be proven against every failure shape
 * rather than against whatever npm happens to be doing today. That matters most
 * for the CLEAN path: while the service is degraded it cannot produce a healthy
 * response at all, so without these fakes the "service is up and the tree is
 * clean" branch would ship unverified.
 *
 * The advisory service is faked with a local HTTP server, so every branch is
 * deterministic and offline.
 *
 * Usage: node scripts/audit.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'audit.mjs');
const semver = createRequire(import.meta.url)('semver');

const CANARY_ADVISORY = {
  id: 1523,
  severity: 'high',
  title: 'Command Injection in lodash',
  vulnerable_versions: '<4.17.21',
  url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm',
};

/**
 * A single-document (pnpm 10 shaped) workspace lockfile with the given
 * `name@version` keys in `packages` and `snapshots`, as pnpm writes them.
 */
function makeLockfile(keys) {
  const dir = mkdtempSync(join(tmpdir(), 'audit-lock-'));
  const file = join(dir, 'pnpm-lock.yaml');
  const entries = keys.map((k) => `  '${k}':\n    resolution: {integrity: sha512-x}\n`).join('\n');
  const snapshots = keys.map((k) => `  '${k}': {}\n`).join('');
  const body =
    `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: false\n  excludeLinksFromLockfile: false\n\n` +
    `importers:\n\n  .: {}\n\npackages:\n\n${entries}\nsnapshots:\n\n${snapshots}`;
  writeFileSync(file, body);
  return file;
}

/**
 * Advisories the fake returns for `name` given the versions the request asked
 * about: only those whose `vulnerable_versions` one of the requested versions
 * satisfies, as the real bulk endpoint matches. An advisory whose range is not
 * a valid semver range is passed through untouched, so the gate's own handling
 * of malformed advisories stays testable.
 */
function matching(advisories, versions) {
  return (advisories ?? []).filter(
    (a) =>
      typeof a.vulnerable_versions !== 'string' ||
      semver.validRange(a.vulnerable_versions) === null ||
      versions.some((v) => semver.satisfies(v, a.vulnerable_versions)),
  );
}

/**
 * Advisory service fake.
 *   healthy   flags the canary, plus whichever `findings` the request asked about
 *   degraded  200 OK but an empty dataset (the dangerous shape)
 *   error     503
 *   hang      never responds
 */
function startService(mode, findings = {}) {
  const requests = [];
  const lifetimes = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (mode === 'hang') {
      const arrived = Date.now();
      res.on('close', () => lifetimes.push(Date.now() - arrived));
    }
    if (mode === 'error') {
      res.writeHead(503);
      res.end(JSON.stringify({ error: 'Service Unavailable' }));
      return;
    }
    if (mode === 'degraded') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({}));
      return;
    }
    if (mode === 'healthy') {
      // Like the real bulk endpoint, answer only for packages that were asked
      // about, so a test can tell WHICH packages the gate sent.
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let asked = {};
        try {
          asked = JSON.parse(body);
        } catch {
          /* an unparseable request gets no findings */
        }
        // Per name AND version, the canary included: a gate that sends the
        // wrong version of anything gets no advisory back for it.
        // A `lodash` entry in `findings` REPLACES the canary advisory, which is
        // how the malformed-canary cases below are built.
        const all = { lodash: [CANARY_ADVISORY], ...findings };
        const answered = {};
        for (const [name, advisories] of Object.entries(all)) {
          const versions = Array.isArray(asked[name]) ? asked[name] : [];
          const hit = matching(advisories, versions);
          if (hit.length > 0) answered[name] = hit;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answered));
      });
      return;
    }
    // mode === 'hang' — reproduces the 2026-09-04 socket timeouts.
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, requests, lifetimes, url: `http://127.0.0.1:${server.address().port}/` }),
    );
  });
}

/**
 * Per-request budget for every case that is NOT about the timeout.
 *
 * Every case spawns a fresh gate process, and its first fetch() pays undici's
 * lazy initialisation and a new connection INSIDE the gate's per-request
 * timeout (the AbortSignal is created before fetch() is called). Measured with
 * Node 26.13.1 on a 12-core Mac (2026-11-20, first fetch in a new process to a
 * local server): idle p50 38 ms / max 74 ms; under vitest + build p90 139 ms /
 * max 182 ms; with the CPU 2x oversubscribed (roughly a 4-vCPU runner that is
 * also building) p50 222 ms / p90 357 ms / max 385 ms, 6 of 40 over 300 ms. The
 * 300 ms that used to apply to every case therefore flaked `quality:ci`. A
 * healthy local fake answers in milliseconds, so a generous budget costs
 * nothing when the gate works and only bounds how long a broken one can stall.
 */
const REQUEST_BUDGET_MS = '10000';

/**
 * The budget for the hang cases, which ARE about the timeout: the fake never
 * answers, so each attempt has to end by the gate aborting it. 1000 ms clears
 * the worst cold-start measured above, so the abort is the timeout firing on a
 * request that was actually sent, not on undici still starting up. Bounded
 * from outside by HANG_DEADLINE_MS: a gate that stopped honouring
 * AUDIT_TIMEOUT_MS would otherwise hang this self-test instead of failing it.
 */
const HANG_TIMEOUT_MS = '1000';
const HANG_DEADLINE_MS = 15000;
// Process start-up plus the fetch() cold start measured above, with room to spare.
const STARTUP_ALLOWANCE_MS = 3000;
/**
 * Per-request lifetime, measured at the fake: from the moment a hung request
 * arrives to the moment the client gives up and the connection closes. The
 * client's timer starts before the request is sent (the AbortSignal exists
 * before fetch()), so a lifetime is the timeout minus the time to get the
 * request out, which includes fetch()'s cold start (measured max 385 ms under
 * load). The two settings below give DISJOINT windows, so any single
 * hard-coded timeout falls outside at least one of them.
 */
const HANG_SETTINGS_MS = [1500, 3000];
const LIFETIME_WINDOW = (timeoutMs) => [timeoutMs - 700, timeoutMs + 300];

function runGate({ url, lockfile, extraArgs = [], env = {}, deadlineMs = 60000, cwd }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(
      process.execPath,
      [GATE, '--audit-level=high', `--lockfile=${lockfile}`, ...extraArgs],
      {
        env: {
          ...process.env,
          AUDIT_CANARY_URL: url,
          AUDIT_RETRIES: '2',
          AUDIT_BASE_DELAY_MS: '1',
          AUDIT_TIMEOUT_MS: REQUEST_BUDGET_MS,
          GITHUB_ACTIONS: '',
          AUDIT_REQUIRE_VERDICT: '',
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(cwd ? { cwd } : {}),
      },
    );
    let out = '';
    let killed = false;
    const watchdog = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, deadlineMs);
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (code) => {
      clearTimeout(watchdog);
      const elapsedMs = Date.now() - started;
      resolve({
        code: killed ? 'killed' : code,
        out: killed ? `${out}\n[killed after ${deadlineMs} ms]` : out,
        elapsedMs,
      });
    });
  });
}

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

async function withService(mode, findings, fn) {
  const { server, url, requests, lifetimes } = await startService(mode, findings);
  try {
    return await fn(url, requests, lifetimes);
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
}

const cleanLock = makeLockfile(['@babel/parser@7.29.7', 'react@19.0.0']);
const vulnerableLock = makeLockfile(['@babel/parser@7.29.7', 'minimist@1.2.5']);
// A workspace that genuinely depends on the canary version must still be flagged.
const canaryLock = makeLockfile(['lodash@4.17.20']);

console.log('audit gate self-test');

// The branches an outage makes untestable against the real service.
await withService('healthy', {}, async (url) => {
  const clean = await runGate({ url, lockfile: cleanLock });
  check(
    'service healthy + no findings -> CLEAN, exit 0',
    clean.code === 0 && /CLEAN/.test(clean.out),
    `exit=${clean.code} out=${clean.out.trim()}`,
  );
});

await withService(
  'healthy',
  {
    minimist: [
      {
        id: 2,
        severity: 'critical',
        title: 'Prototype Pollution',
        vulnerable_versions: '>=1.2.0 <1.2.6',
      },
    ],
  },
  async (url) => {
    const vuln = await runGate({ url, lockfile: vulnerableLock });
    check(
      'service healthy + real finding -> VULNERABLE, exit 1',
      vuln.code === 1 && /VULNERABLE/.test(vuln.out) && /minimist/.test(vuln.out),
      `exit=${vuln.code} out=${vuln.out.trim()}`,
    );
  },
);

// Below-threshold findings must not fail a --audit-level=high gate.
await withService(
  'healthy',
  {
    minimist: [
      { id: 3, severity: 'low', title: 'Minor issue', vulnerable_versions: '>=1.2.0 <1.2.6' },
    ],
  },
  async (url) => {
    const low = await runGate({ url, lockfile: vulnerableLock });
    check(
      'service healthy + below-threshold finding -> CLEAN, exit 0',
      low.code === 0 && /CLEAN/.test(low.out),
      `exit=${low.code} out=${low.out.trim()}`,
    );
  },
);

// The canary is scaffolding, unless the workspace really uses that version.
await withService('healthy', {}, async (url) => {
  const real = await runGate({ url, lockfile: canaryLock });
  check(
    'canary version genuinely installed -> reported as a real finding',
    real.code === 1 && /VULNERABLE/.test(real.out) && /lodash/.test(real.out),
    `exit=${real.code} out=${real.out.trim()}`,
  );
});

// The injected canary must not hide other installed versions of lodash.
for (const version of ['4.17.19', '4.17.21']) {
  await withService('healthy', {}, async (url) => {
    const result = await runGate({ url, lockfile: makeLockfile([`lodash@${version}`]) });
    const vulnerable = version === '4.17.19';
    check(
      `lodash ${version}: filter by advisory range, not exact canary equality`,
      result.code === (vulnerable ? 1 : 0) &&
        (vulnerable ? /VULNERABLE/.test(result.out) : /CLEAN/.test(result.out)),
      `exit=${result.code} out=${result.out.trim()}`,
    );
  });
}

// A non-empty severity string alone is not evidence the canary was checked.
for (const broken of [
  { ...CANARY_ADVISORY, severity: 'unknown' },
  { ...CANARY_ADVISORY, vulnerable_versions: '>=99.0.0' },
  { ...CANARY_ADVISORY, vulnerable_versions: undefined },
]) {
  await withService('healthy', { lodash: [broken] }, async (url) => {
    const result = await runGate({ url, lockfile: cleanLock });
    check(
      'malformed or nonmatching canary is UNDETERMINED',
      /UNDETERMINED/.test(result.out) && !/CLEAN/.test(result.out),
      result.out.trim(),
    );
  });
}

// The regression that motivated the gate: never launder "could not check" into
// "clean", in any of the shapes npm actually produced.
for (const mode of ['hang', 'error', 'degraded']) {
  // Only the hang case exercises the per-request timeout.
  const timing =
    mode === 'hang'
      ? { env: { AUDIT_TIMEOUT_MS: HANG_TIMEOUT_MS }, deadlineMs: HANG_DEADLINE_MS }
      : { env: {} };
  await withService(mode, {}, async (url, requests) => {
    const result = await runGate({ url, lockfile: cleanLock, ...timing });
    check(
      `service ${mode} -> UNDETERMINED after exactly 2 attempts, never reported as CLEAN`,
      result.code === 0 &&
        /UNDETERMINED/.test(result.out) &&
        !/CLEAN/.test(result.out) &&
        requests.length === 2,
      `exit=${result.code} requests=${requests.length} elapsed=${result.elapsedMs}ms out=${result.out.trim()}`,
    );

    const strict = await runGate({
      url,
      lockfile: cleanLock,
      ...timing,
      env: { ...timing.env, AUDIT_REQUIRE_VERDICT: '1' },
    });
    check(
      `service ${mode} + AUDIT_REQUIRE_VERDICT=1 -> exit 1`,
      strict.code === 1 && /UNDETERMINED/.test(strict.out),
      `exit=${strict.code} out=${strict.out.trim()}`,
    );
  });
}

// The timeout path, asserted rather than logged: exactly AUDIT_RETRIES
// requests, each of which the gate abandons after its configured timeout.
for (const timeoutMs of HANG_SETTINGS_MS) {
  await withService('hang', {}, async (url, requests, lifetimes) => {
    const result = await runGate({
      url,
      lockfile: cleanLock,
      env: { AUDIT_TIMEOUT_MS: String(timeoutMs) },
      deadlineMs: HANG_DEADLINE_MS,
    });
    // Let the last connection's close event land.
    await new Promise((r) => setTimeout(r, 50));
    const [lo, hi] = LIFETIME_WINDOW(timeoutMs);
    check(
      `service hang at ${timeoutMs} ms -> 2 requests, each abandoned after ${lo}..${hi} ms`,
      result.code === 0 &&
        /UNDETERMINED/.test(result.out) &&
        requests.length === 2 &&
        lifetimes.length === 2 &&
        lifetimes.every((ms) => ms >= lo && ms <= hi) &&
        result.elapsedMs <= 2 * timeoutMs + STARTUP_ALLOWANCE_MS,
      `exit=${result.code} requests=${requests.length} lifetimes=${lifetimes.join(',')}ms elapsed=${result.elapsedMs}ms out=${result.out.trim()}`,
    );
  });
}

await withService('hang', {}, async (url) => {
  const annotated = await runGate({
    url,
    lockfile: cleanLock,
    env: { GITHUB_ACTIONS: 'true', AUDIT_TIMEOUT_MS: HANG_TIMEOUT_MS },
    deadlineMs: HANG_DEADLINE_MS,
  });
  check(
    'UNDETERMINED emits a ::warning:: annotation under GitHub Actions',
    /::warning::/.test(annotated.out),
    annotated.out.trim(),
  );
});

// An empty or unreadable lockfile must never read as "nothing to audit".
await withService('healthy', {}, async (url) => {
  const emptyLock = makeLockfile([]);
  const empty = await runGate({ url, lockfile: emptyLock });
  check(
    'lockfile with no packages -> refuses to report clean, exit 1',
    empty.code === 1 && !/CLEAN/.test(empty.out),
    `exit=${empty.code} out=${empty.out.trim()}`,
  );

  const missing = await runGate({ url, lockfile: '/nonexistent/pnpm-lock.yaml' });
  check(
    'missing lockfile -> refuses to report clean, exit 1',
    missing.code === 1 && !/CLEAN/.test(missing.out),
    `exit=${missing.code} out=${missing.out.trim()}`,
  );
});

// pnpm 11+ with a pinned packageManager writes TWO YAML documents: an env
// lockfile holding the pnpm binary, then the workspace lockfile. Both carry
// lockfileVersion / importers / packages, so only the importer contents tell
// them apart. Shaped after a real pnpm 12 lockfile.
function envDocument(packageKeys) {
  const entries = packageKeys
    .map((k) => `  '${k}':\n    resolution: {integrity: sha512-x}\n`)
    .join('\n');
  return (
    `---\nlockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    configDependencies: {}\n` +
    `    packageManagerDependencies:\n      pnpm:\n        specifier: 12.21.0\n        version: 12.21.0\n\n` +
    `packages:\n\n${entries}`
  );
}

function workspaceDocument(packageKeys) {
  const entries = packageKeys
    .map((k) => `  '${k}':\n    resolution: {integrity: sha512-x}\n`)
    .join('\n');
  return (
    `---\nlockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: false\n  excludeLinksFromLockfile: false\n\n` +
    `importers:\n\n  .:\n    devDependencies:\n      minimist:\n        specifier: ^1.2.5\n        version: 1.2.5\n\n` +
    `packages:\n\n${entries}`
  );
}

function writeLockfile(body) {
  const dir = mkdtempSync(join(tmpdir(), 'audit-lock-'));
  const file = join(dir, 'pnpm-lock.yaml');
  writeFileSync(file, body);
  return file;
}

const PNPM_PACKAGES = ['pnpm@12.21.0', '@pnpm/exe.darwin-arm64@12.21.0'];

await withService(
  'healthy',
  {
    minimist: [
      {
        id: 5,
        severity: 'critical',
        title: 'Prototype Pollution',
        vulnerable_versions: '>=1.2.0 <1.2.6',
      },
    ],
  },
  async (url) => {
    // The shape pnpm 12 actually writes: env document first.
    const pnpm12 = writeLockfile(
      envDocument(PNPM_PACKAGES) + workspaceDocument(['minimist@1.2.5', 'react@19.0.0']),
    );
    const result = await runGate({ url, lockfile: pnpm12 });
    check(
      'pnpm 12 two-document lockfile -> workspace document audited (its finding reported)',
      result.code === 1 && /VULNERABLE/.test(result.out) && /minimist/.test(result.out),
      `exit=${result.code} out=${result.out.trim()}`,
    );

    // Selection is by content, not position: same documents, reversed.
    const reversed = writeLockfile(
      workspaceDocument(['minimist@1.2.5', 'react@19.0.0']) + envDocument(PNPM_PACKAGES),
    );
    const rev = await runGate({ url, lockfile: reversed });
    check(
      'workspace document second -> still audited',
      rev.code === 1 && /VULNERABLE/.test(rev.out) && /minimist/.test(rev.out),
      `exit=${rev.code} out=${rev.out.trim()}`,
    );

    // `pnpm audit` sends the env document's packages (pnpm itself and the
    // @pnpm/exe.* binaries), so the gate must too: a finding that exists ONLY
    // in the env document has to surface.
    const envFinding = writeLockfile(
      envDocument([...PNPM_PACKAGES, 'minimist@1.2.5']) + workspaceDocument(['react@19.0.0']),
    );
    const env = await runGate({ url, lockfile: envFinding });
    check(
      'a finding only in the env (package-manager) document is reported',
      env.code === 1 && /VULNERABLE/.test(env.out) && /minimist/.test(env.out),
      `exit=${env.code} out=${env.out.trim()}`,
    );
  },
);

// Both documents, each package once: the workspace document has one package,
// the env document three, the union four.
await withService('healthy', {}, async (url) => {
  const lockfile = writeLockfile(
    envDocument([...PNPM_PACKAGES, 'minimist@1.2.5']) + workspaceDocument(['react@19.0.0']),
  );
  const result = await runGate({ url, lockfile });
  check(
    'both documents are audited (4 packages: 1 workspace + 3 package-manager)',
    result.code === 0 && /CLEAN — 4 packages checked/.test(result.out),
    `exit=${result.code} out=${result.out.trim()}`,
  );
});

// Snapshot keys are matched to `packages` exactly first, then with only a
// recognised trailing peer / patch suffix removed. A `(` inside the key itself
// (a `file:` tarball named `widget(copy).tgz`) is part of the name, and
// splitting at the first `(` reported a legitimate lockfile as inconsistent.
await withService('healthy', {}, async (url) => {
  const body =
    `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: false\n\nimporters:\n\n  .:\n    dependencies:\n      widget:\n        specifier: file:widget(copy).tgz\n        version: file:widget(copy).tgz\n\n` +
    `packages:\n\n  'widget@file:widget(copy).tgz':\n    resolution: {integrity: sha512-x, tarball: file:widget(copy).tgz}\n\n` +
    `  'react-dom@19.0.0':\n    resolution: {integrity: sha512-x}\n\n  'react@19.0.0':\n    resolution: {integrity: sha512-x}\n\n` +
    `  'patched@1.0.0':\n    resolution: {integrity: sha512-x}\n\n` +
    `snapshots:\n\n  'widget@file:widget(copy).tgz': {}\n\n  'react-dom@19.0.0(react@19.0.0)': {}\n\n  'react@19.0.0': {}\n\n  'patched@1.0.0(patch_hash=abc123)': {}\n`;
  const result = await runGate({ url, lockfile: writeLockfile(body) });
  check(
    'snapshot keys with a ( in the name, a peer suffix, and a patch suffix all resolve -> CLEAN, 4 packages',
    result.code === 0 && /CLEAN — 4 packages checked/.test(result.out),
    `exit=${result.code} out=${result.out.trim()}`,
  );

  // Stripping must be limited to a real suffix: an unrecognised trailing
  // group does not make an orphan snapshot match.
  const fake = `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: false\n\nimporters:\n\n  .: {}\n\npackages:\n\n  'react@19.0.0':\n    resolution: {integrity: sha512-x}\n\nsnapshots:\n\n  'react@19.0.0(not a suffix)': {}\n`;
  const rejected = await runGate({ url, lockfile: writeLockfile(fake) });
  check(
    'a snapshot whose trailing group is not a peer/patch suffix -> refuses, exit 1',
    rejected.code === 1 && /has no `packages` entry/.test(rejected.out),
    `exit=${rejected.code} out=${rejected.out.trim()}`,
  );
});

// Fail closed whenever the choice is not unambiguous.
await withService('healthy', {}, async (url) => {
  for (const [label, body] of [
    ['only the env document', envDocument(PNPM_PACKAGES)],
    [
      'two workspace documents',
      workspaceDocument(['react@19.0.0']) + workspaceDocument(['minimist@1.2.5']),
    ],
    ['an unrecognised extra document', `---\nfoo: bar\n${workspaceDocument(['react@19.0.0'])}`],
    // Recognised positively, not by elimination: an env-like document whose
    // importers are empty or missing is neither kind, and must not be taken
    // for the workspace (it would audit only pnpm and report CLEAN).
    [
      'an env-like document with empty importers and no workspace document',
      `---\nlockfileVersion: '9.0'\n\nimporters: {}\n\npackages:\n\n  'pnpm@12.21.0':\n    resolution: {integrity: sha512-x}\n`,
    ],
    [
      'an env-like document with no importers and no workspace document',
      `---\nlockfileVersion: '9.0'\n\npackages:\n\n  'pnpm@12.21.0':\n    resolution: {integrity: sha512-x}\n`,
    ],
    [
      'a workspace-like document without settings',
      `${envDocument(PNPM_PACKAGES)}---\nlockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies: {}\n\npackages:\n\n  'react@19.0.0':\n    resolution: {integrity: sha512-x}\n`,
    ],
    [
      'a snapshot with no packages entry',
      `${envDocument(PNPM_PACKAGES)}${workspaceDocument(['react@19.0.0'])}\nsnapshots:\n\n  'react@19.0.0': {}\n\n  'minimist@1.2.5': {}\n`,
    ],
    [
      'two env documents',
      envDocument(PNPM_PACKAGES) +
        envDocument(['pnpm@12.20.0']) +
        workspaceDocument(['react@19.0.0']),
    ],
    [
      'a document with a YAML error',
      `${envDocument(PNPM_PACKAGES)}---\nlockfileVersion: '9.0'\npackages: [unclosed\n`,
    ],
  ]) {
    const result = await runGate({ url, lockfile: writeLockfile(body) });
    check(
      `multi-document lockfile with ${label} -> refuses, exit 1`,
      result.code === 1 && !/CLEAN/.test(result.out) && /audit gate: lockfile/.test(result.out),
      `exit=${result.code} out=${result.out.trim()}`,
    );
  }
});

// --prod uses pnpm's own resolution instead of the lockfile. Faked with a PATH
// shim so the walker is exercised without needing a vulnerable prod tree.
function makePnpmShim(stdout, exitCode = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'audit-shim-'));
  writeFileSync(join(dir, 'pnpm'), `#!/bin/sh\ncat <<'JSON'\n${stdout}\nJSON\nexit ${exitCode}\n`);
  chmodSync(join(dir, 'pnpm'), 0o755);
  return dir;
}

/**
 * --prod reads the workspace that contains the current directory, so its
 * lockfile has to be that workspace's own: a throwaway workspace root holding
 * pnpm-workspace.yaml and the given lockfile body.
 */
function prodWorkspace(lockBody) {
  const cwd = mkdtempSync(join(tmpdir(), 'audit-ws-'));
  writeFileSync(join(cwd, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  writeFileSync(join(cwd, 'pnpm-lock.yaml'), lockBody);
  return { cwd, lockfile: join(cwd, 'pnpm-lock.yaml') };
}
const WORKSPACE_LOCK = `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: false\n\nimporters:\n\n  .: {}\n\npackages:\n\n  'react@19.2.8':\n    resolution: {integrity: sha512-x}\n`;

const PROD_TREE = JSON.stringify([
  {
    name: 'root',
    dependencies: {
      react: { version: '19.2.8' },
      minimist: { version: '1.2.5', dependencies: { nested: { version: '2.0.0' } } },
    },
  },
]);

await withService(
  'healthy',
  {
    nested: [
      {
        id: 4,
        severity: 'critical',
        title: 'Nested advisory',
        vulnerable_versions: '>=2.0.0 <3.0.0',
      },
    ],
  },
  async (url) => {
    const ws = prodWorkspace(WORKSPACE_LOCK);
    const shim = makePnpmShim(PROD_TREE);
    const prod = await runGate({
      url,
      ...ws,
      extraArgs: ['--prod'],
      env: { PATH: `${shim}:${process.env.PATH}` },
    });
    check(
      '--prod walks the pnpm tree and flags a TRANSITIVE prod finding (nested under minimist)',
      prod.code === 1 && /VULNERABLE/.test(prod.out) && /nested/.test(prod.out),
      `exit=${prod.code} out=${prod.out.trim()}`,
    );

    const emptyShim = makePnpmShim('[]');
    const emptyProd = await runGate({
      url,
      ...ws,
      extraArgs: ['--prod'],
      env: { PATH: `${emptyShim}:${process.env.PATH}` },
    });
    check(
      '--prod with an empty tree -> refuses to report clean, exit 1',
      emptyProd.code === 1 && !/CLEAN/.test(emptyProd.out),
      `exit=${emptyProd.code} out=${emptyProd.out.trim()}`,
    );
  },
);

// `pnpm ls --prod` never lists the package manager, but `pnpm audit --prod`
// audits it, so --prod adds the lockfile's env document.
await withService(
  'healthy',
  {
    minimist: [
      {
        id: 6,
        severity: 'critical',
        title: 'Prototype Pollution',
        vulnerable_versions: '>=1.2.0 <1.2.6',
      },
    ],
  },
  async (url) => {
    const shim = makePnpmShim(
      JSON.stringify([{ name: 'root', dependencies: { react: { version: '19.2.8' } } }]),
    );
    const run = (body) =>
      runGate({
        url,
        ...prodWorkspace(body),
        extraArgs: ['--prod'],
        env: { PATH: `${shim}:${process.env.PATH}` },
      });

    const flagged = await run(
      envDocument([...PNPM_PACKAGES, 'minimist@1.2.5']) + workspaceDocument(['react@19.0.0']),
    );
    check(
      '--prod: a finding in the env (package-manager) document is reported',
      flagged.code === 1 && /VULNERABLE/.test(flagged.out) && /minimist/.test(flagged.out),
      `exit=${flagged.code} out=${flagged.out.trim()}`,
    );

    const clean = await run(envDocument(PNPM_PACKAGES) + workspaceDocument(['react@19.0.0']));
    check(
      '--prod: prod tree plus env document (3 packages: react + pnpm + @pnpm/exe)',
      clean.code === 0 && /CLEAN — 3 packages checked/.test(clean.out),
      `exit=${clean.code} out=${clean.out.trim()}`,
    );

    const ambiguous = await run(
      workspaceDocument(['react@19.0.0']) + workspaceDocument(['react@19.0.0']),
    );
    check(
      '--prod: an ambiguous lockfile still refuses, exit 1',
      ambiguous.code === 1 && /audit gate: lockfile/.test(ambiguous.out),
      `exit=${ambiguous.code} out=${ambiguous.out.trim()}`,
    );

    // --prod combines THIS workspace's `pnpm ls` tree with --lockfile's
    // package-manager document; a lockfile from somewhere else is refused.
    const ws = prodWorkspace(envDocument(PNPM_PACKAGES) + workspaceDocument(['react@19.0.0']));
    const foreign = await runGate({
      url,
      cwd: ws.cwd,
      lockfile: writeLockfile(envDocument(PNPM_PACKAGES) + workspaceDocument(['react@19.0.0'])),
      extraArgs: ['--prod'],
      env: { PATH: `${shim}:${process.env.PATH}` },
    });
    check(
      "--prod with a --lockfile that is not the workspace's own -> refuses, exit 1",
      foreign.code === 1 &&
        !/CLEAN/.test(foreign.out) &&
        /--lockfile must be its own/.test(foreign.out),
      `exit=${foreign.code} out=${foreign.out.trim()}`,
    );
  },
);

if (failures > 0) {
  console.error(`\naudit gate self-test: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\naudit gate self-test: all checks passed');
