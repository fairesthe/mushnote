import { state } from '../core/state.js'
import { loadnotes, clearalldraghighlights } from './files.js'
import { uploadfiletovault, workingfolderfromstate } from './upload.js'
import { insertcontentintoactivenote } from '../editor/dragdrop.js'
import { ensureaidraweropen } from './layout.js'
import { ed } from '../editor/editorshared.js'
import { ismarkdownfile } from '../editor/noteutils.js'

let dragdepth = 0
let activezone = null
let activehoverel = null

function isosfiledrag(e) {
  if (state.activefiledrag) return false
  if (e.dataTransfer?.types?.includes('application/mushnote-item')) return false
  return Boolean(e.dataTransfer?.types?.includes('Files'))
}

// precise drop targets (not the whole columns) --------------------
function zonetargets() {
  return {
    files: [
      ...document.querySelectorAll('.folder-quick-btn'),
      document.getElementById('folder-nav-pane')
    ].filter(Boolean),
    note: [
      document.getElementById('tiptap-editor'),
      document.getElementById('plain-editor-wrap'),
      document.getElementById('codemirror-editor'),
      document.getElementById('note-editor')
    ].filter(Boolean),
    chat: [
      document.getElementById('ai-form')
    ].filter(Boolean)
  }
}

function clearzonehover() {
  document.querySelectorAll('.os-drop-target.os-drop-hover').forEach((el) => {
    el.classList.remove('os-drop-hover')
  })
  activehoverel = null
}

function setdragging(on) {
  document.body.classList.toggle('is-dragging-os-file', on)
  const targets = zonetargets()
  for (const list of Object.values(targets)) {
    for (const el of list) el.classList.toggle('os-drop-target', on)
  }
  if (!on) {
    activezone = null
    clearzonehover()
  }
}

function zoneforelement(el) {
  if (!el || typeof el.closest !== 'function') return null
  // each quick btn is its own target, not the whole quick-nav row --------------------
  if (el.closest('.folder-quick-btn') || el.closest('#folder-nav-pane')) return 'files'
  if (el.closest('#ai-form')) return 'chat'
  // note content only, never tabs or toolbar --------------------
  if (el.closest('#editor-tabs-bar') || el.closest('.editor-toolbar') || el.closest('.binary-file-toolbar')) {
    return null
  }
  if (
    el.closest('#tiptap-editor') ||
    el.closest('#plain-editor-wrap') ||
    el.closest('#codemirror-editor') ||
    el.closest('#note-editor') ||
    el.closest('.editor-body') ||
    el.closest('.ProseMirror') ||
    el.closest('.cm-editor')
  ) {
    return 'note'
  }
  return null
}

function hovertargetfor(el, zone) {
  if (!el || !zone) return null
  const targets = zonetargets()[zone] || []
  for (const t of targets) {
    if (t === el || t.contains(el)) return t
  }
  if (zone === 'note' || zone === 'chat') {
    return targets.find((t) => t && !t.classList.contains('hidden')) || targets[0] || null
  }
  return null
}

function setactivezone(zone, el) {
  const hoverel = hovertargetfor(el, zone)
  if (activezone === zone && activehoverel === hoverel) return
  activezone = zone
  clearzonehover()
  activehoverel = hoverel
  if (hoverel) hoverel.classList.add('os-drop-hover')
}

function resolvefilesfolder(clientx, clienty) {
  const under = document.elementFromPoint(clientx, clienty)
  if (!under) return workingfolderfromstate()
  const folderrow = under.closest?.('.folder-row.is-folder')
  if (folderrow?.dataset?.folderPath) return folderrow.dataset.folderPath
  if (under.closest?.('#btn-folder-home')) return ''
  if (under.closest?.('#btn-folder-media')) return 'media'
  return workingfolderfromstate()
}

async function handlefilesdrop(files, folder) {
  if (!files.length) return
  for (const file of files) {
    try {
      await uploadfiletovault(file, folder)
    } catch (err) {
      if (err?.name === 'AbortError') break
      console.error('folder upload failed', err)
      alert(`could not upload "${file.name}"`)
    }
  }
  try { await loadnotes() } catch {}
}

