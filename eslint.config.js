import js from '@eslint/js';
import globals from 'globals';
import prettierConfig from 'eslint-config-prettier';

export default [
  {
    ignores: [
      'node_modules/**',
      'web/**',
      'fixture/node_modules/**',
      'fixture/billing-api/node_modules/**',
      '.oubliette/**',
      'coverage/**',
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  prettierConfig,
];
