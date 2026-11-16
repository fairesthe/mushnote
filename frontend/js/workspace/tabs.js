import { state } from '../core/state.js'
import { ismobilemode } from '../core/mobile.js'
import {
  opennote,
  closenote,
  saveworkspacestate,
  isnoteidmatch,
  getdraggeditem,
  getdraggeditems,
  insertdraggeditemsintoactivenote,
  stopmediafortabclose
} from '../editor/editor.js'

function getpreviewtablabel(tabnoteid, fallbackname) {
  const stored = state.previewtitles?.[tabnoteid]
  const label = stored || fallbackname
  return `web: ${label}`
}

function gettabicon(tabnoteid) {
  if (!tabnoteid) return '/resources/icons/files/binary.png'
  if (tabnoteid.startsWith('preview:')) return '/resources/icons/general/web.png'
  const name = tabnoteid.split('/').pop() || tabnoteid
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (ext === 'md' || ext === 'txt' || !name.includes('.')) return '/resources/icons/files/text.png'
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
  if (ext === 'pdf') return '/resources/icons/files/pdf.png'
  if (ext === 'zip' || ext === 'jar' || ext === 'tar' || ext === 'gz' || ext === '7z' || ext === 'rar') {
    return '/resources/icons/files/archive.png'
  }
  if (ext === 'html' || ext === 'htm') return '/resources/icons/files/webpage.png'
  return '/resources/icons/files/binary.png'
}

// plain path text carried while dragging a tab (for dropping into inputs) --------------------
function gettabdragtext(noteid) {
  let id = String(noteid || '').replace(/\\/g, '/')
  if (id.startsWith('preview:')) id = id.slice('preview:'.length)
  if (!id) return ''
  if (/^https?:\/\//i.test(id)) return id
  id = id.replace(/^\/+/, '')
  if (/^media\//i.test(id) || /^avatars\//i.test(id)) return `/${id}`
  if (/\.(png|jpe?g|gif|webp|svg|ico)$/i.test(id)) return `/preview/${id}`
  return id
}

function findtextdropfield(clientx, clienty) {
  const under = document.elementFromPoint(clientx, clienty)
  if (!under || typeof under.closest !== 'function') return null
  const field = under.closest('input, textarea')
  if (!field) return null
  if (field.disabled || field.readOnly) return null
  if (field.tagName === 'TEXTAREA') return field
  const type = (field.type || 'text').toLowerCase()
  if (['text', 'search', 'url', 'email', 'tel', 'password', 'number'].includes(type)) return field
  return null
}

function inserttextintofield(field, text) {
  if (!field || !text) return
  field.focus()
  const value = String(field.value || '')
  const start = Number.isInteger(field.selectionStart) ? field.selectionStart : value.length
  const end = Number.isInteger(field.selectionEnd) ? field.selectionEnd : value.length
  field.value = `${value.slice(0, start)}${text}${value.slice(end)}`
  const caret = start + text.length
  try {
    field.setSelectionRange(caret, caret)
  } catch {}
  field.dispatchEvent(new Event('input', { bubbles: true }))
  field.dispatchEvent(new Event('change', { bubbles: true }))
}

function cleartabdragstyles() {
  document.body.classList.remove('is-dragging-tab')
  for (const item of tabitems) {
    if (!item?.el) continue
    item.el.style.transition = ''
    item.el.style.transform = ''
    item.el.classList.remove('is-dragging')
  }
  if (draggingtab) {
    draggingtab.classList.remove('is-dragging')
    draggingtab.style.transition = ''
    draggingtab.style.transform = ''
  }
}

// dom elements for tabs --------------------
const editortabsbar = document.getElementById('editor-tabs-bar')
const tabstrack = document.getElementById('tabs-track')

// per tab-slot navigation history (parallel to state.opentabs) --------------------
const tabhistorymax = 40
let suppressingtabhistory = false

function gethistories() {
  if (!Array.isArray(state.tabslothistories)) state.tabslothistories = []
  return state.tabslothistories
}

// active dragging state --------------------
let draggingtab = null
let startclientx = 0
let starttableft = 0
let sourceindex = -1
let targetindex = -1
let tabitems = []
let tabgap = 0
let startscrollleft = 0
let hasdragmoved = false
let isanimatingsnap = false
let renderqueued = false

function synctabslothistories() {
  const histories = gethistories()
  while (histories.length < state.opentabs.length) histories.push([])
  if (histories.length > state.opentabs.length) {
    histories.length = state.opentabs.length
  }
}

function activeslotindex() {
  if (!state.activenoteid) return -1
  return state.opentabs.findIndex((t) => isnoteidmatch(t, state.activenoteid))
}

function peektabhistory() {
  synctabslothistories()
  const idx = activeslotindex()
  if (idx < 0) return null
  const stack = gethistories()[idx]
  if (!stack?.length) return null
  return stack[stack.length - 1]
}

function createtabbackbtn(prevnoteid) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'tab-back-btn'
  btn.title = `back to ${prevnoteid.split('/').pop()}`
  btn.setAttribute('aria-label', 'previous note')
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>'
  btn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    gobacktab()
  })
  btn.addEventListener('pointerdown', (e) => {
    e.stopPropagation()
  })
  return btn
}

