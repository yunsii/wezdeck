import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import babel from '@rolldown/plugin-babel'
import lingui, { linguiTransformerBabelPreset } from '@lingui/vite-plugin'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    lingui(),
    babel({ presets: [linguiTransformerBabelPreset()] }),
    nitro(),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
