import { z } from 'zod'
import { capturedPageSchema, publicPageUrl, type CapturedPage } from '../scraper/contracts.ts'

export const NAVIGATION_LIMITS = {
  actions: 12,
  decisions: 3,
  samples: 3,
  durationMs: 240_000,
  controls: 60,
  linkBatch: 500,
} as const
export const navigationGoalSchema = z.enum(['contents', 'samples'])
export type NavigationGoal = z.infer<typeof navigationGoalSchema>

export function isAccessChallenge(title: string, text: string): boolean {
  return (
    /just a moment|attention required|access denied|security verification|captcha/i.test(title) ||
    /verify (?:that )?you are human|verifying (?:your browser|you are human)|checking your browser|performing security verification|captcha required/i.test(
      text.slice(0, 2000),
    )
  )
}

export const navigationControlSchema = z
  .object({
    id: z.string().min(1).max(80),
    label: z.string().min(1).max(240),
    role: z.enum(['link', 'button', 'select']),
    url: z.string().max(2048).nullable(),
    options: z
      .array(z.object({ value: z.string().max(150), label: z.string().max(150) }).strict())
      .max(30),
  })
  .strict()
export type NavigationControl = z.infer<typeof navigationControlSchema>
export const navigationRecipeSchema = z
  .object({
    label: z.string().min(1).max(240),
    role: z.enum(['link', 'button', 'select']),
    value: z.string().max(150).nullable(),
    intent: z.enum(['contents', 'ascending', 'load_more', 'next_page']),
  })
  .strict()
export type NavigationRecipe = z.infer<typeof navigationRecipeSchema>
export const navigationRecipeLabel = (label: string) =>
  label.normalize('NFKC').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()

export const navigationSnapshotSchema = z
  .object({
    id: z.string().uuid(),
    url: capturedPageSchema.shape.url,
    title: z.string().max(500),
    excerpt: z.string().max(1600),
    fingerprint: z.string().max(100),
    controls: z.array(navigationControlSchema).max(NAVIGATION_LIMITS.controls),
    linkCount: z.number().int().min(0),
    chapterLinkCount: z.number().int().min(0),
    chapterSamples: z
      .array(z.object({ title: z.string().max(240), url: z.string().max(2048) }).strict())
      .max(6),
    canScroll: z.boolean(),
    blocked: z.boolean(),
  })
  .strict()
export type NavigationSnapshot = z.infer<typeof navigationSnapshotSchema>

export const navigationDecisionSchema = z
  .object({
    action: z.enum(['click', 'select', 'scroll', 'finish', 'stop']),
    controlId: z.string().max(80).nullable(),
    value: z.string().max(150).nullable(),
    intent: z.enum([
      'contents',
      'ascending',
      'load_more',
      'start_reading',
      'next_page',
      'next_chapter',
      'inspect',
      'stop',
    ]),
    pageType: z.enum(['contents', 'chapter', 'other', 'blocked', 'uncertain']),
    repeat: z.boolean(),
    reason: z.string().min(1).max(600),
  })
  .strict()
export type NavigationDecision = z.infer<typeof navigationDecisionSchema>

export const navigationStartSchema = z
  .object({
    url: capturedPageSchema.shape.url,
    goal: navigationGoalSchema,
    model: z.string().max(100).optional(),
    confirmed: z.literal(true),
  })
  .strict()
export const navigationPlanSchema = z
  .object({
    runId: z.string().uuid(),
    snapshot: navigationSnapshotSchema,
    history: z
      .array(z.object({ action: z.string().max(100), outcome: z.string().max(300) }).strict())
      .max(12),
  })
  .strict()

export interface NavigationPlanResult {
  decision: NavigationDecision
  model: string
  inputTokens: number
  outputTokens: number
}
export interface NavigationActivity {
  step: number
  url: string
  action: string
  outcome: string
  reused: boolean
}
export interface NavigationRun {
  id: string
  sourceUrl?: string
  pageTitle?: string
  model?: string
  goal: NavigationGoal
  state: 'running' | 'completed' | 'stopped' | 'failed'
  stage: string
  modelCalls: number
  inputTokens: number
  outputTokens: number
  actions: number
  pages: CapturedPage[]
  activity: NavigationActivity[]
  reason?: string
  recipe?: { intent: NavigationDecision['intent']; label: string; role: NavigationControl['role'] }
}

export function prohibitedNavigation(label: string, destination: string | null): boolean {
  return (
    /(?:log\s*(?:in|out)|sign\s*(?:in|out|up)|register|subscribe|purchase|checkout|delete|remove|add to|buy|donate|\u767b\u5f55|\u767b\u9304|\u6ce8\u518c|\u8a3b\u518a|\u5145\u503c|\u8d2d\u4e70|\u8cfc\u8cb7|\u8ba2\u9605|\u8a02\u95b1|\u52a0\u5165\u4e66\u67b6|\u52a0\u5165\u66f8\u67b6|\u6536\u85cf|\u5220\u9664|\u522a\u9664)/i.test(
      label,
    ) ||
    Boolean(
      destination &&
      /(?:\/|[?&])(?:logout|login|delete|checkout|action|subscribe)(?:\/|=|$)/i.test(destination),
    )
  )
}

export function checkNavigationDecision(
  snapshot: NavigationSnapshot,
  value: unknown,
): NavigationDecision {
  const decision = navigationDecisionSchema.parse(value)
  if (snapshot.blocked && !['stop', 'finish'].includes(decision.action))
    throw new Error('This page requires manual access review. Navigation stopped.')
  if (decision.action === 'scroll' && !snapshot.canScroll)
    throw new Error('The page cannot scroll further.')
  if (['click', 'select'].includes(decision.action)) {
    const control = snapshot.controls.find((entry) => entry.id === decision.controlId)
    if (!control || prohibitedNavigation(control.label, control.url))
      throw new Error('The chosen control is not an approved navigation action.')
    if (control.url && new URL(publicPageUrl(control.url)).origin !== new URL(snapshot.url).origin)
      throw new Error('Navigation must stay on the approved site.')
    if (
      decision.action === 'select' &&
      (control.role !== 'select' ||
        !control.options.some((option) => option.value === decision.value))
    )
      throw new Error('The selected option is not present in the page.')
    if (decision.action === 'click' && control.role === 'select')
      throw new Error('Choose a listed select option instead.')
  }
  return decision
}
