import { state } from '../core/state.js'

// track session start time and notes born during active session --------------------
export const sessionstarttime = (() => {
  try {
    const stored = sessionStorage.getItem('mushnote_session_start')
    if (stored) {
      const parsed = parseInt(stored, 10)
      if (!isNaN(parsed) && parsed > 0) return parsed
    }
  } catch {}
  const now = Date.now()
  try {
    sessionStorage.setItem('mushnote_session_start', String(now))
  } catch {}
  return now
})()

const sessioncreatednotes = new Set()

export function marksessioncreated(noteid) {
  if (!noteid) return
  const normid = noteid.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  sessioncreatednotes.add(normid)
  if (normid.endsWith('.md')) {
    sessioncreatednotes.add(normid.slice(0, -3))
  } else {
    sessioncreatednotes.add(`${normid}.md`)
  }
}

export function iscreatedduringsession(noteid, notemeta = {}) {
  if (!noteid) return false
  const normid = noteid.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (sessioncreatednotes.has(normid)) return true
  const withmd = normid.endsWith('.md') ? normid : `${normid}.md`
  if (sessioncreatednotes.has(withmd)) return true
  const stripped = normid.endsWith('.md') ? normid.slice(0, -3) : normid
  if (sessioncreatednotes.has(stripped)) return true

  const birthtime = notemeta.created_time || (notemeta.created_at ? new Date(notemeta.created_at).getTime() : 0)
  if (birthtime && birthtime >= (sessionstarttime - 3000)) {
    return true
  }
  return false
}

// local browser storage for tracking what the current user last saw in each note --------------------
function getseenstoragekey() {
  const userid = state.currentuser?.id || state.currentuser?.user_id || 'default'
  return `mushnote_seen_notes_${userid}`
}

function loadseenmap() {
  try {
    const raw = localStorage.getItem(getseenstoragekey())
    if (raw) return JSON.parse(raw)
  } catch {}
  return {}
}

export function writespotseen(noteid, content) {
  if (!noteid) return
  try {
    const key = getseenstoragekey()
    const map = loadseenmap()
    const normid = noteid.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    map[normid] = {
      content: typeof content === 'string' ? content : '',
      updated_at: Date.now()
    }
    // prune oldest entries when exceeding cap to save space --------------------
    const keys = Object.keys(map)
    if (keys.length > 150) {
      const sorted = keys.sort((a, b) => (map[a]?.updated_at || 0) - (map[b]?.updated_at || 0))
      for (let i = 0; i < keys.length - 150; i++) {
        delete map[sorted[i]]
      }
    }
    localStorage.setItem(key, JSON.stringify(map))
  } catch {}
}

export function getspotseen(noteid) {
  if (!noteid) return null
  const map = loadseenmap()
  const normid = noteid.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (map[normid]) return map[normid]
  const withmd = normid.endsWith('.md') ? normid : `${normid}.md`
  if (map[withmd]) return map[withmd]
  const stripped = normid.endsWith('.md') ? normid.slice(0, -3) : normid
  if (map[stripped]) return map[stripped]
  return null
}

// save workspace tab state to local storage --------------------
export function saveworkspacestate() {
  const userid = state.currentuser?.id || 'guest'
  const ws = {
    opentabs: state.opentabs,
    activenoteid: state.activenoteid,
    currentfolder: state.currentfolder
  }
  try {
    localStorage.setItem(`mushnote_ws_${userid}`, JSON.stringify(ws))
  } catch {}
}

// load workspace tab state from local storage --------------------
export function loadworkspacestate() {
  const userid = state.currentuser?.id || 'guest'
  try {
    const raw = localStorage.getItem(`mushnote_ws_${userid}`)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

