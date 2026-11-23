// A ticket's Thread section as a conversation. The CLI writes each entry as
//   - (2026-11-13T07:56:03Z) initiator: text…
//   continuation lines…
// newest first (lib/lifecycle.sh inserts right under "## Thread"); the page
// shows them oldest → newest like a chat.

export type ThreadEntry = { at: string; who: string; text: string }

const ENTRY = /^- \(([^)]*)\)\s*(?:([^:\n]{1,40}):)?\s?(.*)$/

/** the ticket API cuts a section at 8000 characters (agent-collab api.py):
 *  newest first, so what is lost is the oldest entries */
export const threadClipped = (text: string) =>
  text.trimEnd().endsWith('…') && text.length >= 7990

/** entries oldest first */
export function parseThread(text: string): Array<ThreadEntry> {
  const entries: Array<ThreadEntry> = []
  for (const line of text.split('\n')) {
    const m = ENTRY.exec(line.trim())
    if (m) {
      entries.push({ at: m[1], who: m[2] ? m[2].trim() : '', text: m[3] })
      continue
    }
    const last = entries.at(-1)
    if (last) last.text += `\n${line}`
  }
  for (const entry of entries) entry.text = entry.text.trim()
  return entries.reverse()
}

/** the agent's open question: the newest Thread entry */
export function openQuestion(sections: Array<{ title: string; text: string }>) {
  const thread = sections.find((section) => section.title === 'Thread')
  return parseThread(thread?.text ?? '').at(-1)?.text ?? ''
}

/** the initiator speaks from the right, like your own messages in a chat */
export const fromYou = (entry: ThreadEntry) => entry.who === 'initiator'
