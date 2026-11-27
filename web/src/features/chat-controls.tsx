// Thread navigation controls above and below the conversation: the paging bar
// for loading earlier messages and the floating JumpLatest chip when unpinned.
import { useLingui } from '@lingui/react/macro'
import { ArrowDown } from 'lucide-react'

import { Button } from '#/components/ui/button'

export function JumpLatest({
  pinned,
  unread,
  onJump,
}: {
  pinned: boolean
  unread: number
  onJump: () => void
}) {
  const { t } = useLingui()
  if (pinned) return null
  return (
    <Button
      variant="plain"
      type="button"
      onClick={onJump}
      data-testid="jump-latest"
      // a light chip with an edge and a deep shadow, not the dark solid
      // style: it floats over the conversation, and over a user bubble
      // (same dark fill) the solid chip vanished
      className="key-press chat-in absolute -top-12 left-1/2 inline-flex min-h-10 -translate-x-1/2 items-center gap-1.5 rounded-full border border-brand-edge bg-brand-surface px-4 text-caption font-medium text-brand-text shadow-[0_8px_24px_rgb(0_0_0/0.22)]"
    >
      <ArrowDown size={15} aria-hidden />
      {unread > 0 ? t`${unread} new` : t`Latest`}
    </Button>
  )
}

export function ThreadPagingBar({
  total,
  shown,
  start,
  pagingIn,
  atCompaction,
  autoFailed = false,
  onLoadEarlier,
}: {
  total: number
  shown: number
  start: number
  pagingIn: boolean
  atCompaction: boolean
  autoFailed?: boolean
  onLoadEarlier: () => void
}) {
  const { t } = useLingui()
  if (total <= 0) return null
  return (
    <div
      data-testid="thread-paging-bar"
      className="flex items-center justify-between gap-2 px-1 text-meta text-brand-label"
    >
      <span>{t`${total} messages, showing ${shown}`}</span>
      {start > 0 ? (
        <Button
          variant="plain"
          type="button"
          data-testid="load-earlier"
          disabled={pagingIn}
          onClick={onLoadEarlier}
          className="min-h-9 rounded-full bg-brand-surface px-3 text-brand-text"
        >
          {pagingIn
            ? t`Loading…`
            : atCompaction
              ? t`Show history before compaction`
              : autoFailed
                ? t`Retry loading earlier`
                : t`Load earlier`}
        </Button>
      ) : null}
    </div>
  )
}
