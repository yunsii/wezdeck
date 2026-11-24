import { defineConfig } from '@lingui/cli'
import { createSwcExtractor } from 'lingui-swc'

export default defineConfig({
  sourceLocale: 'en',
  locales: ['en', 'zh'],
  catalogs: [{ path: 'src/locales/{locale}/messages', include: ['src'] }],
  // SWC instead of the default Babel extractor (as ai-video-collection does)
  extractors: [createSwcExtractor()],
})
