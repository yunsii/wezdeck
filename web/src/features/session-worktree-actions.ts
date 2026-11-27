import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { Dispatch, SetStateAction } from 'react'

import { trace } from '#/lib/client-trace'
import { useLocale } from '#/lib/locale-context'
import { hostWrite } from '#/lib/runtime-client'
import { useDeviceState } from './device-state'
import type {
  WorkstationDirection,
  WorktreeGroup,
  WorktreeRow,
} from './session-worktree-manager'

export function useWorktreeActions({
  repoPath,
  selected,
  selectedGroup,
  sample,
  setSampleDirections,
  close,
}: {
  repoPath: string
  selected?: WorktreeRow
  selectedGroup?: WorktreeGroup
  sample?: WorkstationDirection[]
  setSampleDirections: Dispatch<
    SetStateAction<WorkstationDirection[] | undefined>
  >
  close: () => void
}) {
  const { locale } = useLocale()
  const navigate = useNavigate()
  const client = useQueryClient()
  const device = useDeviceState()
  const writable = Boolean(sample) || device.state === 'approved'

  const saveDescription = async (text: string) => {
    if (!selected || !writable) throw new Error('Worktree is not editable')
    if (sample) {
      setSampleDirections((current) =>
        current?.map((direction) => {
          if (!direction.slots.some((slot) => slot.path === selected.path))
            return direction
          const slots = direction.slots.map((slot) =>
            slot.path === selected.path ? { ...slot, description: text } : slot,
          )
          return {
            ...direction,
            slots,
            description: slots.find((slot) => slot.description)?.description,
          }
        }),
      )
    } else {
      await hostWrite('worktree.describe', {
        worktree: selected.path,
        text,
      })
      await Promise.all([
        client.invalidateQueries({
          queryKey: ['remote', 'workstations', repoPath],
        }),
        client.invalidateQueries({ queryKey: ['remote', 'sessions'] }),
      ])
    }
    trace('worktree-view', { action: 'describe', chars: text.length })
  }

  const openSession = () => {
    const id = selected?.sessions?.[0]
    if (!id) return
    trace('worktree-view', { action: 'open_session' })
    close()
    if (sample) return
    void navigate({
      to: '/{-$locale}/console/sessions/$id',
      params: { locale: locale === 'en' ? undefined : locale, id },
    })
  }

  const newSession = () => {
    const anchor = selected?.sessions?.[0]
    if (!anchor) return
    trace('worktree-view', { action: 'new_session' })
    close()
    if (sample) return
    void import('./session-new').then(({ requestNewSession }) =>
      requestNewSession({
        repo: repoPath,
        anchor,
        group:
          selectedGroup?.description || selectedGroup?.name || selected.name,
      }),
    )
  }

  return { writable, saveDescription, openSession, newSession }
}
