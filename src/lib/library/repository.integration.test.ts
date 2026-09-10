// @vitest-environment jsdom
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { webcrypto } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { importBook } from '../books'
import { supabase, ensureSession } from '../supabase/client'
import {
  getBooks,
  getChapter,
  getOriginalFile,
  removeBook,
  saveBook,
  updateBook,
} from './repository'

vi.stubGlobal('File', NodeFile)
vi.stubGlobal('Blob', NodeBlob)
vi.stubGlobal('crypto', webcrypto)

describe.runIf(
  import.meta.env.VITE_SUPABASE_URL?.includes('127.0.0.1') &&
    process.env.RUN_SUPABASE_TESTS === '1',
)('local Supabase repository', () => {
  it('persists files and metadata, prevents cross-session access, and removes its own data', async () => {
    const imported = await importBook(
      new File([`A book stored in Supabase. ${crypto.randomUUID()}`], 'Local.txt'),
    )
    const owner = await ensureSession()
    try {
      const saved = await saveBook(imported)
      expect(saved.duplicate).toBe(false)
      expect((await getChapter(saved.book.id, 0))?.html).toContain('stored in Supabase')
      expect(await (await getOriginalFile(saved.book.id))?.text()).toContain('stored in Supabase')
      await Promise.all([
        updateBook(saved.book.id, (book) => ({
          ...book,
          status: 'reading',
          progress: { chapter: 0, offset: 0.4 },
        })),
        updateBook(saved.book.id, (book) => ({
          ...book,
          bookmarks: [
            {
              id: crypto.randomUUID(),
              chapter: 0,
              offset: 0.4,
              title: 'A saved place',
              createdAt: Date.now(),
            },
          ],
        })),
      ])
      const duplicate = await saveBook(imported)
      expect(duplicate.duplicate).toBe(true)
      expect(duplicate.book.progress.offset).toBe(0.4)
      expect(duplicate.book.bookmarks).toHaveLength(1)
      expect((await getBooks()).find((book) => book.id === saved.book.id)?.status).toBe('reading')
      const outsider = createClient(
        import.meta.env.VITE_SUPABASE_URL,
        import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } },
      )
      const signedIn = await outsider.auth.signInAnonymously()
      expect(signedIn.error).toBeNull()
      const foreignBooks = await outsider.from('books').select('id').eq('id', saved.book.id)
      expect(foreignBooks.data).toEqual([])
      const foreignFile = await outsider.storage
        .from('library')
        .download(`${owner}/${saved.book.id}/original.txt`)
      expect(foreignFile.error).not.toBeNull()
      const foreignInsert = await outsider
        .from('reading_progress')
        .insert({ owner_id: owner, book_id: saved.book.id, chapter: 0, fraction: 0.9 })
      expect(foreignInsert.error).not.toBeNull()
      await outsider.auth.signOut()
    } finally {
      await removeBook(imported.book.id)
    }
    expect(await getChapter(imported.book.id, 0)).toBeUndefined()
    expect(
      (await supabase.storage.from('library').list(`${owner}/${imported.book.id}/chapters`)).data,
    ).toEqual([])
  }, 30_000)
})
