import { api } from '../../core/api.js'
import { state } from '../../core/state.js'
import {
  ed,
  editorcontainer,
  tiptapeditorcontainer,
  noteeditor
} from '../editorshared.js'
import { ismarkdownfile, isexternalurl, resolvenoteid, isnoteidmatch } from '../noteutils.js'
import { handleimagepaste } from '../media/imageupload.js'
import {
  getdraggeditems,
  clearalldraghighlights,
  insertdraggeditemsintoactivenote
} from '../dragdrop.js'
import { geteditorselectionreference, openeditorselectionmenu } from '../selection.js'
import { opennote } from '../editor.js'
import { noteexists, refreshlinkicons } from './linkicons.js'
import { marksessioncreated } from '../session.js'

// scroll editor view to matching heading anchor --------------------
export function scrolltoanchor(anchor) {
  if (!anchor) return
  setTimeout(() => {
    const clean = decodeURIComponent(anchor).toLowerCase().replace(/[^a-z0-9_-]/g, '')
    const headings = tiptapeditorcontainer ? tiptapeditorcontainer.querySelectorAll('h1, h2, h3, h4, h5, h6') : []
    for (const h of headings) {
      const textslug = h.textContent.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '')
      if (textslug === clean || h.textContent.trim().toLowerCase() === anchor.toLowerCase()) {
        h.scrollIntoView({ behavior: 'smooth', block: 'start' })
        h.style.transition = 'background-color 0.3s ease'
        h.style.backgroundColor = 'rgba(59, 130, 246, 0.25)'
        setTimeout(() => { h.style.backgroundColor = '' }, 1200)
        break
      }
    }
  }, 180)
}

async function ensurelinkednoteexists(noteid) {
  if (!noteid || noteexists(noteid)) return noteid

  const basename = noteid.split('/').pop().replace(/\.md$/i, '') || 'untitled'
  const content = `# ${basename}\n\n`
  const author = state.currentuser?.id || 'unknown'

  const res = await api('/api/notes', {
    method: 'POST',
    body: JSON.stringify({
      note_id: noteid,
      content,
      author
    })
  })

  const createdid = res?.note_id || noteid
  marksessioncreated(createdid)
  if (Array.isArray(state.allnotes) && !noteexists(createdid)) {
    state.allnotes.push({ note_id: createdid })
  }
  refreshlinkicons()
  return createdid
}

// open note from link in current or new tab and scroll to anchor if given --------------------
export async function opennotelink(rawtarget, options = {}) {
  if (!rawtarget) return
  if (isexternalurl(rawtarget)) {
    window.open(rawtarget, '_blank', 'noopener,noreferrer')
    return
  }

  const { noteid, anchor } = resolvenoteid(rawtarget)
  if (!noteid) return

  const { newtab = false } = options
  let targetid = noteid
  try {
    targetid = await ensurelinkednoteexists(noteid)
  } catch (err) {
    console.error('could not create missing note', err)
  }

  await opennote(targetid, { newtab, replacecurrent: !newtab, switchfolder: true })

  if (anchor) {
    scrolltoanchor(anchor)
  }
}

const notelinkcontextmenu = document.getElementById('note-link-context-menu')
const ctxitemlinkopentab = document.getElementById('ctx-item-link-open-tab')
const ctxitemlinkcopy = document.getElementById('ctx-item-link-copy')
let pendingnotelinkhref = null
let isnotelinkmenubound = false
let ignorelinkclickuntil = 0

export function shouldignorenotelinkclick() {
  return Date.now() < ignorelinkclickuntil
}

export function closenotelinkmenu() {
  if (notelinkcontextmenu) notelinkcontextmenu.classList.add('hidden')
  pendingnotelinkhref = null
}

export function opennotelinkmenu(x, y, href) {
  if (!notelinkcontextmenu || !href || isexternalurl(href)) return
  // some browsers still fire a click after contextmenu --------------------
  ignorelinkclickuntil = Date.now() + 500
  pendingnotelinkhref = href

  const { noteid } = resolvenoteid(href)
  const alreadyopen = Boolean(noteid && state.opentabs.some((t) => isnoteidmatch(t, noteid)))
  if (ctxitemlinkopentab) {
    ctxitemlinkopentab.innerHTML = alreadyopen
      ? '<img class="btn-icon-img" src="/resources/icons/general/open-tab.png" alt="show"> show tab'
      : '<img class="btn-icon-img" src="/resources/icons/general/open-tab.png" alt="tab"> open in new tab'
  }

  notelinkcontextmenu.style.left = `${x}px`
  notelinkcontextmenu.style.top = `${y}px`
  notelinkcontextmenu.classList.remove('hidden')
}

