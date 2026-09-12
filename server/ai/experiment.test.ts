import { describe, expect, it, vi } from 'vitest'
import { extractWithOpenAI, fixtureExtraction, inferStyleWithOpenAI } from './extractor'
import { estimateInputBudget, requireInputBudget } from './budget'
import { fitTranslationContext } from './continuity'
import { searchChunks, searchWords } from './reader-retrieval'
import { completedStructuredOutput, modelRequestFailure, outputLimits } from './responses'
import { fitTranslationGroup, groupModelOutputLimit, recoverGroupedChapters, validateGroupedChapter } from './grouped-translation'
import type { TranslationContext } from '../../src/lib/translation/context'
import {
  extractionSchema,
  validateExtraction,
  validateStyleInference,
  validateStyleExamples,
  styleRequestSchema,
} from '../../src/lib/ai/contracts'

const { parseResponse } = vi.hoisted(() => ({ parseResponse: vi.fn() }))
vi.mock('openai', () => ({
  default: class {
    responses = { parse: parseResponse, create: async (request: unknown) => {
      const response = await parseResponse(request)
      return { ...response, output_text: response.output_text ?? (response.output_parsed ? JSON.stringify(response.output_parsed) : '') }
    } }
  },
}))

describe('structured completion checks', () => {
  it('rejects output-limit truncation before trying to parse cut-off JSON', () => {
    expect(() => completedStructuredOutput({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: '{"terms":[' }, extractionSchema, 'Term extraction', outputLimits.extraction)).toThrow('12,000-token output limit')
    expect(() => completedStructuredOutput({ status: 'completed', output_text: '{"terms":[' }, extractionSchema, 'Term extraction', outputLimits.extraction)).toThrow('invalid or cut-off JSON')
    expect(() => completedStructuredOutput({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] }, extractionSchema, 'Term extraction', outputLimits.extraction)).toThrow('declined')
  })
  it('reports timeouts, quota and provider capacity without exposing raw errors', () => {
    expect(modelRequestFailure({ name: 'APIConnectionTimeoutError' })).toMatchObject({ code: 'timeout', status: 504 })
    expect(modelRequestFailure({ status: 429, code: 'insufficient_quota' })).toMatchObject({ code: 'quota' })
    expect(modelRequestFailure({ status: 400, code: 'billing_hard_limit_reached' })).toMatchObject({ code: 'quota' })
    expect(modelRequestFailure({ status: 429, message: 'PRIVATE PROVIDER DETAIL' })?.message).not.toContain('PRIVATE')
    expect(modelRequestFailure({ status: 503 })).toMatchObject({ code: 'provider_unavailable' })
  })
})

describe('grouped translation recovery', () => {
  const context: TranslationContext = { targetLanguage: 'en', settingsRevision: 1, source: { key: 'local:0', hash: 'a'.repeat(64), text: 'First source paragraph.\n\nSecond source paragraph.', title: 'Chapter 1', language: 'zh' }, mode: 'continuation', basis: 'preceding', referenceBook: null, references: [], glossary: [], style: '', warnings: [] }
  const chapter = { sourceKey: context.source.key, sourceHash: context.source.hash, title: 'Chapter 1', paragraphs: [{ sourceParagraphId: 1, text: 'First translation.' }, { sourceParagraphId: 2, text: 'Second translation.' }], terminology: [], completion: 'complete' }
  it('recovers closed chapter objects but never repairs the cut-off chapter', () => {
    const text = `{"chapters":[${JSON.stringify(chapter)},{"sourceKey":"local:1","paragraphs":[{"text":"cut off`
    const recovered = recoverGroupedChapters(text, true)
    expect(recovered).toEqual([chapter])
    expect(validateGroupedChapter(recovered[0], context, []).paragraphs).toHaveLength(2)
    expect(() => recoverGroupedChapters(text, false)).toThrow('before its JSON was complete')
    expect(() => validateGroupedChapter({ ...chapter, paragraphs: chapter.paragraphs.slice(0, 1) }, context, [])).toThrow('missing')
    expect(() => validateGroupedChapter({ ...chapter, sourceHash: 'b'.repeat(64) }, context, [])).toThrow('source identity')
  })
  it('does not publish recoveries from malformed syntax or unrelated envelopes', () => {
    expect(() => recoverGroupedChapters(`{"chapters":[${JSON.stringify(chapter)},INVALID`, true)).toThrow('malformed')
    expect(() => recoverGroupedChapters('{"other":[]}', false)).toThrow('envelope')
    expect(recoverGroupedChapters(JSON.stringify({ chapters: [chapter] }), false)).toEqual([chapter])
  })
  it('adapts group size to model output capacity and total context budget', () => {
    const contexts = Array.from({ length: 10 }, (_, index) => ({ ...context, source: { ...context.source, key: `local:${index}` } }))
    expect(fitTranslationGroup(contexts, 'gpt-4o-mini', 128000).count).toBeLessThan(10)
    expect(fitTranslationGroup(contexts, 'gpt-5-mini', 128000).count).toBe(10)
    expect(groupModelOutputLimit('gpt-4o-mini', 65536)).toBe(16384)
    expect(groupModelOutputLimit('unknown-model')).toBe(16384)
    expect(groupModelOutputLimit('unknown-model', 49152)).toBe(49152)
    expect(groupModelOutputLimit('gpt-5.6-luna')).toBe(65536)
    const long = contexts.map(item => ({ ...item, source: { ...item.source, text: 'Dense chapter content. '.repeat(800) } }))
    expect(fitTranslationGroup(long, 'gpt-5-mini', 32000).count).toBeLessThan(fitTranslationGroup(long, 'gpt-5-mini', 128000).count)
  })
})

