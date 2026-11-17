import { api } from '../core/api.js'
import { state } from '../core/state.js'
import { ismobilemode, currentworkspacepath } from '../core/mobile.js'
import {
  opennote,
  closenote,
  saveworkspacestate,
  loadworkspacestate,
  isnoteidmatch,
  formatdraginsert,
  getdraggeditem,
  getdraggeditems,
  insertdraggeditemsintoactivenote,
  insertcontentintoactivenote
} from '../editor/editor.js'
import { closetab, rendertabs, remaptabhistory, restoretabslothistories } from './tabs.js'
import { ispreviewable, openpreviewtab, getpreviewtargetid, ispreviewtabid, schedulepreviewreload } from './preview.js'
import { opendeletednotehistory } from '../editor/history/history-viewer.js'
import { uploadcompressedimage } from '../editor/media/imageupload.js'
import { refreshlinkicons } from '../editor/rich/linkicons.js'

function isvalidopentab(tabid, allnotes) {
  if (ispreviewtabid(tabid)) {
    const target = getpreviewtargetid(tabid)
    if (!target || !ispreviewable(target)) return false
    return allnotes.some(n => isnoteidmatch(n.note_id, target))
  }
  return allnotes.some(n => isnoteidmatch(n.note_id, tabid))
}

// dom elements for file navigation --------------------
const folderbreadcrumb = document.getElementById('folder-breadcrumb')
const folderpathinput = document.getElementById('folder-path-input')
const btnfolderup = document.getElementById('btn-folder-up')
const folderkindicon = document.getElementById('folder-kind-icon')
const folderitems = document.getElementById('folder-items')
const btnfolderhome = document.getElementById('btn-folder-home')
const btnfoldermedia = document.getElementById('btn-folder-media')
const vaulthomepath = '/vault'
const filecontextmenu = document.getElementById('file-context-menu')
const ctxitemopentab = document.getElementById('ctx-item-open-tab')
const ctxitemviewpage = document.getElementById('ctx-item-view-page')
const ctxitemnew = document.getElementById('ctx-item-new')
const ctxitemnewfolder = document.getElementById('ctx-item-new-folder')
const ctxitemupload = document.getElementById('ctx-item-upload')
const ctxitemcut = document.getElementById('ctx-item-cut')
const ctxitemcopy = document.getElementById('ctx-item-copy')
const ctxitempaste = document.getElementById('ctx-item-paste')
const ctxitemrename = document.getElementById('ctx-item-rename')
const ctxitemdelete = document.getElementById('ctx-item-delete')
const ctxitemdeletefolder = document.getElementById('ctx-item-delete-folder')
const ctxitemsystem = document.getElementById('ctx-item-system')
const ctxitemdeleted = document.getElementById('ctx-item-deleted')
const ctxdirsdivider = document.getElementById('ctx-dirs-divider')
const deletedtrackerid = ':deleted'

let contexttargetnoteid = null
let contexttargetfolder = null
let clipboard = null
let hasinitializednotes = false
let roweditpending = null
let roweditsubmitting = false
// ctrl or cmd click multi select for bulk cut copy delete --------------------
const selecteditems = new Map()

function clearfileselection() {
  if (!selecteditems.size) return
  selecteditems.clear()
  updateselectionrows()
}

function updateselectionrows() {
  if (!folderitems) return
  for (const row of folderitems.querySelectorAll('.folder-row')) {
    const path = row.dataset.noteId || row.dataset.folderPath || ''
    row.classList.toggle('is-selected', Boolean(path && selecteditems.has(path)))
  }
}

function toggleselection(path, type) {
  if (!path) return
  if (selecteditems.has(path)) selecteditems.delete(path)
  else selecteditems.set(path, type)
  updateselectionrows()
}

function ensureitemselected(path, type) {
  if (!path) return
  if (selecteditems.has(path)) return
  selecteditems.clear()
  selecteditems.set(path, type)
  updateselectionrows()
}

// targets for cut copy delete from context menu or current selection --------------------
function getoperationtargets() {
  const singlepath = contexttargetnoteid || (
    contexttargetfolder !== null && contexttargetfolder !== state.currentfolder
      ? contexttargetfolder
      : null
  )
  const singletype = contexttargetnoteid ? 'file' : 'folder'
  if (singlepath && selecteditems.has(singlepath) && selecteditems.size > 0) {
    return [...selecteditems.entries()].map(([path, type]) => ({ path, type }))
  }
  if (singlepath) return [{ path: singlepath, type: singletype }]
  return []
}

function ismultiselectionop(targets) {
  return targets.length > 1
}

// clear all drag target visual indicators --------------------
export function clearalldraghighlights() {
  document.querySelectorAll('.drag-over, .is-drag-source').forEach(el => {
    el.classList.remove('drag-over', 'is-drag-source')
  })
}

// the tracker is not a real folder so anything created from it lands in the vault root --------------------
function workingfolder() {
  return state.currentfolder === deletedtrackerid ? '' : state.currentfolder
}

// point tabs and the open note at the new path after a move or rename --------------------
function remapmovedpath(oldpath, newpath, isfolder) {
  const remap = (id) => {
    if (!id) return id
    if (!isfolder) return id === oldpath ? newpath : id
    return id.startsWith(`${oldpath}/`) ? `${newpath}/${id.slice(oldpath.length + 1)}` : id
  }
  const nexttabs = state.opentabs.map(remap)
  const tabschanged = nexttabs.some((id, i) => id !== state.opentabs[i])
  state.opentabs = nexttabs
  state.activenoteid = remap(state.activenoteid)
  if (isfolder) state.currentfolder = state.currentfolder === oldpath ? newpath : remap(state.currentfolder)
  if (clipboard?.items?.length) {
    for (const item of clipboard.items) {
      if (item.path === oldpath) item.path = newpath
      else if (isfolder && item.path.startsWith(`${oldpath}/`)) {
        item.path = `${newpath}/${item.path.slice(oldpath.length + 1)}`
      }
    }
  }
  if (selecteditems.has(oldpath)) {
    const type = selecteditems.get(oldpath)
    selecteditems.delete(oldpath)
    selecteditems.set(newpath, type)
  }
  remaptabhistory(oldpath, newpath)
  if (tabschanged) {
    rendertabs()
    saveworkspacestate()
  }
}

function canmovepathintofolder(srcpath, isfile, targetdestfolder) {
  if (!srcpath) return false
  const basename = srcpath.split('/').pop()
  const destpath = targetdestfolder ? `${targetdestfolder}/${basename}` : basename
  if (srcpath === destpath) return false
  if (!isfile && (targetdestfolder === srcpath || String(targetdestfolder || '').startsWith(`${srcpath}/`))) {
    return false
  }
  return true
}

// move a file or folder into a target folder --------------------
export async function moveitemtofolder(srcpath, isfile, targetdestfolder, { reload = true } = {}) {
  if (!canmovepathintofolder(srcpath, isfile, targetdestfolder)) return

  const basename = srcpath.split('/').pop()
  const destpath = targetdestfolder ? `${targetdestfolder}/${basename}` : basename

  try {
    const res = await api('/api/note/rename', {
      method: 'POST',
      body: JSON.stringify({ old_id: srcpath, new_id: destpath })
    })
    remapmovedpath(srcpath, res?.destination || destpath, !isfile)
    if (reload) await loadnotes()
  } catch (err) {
    alert(`move failed: ${err.message}`)
  }
}

