import { importBook } from '../books'
import { ensureSession, requiresPrivateSignIn, supabase } from '../supabase/client'
import { saveBook } from './repository'
import { initializeTranslationSample } from '../translation/seed'

const samples = [
  {
    filename: 'alice',
    title: "Alice's Adventures in Wonderland",
    author: 'Lewis Carroll',
    genre: 'Fantasy',
    number: 11,
    description:
      "A curious girl follows a hurried stranger into a world where the ordinary rules no longer apply. Tea parties never end, size is a matter of perspective, and every conversation is an invitation to think a little differently.\n\nLewis Carroll's 1865 classic is a playful journey through language, logic, and the boundless possibilities of imagination.",
  },
  {
    filename: 'time-machine',
    title: 'The Time Machine',
    author: 'H. G. Wells',
    genre: 'Science fiction',
    number: 35,
    description:
      'In a quiet London drawing room, a scientist makes an extraordinary claim: time is a dimension that can be travelled. His invention carries him into a distant future, where a beautiful landscape conceals an unsettling mystery.\n\nFirst published in 1895, this compact, visionary novel asks what progress might mean when seen from the far end of history.',
  },
  {
    filename: 'secret-garden',
    title: 'The Secret Garden',
    author: 'Frances Hodgson Burnett',
    genre: 'Classic fiction',
    number: 113,
    description:
      "Sent to live in a sprawling house on the Yorkshire moors, Mary Lennox finds unfamiliar rooms, unexpected friendships, and a locked garden with a story of its own. As the seasons turn, the garden begins to change everyone who enters it.\n\nFrances Hodgson Burnett's 1911 novel is a quietly hopeful story of curiosity, belonging, and things coming back to life.",
  },
]

let initialization: Promise<void> | undefined

export function initializeLibrary(): Promise<void> {
  if (requiresPrivateSignIn) return ensureSession().then(() => undefined)
  initialization ??= (async () => {
    const ownerId = await ensureSession()
    const { data, error } = await supabase
      .from('library_settings')
      .select('samples_imported')
      .eq('owner_id', ownerId)
      .maybeSingle()
    if (error) throw error
    if (!data?.samples_imported) {
      for (const sample of samples) {
        const response = await fetch(`/books/${sample.filename}.epub`)
        if (!response.ok) throw new Error('The sample books could not be loaded. Please try again.')
        const file = new File([await response.blob()], `${sample.filename}.epub`, {
          type: 'application/epub+zip',
        })
        const imported = await importBook(file, { storyOnly: true })
        Object.assign(imported.book, {
          title: sample.title,
          author: sample.author,
          genre: sample.genre,
          description: sample.description,
          cover: `/books/${sample.filename}.jpg`,
          source: 'Project Gutenberg',
          sourceUrl: `https://www.gutenberg.org/ebooks/${sample.number}`,
        })
        const { book } = await saveBook(imported)
        const provenance = await supabase
          .from('novel_sources')
          .update({
            rights_status: 'public_domain_us',
            rights_note:
              'Project Gutenberg lists this edition as public domain in the USA. Checked 2026-09-10.',
            verified_at: new Date().toISOString(),
            edition_label: 'Project Gutenberg EPUB',
          })
          .eq('book_id', book.id)
        if (provenance.error) throw provenance.error
      }
      const result = await supabase
        .from('library_settings')
        .upsert({ owner_id: ownerId, samples_imported: true })
      if (result.error) throw result.error
    }
    await initializeTranslationSample()
  })().catch((error) => {
    initialization = undefined
    throw error
  })
  return initialization
}