describe('local context budgets', () => {
  it('indexes Chinese words and bounded passages without storing duplicate prose', () => {
    expect(searchWords('阿遥在青岚渡寻找照月灯。')).toContain('阿遥')
    const text = 'A named ability appears in this paragraph.\n\n'.repeat(300)
    const chunks = searchChunks(text)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0].start).toBe(0)
    expect(chunks.at(-1)?.end).toBe(text.length)
    expect(chunks.every(chunk => chunk.end - chunk.start <= 2400)).toBe(true)
    expect(chunks.every((chunk, index) => !index || chunk.start < chunks[index - 1].end)).toBe(true)
  })
  it('keeps recent translations whole and drops the oldest context before the hard limit', () => {
    const text = Array.from({ length: 3500 }, (_, index) => `Word ${index}`).join(' ')
    const chapters = [1, 2, 3, 4, 5].map((position) => ({
      position,
      title: `Chapter ${position}`,
      text,
      hash: 'hash',
      truncated: false,
    }))
    const context: TranslationContext = {
      targetLanguage: 'en',
      settingsRevision: 1,
      source: {
        key: 'current',
        title: 'Current',
        text: 'Never truncate this source.',
        hash: 'source',
        language: 'zh',
      },
      referenceBook: null,
      mode: 'continuation',
      basis: 'preceding',
      references: [],
      recentTranslations: chapters,
      style: 'Retained compact guide.',
      glossary: [{ source: 'Name', target: 'Preferred name', sense: '' }],
      warnings: [],
    }
    const small = fitTranslationContext(context, {}, 'test', 32000)
    expect(small.omitted).toBeGreaterThan(0)
    expect(small.context.recentTranslations?.at(-1)).toEqual(chapters.at(-1))
    expect(small.context.source.text).toBe(context.source.text)
    expect(small.context.style).toBe(context.style)
    expect(small.context.glossary).toEqual(context.glossary)
    expect(small.budget.withinLimit).toBe(true)
    expect(context.recentTranslations).toHaveLength(5)
    expect(fitTranslationContext(context, {}, 'test', 128000).omitted).toBe(0)
  })
  it('includes schema and a prompt allowance and reserves room for output', () => {
    const budget = estimateInputBudget(
      { source: 'A chapter.', glossary: ['name'] },
      { format: 'json' },
      14000,
      'gpt-5.6-luna',
    )
    expect(budget).toMatchObject({
      model: 'gpt-5.6-luna',
      contextLimit: 128000,
      inputLimit: 114000,
      outputReserve: 14000,
      withinLimit: true,
    })
    expect(budget.inputTokens).toBeGreaterThan(2048)
    expect(budget.totalTokens).toBe(budget.inputTokens + 14000)
    expect(estimateInputBudget({ source: 'A chapter.' }, {}, 14000, 'test', 32000).inputLimit).toBe(
      18000,
    )
  })
  it('rejects oversized multilingual input before any provider request', () => {
    const requests = parseResponse.mock.calls.length
    const text = Array.from({ length: 40000 }, (_, index) => `Chapter ${index}.`).join(' ')
    expect(() => requireInputBudget({ text }, {}, 14000, 'gpt-5.6-luna')).toThrow(
      'No model request was made',
    )
    expect(parseResponse).toHaveBeenCalledTimes(requests)
  })
})

