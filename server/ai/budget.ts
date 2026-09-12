import { encode } from 'gpt-tokenizer/encoding/o200k_base'
import type { AIInputBudget } from '../../src/lib/ai/contracts.ts'

export class ContextBudgetError extends Error {}

export function estimateInputBudget(
  input: unknown,
  format: unknown,
  outputReserve: number,
  model: string,
  contextLimit = 128_000,
): AIInputBudget {
  const text = JSON.stringify(input)
  const inputTokens = encode(text + JSON.stringify(format)).length + 2048
  const inputLimit = contextLimit - outputReserve
  return {
    model,
    contextLimit,
    inputTokens,
    inputLimit,
    outputReserve,
    totalTokens: inputTokens + outputReserve,
    characters: text.length,
    withinLimit: inputTokens <= inputLimit,
    compactionRecommended: inputTokens > inputLimit * 0.8,
  }
}

export function requireInputBudget(
  input: unknown,
  format: unknown,
  outputReserve: number,
  model: string,
  contextLimit = 128_000,
) {
  const budget = estimateInputBudget(input, format, outputReserve, model, contextLimit)
  if (!budget.withinLimit)
    throw new ContextBudgetError(
      `Estimated input is ${budget.inputTokens.toLocaleString()} tokens, above the ${budget.inputLimit.toLocaleString()}-token local limit. Reduce context or compact the style guide. No model request was made.`,
    )
  return budget
}