export function updatetabbackbutton() {
  if (!tabstrack) return
  const activetab = tabstrack.querySelector('.editor-tab.active')
  if (!activetab) return

  const prev = peektabhistory()
  const existing = activetab.querySelector('.tab-back-btn')
  if (!prev) {
    existing?.remove()
    return
  }

  if (existing) {
    existing.title = `back to ${prev.split('/').pop()}`
    return
  }

  const btn = createtabbackbtn(prev)
  const icon = activetab.querySelector('.tab-icon')
  if (icon) activetab.insertBefore(btn, icon)
  else activetab.prepend(btn)
}

// record in-place navigation for a tab slot --------------------
export function pushtabhistory(slotidx, noteid) {
  if (suppressingtabhistory || slotidx < 0 || !noteid) return
  synctabslothistories()
  const histories = gethistories()
  const stack = histories[slotidx] || (histories[slotidx] = [])
  if (stack.length && isnoteidmatch(stack[stack.length - 1], noteid)) return
  stack.push(noteid)
  if (stack.length > tabhistorymax) stack.splice(0, stack.length - tabhistorymax)
  updatetabbackbutton()
}

export function ensureslothistory() {
  synctabslothistories()
}

export function moveslothistory(fromidx, toidx) {
  synctabslothistories()
  if (fromidx < 0 || toidx < 0 || fromidx === toidx) return
  const histories = gethistories()
  const [moved] = histories.splice(fromidx, 1)
  histories.splice(toidx, 0, moved || [])
}

export function removeslothistory(slotidx) {
  synctabslothistories()
  const histories = gethistories()
  if (slotidx < 0 || slotidx >= histories.length) return
  histories.splice(slotidx, 1)
}

export function prunetabhistory(noteid) {
  if (!noteid) return
  synctabslothistories()
  for (const stack of gethistories()) {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (isnoteidmatch(stack[i], noteid)) stack.splice(i, 1)
    }
  }
  updatetabbackbutton()
}

export function remaptabhistory(oldpath, newpath) {
  if (!oldpath || !newpath) return
  synctabslothistories()
  for (const stack of gethistories()) {
    for (let i = 0; i < stack.length; i++) {
      if (isnoteidmatch(stack[i], oldpath)) stack[i] = newpath
    }
  }
  updatetabbackbutton()
}

// restore stacks from localstorage parallel to the given open-tab list --------------------
export function restoretabslothistories(savedhistories, savedtabs, kepttabs, isvalidentry) {
  const source = Array.isArray(savedhistories) ? savedhistories : []
  const tabs = Array.isArray(savedtabs) ? savedtabs : []
  const kept = Array.isArray(kepttabs) ? kepttabs : []
  const validate = typeof isvalidentry === 'function' ? isvalidentry : (() => true)

  // keep slot alignment by filtering the same indices as kept tabs --------------------
  const restored = []
  for (let i = 0; i < tabs.length; i++) {
    const tabid = tabs[i]
    if (!tabid) continue
    if (!kept.some((k) => isnoteidmatch(k, tabid))) continue
    const stack = Array.isArray(source[i])
      ? source[i].filter((id) => id && validate(id)).slice(-tabhistorymax)
      : []
    restored.push(stack)
  }

  // pad or trim to kept length without reading state.opentabs yet --------------------
  while (restored.length < kept.length) restored.push([])
  if (restored.length > kept.length) restored.length = kept.length

  state.tabslothistories = restored
}

