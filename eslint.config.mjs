import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactPlugin from 'eslint-plugin-react';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/** Typed package + example sources — type-aware rules run here. */
// LINT-003 (craft-audit). The TEST SUITE is type-checked by these rules too.
//
// It used to sit in `nonTypedTsFiles`, so every type-aware rule — including
// `@typescript-eslint/no-floating-promises`, which is an `error` below — was
// silently off for every test, every e2e spec and every fixture. That is not a
// style gap. A floating promise in a test is an assertion that never runs: the
// test finishes, the promise settles afterwards, and it reports green whatever
// the code does. This repo has caught TWELVE tests that passed against broken
// code by hand; this is the automated form of the same failure, and it was
// unguarded in the one place it matters most.
//
// Costs a slower lint (the tests join the typed program). Measured at zero
// existing violations, so it is free today and only ever refuses new ones.
const typedFiles = [
  'packages/*/src/**/*.{ts,tsx}',
  'packages/*/tests/**/*.{ts,tsx}',
  'e2e/**/*.{ts,tsx}',
  'examples/**/*.{ts,tsx}',
];

const nonTypedTsFiles = [
  'fixtures/**/*.{ts,tsx}',
  'scripts/**/*.{ts,mjs,js}',
  'vitest.config.ts',
  'playwright.config.ts',
  'eslint.config.mjs',
  'examples/**/vite.config.ts',
  'examples/**/next.config.mjs',
];

const nonTypedJsFiles = ['**/*.{js,mjs,cjs}'];

/** Block focused tests from landing. */
const focusGuards = [
  'error',
  {
    object: 'describe',
    property: 'only',
    message: 'Do not commit describe.only — it skips the rest of the suite.',
  },
  {
    object: 'it',
    property: 'only',
    message: 'Do not commit it.only — it skips the rest of the suite.',
  },
  {
    object: 'test',
    property: 'only',
    message: 'Do not commit test.only — it skips the rest of the suite.',
  },
];

/** Shared non-type-aware hygiene, slimmed for a library. */
const hygieneRules = {
  curly: 'error',
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-console': ['warn', { allow: ['warn', 'error'] }],
  'no-debugger': 'error',
  'no-alert': 'error',
  'prefer-const': 'error',
  'no-var': 'error',
  'object-shorthand': 'error',
  'prefer-template': 'error',
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
  'no-script-url': 'error',
  'no-restricted-properties': focusGuards,
  '@typescript-eslint/no-unused-vars': [
    'error',
    {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
    },
  ],
};

function scopeTypedConfigs(configs) {
  return configs.map((config) => ({
    ...config,
    files: typedFiles,
    ignores: nonTypedTsFiles,
  }));
}

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/.next/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '.craftsman/**',
      '.remember/**',
      '.claude/**',
      'fixtures/**',
      'examples/**/dist/**',
      'examples/**/.next/**',
      'packages/**/size-check/**',
    ],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },
  {
    files: nonTypedJsFiles,
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  ...scopeTypedConfigs(tseslint.configs.recommendedTypeChecked),
  {
    files: typedFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      react: reactPlugin,
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...hygieneRules,
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      // Phase C (docs/QUALITY.md): honest after NUIA + lifecycle guards.
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/strict-boolean-expressions': [
        'error',
        {
          allowString: true,
          allowNumber: true,
          allowNullableObject: true,
          allowNullableBoolean: false,
          allowNullableString: false,
          allowNullableNumber: false,
          allowAny: false,
        },
      ],
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/require-await': 'warn',
      // Phase A (docs/QUALITY.md): block any-leakage at error.
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'react/jsx-no-leaked-render': 'error',
    },
  },
  {
    // Test code joins the TYPED program (LINT-003) but keeps the relaxations
    // that make tests readable: `!` on a fixture lookup and `any` in a stub are
    // noise to forbid here, and forbidding them buys nothing. What it gains is
    // every type-AWARE rule, `no-floating-promises` above all.
    files: ['packages/*/tests/**/*.{ts,tsx}', 'e2e/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
      '@typescript-eslint/unbound-method': 'off',

      // The two type-aware rules that are NOISE in a test and signal in source.
      // A test defends against its own fixture drifting — a `?? fallback` on a
      // value the types currently say is non-nullable is how a fixture change
      // gets caught instead of crashing, and an "unnecessary" assertion is
      // often documenting what the test believes. Neither can make an assertion
      // silently not run, which is the bar for keeping a rule here.
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',

      // Off for a specific reason: a test's job includes feature-DETECTING the
      // environment it runs in. `if (!HTMLElement.prototype.setPointerCapture)`
      // is correct and necessary — jsdom lacks it — while the DOM lib types it
      // as always present, so the rule calls a real runtime guard impossible.
      '@typescript-eslint/strict-boolean-expressions': 'off',
      // An `async () => {}` with no `await` is idiomatic in testing-library
      // callbacks and cannot cause a missed assertion.
      '@typescript-eslint/require-await': 'off',

      // KEPT, deliberately — these are the ones that decide whether a test
      // asserts anything at all:
      //   no-floating-promises   an un-awaited assertion never runs
      //   await-thenable         awaiting a non-promise hides a sync bug
      //   no-misused-promises    an async callback where none is expected
    },
  },
  {
    files: nonTypedTsFiles,
    extends: [tseslint.configs.recommended, tseslint.configs.disableTypeChecked],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: false },
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      ...hygieneRules,
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },

  {
    files: ['scripts/**/*.{mjs,js,ts}'],
    rules: {
      'no-console': 'off',
    },
  },
  eslintConfigPrettier,

  {
    files: ['packages/react/src/**/*.{tsx,jsx}', 'examples/**/*.{tsx,jsx}'],
    plugins: { 'jsx-a11y': jsxA11y },
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
    },
  },
);
