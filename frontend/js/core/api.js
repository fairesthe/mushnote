// fetch api helper with auth header and cookie credentials --------------------
export async function api(path, options = {}) {
  const token = localStorage.getItem('mushnote_token')
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

export function resolveaccent(prefs = {}) {
  if (!prefs || typeof prefs !== 'object') return '#5f805e'
  return prefs.accent || prefs['accent-color'] || prefs['user-color'] || '#5f805e'
}

// icon art uses white + pure red (#ff0000)
// hue-rotate leaves white alone and shifts only the red toward accent --------------------
const iconbaseredhue = 0

function parsehexrgb(hex) {
  if (!hex || typeof hex !== 'string') return null
  let c = hex.replace('#', '').trim()
  if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2]
  if (!/^[0-9a-fA-F]{6}$/.test(c)) return null
  const num = parseInt(c, 16)
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255
  }
}

function rgbtohsl(r, g, b) {
  const rr = r / 255
  const gg = g / 255
  const bb = b / 255
  const max = Math.max(rr, gg, bb)
  const min = Math.min(rr, gg, bb)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6
  else if (max === gg) h = ((bb - rr) / d + 2) / 6
  else h = ((rr - gg) / d + 4) / 6
  return { h: h * 360, s, l }
}

export function accenticonfilter(accent) {
  const rgb = parsehexrgb(accent)
  if (!rgb) return 'none'
  const { h, s, l } = rgbtohsl(rgb.r, rgb.g, rgb.b)
  // near white or gray accents keep the drawn red as-is --------------------
  if (s < 0.08 || l > 0.92) return 'none'
  const delta = Math.round(h - iconbaseredhue)
  const sat = Math.max(0.55, Math.min(1.75, s / 0.85))
  return `hue-rotate(${delta}deg) saturate(${sat.toFixed(2)})`
}

// apply user theme preferences --------------------
export function applytheme(prefs = {}) {
  const root = document.documentElement
  root.style.setProperty('--bg-color', prefs['bg-color'] || '#000000')
  root.style.setProperty('--text-color', prefs['text-color'] || '#ededed')
  const accent = resolveaccent(prefs)
  root.style.setProperty('--accent-color', accent)
  root.style.setProperty('--highlight-color', hextorgba(accent, 0.35))
  root.style.setProperty('--icon-accent-filter', accenticonfilter(accent))

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

