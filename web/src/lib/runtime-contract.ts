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

// ---------------------------------------------------------------- collab
// Mirrors skills/agent-collab/schema/*.schema.json (ticket api v1),
// served through Runtime GET /api/v1/collab/<command> → wezdeck-wsl bridge.
const nnum = z.number().nullable().optional()
const nstr = z.string().nullable().optional()

export const collabTokensSchema = z.object({
  input: nnum,
  cache_read: nnum,
  cache_write: nnum,
  output: nnum,
})

export const collabSessionSchema = z
  .object({ id: nstr, reuse: nstr, reason: nstr, from: nstr })
  .passthrough()

export const collabRunSummarySchema = z
  .object({
    run: z.string(),
    phase: nstr,
    role: nstr,
    backend: nstr,
    model: nstr,
    started_at: nstr,
    ended_at: nstr,
    wall_ms: nnum,
    turns: nnum,
    tokens: collabTokensSchema.nullable().optional(),
    cache_hit_rate: nnum,
    cache_ttl: nstr,
    cost_usd: nnum,
    tool_calls: nnum,
    rss_peak_mb: nnum,
    exit: nnum,
    session: collabSessionSchema.nullable().optional(),
    trigger: z.unknown().optional(),
    prompt_sha256: nstr,
  })
  .passthrough()

export const collabTicketSchema = z
  .object({
    id: z.string(),
    title: nstr,
    from: nstr,
    to: nstr,
    status: nstr,
    phase: nstr,
    owner: nstr,
    parent: nstr,
    created_at: nstr,
    updated_at: nstr,
    worktree: nstr,
    branch: nstr,
    progress: z
      .object({ step: nstr, message: nstr, ts: nstr })
      .nullable()
      .optional(),
    runs: z.number().default(0),
    running: z.array(z.string()).default([]),
    last_run: collabRunSummarySchema.nullable().optional(),
  })
  .passthrough()

const collabError = z
  .object({ code: z.string(), message: z.string() })
  .optional()

function collabEnvelope<T extends z.ZodRawShape>(shape: T) {
  return z
    .object({ v: z.number(), ok: z.boolean(), error: collabError, ...shape })
    .passthrough()
}

export const collabHealthSchema = collabEnvelope({
  tickets: z.number().default(0),
  by_status: z.record(z.string(), z.number()).default({}),
  running: z.number().default(0),
  queued: z.number().default(0),
  waiting_human: z.number().default(0),
  seq_head: z.number().default(0),
})

export const collabListSchema = collabEnvelope({
  total: z.number().default(0),
  tickets: z.array(collabTicketSchema).default([]),
})

export const collabEventSchema = z
  .object({
    seq: z.number().nullable().optional(),
    ticket: nstr,
    run: nstr,
    kind: z.string().default('event'),
    ts: nstr,
  })
  .passthrough()

