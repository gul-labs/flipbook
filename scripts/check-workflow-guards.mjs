#!/usr/bin/env node
/**
 * Statically prove that `.github/workflows/release.yml` cannot publish from a
 * fork.
 *
 * The Release workflow runs on `workflow_run`, which is the "pwn request"
 * trigger: it executes in the BASE repository with full privileges —
 * `contents: write`, and `id-token: write`, which mints the npm publish
 * credential through trusted publishing — and it fires for CI runs triggered by
 * `pull_request`, which `ci.yml` accepts from anywhere including forks.
 *
 * The `branches: [main]` filter on a `workflow_run` matches `head_branch`, and
 * for a fork PR that is the FORK's branch name. So a fork whose branch is
 * called `main` satisfies it. Without the guards below, that fork's commit is
 * checked out and built — `pnpm install --frozen-lockfile` with their lockfile,
 * `tsup` with their config — inside a job that can publish to npm.
 *
 * These conditions cannot be unit-tested: GitHub Actions does not run locally.
 * So they are asserted statically instead, and this script is wired into the
 * quality gate.
 *
 * WHY THIS IS A PARSER AND NOT A GREP
 * -----------------------------------
 * The first version of this file searched the whole workflow for four
 * substrings. An independent review (2026-08-29) showed that gate passes a
 * semantically unguarded release, because a substring can occur:
 *
 *   - inside a `#` comment (YAML never evaluates it),
 *   - on a DIFFERENT job than the one that publishes,
 *   - inside `always() || <the real condition>`, which is always true,
 *   - as a step-level `if:`, which does not stop the job from checking out and
 *     installing the attacker's commit before that step is reached.
 *
 * It also missed `permissions: write-all` (its regex only matched
 * `contents: write`) and would have failed on semantically identical YAML
 * written with a different scalar style.
 *
 * So: parse the file, find the job that actually holds the publish token, and
 * assert against THAT JOB'S OWN `if:` expression. Comments are gone before we
 * look; formatting is gone before we look; other jobs are not consulted.
 *
 * Everything here FAILS CLOSED. If the workflow cannot be parsed, if no
 * publishing job can be identified, or if a condition cannot be understood,
 * the gate exits non-zero. A gate that cannot establish its claim must not
 * report that it did.
 *
 * Usage: `node scripts/check-workflow-guards.mjs [path/to/release.yml]`
 * The optional path exists so the gate can be driven against fixture
 * workflows — see `packages/core/tests/release-gates.test.ts`, which proves it
 * rejects each of the holes listed above.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(join(root, 'package.json'));

/**
 * `yaml` is not (yet) a root devDependency; it is in the lockfile as a
 * transitive dependency of several root devDependencies, so it is always
 * installed by `pnpm install --frozen-lockfile`. Resolve it from one of those
 * hosts, and FAIL rather than fall back to string matching if it is absent.
 *
 * The clean fix is `pnpm add -Dw yaml`, which this file deliberately does not
 * make on its own — see the report accompanying this change.
 */
const requireDep = (name) => {
  try {
    return require_(name);
  } catch {
    /* fall through to the transitive hosts */
  }
  for (const host of ['@changesets/cli', 'lint-staged', 'tsup', 'eslint', 'vitest']) {
    try {
      return createRequire(require_.resolve(`${host}/package.json`))(name);
    } catch {
      /* try the next host */
    }
  }
  console.error(
    `check-workflow-guards: cannot resolve "${name}".\n` +
      `This gate needs a real parser and refuses to guess. Run: pnpm add -Dw ${name}`,
  );
  process.exit(1);
};

const YAML = requireDep('yaml');

const workflowPath = process.argv[2] ?? join(root, '.github/workflows/release.yml');

const failures = [];
const fail = (msg) => failures.push(msg);

