import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionCard } from '#/features/session-card'
import type { Detail } from '#/features/session-detail-types'
import {
  acceptSessionOptimistic,
  applySessionDetailOverlay,
  applySessionOptimistic,
  applySessionsListOverlay,
  isSessionCardOverlaySettled,
  isSessionDetailOverlaySettled,
  onOptimisticTimeout,
  promptFingerprint,
  reconcileSessionDetail,
  reconcileSessionsList,
  resetSessionOptimisticForTest,
} from '#/lib/optimistic-state'
import {
  acceptTicketOptimistic,
  applyCollabHealthOverlay,
  applyCollabListOverlay,
  applyCollabShowOverlay,
  applyTicketOptimistic,
  reconcileTicketList,
  reconcileTicketShow,
  resetTicketOptimisticForTest,
} from '#/lib/optimistic-tickets'
import type {
  CollabHealth,
  CollabList,
  CollabShow,
} from '#/lib/runtime-contract'

const waitingDetail = (overrides: Partial<Detail> = {}): Detail => ({
  id: 's1',
  agent: 'agy',
  status: 'waiting',
  waiting_kind: 'permission_prompt',
  ts: 1_000,
  start: 0,
  messages: [{ role: 'user', text: 'run cmd' }],
  permission: { tool: 'run_command', text: 'run_command ls', summary: 'ls' },
  ...overrides,
})

const waitingCard = (overrides: Partial<SessionCard> = {}): SessionCard => ({
  id: 's1',
  name: 'demo',
  window: 'primary',
  agent: 'agy',
  cwd: '/repo/demo',
  branch: 'master',
  status: 'waiting',
  waiting_kind: 'permission_prompt',
  ts: 1_000,
  last_prompt: 'run cmd',
  transcript: true,
  desk_idle_s: 60,
  ...overrides,
})

afterEach(() => {
  vi.useRealTimers()
  resetSessionOptimisticForTest()
  resetTicketOptimisticForTest()
})

describe('prompt fingerprint stability during teardown', () => {
  it('keeps suppressing across terminal echo changes and perm -> keys teardown downgrade', () => {
    const rawKeysBefore = waitingDetail({
      permission: undefined,
      screen: 'Allow? (1/2)',
    })
    const rawKeysAfterEcho = waitingDetail({
      permission: undefined,
      screen: 'Allow? (1/2)\n1',
    })
    expect(promptFingerprint(rawKeysBefore)).toBe(
      promptFingerprint(rawKeysAfterEcho),
    )

    const permDetail = waitingDetail()
    const permKey = promptFingerprint(permDetail)
    const settling = {
      id: 's1',
      opId: 'op-perm-downgrade',
      kind: 'prompt-submit' as const,
      phase: 'settling' as const,
      createdAt: 2_000,
      acceptedAt: 2_200,
      ttlMs: 15_000,
      suppressedPromptKey: permKey,
      baseline: {
        status: 'waiting',
        ts: 1_000,
        waitingKind: 'permission_prompt',
        promptKey: permKey,
      },
    }
    // Tool result landed in transcript (permission=undefined) while attention.json
    // still holds waiting_kind=permission_prompt: must NOT flash raw key strip!
    expect(
      isSessionDetailOverlaySettled(settling, rawKeysAfterEcho, 2_400),
    ).toBe('active')
    const projected = applySessionDetailOverlay(
      rawKeysAfterEcho,
      settling,
      2_400,
    )
    expect(projected?.status).toBe('running')
    expect(projected?.waiting_kind).toBeUndefined()
  })
})

