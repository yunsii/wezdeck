// IM list timestamps: today = clock, yesterday / weekday / M/D — not relative ago.

const DAY_MS = 86_400_000

function startOfLocalDay(ms: number) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Compact chat-list time. Labels for yesterday / weekdays come from the
 * caller (i18n); this only picks which bucket and formats clock / date.
 */
export function chatTimeBucket(
  ms: number,
  now = Date.now(),
): 'today' | 'yesterday' | 'weekday' | 'date' {
  const day = startOfLocalDay(ms)
  const today = startOfLocalDay(now)
  const diff = today - day
  if (diff === 0) return 'today'
  if (diff === DAY_MS) return 'yesterday'
  if (diff > 0 && diff < 7 * DAY_MS) return 'weekday'
  return 'date'
}

export function formatChatClock(ms: number, locale: string) {
  return new Date(ms).toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatChatWeekday(ms: number, locale: string) {
  return new Date(ms).toLocaleDateString(locale, { weekday: 'short' })
}

export function formatChatDate(ms: number, locale: string) {
  return new Date(ms).toLocaleDateString(locale, {
    month: 'numeric',
    day: 'numeric',
  })
}
