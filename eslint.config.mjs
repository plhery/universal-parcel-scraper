import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const unsafe = ['assignment', 'member-access', 'call', 'return', 'argument'].map(name => `@typescript-eslint/no-unsafe-${name}`);

// Violations that predate these rules are listed in eslint-suppressions.json; new code has none.
// After fixing some, `npx eslint . --prune-suppressions` drops their entries.
export default defineConfig(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'generated/**', '.private/**'] },
  { files: ['**/*.ts', '**/*.mjs'], extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      'no-restricted-imports': ['error', { paths: ['server-only', 'next', 'react'], patterns: ['@/*', '@carriers/*', '**/delivery-tracker/**'] }],
      // A comment between two labels that share one outcome is not a fallthrough.
      'no-fallthrough': ['error', { allowEmptyCase: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // An abort reason is the caller's own value, passed on as it is.
      '@typescript-eslint/prefer-promise-reject-errors': ['error', { allowThrowingAny: true, allowThrowingUnknown: true }],
    } },
  // Scripts are outside the TypeScript project: syntax rules only.
  { files: ['**/*.mjs'], extends: [tseslint.configs.disableTypeChecked], languageOptions: { globals: globals.node } },
  { files: ['trawl/**/*.mjs'], languageOptions: { globals: globals.browser } },
  // Tests read fixtures, captured requests and mocks as loose JSON.
  { files: ['**/*.test.ts'], rules: {
    ...Object.fromEntries(unsafe.map(rule => [rule, 'off'])),
    '@typescript-eslint/no-base-to-string': 'off',
    '@typescript-eslint/require-await': 'off',
    '@typescript-eslint/unbound-method': 'off',
  } },
);