export async function moveitemstofolder(items, targetdestfolder) {
  const list = (items || []).filter((i) => i?.path)
  if (!list.length) return
  for (const item of list) {
    await moveitemtofolder(item.path, item.type === 'file', targetdestfolder, { reload: false })
  }
  clearfileselection()
  await loadnotes()
}

function builddragitemfrompath(path, type) {
  const name = path.split('/').pop() || path
  if (type === 'folder') {
    return { type: 'folder', path, name, title: name }
  }
  const note = (state.allnotes || []).find((n) => isnoteidmatch(n.note_id, path))
  return {
    type: 'file',
    path,
    name,
    title: note?.title || name,
    isimage: /\.(png|jpg|jpeg|gif|webp|svg|ico|bmp)$/i.test(name),
    ismarkdown: name.endsWith('.md') || name.endsWith('.markdown')
  }
}

// if the dragged row is selected, drag the whole multi selection --------------------
function builddragpayload(primary) {
  let items = [primary]
  if (selecteditems.has(primary.path) && selecteditems.size > 1) {
    items = [...selecteditems.entries()].map(([path, type]) => builddragitemfrompath(path, type))
    items.sort((a, b) => (a.path === primary.path ? -1 : b.path === primary.path ? 1 : 0))
  } else if (!selecteditems.has(primary.path)) {
    clearfileselection()
  }
  return {
    ...primary,
    items
  }
}

function markdragsources(items) {
  for (const item of items || []) {
    const row = item.type === 'folder' ? findfolderrow(item.path) : findfilerow(item.path)
    row?.classList.add('is-drag-source')
  }
}

// shared drop target for breadcrumbs and shortcut buttons --------------------
function bindfolderdroptarget(el, getdestfolder) {
  if (!el) return
  el.addEventListener('dragover', (e) => {
    const items = getdraggeditems(e)
    if (!items.length) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    el.classList.add('drag-over')
  })
  el.addEventListener('dragleave', (e) => {
    if (e.relatedTarget && el.contains(e.relatedTarget)) return
    el.classList.remove('drag-over')
  })
  el.addEventListener('drop', async (e) => {
    clearalldraghighlights()
    const items = getdraggeditems(e)
    if (!items.length) return
    e.preventDefault()
    e.stopPropagation()
    const dest = typeof getdestfolder === 'function' ? getdestfolder() : getdestfolder
    await moveitemstofolder(items, dest || '')
  })
}

// resolve file icon based on extension --------------------
export function getfileicon(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase()
  if (ext === 'md' || ext === 'txt') {
    return '/resources/icons/files/text.png'
  }
  if (ext === 'yaml' || ext === 'yml' || ext === 'json' || ext === 'js' || ext === 'ts' || ext === 'css' || ext === 'py' || ext === 'php') {
    return '/resources/icons/files/code.png'
  }
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif' || ext === 'svg' || ext === 'webp') {
    return '/resources/icons/files/image.png'
  }
  if (ext === 'mp3' || ext === 'm4a' || ext === 'wav' || ext === 'ogg' || ext === 'aac' || ext === 'flac') {
    return '/resources/icons/files/audio.png'
  }
  if (ext === 'mp4' || ext === 'webm' || ext === 'mov' || ext === 'mkv' || ext === 'avi') {
    return '/resources/icons/files/video.png'
  }
  if (ext === 'pdf') {
    return '/resources/icons/files/pdf.png'
  }
  if (ext === 'zip' || ext === 'jar' || ext === 'tar' || ext === 'gz' || ext === '7z' || ext === 'rar') {
    return '/resources/icons/files/archive.png'
  }
  if (ext === 'html' || ext === 'htm') {
    return '/resources/icons/files/webpage.png'
  }
  return '/resources/icons/files/binary.png'
}

// upload files from picker into target folder in vault --------------------
export function uploadfiletofolder(targetfolder = null) {
  const folder = targetfolder !== null ? targetfolder : workingfolder()
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.style.display = 'none'

  input.addEventListener('change', async () => {
    const files = Array.from(input.files || [])
    input.remove()
    if (!files.length) return

    const { uploadfiletovault } = await import('./upload.js')
    for (const file of files) {
      try {
        await uploadfiletovault(file, folder)
      } catch (err) {
        if (err?.name === 'AbortError') break
        console.error('upload failed for file', file.name, err)
      }
    }

    try {
      await loadnotes()
    } catch {}
  })

  document.body.appendChild(input)
  input.click()
}

// extract immediate children of current folder --------------------
export function getfoldercontents(folderpath) {
  const prefix = folderpath
    ? (folderpath.endsWith('/') ? folderpath : `${folderpath}/`)
    : ''

  const subfolders = new Set()
  const files = []

  const insystem = folderpath === 'system' || folderpath.startsWith('system/')
  const inmedia = folderpath === 'media' || folderpath.startsWith('media/')

  // populate subfolders from known folders even if they have no notes --------------------
  for (const folder of (state.allfolders || [])) {
    // hide system notes unless currently browsing inside system --------------------
    if (!insystem && (folder === 'system' || folder.startsWith('system/'))) {
      continue
    }

    // hide media folder contents unless currently browsing inside media --------------------
    if (!inmedia && (folder === 'media' || folder.startsWith('media/'))) {
      continue
    }

    if (prefix && !folder.startsWith(prefix)) {
      continue
    }

    const remainder = folder.slice(prefix.length)
    const parts = remainder.split('/').filter(Boolean)

    if (parts.length > 0) {
      // never show system or media in root folder listing --------------------
      if (!prefix && (parts[0] === 'system' || parts[0] === 'media')) {
        continue
      }
      subfolders.add(parts[0])
    }
  }

  for (const note of state.allnotes) {
    // hide system notes unless currently browsing inside system --------------------
    if (!insystem && note.note_id.startsWith('system/')) {
      continue
    }

    // hide media folder contents unless currently browsing inside media --------------------
    if (!inmedia && note.note_id.startsWith('media/')) {
      continue
    }

    if (prefix && !note.note_id.startsWith(prefix)) {
      continue
    }

    const remainder = note.note_id.slice(prefix.length)
    const parts = remainder.split('/')

    if (parts.length > 1) {
      // never show system or media in root folder listing --------------------
      if (!prefix && (parts[0] === 'system' || parts[0] === 'media')) {
        continue
      }
      subfolders.add(parts[0])
    } else if (parts.length === 1 && parts[0]) {
      files.push({
        id: note.note_id,
        name: parts[0],
        title: note.title
      })
    }
  }

  return {
    folders: Array.from(subfolders).sort(),
    files: files.sort((a, b) => a.name.localeCompare(b.name))
  }
}

// show paths as /vault/... even though the vault root is stored as '' --------------------
function foldertodisplaypath(folder) {
  if (folder === deletedtrackerid) return `${vaulthomepath}/:deleted`
  if (!folder) return vaulthomepath
  return `${vaulthomepath}/${folder}`
}

