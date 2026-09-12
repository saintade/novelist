import {
  chapterTitle,
  sanitizeChapter,
  type Chapter,
  type ImportedBook,
  type LibraryBook,
} from '../books'
import { ensureSession, supabase } from '../supabase/client'
import type { Database } from '../supabase/database.types'

type BookRow = Database['public']['Tables']['books']['Row']
type ChapterRow = Database['public']['Tables']['chapters']['Row']
export type LibraryFolder = Database['public']['Tables']['library_folders']['Row']
const bucket = () => supabase.storage.from('library')
const cachedBooks = new Map<string, LibraryBook>()
const pendingUpdates = new Map<string, Promise<LibraryBook>>()
let cachedOwner: string | undefined
supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT' || (cachedOwner && session?.user.id !== cachedOwner)) {
    cachedBooks.clear()
    pendingUpdates.clear()
  }
  cachedOwner = session?.user.id
})

async function allChapters(bookId: string): Promise<ChapterRow[]> {
  const result: ChapterRow[] = []
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase
      .from('chapters')
      .select('*')
      .eq('book_id', bookId)
      .order('position')
      .range(offset, offset + 999)
    if (error) throw error
    result.push(...data)
    if (data.length < 1000) return result
  }
}

async function hydrate(row: BookRow): Promise<LibraryBook> {
  const [chapters, progress, bookmarks] = await Promise.all([
    allChapters(row.id),
    supabase.from('reading_progress').select('*').eq('book_id', row.id).maybeSingle(),
    supabase.from('bookmarks').select('*').eq('book_id', row.id).order('created_at'),
  ])
  if (progress.error) throw progress.error
  if (bookmarks.error) throw bookmarks.error
  let cover: string | undefined
  if (row.source_cover_url) {
    try {
      cover = (await import('../scraper/contracts')).publicPageUrl(row.source_cover_url)
    } catch {
      cover = undefined
    }
  }
  if (!cover && row.cover_path) {
    const result = await bucket().createSignedUrl(row.cover_path, 86400)
    if (!result.error) cover = result.data.signedUrl
  }
  const catalog =
    row.format === 'WEB'
      ? (await import('../extension/contracts')).catalogMetadataSchema.safeParse(
          row.catalog_metadata,
        )
      : null
  const book: LibraryBook = {
    id: row.id,
    ownerId: row.owner_id,
    novelId: row.novel_id,
    folderId: row.folder_id ?? undefined,
    title: row.title,
    author: row.author,
    description: row.description,
    language: row.language,
    format: row.format as LibraryBook['format'],
    catalog: catalog?.success ? catalog.data : undefined,
    genre: row.genre,
    cover,
    chapters: chapters.map((chapter) => ({
      id: `chapter-${chapter.position}`,
      title: chapter.title,
      wordCount: chapter.word_count,
    })),
    wordCount: row.word_count,
    size: row.file_size,
    addedAt: Date.parse(row.added_at),
    lastReadAt: progress.data?.last_read_at ? Date.parse(progress.data.last_read_at) : 0,
    progress: { chapter: progress.data?.chapter ?? 0, offset: progress.data?.fraction ?? 0 },
    status: (progress.data?.status ?? 'unread') as LibraryBook['status'],
    bookmarks: bookmarks.data.map((entry) => ({
      id: entry.id,
      chapter: entry.chapter,
      offset: entry.fraction,
      title: entry.title,
      createdAt: Date.parse(entry.created_at),
    })),
    source: row.source,
    sourceUrl: row.source_url ?? undefined,
    sourceProgress: progress.data?.source_id && progress.data.source_chapter_url ? {
      sourceId: progress.data.source_id,
      chapterUrl: progress.data.source_chapter_url,
      language: progress.data.target_language ?? undefined,
      versionId: progress.data.translation_version ?? undefined,
    } : undefined,
  }
  if (book.sourceProgress && catalog?.success) {
    const position = catalog.data.contents?.chapters.findIndex(chapter => chapter.url === book.sourceProgress!.chapterUrl) ?? -1
    if (position >= 0) book.progress.chapter = position
  }
  cachedBooks.set(book.id, book)
  return book
}

