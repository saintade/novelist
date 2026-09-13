import { Fragment, useEffect, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { BookOpen, KeyRound, LoaderCircle, LogOut, Mail } from 'lucide-react'
import { z } from 'zod'
import { requiresPrivateSignIn, supabase } from '../../lib/supabase/client'
import { Dialog } from '../ui'

export function LibraryAccess({
  children,
  privateAccess = requiresPrivateSignIn,
}: {
  children: ReactNode
  privateAccess?: boolean
}) {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [verifiedOwner, setVerifiedOwner] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passwordSignIn, setPasswordSignIn] = useState(false)
  const [emailSent, setEmailSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!privateAccess) return
    let cancelled = false
    let receivedAuthEvent = false
    const callback = new URL(window.location.href)
    const fragment = new URLSearchParams(callback.hash.slice(1))
    const hasEmailCallback = ['code', 'error', 'error_code', 'access_token'].some(key => callback.searchParams.has(key) || fragment.has(key))
    void supabase.auth.initialize()
      .then(async (initialization) => {
        const result = await supabase.auth.getSession()
        if (!cancelled && !receivedAuthEvent) {
          setSession(result.data.session)
          if (!result.data.session && (initialization.error || hasEmailCallback))
            setError('This email link could not complete sign-in. Request a new link in the browser you are using now, then open the newest email in that same browser. No email code or password is needed.')
          else if (result.error) setError(result.error.message)
        }
      })
      .catch(() => {
        if (!cancelled && !receivedAuthEvent) {
          setSession(null)
          setError('The sign-in service could not be reached.')
        }
      })
    const { data } = supabase.auth.onAuthStateChange((event, current) => {
      if (cancelled || (event === 'INITIAL_SESSION' && receivedAuthEvent)) return
      if (event !== 'INITIAL_SESSION') receivedAuthEvent = true
      setSession(current)
      if (event !== 'INITIAL_SESSION') setError('')
      setVerifiedOwner((previous) =>
        event === 'SIGNED_OUT' || current?.user.id !== previous ? '' : previous,
      )
      if (event === 'SIGNED_OUT' || event === 'SIGNED_IN') {
        setPassword('')
        setPasswordSignIn(false)
        setEmailSent(false)
      }
    })
    return () => {
      cancelled = true
      data.subscription.unsubscribe()
    }
  }, [privateAccess])
  useEffect(() => {
    if (!privateAccess || !session || session.user.is_anonymous) return
    let cancelled = false
    void Promise.resolve(supabase.rpc('library_access_status'))
      .then((result) => {
        if (cancelled) return
        const access = z
          .object({ restricted: z.literal(true), allowed: z.literal(true) })
          .safeParse(result.data)
        if (result.error || !access.success) {
          setVerifiedOwner('')
          setError(
            'This account cannot open the private library, or its owner restriction has not been configured.',
          )
        } else setVerifiedOwner(session.user.id)
      })
      .catch(() => {
        if (!cancelled) {
          setVerifiedOwner('')
          setError('Library access could not be verified. Check your connection and retry.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [privateAccess, session, attempt])
  if (!privateAccess) return children
  if (session && !session.user.is_anonymous && verifiedOwner === session.user.id)
    return <Fragment key={session.user.id}>{children}</Fragment>
  const run = async (operation: () => Promise<{ error: { message: string } | null }>) => {
    setBusy(true)
    setError('')
    try {
      const result = await operation()
      if (result.error) setError(result.error.message)
    } catch {
      setError('The sign-in request failed. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="library-access">
      <BookOpen size={32} strokeWidth={1.4} />
      <h1>Novelist</h1>
      <p className="access-subtitle">Private library</p>
      {session === undefined || (session && !session.user.is_anonymous && !error) ? (
        <p role="status">
          <LoaderCircle className="spin" size={18} />
          Checking access...
        </p>
      ) : session && !session.user.is_anonymous ? (
        <div className="access-actions">
          <button
            className="button"
            onClick={() => {
              setError('')
              setAttempt((value) => value + 1)
            }}
          >
            Retry access
          </button>
          <button className="button" onClick={() => void run(() => supabase.auth.signOut())}>
            <LogOut size={16} />
            Sign out
          </button>
        </div>
      ) : (
        <form
          className="edit-form"
          onSubmit={(event) => {
            event.preventDefault()
            void run(async () => {
              if (passwordSignIn) return supabase.auth.signInWithPassword({ email: email.trim(), password })
              let result = await supabase.auth.signInWithOtp({
                email: email.trim(),
                options: { shouldCreateUser: false, emailRedirectTo: window.location.origin },
              })
              if (result.error?.code === 'signup_disabled')
                result = await supabase.auth.resend({
                  type: 'signup',
                  email: email.trim(),
                  options: { emailRedirectTo: window.location.origin },
                })
              if (!result.error) setEmailSent(true)
              return result
            })
          }}
        >
          <label>
            Email
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              disabled={busy}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          {passwordSignIn && (
            <label>
              Password
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={busy}
              />
            </label>
          )}
          <button className="button primary" disabled={busy}>
            {busy ? <LoaderCircle size={16} className="spin" /> : passwordSignIn ? <KeyRound size={16} /> : <Mail size={16} />}
            {passwordSignIn ? 'Sign in' : 'Email sign-in link'}
          </button>
          <button
            type="button"
            className="button subtle"
            disabled={busy}
            onClick={() => {
              setPasswordSignIn(previous => !previous)
              setPassword('')
              setEmailSent(false)
              setError('')
            }}
          >
            {passwordSignIn ? <Mail size={16} /> : <KeyRound size={16} />}
            {passwordSignIn ? 'Use email link' : 'Use password'}
          </button>
          {emailSent && <p role="status">Sign-in email sent.</p>}
        </form>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </main>
  )
}

export function TranslationSession() {
  useEffect(() => {
    let cancelled = false
    const send = (token?: string) => {
      if (!token || cancelled) return
      void fetch('/api/ai/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: '{}',
      }).catch(() => undefined)
    }
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (['INITIAL_SESSION', 'SIGNED_IN', 'TOKEN_REFRESHED'].includes(event))
        send(session?.access_token)
    })
    const focus = () => {
      void supabase.auth
        .getSession()
        .then((result) => send(result.data.session?.access_token))
        .catch(() => undefined)
    }
    window.addEventListener('focus', focus)
    return () => {
      cancelled = true
      data.subscription.unsubscribe()
      window.removeEventListener('focus', focus)
    }
  }, [])
  return null
}

export function LibraryAccount({ onClose }: { onClose: () => void }) {
  const [user, setUser] = useState<User | null>(null)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    let cancelled = false
    void supabase.auth
      .getUser()
      .then((result) => {
        if (!cancelled) {
          setUser(result.data.user)
          setEmail(result.data.user?.email ?? '')
          if (result.error) setError(result.error.message)
        }
      })
      .catch(() => {
        if (!cancelled)
          setError('The account could not be loaded. Check your connection and reopen this dialog.')
      })
    return () => {
      cancelled = true
    }
  }, [])
  return (
    <Dialog
      title="Library account"
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      {user && (
        <p className="account-owner">
          Owner ID <code>{user.id}</code>
        </p>
      )}
      <form
        className="edit-form"
        onSubmit={async (event) => {
          event.preventDefault()
          if (!user) return
          setBusy(true)
          setError('')
          setNotice('')
          try {
            if (user.is_anonymous || !user.email_confirmed_at) {
              if (!sent) {
                const result = await supabase.auth.updateUser({ email: email.trim() })
                if (result.error) throw result.error
                if (result.data.user?.id !== user.id)
                  throw new Error(
                    'The account identity changed. Stop and check the library owner before migrating.',
                  )
                setUser(result.data.user)
                if (!result.data.user.is_anonymous && result.data.user.email_confirmed_at)
                  setNotice('Email verified. Set a password for this account.')
                else {
                  setSent(true)
                  setNotice(
                    'Verification requested. Check the email sent by your Supabase project.',
                  )
                }
              } else {
                const result = await supabase.auth.verifyOtp({
                  email: email.trim(),
                  token: code.trim(),
                  type: 'email_change',
                })
                if (result.error) throw result.error
                const current = await supabase.auth.getUser()
                if (current.error) throw current.error
                if (current.data.user?.id !== user.id)
                  throw new Error(
                    'The account identity changed. Stop and check the library owner before migrating.',
                  )
                setUser(current.data.user)
                setNotice('Email verified. Set a password for this account.')
              }
            } else {
              const result = await supabase.auth.updateUser({ password })
              if (result.error) throw result.error
              setPassword('')
              setNotice('Password updated. The library owner ID is unchanged.')
            }
          } catch (failure) {
            setError(
              failure instanceof Error ? failure.message : 'The account could not be updated.',
            )
          } finally {
            setBusy(false)
          }
        }}
      >
        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            disabled={
              busy || sent || Boolean(user && !user.is_anonymous && user.email_confirmed_at)
            }
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        {user && !user.is_anonymous && user.email_confirmed_at ? (
          <label>
            New password
            <input
              type="password"
              minLength={8}
              autoComplete="new-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
            />
          </label>
        ) : (
          sent && (
            <label>
              Verification code
              <input
                autoComplete="one-time-code"
                required
                value={code}
                onChange={(event) => setCode(event.target.value)}
                disabled={busy}
              />
            </label>
          )
        )}
        <button className="button primary" disabled={!user || busy}>
          {busy ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}
          {user && !user.is_anonymous && user.email_confirmed_at
            ? 'Set password'
            : sent
              ? 'Verify email'
              : 'Link email to this library'}
        </button>
        {sent && (user?.is_anonymous || !user?.email_confirmed_at) && (
          <button
            type="button"
            className="button subtle"
            disabled={busy}
            onClick={() => {
              setSent(false)
              setCode('')
              setNotice('')
            }}
          >
            <Mail size={16} />
            Change email or resend
          </button>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {requiresPrivateSignIn && user && !user.is_anonymous && (
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                const result = await supabase.auth.signOut()
                if (result.error) setError(result.error.message)
                else window.location.assign('/')
              } catch {
                setError('Sign-out failed. Check your connection and try again.')
              } finally {
                setBusy(false)
              }
            }}
          >
            <LogOut size={16} />
            Sign out
          </button>
        )}
      </form>
    </Dialog>
  )
}
