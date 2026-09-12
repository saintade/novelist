import { Minus, Moon, Plus, Sun } from 'lucide-react'
import type { ReactNode } from 'react'
import { Dialog, IconButton } from '../ui'
import { defaults, type ReaderSettings } from '../../lib/reader/settings'
import '../../styles/reader.css'

interface Props {
  settings: ReaderSettings
  setSettings: (settings: ReaderSettings) => void
  theme: 'light' | 'dark'
  onTheme: (theme: 'light' | 'dark') => void
  onClose: () => void
  chapterControls?: ReactNode
}

export function ReadingSettings({
  settings,
  setSettings,
  theme,
  onTheme,
  onClose,
  chapterControls,
}: Props) {
  const font =
    settings.font === 'literata'
      ? 'Literata, Georgia, serif'
      : settings.font === 'manrope'
        ? 'Manrope, sans-serif'
        : 'Georgia, serif'
  return (
    <Dialog title="Reading settings" className="drawer" onClose={() => onClose()}>
      <div className="setting-group">
        <label>Appearance</label>
        <div className="segmented theme-options">
          <button
            className={theme === 'light' ? 'selected' : ''}
            aria-pressed={theme === 'light'}
            onClick={() => onTheme('light')}
          >
            <Sun size={18} /> Light
          </button>
          <button
            className={theme === 'dark' ? 'selected' : ''}
            aria-pressed={theme === 'dark'}
            onClick={() => onTheme('dark')}
          >
            <Moon size={18} /> Dark
          </button>
        </div>
      </div>
      {chapterControls && (
        <section className="reader-chapter-settings" aria-label="Chapter settings">
          <h3>Chapter</h3>
          {chapterControls}
        </section>
      )}
      <div className="setting-group">
        <label>Typeface</label>
        <div className="font-options">
          {(['literata', 'georgia', 'manrope'] as const).map((typeface) => (
            <button
              className={settings.font === typeface ? 'selected' : ''}
              key={typeface}
              aria-pressed={settings.font === typeface}
              style={{
                fontFamily:
                  typeface === 'literata'
                    ? 'Literata'
                    : typeface === 'georgia'
                      ? 'Georgia'
                      : 'Manrope',
              }}
              onClick={() => setSettings({ ...settings, font: typeface })}
            >
              <span>Aa</span>
              <small>
                {typeface === 'literata'
                  ? 'Literata'
                  : typeface === 'georgia'
                    ? 'Georgia'
                    : 'Manrope'}
              </small>
            </button>
          ))}
        </div>
      </div>
      <div className="setting-group">
        <label htmlFor="font-size">
          Text size <span>{settings.fontSize}px</span>
        </label>
        <div className="stepper">
          <IconButton
            label="Decrease text size"
            disabled={settings.fontSize <= 14}
            onClick={() => setSettings({ ...settings, fontSize: settings.fontSize - 1 })}
          >
            <Minus size={17} />
          </IconButton>
          <input
            id="font-size"
            type="range"
            min={14}
            max={30}
            value={settings.fontSize}
            onChange={(event) => setSettings({ ...settings, fontSize: Number(event.target.value) })}
          />
          <IconButton
            label="Increase text size"
            disabled={settings.fontSize >= 30}
            onClick={() => setSettings({ ...settings, fontSize: settings.fontSize + 1 })}
          >
            <Plus size={17} />
          </IconButton>
        </div>
      </div>
      <div className="setting-group">
        <label htmlFor="line-height">
          Line spacing <span>{settings.lineHeight.toFixed(1)}</span>
        </label>
        <input
          id="line-height"
          type="range"
          min={1.4}
          max={2.4}
          step={0.1}
          value={settings.lineHeight}
          onChange={(event) => setSettings({ ...settings, lineHeight: Number(event.target.value) })}
        />
      </div>
      <div className="setting-group">
        <label htmlFor="page-width">
          Page width <span>{settings.width}px</span>
        </label>
        <input
          id="page-width"
          type="range"
          min={480}
          max={880}
          step={20}
          value={settings.width}
          onChange={(event) => setSettings({ ...settings, width: Number(event.target.value) })}
        />
      </div>
      <div
        className="type-preview"
        style={{
          fontFamily: font,
          fontSize: settings.fontSize,
          lineHeight: settings.lineHeight,
        }}
      >
        There is no place quite like the next page.
      </div>
      <button className="button subtle reset-settings" onClick={() => setSettings(defaults)}>
        Reset typography
      </button>
    </Dialog>
  )
}
