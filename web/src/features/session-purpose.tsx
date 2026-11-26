// Workstation one-line purpose (git branch description; relay
// `worktree.describe` → `worktree-task describe`, same writer as Ctrl+e in
// Alt+g). Edited from 会话信息 — the IM session list only shows it read-only.
// Without one, an editable workstation shows 「+ 描述」; Enter saves, empty
// clears, Esc cancels. Primary checkout and ticket-* / claw-* are not editable
// (session-order.ts `isWorkstation`).
import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { SyntheticEvent } from 'react'

import { trace } from '#/lib/client-trace'
import { hostWrite } from '#/lib/runtime-client'
import { cn } from '#/lib/utils'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { useDeviceState } from './device-state'

const MAX = 120

export function WorktreePurpose({
  worktree,
  description,
  editable,
}: {
  worktree: string
  description: string
  editable: boolean
}) {
  const { t } = useLingui()
  const client = useQueryClient()
  const device = useDeviceState()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // shown at once after a save, until the sessions poll carries it
  const [saved, setSaved] = useState<string | null>(null)
  const shown = saved ?? description
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
        setSaved(text)
        setEditing(false)
        void client.invalidateQueries({ queryKey: ['remote', 'sessions'] })
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setSaving(false)
      }
    }
    return (
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Input
          variant="bare"
          // opened by a tap or Enter on 「+ 描述」: type straight away
          autoFocus
          value={draft}
          maxLength={MAX}
          disabled={saving}
          aria-label={t`Workstation description`}
          placeholder={t`What this workstation is for, one line`}
          data-testid="worktree-purpose-input"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return // an IME still choosing
            if (event.key === 'Enter') {
              event.preventDefault()
              void save()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setEditing(false)
              setError('')
            }
          }}
          onBlur={() => {
            if (!saving && !error) setEditing(false)
          }}
          className="rounded-md bg-brand-deck px-2 py-0.5 text-meta text-brand-text focus-visible:ring-2 focus-visible:ring-brand-running"
        />
        {error ? (
          <span role="alert" className="text-meta text-brand-error">
            {error}
          </span>
        ) : null}
      </span>
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
