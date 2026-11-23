// Syntax colours for code in tool calls (diffs, written files): shiki with
// its JavaScript regex engine (no WASM), loaded on first use — the core, the
// two GitHub themes and only the grammar a file needs, each its own chunk.
// Colours come back as --shiki-light / --shiki-dark per token; styles/code.css
// picks one by the page theme (.code-token).
import type { HighlighterCore } from 'shiki/core'

type Loader = () => Promise<unknown>

const GRAMMARS: Partial<Record<string, Loader>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
}

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

let core: Promise<HighlighterCore> | null = null
const loaded = new Map<string, Promise<void>>()

function highlighter() {
  core ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] =
      await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
      ])
    return createHighlighterCore({
      themes: [
        import('shiki/themes/github-light.mjs'),
        import('shiki/themes/github-dark.mjs'),
      ],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    })
  })()
  return core
}

/** style: the shiki CSS variables (--shiki-light, --shiki-dark, …) */
export type Token = { content: string; style?: Record<string, string> }

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
  const grammar = GRAMMARS[lang]
  if (!grammar) return null
  try {
    const shiki = await highlighter()
    let ready = loaded.get(lang)
    if (!ready) {
      ready = grammar().then((mod) =>
        shiki.loadLanguage((mod as { default: never }).default),
      )
      loaded.set(lang, ready)
    }
    await ready
    const { tokens } = shiki.codeToTokens(lines.join('\n'), {
      lang,
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false,
    })
    return tokens.map((line) =>
      line.map((token) => ({
        content: token.content,
        style: token.htmlStyle,
      })),
    )
  } catch {
    loaded.delete(lang)
    return null
  }
}
