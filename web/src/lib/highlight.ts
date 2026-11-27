// Syntax colours for code in tool calls & the host file viewer: Shiki with its
// JavaScript regex engine (no WASM), running in a dedicated Web Worker in the
// browser so tokenizing 200+ line files never blocks the main thread during
// transitions, with an in-memory LRU cache and main-thread fallback for tests.
import { hasGrammar, highlightLinesCore } from './highlight-core'
import type { Token } from './highlight-core'

export type { Token }

const BY_EXT: Partial<Record<string, string>> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  go: 'go',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  lua: 'lua',
  py: 'python',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  md: 'markdown',
  mdx: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  cs: 'csharp',
  toml: 'toml',
  html: 'html',
  ps1: 'powershell',
  rs: 'rust',
  sql: 'sql',
}

/** the grammar for a file path, or null (plain text) */
export function langOf(file?: string): string | null {
  const ext = file?.split('/').at(-1)?.split('.').at(-1)?.toLowerCase()
  return (ext && BY_EXT[ext]) || null
}

const MAX_CACHE = 64
const tokenCache = new Map<string, Array<Array<Token>>>()

function readCache(key: string): Array<Array<Token>> | undefined {
  const hit = tokenCache.get(key)
  if (!hit) return undefined
  tokenCache.delete(key)
  tokenCache.set(key, hit)
  return hit
}

function writeCache(key: string, value: Array<Array<Token>>) {
  if (tokenCache.size >= MAX_CACHE) {
    const oldest = tokenCache.keys().next().value
    if (oldest !== undefined) tokenCache.delete(oldest)
  }
  tokenCache.set(key, value)
}

type PendingJob = {
  resolve: (tokens: Array<Array<Token>> | null) => void
}

let worker: Worker | null = null
let workerBroken = false
let nextJobId = 1
const pendingJobs = new Map<number, PendingJob>()

function ensureWorker(): Worker | null {
  if (workerBroken || typeof Worker === 'undefined') return null
  if (worker) return worker
  try {
    const w = new Worker(new URL('./highlight.worker.ts', import.meta.url), {
      type: 'module',
    })
    w.addEventListener(
      'message',
      (
        ev: MessageEvent<{ id: number; tokens: Array<Array<Token>> | null }>,
      ) => {
        const job = pendingJobs.get(ev.data.id)
        if (!job) return
        pendingJobs.delete(ev.data.id)
        job.resolve(ev.data.tokens)
      },
    )
    w.addEventListener('error', () => {
      workerBroken = true
      worker = null
      for (const [, job] of pendingJobs) job.resolve(null)
      pendingJobs.clear()
    })
    worker = w
    return w
  } catch {
    workerBroken = true
    return null
  }
}

/**
 * Tokens per line for `lines` in `lang`, or null when the language is not
 * known or loading failed (the caller keeps plain text). Lines are coloured
 * together, so a construct spanning lines (a comment, a template string)
 * keeps its colour.
 */
export async function highlightLines(
  lines: Array<string>,
  lang: string,
): Promise<Array<Array<Token>> | null> {
  if (!hasGrammar(lang)) return null
  const cacheKey = `${lang}\0${lines.join('\n')}`
  const cached = readCache(cacheKey)
  if (cached) return cached

  const w = ensureWorker()
  let result: Array<Array<Token>> | null = null
  if (w) {
    const id = nextJobId++
    result = await new Promise<Array<Array<Token>> | null>((resolve) => {
      pendingJobs.set(id, { resolve })
      w.postMessage({ id, lines, lang })
    })
  }
  if (!result) {
    result = await highlightLinesCore(lines, lang)
  }
  if (result) writeCache(cacheKey, result)
  return result
}