export async function getLibraryFolders(): Promise<LibraryFolder[]> {
  await ensureSession()
  const folders: LibraryFolder[] = []
  for (let offset = 0; ; offset += 1000) {
    const page = await supabase
      .from('library_folders')
      .select('*')
      .order('name')
      .order('id')
      .range(offset, offset + 999)
    if (page.error) throw page.error
    folders.push(...page.data)
    if (page.data.length < 1000) return folders
  }
}

export async function saveLibraryFolder(name: string, id?: string): Promise<LibraryFolder> {
  await ensureSession()
  name = name.trim()
  if (!name || name.length > 80) throw new Error('Use a folder name between 1 and 80 characters.')
  const result = id
    ? await supabase.from('library_folders').update({ name }).eq('id', id).select('*').single()
    : await supabase.from('library_folders').insert({ name }).select('*').single()
  if (result.error)
    throw new Error(
      result.error.code === '23505'
        ? 'A folder with this name already exists.'
        : result.error.message,
    )
  return result.data
}

export async function removeLibraryFolder(id: string): Promise<void> {
  await ensureSession()
  const result = await supabase.from('library_folders').delete().eq('id', id).select('id').single()
  if (result.error) throw result.error
  for (const [bookId, book] of cachedBooks)
    if (book.folderId === id) cachedBooks.set(bookId, { ...book, folderId: undefined })
}

export async function getBooks(): Promise<LibraryBook[]> {
  await ensureSession()
  const rows: BookRow[] = []
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase
      .from('books')
      .select('*')
      .eq('import_state', 'ready')
      .order('added_at')
      .range(offset, offset + 999)
    if (error) throw error
    rows.push(...data)
    if (data.length < 1000) break
  }
  return Promise.all(rows.map(hydrate))
}

async function upload(path: string, blob: Blob, contentType: string) {
  const { error } = await bucket().upload(path, await blob.arrayBuffer(), {
    upsert: true,
    contentType,
  })
  if (error) throw error
}

