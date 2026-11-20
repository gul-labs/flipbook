#!/usr/bin/env node
/**
 * Self-test for scripts/check-published-provenance.mjs.
 *
 * The check only ever runs for real straight after a publish, which nobody can
 * do to test it. So every branch is driven here against a local fake of the
 * registry's version endpoint: attested, unattested, attested-but-hollow,
 * late-appearing, down, hanging. The one that matters most is "the version doc
 * exists and has no attestation" — the exact shape a token-fallback publish
 * leaves behind — and it must be red.
 *
 * Usage: node scripts/check-published-provenance.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECK = join(dirname(fileURLToPath(import.meta.url)), 'check-published-provenance.mjs');

const PROVENANCE = { predicateType: 'https://slsa.dev/provenance/v1' };

/** A registry version document, shaped like registry.npmjs.org's. */
const versionDoc = (name, version, attestations) => ({
  name,
  version,
  dist: {
    tarball: `https://registry.example/${name}/-/${version}.tgz`,
    integrity: 'sha512-x',
    ...(attestations === undefined ? {} : { attestations }),
  },
});

const attested = (name, version) =>
  versionDoc(name, version, {
    url: `https://registry.example/-/npm/v1/attestations/${name}@${version}`,
    provenance: PROVENANCE,
  });

/**
 * Registry fake. `routes` maps a request path to a list of responses served in
 * order (the last one repeats): `{ status, body }`, or `'hang'`.
 */
