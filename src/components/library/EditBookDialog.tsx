import { useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { LibraryBook } from '../../lib/books'
import { Dialog } from '../ui'

export function EditBookDialog({
  book,
  onClose,
  onSave,
}: {
  book: LibraryBook
  onClose: () => void
  onSave: (
    changes: Pick<LibraryBook, 'title' | 'author' | 'description' | 'genre'>,
  ) => Promise<boolean>
}) {
  const [title, setTitle] = useState(book.title)
  const [author, setAuthor] = useState(book.author)
  const [description, setDescription] = useState(book.description)
  const [genre, setGenre] = useState(book.genre)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  return (
    <Dialog title="Edit book details" onClose={onClose}>
      <form
        className="edit-form"
        onSubmit={async (event) => {
          event.preventDefault()
          setSaving(true)
          setError('')
          const saved = await onSave({
            title: title.trim(),
            author: author.trim() || 'Unknown author',
            description: description.trim(),
            genre: genre.trim() || 'Uncategorized',
          })
          if (!saved) setError('Changes could not be saved. Check the connection and try again.')
          setSaving(false)
        }}
      >
        <label>
          Title
          <input
            required
            maxLength={300}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          Author
          <input
            maxLength={200}
            value={author}
            onChange={(event) => setAuthor(event.target.value)}
          />
        </label>
        <label>
          Genre
          <input maxLength={80} value={genre} onChange={(event) => setGenre(event.target.value)} />
        </label>
        <label>
          Synopsis
          <textarea
            rows={6}
            maxLength={10_000}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={saving || !title.trim()} className="button primary">
            {saving && <LoaderCircle size={16} className="spin" />}Save changes
          </button>
        </div>
      </form>
    </Dialog>
  )
}
