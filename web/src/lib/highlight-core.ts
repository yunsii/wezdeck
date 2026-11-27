// Shiki core + lazy JS-regex grammars (shared by the Web Worker and the
// main-thread fallback when Worker is unavailable, e.g. SSR or unit tests).
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

/** style: the shiki CSS variables (--shiki-light, --shiki-dark, …) */
export type Token = { content: string; style?: Record<string, string> }

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

export function hasGrammar(lang: string): boolean {
  return Boolean(GRAMMARS[lang])
}

export async function highlightLinesCore(
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
    return null
  }
}