function displaypathtofolder(raw) {
  let p = String(raw || '').trim().replace(/\\/g, '/')
  if (!p || p === '/') return ''
  if (!p.startsWith('/')) p = `/${p}`
  p = p.replace(/\/{2,}/g, '/')
  if (p.length > 1) p = p.replace(/\/+$/, '')
  if (p === '/' || p === vaulthomepath) return ''
  if (p === `${vaulthomepath}/:deleted` || p === '/:deleted') return deletedtrackerid
  if (p.startsWith(`${vaulthomepath}/`)) return p.slice(vaulthomepath.length + 1)
  return p.replace(/^\//, '')
}

function syncfolderpathinput() {
  if (!folderpathinput) return
  if (document.activeElement === folderpathinput) return
  folderpathinput.value = foldertodisplaypath(state.currentfolder || '')
}

function parentfolderof(folder) {
  if (!folder || folder === deletedtrackerid) return ''
  return folder.split('/').slice(0, -1).join('/')
}

function syncfolderupbutton() {
  if (!btnfolderup) return
  const folder = state.currentfolder || ''
  const show = Boolean(folder)
  btnfolderup.classList.toggle('hidden', !show)
  btnfolderup.title = folder === deletedtrackerid ? 'back to vault' : 'go to parent folder'
}

function syncfolderkindicon() {
  if (!folderkindicon) return
  const folder = state.currentfolder || ''
  const issystem = folder === 'system' || folder.startsWith('system/')
  folderkindicon.src = issystem
    ? '/resources/icons/general/system-folder.png'
    : '/resources/icons/files/folder.png'
  folderkindicon.alt = issystem ? 'system folder' : 'folder'
}

function commitfolderpathinput() {
  if (!folderpathinput) return
  let raw = folderpathinput.value
  if (raw.trim() === '/') raw = vaulthomepath
  const next = displaypathtofolder(raw)
  folderpathinput.value = foldertodisplaypath(next)
  if (next !== (state.currentfolder || '')) navigatefolder(next)
  else syncfolderupbutton()
}

// navigate into a specific folder --------------------
export function navigatefolder(targetfolder) {
  clearrowedit(false)
  clearfileselection()
  state.currentfolder = targetfolder
  renderfolderview()
  saveworkspacestate()
}

// deleted history tracker lives at a fake folder path --------------------
function timeago(ts) {
  if (!ts) return 'unknown time'
  const mins = Math.round((Date.now() - ts) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(ts).toLocaleDateString()
}

function builddeletedrow(note) {
  const row = document.createElement('div')
  row.className = 'folder-row is-file is-deleted'
  row.dataset.noteId = note.note_id
  if (isnoteidmatch(note.note_id, state.activenoteid)) row.classList.add('active')

  const icon = document.createElement('img')
  icon.className = 'row-icon-img'
  icon.src = getfileicon(note.note_id)
  icon.alt = 'deleted file'

  const text = document.createElement('div')
  text.className = 'deleted-row-text'
  const name = document.createElement('span')
  name.className = 'row-name'
  name.textContent = note.note_id
  name.title = note.note_id
  const meta = document.createElement('span')
  meta.className = 'deleted-row-meta'
  const who = note.deleted_by ? ` by ${note.deleted_by}` : ''
  const when = note.deleted_at ? `deleted ${timeago(note.deleted_at)}${who}` : `last seen ${timeago(note.last_edit)}`
  const saves = `${note.revision_count} ${note.revision_count === 1 ? 'save' : 'saves'}`
  meta.textContent = `${when} \u00b7 ${saves}`
  text.append(name, meta)

  row.append(icon, text)
  row.addEventListener('click', () => opendeletednotehistory(note.note_id))
  return row
}

async function renderdeletedview() {
  syncfolderpathinput()
  syncfolderupbutton()
  syncfolderkindicon()
  folderitems.innerHTML = ''
  let notes = []
  try {
    const data = await api('/api/history/deleted')
    notes = data.notes || []
  } catch (err) {
    console.error('failed to load deleted notes', err)
  }
  if (state.currentfolder !== deletedtrackerid) return

  folderitems.innerHTML = ''
  if (notes.length === 0) {
    const emptymsg = document.createElement('div')
    emptymsg.className = 'folder-empty'
    emptymsg.textContent = 'nothing deleted yet'
    folderitems.appendChild(emptymsg)
    return
  }
  for (const note of notes) folderitems.appendChild(builddeletedrow(note))
}

// render path bar and directory contents --------------------
export function renderfolderview() {
  if (!folderbreadcrumb || !folderitems) return
  if (state.currentfolder === deletedtrackerid) {
    clearrowedit(false)
    renderdeletedview()
    return
  }

  // drop any in-progress create or rename row before rebuild --------------------
  clearrowedit(false)
  syncfolderpathinput()
  syncfolderupbutton()
  syncfolderkindicon()

  // render folder contents --------------------
  folderitems.innerHTML = ''
  const { folders, files } = getfoldercontents(state.currentfolder)

  if (folders.length === 0 && files.length === 0) {
    const emptymsg = document.createElement('div')
    emptymsg.className = 'folder-empty'
    emptymsg.textContent = 'this folder is empty'
    folderitems.appendChild(emptymsg)
    return
  }

  // render subfolders --------------------
  for (const foldername of folders) {
    const fullfolderpath = state.currentfolder
      ? `${state.currentfolder}/${foldername}`
      : foldername

    const row = document.createElement('div')
    row.className = 'folder-row is-folder'
    row.dataset.folderPath = fullfolderpath
    if (clipboard?.action === 'cut' && clipboard.items?.some((i) => i.path === fullfolderpath)) {
      row.classList.add('is-cut')
    }
    if (selecteditems.has(fullfolderpath)) row.classList.add('is-selected')
    row.innerHTML = `
      <img class="row-icon-img" src="/resources/icons/files/folder.png" alt="folder">
      <span class="row-name">${foldername}</span>
      <button type="button" class="row-more-btn" title="more" aria-label="more folder actions">\u22ef</button>
      <span class="row-arrow">></span>
    `
    bindrowmorebtn(row.querySelector('.row-more-btn'), null, fullfolderpath)
    row.addEventListener('click', (e) => {
      if (e.target.closest('.row-more-btn')) return
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        e.stopPropagation()
        toggleselection(fullfolderpath, 'folder')
        return
      }
      clearfileselection()
      navigatefolder(fullfolderpath)
    })

    // right click on folder row --------------------
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (!selecteditems.has(fullfolderpath)) ensureitemselected(fullfolderpath, 'folder')
      opencontextmenu(e.clientX, e.clientY, null, fullfolderpath)
    })

    // drag and drop folder row --------------------
    row.draggable = true
    row.addEventListener('dragstart', (e) => {
      const payload = builddragpayload({
        type: 'folder',
        path: fullfolderpath,
        name: foldername,
        title: foldername
      })
      state.activefiledrag = payload
      e.dataTransfer.setData('text/plain', payload.items.map((i) => i.path).join('\n'))
      e.dataTransfer.setData('application/mushnote-item', JSON.stringify(payload))
      e.dataTransfer.effectAllowed = 'copyMove'
      markdragsources(payload.items)
    })
    row.addEventListener('dragend', () => {
      state.activefiledrag = null
      clearalldraghighlights()
    })

    // accept drops to move files or folders into this folder --------------------
    row.addEventListener('dragover', (e) => {
      const items = getdraggeditems(e)
      if (!items.length) return
      if (items.some((item) => !canmovepathintofolder(item.path, item.type === 'file', fullfolderpath))) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      row.classList.add('drag-over')
    })
    row.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && row.contains(e.relatedTarget)) return
      row.classList.remove('drag-over')
    })
    row.addEventListener('drop', async (e) => {
      clearalldraghighlights()
      const items = getdraggeditems(e)
      if (!items.length) return
      if (items.some((item) => !canmovepathintofolder(item.path, item.type === 'file', fullfolderpath))) return
      e.preventDefault()
      e.stopPropagation()
      await moveitemstofolder(items, fullfolderpath)
    })

    folderitems.appendChild(row)
  }

  // render files --------------------
  for (const file of files) {
    const row = document.createElement('div')
    row.className = 'folder-row is-file'
    row.dataset.noteId = file.id

    if (clipboard?.action === 'cut' && clipboard.items?.some((i) => isnoteidmatch(file.id, i.path))) {
      row.classList.add('is-cut')
    }
    if (selecteditems.has(file.id)) row.classList.add('is-selected')

    if (isnoteidmatch(file.id, state.activenoteid)) {
      row.classList.add('active')
    }

    const iconpath = getfileicon(file.name)

    row.innerHTML = `
      <img class="row-icon-img" src="${iconpath}" alt="file">
      <span class="row-name">${file.name}</span>
      <button type="button" class="row-more-btn" title="more" aria-label="more file actions">\u22ef</button>
    `
    bindrowmorebtn(row.querySelector('.row-more-btn'), file.id, null)
    // click opens or switches tab never closes from the file list --------------------
    row.addEventListener('click', (e) => {
      if (e.target.closest('.row-more-btn')) return
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        e.stopPropagation()
        toggleselection(file.id, 'file')
        return
      }
      clearfileselection()
      if (isnoteidmatch(state.activenoteid, file.id)) return
      opennote(file.id, { replacecurrent: true })
    })

    // right click on file row --------------------
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (!selecteditems.has(file.id)) ensureitemselected(file.id, 'file')
      opencontextmenu(e.clientX, e.clientY, file.id)
    })

    // drag and drop file row --------------------
    row.draggable = true
    row.addEventListener('dragstart', (e) => {
      const payload = builddragpayload({
        type: 'file',
        path: file.id,
        name: file.name,
        title: file.title || file.name,
        isimage: /\.(png|jpg|jpeg|gif|webp|svg|ico|bmp)$/i.test(file.name),
        ismarkdown: file.name.endsWith('.md') || file.name.endsWith('.markdown')
      })
      state.activefiledrag = payload
      e.dataTransfer.setData('text/plain', payload.items.map((i) => i.path).join('\n'))
      e.dataTransfer.setData('application/mushnote-item', JSON.stringify(payload))
      e.dataTransfer.effectAllowed = 'copyMove'
      markdragsources(payload.items)
    })
    row.addEventListener('dragend', () => {
      state.activefiledrag = null
      clearalldraghighlights()
    })

    // accept drops to insert link or embedded image into this file --------------------
    row.addEventListener('dragover', (e) => {
      const items = getdraggeditems(e)
      if (!items.length || items.some((item) => item.path === file.id)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      row.classList.add('drag-over')
    })
    row.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && row.contains(e.relatedTarget)) return
      row.classList.remove('drag-over')
    })
    row.addEventListener('drop', async (e) => {
      clearalldraghighlights()
      const items = getdraggeditems(e)
      if (!items.length || items.some((item) => item.path === file.id)) return
      e.preventDefault()
      e.stopPropagation()

      await opennote(file.id, { replacecurrent: false })
      insertdraggeditemsintoactivenote(items)
    })

    folderitems.appendChild(row)
  }

  if (!state.currentfolder && !ismobilemode()) {
    const hint = document.createElement('div')
    hint.className = 'folder-hint'
    hint.textContent = '(right click for more)'
    folderitems.appendChild(hint)
  }
}

