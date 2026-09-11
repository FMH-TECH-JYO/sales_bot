// eslint.config.js
//
// There was no linter at all before this. Two rules below are not style
// preferences but bug detectors that would have caught real defects in this
// repo:
//
//   * no-unused-vars catches an import or a variable that was renamed on one
//     side of an edit and not the other — the shape of the bug where a tag
//     hint was computed and never appended.
//   * no-undef catches a typo'd identifier in a file that is never exercised
//     by a test, which in a CommonWJS/JSX codebase is otherwise found at runtime
//     by a user.
//
// Formatting rules are deliberately absent. Arguing about semicolons in a
// review is a waste of everyone's time, and a linter that mostly emits style
// complaints trains people to ignore it — at which point it stops catching the
// two things above.

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'web/dist/**',
      'db/.backups/**',
      'server/uploads/**',
      '**/*.min.js',
    ],
  },

  js.configs.recommended,

  // --- Node: server, db scripts, config ---
  {
    files: ['server/**/*.js', 'db/**/*.js', 'config/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      // Express identifies error-handling middleware by its arity, so the
      // trailing `next` MUST be declared even though it is not called.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_|^next$', caughtErrors: 'none' }],
      'no-console': 'off',        // this is a server; logs are the observability story
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'warn',
      // `await` inside a loop is usually a performance smell, but the matching
      // pipeline is deliberately sequential in places. Warn, do not error.
      'require-atomic-updates': 'warn',
    },
  },

  // --- Node test files ---
  {
    files: ['server/test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },

  // --- Browser E2E ---
  // Node code that ALSO contains browser code: the callbacks passed to
  // page.evaluate() are serialised and run inside Chromium, so `document`,
  // `window` and `localStorage` are legitimately in scope there even though
  // the file itself runs under Node. Both global sets are declared rather than
  // sprinkling eslint-disable comments through the file.
  {
    files: ['e2e/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  // --- Browser: the React app ---
  {
    files: ['web/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    rules: {
      // Without a React plugin, the base rule cannot see that JSX uses the
      // component identifiers it flags, so component-shaped names are exempt.
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-undef': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
    },
  },
];
