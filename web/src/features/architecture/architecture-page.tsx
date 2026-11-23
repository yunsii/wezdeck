// 架构解析: a public page on how WezDeck fits together. Prose carries the
// concepts and the flows; implementation notes (files, endpoints, fields)
// are folded. Each diagram is a React Flow canvas on a wide screen above its
// step list; the list is the keyboard path (and the whole diagram on a
// phone, where the canvas is never loaded). Text is bilingual inline
// ({zh, en} in copy.ts / overview.ts / flows*.ts / capabilities.ts):
// long-form page copy, not UI chrome, so the message catalogs stay out of it.
import { Link, useCanGoBack } from '@tanstack/react-router'
import { Maximize2, Minimize2 } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'

import { BackButton } from '#/components/deck/back-button'
import { Button } from '#/components/ui/button'
import { useGoBack } from '#/lib/go-back'
import { useLocale } from '#/lib/locale-context'
import { useTheme } from '#/lib/theme-provider'
import { useMediaQuery } from '#/lib/use-media'
import { cn } from '#/lib/utils'
import { LanguageSwitcher, ThemeSwitcher } from '../console-shared'
import { decisions } from './capabilities'
import { CONCEPTS, COPY, SOURCE } from './copy'
import { Capabilities, CardDetail, Legend, StepList, Threats } from './parts'
import { securityDiagram } from './security'
import { flows } from './flows'
import { overview } from './overview'
import { CARD_H, layout } from './layout'
import { pick } from './model'
import type { Diagram, Lang, Text } from './model'

const FlowCanvas = lazy(() => import('./flow-canvas'))

