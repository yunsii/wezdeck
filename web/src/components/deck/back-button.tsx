import { ChevronLeft } from 'lucide-react'

import { Button } from '#/components/ui/button'
import { cn } from '#/lib/utils'

/**
 * The one back control of a pushed page (a session, a 我的 group, a
 * ticket): a bare ‹ on a 44 px target at the header's left edge — no
 * "返回" word beside it, so every page backs out the same way.
 */
export function BackButton({
  onClick,
  label,
  className,
}: {
  onClick: () => void
  /** what back goes to, for screen readers (返回 / 会话 …) */
  label: string
  className?: string
}) {
  return (
    <Button
      variant="plain"
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        'inline-flex size-11 shrink-0 items-center justify-center text-brand-muted',
        className,
      )}
    >
      <ChevronLeft size={22} aria-hidden />
    </Button>
  )
}
