import { useLingui } from '@lingui/react/macro'
import { RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'

export function WorktreeLifecycle({
  eligible,
  onManage,
}: {
  eligible: boolean
  onManage: (action: 'recycle' | 'remove') => Promise<void>
}) {
  const { t } = useLingui()
  const [pending, setPending] = useState<'recycle' | 'remove' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!pending) return
    const frame = requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>('[data-testid="worktree-cancel-action"]')
        ?.focus(),
    )
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return
      event.preventDefault()
      event.stopPropagation()
      setPending(null)
    }
    window.addEventListener('keydown', onEscape, true)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onEscape, true)
    }
  }, [pending, busy])
  const ask = (action: 'recycle' | 'remove') => {
    setError('')
    setPending(action)
  }
  const confirm = async () => {
    if (!pending || busy || !eligible) return
    setBusy(true)
    setError('')
    try {
      await onManage(pending)
      toast.success(
        pending === 'recycle' ? t`Worktree recycled` : t`Worktree removed`,
      )
      setPending(null)
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div data-write className="grid border-t border-brand-edge pt-1">
      {pending ? (
        <div
          role="group"
          aria-label={
            pending === 'recycle' ? t`Recycle worktree` : t`Remove worktree`
          }
          className="grid gap-2 py-2"
        >
          <p className="text-caption text-brand-text">
            {pending === 'recycle'
              ? t`Reset this worktree to the latest default branch and restart its agent? Undelivered or local changes block the reset.`
              : t`Remove this worktree? Its branch and conversation history stay available. A worktree in use cannot be removed.`}
          </p>
          {error ? (
            <p role="alert" className="text-meta text-brand-error">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              variant="plain"
              type="button"
              data-testid="worktree-cancel-action"
              disabled={busy}
              onClick={() => setPending(null)}
              className="min-h-10 px-3 text-caption text-brand-muted"
            >
              {t`Cancel`}
            </Button>
            <Button
              variant="solid"
              type="button"
              disabled={busy}
              onClick={() => void confirm()}
              className="min-h-10 px-3 text-caption disabled:opacity-40"
            >
              {pending === 'recycle' ? t`Confirm recycle` : t`Confirm removal`}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <Button
            variant="plain"
            type="button"
            disabled={!eligible}
            title={
              !eligible
                ? t`Only reusable worktrees can be managed here`
                : undefined
            }
            onClick={() => ask('recycle')}
            className="flex min-h-11 w-full items-center gap-2 text-left text-caption text-brand-text disabled:opacity-40"
          >
            <RotateCcw
              size={16}
              className="shrink-0 text-brand-muted"
              aria-hidden
            />
            {t`Recycle worktree`}
          </Button>
          <Button
            variant="plain"
            type="button"
            disabled={!eligible}
            title={
              !eligible
                ? t`Only reusable worktrees can be managed here`
                : undefined
            }
            onClick={() => ask('remove')}
            className="flex min-h-11 w-full items-center gap-2 text-left text-caption text-brand-error disabled:opacity-40"
          >
            <Trash2 size={16} className="shrink-0" aria-hidden />
            {t`Remove worktree`}
          </Button>
        </>
      )}
    </div>
  )
}
