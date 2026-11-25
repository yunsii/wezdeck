import { describe, expect, it } from 'vitest'

import { workstationSlug } from '#/features/session-new'

// mirrors open-task-window → wt_workstation_plan → wt_slugify
// (scripts/runtime/worktree/lib/workstation.sh), so the preview names what
// the host creates
describe('workstationSlug', () => {
  it('lower-cases and joins runs of other characters with one dash', () => {
    expect(workstationSlug('Web UX')).toBe('web-ux')
    expect(workstationSlug('  i18n__sync  ')).toBe('i18n-sync')
    expect(workstationSlug('a.b/c')).toBe('a-b-c')
  })
  it('drops a dev- or dev/ typed out of habit', () => {
    expect(workstationSlug('dev-ux')).toBe('ux')
    expect(workstationSlug('dev/ux')).toBe('ux')
    expect(workstationSlug('devtools')).toBe('devtools')
  })
  it('is empty when nothing usable is left', () => {
    expect(workstationSlug('网页体验')).toBe('')
    expect(workstationSlug('  ')).toBe('')
    expect(workstationSlug('ux 体验')).toBe('ux')
  })
})
