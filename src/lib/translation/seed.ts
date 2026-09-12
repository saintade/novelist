import { importBook } from '../books'
import { saveBook } from '../library/repository'
import { ensureSession, supabase } from '../supabase/client'

export const fixtureBookTitle = 'Qinglan Crossing (test novel)'

export async function initializeTranslationSample(): Promise<void> {
  const ownerId = await ensureSession()
  const { data, error } = await supabase
    .from('library_settings')
    .select('translation_sample_imported')
    .eq('owner_id', ownerId)
    .maybeSingle()
  if (error) throw error
  if (data?.translation_sample_imported) return
  const response = await fetch('/books/qinglan-crossing.zh.txt')
  if (!response.ok) throw new Error('The translation test novel could not be loaded.')
  const file = new File([await response.blob()], 'qinglan-crossing.zh.txt', { type: 'text/plain' })
  const imported = await importBook(file)
  Object.assign(imported.book, {
    title: fixtureBookTitle,
    author: 'Novelist test fixture',
    genre: 'Translation fixture',
    language: 'zh',
    description:
      'An original three-chapter Chinese test story about a ferry ledger, a patient teacher, and a lantern. This synthetic bilingual fixture was created during development to test source storage, glossary extraction, and consistency. It is not a published novel or a human-verified translation benchmark.',
    source: 'Chinese original (test fixture)',
  })
  const { book } = await saveBook(imported)
  const reference = await fetch('/books/qinglan-crossing.en.txt')
  if (!reference.ok) throw new Error('The English test reference could not be loaded.')
  const referencePath = `${ownerId}/${book.id}/reference.en.txt`
  const upload = await supabase.storage
    .from('library')
    .upload(referencePath, await reference.arrayBuffer(), {
      contentType: 'text/plain',
      upsert: true,
    })
  if (upload.error) throw upload.error
  const original = await supabase
    .from('novel_sources')
    .update({
      rights_status: 'original_fixture',
      rights_note:
        'Original text authored for this application; not scraped from a published novel.',
      verified_at: new Date().toISOString(),
      edition_label: 'Chinese fixture v1',
    })
    .eq('book_id', book.id)
  if (original.error) throw original.error
  const existing = await supabase
    .from('novel_sources')
    .select('id')
    .eq('novel_id', book.novelId!)
    .eq('role', 'reference')
    .eq('edition_label', 'English fixture v1')
    .maybeSingle()
  if (existing.error) throw existing.error
  if (!existing.data) {
    const added = await supabase.from('novel_sources').insert({
      owner_id: ownerId,
      novel_id: book.novelId!,
      label: 'English reference (test fixture)',
      language: 'en',
      role: 'reference',
      edition_label: 'English fixture v1',
      rights_status: 'original_fixture',
      rights_note:
        'Synthetic English reference created during development, not a live experiment result or a human-verified translation.',
      original_path: referencePath,
      verified_at: new Date().toISOString(),
    })
    if (added.error) throw added.error
  }
  const novel = await supabase
    .from('novels')
    .update({ original_title: '青岚渡', aliases: ['Qinglan Crossing', '青岚渡'] })
    .eq('id', book.novelId!)
  if (novel.error) throw novel.error
  const marked = await supabase
    .from('library_settings')
    .update({ translation_sample_imported: true })
    .eq('owner_id', ownerId)
  if (marked.error) throw marked.error
}