function startRegistry(routes) {
  const seen = [];
  const served = new Map();
  const server = createServer((req, res) => {
    seen.push(req.url);
    const plan = routes[req.url];
    if (!plan) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    const n = served.get(req.url) ?? 0;
    served.set(req.url, n + 1);
    const step = plan[Math.min(n, plan.length - 1)];
    if (step === 'hang') return;
    res.writeHead(step.status, { 'content-type': 'application/json' });
    res.end(typeof step.body === 'string' ? step.body : JSON.stringify(step.body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` }),
    );
  });
}

// Per-request budget for every case that is not about the timeout. A freshly
// spawned check pays fetch()'s lazy initialisation inside it; see
// REQUEST_BUDGET_MS in audit.test.mjs for the measurements behind this.
const REQUEST_BUDGET_MS = '10000';
// The hang case IS about the timeout. 1000 ms clears the worst measured cold
// start, so all three attempts really reach the fake before they are aborted
// (the case asserts three requests; at 300 ms an attempt could abort before it
// was sent). Bounded from outside so a check that ignores
// PROVENANCE_TIMEOUT_MS fails here instead of hanging.
const HANG_TIMEOUT_MS = '1000';
const HANG_DEADLINE_MS = 15000;

function runCheck({ url, published, args = [], env = {}, deadlineMs = 60000 }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHECK, ...args], {
      env: {
        ...process.env,
        PROVENANCE_REGISTRY_URL: url,
        PROVENANCE_RETRIES: '3',
        PROVENANCE_BASE_DELAY_MS: '1',
        PROVENANCE_TIMEOUT_MS: REQUEST_BUDGET_MS,
        ...(published === undefined
          ? { PUBLISHED_PACKAGES: '' }
          : {
              PUBLISHED_PACKAGES:
                typeof published === 'string' ? published : JSON.stringify(published),
            }),
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
      resolve({
        code: killed ? 'killed' : code,
        out: killed ? `${out}\n[killed after ${deadlineMs} ms]` : out,
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

async function withRegistry(routes, fn) {
  const { server, seen, url } = await startRegistry(routes);
  try {
    return await fn(url, seen);
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
}

const CORE = { name: '@gullabs/flipbook-core', version: '3.2.3' };
const REACT = { name: '@gullabs/react-flipbook', version: '3.2.3' };
const CORE_PATH = '/@gullabs%2Fflipbook-core/3.2.3';
const REACT_PATH = '/@gullabs%2Freact-flipbook/3.2.3';
const ok = (doc) => [{ status: 200, body: doc }];

console.log('published-provenance check self-test');

await withRegistry(
  {
    [CORE_PATH]: ok(attested(CORE.name, CORE.version)),
    [REACT_PATH]: ok(attested(REACT.name, REACT.version)),
  },
  async (url, seen) => {
    const result = await runCheck({ url, published: [CORE, REACT] });
    check(
      'every published version attested -> VERIFIED, exit 0',
      result.code === 0 && /check: VERIFIED/.test(result.out),
      `exit=${result.code} out=${result.out.trim()}`,
    );
    check(
      'scoped names are requested as @scope%2Fname/version',
      seen.includes(CORE_PATH) && seen.includes(REACT_PATH),
      `requested: ${seen.join(', ')}`,
    );
  },
);

// The token-fallback publish: the version exists, the attestation does not.
await withRegistry({ [CORE_PATH]: ok(versionDoc(CORE.name, CORE.version)) }, async (url) => {
  const result = await runCheck({ url, published: [CORE] });
  check(
    'version doc with no attestations -> MISSING, exit 1',
    result.code === 1 && /MISSING/.test(result.out) && !/check: VERIFIED/.test(result.out),
    `exit=${result.code} out=${result.out.trim()}`,
  );
});

// Present-but-hollow shapes. Each is "something under dist", none is provenance.
for (const [label, attestations] of [
  ['attestations without provenance', { url: 'https://registry.example/-/npm/v1/attestations/x' }],
  ['provenance: true', { provenance: true }],
  ['provenance: {}', { provenance: {} }],
  ['non-SLSA predicateType', { provenance: { predicateType: 'https://example.com/whatever' } }],
]) {
  await withRegistry(
    { [CORE_PATH]: ok(versionDoc(CORE.name, CORE.version, attestations)) },
    async (url) => {
      const result = await runCheck({ url, published: [CORE] });
      check(
        `${label} -> MISSING, exit 1`,
        result.code === 1 && /MISSING/.test(result.out) && !/check: VERIFIED/.test(result.out),
        `exit=${result.code} out=${result.out.trim()}`,
      );
    },
  );
}

// One good, one bad: the bad one must not be averaged away.
await withRegistry(
  {
    [CORE_PATH]: ok(attested(CORE.name, CORE.version)),
    [REACT_PATH]: ok(versionDoc(REACT.name, REACT.version)),
  },
  async (url) => {
    const result = await runCheck({ url, published: [CORE, REACT] });
    check(
      'one of two unattested -> MISSING names that package, exit 1',
      result.code === 1 &&
        /MISSING/.test(result.out) &&
        /@gullabs\/react-flipbook@3\.2\.3: dist\.attestations\.provenance is absent/.test(
          result.out,
        ),
      `exit=${result.code} out=${result.out.trim()}`,
    );
  },
);

// The registry answers with a different version than was asked for.
await withRegistry({ [CORE_PATH]: ok(attested(CORE.name, '3.2.2')) }, async (url) => {
  const result = await runCheck({ url, published: [CORE] });
  check(
    'registry returns a different version -> MISSING, exit 1',
    result.code === 1 && /MISSING/.test(result.out),
    `exit=${result.code} out=${result.out.trim()}`,
  );
});

// Registry lag: 404 until the version becomes visible.
await withRegistry(
  {
    [CORE_PATH]: [
      { status: 404, body: { error: 'Not found' } },
      { status: 404, body: { error: 'Not found' } },
      { status: 200, body: attested(CORE.name, CORE.version) },
    ],
  },
  async (url, seen) => {
    const result = await runCheck({ url, published: [CORE] });
    check(
      '404, 404, then attested -> retried and VERIFIED, exit 0',
      result.code === 0 && /check: VERIFIED/.test(result.out) && seen.length === 3,
      `exit=${result.code} requests=${seen.length} out=${result.out.trim()}`,
    );
  },
);

// Never laundering "could not check" into a pass.
for (const [label, plan] of [
  ['always 404', [{ status: 404, body: { error: 'Not found' } }]],
  ['always 503', [{ status: 503, body: { error: 'Service Unavailable' } }]],
  ['always 429', [{ status: 429, body: { error: 'Too Many Requests' } }]],
  ['200 with a non-JSON body', [{ status: 200, body: '<html>maintenance</html>' }]],
  ['hang', ['hang']],
]) {
  await withRegistry({ [CORE_PATH]: plan }, async (url, seen) => {
    const timing =
      label === 'hang'
        ? { env: { PROVENANCE_TIMEOUT_MS: HANG_TIMEOUT_MS }, deadlineMs: HANG_DEADLINE_MS }
        : {};
    const result = await runCheck({ url, published: [CORE], ...timing });
    check(
      `registry ${label} -> UNVERIFIED after retries, exit 1`,
      result.code === 1 &&
        /UNVERIFIED/.test(result.out) &&
        !/check: VERIFIED/.test(result.out) &&
        seen.length === 3,
      `exit=${result.code} requests=${seen.length} out=${result.out.trim()}`,
    );
  });
}

// A non-retryable client error is reported without burning retries.
await withRegistry(
  { [CORE_PATH]: [{ status: 403, body: { error: 'Forbidden' } }] },
  async (url, seen) => {
    const result = await runCheck({ url, published: [CORE] });
    check(
      'registry 403 -> UNVERIFIED without retrying, exit 1',
      result.code === 1 && /UNVERIFIED/.test(result.out) && seen.length === 1,
      `exit=${result.code} requests=${seen.length} out=${result.out.trim()}`,
    );
  },
);

// Nothing to check is not a pass: the step only runs when changesets says it published.
await withRegistry({}, async (url, seen) => {
  for (const [label, published] of [
    ['unset', undefined],
    ['empty array', []],
    ['not JSON', 'published'],
    ['object, not array', { name: CORE.name, version: CORE.version }],
    ['entry without version', [{ name: CORE.name }]],
    ['name with a path segment', [{ name: '@gullabs/../evil', version: '1.0.0' }]],
    ['version that is not semver', [{ name: CORE.name, version: 'latest' }]],
  ]) {
    const result = await runCheck({ url, published });
    check(
      `publishedPackages ${label} -> BAD INPUT, exit 1`,
      result.code === 1 && /BAD INPUT/.test(result.out),
      `exit=${result.code} out=${result.out.trim()}`,
    );
  }
  check('BAD INPUT never reaches the registry', seen.length === 0, `requests: ${seen.join(', ')}`);
});

// Tuning variables are validated: zero or unparseable values used to skip the
// fetch loop entirely and die on a TypeError — non-zero by accident.
await withRegistry({ [CORE_PATH]: ok(attested(CORE.name, CORE.version)) }, async (url, seen) => {
  for (const [name, value] of [
    ['PROVENANCE_RETRIES', '0'],
    ['PROVENANCE_RETRIES', 'abc'],
    ['PROVENANCE_RETRIES', '-1'],
    ['PROVENANCE_RETRIES', '1.5'],
    ['PROVENANCE_RETRIES', ''],
    ['PROVENANCE_BASE_DELAY_MS', 'abc'],
    ['PROVENANCE_BASE_DELAY_MS', '0'],
    ['PROVENANCE_TIMEOUT_MS', '0'],
    ['PROVENANCE_TIMEOUT_MS', 'Infinity'],
    ['PROVENANCE_TIMEOUT_MS', '1e3'],
    ['PROVENANCE_REGISTRY_URL', 'not a url'],
    ['PROVENANCE_REGISTRY_URL', 'file:///etc'],
  ]) {
    const result = await runCheck({ url, published: [CORE], env: { [name]: value } });
    check(
      `${name}=${JSON.stringify(value)} -> BAD INPUT naming it, exit 1`,
      result.code === 1 &&
        /BAD INPUT/.test(result.out) &&
        result.out.includes(name) &&
        !/TypeError/.test(result.out),
      `exit=${result.code} out=${result.out.trim()}`,
    );
  }
  check(
    'invalid tuning never reaches the registry',
    seen.length === 0,
    `requests: ${seen.join(', ')}`,
  );

  const one = await runCheck({ url, published: [CORE], env: { PROVENANCE_RETRIES: '1' } });
  check(
    'PROVENANCE_RETRIES=1 is valid -> VERIFIED, exit 0',
    one.code === 0 && /check: VERIFIED/.test(one.out),
    `exit=${one.code} out=${one.out.trim()}`,
  );
});

// argv takes the same JSON as the environment.
await withRegistry({ [CORE_PATH]: ok(attested(CORE.name, CORE.version)) }, async (url) => {
  const result = await runCheck({ url, published: undefined, args: [JSON.stringify([CORE])] });
  check(
    'publishedPackages as argv[2] -> VERIFIED, exit 0',
    result.code === 0 && /check: VERIFIED/.test(result.out),
    `exit=${result.code} out=${result.out.trim()}`,
  );
});

if (failures > 0) {
  console.error(`\npublished-provenance check self-test: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\npublished-provenance check self-test: all checks passed');
