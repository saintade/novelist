// @vitest-environment jsdom
import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import type { AuthChangeEvent, Session } from '@supabase/supabase-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LibraryAccess } from './LibraryAccess'

const { auth, access } = vi.hoisted(() => ({
  auth: {
    initialize: vi.fn(async () => ({ error: null as { message: string } | null })),
    getSession: vi.fn(),
    onAuthStateChange: vi.fn<
      (callback: (event: AuthChangeEvent, session: Session | null) => void) => {
        data: { subscription: { unsubscribe: () => void } }
      }
    >(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    signInWithPassword: vi.fn(),
    signInAnonymously: vi.fn(),
    signInWithOtp: vi.fn(),
    resend: vi.fn(),
  },
  access: vi.fn(),
}))
vi.mock('../../lib/supabase/client', () => ({
  requiresPrivateSignIn: true,
  supabase: { auth, rpc: access },
}))
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
afterEach(() => vi.clearAllMocks())

describe('private library sign-in', () => {
  it('keeps the reader mounted during token refresh and clears it on sign-out or account changes', async () => {
    const session = {
      access_token: 'first-token',
      user: { id: 'owner', is_anonymous: false },
    } as Session
    const mounts = vi.fn()
    function ReaderFixture() {
      useEffect(() => {
        mounts()
      }, [])
      return <p>Private chapter</p>
    }
    auth.getSession.mockResolvedValue({ data: { session }, error: null })
    access.mockResolvedValue({ data: { restricted: true, allowed: true }, error: null })
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () =>
      root.render(
        <LibraryAccess>
          <ReaderFixture />
        </LibraryAccess>,
      ),
    )
    const changed = auth.onAuthStateChange.mock.calls.at(-1)![0]
    await act(async () => changed('TOKEN_REFRESHED', { ...session, access_token: 'renewed-token' }))
    expect(mounts).toHaveBeenCalledTimes(1)
    access.mockResolvedValue({ data: { restricted: true, allowed: false }, error: null })
    await act(async () =>
      changed('SIGNED_IN', { ...session, user: { ...session.user, id: 'other-owner' } }),
    )
    expect(container.textContent).not.toContain('Private chapter')
    await act(async () => changed('SIGNED_OUT', null))
    expect(container.textContent).toContain('Email sign-in link')
    await act(async () => root.unmount())
  })
  it('fails closed when access verification cannot be reached', async () => {
    auth.getSession.mockResolvedValue({
      data: { session: { access_token: 'test-token', user: { id: 'owner', is_anonymous: false } } },
      error: null,
    })
    access.mockRejectedValueOnce(new Error('offline'))
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () =>
      root.render(
        <LibraryAccess>
          <p>Private chapter</p>
        </LibraryAccess>,
      ),
    )
    expect(container.textContent).not.toContain('Private chapter')
    expect(container.textContent).toContain('could not be verified')
    await act(async () => root.unmount())
  })
  it('does not open a library or provision an anonymous user without a session', async () => {
    auth.getSession.mockResolvedValue({ data: { session: null }, error: null })
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () =>
      root.render(
        <LibraryAccess>
          <p>Private book contents</p>
        </LibraryAccess>,
      ),
    )
    expect(container.textContent).toContain('Email sign-in link')
    expect(container.textContent).not.toContain('Private book contents')
    expect(auth.signInAnonymously).not.toHaveBeenCalled()
    await act(async () => root.unmount())
  })
  it.each([
    { code: 'signup_disabled', confirmationError: null, expected: 'Sign-in email sent.' },
    { code: 'signup_disabled', confirmationError: 'Email delivery unavailable', expected: 'Email delivery unavailable' },
    { code: 'over_email_send_rate_limit', confirmationError: null, expected: 'Sign-in request rejected' },
    { code: null, confirmationError: null, expected: 'Sign-in email sent.' },
  ])('confirms pre-created accounts only for signup-disabled errors: $code / $expected', async ({ code, confirmationError, expected }) => {
    auth.getSession.mockResolvedValue({ data: { session: null }, error: null })
    auth.signInWithOtp.mockResolvedValue({ error: code ? { code, message: 'Sign-in request rejected' } : null })
    auth.resend.mockResolvedValue({ error: confirmationError ? { message: confirmationError } : null })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(<LibraryAccess><p>Private chapter</p></LibraryAccess>))
      const emailInput = container.querySelector<HTMLInputElement>('input[type="email"]')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(emailInput, 'owner@example.test')
        emailInput.dispatchEvent(new Event('input', { bubbles: true }))
      })
      const sendLink = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Email sign-in link'))!
      expect(sendLink.disabled).toBe(false)
      await act(async () => sendLink.click())
      expect(auth.signInWithOtp).toHaveBeenCalledWith({ email: 'owner@example.test', options: { shouldCreateUser: false, emailRedirectTo: window.location.origin } })
      if (code === 'signup_disabled')
        expect(auth.resend).toHaveBeenCalledWith({ type: 'signup', email: 'owner@example.test', options: { emailRedirectTo: window.location.origin } })
      else expect(auth.resend).not.toHaveBeenCalled()
      expect(container.textContent).toContain(expected)
      expect(container.textContent).not.toContain('Private chapter')
      expect(container.textContent).not.toContain('Enter email code')
      expect(container.querySelector('input[autocomplete="one-time-code"]')).toBeNull()
      expect(container.querySelector('input[type="password"]')).toBeNull()
      expect(auth.signInAnonymously).not.toHaveBeenCalled()
      expect(access).not.toHaveBeenCalled()
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })
  it.each([null, { message: 'PKCE code verifier not found' }])('shows an actionable callback error even after INITIAL_SESSION: %j', async initializationError => {
    auth.initialize.mockResolvedValueOnce({ error: initializationError })
    auth.getSession.mockResolvedValue({ data: { session: null }, error: null })
    const previousUrl = window.location.href
    window.history.replaceState(null, '', '/?code=fixture-callback-code')
    const container = document.createElement('div')
    const root = createRoot(container)
    try {
      await act(async () => root.render(<LibraryAccess><p>Private chapter</p></LibraryAccess>))
      await act(async () => auth.onAuthStateChange.mock.calls.at(-1)![0]('INITIAL_SESSION', null))
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('Request a new link in the browser you are using now')
      expect(container.textContent).not.toContain('fixture-callback-code')
      expect(container.textContent).not.toContain('Private chapter')
      expect(auth.signInWithOtp).not.toHaveBeenCalled()
      expect(auth.signInAnonymously).not.toHaveBeenCalled()
    } finally {
      await act(async () => root.unmount())
      window.history.replaceState(null, '', previousUrl)
    }
  })
  it('keeps a valid session when an old email callback fails', async () => {
    auth.initialize.mockResolvedValueOnce({ error: { message: 'Expired link' } })
    auth.getSession.mockResolvedValue({ data: { session: { access_token: 'fixture-token', user: { id: 'owner', is_anonymous: false } } }, error: null })
    access.mockResolvedValue({ data: { restricted: true, allowed: true }, error: null })
    const container = document.createElement('div')
    const root = createRoot(container)
    try {
      await act(async () => root.render(<LibraryAccess><p>Private chapter</p></LibraryAccess>))
      expect(container.textContent).toContain('Private chapter')
      expect(container.querySelector('[role="alert"]')).toBeNull()
    } finally { await act(async () => root.unmount()) }
  })
  it('offers password sign-in separately without requesting an email code', async () => {
    auth.getSession.mockResolvedValue({ data: { session: null }, error: null })
    const container = document.createElement('div')
    const root = createRoot(container)
    try {
      await act(async () => root.render(<LibraryAccess><p>Private chapter</p></LibraryAccess>))
      const usePassword = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Use password'))!
      await act(async () => usePassword.click())
      expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.required).toBe(true)
      expect(container.textContent).toContain('Sign in')
      expect(container.textContent).not.toContain('Email code')
      expect(auth.signInWithOtp).not.toHaveBeenCalled()
      const useEmail = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Use email link'))!
      await act(async () => useEmail.click())
      expect(container.querySelector('input[type="password"]')).toBeNull()
    } finally { await act(async () => root.unmount()) }
  })
  it('requires a permanent session and the database owner restriction', async () => {
    auth.getSession.mockResolvedValue({
      data: { session: { access_token: 'test-token', user: { id: 'owner', is_anonymous: false } } },
      error: null,
    })
    access.mockResolvedValue({ data: { restricted: true, allowed: false }, error: null })
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () =>
      root.render(
        <LibraryAccess>
          <p>Private book contents</p>
        </LibraryAccess>,
      ),
    )
    expect(container.textContent).not.toContain('Private book contents')
    expect(container.textContent).toContain('cannot open')
    await act(async () => root.unmount())
    access.mockResolvedValue({ data: { restricted: true, allowed: true }, error: null })
    const allowed = createRoot(container)
    await act(async () =>
      allowed.render(
        <LibraryAccess>
          <p>Private book contents</p>
        </LibraryAccess>,
      ),
    )
    expect(container.textContent).toContain('Private book contents')
    await act(async () => allowed.unmount())
  })
})
