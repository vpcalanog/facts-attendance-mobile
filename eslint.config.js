// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

// Flat config ignores `/* eslint-env jest */` comments, so the test
// globals are declared here instead.
const jestGlobals = {
  jest: 'readonly',
  describe: 'readonly',
  it: 'readonly',
  test: 'readonly',
  expect: 'readonly',
  beforeEach: 'readonly',
  afterEach: 'readonly',
  beforeAll: 'readonly',
  afterAll: 'readonly',
};

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', '.expo/*'],
  },
  {
    files: ['__tests__/**/*.{ts,tsx}', 'jest.setup.js'],
    languageOptions: {
      globals: jestGlobals,
    },
    rules: {
      // jest.mock() calls are hoisted and must be declared before the
      // imports of the modules they replace, so this rule can't apply.
      'import/first': 'off',
      // Modules are re-required after jest.resetModules() to get fresh
      // state (a new database, a new secure store), which import can't do.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
]);