describe('permission optimistic settlement without cross-query flicker', () => {
  it('never settles a waiting list card on accept just because row.ts > baseline.ts', () => {
    const staleDetail = waitingDetail({ ts: 1_000 })
    const keyA = promptFingerprint(staleDetail)
    const newerWaitingRow = waitingCard({ ts: 1_500 })

    applySessionOptimistic({
      id: 's1',
      opId: 'op-allow',
      kind: 'prompt-submit',
      suppressedPromptKey: keyA,
      createdAt: 2_000,
      baseline: {
        status: 'waiting',
        ts: 1_000,
        waitingKind: 'permission_prompt',
        promptKey: keyA,
      },
    })
    acceptSessionOptimistic('s1', 'op-allow', 2_500)

    const settlingOverlay = {
      id: 's1',
      opId: 'op-allow',
      kind: 'prompt-submit' as const,
      phase: 'settling' as const,
      createdAt: 2_000,
      acceptedAt: 2_500,
      ttlMs: 15_000,
      suppressedPromptKey: keyA,
      baseline: {
        status: 'waiting',
        ts: 1_000,
        waitingKind: 'permission_prompt',
        promptKey: keyA,
      },
    }
    expect(
      isSessionCardOverlaySettled(settlingOverlay, newerWaitingRow, 2_600),
    ).toBe('active')
    const projected = applySessionsListOverlay(
      { sessions: [newerWaitingRow] },
      new Map([['s1', settlingOverlay]]),
      2_600,
    )
    expect(projected.sessions[0].status).toBe('running')
    expect(projected.sessions[0].waiting_kind).toBeUndefined()
  })

  it('keeps permission card suppressed on stale detail when sessions list settles first', () => {
    const staleDetail = waitingDetail({ ts: 1_000 })
    const keyA = promptFingerprint(staleDetail)
    const freshListRow = waitingCard({
      status: 'running',
      waiting_kind: undefined,
      ts: 2_800,
    })
    const freshDetail = waitingDetail({
      status: 'running',
      waiting_kind: undefined,
      permission: undefined,
      ts: 2_800,
    })

    applySessionOptimistic({
      id: 's1',
      opId: 'op-allow',
      kind: 'prompt-submit',
      suppressedPromptKey: keyA,
      createdAt: 2_000,
      baseline: {
        status: 'waiting',
        ts: 1_000,
        waitingKind: 'permission_prompt',
        promptKey: keyA,
      },
    })
    acceptSessionOptimistic('s1', 'op-allow', 2_500)

    // Sessions list poll arrives first while detail cache is still stale waiting
    let cachedDetail: Detail = staleDetail
    reconcileSessionsList([freshListRow], 2_900, {
      getDetail: () => cachedDetail,
    })

    // Re-running detail projection on the still-stale detail must NOT flash permission card back
    const overlayAfterList = {
      id: 's1',
      opId: 'op-allow',
      kind: 'prompt-submit' as const,
      phase: 'settling' as const,
      createdAt: 2_000,
      acceptedAt: 2_500,
      ttlMs: 15_000,
      suppressedPromptKey: keyA,
      settledOn: { list: true },
      baseline: {
        status: 'waiting',
        ts: 1_000,
        waitingKind: 'permission_prompt',
        promptKey: keyA,
      },
    }
    const stillProjected = applySessionDetailOverlay(
      staleDetail,
      overlayAfterList,
      2_950,
    )
    expect(stillProjected?.status).toBe('running')
    expect(stillProjected?.permission).toBeUndefined()
    expect(stillProjected?.waiting_kind).toBeUndefined()

    // Once detail catches up, reconciling detail clears the overlay cleanly
    cachedDetail = freshDetail
    reconcileSessionDetail('s1', freshDetail, 3_000, { listRow: freshListRow })

    // Verify no stale overlay lingers by checking timeout never fires
    vi.useFakeTimers()
    const timeouts: Array<string> = []
    const unsub = onOptimisticTimeout((e) => timeouts.push(e.id))
    vi.advanceTimersByTime(20_000)
    expect(timeouts).toEqual([])
    unsub()
  })

  it('keeps list row running when detail settles first, hard-settles on new prompt, and avoids false timeout toast', () => {
    vi.useFakeTimers()
    const timeouts: Array<string> = []
    const unsub = onOptimisticTimeout((e) => timeouts.push(e.id))

    const staleDetail = waitingDetail({ ts: 1_000 })
    const keyA = promptFingerprint(staleDetail)
    const staleListRow = waitingCard({ ts: 1_000 })
    const freshDetail = waitingDetail({
      status: 'running',
      waiting_kind: undefined,
      permission: undefined,
      ts: 2_800,
    })

    applySessionOptimistic({
      id: 's1',
      opId: 'op-allow-2',
      kind: 'prompt-submit',
      suppressedPromptKey: keyA,
      createdAt: 2_000,
      ttlMs: 5_000,
      baseline: {
        status: 'waiting',
        ts: 1_000,
        waitingKind: 'permission_prompt',
        promptKey: keyA,
      },
    })
    acceptSessionOptimistic('s1', 'op-allow-2', 2_500)

    // Detail poll settles first while list cache is still waiting -> keep overlay for list
    reconcileSessionDetail('s1', freshDetail, 2_900, { listRow: staleListRow })

    // Even if TTL expires before the list polls again, no false timeout toast fires
    vi.advanceTimersByTime(5_100)
    expect(timeouts).toEqual([])

    // Now test hard-settle when a brand-new permission B arrives on detail
    const permB = waitingDetail({
      ts: 3_500,
      permission: {
        tool: 'edit_file',
        text: 'edit_file a.ts',
        summary: 'a.ts',
      },
    })
    applySessionOptimistic({
      id: 's1',
      opId: 'op-allow-3',
      kind: 'prompt-submit',
      suppressedPromptKey: keyA,
      createdAt: 3_000,
      ttlMs: 5_000,
      baseline: {
        status: 'waiting',
        ts: 1_000,
        waitingKind: 'permission_prompt',
        promptKey: keyA,
      },
    })
    acceptSessionOptimistic('s1', 'op-allow-3', 3_100)
    reconcileSessionDetail('s1', permB, 3_600, { listRow: staleListRow })
    // Overlay was deleted immediately (not held for staleListRow), so no timeout fires
    vi.advanceTimersByTime(6_000)
    expect(timeouts).toEqual([])
    unsub()
  })
})

