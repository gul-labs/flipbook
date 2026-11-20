/**
 * Tests for the two release/supply-chain gates in `scripts/`.
 *
 * These live here because `packages/core/tests` is the only node-environment
 * vitest project in the repo; they test nothing in `packages/core/src`.
 *
 * Both gates are driven the way CI drives them — as a child process, asserted
 * on the EXIT CODE, never on the text of the output. A previous gate in this
 * repo printed both `644 passed` and `1 error`, exited non-zero, and was read as
 * green because someone grepped stdout.
 *
 * The negative fixtures are not hypothetical. Every one of them is a hole an
 * independent review (2026-08-29) demonstrated in the shipped version of these
 * scripts: guards satisfied by a `#` comment, by another job, by a step, or by
 * `always() || …`; `permissions: write-all` invisible to a `contents: write`
 * regex; and a React manifest with no `react-dom`, `react: "0"`, or a
 * nonexistent `^999.0.0` core range.
 *
 * The last fixture in each group is the negative control: semantically correct
 * input written differently must still PASS, or the gate is brittle rather than
 * strict, and the next maintainer will weaken it to get their build back.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

/**
 * Node is reached through runtime-resolved dynamic imports with hand-written
 * signatures rather than `import … from 'node:fs'`.
 *
 * `@types/node` is a ROOT devDependency, so it is in the root `tsconfig.json`
 * program but not in `packages/core/tsconfig.json`'s — and `pnpm typecheck`'
 * runs both. A literal `node:` specifier here fails `packages/core`'s typecheck'
 * with TS2591. Putting @types/node into `packages/core/package.json` would fix
 * it properly and is the right change; it is a manifest edit, so it is proposed
 * rather than made here. The locally declared shapes below are narrower than
 * the real APIs but they are used, not asserted around, so a mismatch shows up
 * as a failing test rather than as a silent `any`.
 */
interface NodeChildProcess {
  execFileSync(
    file: string,
    args: string[],
    options: {
      cwd: string;
      stdio: [string, string, string];
      env: Record<string, string | undefined>;
    },
  ): unknown;
}
interface NodeFs {
  mkdtempSync(prefix: string): string;
  readFileSync(path: string, encoding: 'utf8'): string;
  rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
  writeFileSync(path: string, data: string): void;
}
interface NodeOs {
  tmpdir(): string;
}
interface NodeProcess {
  execPath: string;
  cwd(): string;
  env: Record<string, string | undefined>;
}

const loadNode = async <T>(specifier: string): Promise<T> =>
  (await import(/* @vite-ignore */ specifier)) as T;

const childProcess = await loadNode<NodeChildProcess>('node:child_process');
const fs = await loadNode<NodeFs>('node:fs');
const os = await loadNode<NodeOs>('node:os');
const proc = (globalThis as unknown as { process: NodeProcess }).process;

// Vitest is configured at the repo root, so that is the cwd. Assert it rather
// than assume it: a wrong root would make every gate invocation fail for the
// wrong reason and the REJECT tests would still look green.
const repoRoot = proc.cwd();
const rootManifest = JSON.parse(fs.readFileSync(`${repoRoot}/package.json`, 'utf8')) as {
  name?: string;
};
if (rootManifest.name !== 'flipbook') {
  throw new Error(`expected the vitest cwd to be the repo root, got ${repoRoot}`);
}

const WORKFLOW_GATE = `${repoRoot}/scripts/check-workflow-guards.mjs`;
const PACKED_GATE = `${repoRoot}/scripts/check-packed-artifacts.mjs`;

let work: string;
beforeAll(() => {
  work = fs.mkdtempSync(`${os.tmpdir()}/flipbook-release-gates-`);
});
afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

/** Run a gate and return only its exit code. Output is never inspected. */
const exitCodeOf = (args: string[], env: Record<string, string> = {}): number => {
  try {
    childProcess.execFileSync(proc.execPath, args, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...proc.env, ...env },
    });
    return 0;
  } catch (error) {
    const status = (error as { status?: number | null }).status;
    // A gate that dies on a signal, or otherwise reports no status, has not
    // established its claim either — surface that as a failure, not a pass.
    return typeof status === 'number' ? status : 1;
  }
};

const writeWorkflow = (name: string, body: string): string => {
  const path = `${work}/${name}.yml`;
  fs.writeFileSync(path, body);
  return path;
};

const GUARD = [
  "github.event.workflow_run.conclusion == 'success'",
  "github.event.workflow_run.event == 'push'",
  'github.event.workflow_run.head_repository.full_name == github.repository',
  "github.event.workflow_run.head_branch == 'main'",
  'github.event.workflow_run.head_sha == github.sha',
].join(' &&\n      ');

