import { z } from 'zod'
import { translationTaskSchema } from '../translation/context.ts'

export const readerChatRequestSchema = z.object({
  requestId: z.string().uuid(),
  bookId: translationTaskSchema.shape.bookId,
  sourceKey: z.string().min(1).max(2048),
  sourceId: z.string().uuid().optional(),
  versionId: z.string().uuid().optional(),
  question: z.string().trim().min(1).max(4000),
  scope: z.enum(['chapter', 'recent', 'retrieval']).default('retrieval'),
  confirmed: z.boolean().default(false),
}).strict()
export const readerChatAnswerSchema = z.object({
  answer: z.string().min(1).max(16000),
  citations: z.array(z.object({ sourceId: z.string().max(30), quote: z.string().trim().min(1).max(500) }).strict()).max(8),
}).strict()
export const readerChatCitationSchema = z.object({ sourceId: z.string(), sourceKey: z.string(), title: z.string(), quote: z.string() })
export type ReaderChatContext = Pick<z.infer<typeof readerChatRequestSchema>, 'bookId' | 'sourceKey' | 'sourceId' | 'versionId'>
export type ReaderChatCitation = z.infer<typeof readerChatCitationSchema>
export const readerIndexRequestSchema = readerChatRequestSchema.pick({ bookId: true, sourceKey: true, sourceId: true })
export interface ReaderIndexStatus { chapters: number; indexedChapters: number; passages: number; remaining: number; estimatedBytes: number }