export function gobacktab() {
  synctabslothistories()
  const idx = activeslotindex()
  if (idx < 0) return
  const stack = gethistories()[idx]
  while (stack?.length) {
    const prev = stack.pop()
    if (!prev || isnoteidmatch(prev, state.activenoteid)) continue
    suppressingtabhistory = true
    opennote(prev, {
      newtab: false,
      replacecurrent: true,
      force: true,
      switchfolder: false,
      fromhistory: true,
    })
    suppressingtabhistory = false
    updatetabbackbutton()
    return
  }
  updatetabbackbutton()
}

// calculate exact pixel translateX offsets for variable width tabs --------------------
function computeslotoffsets(srcidx, tgtidx, items, gap = tabgap) {
  const count = items.length
  const offsets = new Array(count).fill(0)
  if (srcidx === tgtidx || srcidx < 0 || tgtidx < 0) return offsets

  // simulate new tab order --------------------
  const reordered = items.map((t, idx) => ({ ...t, originalindex: idx }))
  const [moved] = reordered.splice(srcidx, 1)
  reordered.splice(tgtidx, 0, moved)

  // calculate target pixel position for each original tab --------------------
  let currentleft = items[0].left
  for (const item of reordered) {
    offsets[item.originalindex] = currentleft - item.left
    currentleft += item.width + gap
  }

  return offsets
}

// render draggable tab bar --------------------
export function rendertabs() {
  if (!tabstrack || !editortabsbar) return

  // mobile uses a single note panel -- no multi tab chrome --------------------
  if (ismobilemode()) {
    editortabsbar.classList.add('hidden')
    tabstrack.innerHTML = ''
    synctabslothistories()
    return
  }

  // rebuilding mid drag yanks the tab out from under the pointer so wait for the drop --------------------
  if (draggingtab) {
    renderqueued = true
    return
  }

  // hide tab bar if no tabs open --------------------
  if (state.opentabs.length === 0) {
    editortabsbar.classList.add('hidden')
    tabstrack.innerHTML = ''
    state.tabslothistories = []
    return
  }

  editortabsbar.classList.remove('hidden')
  tabstrack.innerHTML = ''
  synctabslothistories()

  const histprev = peektabhistory()

  for (let i = 0; i < state.opentabs.length; i++) {
    const tabnoteid = state.opentabs[i]
    const isactive = isnoteidmatch(tabnoteid, state.activenoteid)
    const ispreview = tabnoteid.startsWith('preview:')
    const rawid = ispreview ? tabnoteid.slice('preview:'.length) : tabnoteid
    let tabname = rawid.split('/').pop() || rawid
    if (!ispreview && !tabname.includes('.')) {
      tabname = `${tabname}.md`
    }
    const displayname = ispreview ? getpreviewtablabel(tabnoteid, tabname) : tabname

    const tab = document.createElement('div')
    tab.className = `editor-tab ${isactive ? 'active' : ''}`
    tab.dataset.index = i
    tab.dataset.noteId = tabnoteid
    tab.title = displayname

    if (isactive && histprev) {
      tab.appendChild(createtabbackbtn(histprev))
    }

    const icon = document.createElement('img')
    icon.className = 'tab-icon'
    icon.src = gettabicon(tabnoteid)
    icon.alt = ''
    tab.appendChild(icon)

    const title = document.createElement('span')
    title.className = 'tab-title'
    title.textContent = displayname
    tab.appendChild(title)

    const btnclose = document.createElement('span')
    btnclose.className = 'tab-close'
    btnclose.title = 'close tab'
    btnclose.textContent = '×'
    btnclose.addEventListener('click', (e) => {
      e.stopPropagation()
      closetab(tabnoteid)
    })
    tab.appendChild(btnclose)

    // initiate smooth pointer drag on tab --------------------
    tab.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      if (e.target.closest('.tab-close') || e.target.closest('.tab-back-btn')) return
      if (isanimatingsnap) return

      e.preventDefault()
      startdrag(tab, i, e.clientX)
    })

    // accept file drops and hover to open tab --------------------
    let tabhovertimer = null

    tab.addEventListener('dragenter', (e) => {
      const item = state.activefiledrag || getdraggeditem(e)
      if (!item) return
      tab.classList.add('drag-over')
      if (tabhovertimer) clearTimeout(tabhovertimer)
      tabhovertimer = setTimeout(() => {
        if (!isnoteidmatch(tabnoteid, state.activenoteid)) {
          opennote(tabnoteid, { replacecurrent: false, switchfolder: false })
        }
      }, 350)
    })

    tab.addEventListener('dragover', (e) => {
      const item = state.activefiledrag || getdraggeditem(e)
      if (!item) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      tab.classList.add('drag-over')
    })

    tab.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && tab.contains(e.relatedTarget)) return
      tab.classList.remove('drag-over')
      if (tabhovertimer) {
        clearTimeout(tabhovertimer)
        tabhovertimer = null
      }
    })

    tab.addEventListener('drop', async (e) => {
      tab.classList.remove('drag-over')
      if (tabhovertimer) {
        clearTimeout(tabhovertimer)
        tabhovertimer = null
      }
      const dragitems = getdraggeditems(e)
      if (!dragitems.length) return
      e.preventDefault()
      e.stopPropagation()

      await opennote(tabnoteid, { replacecurrent: false, switchfolder: false })
      insertdraggeditemsintoactivenote(dragitems)
    })

    tabstrack.appendChild(tab)
  }
}

