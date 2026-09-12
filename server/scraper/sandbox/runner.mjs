import { load } from 'cheerio'

const chunks = []
let length = 0
for await (const chunk of process.stdin) {
  length += chunk.length
  if (length > 1_000_000) throw new Error('Sandbox input is too large.')
  chunks.push(chunk)
}
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
if (
  typeof input.code !== 'string' ||
  input.code.length > 24_000 ||
  typeof input.page?.html !== 'string' ||
  input.page.html.length > 80_000
)
  throw new Error('Invalid sandbox input.')
const adapter = await import(
  `data:text/javascript;base64,${Buffer.from(input.code).toString('base64')}`
)
if (typeof adapter.default !== 'function') throw new Error('Export a default parser function.')
const result = await adapter.default({ html: input.page.html, url: input.page.url, load })
process.stdout.write(JSON.stringify(result))
