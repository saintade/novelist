import { useState, type ReactNode } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { BookOpen, Library, Bookmark, Moon, Sun, Settings2 } from 'lucide-react'
import { useLibrary } from '../../app/library-context'
import { initialSettings } from '../../lib/reader/settings'
import { writeSetting } from '../../lib/preferences'
import { ReadingSettings } from '../reader/ReadingSettings'
import { IconButton } from '../ui'

export function Shell({ children }: { children: ReactNode }) {
  const { theme, setTheme } = useLibrary()
  const [preferencesOpen, setPreferencesOpen] = useState(false)
  const [settings, setSettings] = useState(initialSettings)
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link to="/" className="brand">
          <span className="brand-mark">
            <BookOpen size={22} strokeWidth={1.7} />
          </span>
          <span>
            novelist<span className="brand-period">.</span>
          </span>
        </Link>
        <nav className="primary-navigation" aria-label="Main navigation">
          <NavLink to="/" end title="Library" aria-label="Library">
            <Library size={18} />
            <span>Library</span>
          </NavLink>
          <NavLink to="/bookmarks" title="Bookmarks" aria-label="Bookmarks">
            <Bookmark size={18} />
            <span>Bookmarks</span>
          </NavLink>
        </nav>
        <div className="sidebar-bottom">
          <IconButton
            label="Reading preferences"
            onClick={() => {
              setSettings(initialSettings())
              setPreferencesOpen(true)
            }}
          >
            <Settings2 size={18} />
          </IconButton>
          <IconButton
            label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
            onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          >
            {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
          </IconButton>
        </div>
      </aside>
      <div className="workspace">{children}</div>
      {preferencesOpen && (
        <ReadingSettings
          settings={settings}
          setSettings={(next) => {
            setSettings(next)
            writeSetting('novelist-reader', next)
          }}
          theme={theme}
          onTheme={setTheme}
          onClose={() => setPreferencesOpen(false)}
        />
      )}
    </div>
  )
}
