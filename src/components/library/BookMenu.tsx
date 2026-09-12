import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import {
  Ellipsis,
  BookOpen,
  BookCheck,
  Download,
  Trash2,
  LoaderCircle,
  FolderInput,
  Pencil,
} from 'lucide-react'
import { useLibrary } from '../../app/library-context'
import type { LibraryBook } from '../../lib/books'
import { readLink, downloadBook } from '../../lib/library/presentation'
import { Dialog, IconButton } from '../ui'
import { getLibraryFolders, type LibraryFolder } from '../../lib/library/repository'
import { EditBookDialog } from './EditBookDialog'

export function BookMenu({ book }: { book: LibraryBook }) {
  const { patchBook, deleteBook, notify } = useLibrary()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [folderDialog, setFolderDialog] = useState(false)
  const [folders, setFolders] = useState<LibraryFolder[]>([])
  const [folderId, setFolderId] = useState(book.folderId ?? '')
  const [folderBusy, setFolderBusy] = useState(false)
  const [folderError, setFolderError] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const location = useLocation()
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('click', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', escape)
    }
  }, [open])
  return (
    <div className="book-menu" ref={menuRef}>
      <IconButton
        label={`Actions for ${book.title}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Ellipsis size={18} />
      </IconButton>
      {open && (
        <div className="dropdown-menu">
          <Link to={readLink(book)} onClick={() => setOpen(false)}>
            <BookOpen size={16} /> {book.format === 'WEB' ? 'View book' : 'Read book'}
          </Link>
          <button onClick={() => { setOpen(false); setEditing(true) }}><Pencil size={16} />Edit book details</button>
          <button
            onClick={() => {
              void patchBook(book.id, (current) => ({
                ...current,
                status: current.status === 'finished' ? 'unread' : 'finished',
                progress: { chapter: 0, offset: 0 },
              }))
              setOpen(false)
            }}
          >
            <BookCheck size={16} />
            {book.status === 'finished' ? 'Mark as unread' : 'Mark as finished'}
          </button>
          {book.format !== 'WEB' && (
            <button
              onClick={() => {
                void downloadBook(book, notify)
                setOpen(false)
              }}
            >
              <Download size={16} /> Download original
            </button>
          )}
          <button
            onClick={() => {
              setOpen(false)
              setFolderDialog(true)
              setFolderBusy(true)
              setFolderError('')
              setFolderId(book.folderId ?? '')
              void getLibraryFolders()
                .then(setFolders)
                .catch((failure) =>
                  setFolderError(
                    failure instanceof Error ? failure.message : 'Folders could not be loaded.',
                  ),
                )
                .finally(() => setFolderBusy(false))
            }}
          >
            <FolderInput size={16} />
            Move to folder
          </button>
          <button
            className="danger"
            onClick={() => {
              setConfirmDelete(true)
              setOpen(false)
            }}
          >
            <Trash2 size={16} /> Remove book
          </button>
        </div>
      )}
      {folderDialog && (
        <Dialog
          title="Move to folder"
          onClose={() => {
            if (!folderBusy) setFolderDialog(false)
          }}
        >
          <form
            className="edit-form folder-form"
            onSubmit={async (event) => {
              event.preventDefault()
              setFolderBusy(true)
              try {
                if (
                  await patchBook(book.id, (current) => ({
                    ...current,
                    folderId: folderId || undefined,
                  }))
                ) {
                  setFolderDialog(false)
                  notify(folderId ? 'Book moved to folder.' : 'Book moved to Unfiled.')
                } else setFolderError('The book could not be moved. Refresh and retry.')
              } finally {
                setFolderBusy(false)
              }
            }}
          >
            <p>{book.title}</p>
            <label>
              Folder
              <select
                aria-label="Destination folder"
                value={folderId}
                disabled={folderBusy}
                onChange={(event) => setFolderId(event.target.value)}
              >
                <option value="">Unfiled</option>
                {folders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.name}
                  </option>
                ))}
              </select>
            </label>
            {folderError && (
              <p className="form-error" role="alert">
                {folderError}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="button"
                disabled={folderBusy}
                onClick={() => setFolderDialog(false)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={folderBusy}>
                Move book
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {editing && <EditBookDialog book={book} onClose={() => setEditing(false)} onSave={async changes => {
        const saved = await patchBook(book.id, current => ({ ...current, ...changes }))
        if (saved) { setEditing(false); notify('Book details updated.') }
        return saved
      }} />}
      {confirmDelete && (
        <Dialog
          title="Remove book?"
          onClose={() => {
            if (!removing) setConfirmDelete(false)
          }}
        >
          <p className="dialog-copy">
            Remove &quot;{book.title}&quot; and its reading progress from this library? Your
            original file is not affected.
          </p>
          <div className="dialog-actions">
            <button className="button" disabled={removing} onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
            <button
              className="button danger-button"
              disabled={removing}
              onClick={async () => {
                setRemoving(true)
                try {
                  await deleteBook(book.id)
                  setConfirmDelete(false)
                  if (location.pathname.includes(book.id)) navigate('/')
                } catch {
                  notify('The book could not be removed.')
                  setRemoving(false)
                }
              }}
            >
              {removing ? <LoaderCircle size={16} className="spin" /> : <Trash2 size={16} />} Remove
              book
            </button>
          </div>
        </Dialog>
      )}
    </div>
  )
}
