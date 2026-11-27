// Syntax-highlighted fenced code block for long-form Markdown documents
// (used by `ChatMarkdown` in `variant="document"`).
import { useLingui } from '@lingui/react/macro'
import { Check, Copy } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { Button } from '#/components/ui/button'
import { copyText } from '#/lib/clipboard'
import { highlightLines } from '#/lib/highlight'
import type { Token } from '#/lib/highlight'

const FENCE_LANG_ALIASES: Partial<Record<string, string>> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  typescript: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  javascript: 'javascript',
  jsx: 'jsx',
  go: 'go',
  golang: 'go',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  shell: 'shellscript',
  shellscript: 'shellscript',
  lua: 'lua',
  py: 'python',
  python: 'python',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  md: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  cs: 'csharp',
  csharp: 'csharp',
  toml: 'toml',
  html: 'html',
  ps1: 'powershell',
  powershell: 'powershell',
  rs: 'rust',
  rust: 'rust',
  sql: 'sql',
}

function resolveFenceLang(rawLang?: string): string | null {
  if (!rawLang) return null
  const normalized = rawLang.trim().toLowerCase()
  return FENCE_LANG_ALIASES[normalized] ?? null
}

export function DocCodeBlock({ code, lang }: { code: string; lang?: string }) {
  const { t } = useLingui()
  const [copied, setCopied] = useState(false)
  const [tokens, setTokens] = useState<Array<Array<Token>> | null>(null)

  const trimmed = useMemo(() => code.replace(/\n$/, ''), [code])
  const lines = useMemo(() => trimmed.split('\n'), [trimmed])
  const grammar = useMemo(() => resolveFenceLang(lang), [lang])

  useEffect(() => {
    if (!grammar || !trimmed) {
      setTokens(null)
      return
    }
    let live = true
    void highlightLines(lines, grammar).then((result) => {
      if (live) setTokens(result)
    })
    return () => {
      live = false
    }
  }, [grammar, lines, trimmed])

  const label = lang?.trim() || 'text'

  const handleCopy = () => {
    void copyText(trimmed).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1_500)
    })
  }

  return (
    <div className="my-4 min-w-0 max-w-full overflow-hidden rounded-xl border border-brand-edge bg-brand-deck">
      <div className="flex items-center justify-between gap-2 border-b border-brand-edge px-3 py-1.5 text-meta text-brand-label">
        <span className="truncate font-mono">{label}</span>
        <Button
          variant="plain"
          size="none"
          type="button"
          onClick={handleCopy}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-0.5 text-meta text-brand-muted hover:bg-brand-soft hover:text-brand-text"
        >
          {copied ? (
            <>
              <Check size={13} className="text-brand-done" aria-hidden />
              <span>{t`Copied`}</span>
            </>
          ) : (
            <>
              <Copy size={13} aria-hidden />
              <span>{t`Copy`}</span>
            </>
          )}
        </Button>
      </div>
      <pre className="min-w-0 max-w-full overflow-x-auto px-3.5 py-3 font-mono text-meta leading-relaxed text-brand-text">
        <code>
          {lines.map((raw, i) => {
            const lineTokens = tokens?.[i]
            return (
              <span key={i} className="block whitespace-pre">
                {lineTokens
                  ? lineTokens.map((tok, ti) => (
                      <span key={ti} className="code-token" style={tok.style}>
                        {tok.content}
                      </span>
                    ))
                  : raw || ' '}
              </span>
            )
          })}
        </code>
      </pre>
    </div>
  )
}
