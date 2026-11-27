import { useLingui } from '@lingui/react/macro'
import { ArrowUpRight, Check, Copy, Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import type { WorktreeRow } from './session-worktree-manager'
import { WorktreeLifecycle } from './session-worktree-lifecycle'

export function WorktreeDetail({
  row,
  status,
  writable,
  wide,
  copied,
  onCopy,
  onSave,
  onOpenSession,
  onNewSession,
  onManage,
}: {
  row: WorktreeRow
  status: string
  writable: boolean
  wide: boolean
  copied: boolean
  onCopy: () => void
  onSave: (text: string) => Promise<void>
  onOpenSession?: () => void
  onNewSession?: () => void
  onManage: (action: 'recycle' | 'remove') => Promise<void>
}) {
  const { t } = useLingui()
  const [draft, setDraft] = useState(row.description ?? '')
  const [saved, setSaved] = useState(row.description ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const editable = Boolean(row.branch && row.state)
  const canManage =
    editable && writable && row.state === 'idle' && Boolean(row.head)
  const save = async () => {
    const text = draft.trim()
    if (text === saved || saving) return
    setSaving(true)
    setError('')
    try {
      await onSave(text)
      setSaved(text)
      toast.success(t`Saved`)
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <div
      data-testid="worktree-detail"
      className="grid w-full min-w-0 gap-3 overflow-hidden px-4 pb-3 md:px-2"
    >
      <dl className="min-w-0 divide-y divide-brand-edge text-caption">
        {status ? (
          <div className="flex items-center justify-between gap-3 py-2">
            <dt className="text-brand-label">{t`Status`}</dt>
            <dd className="min-w-0 truncate text-brand-text">{status}</dd>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-3 py-2">
          <dt className="text-brand-label">{t`Branch`}</dt>
          <dd className="min-w-0 max-w-[75%] truncate font-mono text-brand-text">
            {row.branch || t`Detached`}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3 py-2">
          <dt className="text-brand-label">{t`Path`}</dt>
          <dd className="min-w-0 flex-1 overflow-hidden">
            <Button
              variant="plain"
              type="button"
              aria-label={t`Copy path`}
              title={t`Copy path`}
              onClick={onCopy}
              className="flex w-full min-w-0 items-center justify-end gap-2 overflow-hidden text-right font-mono text-meta text-brand-text"
            >
              <span className="min-w-0 truncate" title={row.path}>
                {row.path}
              </span>
              {copied ? (
                <Check size={15} className="shrink-0" aria-hidden />
              ) : (
                <Copy size={15} className="shrink-0" aria-hidden />
              )}
            </Button>
          </dd>
        </div>
      </dl>
      {editable ? (
        <form
          data-write
          className="grid min-w-0 gap-2 border-t border-brand-edge pt-3"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <label
            htmlFor="worktree-purpose"
            className="text-caption font-medium text-brand-text"
          >
            {t`Purpose`}
          </label>
          <Input
            id="worktree-purpose"
            variant={wide ? 'default' : 'field'}
            value={draft}
            maxLength={120}
            readOnly={!writable}
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t`What this workstation is for, one line`}
            className="min-h-10 min-w-0"
          />
          {error ? (
            <p role="alert" className="text-meta text-brand-error">
              {error}
            </p>
          ) : null}
          {writable ? (
            <Button
              variant="solid"
              type="submit"
              disabled={saving || draft.trim() === saved}
              className="min-h-10 justify-self-end px-4 text-caption disabled:opacity-40"
            >
              {t`Save`}
            </Button>
          ) : (
            <p className="text-meta text-brand-muted">{t`Turn on write access in Settings to edit`}</p>
          )}
        </form>
      ) : null}
      {onOpenSession || onNewSession ? (
        <div className="divide-y divide-brand-edge border-t border-brand-edge">
          {onOpenSession ? (
            <Button
              variant="plain"
              type="button"
              onClick={onOpenSession}
              className="flex min-h-11 w-full items-center gap-2 text-left text-caption text-brand-text"
            >
              <ArrowUpRight
                size={16}
                className="shrink-0 text-brand-muted"
                aria-hidden
              />
              {t`Open session`}
            </Button>
          ) : null}
          {onNewSession ? (
            <Button
              variant="plain"
              type="button"
              onClick={onNewSession}
              className="flex min-h-11 w-full items-center gap-2 text-left text-caption text-brand-text"
            >
              <Plus
                size={16}
                className="shrink-0 text-brand-muted"
                aria-hidden
              />
              {t`New session in this group`}
            </Button>
          ) : null}
        </div>
      ) : null}
      {editable ? (
        <WorktreeLifecycle eligible={canManage} onManage={onManage} />
      ) : null}
    </div>
  )
}