export function ArchitecturePage() {
  const { locale } = useLocale()
  const { mode, setMode } = useTheme()
  const lang: Lang = locale === 'zh' ? 'zh' : 'en'
  const localeParam = locale === 'en' ? undefined : locale
  const p = (text: Text) => pick(text, lang)
  // opened from inside the app (我的 › 架构解析 in the installed console,
  // which has no browser back button): the same ‹ as every pushed page
  const canGoBack = useCanGoBack()
  const back = useGoBack({ to: '/{-$locale}', params: { locale: localeParam } })
  return (
    <main data-deck className="min-h-dvh bg-brand-deck text-brand-text">
      <header className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4">
        <div className="flex min-w-0 items-center gap-1">
          {canGoBack ? (
            <BackButton
              onClick={back}
              label={lang === 'zh' ? '返回' : 'Back'}
              className="-ml-3"
            />
          ) : null}
          <Link
            to="/{-$locale}"
            params={{ locale: localeParam }}
            className="inline-flex items-center gap-2.5 text-[16px] font-semibold"
          >
            <img src="/brand-icon.svg" alt="" width="28" height="28" />
            WezDeck
          </Link>
        </div>
        <div className="flex items-center gap-2">
          <LanguageSwitcher locale={locale} />
          <ThemeSwitcher mode={mode} onChange={setMode} />
        </div>
      </header>

      <article className="mx-auto grid max-w-6xl gap-16 px-5 pt-8 pb-20 md:pt-14">
        <section className="grid max-w-3xl gap-4">
          <h1 className="text-[34px] leading-tight font-bold tracking-tight md:text-[48px]">
            {p(COPY.title)}
          </h1>
          <p className="text-[16.5px] leading-relaxed text-brand-muted md:text-[18px]">
            {p(COPY.lead)}
          </p>
          <nav className="flex flex-wrap gap-x-5 gap-y-1 pt-1 text-[14.5px]">
            {[overview, ...flows].map((diagram) => (
              <a
                key={diagram.id}
                href={`#${diagram.id}`}
                className="text-brand-running hover:underline"
              >
                {p(diagram.title)}
              </a>
            ))}
            <a
              href="#security-design"
              className="text-brand-running hover:underline"
            >
              {p(COPY.security)}
            </a>
            <a
              href="#capabilities"
              className="text-brand-running hover:underline"
            >
              {p(COPY.capabilities)}
            </a>
            <a href="#decisions" className="text-brand-running hover:underline">
              {p(COPY.decisions)}
            </a>
          </nav>
        </section>

        <DiagramSection diagram={overview} lang={lang} legend />

        <section className="grid gap-5">
          <h2 className="text-[24px] font-bold">{p(COPY.concepts)}</h2>
          <dl className="grid gap-x-10 gap-y-5 md:grid-cols-2">
            {CONCEPTS.map((concept) => (
              <div key={concept.term.en} className="grid content-start gap-1">
                <dt className="text-[16px] font-semibold">{p(concept.term)}</dt>
                <dd className="text-[15px] leading-relaxed text-brand-muted">
                  {p(concept.body)}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <div className="grid gap-16">
          <h2 className="-mb-10 text-[24px] font-bold">{p(COPY.flows)}</h2>
          {flows.map((diagram) => (
            <DiagramSection key={diagram.id} diagram={diagram} lang={lang} />
          ))}
        </div>

        <section id="security-design" className="grid scroll-mt-6 gap-6">
          <div className="grid max-w-3xl gap-2">
            <h2 className="text-[24px] font-bold">{p(COPY.security)}</h2>
            <p className="text-[15.5px] leading-relaxed text-brand-muted">
              {p(COPY.securityLead)}
            </p>
          </div>
          <DiagramSection diagram={securityDiagram} lang={lang} />
          <Threats lang={lang} />
        </section>

        <Capabilities lang={lang} />

        <section id="decisions" className="grid scroll-mt-6 gap-5">
          <h2 className="text-[24px] font-bold">{p(COPY.decisions)}</h2>
          <div className="grid gap-x-10 gap-y-6 md:grid-cols-2">
            {decisions.map((decision) => (
              <div
                key={decision.title.en}
                className="grid content-start gap-1.5"
              >
                <h3 className="text-[16px] font-semibold">
                  {p(decision.title)}
                </h3>
                <p className="text-[15px] leading-relaxed text-brand-muted">
                  {p(decision.body)}
                </p>
              </div>
            ))}
          </div>
        </section>

        <div className="flex flex-wrap items-center gap-3 border-t border-brand-edge pt-8">
          <Link
            to="/{-$locale}/console"
            params={{ locale: localeParam }}
            className="key-press inline-flex min-h-11 items-center rounded-[12px] bg-brand-text px-5 text-[15px] font-semibold text-brand-deck"
          >
            {p(COPY.console)}
          </Link>
          <a
            href={SOURCE}
            target="_blank"
            rel="noreferrer"
            className="key-press inline-flex min-h-11 items-center rounded-[12px] border border-brand-edge bg-brand-surface px-4 text-[15px] font-medium"
          >
            {p(COPY.source)}
          </a>
        </div>
      </article>
    </main>
  )
}

function DiagramSection({
  diagram,
  lang,
  legend = false,
}: {
  diagram: Diagram
  lang: Lang
  legend?: boolean
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const p = (text: Text) => pick(text, lang)
  return (
    <section id={diagram.id} className="grid scroll-mt-6 gap-4">
      <div className="grid max-w-3xl gap-2">
        <h2
          className={cn(
            'font-bold',
            diagram.numbered ? 'text-[20px]' : 'text-[24px]',
          )}
        >
          {p(diagram.title)}
        </h2>
        <p className="text-[15.5px] leading-relaxed text-brand-muted">
          {p(diagram.summary)}
        </p>
      </div>
      {legend ? <Legend lang={lang} /> : null}
      <div className="grid gap-5">
        <CanvasFrame
          diagram={diagram}
          lang={lang}
          selected={selected}
          onSelect={setSelected}
        />
        <StepList
          diagram={diagram}
          lang={lang}
          selected={selected}
          onSelect={setSelected}
        />
      </div>
    </section>
  )
}

/** the canvas: wide screens only, mounted after hydration (React Flow measures the DOM) */
function CanvasFrame({
  diagram,
  lang,
  selected,
  onSelect,
}: {
  diagram: Diagram
  lang: Lang
  selected: string | null
  onSelect: (id: string | null) => void
}) {
  const wide = useMediaQuery('(min-width: 768px)', false)
  const frame = useRef<HTMLDivElement>(null)
  const [full, setFull] = useState(false)
  useEffect(() => {
    const sync = () => setFull(document.fullscreenElement === frame.current)
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])
  const geo = layout(diagram)
  const p = (text: Text) => pick(text, lang)
  return (
    <div className="hidden min-w-0 gap-2 md:grid">
      <div
        ref={frame}
        style={
          full
            ? undefined
            : {
                // the full column width, the diagram's own proportions,
                // capped: a tall flow keeps the width and scrolls less
                height: `min(46rem, calc((min(100vw, 72rem) - 2.5rem) * ${(geo.height + CARD_H / 2) / geo.width}))`,
              }
        }
        className={cn(
          'relative min-h-80 overflow-hidden rounded-[20px] border border-brand-edge bg-brand-deck',
        )}
      >
        {/* isolate: React Flow lifts nodes with z-index; keep that inside */}
        {wide ? (
          <div className="absolute inset-0 isolate">
            <Suspense fallback={null}>
              <FlowCanvas
                diagram={diagram}
                lang={lang}
                selected={selected}
                onSelect={onSelect}
              />
            </Suspense>
          </div>
        ) : null}
        {wide && selected ? (
          <CardDetail
            diagram={diagram}
            lang={lang}
            id={selected}
            onClose={() => onSelect(null)}
          />
        ) : null}
        <Button
          variant="plain"
          size="none"
          type="button"
          aria-label={p(full ? COPY.exitFullscreen : COPY.fullscreen)}
          title={p(full ? COPY.exitFullscreen : COPY.fullscreen)}
          onClick={() =>
            full
              ? void document.exitFullscreen()
              : void frame.current?.requestFullscreen()
          }
          className="key-press absolute top-2.5 right-2.5 z-10 grid size-9 place-items-center rounded-[10px] border border-brand-edge bg-brand-surface text-brand-muted hover:text-brand-text"
        >
          {full ? (
            <Minimize2 size={16} aria-hidden />
          ) : (
            <Maximize2 size={16} aria-hidden />
          )}
        </Button>
      </div>
      <p className="text-[12.5px] text-brand-label">{p(COPY.zoomHint)}</p>
    </div>
  )
}
