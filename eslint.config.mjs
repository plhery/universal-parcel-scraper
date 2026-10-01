import parser from '@typescript-eslint/parser';
export default [
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'generated/**'] },
  { files: ['**/*.ts', '**/*.mjs'], languageOptions: { parser, ecmaVersion: 'latest', sourceType: 'module' }, rules: {
    'no-restricted-imports': ['error', { paths: ['server-only', 'next', 'react'], patterns: ['@/*', '@carriers/*', '**/delivery-tracker/**'] }],
  } },
];
