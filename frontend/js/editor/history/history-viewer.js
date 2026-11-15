import { api } from '../../core/api.js'
import { state } from '../../core/state.js'
import { loadnotes } from '../../workspace/files.js'
import {
  showhistoryrevisionpreview,
  reloadactivenoteafterhistory,
  sethistorypreviewactive,
  showdeletednoteshell,
  closenote
} from '../editor.js'

const btneditorhistory = document.getElementById('btn-editor-history')
const btncodehistory = document.getElementById('btn-code-editor-history')
const historyrevlist = document.getElementById('history-rev-list')
const historydeletedbadge = document.getElementById('history-deleted-badge')
const btnhistoryrestore = document.getElementById('btn-history-restore')
const historypreviewmeta = document.getElementById('history-preview-meta')
const historymodebtns = document.querySelectorAll('.history-mode-btn')
const editorbody = document.querySelector('.editor-body')

const historymodekey = 'mushnote-history-mode'
const maxstackavatars = 2

let historyopen = false
let historymode = localStorage.getItem(historymodekey) === 'all' ? 'all' : 'hourly'
let timelineitems = []
let revisioncontentcache = new Map()
let selecteditemid = null
let selectedrevisionid = null
let notemissing = false
let bound = false

function authoravatar(author) {
  if (!author || author === 'external') return '/resources/icons/general/external.png'
  if (state.useravatarmap?.[author]) return state.useravatarmap[author]
  if (author === 'ai' || author === state.aiuserid) {
    return state.aiavatar || '/resources/icons/general/bot.png'
  }
  return '/resources/icons/general/unknown-user.png'
}

function formattime(ts) {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return ''
  }
}

// hourly rows read like "nov 14, 9 pm" --------------------
function formathour(ts) {
  try {
    return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' }).toLowerCase()
  } catch {
    return ''
  }
}

function sethistorybtnactive(on) {
  btneditorhistory?.classList.toggle('is-active', on)
  btncodehistory?.classList.toggle('is-active', on)
}

function syncmodebuttons() {
  historymodebtns.forEach(btn => btn.classList.toggle('active', btn.dataset.mode === historymode))
}

function sethistoryuivisible(on) {
  historyopen = on
  editorbody?.classList.toggle('history-mode', on)
  sethistorybtnactive(on)
  if (!on) {
    selecteditemid = null
    selectedrevisionid = null
    if (btnhistoryrestore) btnhistoryrestore.disabled = true
    historypreviewmeta?.classList.add('hidden')
    sethistorypreviewactive(false)
  }
}

export function closerevisionhistoryview() {
  if (!historyopen) return
  sethistoryuivisible(false)
  // nothing on disk to go back to so just clear the editor --------------------
  if (notemissing) {
    closenote()
    return
  }
  reloadactivenoteafterhistory()
}

async function fetchtimeline(noteid) {
  const hourly = historymode === 'hourly' ? `&hourly=1&tz=${new Date().getTimezoneOffset()}` : ''
  const data = await api(`/api/history?id=${encodeURIComponent(noteid)}&timeline=1&limit=120${hourly}`)
  timelineitems = Array.isArray(data.timeline) ? data.timeline : []
  notemissing = Boolean(data.note_missing)
  revisioncontentcache = new Map()
}

async function getrevisioncontent(revid) {
  if (!revid) return null
  if (revisioncontentcache.has(revid)) return revisioncontentcache.get(revid)
  const data = await api(`/api/history/revision/${encodeURIComponent(revid)}`)
  const rev = data.revision
  revisioncontentcache.set(revid, rev)
  return rev
}

async function findpriorrevisioncontent(fromindex) {
  for (let i = fromindex + 1; i < timelineitems.length; i++) {
    const item = timelineitems[i]
    if (item.kind !== 'revision') continue
    const oldrev = await getrevisioncontent(item.id)
    return oldrev?.content ?? null
  }
  return null
}

// green adds, red removes and how many lines got touched --------------------
function statpart(classname, text) {
  const span = document.createElement('span')
  span.className = classname
  span.textContent = text
  return span
}

function describelines(stat) {
  const plural = stat.lines === 1 ? 'line' : 'lines'
  if (!stat.removed) return `(${stat.lines} ${plural} added)`
  if (!stat.added) return `(${stat.lines} ${plural} removed)`
  return `(${stat.lines} ${plural} edited)`
}

