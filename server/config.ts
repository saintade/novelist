import { z } from 'zod'
import type { AIConfiguration } from './ai/experiments.ts'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/lib/supabase/database.types.ts'

export function productionConfiguration(
  environment: NodeJS.ProcessEnv,
  root: string,
): AIConfiguration {
  const source = z
    .object({
      NOVELIST_ALLOWED_USER_ID: z.string().uuid(),
      NOVELIST_PUBLIC_ORIGIN: z.url().refine((value) => {
        const url = new URL(value)
        return (
          url.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          url.pathname === '/' &&
          !url.search &&
          !url.hash
        )
      }, 'Use an HTTPS origin without a path or credentials.'),
      VITE_SUPABASE_URL: z
        .url()
        .refine((value) => new URL(value).protocol === 'https:', 'Hosted Supabase requires HTTPS.'),
      VITE_SUPABASE_PUBLISHABLE_KEY: z
        .string()
        .min(20)
        .refine((key) => {
          if (key.startsWith('sb_secret_')) return false
          if (key.split('.').length !== 3) return true
          try {
            return (
              JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8')).role ===
              'anon'
            )
          } catch {
            return false
          }
        }, 'Use only a publishable key or the legacy anon key, never a service-role/secret key.'),
      NOVELIST_AI_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(8),
      NOVELIST_AI_REQUESTS_PER_HOUR: z.coerce.number().int().nonnegative().default(0),
      NOVELIST_GROUP_OUTPUT_LIMIT: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z.coerce.number().int().min(16384).max(65536).optional(),
      ),
    })
    .safeParse(environment)
  if (!source.success)
    throw new Error(
      `Invalid production configuration: ${source.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    )
  if (environment.NOVELIST_ENABLE_LIVE_AI === 'true' && !environment.OPENAI_API_KEY)
    throw new Error('OPENAI_API_KEY is required when live AI is enabled.')
  return {
    root,
    hosted: true,
    publicOrigin: new URL(source.data.NOVELIST_PUBLIC_ORIGIN).origin,
    allowedUserId: source.data.NOVELIST_ALLOWED_USER_ID,
    supabaseUrl: source.data.VITE_SUPABASE_URL,
    publishableKey: source.data.VITE_SUPABASE_PUBLISHABLE_KEY,
    apiKey: environment.OPENAI_API_KEY || '',
    liveEnabled: environment.NOVELIST_ENABLE_LIVE_AI === 'true',
    model: environment.OPENAI_EXTRACTION_MODEL || 'gpt-5.6-luna',
    translationModel: environment.OPENAI_TRANSLATION_MODEL || 'gpt-5.6-luna',
    chatModel: environment.OPENAI_CHAT_MODEL || 'gpt-4.1-mini',
    identificationModel: environment.OPENAI_IDENTIFICATION_MODEL || 'gpt-5-nano',
    maxConcurrentRequests: source.data.NOVELIST_AI_CONCURRENCY,
    maxRequestsPerHour: source.data.NOVELIST_AI_REQUESTS_PER_HOUR,
    groupOutputLimit: source.data.NOVELIST_GROUP_OUTPUT_LIMIT,
  }
}

export async function verifyHostedDatabase(configuration: AIConfiguration) {
  const client = createClient<Database>(configuration.supabaseUrl, configuration.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const result = await client.rpc('library_access_status')
  if (result.error || !z.object({ restricted: z.literal(true) }).safeParse(result.data).success)
    throw new Error(
      'Hosted database owner restriction is not configured. Enable private library access on the migrated hosted database before starting this server.',
    )
}
