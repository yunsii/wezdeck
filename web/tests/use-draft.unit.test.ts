import { describe, expect, it } from 'vitest'

import { sessionDraftKey, ticketDraftKey, visibleDraft } from '#/lib/use-draft'

describe('use-draft helpers', () => {
  it('hides draft while the item detail is currently open and shows it after leaving', () => {
    expect(visibleDraft('s-1', 's-1', '还没发的消息')).toBe('')
    expect(visibleDraft('s-1', 's-2', '  还没发的消息  ')).toBe('还没发的消息')
    expect(visibleDraft('s-1', undefined, '还没发的消息')).toBe('还没发的消息')
    expect(visibleDraft('s-1', 's-2', '   ')).toBe('')
  })

  it('builds stable storage keys for sessions and tickets', () => {
    expect(sessionDraftKey('abc')).toBe('wezdeck.draft.abc')
    expect(ticketDraftKey('req-1')).toBe('wezdeck.draft.ticket.req-1')
  })
})
