import { X } from 'lucide-react'

import { Button } from '#/components/ui/button'

/** Shared chrome for composer tools that open above the input. */
export function ComposerPanel({
  title,
  onClose,
  closeLabel,
  children,
  testId,
}: {
  title: React.ReactNode
  onClose: () => void
  closeLabel: string
  children: React.ReactNode
  testId?: string
}) {
  return (
    <div data-write data-testid={testId} className="composer-panel grid gap-2">
      <div className="composer-panel-header flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-meta text-brand-label">
          {title}
        </span>
        <Button
          variant="plain"
          type="button"
          onClick={onClose}
          aria-label={closeLabel}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-brand-muted"
        >
          <X size={14} aria-hidden />
        </Button>
      </div>
      {children}
    </div>
  )
}
