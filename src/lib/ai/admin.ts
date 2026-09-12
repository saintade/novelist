import { z } from 'zod'

export const aiAdminRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('overview'),
      month: z
        .string()
        .regex(/^20\d\d-(0[1-9]|1[0-2])$/)
        .optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('budget'),
      monthlyAlertUsd: z.number().positive().max(1000000).nullable(),
      warningPercent: z.number().int().min(1).max(100),
    })
    .strict(),
])

export const aiAdminOverviewSchema = z.object({
  month: z.string(),
  trackingSince: z.string().nullable(),
  budgetUsd: z.number().nullable(),
  warningPercent: z.number(),
  totals: z.object({
    requests: z.number(),
    estimatedUsd: z.number(),
    unknownCosts: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    failed: z.number(),
  }),
  models: z.array(
    z.object({
      model: z.string(),
      requests: z.number(),
      input_tokens: z.number(),
      output_tokens: z.number(),
      estimated_usd: z.number(),
      unknown_costs: z.number(),
    }),
  ),
  recent: z.array(
    z.object({
      id: z.string(),
      book_id: z.string().nullable(),
      operation: z.string(),
      model: z.string(),
      group_size: z.number(),
      state: z.string(),
      input_tokens: z.number().nullable(),
      output_tokens: z.number().nullable(),
      estimated_usd: z.number().nullable(),
      error_code: z.string(),
      created_at: z.string(),
    }),
  ),
  providerSignal: z.object({ state: z.string(), errorCode: z.string(), at: z.string() }).nullable(),
  jobs: z.array(
    z.object({
      id: z.string(),
      book_id: z.string(),
      title: z.string(),
      request_kind: z.string(),
      state: z.string(),
      range_start: z.number(),
      range_end: z.number(),
      retry_at: z.string().nullable(),
      max_attempts: z.number(),
      last_error_code: z.string(),
      error: z.string(),
      updated_at: z.string(),
    }),
  ),
})
export type AIAdminOverview = z.infer<typeof aiAdminOverviewSchema> & {
  liveEnabled: boolean
  limits: { concurrency: number; hourlyRequests: number }
  pricingAsOf: string
}
