// Top of 工单: the run / cache / cost band, folded — eleven cells, mostly —
// between runs, held the list half a screen down. On a phone it shares a row
// with ticket activity (no sidebar there); on a wide screen it is one
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
        <h1 className="text-base font-semibold">{t`Cross-repo collab`}</h1>
        <Disclosure
          className="key rounded-[14px] px-3.5"
          triggerClassName="text-sm font-normal text-brand-muted"
          title={t`Runs, cache hit and cost`}
        >
          <div className="pb-3">{band}</div>
        </Disclosure>
      </div>
    )
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="plain"
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="key flex min-h-11 min-w-0 items-center justify-between gap-1 rounded-[14px] px-3.5 text-sm text-brand-muted"
        >
          <span className="truncate">{t`Runs and cost`}</span>
          <span aria-hidden className={cn('transition', open && 'rotate-90')}>
            ›
          </span>
        </Button>
        <ActivityLink />
      </div>
      {open ? <div className="key rounded-[14px] p-2">{band}</div> : null}
    </div>
  )
}
