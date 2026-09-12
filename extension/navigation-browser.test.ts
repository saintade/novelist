import { afterEach, expect, it, vi } from 'vitest'
import { browserNavigation } from './navigation-browser'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('opens an interactive chapter document while background resources are still loading', async () => {
  vi.useFakeTimers()
  const url = 'https://books.example.test/0214633001/8095_1.html'
  vi.stubGlobal('chrome', {
    tabs: { get: async () => ({ url, status: 'loading' }), update: vi.fn() },
    scripting: {
      executeScript: vi.fn(
        async (input: { files?: string[]; func?: (...args: unknown[]) => unknown }) => {
          if (input.files) return []
          if (input.func?.toString().includes('readyState'))
            return [{ result: { url, readyState: 'interactive' } }]
          return [
            {
              result: {
                id: crypto.randomUUID(),
                url,
                title: 'Chapter 1',
                excerpt: 'Chapter text',
                fingerprint: 'chapter-one',
                controls: [],
                linkCount: 0,
                chapterLinkCount: 0,
                chapterSamples: [],
                canScroll: false,
                blocked: false,
              },
            },
          ]
        },
      ),
    },
  })
  const opened = browserNavigation(1, 'https://books.example.test', async () => false)
    .open(url)
    .catch((error) => error)
  await vi.runAllTimersAsync()
  expect(await opened).toMatchObject({ url, blocked: false })
})

it('waits for the observed document to match the navigated tab before capturing a chapter', async () => {
  vi.useFakeTimers()
  const target = 'https://books.example.test/chapter/1'
  const previous = 'https://books.example.test/contents'
  const started = Date.now()
  const capture = { url: target, html: '<h1>Chapter 1</h1><p>Chapter text.</p>' }
  const snapshot = (url: string) => ({
    id: crypto.randomUUID(),
    url,
    title: 'Fixture',
    excerpt: '',
    fingerprint: url,
    controls: [],
    linkCount: 0,
    chapterLinkCount: 0,
    chapterSamples: [],
    canScroll: false,
    blocked: false,
  })
  let tabUrl = previous
  const executeScript = vi.fn(
    async (input: { files?: string[]; func?: (...args: unknown[]) => unknown }) => {
      if (input.files) return []
      if (input.func?.toString().includes('api.observe()'))
        return [{ result: snapshot(Date.now() - started < 2000 ? previous : target) }]
      return [{ result: capture }]
    },
  )
  vi.stubGlobal('chrome', {
    tabs: {
      get: async () => ({ url: tabUrl, status: 'complete' }),
      update: async (_tabId: number, update: { url: string }) => {
        tabUrl = update.url
      },
    },
    scripting: { executeScript },
  })
  const driver = browserNavigation(1, 'https://books.example.test', async () => false)
  const opened = driver.open(target)
  await vi.runAllTimersAsync()
  expect((await opened).url).toBe(target)
  expect(await driver.capture()).toEqual(capture)
})
