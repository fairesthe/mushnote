import { state } from '../core/state.js'
import {
  ed,
  editorcontainer,
  tiptapeditorcontainer,
  noteeditor
} from './editorshared.js'
import { ismarkdownfile, isexternalurl, resolvenoteid } from './noteutils.js'
import { handleimagepaste } from './imageupload.js'
import {
  formatdraginsert,
  getdraggeditem,
  clearalldraghighlights,
  insertcontentintoactivenote
} from './dragdrop.js'
import { geteditorselectionreference, openeditorselectionmenu } from './selection.js'
import { opennote } from './editor.js'

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

// open note from link in current or new tab and scroll to anchor if given --------------------
export async function opennotelink(rawtarget, options = {}) {
  if (!rawtarget) return
  const { noteid, anchor } = resolvenoteid(rawtarget)
  if (!noteid) return

  const { newtab = false } = options
  await opennote(noteid, { newtab, replacecurrent: !newtab, switchfolder: true })

  if (anchor) {
    scrolltoanchor(anchor)
  }
}

// handle clicking and right clicking note links in editor container --------------------
let iseditorlinksbound = false
export function initeditorlinkevents() {
  if (iseditorlinksbound || !tiptapeditorcontainer) return
  iseditorlinksbound = true

  // left click navigates in current tab --------------------
  tiptapeditorcontainer.addEventListener('click', (e) => {
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

  // right click opens note link in new tab --------------------
  tiptapeditorcontainer.addEventListener('contextmenu', (e) => {
    const link = e.target.closest('a')
    if (link) {
      const href = link.getAttribute('data-note-link') || link.getAttribute('href') || link.href
      if (href && !isexternalurl(href)) {
        e.preventDefault()
        e.stopPropagation()
        opennotelink(href, { newtab: true })
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
      if (ismarkdownfile(state.activenoteid) && ed.tiptapinstance) return
      e.preventDefault()
      e.stopPropagation()
      const ref = geteditorselectionreference()
      openeditorselectionmenu(e.clientX, e.clientY, ref)
    })

    if (noteeditor) {
      noteeditor.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        e.stopPropagation()
        const ref = geteditorselectionreference()
        openeditorselectionmenu(e.clientX, e.clientY, ref)
      })
    }

    editorcontainer.addEventListener('drop', async (e) => {
      editorcontainer.classList.remove('drag-over')
      if (e.defaultPrevented) return

      const dragitem = getdraggeditem(e)
      const files = e.dataTransfer?.files

      if (dragitem) {
        e.preventDefault()
        e.stopPropagation()
        state.activefiledrag = null
        clearalldraghighlights()

        if (!state.activenoteid) return

        let droppos = null
        if (ismarkdownfile(state.activenoteid) && ed.tiptapinstance?.view) {
          const coords = { left: e.clientX, top: e.clientY }
          const dropinfo = ed.tiptapinstance.view.posAtCoords(coords)
          if (dropinfo && typeof dropinfo.pos === 'number') {
            droppos = dropinfo.pos
          }
        } else if (ed.cmview) {
          const dropinfo = ed.cmview.posAtCoords({ x: e.clientX, y: e.clientY })
          if (typeof dropinfo?.pos === 'number') {
            droppos = dropinfo.pos
          }
        }

        const insertinfo = formatdraginsert(dragitem)
        insertcontentintoactivenote(insertinfo, droppos)
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