describe('style inference validation', () => {
  const examples = [
    {
      id: 'debb8bf9-b7a1-47b4-bb88-4a975a453934',
      fileName: 'Chapter one.txt',
      text: 'The rain eased. "Keep the ledger," she said.',
    },
  ]
  const result = {
    instructions: 'Use concise narration and natural dialogue.',
    observations: [
      {
        exampleId: examples[0].id,
        quote: 'The rain eased.',
        pattern: 'Short declarative narration.',
      },
    ],
    warnings: [],
  }
  it('grounds the inferred profile in uploaded examples and uses bounded private provider requests', async () => {
    parseResponse.mockResolvedValueOnce({
      status: 'completed',
      output_parsed: result,
      usage: { input_tokens: 150, output_tokens: 50 },
    })
    const output = await inferStyleWithOpenAI(examples, {
      apiKey: 'test-only',
      model: 'configured-model',
    })
    expect(output).toEqual({ result, inputTokens: 150, outputTokens: 50 })
    expect(parseResponse).toHaveBeenLastCalledWith(
      expect.objectContaining({
        model: 'configured-model',
        store: false,
        max_output_tokens: outputLimits.style,
        input: expect.arrayContaining([
          expect.objectContaining({ role: 'user', content: JSON.stringify({ examples }) }),
        ]),
      }),
    )
  })
  it('compacts a bounded previous guide with new evidence in one request', async () => {
    parseResponse.mockResolvedValueOnce({ status: 'completed', output_parsed: result })
    const previousGuide = 'Prefer restrained narration and short paragraphs.'
    await inferStyleWithOpenAI(
      examples,
      { apiKey: 'test-only', model: 'configured-model' },
      previousGuide,
    )
    expect(parseResponse).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: expect.arrayContaining([
          { role: 'user', content: JSON.stringify({ examples, previousGuide }) },
        ]),
      }),
    )
    const requests = parseResponse.mock.calls.length
    await expect(
      inferStyleWithOpenAI(
        examples,
        { apiKey: 'test-only', model: 'configured-model' },
        'a'.repeat(6001),
      ),
    ).rejects.toThrow('6,000')
    expect(parseResponse).toHaveBeenCalledTimes(requests)
  })
  it('applies bounded reader feedback while keeping the guide a complete replacement', async () => {
    parseResponse.mockResolvedValueOnce({ status: 'completed', output_parsed: result })
    await inferStyleWithOpenAI(
      examples,
      { apiKey: 'test-only', model: 'test-only' },
      'Existing compact guide.',
      'Keep dialogue concise and preserve profile line breaks.',
    )
    expect(JSON.stringify(parseResponse.mock.lastCall)).toContain('readerPreferences')
    expect(JSON.stringify(parseResponse.mock.lastCall)).toContain('Existing compact guide.')
    const requests = parseResponse.mock.calls.length
    await expect(
      inferStyleWithOpenAI(
        examples,
        { apiKey: 'test-only', model: 'test-only' },
        undefined,
        'x'.repeat(2001),
      ),
    ).rejects.toThrow('2,000')
    expect(parseResponse).toHaveBeenCalledTimes(requests)
  })
  it('rejects fabricated evidence and ignored examples', () => {
    expect(() =>
      validateStyleInference(
        { ...result, observations: [{ ...result.observations[0], quote: 'Invented prose.' }] },
        examples,
      ),
    ).toThrow('exact evidence')
    expect(() =>
      validateStyleInference(result, [...examples, { ...examples[0], id: crypto.randomUUID() }]),
    ).toThrow('every selected example')
  })
  it('does not silently truncate oversized example sets', () => {
    expect(() => validateStyleExamples([{ ...examples[0], text: 'a'.repeat(48_001) }])).toThrow(
      'No text will be truncated',
    )
    expect(() => validateStyleExamples([])).toThrow('1-12')
  })
  it('requires source-use confirmation and distinct example IDs', () => {
    const request = {
      bookId: 'a'.repeat(32),
      exampleIds: [examples[0].id],
      expectedProfileId: null,
      rightsConfirmed: true,
    }
    expect(styleRequestSchema.safeParse(request).success).toBe(true)
    expect(styleRequestSchema.safeParse({ ...request, rightsConfirmed: false }).success).toBe(false)
    expect(
      styleRequestSchema.safeParse({ ...request, exampleIds: [examples[0].id, examples[0].id] })
        .success,
    ).toBe(false)
  })
  it('rejects incomplete provider output', async () => {
    parseResponse.mockResolvedValueOnce({ status: 'incomplete', output_parsed: result })
    await expect(
      inferStyleWithOpenAI(examples, { apiKey: 'test-only', model: 'configured-model' }),
    ).rejects.toThrow('incomplete output')
  })
})

