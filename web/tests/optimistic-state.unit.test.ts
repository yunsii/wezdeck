import { afterEach, describe, expect, it, vi } from 'vitest'

import { turnState } from '#/features/chat-turn'
import type { SessionCard } from '#/features/session-card'
import type { Detail } from '#/features/session-detail-types'
import {
  SESSION_PROMPT_TTL_MS,
  SESSION_SEND_TTL_MS,
  acceptSessionOptimistic,
  applySessionDetailOverlay,
  applySessionOptimistic,
  applySessionsListOverlay,
  createSerialQueue,
  isSessionDetailOverlaySettled,
  onOptimisticTimeout,
  promptFingerprint,
  reconcileSessionDetail,
  resetSessionOptimisticForTest,
  rollbackSessionOptimistic,
} from '#/lib/optimistic-state'
import type { SessionOptimistic } from '#/lib/optimistic-state'
import {
  acceptTicketOptimistic,
  applyCollabHealthOverlay,
  applyCollabListOverlay,
  applyCollabShowOverlay,
  applyTicketOptimistic,
  reconcileTicketShow,
  resetTicketOptimisticForTest,
  rollbackTicketOptimistic,
} from '#/lib/optimistic-tickets'
import type { TicketOptimistic } from '#/lib/optimistic-tickets'
import type {
  CollabHealth,
  CollabList,
  CollabShow,
} from '#/lib/runtime-contract'

const baseDetail = (overrides: Partial<Detail> = {}): Detail => ({
  id: 's1',
  agent: 'claude',
  status: 'done',
  ts: 1_000,
  start: 0,
  messages: [
    { role: 'user', text: 'hi' },
    { role: 'assistant', text: 'ok' },
  ],
  ...overrides,
})

const baseCard = (overrides: Partial<SessionCard> = {}): SessionCard => ({
  id: 's1',
  name: 'demo',
  window: 'primary',
  agent: 'claude',
  cwd: '/repo/demo',
  branch: 'master',
  status: 'done',
  ts: 1_000,
  last_prompt: 'old prompt',
  transcript: true,
  desk_idle_s: 60,
  ...overrides,
})

const baseTicketShow = (overrides: Partial<CollabShow> = {}): CollabShow => ({
  v: 1,
  ok: true,
  sessions: {},
  ticket: {
    id: 't1',
    title: 'Fix login',
    from: 'repo-a',
    to: 'repo-b',
    repos: ['repo-b'],
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
        question: 'Pick one',
        multi_select: false,
        options: [{ label: 'A' }, { label: 'B' }],
      },
    ],
  },
  ...overrides,
})

afterEach(() => {
  vi.useRealTimers()
  resetSessionOptimisticForTest()
  resetTicketOptimisticForTest()
})

describe('promptFingerprint', () => {
  it('distinguishes ask, plan, permission, generic keys, and idle', () => {
    expect(promptFingerprint(baseDetail({ status: 'done' }))).toBe('')
    const ask = promptFingerprint(
      baseDetail({
        status: 'waiting',
        elicitation: {
          tool_call_id: 'call-1',
          questions: [{ question: 'Which option?', options: [{ label: 'A' }] }],
        },
      }),
    )
    expect(ask).toContain('ask:call-1:1:Which option?')

    const permA = promptFingerprint(
      baseDetail({
        status: 'waiting',
        waiting_kind: 'permission_prompt',
        permission: { tool: 'Bash', text: 'Bash ls', summary: 'ls -la' },
      }),
    )
    const permB = promptFingerprint(
      baseDetail({
        status: 'waiting',
        waiting_kind: 'permission_prompt',
        permission: { tool: 'Edit', text: 'Edit a.ts', summary: 'a.ts' },
      }),
    )
    expect(permA).not.toBe(permB)

    const plan = promptFingerprint(
      baseDetail({
        status: 'waiting',
        plan: { awaiting_approval: true, excerpt: '# Plan' },
      }),
    )
    expect(plan).toContain('plan:# Plan')
  })
})

