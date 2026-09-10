import { useRef, useState } from 'react'
import { LoaderCircle, Upload, Plus } from 'lucide-react'
import { useLibrary } from '../../app/library-context'
import { importBook, type LibraryBook } from '../../lib/books'
import { saveBook } from '../../lib/library/repository'
import { Dialog } from '../ui'

export function ImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void
  onImported: (book: LibraryBook) => void
}) {
  const { notify } = useLibrary()
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [currentFile, setCurrentFile] = useState('')
  const [error, setError] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const processFiles = async (files: File[]) => {
    if (busy || !files.length) return
    setBusy(true)
    setError('')
    const errors: string[] = []
    let added = 0
    let duplicates = 0
    for (const file of files) {
      setCurrentFile(file.name)
      try {
        const imported = await importBook(file)
        const result = await saveBook(imported)
        onImported(result.book)
        if (result.duplicate) duplicates++
        else added++
      } catch (failure) {
        errors.push(
          `${file.name}: ${failure instanceof Error ? failure.message : 'Could not import this book.'}`,
        )
      }
    }
    setBusy(false)
    setCurrentFile('')
    if (added) notify(`${added} ${added === 1 ? 'book' : 'books'} added to your library.`)
    else if (duplicates) notify('This book is already in your library.')
    if (errors.length) setError(errors.join('\n'))
    else onClose()
  }
  return (
    <Dialog
      title="Import a book"
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <div
        className={`drop-zone ${dragging ? 'dragging' : ''}`}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          void processFiles(Array.from(event.dataTransfer.files))
        }}
      >
        {busy ? (
          <>
            <LoaderCircle size={30} className="spin" />
            <strong>Adding to your library</strong>
            <span>{currentFile}</span>
          </>
        ) : (
          <>
            <span className="upload-icon">
              <Upload size={26} strokeWidth={1.4} />
            </span>
            <strong>Drop your books here</strong>
            <span>EPUB or TXT, up to 50 MB each</span>
            <button className="button primary" onClick={() => fileInput.current?.click()}>
              <Plus size={16} /> Choose files
            </button>
          </>
        )}
        <input
          className="sr-only"
          type="file"
          accept=".epub,.txt"
          multiple
          ref={fileInput}
          aria-label="Import EPUB or text files"
          disabled={busy}
          onChange={(event) => {
            void processFiles(Array.from(event.target.files ?? []))
            event.target.value = ''
          }}
        />
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  )
}