function buildrevisionstat(stat) {
  const row = document.createElement('div')
  row.className = 'history-rev-stat'
  if (stat.whitespace) {
    row.appendChild(statpart('history-stat-lines', 'spacing only'))
    return row
  }
  if (stat.added) row.appendChild(statpart('history-stat-add', `+${stat.added}`))
  if (stat.removed) row.appendChild(statpart('history-stat-del', `-${stat.removed}`))
  if (stat.lines) row.appendChild(statpart('history-stat-lines', describelines(stat)))
  return row
}

// avatars --------------------
function buildavatar(author) {
  const img = document.createElement('img')
  img.className = 'history-rev-avatar'
  img.src = authoravatar(author)
  img.alt = author || 'user'
  img.title = author || 'unknown'
  img.onerror = () => {
    img.src = '/resources/icons/general/unknown-user.png'
  }
  return img
}

// two overlapping faces then a +n bubble for everyone else --------------------
function buildavatarstack(authors) {
  const stack = document.createElement('div')
  stack.className = 'history-avatar-stack'
  for (const author of authors.slice(0, maxstackavatars)) stack.appendChild(buildavatar(author))
  const extra = authors.length - maxstackavatars
  if (extra > 0) {
    const more = document.createElement('span')
    more.className = 'history-avatar-more'
    more.textContent = `+${extra}`
    more.title = authors.slice(maxstackavatars).join(', ')
    stack.appendChild(more)
  }
  return stack
}

function describeauthors(authors) {
  if (authors.length <= maxstackavatars) return authors.join(', ')
  return `${authors.slice(0, maxstackavatars).join(', ')} and ${authors.length - maxstackavatars} more`
}

function buildmeta(item) {
  const meta = document.createElement('div')
  meta.className = 'history-rev-meta'
  const author = document.createElement('span')
  author.className = 'history-rev-author'
  author.textContent = item.kind === 'group' ? describeauthors(item.authors) : (item.author || 'unknown')
  meta.appendChild(author)
  const count = item.kind === 'group' && item.revision_ids.length > 1 ? ` (${item.revision_ids.length} saves)` : ''
  const when = item.kind === 'group' ? formathour(item.timestamp) : formattime(item.timestamp)
  meta.appendChild(document.createTextNode(` \u00b7 ${when}${count}`))
  return meta
}

function markactiverow(row) {
  historyrevlist.querySelectorAll('.history-rev-item').forEach((el) => el.classList.remove('active'))
  row?.classList.add('active')
}

function renderrevisionlist() {
  if (!historyrevlist) return
  historyrevlist.innerHTML = ''

  for (const item of timelineitems) {
    const row = document.createElement('div')
    row.className = `history-rev-item${item.kind === 'event' ? ' history-rev-event' : ''}`
    row.dataset.itemId = item.id
    if (selecteditemid && item.id === selecteditemid) row.classList.add('active')

    const body = document.createElement('div')
    body.className = 'history-rev-body'
    body.appendChild(buildmeta(item))

    if (item.kind !== 'event' && item.stat) {
      body.appendChild(buildrevisionstat(item.stat))
    } else if (item.label) {
      const stat = document.createElement('div')
      stat.className = 'history-rev-stat'
      stat.textContent = item.label
      body.appendChild(stat)
    }

    if (item.kind === 'event' && item.preview) {
      const preview = document.createElement('div')
      preview.className = 'history-rev-preview'
      preview.textContent = item.preview
      body.appendChild(preview)
    }

    row.appendChild(item.kind === 'group' ? buildavatarstack(item.authors) : buildavatar(item.author))
    row.appendChild(body)

    row.addEventListener('click', () => {
      if (item.kind !== 'event') {
        selectitem(item)
        return
      }
      selecteditemid = item.id
      selectedrevisionid = null
      if (btnhistoryrestore) btnhistoryrestore.disabled = true
      historypreviewmeta?.classList.remove('hidden')
      if (historypreviewmeta) {
        historypreviewmeta.textContent = `${item.label || item.event_type} by ${item.author || 'unknown'} at ${formattime(item.timestamp)}`
      }
      markactiverow(row)
    })

    historyrevlist.appendChild(row)
  }
}

