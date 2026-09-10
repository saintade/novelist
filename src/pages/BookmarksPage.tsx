import { useLibrary } from '../app/library-context'
import { BookmarkList } from '../components/library/BookmarkList'

export function BookmarksView() {
  const { books } = useLibrary()
  return (
    <main className="library-page">
      <div className="page-heading">
        <h1>Bookmarks</h1>
      </div>
      <BookmarkList books={books} />
    </main>
  )
}