// update active highlight on visible file rows without changing folder --------------------
export function updateactivefilerow() {
  if (!folderitems) return
  const rows = folderitems.querySelectorAll('.folder-row.is-file')
  for (const row of rows) {
    if (isnoteidmatch(row.dataset.noteId, state.activenoteid)) {
      row.classList.add('active')
    } else {
      row.classList.remove('active')
    }
  }
}

// update cut state transparency on visible file and folder rows --------------------
export function updatecutrows() {
  if (!folderitems) return
  const cutpaths = clipboard?.action === 'cut'
    ? (clipboard.items || []).map((i) => i.path)
    : []
  const rows = folderitems.querySelectorAll('.folder-row')
  for (const row of rows) {
    const noteid = row.dataset.noteId
    const folderpath = row.dataset.folderPath || ''
    let iscut = false
    if (cutpaths.length) {
      if (folderpath && cutpaths.includes(folderpath)) iscut = true
      else if (noteid && cutpaths.some((p) => isnoteidmatch(noteid, p))) iscut = true
    }
    row.classList.toggle('is-cut', iscut)
  }
}

function clearrowedit(restorerow = true) {
  const pending = roweditpending
  roweditpending = null
  roweditsubmitting = false
  if (!pending) return
  if (!restorerow) return
  if (pending.mode === 'note' || pending.mode === 'folder') {
    pending.row?.remove()
    if (folderitems && folderitems.children.length === 0) {
      const emptymsg = document.createElement('div')
      emptymsg.className = 'folder-empty'
      emptymsg.textContent = 'this folder is empty'
      folderitems.appendChild(emptymsg)
    }
    return
  }
  if (pending.row && pending.namelabel) {
    pending.input?.replaceWith(pending.namelabel)
    pending.row.classList.remove('is-editing')
    pending.row.draggable = pending.wasdraggable
  }
}

function bindroweditinput(input) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      submitrowedit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      clearrowedit(true)
    }
  })
  input.addEventListener('click', (e) => e.stopPropagation())
  input.addEventListener('mousedown', (e) => e.stopPropagation())
}

function makeroweditinput(value, placeholder) {
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'row-name-input'
  input.value = value
  input.placeholder = placeholder
  input.autocomplete = 'off'
  input.spellcheck = false
  bindroweditinput(input)
  return input
}

function findfolderrow(folderpath) {
  if (!folderitems) return null
  return folderitems.querySelector(`.folder-row.is-folder[data-folder-path="${CSS.escape(folderpath)}"]`)
}

function findfilerow(noteid) {
  if (!folderitems) return null
  for (const row of folderitems.querySelectorAll('.folder-row.is-file')) {
    if (isnoteidmatch(row.dataset.noteId, noteid)) return row
  }
  return null
}

function startrowrename() {
  const oldpath = contexttargetnoteid || contexttargetfolder
  const isfolder = !contexttargetnoteid && Boolean(contexttargetfolder)
  if (!oldpath) return
  closecontextmenu()
  clearrowedit(false)

  const row = isfolder ? findfolderrow(oldpath) : findfilerow(oldpath)
  if (!row) return
  const namelabel = row.querySelector('.row-name')
  if (!namelabel) return

  const currentname = oldpath.split('/').pop()
  const input = makeroweditinput(currentname, isfolder ? 'folder name' : 'filename')
  const wasdraggable = row.draggable
  row.draggable = false
  row.classList.add('is-editing')
  namelabel.replaceWith(input)

  roweditpending = {
    mode: 'rename',
    oldpath,
    isfolder,
    targetfolder: workingfolder(),
    row,
    input,
    namelabel,
    wasdraggable,
  }

  requestAnimationFrame(() => {
    input.focus()
    input.select()
  })
}

