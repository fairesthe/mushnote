import { api, hextorgba } from './api.js'
import { state } from './state.js'
import { rendertabs } from './tabs.js'
import { renderfolderview, updateactivefilerow } from './files.js'

// dom elements for editor --------------------
const editorcontainer = document.getElementById('editor-container')
const emptystate = document.getElementById('empty-state')
const noteeditor = document.getElementById('note-editor')
const editorbackdrop = document.getElementById('editor-backdrop')
const editorcursors = document.getElementById('editor-cursors')
const editorcursorscontent = document.getElementById('editor-cursors-content')
const imageviewercontainer = document.getElementById('image-viewer-container')
const imageviewerimg = document.getElementById('image-viewer-img')
const imageviewermeta = document.getElementById('image-viewer-meta')

let notesocket = null
let flashtimeout = null
let savetimer = null
let caretmeter = null
let cursortimer = null
const activecursors = new Map()

// measurement element to calculate pixel coordinates in textarea --------------------
function getcaretmeter() {
  if (caretmeter) return caretmeter
  caretmeter = document.createElement('div')
  caretmeter.className = 'editor-caret-meter'
  caretmeter.setAttribute('aria-hidden', 'true')
  document.body.appendChild(caretmeter)
  return caretmeter
}

// compute pixel coordinates of character index in textarea --------------------
function getcaretcoordinates(textarea, index) {
  if (!textarea) return { left: 0, top: 0 }
  const meter = getcaretmeter()
  const style = window.getComputedStyle(textarea)

  meter.style.width = textarea.clientWidth + 'px'
  meter.style.paddingLeft = style.paddingLeft
  meter.style.paddingRight = style.paddingRight
  meter.style.paddingTop = style.paddingTop
  meter.style.paddingBottom = style.paddingBottom
  meter.style.fontFamily = style.fontFamily
  meter.style.fontSize = style.fontSize
  meter.style.lineHeight = style.lineHeight
  meter.style.letterSpacing = style.letterSpacing
  meter.style.tabSize = style.tabSize

  const value = textarea.value
  const clampedindex = Math.max(0, Math.min(index, value.length))
  const textbefore = value.substring(0, clampedindex)

  meter.textContent = textbefore
  const span = document.createElement('span')
  span.textContent = value.substring(clampedindex, clampedindex + 1) || ' '
  meter.appendChild(span)

  const left = span.offsetLeft
  const top = span.offsetTop

  return { left, top }
}

// sync cursors layer scroll with textarea --------------------
function synccursorscroll() {
  if (editorcursorscontent && noteeditor) {
    editorcursorscontent.style.transform = `translate(${-noteeditor.scrollLeft}px, ${-noteeditor.scrollTop}px)`
  }
}

// update position of a specific remote cursor --------------------
function positionremotecursor(record) {
  if (!record || !record.element || !noteeditor) return
  const coords = getcaretcoordinates(noteeditor, record.index)
  record.element.style.left = `${coords.left}px`
  record.element.style.top = `${coords.top}px`
}

// update all active remote cursors after text change or resize --------------------
export function refreshallremotecursors() {
  for (const record of activecursors.values()) {
    positionremotecursor(record)
  }
}