function initnotelinkmenu() {
  if (isnotelinkmenubound) return
  isnotelinkmenubound = true

  if (notelinkcontextmenu) {
    notelinkcontextmenu.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
  }

  document.addEventListener('mousedown', (e) => {
    if (!notelinkcontextmenu || notelinkcontextmenu.classList.contains('hidden')) return
    if (notelinkcontextmenu.contains(e.target)) return
    closenotelinkmenu()
  })

  if (ctxitemlinkopentab) {
    ctxitemlinkopentab.addEventListener('click', (e) => {
      e.stopPropagation()
      const href = pendingnotelinkhref
      closenotelinkmenu()
      if (!href) return
      const { noteid } = resolvenoteid(href)
      const alreadyopen = Boolean(noteid && state.opentabs.some((t) => isnoteidmatch(t, noteid)))
      opennotelink(href, { newtab: !alreadyopen })
    })
  }

  if (ctxitemlinkcopy) {
    ctxitemlinkcopy.addEventListener('click', async (e) => {
      e.stopPropagation()
      const href = pendingnotelinkhref
      closenotelinkmenu()
      if (!href) return
      const { noteid } = resolvenoteid(href)
      const text = noteid || href
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        // ignore clipboard failures --------------------
      }
    })
  }
}

// handle clicking and right clicking note links in editor container --------------------
let iseditorlinksbound = false
export function initeditorlinkevents() {
  if (iseditorlinksbound || !tiptapeditorcontainer) return
  iseditorlinksbound = true
  initnotelinkmenu()

  // left click navigates in current tab --------------------
  tiptapeditorcontainer.addEventListener('click', (e) => {
    if (e.button !== 0 || shouldignorenotelinkclick()) return
    const link = e.target.closest('a')
    if (!link) return

    const href = link.getAttribute('data-note-link') || link.getAttribute('href') || link.href
    if (!href) return

    if (isexternalurl(href)) {
      window.open(href, '_blank', 'noopener,noreferrer')
      e.preventDefault()
      e.stopPropagation()
      return
    }

    e.preventDefault()
    e.stopPropagation()
    opennotelink(href, { newtab: false })
  })

  // right click note link shows copy / open menu --------------------
  tiptapeditorcontainer.addEventListener('contextmenu', (e) => {
    if (document.body?.classList.contains('is-mobile')) return
    const link = e.target.closest('a')
    if (link) {
      const href = link.getAttribute('data-note-link') || link.getAttribute('href') || link.href
      if (href && !isexternalurl(href)) {
        e.preventDefault()
        e.stopPropagation()
        opennotelinkmenu(e.clientX, e.clientY, href)
        return
      }
    }

    e.preventDefault()
    e.stopPropagation()
    const ref = geteditorselectionreference()
    openeditorselectionmenu(e.clientX, e.clientY, ref)
  })

  // middle click opens note link in new tab --------------------
  tiptapeditorcontainer.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return
    const link = e.target.closest('a')
    if (!link) return

    const href = link.getAttribute('data-note-link') || link.getAttribute('href') || link.href
    if (!href || isexternalurl(href)) return

    e.preventDefault()
    e.stopPropagation()
    opennotelink(href, { newtab: true })
  })

  // fallback image paste listener for editor workspace --------------------
  if (editorcontainer) {
    editorcontainer.addEventListener('paste', (e) => {
      if (e.defaultPrevented) return
      const items = e.clipboardData?.items
      if (items) {
        for (let i = 0; i < items.length; i++) {
          const item = items[i]
          if (item && item.type && item.type.startsWith('image/')) {
            const file = item.getAsFile()
            if (file) {
              e.preventDefault()
              handleimagepaste(file)
              return
            }
          }
        }
      }
    })

    // drag and drop files and folders into editor workspace --------------------
    editorcontainer.addEventListener('dragover', (e) => {
      const ismushitem = state.activefiledrag || e.dataTransfer?.types?.includes('application/mushnote-item')
      const hasfiles = e.dataTransfer?.types?.includes('Files')
      if (!ismushitem && !hasfiles) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      editorcontainer.classList.add('drag-over')
    })

    editorcontainer.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && editorcontainer.contains(e.relatedTarget)) return
      editorcontainer.classList.remove('drag-over')
    })

    editorcontainer.addEventListener('contextmenu', (e) => {
      if (document.body?.classList.contains('is-mobile')) return
      if (ismarkdownfile(state.activenoteid) && ed.tiptapinstance) return
      e.preventDefault()
      e.stopPropagation()
      const ref = geteditorselectionreference()
      openeditorselectionmenu(e.clientX, e.clientY, ref)
    })

    if (noteeditor) {
      noteeditor.addEventListener('contextmenu', (e) => {
        if (document.body?.classList.contains('is-mobile')) return
        e.preventDefault()
        e.stopPropagation()
        const ref = geteditorselectionreference()
        openeditorselectionmenu(e.clientX, e.clientY, ref)
      })
    }

    editorcontainer.addEventListener('drop', async (e) => {
      clearalldraghighlights()
      if (e.defaultPrevented) return

      const dragitems = getdraggeditems(e)
      const files = e.dataTransfer?.files

      if (dragitems.length) {
        e.preventDefault()
        e.stopPropagation()
        state.activefiledrag = null
        clearalldraghighlights()

        if (!state.activenoteid) return

        // caret already followed the mouse on dragover --------------------
        insertdraggeditemsintoactivenote(dragitems)
        return
      }

      if (files && files.length > 0) {
        for (let i = 0; i < files.length; i++) {
          if (files[i].type && files[i].type.startsWith('image/')) {
            e.preventDefault()
            e.stopPropagation()
            handleimagepaste(files[i])
            return
          }
        }
      }
    })
  }
}

