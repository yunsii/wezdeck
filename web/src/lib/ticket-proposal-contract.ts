// Fan-out split proposals in `ticket api show` (skills/agent-collab/lib/split.py,
// schema/show.schema.json `proposals`): split out of runtime-contract.ts.
import { z } from 'zod'

const nstr = z.string().nullable().optional()

/** a pending split: origin draft (plan agent, with its contract) or split (a running child) */
export const ticketProposalSchema = z.object({
  id: z.string(),
  origin: z.enum(['draft', 'split']),
  by: nstr,
  reason: nstr,
  warnings: z.array(z.string()).nullable().default([]),
  created_at: nstr,
  contract: z.string().optional(),
  summary: z
    .object({ problem: z.string().optional(), approach: z.string().optional() })
    .nullable()
    .optional(),
  status_check: z
    .array(
      z.object({
        item: z.string(),
        status: z.enum(['missing', 'partial', 'done']),
        evidence: z.string().default(''),
        reuse: z.string().optional(),
      }),
    )
    .nullable()
    .optional(),
  risks: z.array(z.string()).nullable().optional(),
  outcome: z
    .object({
      workers: z.number(),
      max_parallel: z.number(),
      stages: z.number(),
      mem_peak_mb: z.number(),
      usd: z.array(z.number()).default([]),
      minutes_each: z.array(z.number()).default([]),
      delivery: z.record(z.string(), z.string()).default({}),
      pushes: z.boolean().default(false),
    })
    .passthrough()
    .nullable()
    .optional(),
  items: z
    .array(
      z.object({
        key: z.string(),
        to: z.string(),
        title: z.string(),
        effect: z.string().optional(),
        observed: z.string().optional(),
        assumed: z.string().optional(),
        scope: z.array(z.string()).default([]),
        depends_on: z.array(z.string()).default([]),
      }),
    )
    .default([]),
})
export type TicketProposal = z.infer<typeof ticketProposalSchema>
