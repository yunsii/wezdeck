// Top of 工单: the run / cache / cost band, folded — eleven cells, mostly —
// between runs, held the list half a screen down. On a phone it is a text
// link next to ticket activity (no sidebar there); on a wide screen it is one
// Disclosure (the sidebar links activity).
import { useLingui } from '@lingui/react/macro'
import { useState } from 'react'

import { Disclosure } from '#/components/ui/disclosure'
import { useIsWide } from '#/lib/use-media'
import { cn } from '#/lib/utils'
import { ActivityLink } from './console-activity'
import { Button } from '#/components/ui/button'

export function CollabTopBar({ band }: { band: React.ReactNode }) {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  const wide = useIsWide()
  if (wide)
    return (
      <div className="grid gap-3">
        {/* the page title, like 会话 / 我的 on a wide screen */}
        <h1 className="text-body font-semibold">{t`Cross-repo collab`}</h1>
        <Disclosure
          className="key rounded-xl px-3.5"
          triggerClassName="text-caption font-normal text-brand-muted"
          title={t`Runs, cache hit and cost`}
        >
          <div className="pb-3">{band}</div>
        </Disclosure>
      </div>
    )
  // phone: one quiet line of two text links, not two cards — the list
  // starts higher (it held the first screen to three tickets)
  const link =
    'inline-flex min-h-9 items-center gap-1 text-caption text-brand-muted'
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1">
      <div className="-mt-2 flex items-center gap-5">
        <Button
          variant="plain"
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className={link}
        >
          {t`Runs and cost`}
          <span aria-hidden className={cn('transition', open && 'rotate-90')}>
            ›
          </span>
        </Button>
        <ActivityLink className={link} />
      </div>
      {open ? <div className="key rounded-xl p-2">{band}</div> : null}
    </div>
  )
}