function startrowcreate(mode) {
  let targetfolder = contexttargetfolder || workingfolder()
  if (targetfolder === deletedtrackerid) targetfolder = ''
  closecontextmenu()
  clearrowedit(false)

  // for files: navigate into the target folder so the input row appears there
  // for folders: stay in current view, the new folder will appear after submit
  if (state.currentfolder !== targetfolder && mode !== 'folder') {
    navigatefolder(targetfolder)
  }

  if (!folderitems) return
  const empty = folderitems.querySelector('.folder-empty')
  if (empty) empty.remove()

  const row = document.createElement('div')
  row.className = `folder-row is-editing ${mode === 'folder' ? 'is-folder' : 'is-file'}`
  const icon = document.createElement('img')
  icon.className = 'row-icon-img'
  icon.src = mode === 'folder'
    ? '/resources/icons/files/folder.png'
    : '/resources/icons/files/text.png'
  icon.alt = mode
  const input = makeroweditinput('', mode === 'folder' ? 'folder name' : 'filename')
  row.append(icon, input)

  if (mode === 'folder') {
    const firstfile = folderitems.querySelector('.folder-row.is-file')
    if (firstfile) folderitems.insertBefore(row, firstfile)
    else folderitems.appendChild(row)
  } else {
    folderitems.appendChild(row)
  }

  roweditpending = {
    mode,
    targetfolder,
    oldpath: null,
    isfolder: mode === 'folder',
    row,
    input,
  }

  requestAnimationFrame(() => input.focus())
}

async function submitrowedit() {
  if (!roweditpending || roweditsubmitting) return
  const pending = roweditpending
  const raw = (pending.input?.value || '').trim()
  if (!raw) {
    clearrowedit(true)
    return
  }

  roweditsubmitting = true
  try {
    if (pending.mode === 'note') {
      let noteid = raw.includes('/') ? raw : (pending.targetfolder ? `${pending.targetfolder}/${raw}` : raw)
      if (!noteid.includes('.')) noteid = `${noteid}.md`
      const res = await api('/api/notes', {
        method: 'POST',
        body: JSON.stringify({
          note_id: noteid,
          content: '',
          author: state.currentuser ? state.currentuser.id : 'unknown',
          create_unique: true,
        }),
      })
      const createdid = res?.note_id || noteid
      roweditpending = null
      roweditsubmitting = false
      await loadnotes()
      await opennote(createdid, { newtab: true, force: true })
      return
    }

    if (pending.mode === 'folder') {
      const cleanfoldername = raw.replace(/[^a-zA-Z0-9_\-]/g, '_')
      if (!cleanfoldername) {
        clearrowedit(true)
        return
      }
      const targetpath = pending.targetfolder
        ? `${pending.targetfolder}/${cleanfoldername}`
        : cleanfoldername
      await api('/api/folder', {
        method: 'POST',
        body: JSON.stringify({ folder_path: targetpath }),
      })
      roweditpending = null
      roweditsubmitting = false
      await loadnotes()
      return
    }

    if (pending.mode === 'rename') {
      const currentname = pending.oldpath.split('/').pop()
      if (raw === currentname) {
        clearrowedit(true)
        return
      }
      let cleanednewname = raw
      if (!pending.isfolder && !/\.[a-zA-Z0-9]+$/.test(cleanednewname)) {
        cleanednewname = `${cleanednewname}.md`
      }
      const parentpath = pending.oldpath.includes('/')
        ? pending.oldpath.split('/').slice(0, -1).join('/')
        : ''
      const newid = parentpath ? `${parentpath}/${cleanednewname}` : cleanednewname
      const res = await api('/api/note/rename', {
        method: 'POST',
        body: JSON.stringify({ old_id: pending.oldpath, new_id: newid }),
      })
      remapmovedpath(pending.oldpath, res?.destination || newid, pending.isfolder)
      roweditpending = null
      roweditsubmitting = false
      await loadnotes()
    }
  } catch (err) {
    alert(`${pending.mode} failed: ${err.message}`)
    roweditsubmitting = false
    pending.input?.focus()
  }
}

// open menu anchored under a button (mobile has no right click) --------------------
export function opencontextmenunear(el, noteid = null, folderpath = null) {
  if (!el?.getBoundingClientRect) {
    opencontextmenu(16, 72, noteid, folderpath)
    return
  }
  const rect = el.getBoundingClientRect()
  const pad = 8
  const mw = 200
  const mh = 320
  let x = rect.left
  let y = rect.bottom + 4
  if (x + mw > window.innerWidth - pad) x = Math.max(pad, window.innerWidth - mw - pad)
  if (y + mh > window.innerHeight - pad) y = Math.max(pad, rect.top - 4)
  opencontextmenu(x, y, noteid, folderpath)
}

function bindrowmorebtn(btn, noteid = null, folderpath = null) {
  if (!btn) return
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
  })
  btn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (noteid) {
      if (!selecteditems.has(noteid)) ensureitemselected(noteid, 'file')
    } else if (folderpath && folderpath !== state.currentfolder) {
      if (!selecteditems.has(folderpath)) ensureitemselected(folderpath, 'folder')
    } else {
      clearfileselection()
    }
    opencontextmenunear(btn, noteid, folderpath)
  })
}

