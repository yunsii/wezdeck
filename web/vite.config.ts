import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import babel from '@rolldown/plugin-babel'
import lingui, { linguiTransformerBabelPreset } from '@lingui/vite-plugin'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'

function git(command: string, fallback: string) {
  try {
    return execSync(command, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return fallback
  }
}

// Build id = commit + build time, so a redeploy of the same commit still
// offers the update. The query-cache buster only changes with the data
// contract, so frontend-only deploys keep the persisted tickets.
// One build evaluates this config several times (client, ssr / worker
// environments); each evaluation used to take its own Date.now(), so the id
// baked into the client differed from /build.json and every update check
// said "new version". Memoize it in the process env so all agree.
const buildId =
  (process.env.WEZDECK_BUILD_ID ??= `${git('git rev-parse --short HEAD', 'dev')}-${Date.now().toString(36)}`)
const cacheBuster = createHash('sha256')
  .update(readFileSync('src/lib/runtime-contract.ts'))
  .digest('hex')
  .slice(0, 12)

/** After the client build: /build.json (update check) and /precache.json (service worker). */
function pwaBuildInfo(): Plugin {
  return {
    name: 'wezdeck-pwa-build-info',
    apply: 'build',
    writeBundle(options) {
      if (this.environment.name !== 'client' || !options.dir) return
      const assets = readdirSync(join(options.dir, 'assets'))
        .filter((name) => /\.(js|css|png|svg|webp)$/.test(name))
        .map((name) => `/assets/${name}`)
      // fail the build rather than ship an update check that never settles
      const baked = assets.some((url) =>
        readFileSync(join(options.dir ?? '', url)).includes(buildId),
      )
      if (!baked)
        this.error(
          `build id ${buildId} is not in the client bundle: /build.json would never match it`,
        )
      writeFileSync(
        join(options.dir, 'build.json'),
        JSON.stringify({ buildId, builtAt: new Date().toISOString() }),
      )
      writeFileSync(
        join(options.dir, 'precache.json'),
        JSON.stringify({ buildId, assets }),
      )
    },
  }
}

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
    __CACHE_BUSTER__: JSON.stringify(cacheBuster),
  },
  plugins: [
    devtools(),
    lingui(),
    babel({ presets: [linguiTransformerBabelPreset()] }),
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
    pwaBuildInfo(),
  ],
})

export default config
