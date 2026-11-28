import type { Pending } from './chat-pending'

export function createPendingBubbleProps(
  pending: Array<Pending>,
  resend: (item: Pending) => void,
  dismiss: (item: Pending) => void,
) {
  return (
    canWrite: boolean,
    onEdit?: (item: Pending) => void,
    onTicket?: (item: Pending) => void,
  ) => ({
    pending,
    onResend: canWrite ? resend : undefined,
    onEdit,
    onTicket: canWrite ? onTicket : undefined,
    onDismiss: dismiss,
  })
}
