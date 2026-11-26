import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { Pencil } from 'lucide-react'
import { useState } from 'react'
import type { SyntheticEvent } from 'react'

import { trace } from '#/lib/client-trace'
import { hostWrite } from '#/lib/runtime-client'
import { cn } from '#/lib/utils'
import { Button } from '#/components/ui/button'
import { Sheet } from '#/components/ui/sheet'
import { Input } from '#/components/ui/input'
import type { SessionCard } from './session-card'
import { worktreeKey } from './session-order'
import { useDeviceState } from './device-state'

const MAX = 120

export function WorktreePurpose({
  worktree,
  description,
  editable,
  compact = false,
}: {
  worktree: string
  description: string
  editable: boolean
  compact?: boolean
}) {
  const { t } = useLingui()
  const client = useQueryClient()
  const device = useDeviceState()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const shown = description
  const canEdit = editable && device.state === 'approved'

  if (editing) {
    const save = async () => {
      const text = draft.trim()
      if (text === shown) {
        setEditing(false)
        return
      }
      setSaving(true)
      setError('')
      try {
        await hostWrite('worktree.describe', { worktree, text })
        trace('worktree-purpose', { chars: text.length, cleared: !text })
        client.setQueryData<{ sessions: Array<SessionCard> }>(
          ['remote', 'sessions'],
          (data) =>
            data && {
              ...data,
              sessions: data.sessions.map((row) =>
                worktreeKey(row) === worktree
                  ? { ...row, worktree_description: text }
                  : row,
              ),
            },
        )
        setEditing(false)
        void client.invalidateQueries({ queryKey: ['remote', 'sessions'] })
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setSaving(false)
      }
    }
    const form = (
      <form
        className="grid min-w-0 gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (!saving) void save()
        }}
      >
        <Input
          variant="bare"
          // opened by a tap or Enter on 「+ 描述」: type straight away
          autoFocus
          value={draft}
          maxLength={MAX}
          disabled={saving}
          aria-label={t`Group name`}
          placeholder={t`What this workstation is for, one line`}
          data-testid="worktree-purpose-input"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return // an IME still choosing
            if (event.key === 'Escape' && !saving) {
              event.preventDefault()
              setEditing(false)
              setError('')
            }
          }}
          className="rounded-md bg-brand-deck px-2 py-0.5 text-meta text-brand-text focus-visible:ring-2 focus-visible:ring-brand-running"
        />
        {error ? (
          <span role="alert" className="text-meta text-brand-error">
            {error}
          </span>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="plain"
            disabled={saving}
            onClick={() => setEditing(false)}
          >
            {t`Cancel`}
          </Button>
          <Button type="submit" variant="solid" disabled={saving}>
            {t`Save`}
          </Button>
        </div>
      </form>
    )
    return compact ? (
      <Sheet
        open
        write
        title={t`Edit group name`}
        onOpenChange={(open) => {
          if (!open && !saving) setEditing(false)
        }}
      >
        <div className="px-4 pb-4">{form}</div>
      </Sheet>
    ) : (
      form
    )
  }

  const open = (event?: SyntheticEvent) => {
    // may sit inside a chat Link — do not navigate
    event?.preventDefault()
    event?.stopPropagation()
    setDraft(shown)
    setError('')
    setEditing(true)
  }
  if (compact) {
    return canEdit ? (
      <Button
        type="button"
        variant="plain"
        size="none"
        aria-label={t`Edit group name`}
        title={t`Edit group name`}
        data-testid="chat-edit-group-name"
        onClick={open}
        className="size-11 shrink-0 text-brand-muted"
      >
        <Pencil size={15} aria-hidden />
      </Button>
    ) : null
  }
  if (shown) {
    return canEdit ? (
      <Button
        variant="plain"
        size="none"
        type="button"
        onClick={open}
        onPointerDown={(event) => event.stopPropagation()}
        title={t`Edit the description`}
        data-testid="worktree-description"
        className="min-h-11 w-full min-w-0 truncate text-left text-body text-brand-text outline-none focus-visible:ring-2 focus-visible:ring-brand-running"
      >
        {shown}
      </Button>
    ) : (
      <span
        className="min-w-0 truncate text-body text-brand-text"
        data-testid="worktree-description"
      >
        {shown}
      </span>
    )
  }
  if (!canEdit) return null
  return (
    <Button
      variant="plain"
      size="none"
      type="button"
      onClick={open}
      onPointerDown={(event) => event.stopPropagation()}
      data-testid="worktree-purpose-add"
      className={cn(
        'inline-flex min-h-11 shrink-0 items-center text-brand-label opacity-70 outline-none hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-brand-running',
      )}
    >
      {t`+ Description`}
    </Button>
  )
}
