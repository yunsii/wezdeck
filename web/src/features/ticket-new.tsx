// New ticket entry on the Tickets page (`n` shortcut or + button):
// opens QuickTicketSheet (AI quick capture with screenshots + 1-tap target repo
// switch + Manual fields / Manager Session toggle) and navigates straight to
// the created ticket.
import { useLingui } from '@lingui/react/macro'
import { useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '#/components/ui/button'
import { useLocale } from '#/lib/locale-context'
import { cn } from '#/lib/utils'
import { jumpPending } from './console-jump-keys'
import { useDeviceState } from './device-state'
import { QuickTicketSheet } from './ticket-quick-form'

export function NewTicketButton() {
  const { t } = useLingui()
  const { locale } = useLocale()
  const navigate = useNavigate()
  const device = useDeviceState()
  const canCreate = device.state === 'approved'
  const [open, setOpen] = useState(false)
  const [round, setRound] = useState(0)
  const show = () => {
    setRound((n) => n + 1)
    setOpen(true)
  }
  useEffect(() => {
    if (!canCreate) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        event.key !== 'n' ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest('input, textarea, select, [contenteditable="true"]') ||
        document.querySelector('[role=dialog], [role=alertdialog]') ||
        jumpPending()
      )
        return
      event.preventDefault()
      show()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canCreate])
  return (
    <>
      <Button
        variant="solid"
        type="button"
        disabled={!canCreate}
        onClick={show}
        data-testid="new-ticket"
        title={t`New ticket (n)`}
        className={cn(
          'inline-flex size-9 shrink-0 items-center justify-center gap-1.5 px-0 text-body md:w-auto md:px-3',
          !canCreate && 'invisible',
        )}
      >
        <Plus size={18} aria-hidden />
        <span className="sr-only md:not-sr-only">{t`New ticket`}</span>
      </Button>
      {canCreate && round > 0 ? (
        <QuickTicketSheet
          key={round}
          open={open}
          onOpenChange={setOpen}
          testId="new-ticket-sheet"
          draftKey="tickets-page-new"
          onCreated={(info) => {
            void navigate({
              to: '/{-$locale}/console/collab/$id',
              params: {
                locale: locale === 'en' ? undefined : locale,
                id: info.id,
              },
            })
          }}
        />
      ) : null}
    </>
  )
}
