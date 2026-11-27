// Lazy Mermaid diagram renderer for Markdown code blocks (` ```mermaid `).
// Loads `mermaid` dynamically only when a diagram is mounted, adapts to the
// current light/dark theme, and allows toggling raw source on error or review.
import { useLingui } from '@lingui/react/macro'
import { Code2, Eye } from 'lucide-react'
import type mermaid from 'mermaid'
import { useEffect, useId, useState } from 'react'

import { Button } from '#/components/ui/button'

let mermaidPromise: Promise<typeof mermaid> | null = null

function loadMermaid(): Promise<typeof mermaid> {
  if (import.meta.env.SSR) {
    return Promise.reject(new Error('mermaid is client-only'))
  }
  mermaidPromise ??= import('mermaid').then((mod) => mod.default)
  return mermaidPromise
}

function useIsDarkTheme() {
  const [dark, setDark] = useState(() =>
    typeof document !== 'undefined'
      ? document.documentElement.classList.contains('dark')
      : false,
  )
  useEffect(() => {
    if (typeof document === 'undefined') return
    const check = () =>
      setDark(document.documentElement.classList.contains('dark'))
    check()
    const observer = new MutationObserver(check)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    })
    return () => observer.disconnect()
  }, [])
  return dark
}

export function MermaidBlock({ code }: { code: string }) {
  const { t } = useLingui()
  const dark = useIsDarkTheme()
  const rawId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const [svg, setSvg] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [showSource, setShowSource] = useState(false)

  useEffect(() => {
    let active = true
    const source = code.trim()
    if (!source) return
    void loadMermaid()
      .then(async (mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: dark ? 'dark' : 'neutral',
          fontFamily: 'var(--font-sans)',
        })
        const renderId = `wd-mmd-${rawId}-${dark ? 'd' : 'l'}`
        const result = await mermaid.render(renderId, source)
        if (!active) return
        setSvg(result.svg)
        setError('')
      })
      .catch((err: unknown) => {
        if (!active) return
        setSvg('')
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      active = false
    }
  }, [code, dark, rawId])

  return (
    <div
      data-testid="mermaid-block"
      className="my-2 overflow-hidden rounded-xl border border-brand-edge bg-brand-deck"
    >
      <div className="flex items-center justify-between border-b border-brand-edge px-2.5 py-1.5 text-meta text-brand-label">
        <span className="font-mono">mermaid</span>
        <Button
          variant="plain"
          size="none"
          type="button"
          onClick={() => setShowSource((prev) => !prev)}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-meta text-brand-muted hover:bg-brand-soft hover:text-brand-text"
        >
          {showSource ? (
            <>
              <Eye size={13} aria-hidden />
              <span>{t`Diagram`}</span>
            </>
          ) : (
            <>
              <Code2 size={13} aria-hidden />
              <span>{t`Source`}</span>
            </>
          )}
        </Button>
      </div>
      {showSource || error || !svg ? (
        <div className="grid gap-1 p-2.5">
          {error ? (
            <p className="text-meta text-brand-error">
              {t`Diagram preview unavailable`}: {error}
            </p>
          ) : null}
          <pre className="overflow-x-auto font-mono text-meta leading-snug text-brand-muted">
            {code}
          </pre>
        </div>
      ) : (
        <div
          data-testid="mermaid-svg"
          className="overflow-x-auto p-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
          // Rendered by mermaid with securityLevel: 'strict' (sanitized SVG)
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
    </div>
  )
}
