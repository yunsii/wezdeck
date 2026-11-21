// Display formatters shared by the Collab console views.
export function pct(value: number | null | undefined) {
  return typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : '—'
}

export function num(value: number | null | undefined, digits = 0) {
  return typeof value === 'number'
    ? value.toLocaleString(undefined, { maximumFractionDigits: digits })
    : '—'
}

export function usd(value: number | null | undefined) {
  return typeof value === 'number' ? `$${value.toFixed(3)}` : '—'
}

export function secs(ms: number | null | undefined) {
  return typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}s` : '—'
}
