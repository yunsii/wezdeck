// The composer's `/` completion: which token the caret is in, which entries
// match it, and the text after picking one. Pure, so the unit tests cover it
// (tests/skill-complete.unit.test.ts); the popup is session-skills.tsx.
//
// Entries are the session's skills (`session.skills`, native/wezdeck-wsl/
// session_skills.go — what the agent was actually shown) plus, for Claude,
// the CLI's own commands, which are not skills and appear in no transcript.

export type SkillOrigin = 'wezdeck' | 'project' | 'user' | 'plugin' | 'builtin'

export type Skill = {
  name: string
  description?: string
  origin: SkillOrigin
  path?: string
}

export type SkillsReply = {
  agent?: string
  /** how the agent's TUI invokes one by name: "/" (Claude, Grok) or "$" (Codex) */
  trigger?: string
  skills: Array<Skill>
  rev?: string
}

/** one row of the completion list */
export type Completion = {
  /** the text inserted, trigger included: `/brainstorm` */
  insert: string
  name: string
  description?: string
  /** a skill's origin, or `command` for a CLI command */
  kind: SkillOrigin | 'command'
}

/** Claude Code's own commands (not skills: no transcript lists them); the
 * descriptions are translated where the list is built (session-skills.tsx) */
export const CLAUDE_COMMANDS = [
  'compact',
  'new',
  'clear',
  'resume',
  'context',
  'usage',
  'model',
  'rename',
] as const

/** Skill groups in the sheet, in this order */
export const ORIGIN_ORDER: Array<SkillOrigin> = [
  'wezdeck',
  'project',
  'user',
  'plugin',
  'builtin',
]

/**
 * The token being completed: the trigger at the start of the text or after
 * whitespace, then name characters up to the caret. null when the caret is
 * not in one (or the selection is not collapsed).
 */
export function completionQuery(
  text: string,
  caret: number,
  trigger: string,
): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf(trigger)
  if (at < 0) return null
  if (at > 0 && !/\s/.test(before[at - 1] ?? '')) return null
  const query = before.slice(at + trigger.length)
  if (!/^[\w:.-]*$/.test(query)) return null
  return { start: at, query }
}

/**
 * Entries matching query: name prefix first, then a word inside the name
 * (after - or :), then anywhere in the name or description; listing order
 * within each.
 */
export function matchCompletions(
  entries: Array<Completion>,
  query: string,
  limit = 8,
): Array<Completion> {
  const q = query.toLowerCase()
  if (!q) return entries.slice(0, limit)
  const rank = (entry: Completion) => {
    const name = entry.name.toLowerCase()
    if (name.startsWith(q)) return 0
    if (name.split(/[-:_.]/).some((part) => part.startsWith(q))) return 1
    if (name.includes(q)) return 2
    if (entry.description?.toLowerCase().includes(q)) return 3
    return -1
  }
  return entries
    .map((entry, index) => ({ entry, index, rank: rank(entry) }))
    .filter((row) => row.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, limit)
    .map((row) => row.entry)
}

/** The completion list for an agent: its commands, then its skills. */
export function completionEntries(
  reply: SkillsReply | undefined,
  commands: Array<{ name: string; description: string }> = [],
): Array<Completion> {
  const trigger = reply?.trigger || '/'
  const skills = (reply?.skills ?? []).map((skill) => ({
    insert: `${trigger}${skill.name}`,
    name: skill.name,
    description: skill.description,
    kind: skill.origin,
  }))
  return [
    ...commands.map((command) => ({
      insert: `/${command.name}`,
      name: command.name,
      description: command.description,
      kind: 'command' as const,
    })),
    ...skills,
  ]
}

/** Replace the token [start, caret) with insert and a space; returns the caret after it. */
export function applyCompletion(
  text: string,
  start: number,
  caret: number,
  insert: string,
) {
  const after = text.slice(caret).replace(/^[\w:.-]*/, '')
  const space = after.startsWith(' ') ? '' : ' '
  const next = text.slice(0, start) + insert + space + after
  return { text: next, caret: start + insert.length + 1 }
}
