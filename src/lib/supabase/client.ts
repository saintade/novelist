import { createClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

const configuredUrl = import.meta.env.VITE_SUPABASE_URL || 'http://127.0.0.1:55321'
const localHosts = ['localhost', '127.0.0.1', '[::1]']
export const requiresPrivateSignIn = import.meta.env.VITE_AUTH_MODE === 'private' || !localHosts.includes(new URL(configuredUrl).hostname) || !localHosts.includes(window.location.hostname)
// Dashboard-generated emails use token callbacks, while app-requested emails use PKCE.
const tokenCallback = new URLSearchParams(window.location.hash.slice(1)).has('access_token')

export const supabase = createClient<Database>(
  configuredUrl,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'local-key-not-configured',
  {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: requiresPrivateSignIn, flowType: tokenCallback ? 'implicit' : 'pkce' },
    global: {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          keepalive:
            typeof input === 'string' &&
            (input.includes('/rest/v1/reading_progress') || input.includes('/rest/v1/rpc/save_source_reading_position')) &&
            init?.method === 'POST',
        }),
    },
  },
)

let sessionInitialization: Promise<string> | undefined
// Subscribe before React mounts: URL recovery can finish before the access gate subscribes.
let recoveryUserId = ''
export function passwordRecoveryPending(userId?: string) {
  return Boolean(userId && recoveryUserId === userId)
}
export function completePasswordRecovery() {
  recoveryUserId = ''
}
supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY') recoveryUserId = session?.user.id ?? ''
  if (event === 'SIGNED_OUT') completePasswordRecovery()
  if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') sessionInitialization = undefined
})

export function ensureSession(): Promise<string> {
  sessionInitialization ??= (async () => {
    const { data, error } = await supabase.auth.getSession()
    if (error) throw error
    if (data.session) {
      if (requiresPrivateSignIn && data.session.user.is_anonymous) throw new Error('Sign in with the private library account.')
      return data.session.user.id
    }
    if (requiresPrivateSignIn) throw new Error('Sign in with the private library account.')
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