// handle remote cursor update from websocket --------------------
function handleremotecursor(data) {
  const { author, index } = data
  if (!author || !editorcursorscontent) return

  const usercolor = state.usercolormap[author] || '#3b82f6'
  const useravatar = state.useravatarmap?.[author]
    || (author === 'ai' ? '/avatars/ai.jpg' : `/avatars/${author}.png`)

  let record = activecursors.get(author)
  if (!record) {
    const cursel = document.createElement('div')
    cursel.className = 'live-cursor'
    cursel.style.setProperty('--cursor-color', usercolor)

    const caret = document.createElement('div')
    caret.className = 'live-cursor-caret'

    const badge = document.createElement('div')
    badge.className = 'live-cursor-badge'
    badge.title = author

    const img = document.createElement('img')
    img.src = useravatar
    img.alt = author
    img.className = 'live-cursor-avatar'

    const fallback = document.createElement('span')
    fallback.className = 'live-cursor-initial'
    fallback.textContent = (author.charAt(0) || '?').toUpperCase()
    fallback.style.display = 'none'

    img.onerror = () => {
      img.style.display = 'none'
      fallback.style.display = 'block'
    }

    badge.appendChild(img)
    badge.appendChild(fallback)
    cursel.appendChild(caret)
    cursel.appendChild(badge)
    editorcursorscontent.appendChild(cursel)

    record = { author, index: index || 0, element: cursel }
    activecursors.set(author, record)
  } else {
    record.index = typeof index === 'number' ? index : record.index
  }

  positionremotecursor(record)
}

// remove remote cursor when user leaves note --------------------
function removeremotecursor(author) {
  const record = activecursors.get(author)
  if (record) {
    record.element.remove()
    activecursors.delete(author)
  }
}

// clear all remote cursors when closing or switching note --------------------
export function clearallremotecursors() {
  for (const record of activecursors.values()) {
    record.element.remove()
  }
  activecursors.clear()
}

// broadcast local user cursor position over websocket --------------------
export function broadcastcursorposition() {
  if (!notesocket || notesocket.readyState !== WebSocket.OPEN) return
  if (!state.activenoteid) return
  const myid = state.currentuser?.id || state.currentuser?.user_id
  if (!myid) return
  const index = noteeditor ? noteeditor.selectionStart : 0
  const payload = JSON.stringify({
    type: 'cursor_event',
    note_id: state.activenoteid,
    author: myid,
    index
  })
  notesocket.send(payload)
}

// queue throttled cursor broadcast --------------------
function queuecursorbroadcast() {
  if (cursortimer) clearTimeout(cursortimer)
  cursortimer = setTimeout(broadcastcursorposition, 50)
}

// helper to match note ids with or without md extension --------------------
function isnoteidmatch(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  const norma = a.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const normb = b.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (norma === normb) return true
  return norma.replace(/\.md$/, '') === normb.replace(/\.md$/, '')
}