// open custom context menu --------------------
export function opencontextmenu(x, y, noteid = null, folderpath = null) {
  contexttargetnoteid = noteid
  contexttargetfolder = folderpath !== null ? folderpath : state.currentfolder
  if (contexttargetfolder === deletedtrackerid) contexttargetfolder = ''

  const isfile = Boolean(noteid)
  const isfolderrow = !isfile && folderpath !== null && folderpath !== state.currentfolder
  const optargets = getoperationtargets()
  const ismulti = ismultiselectionop(optargets)
  const hasfiletargets = optargets.some((t) => t.type === 'file')
  const hasfoldertargets = optargets.some((t) => t.type === 'folder')

  // manage visibility of context items --------------------
  const alreadyopen = isfile && state.opentabs.some((t) => isnoteidmatch(t, noteid))
  const isactive = isfile && isnoteidmatch(state.activenoteid, noteid)
  if (ctxitemopentab) {
    // hide only when that note is already the active tab --------------------
    ctxitemopentab.classList.toggle('hidden', ismulti || !isfile || isactive)
    if (isfile && !isactive && !ismulti) {
      ctxitemopentab.innerHTML = alreadyopen
        ? '<img class="btn-icon-img" src="/resources/icons/general/open-tab.png" alt="show"> show tab'
        : '<img class="btn-icon-img" src="/resources/icons/general/open-tab.png" alt="tab"> open in new tab'
    }
  }
  if (ctxitemviewpage) ctxitemviewpage.classList.toggle('hidden', ismulti || !isfile || !ispreviewable(noteid))
  if (ctxitemrename) ctxitemrename.classList.toggle('hidden', ismulti || (!isfile && !isfolderrow))
  if (ctxitemdelete) {
    const showdelete = ismulti ? hasfiletargets || hasfoldertargets : isfile
    ctxitemdelete.classList.toggle('hidden', !showdelete)
    if (showdelete) {
      const label = ismulti ? `delete ${optargets.length} items...` : 'delete...'
      ctxitemdelete.innerHTML = `<img class="btn-icon-img" src="/resources/icons/general/delete.png" alt="delete"> ${label}`
    }
  }
  if (ctxitemdeletefolder) {
    ctxitemdeletefolder.classList.toggle('hidden', ismulti || !isfolderrow)
  }

  if (ctxitemcut) {
    ctxitemcut.classList.toggle('hidden', !isfile && !isfolderrow && !ismulti)
    if (isfile || isfolderrow || ismulti) {
      const label = ismulti ? `cut ${optargets.length} items` : 'cut'
      ctxitemcut.innerHTML = `<img class="btn-icon-img" src="/resources/icons/general/cut.png" alt="cut"> ${label}`
    }
  }
  if (ctxitemcopy) {
    ctxitemcopy.classList.toggle('hidden', !isfile && !isfolderrow && !ismulti)
    if (isfile || isfolderrow || ismulti) {
      const label = ismulti ? `copy ${optargets.length} items` : 'copy'
      ctxitemcopy.innerHTML = `<img class="btn-icon-img" src="/resources/icons/general/copy.png" alt="copy"> ${label}`
    }
  }

  if (ctxitemnew) {
    ctxitemnew.classList.toggle('hidden', isfile || ismulti)
    ctxitemnew.innerHTML = `<img class="btn-icon-img" src="/resources/icons/general/new.png" alt="new"> ${isfolderrow ? 'new note in folder...' : 'new note...'}`
  }

  if (ctxitemnewfolder) {
    ctxitemnewfolder.classList.toggle('hidden', isfile || ismulti)
    ctxitemnewfolder.innerHTML = `<img class="btn-icon-img" src="/resources/icons/general/newfolder.png" alt="newfolder"> ${isfolderrow ? 'new subfolder...' : 'new folder...'}`
  }

  if (ctxitemupload) {
    ctxitemupload.classList.toggle('hidden', isfile || ismulti)
    ctxitemupload.innerHTML = `<img class="btn-icon-img" src="/resources/icons/general/upload.png" alt="upload"> ${isfolderrow ? 'upload file to folder...' : 'upload file...'}`
  }

  if (ctxitempaste) {
    const canpaste = !isfile && !ismulti && Boolean(clipboard?.items?.length)
    ctxitempaste.classList.toggle('hidden', !canpaste)
    if (canpaste) {
      const count = clipboard.items.length
      const clipname = clipboard.items[0].path.split('/').pop()
      const label = count > 1 ? `paste ${count} items` : `paste "${clipname}"`
      ctxitempaste.innerHTML = `<img class="btn-icon-img" src="/resources/icons/general/paste.png" alt="paste"> ${label}`
    }
  }

  const showdirs = !isfile && !isfolderrow && !ismulti
  if (ctxitemsystem) ctxitemsystem.classList.toggle('hidden', !showdirs)
  if (ctxitemdeleted) ctxitemdeleted.classList.toggle('hidden', !showdirs)
  if (ctxdirsdivider) ctxdirsdivider.classList.toggle('hidden', !showdirs)

  filecontextmenu.style.left = `${x}px`
  filecontextmenu.style.top = `${y}px`
  filecontextmenu.classList.remove('hidden')
}

// close custom context menu --------------------
export function closecontextmenu() {
  if (filecontextmenu) {
    filecontextmenu.classList.add('hidden')
  }
  contexttargetnoteid = null
}

async function pasteimagesintocurrentfolder(e) {
  const items = e.clipboardData?.items
  if (!items?.length) return false

  const images = []
  for (const item of items) {
    if (item && item.type && item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) images.push(file)
    }
  }
  if (!images.length) return false

  e.preventDefault()
  e.stopPropagation()

  const folder = workingfolder()
  for (const file of images) {
    try {
      await uploadcompressedimage(file, folder)
    } catch (err) {
      console.error('folder image paste failed', err)
    }
  }
  return true
}

