import { z } from 'zod'

export const extractedTermSchema = z.object({
  sourceTerm: z.string().min(1).max(160),
  targetTerm: z.string().min(1).max(200),
  category: z.enum(['person', 'place', 'organization', 'rank', 'technique', 'item', 'concept']),
  sense: z.string().max(300),
  aliases: z.array(z.string().min(1).max(160)).max(12),
  evidenceQuote: z.string().min(1).max(500),
})

export const extractionSchema = z.object({
  terms: z.array(extractedTermSchema).max(80),
  warnings: z.array(z.string().max(500)).max(10),
})

export type ExtractionResult = z.infer<typeof extractionSchema>
export type ExtractedTerm = z.infer<typeof extractedTermSchema>

export const experimentRequestSchema = z
  .object({
    bookId: z.string().regex(/^[a-f0-9]{32}$/),
    chapter: z.number().int().min(0),
    mode: z.enum(['fixture', 'live']),
  })
  .strict()

export function validateExtraction(value: unknown, sourceText: string): ExtractionResult {
  const result = extractionSchema.parse(value)
  const identities = new Set<string>()
  for (const term of result.terms) {
    if (!term.sourceTerm.trim() || !term.targetTerm.trim())
      throw new Error('Extraction returned an empty term.')
    if (
      !sourceText.includes(term.sourceTerm) ||
      !sourceText.includes(term.evidenceQuote) ||
      !term.evidenceQuote.includes(term.sourceTerm)
    )
      throw new Error(`No exact source evidence for ${term.sourceTerm}.`)
    if (term.aliases.some((alias) => !sourceText.includes(alias)))
      throw new Error(`An alias for ${term.sourceTerm} was not found in the source.`)
    const identity = JSON.stringify([term.sourceTerm, term.sense])
    if (identities.has(identity)) throw new Error(`Duplicate proposal for ${term.sourceTerm}.`)
    identities.add(identity)
  }
  return result
}

export interface AIStatus {
  translationModel?: string
  chatModel?: string
  limits?: { concurrency: number; hourlyRequests: number }
  liveEnabled: boolean
  model: string
}

export interface AIInputBudget {
  model: string
  contextLimit: number
  inputTokens: number
  inputLimit: number
  outputReserve: number
  totalTokens: number
  characters: number
  withinLimit: boolean
  compactionRecommended: boolean
}

export const STYLE_EXAMPLE_LIMIT = 12
export const STYLE_CHARACTER_LIMIT = 48_000

export const styleRequestSchema = z
  .object({
    bookId: z.string().regex(/^[a-f0-9]{32}$/),
    exampleIds: z
      .array(z.string().uuid())
      .min(1)
      .max(STYLE_EXAMPLE_LIMIT)
      .refine((ids) => new Set(ids).size === ids.length),
    expectedProfileId: z.string().uuid().nullable(),
    rightsConfirmed: z.literal(true),
  })
  .strict()

export const styleInferenceSchema = z.object({
  instructions: z.string().min(1).max(6000),
  observations: z
    .array(
      z.object({
        exampleId: z.string().uuid(),
        quote: z.string().min(1).max(350),
        pattern: z.string().min(1).max(300),
      }),
    )
    .min(1)
    .max(24),
  warnings: z.array(z.string().max(500)).max(8),
})

export type StyleInferenceResult = z.infer<typeof styleInferenceSchema>
export interface StyleExampleText {
  id: string
  fileName: string
  text: string
}

export function validateStyleExamples(examples: StyleExampleText[]): void {
  if (
    !examples.length ||
    examples.length > STYLE_EXAMPLE_LIMIT ||
    new Set(examples.map((example) => example.id)).size !== examples.length
  )
    throw new Error('Select 1-12 distinct chapter examples.')
  if (
    examples.some((example) => !example.text.trim()) ||
    examples.reduce((total, example) => total + example.text.length, 0) > STYLE_CHARACTER_LIMIT
  )
    throw new Error(
      'Select nonempty examples totaling at most 48,000 characters. No text will be truncated.',
    )
}

export function validateStyleInference(
  value: unknown,
  examples: StyleExampleText[],
): StyleInferenceResult {
  const result = styleInferenceSchema.parse(value)
  if (!result.instructions.trim()) throw new Error('The inferred style is empty.')
  const observed = new Set<string>()
  for (const observation of result.observations) {
    const example = examples.find((candidate) => candidate.id === observation.exampleId)
    if (
      !observation.quote.trim() ||
      !observation.pattern.trim() ||
      !example?.text.includes(observation.quote)
    )
      throw new Error('A style observation has no exact evidence in the selected examples.')
    observed.add(observation.exampleId)
  }
  if (examples.some((example) => !observed.has(example.id)))
    throw new Error('The inferred style did not account for every selected example.')
  return result
}
