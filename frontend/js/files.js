import { api } from './api.js'
import { state } from './state.js'
import { opennote, closenote, saveworkspacestate, loadworkspacestate, isnoteidmatch } from './editor.js'
import { closetab, rendertabs } from './tabs.js'

// dom elements for file navigation --------------------
const folderbreadcrumb = document.getElementById('folder-breadcrumb')
const folderitems = document.getElementById('folder-items')
const filecontextmenu = document.getElementById('file-context-menu')
const ctxitemopentab = document.getElementById('ctx-item-open-tab')
const ctxitemnew = document.getElementById('ctx-item-new')
const ctxitemnewfolder = document.getElementById('ctx-item-new-folder')
const ctxitemcut = document.getElementById('ctx-item-cut')
const ctxitemcopy = document.getElementById('ctx-item-copy')
const ctxitempaste = document.getElementById('ctx-item-paste')
const ctxitemrename = document.getElementById('ctx-item-rename')
const ctxitemdelete = document.getElementById('ctx-item-delete')
const ctxitemdeletefolder = document.getElementById('ctx-item-delete-folder')
const ctxitemsystem = document.getElementById('ctx-item-system')

const newnotedialog = document.getElementById('new-note-dialog')
const newnoteform = document.getElementById('new-note-form')
const newnoteinput = document.getElementById('new-note-input')
const newnoteerror = document.getElementById('new-note-error')
const btncancelnewnote = document.getElementById('btn-cancel-new-note')

let contexttargetnoteid = null
let contexttargetfolder = null
let clipboard = null
let hasinitializednotes = false

// resolve file icon based on extension --------------------
export function getfileicon(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase()
  if (ext === 'md' || ext === 'txt') {
    return '/resources/icons/files/text.png'
  }
  if (ext === 'yaml' || ext === 'yml' || ext === 'json' || ext === 'js' || ext === 'ts') {
    return '/resources/icons/files/code.png'
  }
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif' || ext === 'svg') {
    return '/resources/icons/files/image.png'
  }
  if (ext === 'html' || ext === 'htm') {
    return '/resources/icons/files/webpage.png'
  }
  return '/resources/icons/files/common.png'
}