// initialize file pane and context menu events --------------------
export function initfiles() {
  document.addEventListener('mousedown', (e) => {
    if (filecontextmenu && !filecontextmenu.classList.contains('hidden') && filecontextmenu.contains(e.target)) {
      return
    }
    if (filecontextmenu && !filecontextmenu.classList.contains('hidden')) {
      closecontextmenu()
    }
    if (roweditpending && !e.target.closest?.('.row-name-input') && !e.target.closest?.('.folder-row.is-editing')) {
      clearrowedit(true)
    }
  })

  // paste images into the open folder (same webp compression as editor paste) --------------------
  const filesview = document.getElementById('sidebar-files-view')
  const foldernavpane = document.getElementById('folder-nav-pane')
  if (foldernavpane && foldernavpane.tabIndex < 0) {
    foldernavpane.tabIndex = -1
  }
  if (filesview) {
    filesview.addEventListener('mousedown', (e) => {
      if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return
      foldernavpane?.focus({ preventScroll: true })
    })
    filesview.addEventListener('paste', (e) => {
      pasteimagesintocurrentfolder(e)
    })
  }

  if (btnfolderhome) {
    btnfolderhome.addEventListener('click', () => navigatefolder(''))
    bindfolderdroptarget(btnfolderhome, '')
  }
  if (btnfoldermedia) {
    btnfoldermedia.addEventListener('click', () => navigatefolder('media'))
    bindfolderdroptarget(btnfoldermedia, 'media')
  }

  // editable /vault path bar --------------------
  if (btnfolderup) {
    btnfolderup.addEventListener('click', () => {
      if (state.currentfolder === deletedtrackerid) navigatefolder('')
      else navigatefolder(parentfolderof(state.currentfolder || ''))
    })
    bindfolderdroptarget(btnfolderup, () => parentfolderof(state.currentfolder || ''))
  }
  if (folderpathinput) {
    syncfolderpathinput()
    folderpathinput.addEventListener('input', () => {
      if (folderpathinput.value.trim() === '/') folderpathinput.value = vaulthomepath
    })
    folderpathinput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        commitfolderpathinput()
        folderpathinput.blur()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        syncfolderpathinput()
        folderpathinput.blur()
      }
    })
    folderpathinput.addEventListener('blur', () => {
      commitfolderpathinput()
    })
    bindfolderdroptarget(folderpathinput, () => workingfolder())
  }
  syncfolderupbutton()

  // cancel cut or multi select on escape --------------------
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    let changed = false
    if (clipboard && clipboard.action === 'cut') {
      clipboard = null
      changed = true
    }
    if (selecteditems.size) {
      selecteditems.clear()
      changed = true
    }
    if (changed) {
      updatecutrows()
      updateselectionrows()
    }
  })

  // refresh file list when external filesystem changes occur --------------------
  window.addEventListener('vault-changed', async (e) => {
    if (e.detail?.action === 'delete' && e.detail?.note_id) {
      closetab(e.detail.note_id)
      closetab(`preview:${e.detail.note_id}`)
    }
    if (e.detail?.action === 'edit' && e.detail?.note_id) {
      schedulepreviewreload(e.detail.note_id)
    }
    if (e.detail?.action === 'move' && e.detail?.old_id && e.detail?.note_id) {
      remapmovedpath(e.detail.old_id, e.detail.note_id, Boolean(e.detail.is_folder))
    }
    loadnotes()
  })

  // poll for file tree changes when peers are online but we may not have an active socket
  // catches create or folder events that arrive before or after a socket session
  let pollinterval = null
  let lastnotesig = ''

  function getnotesig() {
    const ids = (state.allnotes || []).map(n => n.note_id).sort().join('|')
    const folders = (state.allfolders || []).slice().sort().join('|')
    return `${ids}::${folders}`
  }

  async function pollfiletree() {
    try {
      const data = await api('/api/notes')
      const incoming = (data.notes || []).map(n => n.note_id).sort().join('|') +
        '::' + (data.folders || []).slice().sort().join('|')
      if (incoming !== lastnotesig) {
        lastnotesig = incoming
        window.dispatchEvent(new CustomEvent('vault-changed', { detail: { action: 'poll' } }))
      }
    } catch {}
  }

  function startfilepoll() {
    if (pollinterval) return
    lastnotesig = getnotesig()
    pollinterval = setInterval(pollfiletree, 8000)
  }

  function stopfilepoll() {
    if (!pollinterval) return
    clearInterval(pollinterval)
    pollinterval = null
  }

  // only poll when peers are connected -- vault-changed from collab handles the rest
  window.addEventListener('collab-peers-online', startfilepoll)
  window.addEventListener('collab-peers-offline', stopfilepoll)

  // mobile more button -- same menu as empty-area right click --------------------
  const btnfoldermore = document.getElementById('btn-folder-more')
  if (btnfoldermore) {
    btnfoldermore.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    btnfoldermore.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      clearfileselection()
      opencontextmenunear(btnfoldermore, null, state.currentfolder)
    })
  }

  // right click on file pane empty area --------------------
  const targetempty = foldernavpane || folderitems
  if (targetempty) {
    targetempty.addEventListener('click', (e) => {
      if (e.target.closest('.folder-row')) return
      if (e.ctrlKey || e.metaKey) return
      clearfileselection()
    })
    targetempty.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.folder-row') || e.target.closest('.folder-path-input') || e.target.closest('.breadcrumb-back')) {
        return
      }
      e.preventDefault()
      clearfileselection()
      opencontextmenu(e.clientX, e.clientY, null, state.currentfolder)
    })

    // drag and drop into empty area of current folder --------------------
    targetempty.addEventListener('dragover', (e) => {
      const items = getdraggeditems(e)
      if (!items.length) return
      if (e.target !== folderitems && !e.target.classList.contains('folder-empty') && e.target !== foldernavpane) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      folderitems?.classList.add('drag-over')
    })
    targetempty.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && targetempty.contains(e.relatedTarget)) return
      folderitems?.classList.remove('drag-over')
    })

    targetempty.addEventListener('drop', async (e) => {
      folderitems?.classList.remove('drag-over')
      clearalldraghighlights()
      if (e.target !== folderitems && !e.target.classList.contains('folder-empty') && e.target !== foldernavpane) return
      const items = getdraggeditems(e)
      if (!items.length) return
      e.preventDefault()
      await moveitemstofolder(items, workingfolder())
    })
  }

  // always clear drop outlines when a drag ends anywhere --------------------
  window.addEventListener('dragend', () => clearalldraghighlights())
  window.addEventListener('drop', () => {
    setTimeout(() => clearalldraghighlights(), 0)
  })

  // context menu action handlers --------------------
  if (ctxitemopentab) {
    ctxitemopentab.addEventListener('click', () => {
      if (!contexttargetnoteid) return
      const target = contexttargetnoteid
      const alreadyopen = state.opentabs.some((t) => isnoteidmatch(t, target))
      closecontextmenu()
      opennote(target, alreadyopen
        ? { newtab: false, replacecurrent: false }
        : { newtab: true })
    })
  }

  if (ctxitemviewpage) {
    ctxitemviewpage.addEventListener('click', () => {
      if (!contexttargetnoteid) return
      const target = contexttargetnoteid
      closecontextmenu()
      openpreviewtab(target)
    })
  }

  if (ctxitemnew) {
    ctxitemnew.addEventListener('click', () => {
      startrowcreate('note')
    })
  }

  // new folder listener --------------------
  if (ctxitemnewfolder) {
    ctxitemnewfolder.addEventListener('click', () => {
      startrowcreate('folder')
    })
  }

  // upload file listener --------------------
  if (ctxitemupload) {
    ctxitemupload.addEventListener('click', () => {
      const targetfolder = contexttargetfolder !== null ? contexttargetfolder : workingfolder()
      closecontextmenu()
      uploadfiletofolder(targetfolder)
    })
  }

  // cut listener --------------------
  if (ctxitemcut) {
    ctxitemcut.addEventListener('click', () => {
      const targets = getoperationtargets()
      if (!targets.length) return
      closecontextmenu()
      clipboard = { action: 'cut', items: targets.map((t) => ({ ...t })) }
      clearfileselection()
      updatecutrows()
    })
  }

  // copy listener --------------------
  if (ctxitemcopy) {
    ctxitemcopy.addEventListener('click', () => {
      const targets = getoperationtargets()
      if (!targets.length) return
      closecontextmenu()
      clipboard = { action: 'copy', items: targets.map((t) => ({ ...t })) }
      clearfileselection()
      updatecutrows()
    })
  }

  // paste listener --------------------
  if (ctxitempaste) {
    ctxitempaste.addEventListener('click', async () => {
      if (!clipboard?.items?.length) return
      const targetdestfolder = contexttargetfolder || workingfolder()
      const items = clipboard.items.map((t) => ({ ...t }))
      const action = clipboard.action
      closecontextmenu()

      try {
        for (const item of items) {
          const isfile = item.type === 'file'
          const basename = item.path.split('/').pop()
          const destpath = targetdestfolder ? `${targetdestfolder}/${basename}` : basename
          if (action === 'cut') {
            await moveitemtofolder(item.path, isfile, targetdestfolder)
          } else if (action === 'copy') {
            await api('/api/note/copy', {
              method: 'POST',
              body: JSON.stringify({
                source: item.path,
                destination: targetdestfolder ? `${targetdestfolder}/` : destpath
              })
            })
          }
        }
        if (action === 'cut') {
          clipboard = null
          updatecutrows()
        }
        await loadnotes()
      } catch (err) {
        alert(`paste failed: ${err.message}`)
      }
    })
  }

  // rename note or folder listener --------------------
  if (ctxitemrename) {
    ctxitemrename.addEventListener('click', () => {
      startrowrename()
    })
  }

  // delete note or multi selection listener --------------------
  if (ctxitemdelete) {
    ctxitemdelete.addEventListener('click', async () => {
      const targets = getoperationtargets()
      if (!targets.length) return
      closecontextmenu()

      const label = targets.length === 1
        ? `delete "${targets[0].path}"?`
        : `delete ${targets.length} items?`
      if (!confirm(`are you sure you want to ${label}`)) return

      try {
        for (const item of targets) {
          if (item.type === 'folder') {
            await api(`/api/folder?path=${encodeURIComponent(item.path)}`, { method: 'DELETE' })
            const prefix = `${item.path}/`
            const tabsremaining = state.opentabs.filter((t) => !t.startsWith(prefix) && t !== item.path)
            if (tabsremaining.length !== state.opentabs.length) {
              state.opentabs = tabsremaining
              if (state.activenoteid && (state.activenoteid.startsWith(prefix) || state.activenoteid === item.path)) {
                if (tabsremaining.length > 0) {
                  opennote(tabsremaining[0], { force: true, replacecurrent: false, switchfolder: false })
                } else {
                  closenote()
                }
              }
              rendertabs()
              saveworkspacestate()
            }
          } else {
            await api(`/api/note?id=${encodeURIComponent(item.path)}`, { method: 'DELETE' })
            closetab(item.path)
          }
          if (clipboard?.items?.some((c) => c.path === item.path || c.path.startsWith(`${item.path}/`))) {
            clipboard.items = clipboard.items.filter((c) => c.path !== item.path && !c.path.startsWith(`${item.path}/`))
            if (!clipboard.items.length) clipboard = null
          }
          selecteditems.delete(item.path)
        }
        updatecutrows()
        updateselectionrows()
        await loadnotes()
      } catch (err) {
        alert(`delete failed: ${err.message}`)
      }
    })
  }

  // delete folder listener --------------------
  if (ctxitemdeletefolder) {
    ctxitemdeletefolder.addEventListener('click', async () => {
      const targetfolder = contexttargetfolder
      if (!targetfolder) return
      closecontextmenu()

      const confirmed = confirm(`are you sure you want to delete folder "${targetfolder}" and all its notes?`)
      if (!confirmed) return

      try {
        await api(`/api/folder?path=${encodeURIComponent(targetfolder)}`, {
          method: 'DELETE'
        })
        if (clipboard?.items?.some((c) => c.path === targetfolder || c.path.startsWith(`${targetfolder}/`))) {
          clipboard.items = clipboard.items.filter((c) => c.path !== targetfolder && !c.path.startsWith(`${targetfolder}/`))
          if (!clipboard.items.length) clipboard = null
          updatecutrows()
        }
        selecteditems.delete(targetfolder)
        updateselectionrows()

        const prefix = `${targetfolder}/`
        const tabsremaining = state.opentabs.filter(t => !t.startsWith(prefix) && t !== targetfolder)
        if (tabsremaining.length !== state.opentabs.length) {
          state.opentabs = tabsremaining
          if (state.activenoteid && (state.activenoteid.startsWith(prefix) || state.activenoteid === targetfolder)) {
            if (tabsremaining.length > 0) {
              opennote(tabsremaining[0], { force: true, replacecurrent: false, switchfolder: false })
            } else {
              closenote()
            }
          }
          rendertabs()
          saveworkspacestate()
        }

        if (state.currentfolder === targetfolder || state.currentfolder.startsWith(prefix)) {
          const parentparts = targetfolder.split('/').slice(0, -1)
          navigatefolder(parentparts.join('/'))
        }
        await loadnotes()
      } catch (err) {
        alert(`delete folder failed: ${err.message}`)
      }
    })
  }

  // system folder navigation --------------------
  if (ctxitemsystem) {
    ctxitemsystem.addEventListener('click', () => {
      closecontextmenu()
      navigatefolder('system')
    })
  }

  if (ctxitemdeleted) {
    ctxitemdeleted.addEventListener('click', () => {
      closecontextmenu()
      navigatefolder(deletedtrackerid)
    })
  }

}

