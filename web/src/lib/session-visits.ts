// When a worktree was last visited from this phone. The host sends the desk
// side (`visited`, the access ledger behind Alt+g / Alt+x); opening a session
// here counts as a visit too. The session list sorts by the later of the two
// so it only reorders when you go somewhere, never because an agent printed.
const KEY = 'wezdeck-session-visits'
const CAP = 200

type Visits = Record<string, number>

function read(): Visits {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? (parsed as Visits) : {}
  } catch {
    return {}
  }
}

export function consoleVisits(): Visits {
  return read()
}

export function recordVisit(worktree: string, at = Date.now()) {
  if (!worktree) return
  try {
    const visits = read()
    visits[worktree] = at
    const kept = Object.entries(visits)
      .sort((a, b) => b[1] - a[1])
      .slice(0, CAP)
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)))
  } catch {
    // private window / blocked storage: desk visits still order the list
  }
}