async function handlenotedrop(files) {
  if (!files.length || !state.activenoteid) return
  for (const file of files) {
    try {
      const uploaded = await uploadfiletovault(file, 'media')
      const isimage = /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i.test(uploaded.path || uploaded.name || '')
      if (isimage) {
        insertcontentintoactivenote({
          type: 'image',
          url: uploaded.url || `/${uploaded.path}`,
          alt: uploaded.alt || uploaded.name || 'image',
          text: `![${uploaded.alt || uploaded.name || 'image'}](${uploaded.url || `/${uploaded.path}`})`
        })
      } else {
        const label = uploaded.name || uploaded.path.split('/').pop()
        const path = uploaded.path
        insertcontentintoactivenote({
          type: 'link',
          url: path,
          label,
          text: `[${label}](${path})`
        })
      }
    } catch (err) {
      if (err?.name === 'AbortError') break
      console.error('note upload failed', err)
      alert(`could not upload "${file.name}"`)
    }
  }
  try { await loadnotes() } catch {}
}

async function handlechatdrop(files) {
  const { handlefileupload } = await import('../chat/assistant.js')
  ensureaidraweropen()
  await handlefileupload(files)
}

function ondragenter(e) {
  if (!isosfiledrag(e)) return
  dragdepth += 1
  e.preventDefault()
  setdragging(true)
}

function ondragleave(e) {
  if (!document.body.classList.contains('is-dragging-os-file')) return
  dragdepth = Math.max(0, dragdepth - 1)
  if (dragdepth === 0) setdragging(false)
}

function movenotecarettomouse(clientx, clienty) {
  if (ismarkdownfile(state.activenoteid) && ed.tiptapinstance?.view) {
    const view = ed.tiptapinstance.view
    const info = view.posAtCoords({ left: clientx, top: clienty })
    if (!info || typeof info.pos !== 'number') return
    if (view.state.selection.from === info.pos && view.state.selection.empty) return
    try {
      ed.tiptapinstance.commands.setTextSelection(info.pos)
    } catch {}
    return
  }
  if (ed.cmview) {
    const view = ed.cmview
    const info = view.posAtCoords({ x: clientx, y: clienty })
    if (typeof info?.pos !== 'number') return
    if (view.state.selection.main.head === info.pos) return
    view.dispatch({
      selection: { anchor: info.pos },
      userEvent: 'select.pointer'
    })
  }
}

function ondragover(e) {
  if (!isosfiledrag(e)) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
  setdragging(true)
  const zone = zoneforelement(e.target)
  setactivezone(zone, e.target)
  if (zone === 'note') movenotecarettomouse(e.clientX, e.clientY)
}

async function ondrop(e) {
  if (!isosfiledrag(e)) return
  e.preventDefault()
  e.stopPropagation()
  // clone immediately -- dataTransfer.files goes empty after the event yields --------------------
  const files = Array.from(e.dataTransfer?.files || [])
  const zone = zoneforelement(e.target) || activezone
  const x = e.clientX
  const y = e.clientY
  // final caret sync then insert at selection --------------------
  if (zone === 'note') movenotecarettomouse(x, y)
  dragdepth = 0
  setdragging(false)
  clearalldraghighlights()
  if (!files.length || !zone) return

  if (zone === 'files') {
    await handlefilesdrop(files, resolvefilesfolder(x, y))
    return
  }
  if (zone === 'note') {
    await handlenotedrop(files)
    return
  }
  if (zone === 'chat') {
    await handlechatdrop(files)
  }
}

export function initosfiledrop() {
  window.addEventListener('dragenter', ondragenter, true)
  window.addEventListener('dragleave', ondragleave, true)
  window.addEventListener('dragover', ondragover, true)
  window.addEventListener('drop', ondrop, true)
  window.addEventListener('dragend', () => {
    dragdepth = 0
    setdragging(false)
  })
}
