import { readSetting } from '../preferences'

export interface ReaderSettings {
  fontSize: number
  lineHeight: number
  width: number
  font: 'literata' | 'manrope' | 'georgia'
}

export const defaults: ReaderSettings = {
  fontSize: 19,
  lineHeight: 1.9,
  width: 680,
  font: 'literata',
}

export function initialSettings(): ReaderSettings {
  const saved = readSetting<Partial<ReaderSettings>>('novelist-reader', {})
  return {
    fontSize: Math.max(14, Math.min(30, Number(saved.fontSize) || defaults.fontSize)),
    lineHeight: Math.max(1.4, Math.min(2.4, Number(saved.lineHeight) || defaults.lineHeight)),
    width: Math.max(480, Math.min(880, Number(saved.width) || defaults.width)),
    font: ['literata', 'manrope', 'georgia'].includes(saved.font ?? '')
      ? saved.font!
      : defaults.font,
  }
}