// start horizontal tab dragging session --------------------
function startdrag(tab, index, clientx) {
  draggingtab = tab
  sourceindex = index
  targetindex = index
  startclientx = clientx
  hasdragmoved = false

  // cache geometry of all tabs in track --------------------
  const children = Array.from(tabstrack.children)
  tabitems = children.map((el, idx) => ({
    el,
    index: idx,
    left: el.offsetLeft,
    width: el.offsetWidth,
    center: el.offsetLeft + el.offsetWidth / 2
  }))

  // measure the real gap instead of trusting the css number --------------------
  tabgap = tabitems.length > 1 ? Math.max(0, tabitems[1].left - (tabitems[0].left + tabitems[0].width)) : 0
  starttableft = tabitems[sourceindex]?.left || 0
  startscrollleft = editortabsbar?.scrollLeft || 0
}

// handle pointer move during tab drag --------------------
function onpointermove(e) {
  if (!draggingtab || isanimatingsnap) return

  // auto scroll moves the track under the pointer so fold it into the drag distance --------------------
  const dx = e.clientX - startclientx + ((editortabsbar?.scrollLeft || 0) - startscrollleft)

  if (!hasdragmoved) {
    if (Math.abs(dx) < 4) return
    hasdragmoved = true
    document.body.classList.add('is-dragging-tab')
    draggingtab.classList.add('is-dragging')
  }

  // bounds clamping so tab stays within track bounds --------------------
  const trackwidth = tabstrack.scrollWidth || tabstrack.offsetWidth
  const tabwidth = draggingtab.offsetWidth
  const maxleft = Math.max(0, trackwidth - tabwidth)
  const clampedleft = Math.max(0, Math.min(starttableft + dx, maxleft))
  const actualdx = clampedleft - starttableft

  draggingtab.style.transform = `translateX(${actualdx}px)`

  // leading edge crossing a neighbor's center claims its slot --------------------
  // using the dragged center meant wide tabs could never pass skinny ones at the ends
  const draggedleft = starttableft + actualdx
  const draggedright = draggedleft + tabwidth
  let newtarget = sourceindex

  if (actualdx > 0) {
    for (let i = sourceindex + 1; i < tabitems.length; i++) {
      if (draggedright > tabitems[i].center) newtarget = i
    }
  } else if (actualdx < 0) {
    for (let i = sourceindex - 1; i >= 0; i--) {
      if (draggedleft < tabitems[i].center) newtarget = i
    }
  }

  if (newtarget !== targetindex) {
    targetindex = newtarget
    const offsets = computeslotoffsets(sourceindex, targetindex, tabitems)

    // slide neighboring tabs smoothly into their temporary positions --------------------
    for (let i = 0; i < tabitems.length; i++) {
      if (i === sourceindex) continue
      tabitems[i].el.style.transform = `translateX(${offsets[i]}px)`
    }
  }

  // auto scroll tabs bar when dragging near edges --------------------
  if (editortabsbar && editortabsbar.scrollWidth > editortabsbar.clientWidth) {
    const barrect = editortabsbar.getBoundingClientRect()
    if (e.clientX < barrect.left + 45) {
      editortabsbar.scrollLeft -= 6
    } else if (e.clientX > barrect.right - 45) {
      editortabsbar.scrollLeft += 6
    }
  }
}

