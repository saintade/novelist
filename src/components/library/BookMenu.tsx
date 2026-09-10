import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { Ellipsis, BookOpen, BookCheck, Download, Trash2, LoaderCircle } from 'lucide-react'
import { useLibrary } from '../../app/library-context'
import type { LibraryBook } from '../../lib/books'
import { readLink, downloadBook } from '../../lib/library/presentation'
import { Dialog, IconButton } from '../ui'

export function BookMenu({ book }: { book: LibraryBook }) {
  const { patchBook, deleteBook, notify } = useLibrary()
  const [open, setOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [removing, setRemoving] = useState(false)
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
            <BookOpen size={16} /> Read book
          </Link>
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
          <button
            onClick={() => {
              void downloadBook(book, notify)
              setOpen(false)
            }}
          >
            <Download size={16} /> Download original
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
