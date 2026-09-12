export const IDENTIFICATION_MODEL = 'gpt-5-nano'
export const PRICING_AS_OF = '2026-09-10'
export const PRICING_SOURCE = 'https://developers.openai.com/api/docs/pricing'

export const textModelPrices = [
  { model: 'gpt-5-nano', input: 0.05, cachedInput: 0.005, output: 0.4 },
  { model: 'gpt-4.1-nano', input: 0.1, cachedInput: 0.025, output: 0.4 },
  { model: 'gpt-4o-mini', input: 0.15, cachedInput: 0.075, output: 0.6 },
  { model: 'gpt-5.6-luna', input: 0.2, cachedInput: 0.02, output: 1.2 },
  { model: 'gpt-5.4-nano', input: 0.2, cachedInput: 0.02, output: 1.25 },
  { model: 'gpt-5-mini', input: 0.25, cachedInput: 0.025, output: 2.0 },
  { model: 'gpt-4.1-mini', input: 0.4, cachedInput: 0.1, output: 1.6 },
  { model: 'gpt-5.4-mini', input: 0.75, cachedInput: 0.075, output: 4.5 },
] as const

export interface TokenUsage {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
}

export interface IdentificationCost extends TokenUsage {
  basis: 'preflight' | 'reported-usage'
  model: string
  capturedCharacters: number
  usageKnown: boolean
  estimatedUsd: number | null
  pricesAsOf: string
  pricingSource: string
  comparisons: {
    model: string
    inputPerMillion: number
    outputPerMillion: number
    estimatedUsd: number | null
  }[]
}

export function identificationCost(
  model: string,
  usage: TokenUsage,
  options: { basis: IdentificationCost['basis']; capturedCharacters: number; usageKnown?: boolean },
): IdentificationCost {
  const usageKnown = options.usageKnown ?? true
  const cached = Math.min(usage.inputTokens, Math.max(0, usage.cachedInputTokens))
  const comparisons = textModelPrices.map((price) => ({
    model: price.model,
    inputPerMillion: price.input,
    outputPerMillion: price.output,
    estimatedUsd: usageKnown
      ? ((usage.inputTokens - cached) * price.input +
          cached * price.cachedInput +
          usage.outputTokens * price.output) /
        1_000_000
      : null,
  }))
  const selected = comparisons.find(
    (price) => model === price.model || model.startsWith(`${price.model}-20`),
  )
  return {
    ...usage,
    ...options,
    usageKnown,
    model,
    estimatedUsd: selected?.estimatedUsd ?? null,
    comparisons,
    pricesAsOf: PRICING_AS_OF,
    pricingSource: PRICING_SOURCE,
  }
}
