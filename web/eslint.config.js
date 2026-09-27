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
    ignores: [
      'eslint.config.js',
      'prettier.config.js',
      '.output/**',
      'node_modules/**',
    ],
  },
]
