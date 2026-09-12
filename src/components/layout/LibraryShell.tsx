import { useId, useRef, useState, type ReactNode } from 'react'
import { Link, NavLink } from 'react-router-dom'
import {
  BookOpen,
  Library,
  KeyRound,
  Link2,
  Bookmark,
  ChevronRight,
  Moon,
  Settings,
  Settings2,
  ShieldCheck,
  Sun,
} from 'lucide-react'
import { useLibrary } from '../../app/library-context'
import { initialSettings } from '../../lib/reader/settings'
import { writeSetting } from '../../lib/preferences'
import { ReadingSettings } from '../reader/ReadingSettings'
import { IconButton } from '../ui'
import { LibraryAccount } from '../library/LibraryAccess'

export function Shell({ children }: { children: ReactNode }) {
  const { theme, setTheme } = useLibrary()
  const menuId = useId()
  const menuRef = useRef<HTMLDivElement>(null)
  const controlRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [preferencesOpen, setPreferencesOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
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
          <NavLink to="/sources" title="Sources" aria-label="Sources">
            <Link2 size={18} />
            <span>Sources</span>
          </NavLink>
        </nav>
      </aside>
      <div className="workspace">
        <header className="workspace-toolbar">
          <div className="settings-control" ref={controlRef}>
            <IconButton
              label="Settings"
              className="settings-button"
              aria-haspopup="dialog"
              aria-expanded={menuOpen}
              aria-controls={menuId}
              popoverTarget={menuId}
              onClick={(event) => event.currentTarget.focus()}
            >
              <Settings size={20} strokeWidth={1.7} />
            </IconButton>
            <div
              id={menuId}
              ref={menuRef}
              popover="auto"
              role="dialog"
              aria-label="Preferences"
              className="preferences-popover"
              onToggle={(event) => setMenuOpen(event.newState === 'open')}
            >
              <h2>Appearance</h2>
              <div className="segmented theme-options">
                <button
                  className={theme === 'light' ? 'selected' : ''}
                  aria-pressed={theme === 'light'}
                  onClick={() => setTheme('light')}
                >
                  <Sun size={17} /> Light
                </button>
                <button
                  className={theme === 'dark' ? 'selected' : ''}
                  aria-pressed={theme === 'dark'}
                  onClick={() => setTheme('dark')}
                >
                  <Moon size={17} /> Dark
                </button>
              </div>
              <button
                className="preferences-entry"
                onClick={() => {
                  menuRef.current?.hidePopover()
                  controlRef.current?.querySelector<HTMLButtonElement>('.settings-button')?.focus()
                  setSettings(initialSettings())
                  setPreferencesOpen(true)
                }}
              >
                <Settings2 size={17} /> Reading preferences <ChevronRight size={16} />
              </button>
              <button className="preferences-entry" onClick={() => { menuRef.current?.hidePopover(); setAccountOpen(true) }}><KeyRound size={17} />Library account<ChevronRight size={16} /></button>
              <Link className="preferences-entry" to="/admin" onClick={() => menuRef.current?.hidePopover()}><ShieldCheck size={17} />Admin & usage<ChevronRight size={16} /></Link>
            </div>
          </div>
        </header>
        {children}
      </div>
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
      {accountOpen && <LibraryAccount onClose={() => setAccountOpen(false)} />}
    </div>
  )
}