// extract immediate children of current folder --------------------
export function getfoldercontents(folderpath) {
  const prefix = folderpath
    ? (folderpath.endsWith('/') ? folderpath : `${folderpath}/`)
    : ''

  const subfolders = new Set()
  const files = []

  const insystem = folderpath === 'system' || folderpath.startsWith('system/')

  for (const note of state.allnotes) {
    // hide system notes unless currently browsing inside system --------------------
    if (!insystem && note.note_id.startsWith('system/')) {
      continue
    }

    if (prefix && !note.note_id.startsWith(prefix)) {
      continue
    }

    const remainder = note.note_id.slice(prefix.length)
    const parts = remainder.split('/')

    if (parts.length > 1) {
      // never show system in root folder listing --------------------
      if (!prefix && parts[0] === 'system') {
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

// navigate into a specific folder --------------------
export function navigatefolder(targetfolder) {
  state.currentfolder = targetfolder
  renderfolderview()
  saveworkspacestate()
}

// render breadcrumb and directory contents --------------------
export function renderfolderview() {
  if (!folderbreadcrumb || !folderitems) return

  // render breadcrumb bar --------------------
  folderbreadcrumb.innerHTML = ''

  if (state.currentfolder) {
    const btnback = document.createElement('button')
    btnback.className = 'breadcrumb-back'
    btnback.innerHTML = '<img class="breadcrumb-back-icon" src="/resources/icons/files/updirectory.png" alt="back"> back'
    btnback.title = 'go to parent folder'

    const parts = state.currentfolder.split('/')
    const parentfolder = parts.slice(0, -1).join('/')
    btnback.addEventListener('click', () => navigatefolder(parentfolder))
    folderbreadcrumb.appendChild(btnback)
  }

  const trail = document.createElement('div')
  trail.className = 'breadcrumb-trail'

  const rootcrumb = document.createElement('span')
  rootcrumb.className = `breadcrumb-crumb ${!state.currentfolder ? 'active' : ''}`
  rootcrumb.textContent = 'notes'
  rootcrumb.addEventListener('click', () => navigatefolder(''))
  trail.appendChild(rootcrumb)

  if (state.currentfolder) {
    const parts = state.currentfolder.split('/')
    let cumulative = ''

    for (let i = 0; i < parts.length; i++) {
      cumulative = cumulative ? `${cumulative}/${parts[i]}` : parts[i]
      const targetpath = cumulative

      const sep = document.createElement('span')
      sep.className = 'breadcrumb-sep'
      sep.textContent = '/'
      trail.appendChild(sep)

      const crumb = document.createElement('span')
      const islast = i === parts.length - 1
      crumb.className = `breadcrumb-crumb ${islast ? 'active' : ''}`
      crumb.textContent = parts[i]

      if (!islast) {
        crumb.addEventListener('click', () => navigatefolder(targetpath))
      }
      trail.appendChild(crumb)
    }
  }

  folderbreadcrumb.appendChild(trail)

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
    row.innerHTML = `
      <img class="row-icon-img" src="/resources/icons/files/folder.png" alt="folder">
      <span class="row-name">${foldername}</span>
      <span class="row-arrow">></span>
    `
    row.addEventListener('click', () => navigatefolder(fullfolderpath))

    // right click on folder row --------------------
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      opencontextmenu(e.clientX, e.clientY, null, fullfolderpath)
    })

    folderitems.appendChild(row)
  }

  // render files --------------------
  for (const file of files) {
    const row = document.createElement('div')
    row.className = 'folder-row is-file'
    row.dataset.noteId = file.id

    if (isnoteidmatch(file.id, state.activenoteid)) {
      row.classList.add('active')
    }

    const iconpath = getfileicon(file.name)

    row.innerHTML = `
      <img class="row-icon-img" src="${iconpath}" alt="file">
      <span class="row-name">${file.name}</span>
    `
    // clicking open note closes it otherwise replace current tab --------------------
    row.addEventListener('click', () => {
      if (isnoteidmatch(state.activenoteid, file.id)) {
        closetab(file.id)
      } else {
        opennote(file.id, { replacecurrent: true })
      }
    })

    // right click on file row --------------------
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      opencontextmenu(e.clientX, e.clientY, file.id)
    })

    folderitems.appendChild(row)
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

// open custom context menu --------------------
export function opencontextmenu(x, y, noteid = null, folderpath = null) {
  contexttargetnoteid = noteid
  contexttargetfolder = folderpath !== null ? folderpath : state.currentfolder

  const isfile = Boolean(noteid)
  const isfolderrow = !isfile && folderpath !== null && folderpath !== state.currentfolder

  // manage visibility of context items --------------------
  if (ctxitemopentab) ctxitemopentab.classList.toggle('hidden', !isfile)
  if (ctxitemrename) ctxitemrename.classList.toggle('hidden', !isfile && !isfolderrow)
  if (ctxitemdelete) ctxitemdelete.classList.toggle('hidden', !isfile)
  if (ctxitemdeletefolder) ctxitemdeletefolder.classList.toggle('hidden', !isfolderrow)

  if (ctxitemcut) ctxitemcut.classList.toggle('hidden', !isfile && !isfolderrow)
  if (ctxitemcopy) ctxitemcopy.classList.toggle('hidden', !isfile && !isfolderrow)

  if (ctxitemnew) {
    ctxitemnew.classList.toggle('hidden', isfile)
    ctxitemnew.innerHTML = `<img class="btn-icon-img" src="/resources/icons/files/new.png" alt="new"> ${isfolderrow ? 'new note in folder...' : 'new note...'}`
  }

  if (ctxitemnewfolder) {
    ctxitemnewfolder.classList.toggle('hidden', isfile)
    ctxitemnewfolder.innerHTML = `<img class="btn-icon-img" src="/resources/icons/files/newfolder.png" alt="newfolder"> ${isfolderrow ? 'new subfolder...' : 'new folder...'}`
  }

  if (ctxitempaste) {
    const canpaste = !isfile && Boolean(clipboard)
    ctxitempaste.classList.toggle('hidden', !canpaste)
    if (canpaste) {
      const clipname = clipboard.path.split('/').pop()
      ctxitempaste.innerHTML = `<img class="btn-icon-img" src="/resources/icons/files/common.png" alt="paste"> paste "${clipname}"`
    }
  }

  if (ctxitemsystem) {
    ctxitemsystem.classList.toggle('hidden', isfile || isfolderrow)
  }

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

// initialize file pane and context menu events --------------------
export function initfiles() {
  document.addEventListener('click', closecontextmenu)

  // refresh file list when external filesystem changes occur --------------------
  window.addEventListener('vault-changed', (e) => {
    if (e.detail?.action === 'delete' && e.detail?.note_id) {
      closetab(e.detail.note_id)
    }
    loadnotes()
  })

  // right click on file pane empty area --------------------
  if (folderitems) {
    folderitems.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.folder-row')) {
        return
      }
      e.preventDefault()
      opencontextmenu(e.clientX, e.clientY, null, state.currentfolder)
    })
  }

  // context menu action handlers --------------------
  if (ctxitemopentab) {
    ctxitemopentab.addEventListener('click', () => {
      if (!contexttargetnoteid) return
      const target = contexttargetnoteid
      closecontextmenu()
      opennote(target, { newtab: true })
    })
  }

  if (ctxitemnew) {
    ctxitemnew.addEventListener('click', () => {
      closecontextmenu()
      newnoteerror.textContent = ''
      newnoteerror.classList.add('hidden')
      newnoteinput.value = ''
      const targetdir = contexttargetfolder || state.currentfolder
      newnoteinput.placeholder = targetdir
        ? `${targetdir}/filename`
        : 'filename or folder/filename'
      newnotedialog.classList.remove('hidden')
      newnoteinput.focus()
    })
  }

  // new folder listener --------------------
  if (ctxitemnewfolder) {
    ctxitemnewfolder.addEventListener('click', async () => {
      const targetparent = contexttargetfolder || state.currentfolder
      closecontextmenu()

      const foldername = prompt('new folder name:', '')
      if (!foldername || !foldername.trim()) {
        return
      }

      const cleanfoldername = foldername.trim().replace(/[^a-zA-Z0-9_\-]/g, '_')
      const targetpath = targetparent ? `${targetparent}/${cleanfoldername}` : cleanfoldername

      try {
        await api('/api/folder', {
          method: 'POST',
          body: JSON.stringify({ folder_path: targetpath })
        })
        navigatefolder(targetpath)
        await loadnotes()
      } catch (err) {
        alert(`create folder failed: ${err.message}`)
      }
    })
  }

  // cut listener --------------------
  if (ctxitemcut) {
    ctxitemcut.addEventListener('click', () => {
      const isfile = Boolean(contexttargetnoteid)
      const targetpath = contexttargetnoteid || contexttargetfolder
      if (!targetpath) return
      closecontextmenu()
      clipboard = { action: 'cut', type: isfile ? 'file' : 'folder', path: targetpath }
    })
  }

  // copy listener --------------------
  if (ctxitemcopy) {
    ctxitemcopy.addEventListener('click', () => {
      const isfile = Boolean(contexttargetnoteid)
      const targetpath = contexttargetnoteid || contexttargetfolder
      if (!targetpath) return
      closecontextmenu()
      clipboard = { action: 'copy', type: isfile ? 'file' : 'folder', path: targetpath }
    })
  }

  // paste listener --------------------
  if (ctxitempaste) {
    ctxitempaste.addEventListener('click', async () => {
      if (!clipboard) return
      const targetdestfolder = contexttargetfolder || state.currentfolder
      closecontextmenu()

      const srcpath = clipboard.path
      const isfile = clipboard.type === 'file'
      const basename = srcpath.split('/').pop()
      const destpath = targetdestfolder ? `${targetdestfolder}/${basename}` : basename

      try {
        if (clipboard.action === 'cut') {
          if (srcpath !== destpath) {
            await api('/api/note/rename', {
              method: 'POST',
              body: JSON.stringify({ old_id: srcpath, new_id: destpath })
            })

            if (isfile) {
              if (state.activenoteid === srcpath) {
                state.activenoteid = destpath
              }
              if (state.opentabs.includes(srcpath)) {
                state.opentabs = state.opentabs.map(t => t === srcpath ? destpath : t)
                rendertabs()
                saveworkspacestate()
              }
            } else {
              const oldprefix = `${srcpath}/`
              const newprefix = `${destpath}/`
              let tabsmodified = false
              state.opentabs = state.opentabs.map(tabid => {
                if (tabid.startsWith(oldprefix)) {
                  tabsmodified = true
                  return `${newprefix}${tabid.slice(oldprefix.length)}`
                }
                return tabid
              })
              if (state.activenoteid && state.activenoteid.startsWith(oldprefix)) {
                state.activenoteid = `${newprefix}${state.activenoteid.slice(oldprefix.length)}`
              }
              if (tabsmodified) {
                rendertabs()
                saveworkspacestate()
              }
            }
          }
          clipboard = null
        } else if (clipboard.action === 'copy') {
          await api('/api/note/copy', {
            method: 'POST',
            body: JSON.stringify({ source: srcpath, destination: targetdestfolder ? `${targetdestfolder}/` : destpath })
          })
        }

        await loadnotes()
      } catch (err) {
        alert(`paste failed: ${err.message}`)
      }
    })
  }

  // rename note or folder listener --------------------
  if (ctxitemrename) {
    ctxitemrename.addEventListener('click', async () => {
      const isfolder = !contexttargetnoteid && Boolean(contexttargetfolder)
      const oldtarget = contexttargetnoteid || contexttargetfolder
      if (!oldtarget) return
      closecontextmenu()

      const currentname = oldtarget.split('/').pop()
      const promptmsg = isfolder ? `rename folder "${currentname}" to:` : `rename note "${currentname}" to:`
      const newname = prompt(promptmsg, currentname)
      if (!newname || newname.trim() === '' || newname === currentname) {
        return
      }

      let cleanednewname = newname.trim()
      if (!isfolder && !/\.[a-zA-Z0-9]+$/.test(cleanednewname)) {
        cleanednewname = `${cleanednewname}.md`
      }

      const parentpath = oldtarget.includes('/') ? oldtarget.split('/').slice(0, -1).join('/') : ''
      const newid = parentpath ? `${parentpath}/${cleanednewname}` : cleanednewname

      try {
        await api('/api/note/rename', {
          method: 'POST',
          body: JSON.stringify({ old_id: oldtarget, new_id: newid })
        })

        if (!isfolder) {
          if (state.activenoteid === oldtarget) {
            state.activenoteid = newid
          }
          if (state.opentabs.includes(oldtarget)) {
            state.opentabs = state.opentabs.map(t => t === oldtarget ? newid : t)
            rendertabs()
            saveworkspacestate()
          }
        } else {
          const oldprefix = `${oldtarget}/`
          const newprefix = `${newid}/`
          let tabsmodified = false
          state.opentabs = state.opentabs.map(tabid => {
            if (tabid.startsWith(oldprefix)) {
              tabsmodified = true
              return `${newprefix}${tabid.slice(oldprefix.length)}`
            }
            return tabid
          })
          if (state.activenoteid && state.activenoteid.startsWith(oldprefix)) {
            state.activenoteid = `${newprefix}${state.activenoteid.slice(oldprefix.length)}`
          }
          if (state.currentfolder === oldtarget) {
            state.currentfolder = newid
          }
          if (tabsmodified) {
            rendertabs()
            saveworkspacestate()
          }
        }
        await loadnotes()
      } catch (err) {
        alert(`rename failed: ${err.message}`)
      }
    })
  }

  // delete note listener --------------------
  if (ctxitemdelete) {
    ctxitemdelete.addEventListener('click', async () => {
      if (!contexttargetnoteid) return
      const target = contexttargetnoteid
      closecontextmenu()

      const confirmed = confirm(`are you sure you want to delete note "${target}"?`)
      if (!confirmed) {
        return
      }

      try {
        await api(`/api/note?id=${encodeURIComponent(target)}`, {
          method: 'DELETE'
        })
        closetab(target)
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

  // new note dialog listeners --------------------
  if (btncancelnewnote) {
    btncancelnewnote.addEventListener('click', () => {
      newnotedialog.classList.add('hidden')
    })
  }

  if (newnotedialog) {
    newnotedialog.addEventListener('click', (e) => {
      if (e.target === newnotedialog) {
        newnotedialog.classList.add('hidden')
      }
    })
  }

  if (newnoteform) {
    newnoteform.addEventListener('submit', async (e) => {
      e.preventDefault()
      newnoteerror.textContent = ''
      newnoteerror.classList.add('hidden')

      let raw = newnoteinput.value.trim()
      if (!raw) return

      // prepend target folder if user provided only filename --------------------
      if (state.currentfolder && !raw.includes('/')) {
        raw = `${state.currentfolder}/${raw}`
      }

      // default to markdown if no extension given --------------------
      if (!raw.includes('.')) {
        raw = `${raw}.md`
      }

      // ensure parent folders are navigated to so new note is visible --------------------
      if (raw.includes('/')) {
        const parentfolder = raw.split('/').slice(0, -1).join('/')
        state.currentfolder = parentfolder
      }

      const parts = raw.split('/')
      const basefilename = parts[parts.length - 1].replace(/\.[^/.]+$/, '')
      const titleheading = basefilename.charAt(0).toUpperCase() + basefilename.slice(1)
      const initialcontent = `# ${titleheading}\n\n`

      try {
        await api('/api/notes', {
          method: 'POST',
          body: JSON.stringify({
            note_id: raw,
            content: initialcontent,
            author: state.currentuser ? state.currentuser.id : 'unknown'
          })
        })

        newnotedialog.classList.add('hidden')
        await loadnotes()
        await opennote(raw, { newtab: true, force: true })
      } catch (err) {
        newnoteerror.textContent = err.message
        newnoteerror.classList.remove('hidden')
      }
    })
  }
}

// load note list from server --------------------
export async function loadnotes() {
  try {
    const data = await api('/api/notes')
    state.allnotes = data.notes || []

    // prune tabs for notes that no longer exist on disk --------------------
    if (Array.isArray(state.opentabs) && state.opentabs.length > 0) {
      const remainingtabs = state.opentabs.filter(tabid =>
        state.allnotes.some(n => isnoteidmatch(n.note_id, tabid))
      )
      if (remainingtabs.length !== state.opentabs.length) {
        state.opentabs = remainingtabs
        if (state.activenoteid && !state.allnotes.some(n => isnoteidmatch(n.note_id, state.activenoteid))) {
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

      if (notetoopen && state.allnotes.some(n => isnoteidmatch(n.note_id, notetoopen))) {
        if (saved && Array.isArray(saved.opentabs)) {
          state.opentabs = saved.opentabs.filter(t => state.allnotes.some(n => isnoteidmatch(n.note_id, t)))
        }
        await opennote(notetoopen, { newtab: true, switchfolder: true })
        window.history.replaceState({}, '', '/editor.html')
      } else if (saved && saved.opentabs && saved.opentabs.length > 0) {
        const existingtabs = saved.opentabs.filter(t => state.allnotes.some(n => isnoteidmatch(n.note_id, t)))
        state.opentabs = existingtabs
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

    // ensure current folder exists in accessible notes unless it is archive or system --------------------
      if (state.currentfolder && state.currentfolder !== 'archive' && state.currentfolder !== 'system') {
        const folderprefix = state.currentfolder.endsWith('/') ? state.currentfolder : `${state.currentfolder}/`
        const folderexists = state.allnotes.some(n => n.note_id.startsWith(folderprefix))
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