// works for single revisions and hourly groups --------------------
async function selectitem(item) {
  const isgroup = item.kind === 'group'
  selecteditemid = item.id
  selectedrevisionid = isgroup ? item.newest_id : item.id
  if (btnhistoryrestore) btnhistoryrestore.disabled = false

  const rev = await getrevisioncontent(selectedrevisionid)
  let prior = null
  if (isgroup) {
    prior = item.base_id ? (await getrevisioncontent(item.base_id))?.content ?? null : null
  } else {
    const idx = timelineitems.findIndex((t) => t.id === item.id)
    prior = idx >= 0 ? await findpriorrevisioncontent(idx) : null
  }

  showhistoryrevisionpreview({
    content: rev.content || '',
    priorcontent: prior,
    author: rev.author,
    noteid: state.activenoteid
  })

  markactiverow(historyrevlist.querySelector(`[data-item-id="${CSS.escape(item.id)}"]`))
  historypreviewmeta?.classList.remove('hidden')
  if (historypreviewmeta) {
    historypreviewmeta.textContent = isgroup
      ? `${item.revision_ids.length} saves by ${describeauthors(item.authors)} around ${formathour(item.timestamp)}`
      : `revision #${rev.id} by ${rev.author || 'unknown'} at ${formattime(rev.timestamp)}`
  }
}

async function selectfirstitem() {
  const first = timelineitems.find((t) => t.kind !== 'event')
  if (first) await selectitem(first)
}

async function openrevisionhistoryview() {
  const noteid = state.activenoteid
  if (!noteid) return

  try {
    await fetchtimeline(noteid)
  } catch (err) {
    console.error('failed to load note history', err)
    return
  }

  if (timelineitems.length === 0) {
    window.alert('no revision history for this note yet')
    return
  }

  historydeletedbadge?.classList.toggle('hidden', !notemissing)
  syncmodebuttons()
  sethistoryuivisible(true)
  renderrevisionlist()
  await selectfirstitem()
}

// entry point from the deleted history tracker --------------------
export async function opendeletednotehistory(noteid) {
  showdeletednoteshell(noteid)
  await openrevisionhistoryview()
}

async function sethistorymode(mode) {
  if (mode === historymode) return
  historymode = mode
  localStorage.setItem(historymodekey, mode)
  syncmodebuttons()
  if (!historyopen || !state.activenoteid) return
  selecteditemid = null
  selectedrevisionid = null
  await fetchtimeline(state.activenoteid)
  renderrevisionlist()
  await selectfirstitem()
}

async function togglehistoryview() {
  if (historyopen) {
    closerevisionhistoryview()
    return
  }
  await openrevisionhistoryview()
}

async function restorerevision() {
  if (!selectedrevisionid || !state.activenoteid) return
  const noteid = state.activenoteid
  const revlabel = `revision #${selectedrevisionid}`
  if (!window.confirm(`restore ${revlabel} into "${noteid}"?\n\ncurrent file content will be replaced`)) {
    return
  }

  try {
    await api('/api/history/restore', {
      method: 'POST',
      body: JSON.stringify({
        note_id: noteid,
        revision_id: selectedrevisionid
      })
    })
    notemissing = false
    historydeletedbadge?.classList.add('hidden')
    await loadnotes()
    closerevisionhistoryview()
  } catch (err) {
    console.error('restore failed', err)
    window.alert(err?.message || 'restore failed')
  }
}

export function inithistoryviewer() {
  if (bound) return
  bound = true

  btneditorhistory?.addEventListener('click', () => togglehistoryview())
  btncodehistory?.addEventListener('click', () => togglehistoryview())
  btnhistoryrestore?.addEventListener('click', () => restorerevision())
  historymodebtns.forEach(btn => btn.addEventListener('click', () => sethistorymode(btn.dataset.mode)))
  syncmodebuttons()

  window.addEventListener('mushnote-history-close', () => {
    if (historyopen) {
      sethistoryuivisible(false)
      sethistorypreviewactive(false)
      if (btnhistoryrestore) btnhistoryrestore.disabled = true
    }
  })

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && historyopen) {
      closerevisionhistoryview()
    }
  })
}
