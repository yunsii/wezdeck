// 交互调试 (我的 › 交互调试): every special interaction of the session page, rendered with
// sample data by the real components. Each says where the page learns it
// from (always the transcript or a hook — never the screen) and which keys a
// tap sends; here the keys only go to the log at the top, nothing reaches a
// pane. Debug copy is bilingual inline (like the architecture page), not in
// the message catalogs.
import { useCanGoBack, useLocation, useNavigate } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { SessionTag } from '#/components/deck/session-tags'
import { Button } from '#/components/ui/button'
import { SectionHeading } from '#/components/ui/section-heading'
import { useLocale } from '#/lib/locale-context'
import { useIsWidePhoneFirst } from '#/lib/use-media'
import { cn } from '#/lib/utils'
import { GROUPS, TAGS, buildSections } from './console-interactions-sections'
import type { Tag, Text } from './console-interactions-sections'

/**
 * 我的 › 交互调试: a list of interactions beside (wide) or before (phone)
 * the selected one — what it is, where it comes from, which keys a tap
 * sends, the live component and its own key log. The selection rides the
 * URL hash so a link can point at one interaction.
 */
export function InteractionsPage() {
  const { locale } = useLocale()
  const p = (text: Text) => (locale === 'zh' ? text.zh : text.en)
  // phone first: hydration must not flash the split on a phone
  const wide = useIsWidePhoneFirst()
  const fill = useFillWindow(wide)
  const [log, setLog] = useState<Array<string>>([])
  const keyFor = (name: string) => (key: string) =>
    new Promise<void>((resolve) => {
      // Grok's loading is part of the demo: leave enough time to see the local
      // pending state before the simulated host write lands in the key log.
      setTimeout(
        () => {
          setLog((rows) => [`${name} → ${key}`, ...rows].slice(0, 8))
          resolve()
        },
        name === 'grok-ask' ? 180 : 0,
      )
    })
  const sections = buildSections(keyFor, Date.now())
  const tagChips = (tags: ReadonlyArray<Tag>) =>
    tags.map((id) => (
      <SessionTag key={id} tone={id === 'common' ? 'neutral' : id}>
        {p(TAGS.find((tag) => tag.id === id)?.label ?? { zh: id, en: id })}
      </SessionTag>
    ))
  // the selection is the URL hash, through the router: on a phone opening
  // one pushes a history entry, so the header's back (and the system back)
  // returns to the list instead of leaving 我的 › 交互调试
  const navigate = useNavigate()
  const hash = useLocation({ select: (location) => location.hash })
  const selected = IDS.has(hash) ? hash : null
  useEffect(() => {
    setLog([])
  }, [selected])
  const pick = (id: string) =>
    void navigate({
      to: '/{-$locale}/console/me/$page',
      params: {
        locale: locale === 'en' ? undefined : locale,
        page: 'interactions',
      },
      hash: id,
      replace: wide,
    })
  // a wide screen always shows one; a phone starts on the list
  const current =
    sections.find((s) => s.id === selected) ?? (wide ? sections[0] : undefined)
  const list = (
    <nav
      aria-label={p({ zh: '交互列表', en: 'Interactions' })}
      // minmax(0,1fr) all the way down: a long title truncates instead of
      // widening the sidebar over the detail (the tags pushed it there)
      className="grid grid-cols-[minmax(0,1fr)] content-start gap-4"
    >
      {GROUPS.map((group) => (
        <div key={group.id} className="grid grid-cols-[minmax(0,1fr)] gap-1">
          {/* the phone list sits on a .key card, the wide sidebar on the page */}
          <SectionHeading
            as="h2"
            className={cn(
              'px-2 text-brand-label',
              wide ? 'bg-brand-deck' : 'bg-brand-key',
            )}
          >
            {p(group.title)}
          </SectionHeading>
          {/* a phone gets the 我的 list row (ink, a rule between rows); a
              wide screen keeps the sidebar look beside the detail */}
          <ul
            className={cn(
              'grid grid-cols-[minmax(0,1fr)]',
              wide ? 'gap-0.5' : '',
            )}
          >
            {sections
              .filter((s) => s.group === group.id)
              .map((s) => (
                <li
                  key={s.id}
                  className={
                    wide
                      ? undefined
                      : 'border-b border-brand-edge last:border-b-0'
                  }
                >
                  <Button
                    variant="plain"
                    type="button"
                    data-interaction={s.id}
                    aria-current={current?.id === s.id ? 'true' : undefined}
                    onClick={() => pick(s.id)}
                    className={cn(
                      'flex w-full min-w-0 items-center justify-between gap-2 overflow-hidden px-2.5 text-left text-body',
                      !wide
                        ? 'key-press min-h-13 text-brand-text'
                        : current?.id === s.id
                          ? 'min-h-10 rounded-xl bg-brand-surface font-medium text-brand-text'
                          : 'min-h-10 rounded-xl text-brand-muted hover:bg-brand-soft',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {p(s.title)}
                    </span>
                    <span className="flex shrink-0 gap-1">
                      {tagChips(s.tags)}
                    </span>
                    {wide ? null : (
                      <ChevronRight
                        size={18}
                        aria-hidden
                        className="shrink-0 text-brand-label"
                      />
                    )}
                  </Button>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </nav>
  )
  // the description is a card; the demo renders on the page's own ground,
  // like the session page it copies, under its own heading — the two used
  // to run together (a diff read as part of the copy)
  const detail = current ? (
    <section
      key={current.id}
      data-testid="interaction-detail"
      data-interaction={current.id}
      className="grid min-w-0 content-start gap-4"
    >
      <h2 className="sticky top-0 z-10 flex flex-wrap items-center gap-2 bg-brand-deck py-1 text-title font-semibold">
        {p(current.title)}
        {tagChips(current.tags)}
      </h2>
      <dl className="grid gap-2 rounded-2xl bg-brand-surface px-3.5 py-3 text-caption">
        <div className="grid gap-0.5">
          <dt className="text-meta text-brand-label">
            {p({ zh: '怎么识别', en: 'Where it comes from' })}
          </dt>
          <dd className="leading-relaxed text-brand-muted">
            {p(current.source)}
          </dd>
        </div>
        <div className="grid gap-0.5">
          <dt className="text-meta text-brand-label">
            {p({ zh: '点了发什么', en: 'What a tap sends' })}
          </dt>
          <dd className="leading-relaxed text-brand-muted">
            {p(current.keys)}
          </dd>
        </div>
      </dl>
      <div data-testid="interaction-stage" className="grid min-w-0 gap-2">
        <h3 className="flex items-center gap-2 px-1 text-meta font-semibold text-brand-label">
          {p({ zh: '演示', en: 'Demo' })}
          <span className="h-px flex-1 bg-brand-edge" />
        </h3>
        {current.demo}
      </div>
      <div
        data-testid="interaction-log"
        className="grid gap-1 border-t border-brand-edge pt-2"
      >
        <span className="text-meta text-brand-label">
          {p({
            zh: '按键日志（这里不会发到任何窗格）',
            en: 'Key log (nothing here reaches a pane)',
          })}
        </span>
        <p className="min-h-5 font-mono text-caption whitespace-pre-wrap text-brand-muted">
          {log.length
            ? log.join('\n')
            : p({ zh: '还没有按键', en: 'No keys yet' })}
        </p>
      </div>
    </section>
  ) : null
  if (!wide)
    return detail ?? <div className="key rounded-2xl px-2 py-3">{list}</div>
  return (
    // each column scrolls on its own and together they fill the rest of
    // the window exactly: the page itself never scrolls (it had 88 px of
    // room, so a scroll moved the page first and the list with it)
    <div
      ref={fill.box}
      style={fill.height ? { height: fill.height } : undefined}
      className="grid grid-cols-[16rem_minmax(0,1fr)] gap-6"
    >
      <div
        data-testid="interaction-list-scroll"
        className="min-h-0 min-w-0 overflow-y-auto overscroll-contain border-r border-brand-edge pr-3 pb-4"
      >
        {list}
      </div>
      <div
        data-testid="interaction-detail-scroll"
        className="min-h-0 min-w-0 overflow-y-auto overscroll-contain pb-4"
      >
        {detail}
      </div>
    </div>
  )
}

/**
 * The rest of the scroller's height below this box (its top inside the
 * scroller, the page's bottom padding off): the two columns fill the window
 * and scroll inside, the page never does. Re-measured on resize.
 */
function useFillWindow(on: boolean) {
  const box = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)
  useLayoutEffect(() => {
    const el = box.current
    const scroller = el?.closest<HTMLElement>('.overflow-y-auto')
    if (!on || !el || !scroller || typeof ResizeObserver === 'undefined') return
    const main = document.getElementById('console-main')
    const measure = () => {
      const top =
        el.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop
      const pad = main ? parseFloat(getComputedStyle(main).paddingBottom) : 0
      setHeight(Math.max(240, Math.floor(scroller.clientHeight - top - pad)))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [on])
  return { box, height }
}

/** every interaction id (the hash a link may carry) */
const IDS = new Set(
  buildSections(() => () => Promise.resolve(), 0).map((s) => s.id),
)

/**
 * The 我的 page header's back: an open interaction (#id, pushed from its
 * list) returns to the list; otherwise `leave` (back to 我的).
 */
export function useInteractionsBack(active: boolean, leave: () => void) {
  const navigate = useNavigate()
  const canGoBack = useCanGoBack()
  const { locale } = useLocale()
  const hash = useLocation({ select: (location) => location.hash })
  if (!active || !hash) return leave
  return () =>
    canGoBack
      ? window.history.back()
      : void navigate({
          to: '/{-$locale}/console/me/$page',
          params: {
            locale: locale === 'en' ? undefined : locale,
            page: 'interactions',
          },
          replace: true,
        })
}
