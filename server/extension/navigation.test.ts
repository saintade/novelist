import { describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { discoverContents } from '../../src/lib/extension/contents'
import { createNavigationDOM } from '../../src/lib/extension/navigation-dom'
import {
  checkNavigationDecision,
  type NavigationDecision,
} from '../../src/lib/extension/navigation'
import {
  exploreBrowser,
  scanChapterContents,
  type NavigationDriver,
} from '../../extension/navigation-runner'
import { NavigationSessions, chooseNavigation, navigationFailure } from './navigation'

const mocks = vi.hoisted(() => ({ parse: vi.fn() }))
vi.mock('openai', async (original) => ({
  ...(await original<typeof import('openai')>()),
  default: class {
    responses = { parse: mocks.parse }
  },
}))

function fixture(html: string) {
  const dom = new JSDOM(html, {
    url: 'https://books.example.test/#/book/1',
    pretendToBeVisual: true,
  })
  dom.window.HTMLElement.prototype.getClientRects = () =>
    [{ width: 100, height: 20 }] as unknown as DOMRectList
  return dom
}
const decision = (controlId: string): NavigationDecision => ({
  action: 'click',
  controlId,
  value: null,
  intent: 'ascending',
  pageType: 'contents',
  repeat: false,
  reason: 'Open oldest-first contents.',
})

describe('registered browser navigation', () => {
  it.each([
    '<title>Just a moment...</title><h1>Performing security verification</h1>',
    '<title>Book page</title><p>Checking your browser before accessing the site</p>',
    '<title>Attention Required! | Cloudflare</title><p>Verify you are human</p>',
  ])('recognizes browser challenges before a chapter can be captured', (html) => {
    const dom = fixture(html)
    const api = createNavigationDOM(dom.window.document)
    const snapshot = api.observe()
    expect(snapshot.blocked).toBe(true)
    expect(() =>
      checkNavigationDecision(snapshot, { ...decision('missing'), intent: 'next_page' }),
    ).toThrow('access review')
    dom.window.close()
  })
  it('reuses a learned site control with a different chapter count and invalidates a failed rule', async () => {
    const dom = fixture(
      '<button id="reveal">Reveal 150 entries</button><button id="fallback">Expand all chapters</button><div id="chapters"><a href="#/chapter/1">Chapter 1</a></div>',
    )
    const api = createNavigationDOM(dom.window.document)
    let working = true
    const expand = () => {
      dom.window.document.getElementById('chapters')!.innerHTML =
        '<a href="#/chapter/1">Chapter 1</a><a href="#/chapter/2">Chapter 2</a>'
      dom.window.document.getElementById('reveal')!.remove()
      dom.window.document.getElementById('fallback')!.remove()
    }
    dom.window.document.getElementById('reveal')!.addEventListener('click', () => {
      if (working) expand()
    })
    dom.window.document.getElementById('fallback')!.addEventListener('click', expand)
    const driver = {
      observe: async () => api.observe(),
      collect: async (snapshot: ReturnType<typeof api.observe>) => ({
        url: snapshot.url,
        title: snapshot.title,
        links: api.links(snapshot.id, 0).links,
        truncated: false,
      }),
      act: async (snapshot: ReturnType<typeof api.observe>, action: NavigationDecision) =>
        api.act(snapshot.id, action),
      changed: async () => api.observe(),
      stopped: async () => false,
    }
    const saved = [
      {
        label: 'reveal # entries',
        role: 'button' as const,
        value: null,
        intent: 'load_more' as const,
      },
    ]
    const result = await scanChapterContents(
      'https://books.example.test',
      { chapterLinks: [], chapterCount: 2, indexUrl: null },
      driver,
      async () => undefined,
      saved,
    )
    expect(result.reused).toBe(1)
    expect(result.recipes).toEqual(saved)
    dom.window.document.body.innerHTML =
      '<button id="reveal">Reveal 999 entries</button><button id="fallback">Expand all chapters</button><div id="chapters"><a href="#/chapter/1">Chapter 1</a></div>'
    working = false
    dom.window.document.getElementById('fallback')!.addEventListener('click', expand)
    const repaired = await scanChapterContents(
      'https://books.example.test',
      { chapterLinks: [], chapterCount: 2, indexUrl: null },
      driver,
      async () => undefined,
      saved,
    )
    expect(repaired.invalidated).toBe(true)
    expect(repaired.capture.truncated).toBe(false)
    expect(repaired.recipes[0].label).toBe('expand all chapters')
    dom.window.close()
  })
  it('finds the contents from a landing page when identification omitted indexUrl, then expands all 754 chapters', async () => {
    const dom = fixture(
      '<a href="https://books.example.test/book/11508/index.html">Click to view all chapters</a><a href="/txt/11508/754.html">Chapter 754</a>',
    )
    const api = createNavigationDOM(dom.window.document)
    let current = api.observe()
    const acted: string[] = []
    const capture = await scanChapterContents(
      'https://books.example.test',
      { chapterLinks: [], chapterCount: 754, indexUrl: null },
      {
        observe: async () => current,
        collect: async (snapshot) => ({
          url: snapshot.url,
          title: snapshot.title,
          links:
            snapshot.chapterLinkCount === 754
              ? Array.from({ length: 754 }, (_, index) => ({
                  title: `Chapter ${index + 1}`,
                  url: `https://books.example.test/txt/11508/${index + 1}.html`,
                }))
              : [
                  { title: 'Read first', url: 'https://books.example.test/txt/11508/1.html' },
                  { title: 'Chapter 754', url: 'https://books.example.test/txt/11508/754.html' },
                ],
          truncated: false,
        }),
        act: async (_snapshot, action) => {
          acted.push(action.intent)
          current = {
            ...current,
            id: crypto.randomUUID(),
            url: 'https://books.example.test/book/11508/index.html',
            fingerprint: action.intent,
            chapterLinkCount: action.intent === 'contents' ? 1 : 754,
            controls: [
              {
                id: 'expand',
                label: 'Expand all 754 chapters',
                role: 'button',
                url: null,
                options: [],
              },
            ],
          }
        },
        changed: async () => current,
        stopped: async () => false,
      },
      async () => undefined,
    )
    expect(acted).toEqual(['contents', 'load_more'])
    expect(capture.capture.url).toBe('https://books.example.test/book/11508/index.html')
    expect(
      discoverContents(capture.capture, { chapterLinks: [], chapterCount: 754, indexUrl: null })
        .foundCount,
    ).toBe(754)
    expect(capture.capture.truncated).toBe(false)
    expect(
      discoverContents(capture.capture, { chapterLinks: [], chapterCount: 754, indexUrl: null })
        .chapters[0].number,
    ).toBe(1)
    dom.window.close()
  })
  it('collects all chapter-list pages through a JavaScript Next control', async () => {
    const dom = fixture(
      '<div id="latest"></div><section><h2>Chapter list</h2><div id="chapters"></div><div class="pagination"><a id="next" href="javascript:;" data-page-action="next">Next</a></div></section><button id="comments">Load More Comments</button>',
    )
    const document = dom.window.document
    const loadComments = vi.fn()
    document.getElementById('comments')!.addEventListener('click', loadComments)
    const chapterLink = (number: number) =>
      `<a href="/novel/example/chapter-${number}">Chapter ${number}</a>`
    document.getElementById('latest')!.innerHTML = Array.from({ length: 6 }, (_, index) =>
      chapterLink(122 - index),
    ).join('')
    let position = 0
    const render = () => {
      document.getElementById('chapters')!.innerHTML = Array.from(
        { length: Math.min(40, 122 - position) },
        (_, index) => chapterLink(position + index + 1),
      ).join('')
      if (position + 40 >= 122) document.getElementById('next')!.textContent = 'None'
    }
    render()
    document.getElementById('next')!.addEventListener('click', () => {
      position += 40
      render()
    })
    const api = createNavigationDOM(document)
    const initial = api.observe()
    expect(initial.chapterLinkCount).toBe(46)
    expect(initial.controls.find((control) => control.label === 'Next')?.url).toBeNull()
    const result = await scanChapterContents(
      'https://books.example.test',
      { chapterLinks: [], chapterCount: 122, indexUrl: null },
      {
        observe: async () => api.observe(),
        collect: async (snapshot) => ({
          url: snapshot.url,
          title: snapshot.title,
          links: api.links(snapshot.id, 0).links,
          truncated: false,
        }),
        act: async (snapshot, action) => api.act(snapshot.id, action),
        changed: async () => api.observe(),
        stopped: async () => false,
      },
      async () => undefined,
      [{ label: 'load more comments', role: 'button', value: null, intent: 'load_more' }],
    )
    expect(result.capture.links).toHaveLength(122)
    expect(result.actions).toBe(3)
    expect(result.capture.truncated).toBe(false)
    expect(result.recipes).toEqual([
      { label: 'next', role: 'link', value: null, intent: 'next_page' },
    ])
    expect(loadComments).not.toHaveBeenCalled()
    dom.window.close()
  })
  it('follows contents pagination and excludes visited next-page links from remaining coverage', async () => {
    const dom = fixture(
      '<a href="#/chapter/1">Chapter 1</a><a href="#/book/1/page/2">Next page</a>',
    )
    const api = createNavigationDOM(dom.window.document)
    const snapshot = api.observe()
    let current = snapshot
    const result = await scanChapterContents(
      'https://books.example.test',
      { chapterLinks: [], chapterCount: 2, indexUrl: null },
      {
        observe: async () => current,
        collect: async () => ({
          url: current.url,
          title: current.title,
          links:
            current === snapshot
              ? [
                  { title: 'Chapter 1', url: 'https://books.example.test/#/chapter/1' },
                  { title: 'Next page', url: 'https://books.example.test/#/book/1/page/2' },
                ]
              : [{ title: 'Chapter 2', url: 'https://books.example.test/#/chapter/2' }],
          truncated: false,
        }),
        act: async () => {
          current = {
            ...snapshot,
            id: crypto.randomUUID(),
            fingerprint: 'second',
            url: 'https://books.example.test/#/book/1/page/2',
            controls: [],
          }
        },
        changed: async () => current,
        stopped: async () => false,
      },
      async () => undefined,
    )
    const contents = discoverContents(result.capture, {
      chapterLinks: [],
      chapterCount: 2,
      indexUrl: null,
    })
    expect(contents.foundCount).toBe(2)
    expect(contents.nextContentsUrls).toEqual([])
    expect(result.actions).toBe(1)
    dom.window.close()
  })
  it('stops a no-progress scan, preserves partial links and respects cancellation', async () => {
    const dom = fixture('<button>Load more chapters</button><a href="#/chapter/1">Chapter 1</a>')
    const api = createNavigationDOM(dom.window.document)
    const snapshot = api.observe()
    const act = vi.fn(async () => undefined)
    let cancelled = false
    const driver = {
      observe: async () => snapshot,
      collect: async () => ({
        url: snapshot.url,
        title: snapshot.title,
        links: api.links(snapshot.id, 0).links,
        truncated: false,
      }),
      act,
      changed: async () => snapshot,
      stopped: async () => cancelled,
    }
    const result = await scanChapterContents(
      'https://books.example.test',
      { chapterCount: 100, chapterLinks: [], indexUrl: null },
      driver,
      async () => undefined,
    )
    expect(result.capture.truncated).toBe(true)
    expect(result.reason).toContain('did not reveal')
    expect(act).toHaveBeenCalledTimes(1)
    cancelled = true
    expect(
      (
        await scanChapterContents(
          'https://books.example.test',
          { chapterCount: 100, chapterLinks: [], indexUrl: null },
          driver,
          async () => undefined,
        )
      ).reason,
    ).toBe('Scan stopped.')
    expect(act).toHaveBeenCalledTimes(1)
    dom.window.close()
  })
  it('scans expand-all controls into a complete ordered inventory without a model or chapter capture', async () => {
    const dom = fixture(
      '<button id="expand">\u9ede\u64ca\u5c55\u958b\u5168\u90e8754\u7ae0\u7bc0\u76ee\u9304</button><div id="chapters"><a href="#/chapter/754">Chapter 754</a></div>',
    )
    const api = createNavigationDOM(dom.window.document)
    dom.window.document.getElementById('expand')!.addEventListener('click', () => {
      dom.window.document.getElementById('chapters')!.innerHTML = Array.from(
        { length: 754 },
        (_, index) => `<a href="#/chapter/${index + 1}">Chapter ${index + 1}</a>`,
      ).join('')
      dom.window.document.getElementById('expand')!.remove()
    })
    const result = await scanChapterContents(
      'https://books.example.test',
      { chapterLinks: [], chapterCount: 754, indexUrl: null },
      {
        observe: async () => api.observe(),
        collect: async (snapshot) => {
          const links = []
          let cursor: number | null = 0
          while (cursor !== null) {
            const batch = api.links(snapshot.id, cursor)
            links.push(...batch.links)
            cursor = batch.next
            expect(batch.links.length).toBeLessThanOrEqual(500)
          }
          return { url: snapshot.url, title: snapshot.title, links, truncated: false }
        },
        act: async (snapshot, decision) => api.act(snapshot.id, decision),
        changed: async () => api.observe(),
        stopped: async () => false,
      },
      async () => undefined,
    )
    expect(result.capture.links).toHaveLength(754)
    expect(result.capture.truncated).toBe(false)
    expect(result.actions).toBe(1)
    dom.window.close()
  })
  it('observes JavaScript controls without sending their code and captures expanded contents in batches', () => {
    const dom = fixture(
      '<html><body><a id="order" href="javascript:booklist()">Ascending order</a><button>Add to bookshelf</button><div id="chapters"></div></body></html>',
    )
    const api = createNavigationDOM(dom.window.document)
    dom.window.document.getElementById('order')!.addEventListener('click', (event) => {
      event.preventDefault()
      dom.window.document.getElementById('chapters')!.innerHTML = Array.from(
        { length: 7805 },
        (_, index) => `<a href="#/chapter/${index + 1}">Chapter ${index + 1}</a>`,
      ).join('')
    })
    const before = api.observe()
    expect(JSON.stringify(before)).not.toContain('booklist()')
    expect(before.controls.map((control) => control.label)).not.toContain('Add to bookshelf')
    api.act(before.id, decision(before.controls[0].id))
    const after = api.observe()
    expect(after.url).toBe(before.url)
    expect(after.fingerprint).not.toBe(before.fingerprint)
    expect(after.chapterLinkCount).toBe(7805)
    expect(after.controls.length).toBeLessThanOrEqual(60)
    const urls = new Set<string>()
    let cursor: number | null = 0
    while (cursor !== null) {
      const batch = api.links(after.id, cursor)
      batch.links.forEach((entry) => urls.add(entry.url))
      cursor = batch.next
      expect(batch.links.length).toBeLessThanOrEqual(500)
    }
    expect(urls.size).toBe(7805)
    dom.window.close()
  })
  it('rejects stale controls, off-origin links and blocked access', () => {
    const dom = fixture(
      '<button id="next">Next chapter</button><a href="https://other.example/pay">Buy</a>',
    )
    const api = createNavigationDOM(dom.window.document)
    const snapshot = api.observe()
    expect(snapshot.controls).toHaveLength(1)
    dom.window.document.getElementById('next')!.textContent = 'Purchase'
    expect(() => api.act(snapshot.id, decision(snapshot.controls[0].id))).toThrow('changed')
    expect(() =>
      checkNavigationDecision({ ...snapshot, blocked: true }, decision(snapshot.controls[0].id)),
    ).toThrow('manual access')
    expect(() => checkNavigationDecision(snapshot, decision('invented-control'))).toThrow(
      'approved navigation',
    )
    dom.window.close()
  })
  it('selects only an observed option using native DOM events', () => {
    const dom = fixture(
      '<select aria-label="Chapter order"><option value="desc">Newest first</option><option value="asc">Ascending</option></select>',
    )
    const api = createNavigationDOM(dom.window.document)
    const snapshot = api.observe()
    api.act(snapshot.id, { ...decision(snapshot.controls[0].id), action: 'select', value: 'asc' })
    expect(dom.window.document.querySelector('select')!.value).toBe('asc')
    expect(() =>
      api.act(snapshot.id, {
        ...decision(snapshot.controls[0].id),
        action: 'select',
        value: 'injected',
      }),
    ).toThrow('not present')
    dom.window.close()
  })
})

describe('bounded browser exploration', () => {
  it('captures sequential rendered samples using one model decision and a validated repeating control', async () => {
    let chapter = 1
    let modelCalls = 0
    const snapshots = [1, 2, 3].map((number) => ({
      id: crypto.randomUUID(),
      url: `https://books.example.test/#/chapter/${number}`,
      title: `Chapter ${number}`,
      excerpt: `Chapter ${number} content`,
      fingerprint: `${number}`,
      controls: [
        {
          id: `next-${number}`,
          label: 'Next chapter',
          role: 'link' as const,
          url: `https://books.example.test/#/chapter/${number + 1}`,
          options: [],
        },
      ],
      linkCount: 1,
      chapterLinkCount: 0,
      chapterSamples: [],
      canScroll: false,
      blocked: false,
    }))
    const driver: NavigationDriver = {
      observe: async () => snapshots[chapter - 1],
      collect: async (snapshot) => ({
        url: snapshot.url,
        title: snapshot.title,
        links: [],
        truncated: false,
      }),
      capture: async () => ({
        url: snapshots[chapter - 1].url,
        html: `<p>Chapter ${chapter} contents.</p>`,
      }),
      act: async () => {
        chapter++
      },
      changed: async () => snapshots[chapter - 1],
      stopped: async () => false,
      progress: async () => undefined,
      decide: async (snapshot) => {
        modelCalls++
        return {
          decision: {
            ...decision(snapshot.controls[0].id),
            intent: 'next_chapter',
            pageType: 'chapter',
            repeat: true,
          },
          model: 'test-only',
          inputTokens: 5,
          outputTokens: 5,
        }
      },
    }
    const run = await exploreBrowser('test-run', 'samples', 'https://books.example.test', driver)
    expect(run.pages).toHaveLength(3)
    expect(run.actions).toBe(2)
    expect(modelCalls).toBe(1)
    expect(run.activity[1].reused).toBe(true)
    expect(run.recipe?.label).toBe('Next chapter')
    expect(run.state).toBe('completed')
  })

  it('does not repeat no-progress actions and obeys cancellation before a click', async () => {
    const dom = fixture('<button>Load more chapters</button>')
    const snapshot = createNavigationDOM(dom.window.document).observe()
    const act = vi.fn(async () => undefined)
    let cancelled = false
    const driver: NavigationDriver = {
      observe: async () => snapshot,
      collect: async () => ({ url: snapshot.url, title: '', links: [], truncated: false }),
      act,
      changed: async () => snapshot,
      capture: async () => ({ url: snapshot.url, html: '<p>test</p>' }),
      stopped: async () => cancelled,
      progress: async () => undefined,
      decide: async () => ({
        decision: { ...decision(snapshot.controls[0].id), intent: 'load_more', repeat: true },
        model: 'test',
        inputTokens: 0,
        outputTokens: 0,
      }),
    }
    expect(
      (await exploreBrowser('one', 'contents', new URL(snapshot.url).origin, driver)).reason,
    ).toContain('did not change')
    expect(act).toHaveBeenCalledTimes(1)
    cancelled = true
    expect(
      (await exploreBrowser('two', 'contents', new URL(snapshot.url).origin, driver)).state,
    ).toBe('stopped')
    expect(act).toHaveBeenCalledTimes(1)
    dom.window.close()
  })

  it('limits planner sessions by connection, origin and model-call budget', () => {
    const dom = fixture('<button>Next chapter</button>')
    const snapshot = createNavigationDOM(dom.window.document).observe()
    const sessions = new NavigationSessions()
    const session = sessions.start(
      'connection',
      { url: snapshot.url, goal: 'samples', confirmed: true },
      'gpt-5-nano',
    )
    expect(() => sessions.take('outsider', session.id, snapshot)).toThrow('expired')
    expect(() =>
      sessions.take('connection', session.id, { ...snapshot, url: 'https://other.example/' }),
    ).toThrow('approved site')
    for (let index = 0; index < 3; index++)
      sessions.take('connection', session.id, snapshot).release()
    expect(() => sessions.take('connection', session.id, snapshot)).toThrow('budget')
    dom.window.close()
  })

  it('asks the model for a registered action, never executable code', async () => {
    const dom = fixture('<a href="javascript:booklist()">Ascending order</a>')
    const snapshot = createNavigationDOM(dom.window.document).observe()
    mocks.parse.mockResolvedValueOnce({
      status: 'completed',
      output_parsed: decision(snapshot.controls[0].id),
      usage: { input_tokens: 150, output_tokens: 80 },
    })
    const plan = await chooseNavigation(
      snapshot,
      { goal: 'contents', history: [] },
      { apiKey: 'test-only', model: 'gpt-5-nano' },
    )
    expect(plan.decision.controlId).toBe(snapshot.controls[0].id)
    const schema = mocks.parse.mock.lastCall![0].text.format.schema
    expect(schema.properties.action.enum).not.toContain('scroll')
    expect(JSON.stringify(schema.properties.controlId)).toContain(snapshot.controls[0].id)
    expect(mocks.parse.mock.lastCall![0]).toMatchObject({
      reasoning: { effort: 'minimal' },
      store: false,
      max_output_tokens: 1200,
    })
    expect(JSON.stringify(mocks.parse.mock.lastCall![0].input)).not.toContain(
      'javascript:booklist()',
    )
    dom.window.close()
  })
  it('reports unavailable controls and incomplete replies as navigation errors', async () => {
    const dom = fixture('<button>Next chapter</button>')
    const snapshot = createNavigationDOM(dom.window.document).observe()
    mocks.parse.mockResolvedValueOnce({
      status: 'completed',
      output_parsed: decision('invented-control'),
    })
    await expect(
      chooseNavigation(
        snapshot,
        { goal: 'contents', history: [] },
        { apiKey: 'test-only', model: 'gpt-5-nano' },
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('not available in this observation'),
      status: 502,
    })
    expect(navigationFailure(new SyntaxError('Unterminated JSON')).message).toContain(
      'navigation reply was incomplete',
    )
    expect(navigationFailure(new Error('private provider data')).message).not.toContain(
      'private provider data',
    )
    dom.window.close()
  })
})
