import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { storedChapterText } from './content.ts'

describe('compressed chapter storage', () => {
  it('reads legacy JSON and gzip without changing the original text', async () => {
    const text = JSON.stringify({
      title: 'Chapter 1',
      paragraphs: Array.from(
        { length: 60 },
        () => '\u9752\u5c9a\u6e21\u53e3\u3002 Exact source text and paragraph boundaries.',
      ),
    })
    const compressed = gzipSync(text)
    expect(compressed.byteLength).toBeLessThan(Buffer.byteLength(text) * 0.9)
    expect(await storedChapterText(new Blob([text]), 'chapter.json')).toBe(text)
    expect(await storedChapterText(new Blob([compressed]), 'chapter.json.gz')).toBe(text)
  })
  it('rejects broken compression instead of returning a partial chapter', async () => {
    const compressed = gzipSync('Complete original chapter.')
    await expect(
      storedChapterText(new Blob([compressed.subarray(0, -8)]), 'chapter.json.gz'),
    ).rejects.toThrow()
  })
  it('bounds decompressed output as well as stored input', async () => {
    const text = 'Original text. '.repeat(150000)
    await expect(storedChapterText(new Blob([text]), 'chapter.json')).rejects.toThrow('too large')
    await expect(storedChapterText(new Blob([gzipSync(text)]), 'chapter.json.gz')).rejects.toThrow(
      'too large',
    )
  })
})
