import { describe, expect, it } from 'vitest'

import { toneOf } from '../src/features/console-activity'

const ev = (kind: string, extra: Record<string, unknown> = {}) =>
  ({ kind, ...extra }) as never

describe('ticket activity lights match the ticket list', () => {
  it('▲ only when the ticket waits on you', () => {
    expect(toneOf(ev('status', { status: 'waiting_initiator' }))).toBe(
      'waiting',
    )
    expect(toneOf(ev('status', { status: 'waiting_target' }))).toBe('muted')
    expect(toneOf(ev('created'))).toBe('muted')
  })
  it('done, failed, running, closed', () => {
    expect(toneOf(ev('status', { status: 'shipped' }))).toBe('done')
    expect(toneOf(ev('status', { status: 'failed' }))).toBe('error')
    expect(toneOf(ev('status', { status: 'in_progress' }))).toBe('running')
    expect(toneOf(ev('status', { status: 'closed' }))).toBe('muted')
    expect(toneOf(ev('run_end', { exit: 1 }))).toBe('error')
    expect(toneOf(ev('run_start'))).toBe('running')
  })
})