// connect websocket for real time edit events and animations --------------------
export function connectnotesocket(noteid) {
  if (notesocket) {
    try {
      const myid = state.currentuser?.id || state.currentuser?.user_id
      if (myid && notesocket.readyState === WebSocket.OPEN) {
        notesocket.send(JSON.stringify({
          type: 'cursor_leave',
          note_id: state.activenoteid,
          author: myid
        }))
      }
      notesocket.close()
    } catch {}
    notesocket = null
  }

  clearallremotecursors()
  if (editorbackdrop) {
    editorbackdrop.innerHTML = ''
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const author = state.currentuser ? state.currentuser.id : 'unknown'
  const wsurl = `${protocol}//${window.location.host}/ws/${encodeURIComponent(noteid)}?author=${encodeURIComponent(author)}`

  notesocket = new WebSocket(wsurl)

  notesocket.onopen = () => {
    broadcastcursorposition()
  }

  notesocket.onmessage = (event) => {
    try {
      if (typeof event.data !== 'string') {
        return
      }
      const data = JSON.parse(event.data)
      const myid = state.currentuser?.id || state.currentuser?.user_id

      if (data.type === 'edit_event' && isnoteidmatch(data.note_id, state.activenoteid)) {
        // don't flash our own live local keystrokes --------------------
        if (data.author && myid && data.author === myid) {
          return
        }
        handleotheruseredit(data)
      } else if (data.type === 'vault_changed') {
        window.dispatchEvent(new CustomEvent('vault-changed', { detail: data }))
      } else if (data.type === 'cursor_event' && isnoteidmatch(data.note_id, state.activenoteid)) {
        if (data.author && myid && data.author === myid) {
          return
        }
        handleremotecursor(data)
      } else if (data.type === 'cursor_leave' && isnoteidmatch(data.note_id, state.activenoteid)) {
        removeremotecursor(data.author)
      } else if (data.type === 'cursor_query' && isnoteidmatch(data.note_id, state.activenoteid)) {
        if (data.author && myid && data.author !== myid) {
          broadcastcursorposition()
        }
      } else if (data.type === 'note_renamed') {
        const oldid = data.old_note_id
        const newid = data.new_note_id
        let modified = false
        if (state.opentabs.some(t => isnoteidmatch(t, oldid))) {
          state.opentabs = state.opentabs.map(t => isnoteidmatch(t, oldid) ? newid : t)
          modified = true
        }
        if (isnoteidmatch(state.activenoteid, oldid)) {
          state.activenoteid = newid
          modified = true
          connectnotesocket(newid)
        }
        if (modified) {
          rendertabs()
          saveworkspacestate()
        }
      }
    } catch {}
  }
}

// trigger highlight flash animation for edits made by another user --------------------
function handleotheruseredit(data) {
  const { author, edits } = data
  const usercolor = author === 'external' ? '#737373' : (state.usercolormap[author] || '#3b82f6')

  // fetch latest text if not already synced --------------------
  api(`/api/note?id=${encodeURIComponent(state.activenoteid)}`).then(res => {
    if (!res || !res.note) return
    const text = res.note.content || ''
    const previouscursor = noteeditor.selectionStart
    noteeditor.value = text
    noteeditor.selectionStart = previouscursor
    noteeditor.selectionEnd = previouscursor

    renderflashhighlight(text, edits, usercolor, author)
    refreshallremotecursors()
  }).catch(() => {})
}

// render flash highlight behind text in editor backdrop --------------------
export function renderflashhighlight(text, edits, usercolor, author = '') {
  if (!editorbackdrop) return

  // find bounds of affected edit region --------------------
  let minstart = text.length
  let maxend = 0

  for (const edit of edits) {
    const from = Math.max(0, Math.min(edit.from, text.length))
    const to = Math.max(from, Math.min(edit.to || edit.from + 1, text.length))
    if (from < minstart) minstart = from
    if (to > maxend) maxend = to
  }

  if (minstart > maxend || minstart >= text.length) {
    minstart = Math.max(0, text.length - 1)
    maxend = text.length
  }

  // trim leading and trailing newlines from highlight region so blank line breaks do not get highlighted --------------------
  while (minstart < maxend && (text[minstart] === '\n' || text[minstart] === '\r')) {
    minstart++
  }
  while (maxend > minstart && (text[maxend - 1] === '\n' || text[maxend - 1] === '\r')) {
    maxend--
  }

  // if the edit was only newlines or whitespace there is no text to highlight --------------------
  if (minstart >= maxend) {
    return
  }

  const before = text.slice(0, minstart)
  const highlighted = text.slice(minstart, maxend)
  const after = text.slice(maxend)

  // set user color variables --------------------
  const bgcolor = hextorgba(usercolor, 0.28)
  const bordercolor = hextorgba(usercolor, 0.75)
  const glowcolor = hextorgba(usercolor, 0.35)

  editorbackdrop.style.setProperty('--flash-user-bg', bgcolor)
  editorbackdrop.style.setProperty('--flash-user-border', bordercolor)
  editorbackdrop.style.setProperty('--flash-user-glow', glowcolor)

  editorbackdrop.innerHTML = ''

  // split highlighted block across newlines so span borders wrap individual lines without tall rectangular box on blank lines --------------------
  if (before) {
    const beforespan = document.createElement('span')
    beforespan.textContent = before
    editorbackdrop.appendChild(beforespan)
  }

  let lastflashspan = null
  const lines = highlighted.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.length > 0) {
      const flashspan = document.createElement('span')
      flashspan.className = 'edit-flash'
      flashspan.textContent = line
      editorbackdrop.appendChild(flashspan)
      lastflashspan = flashspan
    }
    if (i < lines.length - 1) {
      editorbackdrop.appendChild(document.createTextNode('\n'))
    }
  }

  // append user icon badge to bottom right corner of highlight --------------------
  if (lastflashspan && author && author !== 'external') {
    const useravatar = state.useravatarmap?.[author]
      || (author === 'ai' ? '/avatars/ai.jpg' : `/avatars/${author}.png`)

    const anchor = document.createElement('span')
    anchor.className = 'edit-user-anchor'

    const badge = document.createElement('span')
    badge.className = 'edit-user-badge'
    badge.title = author

    const img = document.createElement('img')
    img.src = useravatar
    img.alt = author
    img.className = 'edit-user-img'

    const fallback = document.createElement('span')
    fallback.className = 'edit-user-fallback'
    fallback.textContent = (author.charAt(0) || '?').toUpperCase()
    fallback.style.display = 'none'

    img.onerror = () => {
      img.style.display = 'none'
      fallback.style.display = 'block'
    }

    badge.appendChild(img)
    badge.appendChild(fallback)
    anchor.appendChild(badge)
    lastflashspan.appendChild(anchor)
  }

  if (after) {
    const afterspan = document.createElement('span')
    afterspan.textContent = after
    editorbackdrop.appendChild(afterspan)
  }

  editorbackdrop.scrollTop = noteeditor.scrollTop
  editorbackdrop.scrollLeft = noteeditor.scrollLeft

  if (flashtimeout) clearTimeout(flashtimeout)
  flashtimeout = setTimeout(() => {
    if (editorbackdrop) editorbackdrop.innerHTML = ''
  }, 2300)
}

