import { state } from '../core/state.js'
import { opennote, closenote, saveworkspacestate, isnoteidmatch, formatdraginsert, getdraggeditem, insertcontentintoactivenote, stopmediafortabclose } from '../editor/editor.js'

function getpreviewtablabel(tabnoteid, fallbackname) {
  const stored = state.previewtitles?.[tabnoteid]
  const label = stored || fallbackname
  return `web: ${label}`
}

// dom elements for tabs --------------------
const editortabsbar = document.getElementById('editor-tabs-bar')
const tabstrack = document.getElementById('tabs-track')

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

  // rebuilding mid drag yanks the tab out from under the pointer so wait for the drop --------------------
  if (draggingtab) {
    renderqueued = true
    return
  }

  // hide tab bar if no tabs open --------------------
  if (state.opentabs.length === 0) {
    editortabsbar.classList.add('hidden')
    tabstrack.innerHTML = ''
    return
  }

  editortabsbar.classList.remove('hidden')
  tabstrack.innerHTML = ''

  for (let i = 0; i < state.opentabs.length; i++) {
    const tabnoteid = state.opentabs[i]
    const ispreview = tabnoteid.startsWith('preview:')
    const rawid = ispreview ? tabnoteid.slice('preview:'.length) : tabnoteid
    let tabname = rawid.split('/').pop() || rawid
    if (!ispreview && !tabname.includes('.')) {
      tabname = `${tabname}.md`
    }
    const displayname = ispreview ? getpreviewtablabel(tabnoteid, tabname) : tabname

    const tab = document.createElement('div')
    tab.className = `editor-tab ${isnoteidmatch(tabnoteid, state.activenoteid) ? 'active' : ''}`
    tab.dataset.index = i
    tab.dataset.noteId = tabnoteid
    tab.title = displayname

    tab.innerHTML = `
      <span class="tab-title">${displayname}</span>
      <span class="tab-close" title="close tab">×</span>
    `

    // close tab on close button click --------------------
    const btnclose = tab.querySelector('.tab-close')
    btnclose.addEventListener('click', (e) => {
      e.stopPropagation()
      closetab(tabnoteid)
    })

    // initiate smooth pointer drag on tab --------------------
    tab.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      if (e.target.closest('.tab-close')) return
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
      const dragitem = state.activefiledrag || getdraggeditem(e)
      if (!dragitem) return
      e.preventDefault()
      e.stopPropagation()

      await opennote(tabnoteid, { replacecurrent: false, switchfolder: false })
      const insertinfo = formatdraginsert(dragitem)
      insertcontentintoactivenote(insertinfo)
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

  // remove tab and any matching duplicates --------------------
  state.opentabs.splice(index, 1)
  state.opentabs = state.opentabs.filter(t => !isnoteidmatch(t, noteid))

  if (wasactive) {
    if (state.opentabs.length > 0) {
      // switch to neighbor tab --------------------
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
