import { createServer } from 'node:http'
import { once } from 'node:events'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { chromium } from '@playwright/test'

const chapterCount = 16
const artificialLatencyMs = 200
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  const chapter = Number(url.pathname.split('/').at(-1))
  if (!Number.isInteger(chapter)) {
    response.writeHead(404).end()
    return
  }
  const challenged = url.searchParams.get('challenge') === 'true' && chapter > 10
  setTimeout(() => {
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(
      challenged
        ? '<title>Just a moment...</title><h1>Verify you are human</h1>'
        : `<title>Chapter ${chapter}</title><h1>Chapter ${chapter}</h1><main>${Array.from({ length: 30 }, (_, paragraph) => `<p>Original fixture paragraph ${paragraph + 1} in chapter ${chapter}.</p>`).join('')}</main>`,
    )
  }, artificialLatencyMs)
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
const browser = await chromium.launch({ headless: true })
try {
  for (const challenge of [false, true]) {
    for (const concurrency of [1, 2]) {
      const context = await browser.newContext()
      await context.route('https://books.example.test/**', async (route) => {
        const requested = new URL(route.request().url())
        const result = await fetch(
          `http://127.0.0.1:${address.port}${requested.pathname}${requested.search}`,
        )
        await route.fulfill({
          status: result.status,
          contentType: 'text/html',
          body: await result.text(),
        })
      })
      let next = 1
      let stopped = false
      let challenges = 0
      let navigationMs = 0
      let captureMs = 0
      const saved = new Set()
      const start = performance.now()
      const worker = async () => {
        const page = await context.newPage()
        while (next <= chapterCount && !stopped) {
          const chapter = next++
          const beforeNavigation = performance.now()
          await page.goto(`https://books.example.test/chapter/${chapter}?challenge=${challenge}`, {
            waitUntil: 'domcontentloaded',
          })
          navigationMs += performance.now() - beforeNavigation
          const beforeCapture = performance.now()
          await page.addScriptTag({ path: resolve('dist-extension/capture.js') })
          const captured = await page.evaluate(() => {
            const api = globalThis.__novelistNavigation
            const snapshot = api.observe()
            return snapshot.blocked ? { blocked: true } : { blocked: false, page: api.capture() }
          })
          captureMs += performance.now() - beforeCapture
          if (captured.blocked) {
            challenges++
            stopped = true
            continue
          }
          assert(captured.page.html.includes(`in chapter ${chapter}.`))
          saved.add(chapter)
        }
      }
      await Promise.all(Array.from({ length: concurrency }, worker))
      const elapsedMs = Math.round(performance.now() - start)
      assert.equal(saved.size, challenge ? 10 : chapterCount)
      console.log(
        JSON.stringify({
          mode: 'local-render-and-capture-only',
          concurrency,
          simulatedChallengeAfter: challenge ? 10 : null,
          artificialLatencyMs,
          saved: saved.size,
          challenges,
          elapsedMs,
          summedNavigationMs: Math.round(navigationMs),
          summedCaptureMs: Math.round(captureMs),
          chaptersPerMinute: Number(((saved.size * 60000) / elapsedMs).toFixed(1)),
        }),
      )
      await context.close()
    }
  }
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
