import { defineConfig } from '@lingui/cli'

export default defineConfig({
  sourceLocale: 'en',
  locales: ['en', 'zh'],
  catalogs: [{ path: 'src/locales/{locale}/messages', include: ['src'] }],
})
