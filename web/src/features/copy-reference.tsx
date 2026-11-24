// 复制引用 from a list (工单 / 会话): the list rows carry no reference — it
// is built per item by the host (`ticket api show`, the relay's `session`
// reply) and the lists poll — so a copy reads it on demand, straight from the
// cache when the item was open just now, and writes it inside the click
// (copyTextLater). One toast says what landed or why not.
import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { Check, Hash } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { copyTextLater } from '#/lib/clipboard'
import { collabKey } from '#/lib/collab-query'
import { getCollab, hostRead } from '#/lib/runtime-client'
import { cn } from '#/lib/utils'

type CopyFn = (id: string) => Promise<boolean>

function useCopyReference(load: (id: string) => Promise<string>): CopyFn {
  const { t } = useLingui()
  return (id) =>
    copyTextLater(load(id)).then(
      () => {
        toast(t`Copied reference`)
        return true
      },
      (error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error)
        toast.error(t`Could not copy the reference: ${reason}`)
        return false
      },
    )
}

/** a ticket's reference.py block (`ticket api show`) */
export function useCopyTicketReference(): CopyFn {
  const client = useQueryClient()
  return useCopyReference((id) =>
    client
      .fetchQuery({
        queryKey: collabKey('show', { id }),
        queryFn: () => getCollab('show', { id }),
        staleTime: 10_000,
      })
      .then((data) => {
        if (!data.ok || !data.reference)
          throw new Error(data.error?.message ?? 'no reference')
        return data.reference
      }),
  )
}

/** a session's remote_reference.go block: the open session's cache, else a
 * one-message read (the block rides on every `session` reply) */
export function useCopySessionReference(): CopyFn {
  const client = useQueryClient()
  return useCopyReference(async (id) => {
    const cached = client.getQueryData<{ reference?: string }>([
      'remote',
      'session',
      id,
    ])
    if (cached?.reference) return cached.reference
    const reply = (await hostRead('session', { id, limit: 1 })) as {
      reference?: string
      error?: string
    }
    if (!reply.reference) throw new Error(reply.error ?? 'no reference')
    return reply.reference
  })
}

/**
 * The row's copy key — # for "reference", not the generic copy glyph — a
 * sibling of the row link (no button inside an a): on a phone always shown,
 * wide on hover / focus. The row's container needs
 * `group/row relative` and room at its bottom-right.
 */
export function RowCopyButton({ id, copy }: { id: string; copy: CopyFn }) {
  const { t } = useLingui()
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="plain"
      type="button"
      aria-label={t`Copy reference`}
      title={t`Copy reference`}
      data-testid="row-copy-reference"
      onClick={() => {
        void copy(id).then((ok) => {
          if (!ok) return
          setCopied(true)
          setTimeout(() => setCopied(false), 1_500)
        })
      }}
      className={cn(
        // under the time, right edges lined up (the row's px-4)
        'absolute right-1 bottom-1 grid size-10 place-items-center rounded-lg text-brand-label outline-none hover:text-brand-text focus-visible:ring-2 focus-visible:ring-brand-running md:right-2 md:size-7',
        !copied &&
          'md:opacity-0 md:group-hover/row:opacity-100 md:focus-visible:opacity-100',
      )}
    >
      {copied ? (
        <Check size={14} className="text-brand-done" aria-hidden />
      ) : (
        <Hash size={14} aria-hidden />
      )}
    </Button>
  )
}

/** y: copy the open item's reference (wide split, beside j / k) */
export function CopyKey({ id, copy }: { id: string; copy: CopyFn }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        event.key !== 'y' ||
        !id ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest('input, textarea, select, [contenteditable="true"]') ||
        document.querySelector('[role="dialog"]')
      )
        return
      event.preventDefault()
      void copy(id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [id, copy])
  return null
}
