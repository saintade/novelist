import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../supabase/database.types.ts'
import type { LibraryEntry } from '../extension/library-catalog.ts'

export async function readLibraryCatalog(
  client: SupabaseClient<Database>,
): Promise<LibraryEntry[]> {
  const books: {
    id: string
    novel_id: string
    title: string
    author: string
    language: string
    description: string
    contents_url?: string | null
  }[] = []
  const novels = new Map<string, { original_title: string; aliases: string[] }>()
  const sources = new Map<string, LibraryEntry['sources']>()
  const attachedBooks = new Set<string>()
  for (let offset = 0; ; offset += 1000) {
    const page = await client
      .from('books')
      .select(
        'id,novel_id,title,author,language,description,contents_url:catalog_metadata->>canonicalUrl',
      )
      .eq('import_state', 'ready')
      .order('id')
      .range(offset, offset + 999)
    if (page.error) throw page.error
    books.push(...page.data)
    if (page.data.length < 1000) break
  }
  for (let offset = 0; ; offset += 1000) {
    const page = await client
      .from('novels')
      .select('id,original_title,aliases')
      .order('id')
      .range(offset, offset + 999)
    if (page.error) throw page.error
    for (const entry of page.data) novels.set(entry.id, entry)
    if (page.data.length < 1000) break
  }
  for (let offset = 0; ; offset += 1000) {
    const page = await client
      .from('novel_sources')
      .select('id,novel_id,book_id,url,label,language,role,contents_url:contents_data->>url')
      .not('url', 'is', null)
      .order('id')
      .range(offset, offset + 999)
    if (page.error) throw page.error
    for (const entry of page.data) {
      if (!entry.url || !/^https?:\/\//i.test(entry.url)) continue
      if (entry.book_id) attachedBooks.add(entry.book_id)
      const existing = sources.get(entry.novel_id) ?? []
      existing.push({
        id: entry.id,
        url: entry.url,
        label: entry.label,
        language: entry.language,
        role: entry.role,
        ...(entry.contents_url ? { contentsUrl: String(entry.contents_url) } : {}),
      })
      sources.set(entry.novel_id, existing)
    }
    if (page.data.length < 1000) break
  }
  return books.map((book) => {
    const entries = [...(sources.get(book.novel_id) ?? [])]
    if (
      book.contents_url &&
      attachedBooks.has(book.id) &&
      /^https?:\/\//i.test(book.contents_url) &&
      !entries.some((source) => source.url === book.contents_url)
    )
      entries.push({
        id: `contents-${book.id}`,
        url: book.contents_url,
        label: 'Table of contents',
        language: book.language,
        role: 'contents',
      })
    return {
      id: book.id,
      novelId: book.novel_id,
      title: book.title,
      originalTitle: novels.get(book.novel_id)?.original_title || '',
      aliases: novels.get(book.novel_id)?.aliases ?? [],
      author: book.author,
      language: book.language,
      description: book.description.slice(0, 800),
      sources: entries,
    }
  })
}
