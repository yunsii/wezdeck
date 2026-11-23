// Reading: the title + facts + body block of a detail pane (工单 detail).
// The Inspector split it used to live beside is gone: 会话, 工单 and 诊断 all
// use the sticky-list split now.
import { cn } from '#/lib/utils'
import { useLingui } from '@lingui/react/macro'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { copyText } from '#/lib/clipboard'

export function Reading({
  kicker,
  title,
  body,
  facts,
  children,
}: {
  kicker?: React.ReactNode
  title: string
  body?: string
  /** wide: the fact takes the whole row and may wrap (a repo route) */
  facts?: Array<{ label: string; value: React.ReactNode; wide?: boolean }>
  children?: React.ReactNode
}) {
  // empty facts say nothing; an odd one out spans the row instead of
  // leaving a blank grey cell beside it
  const shownFacts = (facts ?? []).filter((fact) => fact.value !== '—')
  const halves = shownFacts.filter((fact) => !fact.wide)
  const lonely = halves.length % 2 ? halves.at(-1) : undefined
  return (
    <div className="grid content-start gap-4">
      {kicker ? <div className="text-sm">{kicker}</div> : null}
      <h1 className="text-[22px] leading-tight font-semibold tracking-tight text-balance text-brand-text md:text-2xl">
        {title}
      </h1>
      {body ? (
        <p className="max-w-prose text-sm leading-6 text-brand-muted">{body}</p>
      ) : null}
      {shownFacts.length ? (
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[14px] border border-brand-edge bg-brand-edge">
          {shownFacts.map((fact) => (
            <FactCell
              key={fact.label}
              fact={fact}
              span={fact.wide || fact === lonely}
            />
          ))}
        </dl>
      ) : null}
      {children}
    </div>
  )
}

/** one fact; a plain-text value copies on click like a Field row */
function FactCell({
  fact,
  span,
}: {
  fact: { label: string; value: React.ReactNode; wide?: boolean }
  span: boolean | undefined
}) {
  const { t } = useLingui()
  const text = typeof fact.value === 'string' ? fact.value : null
  const label = fact.label
  const body = (
    <>
      <dt className="text-xs text-brand-label">{fact.label}</dt>
      <dd
        className={cn(
          'mt-1 text-sm text-brand-text',
          fact.wide ? 'break-words' : 'truncate',
        )}
      >
        {fact.value}
      </dd>
    </>
  )
  const cell = cn('bg-brand-key px-3 py-2.5', span && 'col-span-2')
  if (text === null) return <div className={cell}>{body}</div>
  return (
    <Button
      variant="plain"
      type="button"
      title={t`Copy`}
      onClick={() => {
        void copyText(text).then(() => toast(t`Copied ${label}`))
      }}
      className={cn(
        cell,
        'block text-left transition-colors hover:bg-brand-soft active:bg-brand-soft',
      )}
    >
      {body}
    </Button>
  )
}
