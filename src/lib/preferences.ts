export function readSetting<Value>(key: string, fallback: Value): Value {
  try {
    const value = localStorage.getItem(key)
    return value ? (JSON.parse(value) as Value) : fallback
  } catch {
    return fallback
  }
}

export function writeSetting(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    return
  }
}
