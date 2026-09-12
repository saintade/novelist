import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { aiExperimentPlugin } from './server/ai/plugin.ts'

export default defineConfig(({ mode }) => {
  const environment = { ...loadEnv(mode, process.cwd(), ''), ...process.env }
  return {
    server: {
      fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.novelist/**'] },
    },
    plugins: [
      react(),
      aiExperimentPlugin({
        root: process.cwd(),
        supabaseUrl: environment.VITE_SUPABASE_URL || 'http://127.0.0.1:55321',
        publishableKey: environment.VITE_SUPABASE_PUBLISHABLE_KEY || 'local-key-not-configured',
        allowedUserId: environment.NOVELIST_ALLOWED_USER_ID || undefined,
        apiKey: environment.OPENAI_API_KEY || '',
        liveEnabled: environment.NOVELIST_ENABLE_LIVE_AI === 'true',
        model: environment.OPENAI_EXTRACTION_MODEL || 'gpt-5.6-luna',
        translationModel: environment.OPENAI_TRANSLATION_MODEL || 'gpt-5.6-luna',
        scraperModel:
          environment.OPENAI_SCRAPER_MODEL || environment.OPENAI_EXTRACTION_MODEL || 'gpt-5.6-luna',
        identificationModel: environment.OPENAI_IDENTIFICATION_MODEL || 'gpt-5-nano',
        maxConcurrentRequests: Number(environment.NOVELIST_AI_CONCURRENCY || 8),
        maxRequestsPerHour: Number(environment.NOVELIST_AI_REQUESTS_PER_HOUR || 0),
        groupOutputLimit: environment.NOVELIST_GROUP_OUTPUT_LIMIT ? Number(environment.NOVELIST_GROUP_OUTPUT_LIMIT) : undefined,
        chatModel: environment.OPENAI_CHAT_MODEL || 'gpt-4.1-mini',
      }),
    ],
  }
})
