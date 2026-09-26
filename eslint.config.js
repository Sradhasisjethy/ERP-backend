const js = require('@eslint/js');
const globals = require('globals');

/**
 * ESLint 9 flat config. `npm run lint` had been failing outright since the
 * ESLint 9 upgrade because the legacy .eslintrc format is no longer read and
 * no flat config existed, so nothing was being linted at all.
 *
 * Kept to the recommended rule set plus what the codebase already does by
 * convention: CommonJS modules, Node globals in src, Jest globals in tests.
 */
module.exports = [
  {
    ignores: ['node_modules/**', 'coverage/**', 'uploads/**', 'dist/**', 'logs/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      // An unused catch binding or a `_`-prefixed argument is deliberate.
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' }],
      // Empty catch blocks are used deliberately for best-effort cleanup.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['tests/**/*.js', 'jest.config.js', 'src/**/*.test.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
    },
  },
];