export async function saveBook(
  imported: ImportedBook,
): Promise<{ book: LibraryBook; duplicate: boolean }> {
  const ownerId = await ensureSession()
  const save = async () => {
    const { data: existing, error: lookupError } = await supabase
      .from('books')
      .select('*')
      .eq('id', imported.book.id)
      .maybeSingle()
    if (lookupError) throw lookupError
    if (existing?.import_state === 'ready')
      return { book: await hydrate(existing), duplicate: true }
    const prefix = `${ownerId}/${imported.book.id}`
    const originalPath = `${prefix}/original.${imported.book.format.toLowerCase()}`
    const { error: insertError } = await supabase.from('books').upsert(
      {
        id: imported.book.id,
        owner_id: ownerId,
        novel_id: existing?.novel_id ?? imported.book.novelId ?? crypto.randomUUID(),
        title: imported.book.title,
        author: imported.book.author,
        description: imported.book.description,
        language: imported.book.language,
        format: imported.book.format,
        genre: imported.book.genre,
        original_path: originalPath,
        word_count: imported.book.wordCount,
        file_size: imported.book.size,
        source: imported.book.source,
        source_url: imported.book.sourceUrl,
        added_at: new Date(imported.book.addedAt).toISOString(),
        import_state: 'importing',
      },
      { onConflict: 'owner_id,id' },
    )
    if (insertError) throw insertError
    await upload(
      originalPath,
      imported.file,
      imported.book.format === 'EPUB' ? 'application/epub+zip' : 'text/plain',
    )
    let coverPath: string | null = null
    if (
      imported.book.cover &&
      /^(?:data:image\/(?:png|jpeg|gif|webp);base64,|\/books\/)/i.test(imported.book.cover)
    ) {
      const cover = await fetch(imported.book.cover).then((response) => response.blob())
      if (['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(cover.type)) {
        coverPath = `${prefix}/cover`
        await upload(coverPath, cover, cover.type)
      }
    }
    for (let offset = 0; offset < imported.chapters.length; offset += 6) {
      await Promise.all(
        imported.chapters
          .slice(offset, offset + 6)
          .map((chapter, localIndex) =>
            upload(
              `${prefix}/chapters/${offset + localIndex}.json`,
              new Blob([JSON.stringify(chapter)], { type: 'application/json' }),
              'application/json',
            ),
          ),
      )
    }
    for (let offset = 0; offset < imported.chapters.length; offset += 250) {
      const { error } = await supabase.from('chapters').upsert(
        imported.chapters.slice(offset, offset + 250).map((chapter, localIndex) => ({
          owner_id: ownerId,
          book_id: imported.book.id,
          position: offset + localIndex,
          title: chapter.title,
          word_count: chapter.wordCount,
          content_path: `${prefix}/chapters/${offset + localIndex}.json`,
        })),
        { onConflict: 'owner_id,book_id,position' },
      )
      if (error) throw error
    }
    const { data, error } = await supabase
      .from('books')
      .update({ import_state: 'ready', cover_path: coverPath })
      .eq('id', imported.book.id)
      .select()
      .single()
    if (error) throw error
    return { book: await hydrate(data), duplicate: false }
  }
  return typeof navigator !== 'undefined' && navigator.locks
    ? navigator.locks.request(`novelist-import-${ownerId}-${imported.book.id}`, save)
    : save()
}

export async function getChapter(bookId: string, index: number): Promise<Chapter | undefined> {
  await ensureSession()
  const { data, error } = await supabase
    .from('chapters')
    .select('*')
    .eq('book_id', bookId)
    .eq('position', index)
    .maybeSingle()
  if (error) throw error
  if (!data) return undefined
  const file = await bucket().download(data.content_path)
  if (file.error) throw file.error
  const chapter: unknown = JSON.parse(await file.data.text())
  if (
    !chapter ||
    typeof chapter !== 'object' ||
    !('html' in chapter) ||
    typeof chapter.html !== 'string'
  )
    throw new Error('This chapter file is damaged.')
  return {
    id: `chapter-${index}`,
    title: data.title,
    wordCount: data.word_count,
    html: sanitizeChapter(chapter.html),
  }
}

export async function getOriginalFile(bookId: string): Promise<Blob | undefined> {
  await ensureSession()
  const { data, error } = await supabase
    .from('books')
    .select('original_path')
    .eq('id', bookId)
    .maybeSingle()
  if (error) throw error
  if (!data?.original_path) return undefined
  const result = await bucket().download(data.original_path)
  if (result.error) throw result.error
  return result.data
}

export async function updateBook(
  bookId: string,
  change: (book: LibraryBook) => LibraryBook,
): Promise<LibraryBook> {
  const previous = pendingUpdates.get(bookId) ?? Promise.resolve(undefined)
  const task = previous
    .catch(() => undefined)
    .then(async () => {
      const ownerId = await ensureSession()
      let book = cachedBooks.get(bookId)
      if (!book) {
        const { data, error } = await supabase.from('books').select('*').eq('id', bookId).single()
        if (error) throw error
        book = await hydrate(data)
      }
      const updated = change(book)
      if (
        updated.title !== book.title ||
        updated.author !== book.author ||
        updated.description !== book.description ||
        updated.genre !== book.genre ||
        updated.folderId !== book.folderId
      ) {
        const { error } = await supabase
          .from('books')
          .update({
            title: updated.title,
            author: updated.author,
            description: updated.description,
            genre: updated.genre,
            ...(updated.folderId !== book.folderId ? { folder_id: updated.folderId ?? null } : {}),
          })
          .eq('id', bookId)
        if (error) throw error
      }
      if (
        updated.progress !== book.progress ||
        updated.status !== book.status ||
        updated.lastReadAt !== book.lastReadAt
      ) {
        const { error } = await supabase.from('reading_progress').upsert({
          owner_id: ownerId,
          book_id: bookId,
          chapter: updated.progress.chapter,
          fraction: updated.progress.offset,
          status: updated.status,
          last_read_at: updated.lastReadAt ? new Date(updated.lastReadAt).toISOString() : null,
        })
        if (error) throw error
      }
      if (updated.bookmarks !== book.bookmarks) {
        const removed = book.bookmarks
          .filter((entry) => !updated.bookmarks.some((saved) => saved.id === entry.id))
          .map((entry) => entry.id)
        if (removed.length) {
          const { error } = await supabase.from('bookmarks').delete().in('id', removed)
          if (error) throw error
        }
        const added = updated.bookmarks.filter(
          (entry) => !book.bookmarks.some((saved) => saved.id === entry.id),
        )
        if (added.length) {
          const { error } = await supabase.from('bookmarks').insert(
            added.map((entry) => ({
              id: entry.id,
              owner_id: ownerId,
              book_id: bookId,
              chapter: entry.chapter,
              fraction: entry.offset,
              title: chapterTitle(entry.title),
              created_at: new Date(entry.createdAt).toISOString(),
            })),
          )
          if (error) throw error
        }
      }
      cachedBooks.set(bookId, updated)
      return updated
    })
  pendingUpdates.set(bookId, task)
  try {
    return await task
  } finally {
    if (pendingUpdates.get(bookId) === task) pendingUpdates.delete(bookId)
  }
}

export async function removeBook(bookId: string): Promise<void> {
  const ownerId = await ensureSession()
  await pendingUpdates.get(bookId)?.catch(() => undefined)
  const { data: record, error: lookupError } = await supabase
    .from('books')
    .select('novel_id')
    .eq('id', bookId)
    .maybeSingle()
  if (lookupError) throw lookupError
  const sourcePaths: string[] = []
  if (record) {
    const sources = await supabase
      .from('novel_sources')
      .select('id')
      .eq('novel_id', record.novel_id)
    if (sources.error) throw sources.error
    if (sources.data.length)
      for (let offset = 0; ; offset += 1000) {
        const chapters = await supabase
          .from('source_chapters')
          .select('content_path')
          .in(
            'source_id',
            sources.data.map((source) => source.id),
          )
          .order('id')
          .range(offset, offset + 999)
        if (chapters.error) throw chapters.error
        sourcePaths.push(...chapters.data.map((chapter) => chapter.content_path))
        if (chapters.data.length < 1000) break
      }
  }
  const prefix = `${ownerId}/${bookId}`
  const paths: string[] = []
  for (const folder of [prefix, `${prefix}/chapters`]) {
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await bucket().list(folder, {
        limit: 1000,
        offset,
        sortBy: { column: 'name', order: 'asc' },
      })
      if (error) throw error
      paths.push(...data.filter((entry) => entry.id).map((entry) => `${folder}/${entry.name}`))
      if (data.length < 1000) break
    }
  }
  for (let offset = 0; offset < paths.length; offset += 100) {
    const { error } = await bucket().remove(paths.slice(offset, offset + 100))
    if (error) throw error
  }
  const { error } = await supabase.from('books').delete().eq('id', bookId)
  if (error) throw error
  cachedBooks.delete(bookId)
  if (record) {
    const remaining = await supabase
      .from('books')
      .select('id', { count: 'exact', head: true })
      .eq('novel_id', record.novel_id)
    if (remaining.error) throw remaining.error
    if (remaining.count === 0) {
      const removed = await supabase.from('novels').delete().eq('id', record.novel_id)
      if (removed.error) throw removed.error
      for (let offset = 0; offset < sourcePaths.length; offset += 100) {
        const files = await bucket().remove(sourcePaths.slice(offset, offset + 100))
        if (files.error) throw files.error
      }
    }
  }
}
