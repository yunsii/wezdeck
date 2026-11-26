import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { trace } from '#/lib/client-trace'
import { hostWrite } from '#/lib/runtime-client'
import { Button } from '#/components/ui/button'
import { Sheet } from '#/components/ui/sheet'
import { Input } from '#/components/ui/input'
import type { SessionCard } from './session-card'
import { worktreeKey } from './session-order'

const MAX = 120

export function useGroupNameEditor({
  worktree,
  description,
}: {
  worktree: string
  description: string
}) {
  const { t } = useLingui()
  const client = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const save = async () => {
    const text = draft.trim()
    if (text === description) {
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
  const label = t`Edit group name`
  return {
    edit: () => {
      setDraft(description)
      setError('')
      setEditing(true)
    },
    sheet: (
      <Sheet
        open={editing}
        write
        title={label}
        onOpenChange={(open) => {
          if (!open && !saving) setEditing(false)
        }}
      >
        <div className="px-4 pb-4">
          <form
            className="grid min-w-0 gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (!saving) void save()
            }}
          >
            <Input
              variant="bare"
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
        </div>
      </Sheet>
    ),
  }
}
