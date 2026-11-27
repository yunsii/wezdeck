import { describe, expect, it } from 'vitest'

import {
  filterWorktreeGroups,
  worktreeGroups,
} from '#/features/session-worktree-manager'

describe('worktree overview', () => {
  const list = [
    { path: '/repo', branch: 'main' },
    { path: '/trees/ux', branch: 'dev/ux', current: true },
    { path: '/trees/ux-2', branch: 'dev/ux-2' },
    { path: '/trees/ticket-1', branch: 'ticket/1' },
  ]
  const directions = [
    {
      name: 'ux',
      description: 'Web console',
      slots: [
        { path: '/trees/ux', name: 'ux', branch: 'dev/ux', state: 'idle' },
        {
          path: '/trees/ux-2',
          name: 'ux-2',
          branch: 'dev/ux-2',
          state: 'dirty',
        },
      ],
    },
  ]

  it('keeps the current slot, primary checkout and non-workstation trees', () => {
    const groups = worktreeGroups(list, directions, 'Other')
    expect(groups.map((group) => group.name)).toEqual(['ux', 'Other'])
    expect(groups[0].description).toBe('Web console')
    expect(groups[0].rows[0]).toMatchObject({ name: 'ux', current: true })
    expect(groups[1].rows.map((row) => [row.path, row.primary])).toEqual([
      ['/repo', true],
      ['/trees/ticket-1', false],
    ])
  })

  it('searches direction names, descriptions, branches and paths', () => {
    const groups = worktreeGroups(list, directions, 'Other')
    expect(filterWorktreeGroups(groups, 'Web console')[0].rows).toHaveLength(2)
    expect(
      filterWorktreeGroups(groups, 'dev/ux-2')[0].rows.map((row) => row.name),
    ).toEqual(['ux-2'])
    expect(filterWorktreeGroups(groups, 'ticket-1')[0].name).toBe('Other')
    expect(filterWorktreeGroups(groups, 'missing')).toEqual([])
  })
})
