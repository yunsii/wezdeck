// 架构解析: a public page on how WezDeck fits together. Prose carries the
// concepts and the flows; implementation notes (files, endpoints, fields)
// are folded. Each diagram is a React Flow canvas on a wide screen above its
// step list; the list is the keyboard path (and the whole diagram on a
// phone, where the canvas is never loaded). Text is bilingual inline
// ({zh, en} in copy.ts / overview.ts / flows*.ts / capabilities.ts):
// long-form page copy, not UI chrome, so the message catalogs stay out of it.
import { Link, useCanGoBack } from '@tanstack/react-router'
import { Maximize2, Minimize2 } from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '#/components/ui/button'
import { useGoBack } from '#/lib/go-back'
import { useLocale } from '#/lib/locale-context'
import { useMediaQuery } from '#/lib/use-media'
import { cn } from '#/lib/utils'
import { PublicHeader } from '../public-header'
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

type TocItem = { id: string; title: Text }

function useActiveSection(ids: Array<string>) {
  const [active, setActive] = useState(ids[0] ?? '')
  const key = ids.join(',')
  useEffect(() => {
    const list = key.split(',').filter(Boolean)
    if (typeof IntersectionObserver === 'undefined' || list.length === 0) return
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]?.target.id) setActive(visible[0].target.id)
      },
      { rootMargin: '-18% 0px -68% 0px', threshold: 0 },
    )
    for (const id of list) {
      const el = document.getElementById(id)
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
  }, [key])
  return active
}

