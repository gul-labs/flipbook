#!/usr/bin/env node
/**
 * Local quality entry that documents the gate order.
 * Prefer `pnpm quality` / `pnpm quality:ci` package scripts — this script is a
 * thin structural preflight (OSS files + package repository URLs + core invariants).
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const required = [
  'LICENSE',
  'NOTICE',
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'SUPPORT.md',
  'GOVERNANCE.md',
  'CODEOWNERS',
  '.github/CODEOWNERS',
  '.github/workflows/ci.yml',
  '.github/workflows/codeql.yml',
  '.github/dependabot.yml',
  'AGENTS.md',
  'eslint.config.mjs',
  'vitest.config.ts',
  'packages/core/package.json',
  'packages/react/package.json',
  'examples/vanilla/package.json',
  'examples/vite-react/package.json',
  'examples/nextjs/package.json',
];

const missing = required.filter((f) => !existsSync(join(root, f)));
if (missing.length > 0) {
  console.error(`Missing required files:\n${missing.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}

const expected = 'gul-labs/flipbook';
for (const dir of ['packages/core', 'packages/react']) {
  const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
  const url = String(pkg.repository?.url ?? pkg.repository ?? '');
  if (!url.includes(expected)) {
    console.error(
      `${dir}: repository.url must point at gul-labs/flipbook (got ${url || 'missing'})`,
    );
    process.exit(1);
  }
}

const core = JSON.parse(readFileSync(join(root, 'packages/core/package.json'), 'utf8'));
if (core.dependencies && Object.keys(core.dependencies).length > 0) {
  console.error(
    'packages/core must stay zero runtime dependencies; found:',
    Object.keys(core.dependencies).join(', '),
  );
  process.exit(1);
}
for (const dir of ['packages/core', 'packages/react']) {
  const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
  const files = pkg.files ?? [];
  if (!Array.isArray(files) || !files.includes('dist') || files.includes('src')) {
    console.error(`${dir}: package.json "files" must be dist-only (got ${JSON.stringify(files)})`);
    process.exit(1);
  }
}

// pnpm >= 10 blocks dependency install scripts unless allowlisted. The
// allowlist is `allowBuilds` in pnpm-workspace.yaml: pnpm 11 removed
// `onlyBuiltDependencies` and ignores the `pnpm` field in package.json, so an
// allowlist in either of those places is dead config that reads as if it were
// in force. pnpm 12 rejects unknown workspace keys, but measured on 12.21.0 it
// still accepts `onlyBuiltDependencies` without a word, so this check is what
// catches it. Parsed, not grepped: a regex accepts a key that is commented out
// or nested under another mapping.
const require_ = createRequire(import.meta.url);
let workspace;
try {
  workspace = require_('yaml').parse(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'));
} catch (error) {
  console.error(`pnpm-workspace.yaml is not parseable YAML: ${String(error)}`);
  process.exit(1);
}
const allowBuilds = workspace?.allowBuilds;
if (
  allowBuilds === null ||
  typeof allowBuilds !== 'object' ||
  Array.isArray(allowBuilds) ||
  !Object.values(allowBuilds).some((v) => v === true) ||
  !Object.values(allowBuilds).every((v) => typeof v === 'boolean')
) {
  console.error(
    'pnpm-workspace.yaml must define `allowBuilds` as a mapping of package name to true/false,\n' +
      `with at least one package allowed (got ${JSON.stringify(allowBuilds)}).`,
  );
  process.exit(1);
}
if (workspace && 'onlyBuiltDependencies' in workspace) {
  console.error(
    'pnpm-workspace.yaml still sets `onlyBuiltDependencies`, which pnpm 11 removed. Use `allowBuilds`.',
  );
  process.exit(1);
}
const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if ('pnpm' in rootManifest) {
  console.error(
    'package.json has a `pnpm` field. pnpm 11+ ignores it; move the setting to pnpm-workspace.yaml.',
  );
  process.exit(1);
}

// TypeScript must stay inside typescript-eslint's supported range. Outside it,
// `pnpm install` still succeeds and every type-aware rule quietly degrades —
// which is most of the quality bar. This is why the workspace is pinned to
// TypeScript 6 rather than the newest release; make it a loud failure, not a
// comment someone reads later.

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  return match ? match.slice(1, 4).map(Number) : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function satisfies(version, range) {
  const parsed = parseVersion(version);
  if (!parsed) return null;

  for (const comparator of range.trim().split(/\s+/)) {
    const match = /^(>=|<=|>|<)(\d+\.\d+\.\d+)$/.exec(comparator);
    // Only the simple comparator form is understood; anything else and the
    // check abstains rather than guessing.
    if (!match) return null;

    const bound = parseVersion(match[2]);
    if (!bound) return null;

    const order = compare(parsed, bound);
    const ok =
      (match[1] === '>=' && order >= 0) ||
      (match[1] === '>' && order > 0) ||
      (match[1] === '<=' && order <= 0) ||
      (match[1] === '<' && order < 0);

    if (!ok) return false;
  }

  return true;
}

const tsVersion = require_('typescript/package.json').version;
const tsRange = require_('typescript-eslint/package.json').peerDependencies?.typescript;
const supported = tsRange ? satisfies(tsVersion, tsRange) : null;

if (supported === false) {
  console.error(
    `TypeScript ${tsVersion} is outside typescript-eslint's supported range (${tsRange}).\n` +
      'Type-aware lint rules degrade silently outside it. Pin TypeScript back, or\n' +
      'upgrade typescript-eslint first and re-run.',
  );
  process.exit(1);
}

if (supported === null) {
  console.warn(
    `Could not check TypeScript ${tsVersion} against typescript-eslint range ${String(tsRange)}.`,
  );
}

console.log('quality preflight: ok');

// Licensing is an owner decision, not an implementation detail — and not a
// tool's. The owner relicensed the engine to MPL-2.0 on 2026-08-28 so that
// forks of the engine cannot be taken closed, while keeping the React binding
// MIT and leaving consuming applications entirely unencumbered (MPL-2.0 is
// file-level copyleft: it reaches the engine's own files, nothing else).
// Upstream Nodlik MIT notices stay preserved in LICENSE and NOTICE.
// If you are changing this, the repository owner has decided to.
const EXPECTED_LICENSES = {
  'package.json': 'MIT AND MPL-2.0',
  'packages/core/package.json': 'MPL-2.0',
  'packages/react/package.json': 'MIT',
};

for (const [manifest, expected] of Object.entries(EXPECTED_LICENSES)) {
  const pkg = JSON.parse(readFileSync(join(root, manifest), 'utf8'));
  if (pkg.license !== expected) {
    console.error(
      `${manifest}: license is ${JSON.stringify(pkg.license)}, expected ${JSON.stringify(expected)}.\n` +
        'Relicensing is an owner decision. Revert, or get explicit sign-off first.',
    );
    process.exit(1);
  }
}

// Byte-exact, not substring. A marker list accepts a file that keeps every
// heading while §3.2 is quietly rewritten, which is precisely the edit that
// would matter. The digest below is SHA-256 of the canonical MPL-2.0 text as
// published at https://www.mozilla.org/media/MPL/2.0/index.txt (16726 bytes).
// It is a constant of the license, not of this repo: it changes only if Mozilla
// publishes a new version, in which case that is a deliberate relicense.
const MPL_2_0_SHA256 = '3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04';
const MPL_TAIL_MARKER =
  '\n-------------------------------------------------------------------------------\n\n@gullabs/flipbook-core is Copyright';

const coreLicense = readFileSync(join(root, 'packages/core/LICENSE'), 'utf8');
const tailAt = coreLicense.indexOf(MPL_TAIL_MARKER);
if (tailAt === -1) {
  console.error(
    'packages/core/LICENSE: the MPL-2.0 text and the GulLabs/upstream notice block are no longer separated as expected.',
  );
  process.exit(1);
}
const mplBody = `${coreLicense.slice(0, tailAt).replace(/\n+$/, '')}\n`;
const mplDigest = createHash('sha256').update(mplBody).digest('hex');
if (mplDigest !== MPL_2_0_SHA256) {
  console.error(
    `packages/core/LICENSE: the MPL-2.0 text is not byte-identical to the canonical license.\n` +
      `  expected sha256 ${MPL_2_0_SHA256}\n` +
      `  actual   sha256 ${mplDigest}\n` +
      'Restore it from https://www.mozilla.org/media/MPL/2.0/index.txt.',
  );
  process.exit(1);
}

// The notice block that follows the MPL body in packages/core/LICENSE is pinned
// too. Hashing only the MPL text left the trailing block free to contradict it
// — e.g. to assert terms the license does not grant — without tripping anything.
const CORE_LICENSE_TAIL_SHA256 = '3803bbb053002c6ebdf1c7b4c7935c6385438d7ff6643b69612955921e4cbade';
const coreTailDigest = createHash('sha256').update(coreLicense.slice(tailAt)).digest('hex');
if (coreTailDigest !== CORE_LICENSE_TAIL_SHA256) {
  console.error(
    'packages/core/LICENSE: the notice block after the MPL text changed.\n' +
      `  expected sha256 ${CORE_LICENSE_TAIL_SHA256}\n` +
      `  actual   sha256 ${coreTailDigest}\n` +
      'If the change is intended, update CORE_LICENSE_TAIL_SHA256 in this file.',
  );
  process.exit(1);
}

// The MIT grant, verbatim. A substring check on the copyright line or the
// warranty sentence still passes a file whose *permission* paragraph has been
// gutted — which is the edit that would actually strip the upstream grant. So
// the whole body is pinned, and each file must carry it a minimum number of
// times: once per notice it is supposed to reproduce.
const MIT_GRANT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const countOf = (haystack, needle) => haystack.split(needle).length - 1;

// `grants` is the minimum number of verbatim MIT grants the file must contain.
// NOTICE summarises and points at LICENSE, so it carries attribution only.
const NOTICE_FILES = [
  {
    file: 'LICENSE',
    needles: [
      'Copyright (c) 2026 Gul Labs',
      'Copyright (c) 2020 Nodlik',
      'Copyright (c) 2020 oleg.litovski9@gmail.com',
    ],
    grants: 3,
  },
  {
    file: 'NOTICE',
    needles: ['Copyright (c) 2020 Nodlik', 'Copyright (c) 2020 oleg.litovski9@gmail.com'],
    grants: 0,
  },
  { file: 'packages/core/LICENSE', needles: ['Copyright (c) 2020 Nodlik'], grants: 1 },
  { file: 'packages/react/LICENSE', needles: ['Copyright (c) 2026 Gul Labs'], grants: 1 },
];

for (const { file, needles, grants } of NOTICE_FILES) {
  const text = readFileSync(join(root, file), 'utf8');
  for (const needle of needles) {
    if (!text.includes(needle)) {
      console.error(`${file}: required notice is missing — ${JSON.stringify(needle)}.`);
      process.exit(1);
    }
  }
  const found = countOf(text, MIT_GRANT);
  if (found < grants) {
    console.error(
      `${file}: expected at least ${grants} verbatim MIT grant(s), found ${found}.\n` +
        'The upstream MIT permission text must be reproduced exactly.',
    );
    process.exit(1);
  }
}

// MPL Exhibit A on every core source. Without this the headers can be stripped
// file by file and nothing notices until someone reads the tree.
// The complete header, anchored to the start of the file — not a URL substring.
// A substring test passes `// https://mozilla.org/MPL/2.0/`, which removes the
// notice while looking like it is still there.
const EXHIBIT_A = `/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */`;
const coreSrc = join(root, 'packages/core/src');
// Every TypeScript extension the build can pick up, not just `.ts` — a new
// `foo.mts` would otherwise ship without the notice. Symlinks are refused
// rather than followed: traversing them is how a directory of unheadered
// sources gets in without the walk ever seeing it.
// Every source extension the bundler can pull in from src/, not only the
// TypeScript ones — a plain .js imported from index.ts is bundled just the
// same and would otherwise ship without the notice.
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isSymbolicLink()) {
      console.error(`packages/core/src: symlink not allowed (${path.slice(root.length + 1)}).`);
      process.exit(1);
    }
    if (e.isDirectory()) return walk(path);
    return SOURCE_EXTENSIONS.some((ext) => e.name.endsWith(ext)) ? [path] : [];
  });
const missingHeaders = walk(coreSrc).filter((f) => !readFileSync(f, 'utf8').startsWith(EXHIBIT_A));
if (missingHeaders.length > 0) {
  const list = missingHeaders.map((f) => `  ${f.slice(root.length + 1)}`).join('\n');
  console.error(`packages/core/src: MPL Exhibit A header missing from:\n${list}`);
  process.exit(1);
}

// The header walk covers files that live in src/. What actually ships is
// whatever the entry pulls in, and tsup does not confine that to src/ — so the
// authoritative list is esbuild's own. Any regex over import syntax is
// guessable around (require(), template specifiers, comments); asking the
// bundler what it bundled is exact, and closes the whole class.
const esbuildEntry = createRequire(
  createRequire(join(root, 'packages/core/package.json')).resolve('tsup'),
).resolve('esbuild');
const { build } = await import(pathToFileURL(esbuildEntry).href);

let bundled;
try {
  bundled = await build({
    entryPoints: [join(coreSrc, 'index.ts')],
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    target: 'es2020',
    logLevel: 'silent',
  });
} catch (error) {
  // Preflight runs before typecheck, so a syntax or resolution error lands here
  // first. Say which check failed rather than surfacing a bare esbuild throw.
  console.error(
    `packages/core: could not bundle src/index.ts to check MPL headers.\n${String(error)}`,
  );
  process.exit(1);
}

// Every first-party input, not just the ones under packages/core. Filtering to
// that directory reintroduced the hole it was meant to close: a relative import
// to an unheadered file elsewhere in the repo is bundled into dist all the same.
// Third-party code in node_modules carries its own licence and is excluded.
const bundledCoreFiles = Object.keys(bundled.metafile.inputs)
  .map((p) => resolve(root, p))
  .filter((p) => p.startsWith(`${root}/`) && !p.includes('/node_modules/'));

// JSON cannot carry a comment, so it can never satisfy Exhibit A. Rather than
// exempt it — which is how an unheadered file gets in — refuse to bundle it.
const bundledJson = bundledCoreFiles.filter((f) => f.endsWith('.json'));
if (bundledJson.length > 0) {
  const list = bundledJson.map((f) => `  ${f.slice(root.length + 1)}`).join('\n');
  console.error(
    `packages/core: JSON cannot carry the MPL Exhibit A notice, so it must not be bundled.\nMove the data into a .ts module:\n${list}`,
  );
  process.exit(1);
}

const unheaderedBundled = bundledCoreFiles.filter(
  (f) => !readFileSync(f, 'utf8').startsWith(EXHIBIT_A),
);
if (unheaderedBundled.length > 0) {
  const list = unheaderedBundled.map((f) => `  ${f.slice(root.length + 1)}`).join('\n');
  console.error(
    `packages/core: these files are bundled into the published engine but carry no MPL Exhibit A header:\n${list}`,
  );
  process.exit(1);
}