describe('term extraction validation', () => {
  const source = '林遥来到青岚渡，顾宁正在修补照月灯。'
  it('validates structured fixture terms and source evidence', () => {
    const result = fixtureExtraction(source)
    expect(result.terms.map((term) => term.sourceTerm)).toEqual([
      '林遥',
      '顾宁',
      '青岚渡',
      '照月灯',
    ])
    expect(result.warnings[0]).toContain('No AI request')
  })
  it('rejects fabricated evidence even when the JSON is valid', () => {
    const result = fixtureExtraction(source)
    result.terms[0].evidenceQuote = 'An invented source quote'
    expect(() => validateExtraction(result, source)).toThrow('source evidence')
  })
  it('rejects invented aliases and duplicate terms', () => {
    const result = fixtureExtraction(source)
    result.terms[0].aliases = ['An absent alias']
    expect(() => validateExtraction(result, source)).toThrow('alias')
    result.terms[0].aliases = []
    result.terms.push(result.terms[0])
    expect(() => validateExtraction(result, source)).toThrow('Duplicate')
  })
  it('rejects malformed or oversized output', () => {
    expect(() => validateExtraction({ terms: [{}], warnings: [] }, source)).toThrow()
    const result = fixtureExtraction(source)
    expect(() =>
      validateExtraction(
        { ...result, terms: Array.from({ length: 81 }, () => result.terms[0]) },
        source,
      ),
    ).toThrow()
  })
  it('uses the configured OpenAI model and includes the selected context with bounded output', async () => {
    const result = fixtureExtraction(source)
    parseResponse.mockResolvedValueOnce({
      status: 'completed',
      output_parsed: result,
      usage: { input_tokens: 200, output_tokens: 80 },
    })
    const context = {
      sourceLanguage: 'zh',
      style: 'Preserve all meaning.',
      glossary: [{ sourceTerm: '林遥', targetTerm: 'Lin Yao', sense: '' }],
    }
    const output = await extractWithOpenAI(source, context, {
      apiKey: 'test-only',
      model: 'configured-model',
    })
    expect(output.inputTokens).toBe(200)
    expect(output.result).toEqual(result)
    expect(parseResponse).toHaveBeenLastCalledWith(
      expect.objectContaining({
        model: 'configured-model',
        store: false,
        max_output_tokens: outputLimits.extraction,
        input: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: JSON.stringify({ context, chapter: source }),
          }),
        ]),
      }),
    )
  })
  it('does not accept incomplete or refused provider output', async () => {
    const context = { sourceLanguage: 'zh', style: '', glossary: [] }
    parseResponse.mockResolvedValueOnce({
      status: 'incomplete',
      output_parsed: fixtureExtraction(source),
    })
    await expect(
      extractWithOpenAI(source, context, { apiKey: 'test-only', model: 'configured-model' }),
    ).rejects.toThrow('incomplete output')
    parseResponse.mockResolvedValueOnce({ status: 'completed', output_parsed: null })
    await expect(
      extractWithOpenAI(source, context, { apiKey: 'test-only', model: 'configured-model' }),
    ).rejects.toThrow('no structured result')
  })
})
