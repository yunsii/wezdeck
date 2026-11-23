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
    // UI rule: controls come from #/components/ui (Base UI underneath), never
    // a bare native element — one look, focus ring, disabled state and
    // touch size everywhere. components/ is where the natives live.
    files: ['src/**/*.tsx'],
    ignores: ['src/components/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'JSXOpeningElement[name.name=/^(button|input|select|textarea|details|summary)$/]',
          message:
            'Use the #/components/ui control (Button, Input, Select, Textarea, Checkbox, Disclosure) instead of a native element.',
        },
      ],
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
