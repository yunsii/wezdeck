import { useLingui } from '@lingui/react/macro'
import { ListTodo } from 'lucide-react'
import { Button } from '#/components/ui/button'

export function DeferredMenuItem({
  count,
  onOpen,
  className,
}: {
  count: number
  onOpen: () => void
  className: string
}) {
  const { t } = useLingui()
  return (
    <Button
      variant="plain"
      type="button"
      onClick={onOpen}
      className={className}
    >
      <ListTodo size={19} aria-hidden className="text-brand-waiting" />
      <span className="flex-1">{t`Pending messages`}</span>
      <span className="text-meta tabular-nums text-brand-waiting">{count}</span>
    </Button>
  )
}