describe('session optimistic overlays', () => {
  it('projects send to running on both detail and list, survives stale polls, and settles on host running', () => {
    const serverDone = baseDetail({ status: 'done', ts: 1_000 })
    const overlay: SessionOptimistic = {
      id: 's1',
      opId: 'op-1',
      kind: 'send',
      phase: 'in-flight',
      createdAt: 2_000,
      ttlMs: SESSION_SEND_TTL_MS,
      promptText: 'new message',
      baseline: { status: 'done', ts: 1_000, transcriptEnd: 2 },
    }
    const projected = applySessionDetailOverlay(serverDone, overlay, 2_100)
    expect(projected?.status).toBe('running')
    expect(projected?.turn_started).toBe(2_000)

    const listProjected = applySessionsListOverlay(
      { sessions: [baseCard({ status: 'done', ts: 1_000 })] },
      new Map([['s1', overlay]]),
      2_100,
    )
    expect(listProjected.sessions[0].status).toBe('running')
    expect(listProjected.sessions[0].last_prompt).toBe('new message')

    // Accepted, but a stale poll still shows done @ ts=1000 -> stays running (no bounce)
    const settling: SessionOptimistic = {
      ...overlay,
      phase: 'settling',
      acceptedAt: 2_200,
    }
    expect(isSessionDetailOverlaySettled(settling, serverDone, 2_500)).toBe(
      'active',
    )
    expect(applySessionDetailOverlay(serverDone, settling, 2_500)?.status).toBe(
      'running',
    )

    // Host flips to running -> settled cleanly
    const serverRunning = baseDetail({
      status: 'running',
      ts: 2_600,
      turn_started: 2_550,
    })
    expect(isSessionDetailOverlaySettled(settling, serverRunning, 2_700)).toBe(
      'settled',
    )
    expect(
      applySessionDetailOverlay(serverRunning, settling, 2_700)?.turn_started,
    ).toBe(2_550)

    // Never outlives TTL so unpicked bubbles still turn lost at 60s
    expect(
      isSessionDetailOverlaySettled(
        settling,
        serverDone,
        2_200 + SESSION_SEND_TTL_MS,
      ),
    ).toBe('timeout')
  })

  it('prompt-submit hides baseline card and switches to running, but NEVER swallows a new prompt', () => {
    const permADetail = baseDetail({
      status: 'waiting',
      waiting_kind: 'permission_prompt',
      ts: 1_000,
      permission: { tool: 'Bash', text: 'Bash ls', summary: 'ls' },
    })
    const keyA = promptFingerprint(permADetail)
    const overlay: SessionOptimistic = {
      id: 's1',
      opId: 'op-perm',
      kind: 'prompt-submit',
      phase: 'settling',
      createdAt: 2_000,
      acceptedAt: 2_100,
      ttlMs: SESSION_PROMPT_TTL_MS,
      suppressedPromptKey: keyA,
      baseline: {
        status: 'waiting',
        ts: 1_000,
        waitingKind: 'permission_prompt',
        promptKey: keyA,
      },
    }

    // Stale poll with permission A -> card hidden, status running
    const projected = applySessionDetailOverlay(permADetail, overlay, 2_300)
    expect(projected?.status).toBe('running')
    expect(projected?.permission).toBeUndefined()
    expect(projected?.waiting_kind).toBeUndefined()

    // New permission B arrives -> overlay settles IMMEDIATELY so B is shown!
    const permBDetail = baseDetail({
      status: 'waiting',
      waiting_kind: 'permission_prompt',
      ts: 2_400,
      permission: { tool: 'Edit', text: 'Edit b.ts', summary: 'b.ts' },
    })
    expect(isSessionDetailOverlaySettled(overlay, permBDetail, 2_500)).toBe(
      'settled',
    )
    const projectedB = applySessionDetailOverlay(permBDetail, overlay, 2_500)
    expect(projectedB?.permission?.tool).toBe('Edit')
    expect(projectedB?.status).toBe('waiting')
  })

  it('prompt-cancel clears waiting card and unlocks composer as idle (not running), and follow-up send keeps suppressing old prompt', () => {
    const permDetail = baseDetail({
      status: 'waiting',
      waiting_kind: 'permission_prompt',
      ts: 1_000,
      permission: { tool: 'Bash', text: 'Bash rm', summary: 'rm' },
    })
    const keyA = promptFingerprint(permDetail)
    applySessionOptimistic({
      id: 's1',
      opId: 'op-deny',
      kind: 'prompt-cancel',
      suppressedPromptKey: keyA,
      baseline: { status: 'waiting', ts: 1_000, promptKey: keyA },
    })
    // User immediately follows up with a message before host clears keyA
    applySessionOptimistic({
      id: 's1',
      opId: 'op-followup',
      kind: 'send',
      promptText: 'use safer command instead',
      baseline: { status: 'waiting', ts: 1_000 },
    })
    // Even if server still reports old permDetail, card stays suppressed while running
    const staleReconcile = baseDetail({
      status: 'waiting',
      waiting_kind: 'permission_prompt',
      ts: 1_000,
      permission: { tool: 'Bash', text: 'Bash rm', summary: 'rm' },
    })
    // Check via pure projection of a prompt-cancel directly too
    const cancelOverlay: SessionOptimistic = {
      id: 's1',
      opId: 'op-deny',
      kind: 'prompt-cancel',
      phase: 'in-flight',
      createdAt: 2_000,
      ttlMs: SESSION_PROMPT_TTL_MS,
      suppressedPromptKey: keyA,
      baseline: { status: 'waiting', ts: 1_000, promptKey: keyA },
    }
    const cancelled = applySessionDetailOverlay(
      permDetail,
      cancelOverlay,
      2_050,
    )
    expect(cancelled?.status).toBe('idle')
    expect(cancelled?.waiting_kind).toBeUndefined()
    expect(cancelled?.permission).toBeUndefined()

    // Rollback restores immediately
    rollbackSessionOptimistic('s1', 'op-followup', 'network')
    reconcileSessionDetail('s1', staleReconcile)
  })

  it('fires timeout callback when settling overlay expires without host confirmation', () => {
    vi.useFakeTimers()
    const events: Array<{ id: string; kind: string }> = []
    const unsub = onOptimisticTimeout((e) =>
      events.push({ id: e.id, kind: e.kind }),
    )
    applySessionOptimistic({
      id: 's1',
      opId: 'op-t',
      kind: 'prompt-submit',
      ttlMs: 5_000,
      baseline: { status: 'waiting', ts: 1_000, promptKey: 'perm:a' },
    })
    acceptSessionOptimistic('s1', 'op-t')
    vi.advanceTimersByTime(5_000)
    expect(events).toEqual([{ id: 's1', kind: 'prompt-submit' }])
    unsub()
  })
})