/** structured questions a waiting ticket asks (skills/agent-collab questions.json) */
export const ticketQuestionsSchema = z.object({
  asked_at: nstr,
  source: nstr,
  questions: z
    .array(
      z.object({
        header: z.string().optional(),
        question: z.string(),
        multi_select: z.boolean().default(false),
        options: z
          .array(
            z.object({
              label: z.string(),
              description: z.string().optional(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
})
export type TicketQuestions = z.infer<typeof ticketQuestionsSchema>

export const collabShowSchema = collabEnvelope({
  ticket: collabTicketSchema.optional(),
  /** a text block for another agent (复制引用): skills/agent-collab/lib/reference.py */
  reference: z.string().optional(),
  sessions: z.record(z.string(), z.unknown()).default({}),
  questions: ticketQuestionsSchema.nullable().optional(),
  sections: z
    .array(z.object({ title: z.string(), text: z.string() }))
    .default([]),
  children: z.array(z.string()).default([]),
  children_detail: z
    .array(
      collabTicketSchema.extend({
        depends_on: z.array(z.string()).default([]),
        scope: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  collab: z
    .object({
      kind: nstr,
      contract_sha256: nstr,
      integration: z
        .record(
          z.string(),
          z
            .object({
              worktree: nstr,
              branch: nstr,
              merged: z.array(z.string()).default([]),
              skipped: nstr,
              conflict: z
                .object({
                  child: z.string(),
                  files: z.array(z.string()).default([]),
                })
                .nullable()
                .optional(),
            })
            .passthrough(),
        )
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  runs: z.array(collabRunSummarySchema).default([]),
})

export const collabEventsSchema = collabEnvelope({
  events: z.array(collabEventSchema).default([]),
  next: z.number().default(0),
  head: z.number().default(0),
  more: z.boolean().default(false),
})

export const collabCompositionSchema = z
  .object({
    kind: z.string(),
    source: nstr,
    git_blob: nstr,
    bytes: z.number().default(0),
    sha256: nstr,
  })
  .passthrough()

export const collabRunSchema = collabEnvelope({
  ticket: z.string().optional(),
  running: z.boolean().default(false),
  launch: z
    .object({
      run: z.string(),
      ts: nstr,
      phase: nstr,
      role: nstr,
      trigger: z
        .object({
          source: nstr,
          actor: nstr,
          origin_session: nstr,
          origin_cwd: nstr,
          cmdline: nstr,
        })
        .passthrough()
        .nullable()
        .optional(),
      prompt: z
        .object({
          sha256: z.string(),
          store_sha256: nstr,
          bytes: z.number(),
          est_tokens: z.number(),
          redactions: z.array(z.string()).optional(),
        })
        .passthrough(),
      composition: z.array(collabCompositionSchema).default([]),
      session: collabSessionSchema.nullable().optional(),
      invocation: z
        .object({
          backend: z.string(),
          mode: z.string(),
          model: nstr,
          cwd: z.string(),
          base_sha: nstr,
          argv: z.array(z.string()).default([]),
        })
        .passthrough(),
    })
    .passthrough()
    .optional(),
  record: collabRunSummarySchema
    .extend({
      cli_init: z.record(z.string(), z.unknown()).nullable().optional(),
      final_text_tail: nstr,
      denials: nnum,
      errors: nnum,
    })
    .nullable()
    .optional(),
})

export const collabPromptSchema = collabEnvelope({
  sha256: z.string().optional(),
  bytes: z.number().optional(),
  text: z.string().default(''),
})

export const collabTranscriptSchema = collabEnvelope({
  lines: z.array(collabEventSchema).default([]),
  total: z.number().default(0),
  final_text_tail: nstr,
})

const collabGroup = z.record(
  z.string(),
  z
    .object({
      runs: z.number().default(0),
      cache_hit_rate: nnum,
      cost_usd: nnum,
    })
    .passthrough(),
)

export const collabMetricsSchema = collabEnvelope({
  window: z.string().default('24h'),
  realized_parallelism: nnum,
  runs: z.number().default(0),
  failed_runs: z.number().default(0),
  sessions: z.number().default(0),
  turns: z.number().default(0),
  tokens: collabTokensSchema.optional(),
  cache_hit_rate: nnum,
  cost_usd: nnum,
  wall_ms: z.object({ p50: nnum, p95: nnum, sum: nnum }).partial().optional(),
  rss_peak_mb: z.object({ p95: nnum, max: nnum }).partial().optional(),
  by_backend: collabGroup.default({}),
  by_reuse: collabGroup.default({}),
  reuse_reasons: z.record(z.string(), z.number()).default({}),
  by_repo: collabGroup.default({}),
  by_trigger: z.record(z.string(), z.number()).default({}),
})

export type CollabHealth = z.infer<typeof collabHealthSchema>
export type CollabList = z.infer<typeof collabListSchema>
export type CollabTicket = z.infer<typeof collabTicketSchema>
export type CollabShow = z.infer<typeof collabShowSchema>
export type CollabEvents = z.infer<typeof collabEventsSchema>
export type CollabEvent = z.infer<typeof collabEventSchema>
export type CollabRun = z.infer<typeof collabRunSchema>
export type CollabRunSummary = z.infer<typeof collabRunSummarySchema>
export type CollabPrompt = z.infer<typeof collabPromptSchema>
export type CollabTranscript = z.infer<typeof collabTranscriptSchema>
export type CollabMetrics = z.infer<typeof collabMetricsSchema>
