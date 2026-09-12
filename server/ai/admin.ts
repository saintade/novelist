import { aiAdminOverviewSchema, aiAdminRequestSchema } from '../../src/lib/ai/admin.ts'
import { PRICING_AS_OF } from '../../src/lib/ai/pricing.ts'
import { authenticateAILibrary, localAILimits, type AIConfiguration } from './experiments.ts'

export async function runAIAdmin(token: string, payload: unknown, configuration: AIConfiguration) {
  const input = aiAdminRequestSchema.parse(payload)
  const { client, ownerId } = await authenticateAILibrary(token, configuration)
  if (input.action === 'budget') {
    const updated = await client
      .from('ai_budget_settings')
      .upsert({
        owner_id: ownerId,
        monthly_alert_usd: input.monthlyAlertUsd,
        warning_percent: input.warningPercent,
      })
    if (updated.error) throw updated.error
  }
  const month =
    input.action === 'overview'
      ? (input.month ?? new Date().toISOString().slice(0, 7))
      : new Date().toISOString().slice(0, 7)
  const result = await client.rpc('ai_usage_overview', { month_start: `${month}-01` })
  if (result.error) throw result.error
  return {
    ...aiAdminOverviewSchema.parse(result.data),
    liveEnabled: configuration.liveEnabled && Boolean(configuration.apiKey),
    limits: localAILimits(configuration),
    pricingAsOf: PRICING_AS_OF,
  }
}
