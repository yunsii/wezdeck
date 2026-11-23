// The pieces of the architecture page: the line legend, the detail panel
// over a canvas, the step list (the keyboard path, and the whole diagram on
// a phone) and the folded capability tables.
import { X } from 'lucide-react'

import { Button } from '#/components/ui/button'
import { Disclosure } from '#/components/ui/disclosure'
import { cn } from '#/lib/utils'
import { capabilityGroups } from './capabilities'
import { COPY, KINDS } from './copy'
import { KIND_STYLE, pick } from './model'
import type { Diagram, Lang, Text } from './model'

export function Legend({ lang }: { lang: Lang }) {
  return (
    // the legend explains canvas lines: no canvas on a phone, no legend
    <div className="hidden flex-wrap items-center gap-x-5 gap-y-1.5 text-[13px] text-brand-muted md:flex">
      <span className="text-brand-label">{pick(COPY.legend, lang)}</span>
      {KINDS.map(({ kind, label }) => (
        <span key={kind} className="inline-flex items-center gap-2">
          <svg width="30" height="8" aria-hidden>
            <line
              x1="1"
              y1="4"
              x2="29"
              y2="4"
              stroke={KIND_STYLE[kind].color}
              strokeWidth="2"
              strokeDasharray={KIND_STYLE[kind].dash}
            />
          </svg>
          {pick(label, lang)}
        </span>
      ))}
    </div>
  )
}

/** the selected card's notes, floating over the canvas (also in full screen) */
export function CardDetail({
  diagram,
  lang,
  id,
  onClose,
}: {
  diagram: Diagram
  lang: Lang
  id: string
  onClose: () => void
}) {
  const index = diagram.cards.findIndex((card) => card.id === id)
  const card = diagram.cards.find((one) => one.id === id)
  if (!card) return null
  const p = (text: Text) => pick(text, lang)
  const lane = diagram.lanes.find((l) => l.key === card.lane)
  return (
    <aside
      aria-label={p(card.title)}
      className="absolute top-14 right-2.5 z-10 grid max-h-[calc(100%-4.5rem)] w-80 content-start gap-2 overflow-y-auto rounded-[16px] border border-brand-edge bg-brand-surface p-4 shadow-[0_8px_30px_rgba(0,0,0,0.18)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="grid gap-0.5">
          <span className="text-[12.5px] text-brand-label">
            {diagram.numbered ? `${index + 1} · ` : ''}
            {lane ? p(lane.label) : ''}
          </span>
          <h3 className="text-[16px] font-semibold">{p(card.title)}</h3>
        </div>
        <Button
          variant="ghost"
          size="icon"
          type="button"
          aria-label={lang === 'zh' ? '关闭' : 'Close'}
          onClick={onClose}
        >
          <X size={15} aria-hidden />
        </Button>
      </div>
      <p className="text-[14px] leading-relaxed text-brand-muted">
        {p(card.body)}
      </p>
      {card.impl ? (
        <Disclosure
          title={p(COPY.impl)}
          triggerClassName="min-h-8 text-[13px] font-medium text-brand-label"
        >
          <p className="pb-1 font-mono text-[12.5px] leading-relaxed break-words text-brand-muted">
            {p(card.impl)}
          </p>
        </Disclosure>
      ) : null}
    </aside>
  )
}

