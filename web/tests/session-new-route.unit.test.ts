import { describe, expect, it } from 'vitest'

import {
  NEW_SESSION_ID,
  isNewSessionId,
  isVirtualSessionId,
  jobIdFromSessionId,
  jobSessionId,
  resolveJobTargetSessionId,
  stageStepState,
} from '#/features/session-new-route'

describe('session-new virtual route helpers', () => {
  it('classifies new and job virtual session ids cleanly', () => {
    expect(isNewSessionId(NEW_SESSION_ID)).toBe(true)
    expect(isNewSessionId('abc')).toBe(false)
    expect(jobIdFromSessionId(jobSessionId('a1b2'))).toBe('a1b2')
    expect(jobIdFromSessionId('job-')).toBeNull()
    expect(jobIdFromSessionId('real-session')).toBeNull()
    expect(isVirtualSessionId('new')).toBe(true)
    expect(isVirtualSessionId('job-1234')).toBe(true)
    expect(isVirtualSessionId('real-session')).toBe(false)
  })

  it('resolves real session id from job.session_id or newly listed worktree session', () => {
    expect(
      resolveJobTargetSessionId(
        { stage: 'starting', worktree: '/wt/a' },
        [{ id: 's1', worktree: '/wt/a', cwd: '/wt/a' }],
        new Set(),
      ),
    ).toEqual({})

    expect(
      resolveJobTargetSessionId(
        { stage: 'done', session_id: 's2', worktree: '/wt/a' },
        [{ id: 's2', worktree: '/wt/a', cwd: '/wt/a' }],
        new Set(['s1']),
      ),
    ).toEqual({ targetId: 's2', visitPath: '/wt/a' })

    expect(
      resolveJobTargetSessionId(
        { stage: 'done', worktree: '/wt/a' },
        [
          { id: 's1', worktree: '/wt/a', cwd: '/wt/a' },
          { id: 's2', worktree: '/wt/a', cwd: '/wt/a' },
        ],
        new Set(['s1']),
      ),
    ).toEqual({ targetId: 's2', visitPath: '/wt/a' })
  })

  it('maps job stage to three-step progress states', () => {
    expect(stageStepState('creating', 'workspace')).toBe('active')
    expect(stageStepState('creating', 'agent')).toBe('pending')
    expect(stageStepState('starting', 'workspace')).toBe('done')
    expect(stageStepState('starting', 'agent')).toBe('active')
    expect(stageStepState('waiting_trust', 'agent')).toBe('active')
    expect(stageStepState('sending', 'agent')).toBe('done')
    expect(stageStepState('sending', 'send')).toBe('active')
    expect(stageStepState('done', 'send')).toBe('done')
    expect(stageStepState('failed', 'workspace')).toBe('error')
  })
})
