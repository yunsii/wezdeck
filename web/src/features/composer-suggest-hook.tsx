// Composer suggestion controller for `#` repo ticket mentions and recent
// host-sent messages. Coordinates strictly below `/` skill/command completion:
//   - `#` ticket mention: active starts at 0, ↑/↓ move, Tab/Enter pick, Esc closes.
//   - History autocomplete: active starts at -1 so Enter ALWAYS sends normally;
//     Tab accepts the top candidate, ↑/↓ enters highlight mode where Enter/Tab
//     accepts, and Esc dismisses for the current input text.
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { collabKey } from '#/lib/collab-query'
import { trace } from '#/lib/client-trace'
import { getCollab } from '#/lib/runtime-client'
import type { Composer } from './session-composer'
import { useSentHistory } from './sent-history-data'
import { useRepoTickets } from './session-tickets'
import {
  applyTicketCompletion,
  matchSentSuggestions,
  matchTicketSuggestions,
  ticketMentionQuery,
} from './composer-suggest'
import type { SentSuggestion, TicketSuggestion } from './composer-suggest'
import { SentSuggestList, TicketSuggestList } from './composer-suggest-list'

export function useComposerSuggestions(
  composer: Pick<
    Composer,
    | 'id'
    | 'text'
    | 'setText'
    | 'replacePayload'
    | 'appendPayload'
    | 'textareaRef'
  >,
  suppressed: boolean,
) {
  const client = useQueryClient()
  const [caret, setCaret] = useState(-1)
  const [active, setActive] = useState(-1)
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  const [lastKey, setLastKey] = useState<string | null>(null)

  const sent = useSentHistory({
    scope: 'repo',
    session: composer.id,
    enabled: Boolean(composer.id),
    limit: 80,
  })
  const repoTickets = useRepoTickets(composer.id, Boolean(composer.id))

  const focused = caret >= 0 && !suppressed
  const ticketToken = focused ? ticketMentionQuery(composer.text, caret) : null
  const ticketItems = ticketToken
    ? matchTicketSuggestions(repoTickets.openTickets, ticketToken.query)
    : []
  const sentItems =
    focused && !ticketToken
      ? matchSentSuggestions(
          sent.data?.items ?? [],
          composer.text,
          composer.id,
          5,
        )
      : []

  const mode: 'ticket' | 'sent' | 'none' = ticketItems.length
    ? 'ticket'
    : sentItems.length
      ? 'sent'
      : 'none'
  const tokenKey =
    mode === 'ticket' && ticketToken
      ? `t:${ticketToken.start}:${ticketToken.query}`
      : mode === 'sent'
        ? `s:${composer.text.trim()}`
        : null
  const open = Boolean(tokenKey && tokenKey !== dismissedKey)

  if (tokenKey !== lastKey) {
    setLastKey(tokenKey)
    setActive(mode === 'ticket' ? 0 : -1)
  }

  const focusAt = (pos: number) =>
    requestAnimationFrame(() => {
      const box = composer.textareaRef.current
      if (!box) return
      box.focus()
      box.setSelectionRange(pos, pos)
      setCaret(pos)
    })

  const pickSent = (item: SentSuggestion, via: string) => {
    composer.replacePayload({
      text: item.text,
      attachments: item.attachments,
    })
    setDismissedKey(`s:${item.text.trim()}`)
    trace('composer-suggest', {
      source: 'sent',
      via,
      attachments: item.attachments.length,
    })
    focusAt(item.text.length)
  }

  const pickTicket = async (item: TicketSuggestion, via: string) => {
    if (!ticketToken) return
    let insert = `${item.id} (${item.title})`
    let attachments: Array<string> = []
    try {
      const show = await client.fetchQuery({
        queryKey: collabKey('show', { id: item.id }),
        queryFn: () => getCollab('show', { id: item.id }),
        staleTime: 10_000,
      })
      if (show.ok && show.reference) {
        insert = show.reference.trim()
      }
      if (show.ok && show.attachments?.length) {
        attachments = show.attachments
      }
    } catch {
      // fall back to id + title
    }
    const next = applyTicketCompletion(
      composer.text,
      ticketToken.start,
      caret,
      insert,
    )
    composer.setText(next.text)
    if (attachments.length > 0) {
      composer.appendPayload({ text: '', attachments })
    }
    setDismissedKey(tokenKey)
    trace('composer-suggest', {
      source: 'ticket',
      via,
      attachments: attachments.length,
    })
    focusAt(next.caret)
  }

  const key = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return false
    if (event.nativeEvent.isComposing || event.keyCode === 229) return false
    const count = mode === 'ticket' ? ticketItems.length : sentItems.length
    if (count === 0) return false

    if (event.key === 'Escape') {
      event.preventDefault()
      setDismissedKey(tokenKey)
      return true
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((cur) => (cur < 0 ? 0 : (cur + 1) % count))
      return true
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((cur) => (cur <= 0 ? count - 1 : cur - 1))
      return true
    }
    if (event.key === 'Tab') {
      if (event.shiftKey) return false
      event.preventDefault()
      const idx = active >= 0 ? Math.min(active, count - 1) : 0
      if (mode === 'ticket') void pickTicket(ticketItems[idx], 'tab')
      else pickSent(sentItems[idx], 'tab')
      return true
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      // History suggestions never hijack Enter unless the user explicitly
      // navigated into the list with ↑/↓ (`active >= 0`).
      if (mode === 'sent' && active < 0) return false
      event.preventDefault()
      const idx = Math.max(0, Math.min(active, count - 1))
      if (mode === 'ticket') void pickTicket(ticketItems[idx], 'enter')
      else pickSent(sentItems[idx], 'enter')
      return true
    }
    return false
  }

  const track = (position: number | null) => setCaret(position ?? -1)

  const list =
    open && mode === 'ticket' ? (
      <TicketSuggestList
        items={ticketItems}
        active={active}
        onHover={setActive}
        onPick={(item) => void pickTicket(item, 'tap')}
      />
    ) : open && mode === 'sent' ? (
      <SentSuggestList
        items={sentItems}
        active={active}
        onHover={setActive}
        onPick={(item) => pickSent(item, 'tap')}
      />
    ) : null

  return {
    open,
    key,
    track,
    list,
    active,
  }
}
