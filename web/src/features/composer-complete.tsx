// The composer's `/` completion and the 能力 chip and sheet, kept out of
// session-composer.tsx: the hook hands back ready elements and the props the
// textarea needs. Matching and text edits are skill-complete.ts; the list,
// chip and sheet are session-skills.tsx.
import { useRef, useState } from 'react'

import { trace } from '#/lib/client-trace'
import { insertTokens } from './composer-tokens'
import type { Composer } from './session-composer'
import {
  CompletionList,
  SkillsChip,
  SkillsSheet,
  useCompletions,
  useSessionSkills,
} from './session-skills'
import {
  applyCompletion,
  completionQuery,
  matchCompletions,
} from './skill-complete'
import type { Completion, SkillsReply } from './skill-complete'

/**
 * The `/` completion and the 能力 sheet's state. The list shows while the
 * caret is in a trigger token (skill-complete.ts completionQuery) and Esc
 * has not dismissed that token; ↑ ↓ move, Tab / Enter pick, Esc closes.
 */
export function useSkillCompletion(
  composer: Pick<Composer, 'id' | 'text' | 'setText'>,
  session: { agent?: string; skills_rev?: string } | undefined,
  /** 交互调试: this list instead of reading the host */
  sample?: SkillsReply,
) {
  // "agent" is the reply's placeholder while the agent is unknown
  const agent =
    session?.agent && session.agent !== 'agent' ? session.agent : undefined
  const query = useSessionSkills(
    composer.id,
    session?.skills_rev,
    Boolean(agent) && !sample,
  )
  const reply = sample ?? query.data
  const entries = useCompletions(agent ? reply : undefined, agent)
  const ref = useRef<HTMLTextAreaElement>(null)
  // -1: the input is not focused (no list)
  const [caret, setCaret] = useState(-1)
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [sheet, setSheet] = useState(false)
  const token =
    agent && caret >= 0
      ? completionQuery(composer.text, caret, reply?.trigger || '/')
      : null
  const tokenId = token ? `${token.start}:${token.query}` : null
  const items =
    token && tokenId !== dismissed ? matchCompletions(entries, token.query) : []
  // a new token (or a new query) starts at the top
  const [lastToken, setLastToken] = useState<string | null>(null)
  if (tokenId !== lastToken) {
    setLastToken(tokenId)
    setActive(0)
  }
  const focusAt = (position: number) =>
    requestAnimationFrame(() => {
      const field = ref.current
      if (!field) return
      field.focus()
      field.setSelectionRange(position, position)
      setCaret(position)
    })
  const pick = (item: Completion, via: string) => {
    if (!token) return
    const next = applyCompletion(composer.text, token.start, caret, item.insert)
    composer.setText(next.text)
    trace('skill-complete', { name: item.name, kind: item.kind, via })
    focusAt(next.caret)
  }
  /** a tap in the sheet: at the caret (or the start), spaced like a token */
  const draft = (insert: string) => {
    const at =
      caret >= 0 ? caret : composer.text.trim() ? composer.text.length : 0
    const next = insertTokens(composer.text, at, [insert])
    composer.setText(next.text)
    setSheet(false)
    trace('skill-complete', { name: insert, via: 'sheet' })
    focusAt(next.caret)
  }
  const key = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!items.length) return false
    if (event.nativeEvent.isComposing || event.keyCode === 229) return false
    const move = (step: number) => {
      event.preventDefault()
      setActive((index) => (index + step + items.length) % items.length)
    }
    switch (event.key) {
      case 'ArrowDown':
        move(1)
        return true
      case 'ArrowUp':
        move(-1)
        return true
      case 'Tab':
      case 'Enter': {
        if (event.shiftKey) return false
        event.preventDefault()
        pick(
          items[Math.min(active, items.length - 1)],
          event.key === 'Tab' ? 'tab' : 'enter',
        )
        return true
      }
      case 'Escape':
        event.preventDefault()
        setDismissed(tokenId)
        return true
      default:
        return false
    }
  }
  const open = items.length > 0
  const track = (position: number | null) => setCaret(position ?? -1)
  return {
    key,
    /** the textarea's ref, combobox state and caret tracking */
    inputProps: {
      ref,
      role: open ? 'combobox' : undefined,
      'aria-expanded': open ? true : undefined,
      'aria-controls': open ? 'composer-completions' : undefined,
      'aria-activedescendant': open
        ? `composer-completion-${active}`
        : undefined,
      onSelect: (event: React.SyntheticEvent<HTMLTextAreaElement>) =>
        track(event.currentTarget.selectionStart),
      onBlur: () => track(null),
    },
    /** after setText in onChange */
    track,
    list: open ? (
      <CompletionList
        items={items}
        active={active}
        onHover={setActive}
        onPick={(item) => pick(item, 'tap')}
      />
    ) : null,
    chip: agent ? (
      <SkillsChip count={reply?.skills.length} onOpen={() => setSheet(true)} />
    ) : null,
    sheet: agent ? (
      <SkillsSheet
        open={sheet}
        onOpenChange={setSheet}
        reply={reply}
        error={query.error?.message}
        agent={agent}
        onPick={draft}
      />
    ) : null,
  }
}
