// Lazy Mermaid diagram renderer for Markdown code blocks (` ```mermaid `).
// Loads `mermaid` dynamically only when a diagram is mounted, adapts to the
// console's `[data-theme]` light/dark mode, fits container width cleanly with
// zero horizontal overflow, and supports toggling raw source or 1:1 scroll.
import { useLingui } from '@lingui/react/macro'
import { Code2, Eye, Maximize2, Minimize2 } from 'lucide-react'
import type mermaid from 'mermaid'
import { useEffect, useId, useState } from 'react'

import { Button } from '#/components/ui/button'
import { Skeleton, SkeletonGroup } from '#/components/ui/skeleton'
import { normalizeMermaidSvg } from '#/lib/mermaid-svg'
import type { NormalizedMermaidSvg } from '#/lib/mermaid-svg'
import { cn } from '#/lib/utils'

let mermaidPromise: Promise<typeof mermaid> | null = null

function loadMermaid(): Promise<typeof mermaid> {
  if (import.meta.env.SSR) {
    return Promise.reject(new Error('mermaid is client-only'))
  }
  mermaidPromise ??= import('mermaid').then((mod) => mod.default)
  return mermaidPromise
}

function readIsDarkTheme(): boolean {
  if (typeof document === 'undefined') return false
  const theme = document.documentElement.getAttribute('data-theme')
  if (theme === 'dark') return true
  if (theme === 'light') return false
  return document.documentElement.classList.contains('dark')
}

function useIsDarkTheme() {
  const [dark, setDark] = useState(readIsDarkTheme)
  useEffect(() => {
    if (typeof document === 'undefined') return
    const check = () => setDark(readIsDarkTheme())
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
  const [rendered, setRendered] = useState<NormalizedMermaidSvg | null>(null)
  const [error, setError] = useState<string>('')
  const [showSource, setShowSource] = useState(false)
  const [actualSize, setActualSize] = useState(false)

  useEffect(() => {
    let active = true
    const source = code.trim()
    if (!source) return
    setRendered(null)
    setError('')
    void loadMermaid()
      .then(async (mmd) => {
        mmd.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: dark ? 'dark' : 'neutral',
          fontFamily: 'var(--font-sans)',
          flowchart: {
            useMaxWidth: true,
            htmlLabels: true,
            curve: 'basis',
            padding: 14,
          },
          sequence: {
            useMaxWidth: true,
            mirrorActors: false,
          },
          class: { useMaxWidth: true },
          state: { useMaxWidth: true },
          er: { useMaxWidth: true },
          gantt: { useMaxWidth: true },
          journey: { useMaxWidth: true },
        })
        const renderId = `wd-mmd-${rawId}-${dark ? 'd' : 'l'}`
        const result = await mmd.render(renderId, source)
        if (!active) return
        setRendered(normalizeMermaidSvg(result.svg))
        setError('')
      })
      .catch((err: unknown) => {
        if (!active) return
        setRendered(null)
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      active = false
    }
  }, [code, dark, rawId])

  const canZoomActual = Boolean(
    rendered?.viewBoxWidth && rendered.viewBoxWidth > 480,
  )

  return (
    <div
      data-testid="mermaid-block"
      className="my-4 w-full min-w-0 max-w-full overflow-hidden rounded-xl border border-brand-edge bg-brand-deck"
    >
      <div className="flex items-center justify-between gap-2 border-b border-brand-edge px-3 py-1.5 text-meta text-brand-label">
        <span className="font-mono">mermaid</span>
        <div className="flex items-center gap-1">
          {rendered && !showSource && canZoomActual ? (
            <Button
              variant="plain"
              size="none"
              type="button"
              onClick={() => setActualSize((prev) => !prev)}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-meta text-brand-muted hover:bg-brand-soft hover:text-brand-text"
            >
              {actualSize ? (
                <>
                  <Minimize2 size={13} aria-hidden />
                  <span>{t`Fit`}</span>
                </>
              ) : (
                <>
                  <Maximize2 size={13} aria-hidden />
                  <span>{t`1:1`}</span>
                </>
              )}
            </Button>
          ) : null}
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
      </div>
      {showSource || error ? (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 p-3">
          {error ? (
            <p className="text-meta text-brand-error">
              {t`Diagram preview unavailable`}: {error}
            </p>
          ) : null}
          <pre className="min-w-0 max-w-full overflow-x-auto font-mono text-meta leading-relaxed text-brand-muted">
            {code}
          </pre>
        </div>
      ) : !rendered ? (
        <SkeletonGroup
          data-testid="mermaid-loading"
          className="flex min-h-40 w-full flex-col justify-center gap-2.5 p-4"
        >
          <Skeleton className="mx-auto h-5 w-2/5 rounded-lg" />
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="mx-auto h-4 w-3/5 rounded-lg" />
        </SkeletonGroup>
      ) : (
        <div
          data-testid="mermaid-svg"
          data-fit-mode={actualSize ? 'actual' : 'fit'}
          className={cn(
            'w-full min-w-0 max-w-full p-3 sm:p-4',
            actualSize
              ? 'overflow-x-auto'
              : 'overflow-hidden [&_svg]:block [&_svg]:h-auto [&_svg]:w-full [&_svg]:max-w-full',
          )}
        >
          <div
            className="mx-auto min-w-0"
            style={
              actualSize && rendered.viewBoxWidth
                ? { width: `${rendered.viewBoxWidth}px` }
                : rendered.viewBoxWidth && rendered.viewBoxWidth < 520
                  ? {
                      width: '100%',
                      maxWidth: `${Math.max(420, Math.round(rendered.viewBoxWidth * 1.25))}px`,
                    }
                  : { width: '100%' }
            }
            // Rendered by mermaid with securityLevel: 'strict' (sanitized SVG)
            dangerouslySetInnerHTML={{ __html: rendered.svg }}
          />
        </div>
      )}
    </div>
  )
}
