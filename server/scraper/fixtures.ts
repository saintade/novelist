import type { CapturedPage, ScrapedPage } from '../../src/lib/scraper/contracts.ts'

export interface ScraperFixture {
  page: CapturedPage
  expected: ScrapedPage
}

const origin = 'https://books.example.test'
export const trainingFixtures: ScraperFixture[] = [
  {
    page: {
      url: `${origin}/river-ledger`,
      html: '<html lang="en"><head><title>The River Ledger</title></head><body><nav><a href="/">Home</a></nav><main><h1>The River Ledger</h1><span class="author">N. Vale</span><p class="synopsis">Two clerks mend a damaged ferry ledger.</p><ol class="chapters"><li><a href="/river-ledger/1">1. The Rain</a></li><li><a href="/river-ledger/2">2. The Crossing</a></li></ol></main><footer>Subscribe to our newsletter.</footer></body></html>',
    },
    expected: {
      kind: 'index',
      title: 'The River Ledger',
      author: 'N. Vale',
      language: 'en',
      synopsis: 'Two clerks mend a damaged ferry ledger.',
      chapters: [
        { title: '1. The Rain', url: `${origin}/river-ledger/1` },
        { title: '2. The Crossing', url: `${origin}/river-ledger/2` },
      ],
    },
  },
  {
    page: {
      url: `${origin}/river-ledger/1`,
      html: '<html><body><nav><a href="/river-ledger">Contents</a></nav><h1>1. The Rain</h1><article class="chapter-body"><p>The rain stopped before dawn.</p><aside class="advert">Buy a new notebook.</aside><p>Mara opened the ledger. Three entries were missing.</p></article><a rel="next" href="/river-ledger/2">Next chapter</a></body></html>',
    },
    expected: {
      kind: 'chapter',
      title: '1. The Rain',
      contentSelector: '.chapter-body',
      paragraphs: [
        'The rain stopped before dawn.',
        'Mara opened the ledger. Three entries were missing.',
      ],
      nextPageUrl: null,
      nextChapterUrl: `${origin}/river-ledger/2`,
    },
  },
]

export const heldOutFixtures: ScraperFixture[] = [
  {
    page: {
      url: `${origin}/river-ledger/2`,
      html: '<html><body><h1>2. The Crossing</h1><article class="chapter-body"><p>At the crossing, Tomas counted the waiting boats.</p><p>"Only two," he said. "The third has not arrived."</p></article><a rel="next" data-page="continuation" href="/river-ledger/2?page=2">Continue this chapter</a><a class="next-chapter" href="/river-ledger/3">Next chapter</a></body></html>',
    },
    expected: {
      kind: 'chapter',
      title: '2. The Crossing',
      contentSelector: '.chapter-body',
      paragraphs: [
        'At the crossing, Tomas counted the waiting boats.',
        '"Only two," he said. "The third has not arrived."',
      ],
      nextPageUrl: `${origin}/river-ledger/2?page=2`,
      nextChapterUrl: `${origin}/river-ledger/3`,
    },
  },
  {
    page: {
      url: `${origin}/river-ledger/2?page=2`,
      html: '<html><body><h1>2. The Crossing</h1><section id="reader-text"><div class="paragraph">Mara waited until noon.</div><div class="paragraph">The missing boat carried no ledger.</div></section><a rel="next" href="/river-ledger/3">Next chapter</a><footer><a href="https://ads.example.test/offer">Offer</a></footer></body></html>',
    },
    expected: {
      kind: 'chapter',
      title: '2. The Crossing',
      contentSelector: '#reader-text',
      paragraphs: ['Mara waited until noon.', 'The missing boat carried no ledger.'],
      nextPageUrl: null,
      nextChapterUrl: `${origin}/river-ledger/3`,
    },
  },
  {
    page: {
      url: `${origin}/river-ledger/3`,
      html: '<html><body><h1>Chapter unavailable</h1><form><label>Password<input type="password"></label><button>Sign in</button></form><p>This chapter requires permission.</p></body></html>',
    },
    expected: { kind: 'blocked', reason: 'No readable chapter or chapter index found.' },
  },
]