// load note list from server --------------------
export async function loadnotes() {
  try {
    const data = await api('/api/notes')
    state.allnotes = data.notes || []
    state.allfolders = data.folders || []
    refreshlinkicons()

    // prune tabs for notes that no longer exist on disk --------------------
    if (Array.isArray(state.opentabs) && state.opentabs.length > 0) {
      const previoustabs = [...state.opentabs]
      const previoushistories = Array.isArray(state.tabslothistories)
        ? state.tabslothistories.map((stack) => (Array.isArray(stack) ? [...stack] : []))
        : []
      const remainingtabs = state.opentabs.filter(tabid => isvalidopentab(tabid, state.allnotes))
      if (remainingtabs.length !== state.opentabs.length) {
        state.opentabs = remainingtabs
        restoretabslothistories(
          previoushistories,
          previoustabs,
          remainingtabs,
          (id) => isvalidopentab(id, state.allnotes)
        )
        if (state.activenoteid && !isvalidopentab(state.activenoteid, state.allnotes)) {
          if (remainingtabs.length > 0) {
            opennote(remainingtabs[0], { force: true, replacecurrent: false, switchfolder: false })
          } else {
            closenote()
          }
        }
        rendertabs()
        saveworkspacestate()
      }
    }

    // only auto open on first startup --------------------
    if (!hasinitializednotes) {
      hasinitializednotes = true

      // check if a specific note was requested via query parameter --------------------
      const urlparams = new URLSearchParams(window.location.search)
      const notetoopen = urlparams.get('open')

      const saved = loadworkspacestate()
      const historyentryok = (id) => isvalidopentab(id, state.allnotes)

      if (notetoopen && state.allnotes.some(n => isnoteidmatch(n.note_id, notetoopen))) {
        if (saved && Array.isArray(saved.opentabs)) {
          const kept = saved.opentabs.filter(t => isvalidopentab(t, state.allnotes))
          // set tabs first so history sync cannot truncate against an empty list --------------------
          state.opentabs = kept
          restoretabslothistories(saved.tabslothistories, saved.opentabs, kept, historyentryok)
        }
        await opennote(notetoopen, { newtab: true, switchfolder: true })
        window.history.replaceState({}, '', currentworkspacepath())
      } else if (saved && saved.opentabs && saved.opentabs.length > 0) {
        let existingtabs = saved.opentabs.filter(t => isvalidopentab(t, state.allnotes))
        // mobile only keeps one tab from a restored desktop session --------------------
        if (ismobilemode() && existingtabs.length > 1) {
          const preferred = (saved.activenoteid && existingtabs.some(t => isnoteidmatch(t, saved.activenoteid)))
            ? saved.activenoteid
            : existingtabs[0]
          existingtabs = [preferred]
        }
        state.opentabs = existingtabs
        restoretabslothistories(saved.tabslothistories, saved.opentabs, existingtabs, historyentryok)
        if (saved.currentfolder) {
          state.currentfolder = saved.currentfolder
        }
        const activetoopen = (saved.activenoteid && existingtabs.some(t => isnoteidmatch(t, saved.activenoteid)))
          ? saved.activenoteid
          : existingtabs[0]

        if (activetoopen) {
          await opennote(activetoopen, { replacecurrent: false, switchfolder: false })
        } else {
          closenote()
        }
      } else {
        const lastopen = state.currentuser?.preferences?.['last-open-note']
        const lastopenexists = lastopen && state.allnotes.some(n => isnoteidmatch(n.note_id, lastopen))

        if (lastopenexists) {
          await opennote(lastopen, { switchfolder: true })
        } else {
          closenote()
        }
      }
    }

    // ensure current folder exists in accessible notes or folders unless it is archive, system, or media --------------------
    const keepfolders = ['archive', 'system', 'media', deletedtrackerid]
    if (state.currentfolder && !keepfolders.includes(state.currentfolder)) {
      const folderprefix = state.currentfolder.endsWith('/') ? state.currentfolder : `${state.currentfolder}/`
      const folderexists = state.allnotes.some(n => n.note_id.startsWith(folderprefix)) ||
        (state.allfolders || []).some(f => f === state.currentfolder || f.startsWith(folderprefix))
      if (!folderexists) {
        const parentparts = state.currentfolder.split('/').slice(0, -1)
        state.currentfolder = parentparts.join('/')
      }
    }

      // always render folder view so directory tree is always populated --------------------
      renderfolderview()
    } catch (err) {
      console.error('failed to load notes', err)
    }
  }