/** the cards as a list: the keyboard path beside the canvas, the whole diagram on a phone */
export function StepList({
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
  const p = (text: Text) => pick(text, lang)
  const laneLabel = new Map(
    diagram.lanes.map((lane) => [lane.key, p(lane.label)]),
  )
  const List = diagram.numbered ? 'ol' : 'ul'
  return (
    <div className="grid content-start gap-2">
      <h3 className="text-[13px] font-semibold text-brand-label">
        {p(diagram.numbered ? COPY.steps : COPY.parts)}
      </h3>
      <List className="grid items-start gap-1.5 md:grid-cols-2 lg:grid-cols-3">
        {diagram.cards.map((card, index) => {
          const open = card.id === selected
          // the overview groups its parts under the lane they run in
          const lane =
            !diagram.numbered && card.lane !== diagram.cards[index - 1]?.lane
              ? laneLabel.get(card.lane)
              : undefined
          return [
            lane ? (
              <li
                key={`lane:${card.lane}`}
                role="presentation"
                className="col-span-full pt-2 text-[13px] font-semibold text-brand-text first:pt-0"
              >
                {lane}
              </li>
            ) : null,
            <li
              key={card.id}
              className={cn(
                'rounded-[14px] border bg-brand-surface transition-colors duration-[var(--motion-short)]',
                open ? 'border-brand-running/70' : 'border-brand-edge',
                card.planned && 'border-dashed',
              )}
            >
              <Button
                variant="plain"
                size="none"
                type="button"
                aria-expanded={open}
                onClick={() => onSelect(open ? null : card.id)}
                className={cn(
                  'grid w-full cursor-pointer items-baseline gap-x-2 rounded-[14px] px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-running',
                  diagram.numbered && 'grid-cols-[1.25rem_minmax(0,1fr)]',
                )}
              >
                {diagram.numbered ? (
                  <span className="text-xs font-semibold text-brand-running tabular-nums">
                    {index + 1}
                  </span>
                ) : null}
                <span className="grid gap-0.5">
                  <span className="text-[14.5px] font-semibold">
                    {p(card.title)}
                    {card.planned ? (
                      <span className="ml-2 text-[12px] font-normal text-brand-label">
                        {lang === 'zh' ? '规划中' : 'planned'}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-[12.5px] text-brand-label">
                    {diagram.numbered
                      ? `${laneLabel.get(card.lane) ?? ''} · ${p(card.sub)}`
                      : p(card.sub)}
                  </span>
                </span>
              </Button>
              {open ? (
                <div
                  className={cn(
                    'grid gap-2 px-3 pb-3',
                    diagram.numbered && 'pl-[2.75rem]',
                  )}
                >
                  <p className="text-[14px] leading-relaxed text-brand-muted">
                    {p(card.body)}
                  </p>
                  {card.impl ? (
                    <Disclosure
                      title={p(COPY.impl)}
                      triggerClassName="min-h-8 text-[13px] font-medium text-brand-label"
                    >
                      <p className="pb-1 font-mono text-[12.5px] leading-relaxed break-words text-brand-muted">
                        {p(card.impl)}
                      </p>
                    </Disclosure>
                  ) : null}
                </div>
              ) : null}
            </li>,
          ]
        })}
      </List>
    </div>
  )
}

export function Capabilities({ lang }: { lang: Lang }) {
  const p = (text: Text) => pick(text, lang)
  return (
    <section id="capabilities" className="grid scroll-mt-6 gap-5">
      <div className="grid max-w-3xl gap-2">
        <h2 className="text-[24px] font-bold">{p(COPY.capabilities)}</h2>
        <p className="text-[15.5px] leading-relaxed text-brand-muted">
          {p(COPY.capabilitiesLead)}
        </p>
      </div>
      <div className="grid gap-2.5">
        {capabilityGroups.map((group) => (
          <Disclosure
            key={group.id}
            className="min-w-0 rounded-[16px] border border-brand-edge bg-brand-surface px-4"
            triggerClassName="py-2"
            title={
              <span className="grid gap-0.5 py-1">
                <span className="text-[15.5px] font-semibold">
                  {p(group.title)}
                  <span className="ml-2 text-[13px] font-normal text-brand-label tabular-nums">
                    {group.items.length}
                  </span>
                </span>
                <span className="text-[13.5px] leading-relaxed font-normal text-brand-muted">
                  {p(group.summary)}
                </span>
              </span>
            }
          >
            {/* a list, not a table: on a phone the entry sits above its
                description instead of pushing the card off the screen */}
            <div className="pb-4">
              <div className="hidden grid-cols-[17rem_minmax(0,1fr)] gap-x-4 py-2 text-[13.5px] text-brand-label md:grid">
                <span>{p(COPY.entry)}</span>
                <span>{p(COPY.what)}</span>
              </div>
              <dl className="text-[13.5px]">
                {group.items.map((item) => (
                  <div
                    key={item.name}
                    className="grid gap-x-4 gap-y-0.5 border-t border-brand-border py-2 md:grid-cols-[17rem_minmax(0,1fr)]"
                  >
                    <dt className="font-mono text-[12.5px] break-all text-brand-text">
                      {item.name}
                    </dt>
                    <dd className="text-brand-muted">{p(item.what)}</dd>
                  </div>
                ))}
              </dl>
              <p className="pt-2 font-mono text-[12px] text-brand-label">
                {group.source}
              </p>
            </div>
          </Disclosure>
        ))}
      </div>
    </section>
  )
}
