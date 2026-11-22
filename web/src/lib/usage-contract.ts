// What /relay/usage returns (relay/usage.ts) and the Workers Free limits it
// is measured against; shared by the Worker and the phone's 用量 card.

export const FREE = {
  workerRequestsPerDay: 100_000,
  doRequestsPerDay: 100_000,
  doDurationGbsPerDay: 13_000,
}

export type UsageReply = {
  analytics: 'ok' | 'partial' | 'unconfigured' | 'error'
  errors: Array<string>
  /** UTC day the numbers are for (limits reset at 00:00 UTC) */
  day: string
  at: string
  limits: typeof FREE
  worker: { requests: number | null; errors: number | null }
  durableObject: {
    requests: number | null
    /** GB-s: active seconds × 0.125 GB */
    durationGbs: number | null
    activeSeconds: number | null
    wsIn: number | null
    wsOut: number | null
  }
}