/** changesets/action@v2 contract — required so fixtures exercise the real guards. */
const CHANGESETS_V2_STEP = `- uses: changesets/action@v2
        with:
          version-script: pnpm version-packages
          publish-script: pnpm release
          github-token: \${{ secrets.GITHUB_TOKEN }}
        env:
          NPM_TOKEN: \${{ secrets.NPM_TOKEN }}`;

/** A minimal but genuinely safe release workflow, used as the mutation base. */
const safeWorkflow = (overrides: { topPermissions?: string; jobIf?: string } = {}): string => `
name: Release
on:
  workflow_run:
    workflows: ['CI']
    types: [completed]
    branches: [main]
permissions:
  ${overrides.topPermissions ?? 'contents: read'}
jobs:
  release:
    runs-on: ubuntu-latest
    if: >-
      ${overrides.jobIf ?? GUARD}
    permissions:
      contents: write
      id-token: write
    steps:
      - uses: actions/checkout@v7
      ${CHANGESETS_V2_STEP}
`;

describe('scripts/check-workflow-guards.mjs', () => {
  test('the real .github/workflows/release.yml passes', () => {
    expect(exitCodeOf([WORKFLOW_GATE])).toBe(0);
  });

  test('a synthetic but genuinely guarded workflow passes', () => {
    expect(exitCodeOf([WORKFLOW_GATE, writeWorkflow('safe', safeWorkflow())])).toBe(0);
  });

  test('REJECTS a workflow whose guards appear only in a # comment', () => {
    const body = `
name: Release
on:
  workflow_run:
    workflows: ['CI']
    types: [completed]
    branches: [main]
permissions:
  contents: read
jobs:
  release:
    runs-on: ubuntu-latest
    # ${GUARD.split('\n').join('\n    # ')}
    steps:
      ${CHANGESETS_V2_STEP}
`;
    expect(exitCodeOf([WORKFLOW_GATE, writeWorkflow('comment-only', body)])).not.toBe(0);
  });

  test('REJECTS a workflow whose guards sit on a DIFFERENT job', () => {
    const body = `
name: Release
on:
  workflow_run:
    workflows: ['CI']
    types: [completed]
    branches: [main]
permissions:
  contents: read
jobs:
  decoy:
    runs-on: ubuntu-latest
    if: >-
      ${GUARD}
    steps:
      - run: echo guarded
  release:
    runs-on: ubuntu-latest
    steps:
      ${CHANGESETS_V2_STEP}
`;
    expect(exitCodeOf([WORKFLOW_GATE, writeWorkflow('other-job', body)])).not.toBe(0);
  });

  test('REJECTS a workflow whose guards sit on a STEP rather than the job', () => {
    const body = `
name: Release
on:
  workflow_run:
    workflows: ['CI']
    types: [completed]
    branches: [main]
permissions:
  contents: read
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: changesets/action@v2
        if: >-
          ${GUARD.split('\n').join('\n    ')}
        with:
          version-script: pnpm version-packages
          publish-script: pnpm release
          github-token: \${{ secrets.GITHUB_TOKEN }}
        env:
          NPM_TOKEN: \${{ secrets.NPM_TOKEN }}
`;
    expect(exitCodeOf([WORKFLOW_GATE, writeWorkflow('step-guard', body)])).not.toBe(0);
  });

  test('REJECTS `always() || <the real condition>`', () => {
    const path = writeWorkflow(
      'always-or',
      safeWorkflow({ jobIf: `always() ||\n      (${GUARD})` }),
    );
    expect(exitCodeOf([WORKFLOW_GATE, path])).not.toBe(0);
  });

  test('REJECTS a `|| true` short-circuit appended to a correct condition', () => {
    const path = writeWorkflow('or-true', safeWorkflow({ jobIf: `${GUARD} ||\n      true` }));
    expect(exitCodeOf([WORKFLOW_GATE, path])).not.toBe(0);
  });

  test('REJECTS `permissions: write-all` at workflow level', () => {
    const path = writeWorkflow(
      'write-all',
      safeWorkflow({ topPermissions: '' }).replace(
        'permissions:\n  \n',
        'permissions: write-all\n',
      ),
    );
    expect(exitCodeOf([WORKFLOW_GATE, path])).not.toBe(0);
  });

  test('REJECTS a workflow-level `contents: write`', () => {
    const path = writeWorkflow('top-write', safeWorkflow({ topPermissions: 'contents: write' }));
    expect(exitCodeOf([WORKFLOW_GATE, path])).not.toBe(0);
  });

  test.each([
    ["github.event.workflow_run.conclusion == 'success'", 'conclusion'],
    ["github.event.workflow_run.event == 'push'", 'event'],
    ['github.event.workflow_run.head_repository.full_name == github.repository', 'repository'],
    ["github.event.workflow_run.head_branch == 'main'", 'branch'],
    ['github.event.workflow_run.head_sha == github.sha', 'head-sha'],
  ])('REJECTS a workflow with the %s guard dropped', (dropped, label) => {
    const remaining = GUARD.split('&&')
      .map((s) => s.trim())
      .filter((s) => s !== dropped)
      .join(' &&\n      ');
    expect(remaining).not.toContain(dropped);
    const path = writeWorkflow(`drop-${label}`, safeWorkflow({ jobIf: remaining }));
    expect(exitCodeOf([WORKFLOW_GATE, path])).not.toBe(0);
  });

  // The fifth guard ties the commit that is built to the commit the run (and
  // so its provenance) is attributed to. A comparison that is always true, or
  // one against the wrong side, must not satisfy it.
  test.each([
    ['github.event.workflow_run.head_sha == github.event.workflow_run.head_sha', 'tautology'],
    ['github.event.workflow_run.head_sha != github.sha', 'negated'],
    ['github.event.workflow_run.head_commit.id == github.sha', 'head-commit-id'],
  ])('REJECTS the head_sha guard written as %s', (replacement, label) => {
    const jobIf = GUARD.replace('github.event.workflow_run.head_sha == github.sha', replacement);
    expect(jobIf).toContain(replacement);
    const path = writeWorkflow(`head-sha-${label}`, safeWorkflow({ jobIf }));
    expect(exitCodeOf([WORKFLOW_GATE, path])).not.toBe(0);
  });

  test('REJECTS a workflow with no publishing job it can identify', () => {
    const body = `
name: Release
on:
  workflow_run:
    workflows: ['CI']
    types: [completed]
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
    expect(exitCodeOf([WORKFLOW_GATE, writeWorkflow('no-publish-job', body)])).not.toBe(0);
  });

  // NEGATIVE CONTROL. Same five conditions, written as differently as GitHub
  // allows: a literal block scalar instead of a folded one, double quotes
  // instead of single, a flow mapping for `permissions`, a `${{ }}` wrapper,
  // reversed equality operands, and one conjunct in parentheses. A gate that
  // fails this is pattern-matching a formatting convention, not the semantics.
  test('ACCEPTS the same guard written with different but equivalent YAML', () => {
    const body = `
name: Release
"on":
  workflow_run:
    workflows: ["CI"]
    types: [completed]
    branches: [main]
permissions: { contents: read }
jobs:
  publish-to-npm:
    runs-on: ubuntu-latest
    if: |
      \${{ 'success' == github.event.workflow_run.conclusion
      &&   github.event.workflow_run.event == "push"
      &&   (github.event.workflow_run.head_repository.full_name == github.repository)
      &&   github.event.workflow_run.head_branch == "main"
      &&   github.sha == github.event.workflow_run.head_sha }}
    permissions: { contents: write, id-token: write, pull-requests: write }
    steps:
      - uses: actions/checkout@v7
      - run: pnpm release
        env:
          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}
`;
    expect(exitCodeOf([WORKFLOW_GATE, writeWorkflow('equivalent', body)])).toBe(0);
  });

  // A guard inherited through `needs:` is legitimate — the downstream job cannot
  // start unless the guarded one ran — and must not be reported as missing.
  test('ACCEPTS a publishing job guarded via `needs:` on a guarded job', () => {
    const body = `
name: Release
on:
  workflow_run:
    workflows: ['CI']
    types: [completed]
permissions:
  contents: read
jobs:
  gate:
    runs-on: ubuntu-latest
    if: >-
      ${GUARD}
    steps:
      - run: echo ok
  release:
    needs: [gate]
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      ${CHANGESETS_V2_STEP}
`;
    expect(exitCodeOf([WORKFLOW_GATE, writeWorkflow('needs-gate', body)])).toBe(0);
  });

  // Dependabot #16 style: pin bumped to v2, inputs left on v1 names. The action
  // ignores unknown keys, so the next publish would no-op the version/publish
  // scripts. The gate must fail closed on this, not only on missing trigger guards.
  test('REJECTS changesets/action steps still using v1 input names', () => {
    const body = `
name: Release
on:
  workflow_run:
    workflows: ['CI']
    types: [completed]
    branches: [main]
permissions:
  contents: read
jobs:
  release:
    runs-on: ubuntu-latest
    if: >-
      ${GUARD}
    permissions:
      contents: write
      id-token: write
    steps:
      - uses: changesets/action@v2
        with:
          version: pnpm version-packages
          publish: pnpm release
          title: 'chore: version packages'
          commit: 'chore: version packages'
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          NPM_TOKEN: \${{ secrets.NPM_TOKEN }}
`;
    expect(exitCodeOf([WORKFLOW_GATE, writeWorkflow('changesets-v1-inputs', body)])).not.toBe(0);
  });
});

describe('scripts/check-packed-artifacts.mjs — manifest installability', () => {
  const WORKSPACE = {
    react: '19.2.8',
    'react-dom': '19.2.8',
    '@gullabs/flipbook-core': '3.0.0',
  };
  const IMPORTS = ['react', 'react-dom', '@gullabs/flipbook-core'];

  const check = (name: string, manifest: unknown, imports: string[] = IMPORTS): number => {
    const path = `${work}/${name}.manifest.json`;
    fs.writeFileSync(
      path,
      JSON.stringify({
        name: '@gullabs/react-flipbook',
        manifest,
        imports,
        versions: WORKSPACE,
      }),
    );
    return exitCodeOf([PACKED_GATE], { FLIPBOOK_MANIFEST_SELFTEST: path });
  };

  const GOOD = {
    dependencies: { '@gullabs/flipbook-core': '3.0.0' },
    peerDependencies: { react: '>=18', 'react-dom': '>=18' },
  };

  test('the manifest actually shipped by packages/react passes', () => {
    const shipped = JSON.parse(
      fs.readFileSync(`${repoRoot}/packages/react/package.json`, 'utf8'),
    ) as { dependencies: Record<string, string>; peerDependencies: Record<string, string> };
    // `changeset publish` rewrites `workspace:*` to the concrete version, which
    // is what a consumer sees; check what they get, not what is in git.
    expect(shipped.dependencies['@gullabs/flipbook-core']).toBe('workspace:*');
    expect(
      check('shipped', {
        ...shipped,
        dependencies: { '@gullabs/flipbook-core': '3.0.0' },
      }),
    ).toBe(0);
  });

  test('a well-formed manifest passes', () => {
    expect(check('good', GOOD)).toBe(0);
  });

  test('REJECTS a manifest with no react-dom peer, which the runtime imports', () => {
    expect(check('no-react-dom', { ...GOOD, peerDependencies: { react: '>=18' } })).not.toBe(0);
  });

  test('REJECTS `react: "0"`, a valid range that admits no supported React', () => {
    expect(
      check('react-zero', { ...GOOD, peerDependencies: { react: '0', 'react-dom': '>=18' } }),
    ).not.toBe(0);
  });

  test('REJECTS a nonexistent core range like ^999.0.0', () => {
    expect(
      check('core-999', { ...GOOD, dependencies: { '@gullabs/flipbook-core': '^999.0.0' } }),
    ).not.toBe(0);
  });

  test('REJECTS a missing @gullabs/flipbook-core dependency', () => {
    expect(check('no-core', { ...GOOD, dependencies: {} })).not.toBe(0);
  });

  test('REJECTS a `workspace:*` range surviving into the packed manifest', () => {
    expect(
      check('workspace-range', {
        ...GOOD,
        dependencies: { '@gullabs/flipbook-core': 'workspace:*' },
      }),
    ).not.toBe(0);
  });

  test('REJECTS react promoted to a hard dependency', () => {
    expect(
      check('react-hard', {
        ...GOOD,
        dependencies: { ...GOOD.dependencies, react: '^19.0.0' },
      }),
    ).not.toBe(0);
  });

  test('REJECTS a declared dependency the workspace resolves no version for', () => {
    expect(
      check('unknown-dep', {
        ...GOOD,
        dependencies: { ...GOOD.dependencies, 'some-untested-pkg': '^1.0.0' },
      }),
    ).not.toBe(0);
  });

  test('REJECTS an import the manifest never declares', () => {
    expect(check('undeclared-import', GOOD, [...IMPORTS, 'scheduler'])).not.toBe(0);
  });

  // NEGATIVE CONTROL: equally valid ranges written differently must pass, or the
  // gate is asserting a house style instead of installability.
  test('ACCEPTS equivalent ranges written in other valid semver forms', () => {
    expect(
      check('equivalent-ranges', {
        dependencies: { '@gullabs/flipbook-core': '^3.0.0' },
        peerDependencies: { react: '18 || 19', 'react-dom': '>=18.0.0 <20.0.0' },
      }),
    ).toBe(0);
  });
});