/** Read + parse, failing closed on anything unreadable or non-mapping. */
let workflow;
try {
  // YAML 1.2 core schema (the `yaml` package default) keeps `on` a string
  // rather than resolving it to the boolean `true` the way YAML 1.1 would.
  workflow = YAML.parse(readFileSync(workflowPath, 'utf8'));
} catch (error) {
  console.error(`check-workflow-guards: ${workflowPath} is not parseable YAML:\n${String(error)}`);
  process.exit(1);
}
if (workflow === null || typeof workflow !== 'object' || Array.isArray(workflow)) {
  console.error(`check-workflow-guards: ${workflowPath} is not a workflow mapping`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Expression handling
// ---------------------------------------------------------------------------

/** Strip the optional `${{ … }}` wrapper GitHub allows around a job `if:`. */
const unwrapExpression = (raw) => {
  const s = String(raw).trim();
  const m = /^\$\{\{([\s\S]*)\}\}$/.exec(s);
  return (m ? m[1] : s).trim();
};

/** True when `s` has balanced parens AND the outermost pair wraps everything. */
const wrappedInParens = (s) => {
  if (!s.startsWith('(') || !s.endsWith(')')) return false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i === s.length - 1;
    }
  }
  return false;
};

/**
 * Split on `&&` at paren depth 0 and outside string literals. Anything the
 * splitter cannot account for stays in one piece and simply fails to match a
 * required conjunct, which fails the gate — never the other way round.
 */
const splitConjuncts = (expr) => {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (quote !== null) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && c === '&' && expr[i + 1] === '&') {
      parts.push(expr.slice(start, i));
      i++;
      start = i + 1;
    }
  }
  parts.push(expr.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
};

/**
 * Canonicalise one conjunct so that semantically identical GitHub expressions
 * compare equal: outer parens dropped, double quotes rewritten as single,
 * whitespace collapsed, and the operands of a single top-level `==` sorted so
 * `a == b` and `b == a` agree.
 *
 * This is what makes the gate strict without being brittle: a maintainer may
 * reformat, requote, or flip an equality and the gate still passes; they may
 * not weaken it.
 */
const canonicalConjunct = (part) => {
  let s = part.trim();
  while (wrappedInParens(s)) s = s.slice(1, -1).trim();
  s = s.replace(/"([^"\\]*)"/g, "'$1'");
  s = s.replace(/\s+/g, ' ').trim();
  const eq = s.split('==');
  if (eq.length === 2) {
    const [a, b] = eq.map((side) => side.trim());
    return [a, b].sort().join(' == ');
  }
  return s;
};

const REQUIRED = [
  ["github.event.workflow_run.conclusion == 'success'", 'CI must have passed'],
  [
    "github.event.workflow_run.event == 'push'",
    'THE load-bearing one: a pull_request-triggered CI run must never reach the publish job',
  ],
  [
    'github.event.workflow_run.head_repository.full_name == github.repository',
    'the commit must come from this repository, not a fork',
  ],
  ["github.event.workflow_run.head_branch == 'main'", 'and from main specifically'],
  [
    'github.event.workflow_run.head_sha == github.sha',
    'the commit the job checks out and builds (head_sha) must be the commit the run is ' +
      'attributed to: for workflow_run, GITHUB_SHA is the "Last commit on default branch", ' +
      'and that is the source commit a provenance attestation names',
  ],
];
const REQUIRED_CANONICAL = REQUIRED.map(([expr, why]) => [canonicalConjunct(expr), expr, why]);

// ---------------------------------------------------------------------------
// Locate the publishing job
// ---------------------------------------------------------------------------

const jobs = workflow.jobs;
if (jobs === null || typeof jobs !== 'object' || Array.isArray(jobs)) {
  console.error(`check-workflow-guards: ${workflowPath} declares no \`jobs:\` mapping`);
  process.exit(1);
}

/**
 * A job is "publishing" if anything in it reaches for the npm token or runs the
 * publish command. Matching on the job's own serialised content — not the whole
 * file — is what stops a guard on some other job from counting.
 */
