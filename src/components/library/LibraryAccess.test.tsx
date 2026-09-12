// @vitest-environment jsdom
import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import type { AuthChangeEvent, Session } from '@supabase/supabase-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LibraryAccess } from './LibraryAccess'

const { auth, access } = vi.hoisted(() => ({
  auth: {
    getSession: vi.fn(),
    onAuthStateChange: vi.fn<
      (callback: (event: AuthChangeEvent, session: Session | null) => void) => {
        data: { subscription: { unsubscribe: () => void } }
      }
    >(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    signInWithPassword: vi.fn(),
    signInAnonymously: vi.fn(),
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
    expect(container.textContent).toContain('Sign in')
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
    expect(container.textContent).toContain('Sign in')
    expect(container.textContent).not.toContain('Private book contents')
    expect(auth.signInAnonymously).not.toHaveBeenCalled()
    await act(async () => root.unmount())
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
