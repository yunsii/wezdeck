import type { QueryClient } from '@tanstack/react-query'
import {
  acceptSessionOptimistic,
  applySessionOptimistic,
  rollbackSessionOptimistic,
} from '#/lib/optimistic-state'
import { hostWrite } from '#/lib/runtime-client'
import { trace } from '#/lib/client-trace'
import { followSessionReply } from './session-send-helpers'
import type { buildSessionBaseline } from './session-send-helpers'

export type WriteRunner = (
  target: string,
  job: () => Promise<void>,
  opts?: { lockComposer?: boolean; invalidate?: boolean },
) => Promise<boolean>

export function createRunSessionAction({
  target,
  baseline,
  client,
  follow,
  resolvingRef,
  write,
  onInterrupted,
  interruptNotConfirmed,
}: {
  target: string
  baseline: () => ReturnType<typeof buildSessionBaseline>
  client: QueryClient
  follow: (from: string, to: string) => void
  resolvingRef: { current: number }
  write: WriteRunner
  onInterrupted: () => void
  interruptNotConfirmed: () => string
}) {
  return (action: 'key' | 'session.restart', args: Record<string, unknown>) => {
    const op_id = crypto.randomUUID()
    const isInterrupt = action === 'key' && args.interrupt === true
    const invalidate = action !== 'key' || resolvingRef.current === 0
    if (isInterrupt) {
      applySessionOptimistic({
        id: target,
        opId: op_id,
        kind: 'interrupt',
        baseline: baseline(),
      })
    }
    return write(
      target,
      async () => {
        trace('web-write', { id: target, op_id, action, stage: 'requested' })
        try {
          const reply = await hostWrite(action, {
            id: target,
            ...args,
            client_op: op_id,
          })
          if (action === 'session.restart' && args.fresh === true)
            followSessionReply(follow, target, reply)
          if (
            isInterrupt &&
            reply &&
            typeof reply === 'object' &&
            'interrupted' in reply &&
            typeof reply.interrupted === 'boolean'
          ) {
            if (reply.interrupted) {
              acceptSessionOptimistic(target, op_id)
              onInterrupted()
            } else {
              rollbackSessionOptimistic(target, op_id, 'not-confirmed')
              throw new Error(interruptNotConfirmed())
            }
          } else if (isInterrupt) {
            acceptSessionOptimistic(target, op_id)
          }
          if (invalidate) {
            void client.invalidateQueries({ queryKey: ['remote', 'sessions'] })
          }
          trace('web-write', {
            id: target,
            op_id,
            action,
            stage: 'host-accepted',
          })
        } catch (error) {
          if (isInterrupt) {
            rollbackSessionOptimistic(target, op_id, (error as Error).message)
          }
          trace('web-write', { id: target, op_id, action, stage: 'failed' })
          throw error
        }
      },
      { lockComposer: action === 'session.restart', invalidate },
    )
  }
}
