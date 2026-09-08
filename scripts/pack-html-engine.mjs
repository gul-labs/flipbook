import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'packages/core/dist');
const outDir = join(root, 'packages/core/size-check');
mkdirSync(outDir, { recursive: true });

const files = readdirSync(dist)
  .filter((f) => f.endsWith('.js') && !f.endsWith('.map') && f !== 'html-engine.js')
  .sort();

// Concatenate the already-terser'd ESM chunks.
// A full esbuild re-bundle of minified ESM expands identifiers (`i`→`i2`)
// and is a net loss — measured 2026-08-28.
let body = files.map((f) => readFileSync(join(dist, f), 'utf8')).join('\n');

// Drop static cross-chunk import/re-export glue. After concatenation the
// bindings already live in the same text; consumers' bundlers erase this
// linkage, so counting it inflated the size-check.
body = body
  .replace(/import\s*\{[^}]*\}\s*from\s*["']\.\/chunk-[^"']+["'];?/g, '')
  .replace(/export\s*\{[^}]*\}\s*from\s*["']\.\/chunk-[^"']+["'];?/g, '')
  // Source-map comments are not shipped in the size budget payload.
  .replace(/\/\/# sourceMappingURL=[^\n]*/g, '');

// Canvas mode was removed (ADR 0002). A leaked canvas renderer would still
// show up as `getContext` in the eager graph — refuse that regression.
if (body.includes('getContext')) {
  console.error(
    'Canvas renderer code leaked into the eager HTML engine graph (found\n' +
      '`getContext`). Canvas mode was removed; nothing should acquire a 2d\n' +
      'context from this package.',
  );
  process.exit(1);
}

if (/import\(\s*["']\.\/canvas-loader-/.test(body) || body.includes('canvas-loader')) {
  console.error(
    'Canvas loader remnants found in the packed HTML engine. Canvas mode was\n' +
      'removed (ADR 0002); the dynamic import and chunk must be gone.',
  );
  process.exit(1);
}

// The `updateSettings` refusal warning has to survive minification. It is the
// only signal a consumer gets that a construction-time setting was ignored —
// the value is refused, `getSettings()` honestly reports the old one, and
// without this line nothing says why. Terser's `drop_console: true` removed it
// from every published build, so the diagnostic existed in development only.
//
// Asserted on the packed output rather than trusted to the config, because the
// config LOOKED correct while being wrong: `drop_console: { exclude: ['warn'] }`
// is esbuild's option shape, and terser coerces the object to truthy and drops
// everything. Nothing failed; the warning simply was not there.
// Matched on the DIAGNOSTIC TEXT, not on `console.warn`. Any future eager
// `console.warn` anywhere in the engine would satisfy a bare method check while
// this exact warning had silently disappeared — the assertion would then be
// guarding the presence of console calls in general, which is not the property
// anyone cares about.
const REFUSAL_WARNING = 'updateSettings ignored construction-time setting';

if (!body.includes(REFUSAL_WARNING)) {
  console.error(
    'The updateSettings refusal warning did not survive minification.\n' +
      "Terser's `drop_console` takes a LIST of console methods to REMOVE;\n" +
      "`true`, or esbuild's `{ exclude: [...] }` object, strips every one of\n" +
      'them — including the only diagnostic a consumer gets for a setting the\n' +
      `engine refused. Looked for: ${JSON.stringify(REFUSAL_WARNING)}.\n` +
      'See packages/core/tsup.config.ts.',
  );
  process.exit(1);
}

const out = join(outDir, 'html-engine.js');
writeFileSync(out, body);
const bytes = Buffer.byteLength(body);
console.log(`html-engine.js ${files.join('+')} ${bytes} B (${(bytes / 1000).toFixed(2)} kB)`);

// Raw bytes track parse/compile cost and catch gross drift. Transfer size is
// enforced separately by `size-limit`. Measured 2026-08-30 after canvas removal
// (ADR 0002): 56_207 B raw / 13.78 kB brotli / 15.43 kB gzip. Ceilings set
// tight to that: 57 kB / 14 kB / 16 kB. Units: size-limit "kB" is decimal (1000).
// Raised 57_000 -> 62_000 by the OWNER for the code-complete round, alongside
// the size-limit ceilings in packages/core/package.json. Both numbers exist and
// both must move together; a mismatch fails the build with the other one's text,
// which is how this was found. See docs/ROUND-CODE-COMPLETE.md.
// 62_000 held post-B3.1 (measured 61_761 B). B3.2 delta-clear + copyOwner
// B3.2 ~62.62 kB; B3.3–B3.4 elision helpers → 62_754 B. Ceiling 63_000 with
// size-limit twins 63 / 15.5 / 17.4 kB.
// PLAN-3.1 Campaign C (`turnProgress` event): measured 63_337 B raw /
// 15.54 kB brotli / 17.57 kB gzip — feature may spend headroom (AGENTS.md §2).
// Ceiling 63_500 with size-limit twins 63.5 / 15.6 / 17.6 kB.
// F03 mid-turn resize cancel + F05 `cancelTurn`: measured 63_891 B raw /
// 15.69 kB brotli / 17.68 kB gzip. Correctness + public API, AGENTS.md §2.
// Destroy-guard on Render.update (reentrancy): 63_930 B. Ceiling 64_000
// with size-limit twins 64 / 15.7 / 17.7 kB.
// Adopt orientation before nested flipNext (portrait step): 64_065 B.
// Ceiling 64_200 with size-limit twins 64.2 / 15.8 / 17.8 kB.
// 2026-09-08 audit: f91a654 clean build was 65_650 B, not the claimed 64.16 kB.
// Rebase/restyle before cancellation adds 196 B (65_846 / 16_018 / 18_127 B).
// Owner approved 66 / 16.1 / 18.2 kB ceilings in the audit conversation.
const RAW_ALARM_BYTES = 66_000;

if (bytes > RAW_ALARM_BYTES) {
  console.error(
    `HTML engine raw size ${bytes} B exceeds the ${RAW_ALARM_BYTES} B ceiling.\n` +
      'This fails the build. Find out WHY it grew before deciding what to do:\n' +
      'a correctness fix or a feature may take the room, with an owner-approved\n' +
      'ceiling raise that says what was added. Deleting a public helper or\n' +
      'golfing identifiers to buy back bytes is the wrong trade (AGENTS.md §2).',
  );
  process.exit(1);
}
