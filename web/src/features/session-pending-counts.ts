import type { Pending } from './chat-pending'

export function countPendingFailures(items: Array<Pending>) {
  const unconfirmedCount = items.filter((item) => item.state === 'lost').length
  const failedCount = items.filter((item) => item.state === 'failed').length
  return {
    unconfirmedCount,
    failedCount,
    unsettledCount: unconfirmedCount + failedCount,
  }
}