// finish tab drag and snap into final slot --------------------
function onpointerup(e) {
  if (!draggingtab) return

  const tab = draggingtab
  const tabid = tab.dataset.noteId

  if (!hasdragmoved) {
    // clean click without dragging switches active tab --------------------
    draggingtab = null
    sourceindex = -1
    targetindex = -1
    tabitems = []
    if (renderqueued) {
      renderqueued = false
      rendertabs()
    }
    if (tabid) {
      switchtotab(tabid)
    }
    return
  }

  // drop tab path into whatever text field is under the pointer --------------------
  const dropfield = findtextdropfield(e.clientX, e.clientY)
  if (dropfield && tabid && !(editortabsbar && editortabsbar.contains(dropfield))) {
    inserttextintofield(dropfield, gettabdragtext(tabid))
    cleartabdragstyles()
    draggingtab = null
    sourceindex = -1
    targetindex = -1
    tabitems = []
    hasdragmoved = false
    isanimatingsnap = false
    if (renderqueued) {
      renderqueued = false
      rendertabs()
    }
    return
  }

  isanimatingsnap = true
  document.body.classList.remove('is-dragging-tab')

  // compute final resting position for dragged tab --------------------
  const offsets = computeslotoffsets(sourceindex, targetindex, tabitems)
  const finaloffset = offsets[sourceindex]

  tab.style.transition = 'transform 0.18s cubic-bezier(0.2, 0, 0, 1)'
  tab.style.transform = `translateX(${finaloffset}px)`

  // update state array and re-render after snap finishes --------------------
  setTimeout(() => {
    if (sourceindex !== targetindex && sourceindex >= 0 && targetindex >= 0) {
      const moved = state.opentabs.splice(sourceindex, 1)[0]
      state.opentabs.splice(targetindex, 0, moved)
      moveslothistory(sourceindex, targetindex)
      saveworkspacestate()
    }

    draggingtab = null
    sourceindex = -1
    targetindex = -1
    tabitems = []
    hasdragmoved = false
    isanimatingsnap = false
    renderqueued = false

    rendertabs()
  }, 190)
}

// global pointer listeners for smooth continuous tracking --------------------
window.addEventListener('pointermove', onpointermove)
window.addEventListener('pointerup', onpointerup)
window.addEventListener('pointercancel', onpointerup)

// mouse wheel horizontal scrolling on tabs bar --------------------
if (editortabsbar) {
  editortabsbar.addEventListener('wheel', (e) => {
    if (e.deltaY !== 0) {
      e.preventDefault()
      editortabsbar.scrollLeft += e.deltaY
    }
  }, { passive: false })
}

// close specific tab --------------------
export function closetab(noteid) {
  const wasactive = isnoteidmatch(state.activenoteid, noteid)
  const index = state.opentabs.findIndex(t => isnoteidmatch(t, noteid))
  if (index === -1) {
    if (wasactive) {
      closenote()
    }
    return
  }

  stopmediafortabclose(noteid)
  removeslothistory(index)
  prunetabhistory(noteid)

  // remove tab and any matching duplicates --------------------
  state.opentabs.splice(index, 1)
  state.opentabs = state.opentabs.filter(t => !isnoteidmatch(t, noteid))
  synctabslothistories()

  if (wasactive) {
    if (state.opentabs.length > 0) {
      const nextindex = Math.min(index, state.opentabs.length - 1)
      switchtotab(state.opentabs[nextindex])
    } else {
      closenote()
    }
  } else {
    rendertabs()
    saveworkspacestate()
  }
}

// switch active tab without changing file picker directory --------------------
export function switchtotab(noteid) {
  opennote(noteid, { replacecurrent: false, newtab: false, force: true, switchfolder: false })
}
