import { useQueryClient } from '@tanstack/react-query'
import { marked } from 'marked'
import type { Token, Tokens } from 'marked'
import { useEffect, useState } from 'react'

import type { Detail } from './console-sessions'
import type { SessionCard } from './session-card'
import { detailKey } from './session-detail-read'

const previewCache = new WeakMap<object, string>()

function inlineText(tokens: Array<Token>): string {
  return tokens
    .map((token) => {
      if (token.type === 'html') return ''
      if ('tokens' in token && token.tokens?.length)
        return inlineText(token.tokens)
      return 'text' in token && typeof token.text === 'string' ? token.text : ''
    })
    .join('')
}

function blockText(tokens: Array<Token>): string {
  return tokens
    .map((token) => {
      if (token.type === 'list')
        return (token as Tokens.List).items
          .map((item) => blockText(item.tokens))
          .join(' ')
      if (token.type === 'table') {
        const table = token as Tokens.Table
        return [
          ...table.header.map((cell) => inlineText(cell.tokens)),
          ...table.rows.flatMap((row) =>
            row.map((cell) => inlineText(cell.tokens)),
          ),
        ].join(' ')
      }
      if (token.type === 'blockquote')
        return blockText((token as Tokens.Blockquote).tokens)
      if (token.type === 'html') return ''
      if ('tokens' in token && token.tokens?.length)
        return inlineText(token.tokens)
      return 'text' in token && typeof token.text === 'string' ? token.text : ''
    })
    .filter(Boolean)
    .join(' ')
}

function messagePreview(message: { text: string }): string {
  const cached = previewCache.get(message)
  if (cached !== undefined) return cached
  const plain = blockText(marked.lexer(message.text))
    .replace(/\s+/g, ' ')
    .trim()
  previewCache.set(message, plain)
  return plain
}

/** Only a detail snapshot from the finished turn may supply list text. */
export function cachedAgentReply(
  row: Pick<SessionCard, 'id' | 'status' | 'ts'>,
  detail?: Pick<Detail, 'id' | 'status' | 'ts' | 'messages'>,
): string {
  if (!detail || detail.id !== row.id) return ''
  if (!['done', 'idle'].includes(row.status)) return ''
  if (!['done', 'idle'].includes(detail.status)) return ''
  if (row.ts > 0 && (detail.ts ?? 0) < row.ts) return ''
  for (let index = (detail.messages?.length ?? 0) - 1; index >= 0; index--) {
    const message = detail.messages?.[index]
    if (message?.role === 'user' && !message.text.trim().startsWith('<')) break
    if (message?.role === 'assistant' && message.kind !== 'thought') {
      const text = messagePreview(message)
      if (text) return text
    }
  }
  return ''
}

/** Refresh list previews when background detail sync finishes. */
export function useReplyPreviews(rows: Array<SessionCard>) {
  const client = useQueryClient()
  const [, setRevision] = useState(0)
  useEffect(() => {
    const finished = new Map(
      rows
        .filter((row) => row.status === 'done' || row.status === 'idle')
        .map((row) => [row.id, row]),
    )
    const previews = new Map(
      [...finished].map(([id, row]) => [
        id,
        cachedAgentReply(row, client.getQueryData<Detail>(detailKey(id))),
      ]),
    )
    return client.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'success') return
      const [scope, type, id] = event.query.queryKey
      if (scope !== 'remote' || type !== 'session' || typeof id !== 'string')
        return
      const row = finished.get(id)
      if (!row) return
      const next = cachedAgentReply(row, event.query.state.data as Detail)
      if (next === previews.get(id)) return
      previews.set(id, next)
      setRevision((revision) => revision + 1)
    })
  }, [client, rows])

  return rows.map((row) => ({
    ...row,
    last_reply: cachedAgentReply(
      row,
      client.getQueryData<Detail>(detailKey(row.id)),
    ),
  }))
}
