import { z } from 'zod'

export const worktreeStatusSchema = z.object({
  available: z.boolean().default(false),
  branch: z.string().default(''),
  git_changes: z.string().default(''),
  node_version: z.string().default(''),
})

export const wslBridgeStatusSchema = z.object({
  available: z.boolean().default(false),
  socket: z.string().default(''),
  pid: z.number().optional(),
})

export const wakatimeStatusSchema = z.object({
  available: z.boolean().default(false),
  ai: z.string().default(''),
  code: z.string().default(''),
})

export type WorktreeStatus = z.infer<typeof worktreeStatusSchema>
export type WakatimeStatus = z.infer<typeof wakatimeStatusSchema>
export type WslBridgeStatus = z.infer<typeof wslBridgeStatusSchema>

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

export const vscodeWindowSchema = z.object({
  Pid: z.number().optional(),
  Hwnd: z.number().optional(),
  Title: z.string().default(''),
  Foreground: z.boolean().default(false),
  pid: z.number().optional(),
  hwnd: z.number().optional(),
  title: z.string().optional(),
  foreground: z.boolean().optional(),
})

export type VscodeWindow = z.infer<typeof vscodeWindowSchema>

export const vscodeStateSchema = z.object({
  available: z.boolean().default(false),
  windows: z.array(vscodeWindowSchema).default([]),
})

export const worktreeSchema = z.object({
  path: z.string(),
  name: z.string(),
  branch: z.string().default(''),
  kind: z.string().default('primary'),
})

export const workspaceCatalogSchema = z.object({
  available: z.boolean(),
  workspaces: z
    .array(
      z.object({
        name: z.string(),
        items: z
          .array(
            z.object({
              cwd: z.string(),
              name: z.string(),
              worktrees: z.array(worktreeSchema).default([]),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
  selection: z
    .object({
      workspace: z.string().default(''),
      repo: z.string().default(''),
      worktree: z.string().default(''),
    })
    .default({ workspace: '', repo: '', worktree: '' }),
})

export const agentSessionSchema = z
  .object({
    session_id: z.string().optional(),
    repo: z.string().optional(),
    agent_name: z.string().optional(),
    status: z.string().optional(),
    last_status: z.string().optional(),
    reason: z.string().optional(),
    last_reason: z.string().optional(),
    last_user_prompt: z.string().optional(),
    tmux_session: z.string().optional(),
    tmux_window: z.string().optional(),
    tmux_pane: z.string().optional(),
    tmux_window_name: z.string().optional(),
    git_branch: z.string().optional(),
    ts: z.number().optional(),
    live_ts: z.number().optional(),
    archived_ts: z.number().optional(),
  })
  .passthrough()

export const sessionsStateSchema = z
  .object({
    available: z.boolean().default(true),
    entries: z.record(z.string(), agentSessionSchema).default({}),
    recent: z.array(agentSessionSchema).default([]),
  })
  .passthrough()

export const runtimeActionResponseSchema = z.object({
  ok: z.boolean(),
  status: z.string().optional(),
  decision_path: z.string().optional(),
  result: z.unknown().optional(),
  error: z
    .object({ code: z.string(), message: z.string() })
    .nullable()
    .optional(),
})

export const diagnosticEntrySchema = z.object({
  Ts: z.string().optional(),
  Level: z.string().optional(),
  Source: z.string().optional(),
  Category: z.string().optional(),
  TraceId: z.string().optional(),
  Message: z.string().optional(),
  Stream: z.string().optional(),
  Raw: z.string().optional(),
  ts: z.string().optional(),
  level: z.string().optional(),
  source: z.string().optional(),
  category: z.string().optional(),
  trace_id: z.string().optional(),
  message: z.string().optional(),
  stream: z.string().optional(),
  raw: z.string().optional(),
})

export const diagnosticsStateSchema = z.object({
  available: z.boolean().default(false),
  path: z.string().optional(),
  sources: z.array(z.string()).default([]),
  entries: z.array(diagnosticEntrySchema).default([]),
  counts: z.record(z.string(), z.number()).default({}),
})

export type Health = z.infer<typeof healthSchema>
export type RimeStats = z.infer<typeof rimeStatsSchema>
export type ImeState = z.infer<typeof imeStateSchema>
export type ChromeState = z.infer<typeof chromeStateSchema>
export type VscodeState = z.infer<typeof vscodeStateSchema>
export type AgentSession = z.infer<typeof agentSessionSchema>
export type WorkspaceCatalog = z.infer<typeof workspaceCatalogSchema>
export type SessionsState = z.infer<typeof sessionsStateSchema>
export type RuntimeActionResponse = z.infer<typeof runtimeActionResponseSchema>
export type DiagnosticsState = z.infer<typeof diagnosticsStateSchema>

export type RuntimeSnapshot = {
  health: Health
  rime: RimeStats | null
  ime: ImeState | null
  chrome: ChromeState | null
}