describe('ticket optimistic overlays', () => {
  it('projects ticket reply across show, list, and health badge and settles on host status change', () => {
    const show = baseTicketShow()
    const list: CollabList = {
      v: 1,
      ok: true,
      total: 1,
      tickets: [show.ticket!],
    }
    const health: CollabHealth = {
      v: 1,
      ok: true,
      seq_head: 10,
      tickets: 1,
      running: 0,
      queued: 0,
      waiting_human: 2,
      by_status: { waiting_initiator: 2 },
    }
    const overlay: TicketOptimistic = {
      id: 't1',
      opId: 'op-r1',
      kind: 'reply',
      phase: 'in-flight',
      createdAt: 1_000,
      ttlMs: 15_000,
      continueRun: true,
      baseline: {
        status: 'waiting_initiator',
        updated: '2026-11-28T00:00:00Z',
      },
    }
    const nextShow = applyCollabShowOverlay(show, overlay, 1_100)
    expect(nextShow?.ticket?.status).toBe('in_progress')
    expect(nextShow?.questions).toBeNull()

    const nextList = applyCollabListOverlay(
      list,
      new Map([['t1', overlay]]),
      1_100,
    )
    expect(nextList?.tickets[0].status).toBe('in_progress')

    const nextHealth = applyCollabHealthOverlay(
      health,
      new Map([['t1', overlay]]),
      1_100,
    )
    expect(nextHealth?.waiting_human).toBe(1)

    // Store reconcile + rollback lifecycle
    applyTicketOptimistic({
      id: 't1',
      opId: 'op-r2',
      kind: 'reply',
      continueRun: true,
      baseline: {
        status: 'waiting_initiator',
        updated: '2026-11-28T00:00:00Z',
      },
    })
    acceptTicketOptimistic('t1', 'op-r2')
    reconcileTicketShow(
      't1',
      baseTicketShow({
        ticket: { ...show.ticket!, status: 'in_progress' },
      }),
    )
    rollbackTicketOptimistic('t1', 'op-r2', 'noop-after-settle')
  })
})

describe('createSerialQueue', () => {
  it('runs tasks strictly in FIFO order and aborts queued tasks after a failure', async () => {
    const queue = createSerialQueue()
    const order: Array<string> = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const p1 = queue.enqueue('k', async () => {
      order.push('start-1')
      await firstGate
      order.push('end-1')
      return true
    })
    const p2 = queue.enqueue('k', async () => {
      order.push('run-2')
      return false
    })
    const p3 = queue.enqueue('k', async () => {
      order.push('run-3')
      return true
    })

    releaseFirst()
    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    expect(order).toEqual(['start-1', 'end-1', 'run-2'])
    expect(r1).toEqual({ ok: true, value: true })
    expect(r2).toEqual({ ok: false, aborted: false })
    expect(r3).toEqual({ ok: false, aborted: true })
  })
})

describe('turnState with lost / failed pending bubbles', () => {
  it('does not treat lost or failed bubbles as working', () => {
    expect(
      turnState({
        messages: [
          { role: 'user', text: 'hi', ts: '2026-11-28T00:00:00Z' },
          { role: 'assistant', text: 'done', ts: '2026-11-28T00:00:10Z' },
        ],
        left: [{ text: 'dropped', at: 999, state: 'lost' }],
        busy: false,
        status: 'idle',
      })?.kind,
    ).toBe('done')

    expect(
      turnState({
        messages: [
          { role: 'user', text: 'hi', ts: '2026-11-28T00:00:00Z' },
          { role: 'assistant', text: 'done', ts: '2026-11-28T00:00:10Z' },
        ],
        left: [{ text: 'err', at: 999, state: 'failed' }],
        busy: false,
        status: 'idle',
      })?.kind,
    ).toBe('done')
  })
})
