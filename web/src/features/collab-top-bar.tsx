// 工单 on a phone: the run / cache / cost band and ticket activity as one
// row of two buttons — two full-width cards pushed the list a screen down.
// The band opens below on demand.
import { useLingui } from '@lingui/react/macro'
import { useState } from 'react'

import { cn } from '#/lib/utils'
import { ActivityLink } from './console-activity'

export function CollabTopBar({ band }: { band: React.ReactNode }) {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="key flex min-h-11 min-w-0 items-center justify-between gap-1 rounded-[14px] px-3.5 text-sm text-brand-muted"
        >
          <span className="truncate">{t`Runs and cost`}</span>
          <span aria-hidden className={cn('transition', open && 'rotate-90')}>
            ›
          </span>
        </button>
        <ActivityLink />
      </div>
      {open ? <div className="key rounded-[14px] p-2">{band}</div> : null}
    </div>
  )
}