export function ArchitecturePage() {
  const { locale } = useLocale()
  const lang: Lang = locale === 'zh' ? 'zh' : 'en'
  const localeParam = locale === 'en' ? undefined : locale
  const p = (text: Text) => pick(text, lang)
  // opened from inside the app (我的 › 架构解析 in the installed console,
  // which has no browser back button): the same ‹ as every pushed page
  const canGoBack = useCanGoBack()
  const back = useGoBack({ to: '/{-$locale}', params: { locale: localeParam } })

  const toc = useMemo<Array<TocItem>>(
    () => [
      { id: overview.id, title: overview.title },
      { id: 'concepts', title: COPY.concepts },
      ...flows.map((diagram) => ({ id: diagram.id, title: diagram.title })),
      { id: 'security-design', title: COPY.security },
      { id: 'capabilities', title: COPY.capabilities },
      { id: 'decisions', title: COPY.decisions },
    ],
    [],
  )
  const activeSection = useActiveSection(toc.map((item) => item.id))

  return (
    <main data-deck className="min-h-dvh bg-brand-deck text-brand-text">
      <PublicHeader
        active="architecture"
        maxWidth="max-w-7xl"
        onBack={canGoBack ? back : undefined}
      />

      {/* Compact sticky chapter rail on narrow / medium screens */}
      <nav
        aria-label={p(COPY.toc)}
        data-testid="architecture-toc-mobile"
        className="sticky top-14 z-20 border-b border-brand-edge bg-brand-surface/95 backdrop-blur xl:hidden"
      >
        <div className="mx-auto flex max-w-7xl items-center gap-1 overflow-x-auto px-4 py-1.5 [scrollbar-width:none] sm:px-5 [&::-webkit-scrollbar]:hidden">
          {toc.map((item) => {
            const current = activeSection === item.id
            return (
              <a
                key={item.id}
                href={`#${item.id}`}
                aria-current={current ? 'location' : undefined}
                className={cn(
                  'shrink-0 rounded-xl px-2.5 py-1 text-caption transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand-running',
                  current
                    ? 'bg-brand-running/12 font-semibold text-brand-running'
                    : 'text-brand-muted hover:bg-brand-soft hover:text-brand-text',
                )}
              >
                {p(item.title)}
              </a>
            )
          })}
        </div>
      </nav>

      <div className="mx-auto grid max-w-7xl items-start gap-10 px-4 pt-8 pb-20 sm:px-5 md:pt-12 xl:grid-cols-[13.5rem_minmax(0,1fr)]">
        {/* Persistent sticky table of contents on wide screens */}
        <nav
          aria-label={p(COPY.toc)}
          className="sticky top-20 hidden max-h-[calc(100dvh-6rem)] overflow-y-auto xl:grid xl:gap-1"
        >
          <p className="px-3 pb-1 text-meta font-semibold text-brand-label">
            {p(COPY.toc)}
          </p>
          <ul className="grid gap-0.5">
            {toc.map((item) => {
              const current = activeSection === item.id
              return (
                <li key={item.id}>
                  <a
                    href={`#${item.id}`}
                    aria-current={current ? 'location' : undefined}
                    className={cn(
                      'list-row block truncate rounded-xl px-3 py-1.5 text-caption outline-none focus-visible:ring-2 focus-visible:ring-brand-running',
                      current
                        ? 'row-selected font-semibold text-brand-running'
                        : 'text-brand-muted hover:text-brand-text',
                    )}
                  >
                    {p(item.title)}
                  </a>
                </li>
              )
            })}
          </ul>
        </nav>

        <article className="grid min-w-0 gap-14">
          <section className="grid max-w-3xl gap-3.5">
            <h1 className="text-[32px] leading-tight font-semibold tracking-tight md:text-[44px]">
              {p(COPY.title)}
            </h1>
            <p className="text-body leading-relaxed text-brand-muted md:text-title md:font-normal">
              {p(COPY.lead)}
            </p>
          </section>

          <DiagramSection diagram={overview} lang={lang} legend />

          <section
            id="concepts"
            className="grid scroll-mt-28 gap-4 xl:scroll-mt-20"
          >
            <h2 className="text-display font-semibold">{p(COPY.concepts)}</h2>
            <dl className="grid overflow-hidden rounded-2xl bg-brand-surface md:grid-cols-2">
              {CONCEPTS.map((concept) => (
                <div
                  key={concept.term.en}
                  className="grid content-start gap-1 border-b border-brand-edge px-4 py-3.5 md:odd:border-r"
                >
                  <dt className="text-body font-semibold text-brand-text">
                    {p(concept.term)}
                  </dt>
                  <dd className="text-caption leading-relaxed text-brand-muted">
                    {p(concept.body)}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <div className="grid gap-14">
            <h2 className="-mb-8 text-display font-semibold">
              {p(COPY.flows)}
            </h2>
            {flows.map((diagram) => (
              <DiagramSection key={diagram.id} diagram={diagram} lang={lang} />
            ))}
          </div>

          <section
            id="security-design"
            className="grid scroll-mt-28 gap-6 xl:scroll-mt-20"
          >
            <div className="grid max-w-3xl gap-2">
              <h2 className="text-display font-semibold">{p(COPY.security)}</h2>
              <p className="text-body leading-relaxed text-brand-muted">
                {p(COPY.securityLead)}
              </p>
            </div>
            <DiagramSection diagram={securityDiagram} lang={lang} />
            <Threats lang={lang} />
          </section>

          <Capabilities lang={lang} />

          <section
            id="decisions"
            className="grid scroll-mt-28 gap-4 xl:scroll-mt-20"
          >
            <h2 className="text-display font-semibold">{p(COPY.decisions)}</h2>
            <div className="grid overflow-hidden rounded-2xl bg-brand-surface md:grid-cols-2">
              {decisions.map((decision) => (
                <div
                  key={decision.title.en}
                  className="grid content-start gap-1.5 border-b border-brand-edge px-4 py-4 md:odd:border-r"
                >
                  <h3 className="text-body font-semibold text-brand-text">
                    {p(decision.title)}
                  </h3>
                  <p className="text-caption leading-relaxed text-brand-muted">
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
              className="key-press inline-flex min-h-11 items-center rounded-xl bg-brand-text px-5 text-body font-semibold text-brand-deck"
            >
              {p(COPY.console)}
            </Link>
            <a
              href={SOURCE}
              target="_blank"
              rel="noreferrer"
              className="key-press inline-flex min-h-11 items-center rounded-xl bg-brand-surface px-4 text-body font-medium hover:bg-brand-soft"
            >
              {p(COPY.source)}
            </a>
          </div>
        </article>
      </div>
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
    <section
      id={diagram.id}
      className="grid scroll-mt-28 gap-4 xl:scroll-mt-20"
    >
      <div className="grid max-w-3xl gap-2">
        <h2
          className={cn(
            'font-semibold',
            diagram.numbered ? 'text-heading' : 'text-display',
          )}
        >
          {p(diagram.title)}
        </h2>
        <p className="text-body leading-relaxed text-brand-muted">
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
                height: `min(46rem, calc((min(100vw, 64rem) - 2.5rem) * ${(geo.height + CARD_H / 2) / geo.width}))`,
              }
        }
        className={cn(
          'relative min-h-80 overflow-hidden rounded-2xl border border-brand-edge bg-brand-surface',
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
          className="key-press absolute top-2.5 right-2.5 z-10 grid size-9 place-items-center rounded-xl border border-brand-edge bg-brand-deck text-brand-muted hover:text-brand-text"
        >
          {full ? (
            <Minimize2 size={16} aria-hidden />
          ) : (
            <Maximize2 size={16} aria-hidden />
          )}
        </Button>
      </div>
      <p className="text-meta text-brand-label">{p(COPY.zoomHint)}</p>
    </div>
  )
}
