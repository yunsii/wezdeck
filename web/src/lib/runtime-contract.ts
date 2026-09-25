import { z } from 'zod'

export const healthSchema = z.object({
  api_version: z.string(),
  instance_id: z.string(),
  ready: z.boolean(),
  uptime_ms: z.number().nonnegative().optional(),
  capabilities: z.array(z.string()).default([]),
  observed_at: z.string(),
})

export const rimeStatsSchema = z.object({
  events: z.number().nonnegative(),
  chars: z.number().nonnegative(),
  today_events: z.number().nonnegative().optional(),
  today_chars: z.number().nonnegative().optional(),
  first_ts: z.string().nullable().optional(),
  last_ts: z.string().nullable().optional(),
})

export const imeStateSchema = z.object({
  mode: z.string(),
  lang: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
})

export const chromeStateSchema = z.object({
  mode: z.string(),
  alive: z.boolean().optional(),
  port: z.number().optional(),
  pid: z.number().nullable().optional(),
})

export type Health = z.infer<typeof healthSchema>
export type RimeStats = z.infer<typeof rimeStatsSchema>
export type ImeState = z.infer<typeof imeStateSchema>
export type ChromeState = z.infer<typeof chromeStateSchema>

export type RuntimeSnapshot = {
  health: Health
  rime: RimeStats | null
  ime: ImeState | null
  chrome: ChromeState | null
}
