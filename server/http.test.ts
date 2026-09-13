import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createProductionApp } from './http.ts'
import { productionConfiguration } from './config.ts'

describe('private production server', () => {
  it('boots the native Node entry point only with a restricted database and exits gracefully', async () => {
    const root = await mkdtemp(join(tmpdir(), 'novelist-native-'))
    await mkdir(join(root, 'dist'))
    await writeFile(
      join(root, 'dist', 'index.html'),
      '<!doctype html><title>Native Novelist</title>',
    )
    const reservation = createServer()
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve))
    const address = reservation.address()
    if (!address || typeof address === 'string') throw new Error('Missing test port')
    await new Promise<void>((resolve) => reservation.close(() => resolve()))
    try {
      for (const { restricted, originVariable } of [
        { restricted: false, originVariable: 'RENDER_EXTERNAL_URL' },
        { restricted: true, originVariable: 'RENDER_EXTERNAL_URL' },
        { restricted: true, originVariable: 'NOVELIST_PUBLIC_ORIGIN' },
      ]) {
        const preload = `globalThis.fetch = async input => { if (String(input) !== 'https://library.supabase.test/rest/v1/rpc/library_access_status') throw new Error('Unexpected startup network request'); return new Response(JSON.stringify({restricted:${restricted},allowed:false}),{headers:{'Content-Type':'application/json'}}) }`
        const child = spawn(
          process.execPath,
          [
            '--experimental-strip-types',
            '--import',
            `data:text/javascript,${encodeURIComponent(preload)}`,
            resolve('server/index.ts'),
          ],
          {
            cwd: root,
            env: {
              PATH: process.env.PATH,
              NODE_ENV: 'production',
              PORT: String(address.port),
              NOVELIST_ALLOWED_USER_ID: crypto.randomUUID(),
              [originVariable]: `https://127.0.0.1:${address.port}`,
              VITE_SUPABASE_URL: 'https://library.supabase.test',
              VITE_SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key-long',
              NOVELIST_ENABLE_LIVE_AI: 'false',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
        let errors = ''
        child.stderr.on('data', (chunk) => {
          errors += String(chunk)
        })
        const exited = once(child, 'exit')
        try {
          if (!restricted) {
            expect((await exited)[0]).not.toBe(0)
            expect(errors).toContain('Hosted database owner restriction is not configured')
            continue
          }
          await new Promise<void>((resolve, reject) => {
            let output = ''
            child.stdout.on('data', (chunk) => {
              output += String(chunk)
              if (output.includes('production server listening')) resolve()
            })
            child.once('error', reject)
            child.once('exit', (code) =>
              reject(new Error(`Native server exited before startup (${code}): ${errors}`)),
            )
          })
          const origin = `http://127.0.0.1:${address.port}`
          expect((await fetch(`${origin}/health`)).status).toBe(200)
          expect(
            await (
              await fetch(`${origin}/read/book/2`, { headers: { Accept: 'text/html' } })
            ).text(),
          ).toContain('Native Novelist')
          child.kill('SIGTERM')
          expect((await exited)[0]).toBe(0)
        } finally {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM')
            await exited
          }
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15000)
  it('fails closed without owner/origin settings and requires HTTPS', () => {
    expect(() => productionConfiguration({}, '')).toThrow('NOVELIST_ALLOWED_USER_ID')
    expect(() =>
      productionConfiguration(
        {
          NOVELIST_ALLOWED_USER_ID: crypto.randomUUID(),
          NOVELIST_PUBLIC_ORIGIN: 'http://example.test',
          VITE_SUPABASE_URL: 'https://library.supabase.co',
          VITE_SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key-long',
        },
        '',
      ),
    ).toThrow('NOVELIST_PUBLIC_ORIGIN')
    expect(() =>
      productionConfiguration(
        {
          NOVELIST_ALLOWED_USER_ID: crypto.randomUUID(),
          NOVELIST_PUBLIC_ORIGIN: 'https://example.test',
          VITE_SUPABASE_URL: 'https://library.supabase.co',
          VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_not_for_the_browser',
        },
        '',
      ),
    ).toThrow('VITE_SUPABASE_PUBLISHABLE_KEY')
  })
  it.each([undefined, '', '   '])('uses the Render runtime URL when the custom origin is absent or blank: %j', override => {
    const configuration = productionConfiguration({
      NOVELIST_ALLOWED_USER_ID: crypto.randomUUID(),
      NOVELIST_PUBLIC_ORIGIN: override,
      RENDER_EXTERNAL_URL: '  https://novelist-fixture.onrender.com/  ',
      VITE_SUPABASE_URL: 'https://library.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key-long',
    }, '')
    expect(configuration.publicOrigin).toBe('https://novelist-fixture.onrender.com')
    expect(configuration.hosted).toBe(true)
  })
  it('prefers an explicit custom origin over the Render URL', () => {
    const configuration = productionConfiguration({
      NOVELIST_ALLOWED_USER_ID: crypto.randomUUID(),
      NOVELIST_PUBLIC_ORIGIN: ' https://reader.example.test/ ',
      RENDER_EXTERNAL_URL: 'https://novelist-fixture.onrender.com',
      VITE_SUPABASE_URL: 'https://library.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key-long',
    }, '')
    expect(configuration.publicOrigin).toBe('https://reader.example.test')
  })
  it.each([
    'novelist-fixture.onrender.com',
    'http://novelist-fixture.onrender.com',
    'https://reader@novelist-fixture.onrender.com',
    'https://novelist-fixture.onrender.com/read/book/1',
    'https://novelist-fixture.onrender.com/?code=fixture',
    'https://novelist-fixture.onrender.com/#fragment',
    '${RENDER_EXTERNAL_URL}',
  ])('rejects unsafe origins from both explicit and Render configuration: %s', invalidOrigin => {
    const base = {
      NOVELIST_ALLOWED_USER_ID: crypto.randomUUID(),
      VITE_SUPABASE_URL: 'https://library.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key-long',
    }
    expect(() => productionConfiguration({ ...base, RENDER_EXTERNAL_URL: invalidOrigin }, '')).toThrow('NOVELIST_PUBLIC_ORIGIN')
    expect(() => productionConfiguration({ ...base, NOVELIST_PUBLIC_ORIGIN: invalidOrigin, RENDER_EXTERNAL_URL: 'https://novelist-fixture.onrender.com' }, '')).toThrow('NOVELIST_PUBLIC_ORIGIN')
  })
  it('explains the required origin when neither environment variable is configured', () => {
    expect(() => productionConfiguration({
      NOVELIST_ALLOWED_USER_ID: crypto.randomUUID(),
      VITE_SUPABASE_URL: 'https://library.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key-long',
    }, '')).toThrow('leave it unset to use RENDER_EXTERNAL_URL on Render')
  })
  it('serves nested reader URLs but never repository files or unauthenticated AI', async () => {
    const assets = await mkdtemp(join(tmpdir(), 'novelist-host-'))
    await writeFile(join(assets, 'index.html'), '<!doctype html><title>Private Novelist</title>')
    const configuration = productionConfiguration(
      {
        NOVELIST_ALLOWED_USER_ID: crypto.randomUUID(),
        NOVELIST_PUBLIC_ORIGIN: 'https://novelist.example.test',
        VITE_SUPABASE_URL: 'https://library.supabase.co',
        VITE_SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key-long',
      },
      assets,
    )
    const { app, batches } = createProductionApp(configuration, assets)
    const server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing server address')
    const origin = `http://127.0.0.1:${address.port}`
    configuration.publicOrigin = `https://127.0.0.1:${address.port}`
    const headers = { Origin: configuration.publicOrigin, 'Content-Type': 'application/json' }
    try {
      const page = await fetch(`${origin}/read/book/42`, { headers: { Accept: 'text/html' } })
      expect(await page.text()).toContain('Private Novelist')
      expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
      for (const path of [
        '/server/index.ts',
        '/.env.local',
        '/@fs/private',
        '/api/extension/ready',
        '/supabase/migrations/file.sql',
      ])
        expect((await fetch(origin + path)).status).toBe(404)
      expect(
        (await fetch(`${origin}/api/ai/book-translation`, { method: 'POST', headers, body: '{}' }))
          .status,
      ).toBe(401)
      expect(
        (
          await fetch(`${origin}/api/ai/book-translation`, {
            method: 'POST',
            headers: { ...headers, Origin: 'https://other.example' },
            body: '{}',
          })
        ).status,
      ).toBe(403)
      expect((await fetch(`${origin}/health`)).status).toBe(200)
    } finally {
      batches.stop()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(assets, { recursive: true, force: true })
    }
  })
})
