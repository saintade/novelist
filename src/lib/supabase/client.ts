import { createClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

export const supabase = createClient<Database>(
  import.meta.env.VITE_SUPABASE_URL || 'http://127.0.0.1:55321',
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'local-key-not-configured',
  {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    global: {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          keepalive:
            typeof input === 'string' &&
            input.includes('/rest/v1/reading_progress') &&
            init?.method === 'POST',
        }),
    },
  },
)

let sessionInitialization: Promise<string> | undefined

export function ensureSession(): Promise<string> {
  sessionInitialization ??= (async () => {
    const { data, error } = await supabase.auth.getSession()
    if (error) throw error
    if (data.session) return data.session.user.id
    const { data: signedIn, error: signInError } = await supabase.auth.signInAnonymously()
    if (signInError)
      throw new Error(`Could not connect to your local library: ${signInError.message}`)
    if (!signedIn.user) throw new Error('Could not create a private library session.')
    return signedIn.user.id
  })().catch((error) => {
    sessionInitialization = undefined
    throw error
  })
  return sessionInitialization
}
