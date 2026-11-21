//  @ts-check

import { tanstackConfig } from '@tanstack/eslint-config'
import pluginLingui from 'eslint-plugin-lingui'

export default [
  pluginLingui.configs['flat/recommended'],
  ...tanstackConfig,
  {
    rules: {
      'import/no-cycle': 'off',
      'import/order': 'off',
      'sort-imports': 'off',
      '@typescript-eslint/array-type': 'off',
      '@typescript-eslint/require-await': 'off',
      'max-lines': [
        'error',
        { max: 500, skipBlankLines: true, skipComments: true },
      ],
      'max-lines-per-function': [
        'error',
        { max: 220, skipBlankLines: true, skipComments: true },
      ],
      'pnpm/json-enforce-catalog': 'off',
    },
  },
  {
    // Worker code type-checks against workers-types (tsconfig.worker.json).
    files: ['src/server.ts', 'src/relay/**/*.ts'],
    languageOptions: {
      parserOptions: { project: './tsconfig.worker.json' },
    },
  },
  {
    ignores: [
      'eslint.config.js',
      'prettier.config.js',
      '.output/**',
      'node_modules/**',
      // plain service-worker script, not part of the TS project
      'public/sw.js',
    ],
  },
]