const PUBLISH_MARKERS = /changesets\/action|changeset publish|pnpm release|NPM_TOKEN/;
const publishingJobIds = Object.entries(jobs)
  .filter(([, job]) => PUBLISH_MARKERS.test(JSON.stringify(job ?? null)))
  .map(([id]) => id);

if (publishingJobIds.length === 0) {
  console.error(
    `check-workflow-guards: no job in ${workflowPath} looks like the publishing job\n` +
      '(nothing references changesets/action, `changeset publish`, `pnpm release`, or NPM_TOKEN).\n' +
      'This gate cannot establish its claim, so it fails rather than reporting success.',
  );
  process.exit(1);
}

// The trigger has to still be the one the five guards were derived for. If the
// workflow moves to `on: push`, these particular conditions are the wrong
// question and the gate must be re-derived rather than silently pass.
const on = workflow.on ?? workflow[true];
const hasWorkflowRun =
  on !== null &&
  (on === 'workflow_run' ||
    (Array.isArray(on) && on.includes('workflow_run')) ||
    (typeof on === 'object' && !Array.isArray(on) && 'workflow_run' in on));
if (!hasWorkflowRun) {
  fail(
    'release.yml no longer triggers on `workflow_run`. The five guards this gate ' +
      'asserts are specific to that trigger; re-derive them before removing it.',
  );
}

// ---------------------------------------------------------------------------
// Assert the guard on the publishing job itself
// ---------------------------------------------------------------------------

/** Every job whose `if:` gates this one: itself, plus everything it `needs:`. */
const gatingJobIds = (id, seen = new Set()) => {
  if (seen.has(id)) return seen;
  seen.add(id);
  const job = jobs[id];
  const needs = job?.needs;
  for (const n of typeof needs === 'string' ? [needs] : Array.isArray(needs) ? needs : []) {
    if (typeof n === 'string' && n in jobs) gatingJobIds(n, seen);
  }
  return seen;
};

