// fetch api helper with auth header and cookie credentials --------------------
export async function api(path, options = {}) {
  const token = localStorage.getItem('mushnote_token') || localStorage.getItem('gillium_token')
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const res = await fetch(path, { credentials: 'same-origin', ...options, headers })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || 'request failed')
  }
  return data
}

// parse reading scale preference into multiplier --------------------
export function parsereadingscale(val) {
  if (val === undefined || val === null || val === '') return 1
  const num = parseFloat(val)
  if (isNaN(num) || num <= 0) return 1
  return num > 10 ? num / 100 : num
}

// apply user theme preferences --------------------
export function applytheme(prefs = {}) {
  const root = document.documentElement
  root.style.setProperty('--bg-color', prefs['bg-color'] || '#000000')
  root.style.setProperty('--text-color', prefs['text-color'] || '#ededed')
  const accent = prefs['accent-color'] || '#ffffff'
  root.style.setProperty('--accent-color', accent)
  root.style.setProperty('--highlight-color', hextorgba(accent, 0.35))

  // text file reading scale for code and markdown --------------------
  const scale = parsereadingscale(prefs['reading-scale'])
  root.style.setProperty('--reading-scale', scale)
}

// convert hex color string to rgba format --------------------
export function hextorgba(hex, alpha = 1) {
  if (!hex || typeof hex !== 'string') return `rgba(59, 130, 246, ${alpha})`
  let c = hex.replace('#', '')
  if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2]
  const num = parseInt(c, 16)
  if (isNaN(num)) return `rgba(59, 130, 246, ${alpha})`
  const r = (num >> 16) & 255
  const g = (num >> 8) & 255
  const b = num & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