// save workspace state to local storage --------------------
export function saveworkspacestate() {
  const userid = state.currentuser?.id || state.currentuser?.user_id
  if (!userid) return
  const ws = {
    opentabs: state.opentabs,
    activenoteid: state.activenoteid,
    currentfolder: state.currentfolder
  }
  try {
    localStorage.setItem(`mushnote_ws_${userid}`, JSON.stringify(ws))
  } catch {}
}

// load workspace state from local storage --------------------
export function loadworkspacestate() {
  const userid = state.currentuser?.id || state.currentuser?.user_id
  if (!userid) return null
  try {
    const raw = localStorage.getItem(`mushnote_ws_${userid}`) || localStorage.getItem(`gillium_ws_${userid}`)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

// close open note and return editor to completely blank state --------------------
export function closenote() {
  const myid = state.currentuser?.id || state.currentuser?.user_id
  if (notesocket) {
    try {
      if (myid && notesocket.readyState === WebSocket.OPEN && state.activenoteid) {
        notesocket.send(JSON.stringify({
          type: 'cursor_leave',
          note_id: state.activenoteid,
          author: myid
        }))
      }
      notesocket.close()
    } catch {}
    notesocket = null
  }

  clearallremotecursors()

  state.activenoteid = null
  state.opentabs = []
  rendertabs()
  saveworkspacestate()

  if (editorbackdrop) {
    editorbackdrop.innerHTML = ''
  }

  noteeditor.value = ''
  editorcontainer.classList.add('hidden')
  if (imageviewercontainer) imageviewercontainer.classList.add('hidden')
  emptystate.classList.remove('hidden')
  updateactivefilerow()

  // clear last-open-note from preferences on server --------------------
  if (state.currentuser) {
    if (!state.currentuser.preferences) state.currentuser.preferences = {}
    state.currentuser.preferences['last-open-note'] = null
    api('/api/user/preferences', {
      method: 'POST',
      body: JSON.stringify({
        preferences: { 'last-open-note': null }
      })
    }).catch(() => {})
  }
}

// open note in right column editor --------------------
export async function opennote(noteid, options = {}) {
  const opts = typeof options === 'boolean' ? { force: options } : (options || {})
  const { newtab = false, replacecurrent = true, switchfolder = true } = opts

  // manage open tabs list --------------------
  if (newtab) {
    if (!state.opentabs.includes(noteid)) {
      state.opentabs.push(noteid)
    }
  } else if (replacecurrent) {
    if (state.opentabs.length === 0) {
      state.opentabs = [noteid]
    } else if (state.opentabs.includes(noteid)) {
      // note already in tabs so keep existing tabs
    } else if (state.activenoteid && state.opentabs.includes(state.activenoteid)) {
      const idx = state.opentabs.indexOf(state.activenoteid)
      state.opentabs[idx] = noteid
    } else {
      state.opentabs.push(noteid)
    }
  } else {
    if (!state.opentabs.includes(noteid)) {
      state.opentabs.push(noteid)
    }
  }

  // deduplicate tabs --------------------
  state.opentabs = Array.from(new Set(state.opentabs))

  state.activenoteid = noteid
  rendertabs()

  // switch folder view only if requested --------------------
  if (switchfolder) {
    const notefolder = noteid.includes('/')
      ? noteid.split('/').slice(0, -1).join('/')
      : ''

    if (state.currentfolder !== notefolder) {
      state.currentfolder = notefolder
    }
    renderfolderview()
  } else {
    updateactivefilerow()
  }

  try {
    const data = await api(`/api/note?id=${encodeURIComponent(noteid)}`)
    emptystate.classList.add('hidden')

    if (data.note.is_image) {
      if (editorcontainer) editorcontainer.classList.add('hidden')
      if (imageviewercontainer) {
        imageviewercontainer.classList.remove('hidden')
        if (imageviewerimg) imageviewerimg.src = data.note.image_url || `/api/raw?id=${encodeURIComponent(noteid)}`
        if (imageviewermeta) {
          const sizestr = data.note.size ? ` - ${Math.round(data.note.size / 1024)} kb` : ''
          imageviewermeta.textContent = `${data.note.title}${sizestr}`
        }
      }
    } else {
      if (imageviewercontainer) imageviewercontainer.classList.add('hidden')
      if (editorcontainer) editorcontainer.classList.remove('hidden')
      noteeditor.value = data.note.content || ''
      connectnotesocket(noteid)
    }

    // persist last open note into user preferences on server --------------------
    if (state.currentuser) {
      if (!state.currentuser.preferences) state.currentuser.preferences = {}
      if (state.currentuser.preferences['last-open-note'] !== noteid) {
        state.currentuser.preferences['last-open-note'] = noteid
        api('/api/user/preferences', {
          method: 'POST',
          body: JSON.stringify({
            preferences: { 'last-open-note': noteid }
          })
        }).catch(() => {})
      }
    }

    saveworkspacestate()
  } catch (err) {
    console.error('failed to read note', err)
  }
}

// sync backdrop and cursors scrolling with textarea --------------------
noteeditor.addEventListener('scroll', () => {
  if (editorbackdrop) {
    editorbackdrop.scrollTop = noteeditor.scrollTop
    editorbackdrop.scrollLeft = noteeditor.scrollLeft
  }
  synccursorscroll()
})

// broadcast cursor position on user interactions --------------------
noteeditor.addEventListener('keyup', queuecursorbroadcast)
noteeditor.addEventListener('click', queuecursorbroadcast)
noteeditor.addEventListener('select', queuecursorbroadcast)

// re-align cursors on window resize --------------------
window.addEventListener('resize', refreshallremotecursors)

// debounced live auto save and cursor sync --------------------
noteeditor.addEventListener('input', () => {
  queuecursorbroadcast()
  refreshallremotecursors()

  if (!state.activenoteid) {
    return
  }

  if (savetimer) {
    clearTimeout(savetimer)
  }

  savetimer = setTimeout(async () => {
    try {
      await api('/api/notes', {
        method: 'POST',
        body: JSON.stringify({
          note_id: state.activenoteid,
          content: noteeditor.value,
          author: state.currentuser ? state.currentuser.id : 'unknown'
        })
      })
    } catch (err) {
      console.error('auto save failed', err)
    }
  }, 400)
})