for (const jobId of publishingJobIds) {
  const gating = [...gatingJobIds(jobId)];
  const satisfied = new Set();
  let sawUsableCondition = false;

  for (const id of gating) {
    const raw = jobs[id]?.if;
    if (raw === undefined || raw === null) continue;
    if (typeof raw === 'boolean') {
      fail(
        `job "${id}": \`if: ${String(raw)}\` is a constant, not a guard — a publishing job must be conditional`,
      );
      continue;
    }
    const expr = unwrapExpression(raw);

    // A single `||` anywhere makes the whole condition satisfiable without the
    // conjuncts below: `always() || <real condition>` and `<real condition> ||
    // true` both publish unconditionally. There is no legitimate use for a
    // disjunction in this guard, so any occurrence is fatal.
    if (expr.includes('||')) {
      fail(
        `job "${id}": its \`if:\` contains \`||\`, so the guard can be short-circuited ` +
          `(\`always() || …\` and \`… || true\` are both always true). Use a pure \`&&\` chain.\n` +
          `           condition: ${expr}`,
      );
      continue;
    }

    sawUsableCondition = true;
    for (const c of splitConjuncts(expr)) satisfied.add(canonicalConjunct(c));
  }

  if (!sawUsableCondition) {
    fail(
      `job "${jobId}" holds the publish token and has no usable \`if:\` on itself or on any ` +
        'job it `needs:`. A step-level `if:` does not count: the job still checks out and ' +
        "installs the attacker's commit before that step is reached.",
    );
  }

  for (const [canonical, expr, why] of REQUIRED_CANONICAL) {
    if (!satisfied.has(canonical)) {
      fail(
        `job "${jobId}" is not guarded by: ${expr}\n           ${why}\n` +
          `           (it must be a top-level \`&&\` conjunct of that job's own \`if:\`, ` +
          'or of a job it `needs:` — not a comment, not another job, not a step)',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/**
 * Returns the list of write grants a `permissions:` value confers.
 * `write-all` is a single scalar and grants everything — the shape the previous
 * regex could not see at all.
 */
const writeGrants = (permissions) => {
  if (permissions === undefined || permissions === null) return null; // "not declared"
  if (typeof permissions === 'string') return permissions === 'write-all' ? ['write-all'] : [];
  if (typeof permissions !== 'object' || Array.isArray(permissions)) return ['<unparseable>'];
  return Object.entries(permissions)
    .filter(([, v]) => String(v) === 'write')
    .map(([k]) => k);
};

const topLevel = writeGrants(workflow.permissions);
if (topLevel === null) {
  fail(
    'release.yml declares no workflow-level `permissions:`. Without it every job inherits the ' +
      'repository default token scope. Declare `permissions: contents: read` at the top and ' +
      'elevate per job.',
  );
} else if (topLevel.length > 0) {
  fail(
    `release.yml grants ${topLevel.join(', ')} at WORKFLOW level. That grants it to every job ` +
      'added to this file later. Keep elevated permissions on the job that needs them.',
  );
}

for (const jobId of publishingJobIds) {
  if (jobs[jobId]?.permissions === 'write-all') {
    fail(
      `job "${jobId}": \`permissions: write-all\` gives the publish job every scope in the ` +
        'repository. List only the scopes it needs (contents / pull-requests / id-token).',
    );
  }
}

// ---------------------------------------------------------------------------
// changesets/action@v2 input contract
// ---------------------------------------------------------------------------
//
// v2 renamed the root inputs and stopped reading GITHUB_TOKEN from the
// environment. A Dependabot pin bump that leaves the v1 names is a silent
// publish break (the action ignores unknown inputs). Assert the live contract
// whenever a step uses changesets/action.

const CHANGESSETS_V1_INPUTS = new Set(['version', 'publish', 'commit', 'title', 'branch']);
const CHANGESSETS_V2_REQUIRED = ['version-script', 'publish-script', 'github-token'];

for (const jobId of publishingJobIds) {
  const steps = jobs[jobId]?.steps;
  if (!Array.isArray(steps)) continue;
  for (const [i, step] of steps.entries()) {
    const uses = typeof step?.uses === 'string' ? step.uses : '';
    if (!uses.startsWith('changesets/action@')) continue;

    const withBlock =
      step.with !== null && typeof step.with === 'object' && !Array.isArray(step.with)
        ? step.with
        : {};
    const keys = Object.keys(withBlock);
    const stepLabel = `job "${jobId}" step ${String(i)} (${uses})`;

    for (const key of keys) {
      if (CHANGESSETS_V1_INPUTS.has(key)) {
        fail(
          `${stepLabel}: still uses changesets/action v1 input \`${key}\`. ` +
            'v2 renamed these (version→version-script, publish→publish-script, ' +
            'commit→commit-message, title→pr-title, branch→pr-base-branch).',
        );
      }
    }

    for (const required of CHANGESSETS_V2_REQUIRED) {
      if (!(required in withBlock) || withBlock[required] === '' || withBlock[required] == null) {
        fail(
          `${stepLabel}: missing required changesets/action@v2 input \`${required}\`. ` +
            'github-token must be an explicit input — the action no longer reads GITHUB_TOKEN from env.',
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`Release workflow guard check FAILED (${workflowPath}):\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  console.error(
    'Without the first four conditions on the publishing job, a fork PR whose branch is\n' +
      'named `main` can reach a job holding publish credentials and contents: write, and\n' +
      'publish arbitrary code as @gullabs/*. Without the fifth, a stale run builds an older\n' +
      'commit than the one its provenance names. See the comment above the `if:` in release.yml.',
  );
  process.exit(1);
}

console.log(
  `release workflow: publishing job(s) ${publishingJobIds.map((j) => `"${j}"`).join(', ')} ` +
    `guarded by all ${String(REQUIRED.length)} trigger conditions, permissions job-scoped`,
);
