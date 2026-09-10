import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom'
import { BookOpen, LoaderCircle, Check, X } from 'lucide-react'
import type { LibraryBook } from './lib/books'
import { getBooks, updateBook, removeBook } from './lib/library/repository'
import { initializeLibrary } from './lib/library/seed'
import { readSetting, writeSetting } from './lib/preferences'
import { LibraryContext } from './app/library-context'
import { IconButton } from './components/ui'
import { Shell } from './components/layout/LibraryShell'
import { ImportDialog } from './components/library/ImportDialog'
import { NotFound } from './pages/NotFoundPage'
import './styles/library.css'
const LibraryView = lazy(() =>
  import('./pages/LibraryPage').then((module) => ({ default: module.LibraryView })),
)
const BookDetails = lazy(() =>
  import('./pages/BookPage').then((module) => ({ default: module.BookDetails })),
)
const BookmarksView = lazy(() =>
  import('./pages/BookmarksPage').then((module) => ({ default: module.BookmarksView })),
)
const ReaderRoute = lazy(() =>
  import('./pages/ReaderPage').then((module) => ({ default: module.ReaderRoute })),
)

function App() {
  const [books, setBooks] = useState<LibraryBook[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [importOpen, setImportOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [theme, setThemeState] = useState<'light' | 'dark'>(() =>
    readSetting<string>('novelist-theme', 'light') === 'dark' ? 'dark' : 'light',
  )
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    let cancelled = false
    initializeLibrary()
      .then(getBooks)
      .then((saved) => {
        if (!cancelled) setBooks(saved)
      })
      .catch((failure: unknown) => {
        if (!cancelled)
          setError(failure instanceof Error ? failure.message : 'Your library could not be opened.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [attempt])
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    writeSetting('novelist-theme', theme)
  }, [theme])
  const notify = (message: string) => {
    clearTimeout(toastTimer.current)
    setToast(message)
    toastTimer.current = setTimeout(() => setToast(''), 4200)
  }
  const patchBook = async (id: string, change: (book: LibraryBook) => LibraryBook) => {
    try {
      const updated = await updateBook(id, change)
      setBooks((current) => current.map((book) => (book.id === id ? updated : book)))
      return true
    } catch {
      notify('Your changes could not be saved. Check that local Supabase is running.')
      return false
    }
  }
  const deleteBook = async (id: string) => {
    await removeBook(id)
    setBooks((current) => current.filter((book) => book.id !== id))
    notify('Book removed from your library.')
  }

  return (
    <BrowserRouter>
      <LibraryContext.Provider
        value={{
          books,
          theme,
          setTheme: setThemeState,
          openImport: () => setImportOpen(true),
          patchBook,
          deleteBook,
          notify,
        }}
      >
        <ScrollReset />
        {loading ? (
          <div className="app-loading">
            <div className="brand-mark">
              <BookOpen size={24} />
            </div>
            <h1>Novelist</h1>
            <LoaderCircle className="spin" size={20} />
            <p>Opening your library...</p>
          </div>
        ) : error ? (
          <div className="app-loading" role="alert">
            <BookOpen size={30} />
            <h1>Unable to open library</h1>
            <p>{error}</p>
            <button
              className="button primary"
              onClick={() => {
                setLoading(true)
                setError('')
                setAttempt(attempt + 1)
              }}
            >
              Try again
            </button>
          </div>
        ) : (
          <Suspense
            fallback={
              <div className="app-loading">
                <LoaderCircle className="spin" size={24} />
              </div>
            }
          >
            <Routes>
              <Route
                path="/"
                element={
                  <Shell>
                    <LibraryView />
                  </Shell>
                }
              />
              <Route
                path="/bookmarks"
                element={
                  <Shell>
                    <BookmarksView />
                  </Shell>
                }
              />
              <Route
                path="/books/:bookId"
                element={
                  <Shell>
                    <BookDetails />
                  </Shell>
                }
              />
              <Route path="/read/:bookId/:chapter" element={<ReaderRoute />} />
              <Route
                path="*"
                element={
                  <Shell>
                    <NotFound />
                  </Shell>
                }
              />
            </Routes>
          </Suspense>
        )}
        {importOpen && (
          <ImportDialog
            onClose={() => setImportOpen(false)}
            onImported={(book) =>
              setBooks((current) => [...current.filter((entry) => entry.id !== book.id), book])
            }
          />
        )}
        {toast && (
          <div className="toast" role="status">
            <Check size={17} />
            <span>{toast}</span>
            <IconButton label="Dismiss notification" onClick={() => setToast('')}>
              <X size={16} />
            </IconButton>
          </div>
        )}
      </LibraryContext.Provider>
    </BrowserRouter>
  )
}

function ScrollReset() {
  const location = useLocation()
  useEffect(() => {
    if (!location.pathname.startsWith('/read/')) {
      window.scrollTo(0, 0)
      document.title = 'Novelist | Your personal library'
    }
  }, [location.pathname])
  return null
}

export default App
