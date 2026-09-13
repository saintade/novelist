import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:https'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createProductionApp } from '../../server/http.ts'
import type { TranslationBatchManager } from '../../server/ai/translation-batches.ts'

test.use({ ignoreHTTPSErrors: true })
let assets: string
let origin: string
let server: Server
let batches: TranslationBatchManager

test.beforeAll(async () => {
  assets = await mkdtemp(join(tmpdir(), 'novelist-private-browser-'))
  execFileSync(
    process.execPath,
    [resolve('node_modules/vite/bin/vite.js'), 'build', '--outDir', join(assets, 'dist')],
    {
      env: {
        ...process.env,
        VITE_AUTH_MODE: 'private',
        VITE_SUPABASE_URL: 'https://private-library.supabase.test',
        VITE_SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key-for-private-build',
        NOVELIST_ENABLE_LIVE_AI: 'false',
        OPENAI_API_KEY: '',
      },
      stdio: 'pipe',
    },
  )
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-keyout',
      join(assets, 'test.key'),
      '-out',
      join(assets, 'test.pem'),
    ],
    { stdio: 'pipe' },
  )
  const configuration = {
    root: assets,
    hosted: true,
    allowedUserId: crypto.randomUUID(),
    publicOrigin: 'https://127.0.0.1',
    supabaseUrl: 'https://private-library.supabase.test',
    publishableKey: 'test-publishable-key-for-private-build',
    apiKey: '',
    liveEnabled: false,
    model: 'test-only',
  }
  const production = createProductionApp(configuration, join(assets, 'dist'))
  batches = production.batches
  server = createServer(
    {
      key: await readFile(join(assets, 'test.key')),
      cert: await readFile(join(assets, 'test.pem')),
    },
    production.app,
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing private browser server port')
  origin = `https://127.0.0.1:${address.port}`
  configuration.publicOrigin = origin
})

test.afterAll(async () => {
  batches?.stop()
  server?.closeAllConnections()
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
  if (assets) await rm(assets, { recursive: true, force: true })
})