describe('ticket optimistic settlement without cross-query flicker', () => {
  it('coordinates ticket show and list settlement without tearing either surface', () => {
    const staleShow: CollabShow = {
      v: 1,
      ok: true,
      sessions: {},
      ticket: {
        id: 't1',
        title: 'Fix',
        from: 'a',
        to: 'b',
        repos: ['b'],
        runs: 1,
        status: 'waiting_initiator',
        updated_at: '2026-11-28T00:00:00Z',
        running: [],
        manager_session: { state: 'parked', profile: 'claude' },
      },
      sections: [],
      runs: [],
      children: [],
      children_detail: [],
      proposals: [],
      questions: {
        questions: [
          {
            question: 'Q?',
            multi_select: false,
            options: [{ label: 'Yes' }],
          },
        ],
      },
    }
    const freshList: CollabList = {
      v: 1,
      ok: true,
      total: 1,
      tickets: [
        {
          ...staleShow.ticket!,
          status: 'in_progress',
          updated_at: '2026-11-28T00:01:00Z',
        },
      ],
    }
    applyTicketOptimistic({
      id: 't1',
      opId: 'op-t1',
      kind: 'reply',
      continueRun: true,
      baseline: {
        status: 'waiting_initiator',
        updated: '2026-11-28T00:00:00Z',
      },
    })
    acceptTicketOptimistic('t1', 'op-t1', 1_000)

    // List settles while show cache is still stale
    reconcileTicketList(freshList, 1_500, { getShow: () => staleShow })

    const partialOverlay = {
      id: 't1',
      opId: 'op-t1',
      kind: 'reply' as const,
      phase: 'settling' as const,
      createdAt: 1_000,
      acceptedAt: 1_000,
      ttlMs: 15_000,
      continueRun: true,
      settledOn: { list: true },
      baseline: {
        status: 'waiting_initiator',
        updated: '2026-11-28T00:00:00Z',
      },
    }
    expect(
      applyCollabShowOverlay(staleShow, partialOverlay, 1_600)?.questions,
    ).toBeNull()
    expect(
      applyCollabListOverlay(
        freshList,
        new Map([['t1', partialOverlay]]),
        1_600,
      )?.tickets[0].status,
    ).toBe('in_progress')
    const health: CollabHealth = {
      v: 1,
      ok: true,
      seq_head: 1,
      tickets: 1,
      running: 1,
      queued: 0,
      waiting_human: 0,
      by_status: { in_progress: 1 },
    }
    expect(
      applyCollabHealthOverlay(health, new Map([['t1', partialOverlay]]), 1_600)
        ?.waiting_human,
    ).toBe(0)

    reconcileTicketShow(
      't1',
      { ...staleShow, ticket: freshList.tickets[0], questions: null },
      1_700,
      { listRow: freshList.tickets[0] },
    )
  })
})