test('private production sign-in isolates accounts and supports password and email-link recovery', async ({
  page,
}, testInfo) => {
  let allowed = false
  let dataRequests = 0
  let writes = 0
  let anonymousRequests = 0
  let paidRequests = 0
  let rejectCallback = false
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(error.message))
  page.on('request', (request) => {
    if (request.url().includes('/api/ai/') && !request.url().endsWith('/api/ai/session') && request.method() === 'POST') paidRequests += 1
  })
  await page.route('**/api/ai/session', route => route.fulfill({ json: { resumed: 0 } }))
  const user = {
    id: crypto.randomUUID(),
    aud: 'authenticated',
    role: 'authenticated',
    email: 'reader@example.test',
    is_anonymous: false,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    created_at: new Date().toISOString(),
    email_confirmed_at: new Date().toISOString(),
  }
  const payload = Buffer.from(
    JSON.stringify({
      sub: user.id,
      role: 'authenticated',
      aud: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString('base64url')
  const session = {
    access_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.fixture`,
    refresh_token: 'fixture-refresh',
    token_type: 'bearer',
    expires_in: 3600,
    user,
  }
  const otpRequests: unknown[] = []
  const otpRedirects: (string | null)[] = []
  const confirmationRequests: unknown[] = []
  let needsConfirmation = false
  const passwordUpdates: unknown[] = []
  const resetRequests: unknown[] = []
  await page.route('https://private-library.supabase.test/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    let body: unknown = {}
    let responseStatus = 200
    if (path === '/auth/v1/signup') {
      anonymousRequests += 1
      body = { error: 'Unexpected anonymous provision' }
    } else if (path === '/auth/v1/token' && rejectCallback) {
      responseStatus = 400
      body = { code: 'flow_state_not_found', msg: 'Invalid or expired verification request' }
    } else if (path === '/auth/v1/token' || path === '/auth/v1/verify') body = session
    else if (path === '/auth/v1/user') {
      body = user
      if (request.method() === 'PUT') passwordUpdates.push(request.postDataJSON())
    } else if (path === '/auth/v1/logout') body = {}
    else if (path === '/auth/v1/otp') {
      otpRequests.push(request.postDataJSON())
      otpRedirects.push(new URL(request.url()).searchParams.get('redirect_to'))
      if (needsConfirmation) {
        responseStatus = 422
        body = { code: 'signup_disabled', msg: 'Signups not allowed for this instance' }
      }
    } else if (path === '/auth/v1/recover') {
      resetRequests.push(request.postDataJSON())
      expect(new URL(request.url()).searchParams.get('redirect_to')).toBe(origin)
    } else if (path === '/auth/v1/resend') {
      confirmationRequests.push(request.postDataJSON())
      expect(new URL(request.url()).searchParams.get('redirect_to')).toBe(origin)
    } else if (path === '/rest/v1/rpc/library_access_status') body = { restricted: true, allowed }
    else if (path.startsWith('/rest/v1/')) {
      dataRequests += 1
      if (request.method() !== 'GET') writes += 1
      body = []
    } else failures.push(`Unexpected request: ${path}`)
    await route.fulfill({
      status: responseStatus,
      contentType: 'application/json',
      headers: { 'x-supabase-api-version': '2024-01-01', 'access-control-expose-headers': 'x-supabase-api-version' },
      body: JSON.stringify(body),
    })
  })
  await page.goto(`${origin}/?code=fixture-callback-without-request`)
  await expect(page.getByRole('alert')).toContainText('Request a new link in the browser you are using now')
  await expect(page.getByRole('alert')).not.toContainText('fixture-callback-without-request')
  expect(dataRequests).toBe(0)
  await page.goto(`${origin}/read/example/42`)
  await expect(page.getByRole('heading', { name: 'Novelist', exact: true })).toBeVisible()
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Email sign-in link', exact: true })).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('private-sign-in.png'), fullPage: true })
  expect(dataRequests).toBe(0)
  expect(anonymousRequests).toBe(0)
  await page.getByLabel('Email', { exact: true }).fill(user.email)
  await page.getByRole('button', { name: 'Use password', exact: true }).click()
  await page.getByLabel('Password', { exact: true }).fill('fixture-password-123')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('cannot open the private library')
  expect(dataRequests).toBe(0)
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Email sign-in link', exact: true })).toBeVisible()
  allowed = true
  await page.goto(`${origin}/`)
  await page.getByLabel('Email', { exact: true }).fill(user.email)
  await page.getByRole('button', { name: 'Use password', exact: true }).click()
  await page.getByLabel('Password', { exact: true }).fill('fixture-password-123')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.locator('.app-shell')).toBeVisible()
  expect(writes).toBe(0)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Library account', exact: true }).click()
  const account = page.getByRole('dialog', { name: 'Library account', exact: true })
  await expect(account).toContainText(user.id)
  await expect(account.getByLabel('New password', { exact: true })).toHaveAttribute('minlength', '8')
  await account.getByLabel('New password', { exact: true }).fill('fixture-new-password-123')
  await account.getByRole('button', { name: 'Set password', exact: true }).click()
  await expect(account.getByRole('status')).toContainText('Password updated')
  expect(passwordUpdates).toEqual([
    expect.objectContaining({ password: 'fixture-new-password-123' }),
  ])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('private-account.png'), fullPage: true })
  await account.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Email sign-in link', exact: true })).toBeVisible()
  await page.getByLabel('Email', { exact: true }).fill(user.email)
  await page.getByRole('button', { name: 'Email sign-in link', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('Sign-in email sent.')
  expect(otpRedirects).toEqual([origin])
  rejectCallback = true
  await page.goto(`${origin}/?code=fixture-expired-email-link-code`)
  await expect(page.getByRole('alert')).toContainText('This email link could not complete sign-in')
  await expect(page.getByRole('button', { name: 'Email sign-in link', exact: true })).toBeVisible()
  rejectCallback = false
  await page.getByLabel('Email', { exact: true }).fill(user.email)
  await page.getByRole('button', { name: 'Email sign-in link', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('Sign-in email sent.')
  await page.goto(`${origin}/?code=fixture-email-link-code`)
  await expect(page.locator('.app-shell')).toBeVisible()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Library account', exact: true }).click()
  await page.getByRole('dialog', { name: 'Library account', exact: true }).getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Email sign-in link', exact: true })).toBeVisible()
  await page.getByLabel('Email', { exact: true }).fill(user.email)
  needsConfirmation = true
  await page.getByRole('button', { name: 'Email sign-in link', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('Sign-in email sent.')
  await expect(page.getByRole('button', { name: 'Enter email code', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('Email code', { exact: true })).toHaveCount(0)
  expect(otpRequests).toEqual(Array.from({ length: 3 }, () => expect.objectContaining({ email: user.email, create_user: false })))
  expect(confirmationRequests).toEqual([expect.objectContaining({ type: 'signup', email: user.email, code_challenge: expect.any(String), code_challenge_method: 's256' })])
  await page.goto(`${origin}/?code=fixture-confirmation-link-code`)
  await expect(page.locator('.app-shell')).toBeVisible()
  // Recovery requested by the app uses a PKCE callback.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Library account', exact: true }).click()
  await page.getByRole('dialog', { name: 'Library account', exact: true }).getByRole('button', { name: 'Sign out', exact: true }).click()
  await page.getByRole('button', { name: 'Use password', exact: true }).click()
  await page.getByRole('button', { name: 'Forgot password?', exact: true }).click()
  await page.getByLabel('Email', { exact: true }).fill(user.email)
  await page.getByRole('button', { name: 'Send password reset link', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('password reset link has been sent')
  expect(resetRequests).toEqual([expect.objectContaining({ email: user.email, code_challenge: expect.any(String) })])
  await page.goto(`${origin}/?code=fixture-recovery-code`)
  await expect(page.getByRole('heading', { name: 'Reset password', exact: true })).toBeVisible()
  await expect(page.locator('.app-shell')).toHaveCount(0)
  await page.getByLabel('New password', { exact: true }).fill('fixture-reset-password-123')
  await page.getByLabel('Confirm new password', { exact: true }).fill('fixture-mismatched-password')
  await page.getByRole('button', { name: 'Update password', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Passwords do not match')
  expect(passwordUpdates).toHaveLength(1)
  await page.getByLabel('Confirm new password', { exact: true }).fill('fixture-reset-password-123')
  await page.getByRole('button', { name: 'Update password', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('Password updated.')
  await page.getByRole('button', { name: 'Continue to library', exact: true }).click()
  await expect(page.locator('.app-shell')).toBeVisible()
  expect(passwordUpdates).toHaveLength(2)

  // Supabase dashboard recovery emails carry tokens instead of a PKCE code.
  const callback = new URLSearchParams({
    access_token: session.access_token, refresh_token: session.refresh_token,
    expires_in: '3600', token_type: 'bearer', type: 'recovery',
  })
  await page.goto(`${origin}/#${callback}`)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Reset password', exact: true })).toBeVisible()
  await expect(page.locator('.app-shell')).toHaveCount(0)
  await expect(page).not.toHaveURL(/access_token/)
  expect(anonymousRequests).toBe(0)
  expect(paidRequests).toBe(0)
  expect(writes).toBe(0)
  expect(failures).toEqual([])
})
