import { hextorgba } from '../../core/api.js'
import { state } from '../../core/state.js'
import { rendertabs, remaptabhistory } from '../../workspace/tabs.js'
import { updateviewpagebutton, getpreviewtargetid, schedulepreviewreload } from '../../workspace/preview.js'
import {
  Decoration,
  DecorationSet,
  CMEditorState,
  CMDecoration,
  cmKeymap,
  cmHistory,
  CMPrec,
  yCollab,
  yUndoManagerKeymap,
  notecollabprovider,
  Y,
  ySyncPlugin,
  ySyncPluginKey,
  yUndoPlugin,
  yUndoPluginKey
} from '../rich/tiptap.bundle.js'
import {
  ed,
  remotecursormap,
  remoteselectionpluginkey,
  setremoteselectioneffect
} from '../editorshared.js'
import { ismarkdownfile, geteditormarkdown, isnoteidmatch } from '../noteutils.js'
import { expandrangeforsnapnodes, issnapnode } from '../rich/selectionsnap.js'
import { resolveauthorcolor } from './flash.js'
import { ishistorypreviewactive } from '../history/historypreview.js'
import { marksessioncreated, writespotseen, saveworkspacestate } from '../session.js'
import { refreshallremotecursors, clearallremotecursors, broadcastcursorposition } from './cursors.js'

export function schedulecursorbroadcast(head, anchor) {
  ed.lastcursorpayload = { head, anchor }
  if (ed.cursortimer) return
  ed.cursortimer = setTimeout(() => {
    ed.cursortimer = null
    if (!ed.lastcursorpayload) return
    const { head: h, anchor: a } = ed.lastcursorpayload
    broadcastcursorposition(h, a)
    refreshallremotecursors()
  }, 40)
}

function sendcurrentcursortopeers() {
  if (!collabpeerslive()) return
  if (ed.tiptapinstance && ismarkdownfile(state.activenoteid)) {
    const { head, anchor } = ed.tiptapinstance.state.selection
    broadcastcursorposition(head, anchor)
    return
  }
  if (ed.cmview) {
    const sel = ed.cmview.state.selection.main
    broadcastcursorposition(sel.head, sel.anchor)
  }
}

function handlevaultsocketmessage(data = {}) {
  if (data.type === 'cursor_query') {
    sendcurrentcursortopeers()
    return
  }

  // content arrives through yjs now, this only nudges web previews to reload --------------------
  if (data.type === 'edit_event') {
    const previewtarget = state.activenoteid?.startsWith('preview:')
      ? getpreviewtargetid(state.activenoteid)
      : null
    if (previewtarget && isnoteidmatch(data.note_id, previewtarget)) {
      schedulepreviewreload(data.note_id)
    }
    return
  }

  if (data.type === 'vault_changed') {
    if (data.action === 'create' && data.note_id) {
      marksessioncreated(data.note_id)
    }
    window.dispatchEvent(new CustomEvent('vault-changed', { detail: data }))
    return
  }

  if (data.type === 'note_renamed') {
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
      // server moved the live doc with us, just reconnect to the new name next time --------------------
      if (ed.collabprovider) ed.collabprovider.noteid = newid
      let newfilename = newid.split('/').pop() || newid
      if (!newfilename.includes('.')) {
        newfilename = `${newfilename}.md`
      }
      document.title = `${newfilename} - mushnote`
    }
    if (modified) {
      remaptabhistory(oldid, newid)
      rendertabs()
      updateviewpagebutton()
      saveworkspacestate()
    }
  }
}

function remoteselectionrange(data = {}) {
  const head = typeof data.head === 'number'
    ? data.head
    : (typeof data.to === 'number' ? data.to : null)
  const anchor = typeof data.anchor === 'number'
    ? data.anchor
    : (typeof data.from === 'number' ? data.from : head)
  if (head === null || anchor === null) return null
  const from = Math.min(anchor, head)
  const to = Math.max(anchor, head)
  return to > from ? { from, to } : null
}

function buildremoteselectiondecos(doc) {
  const myid = state.currentuser?.id || state.currentuser?.user_id
  const decos = []
  for (const [author, data] of remotecursormap.entries()) {
    if (myid && author === myid) continue
    const range = remoteselectionrange(data)
    if (!range) continue
    const color = resolveauthorcolor(author)
    const style = `--remote-selection-bg: ${hextorgba(color, 0.32)};`
    // snap over charts tables and latex the same way local selection does --------------------
    const expanded = expandrangeforsnapnodes(doc, range.from, range.to)
    const from = Math.max(0, Math.min(expanded.from, doc.content.size))
    const to = Math.max(from, Math.min(expanded.to, doc.content.size))
    if (from >= to) continue
    decos.push(Decoration.inline(from, to, { class: 'remote-user-selection', style }))
    doc.nodesBetween(from, to, (node, pos) => {
      if (!issnapnode(node)) return true
      const end = pos + node.nodeSize
      if (from <= pos && to >= end) {
        decos.push(Decoration.node(pos, end, { class: 'remote-user-selection remote-user-selection-node', style }))
      }
      return node.type.name !== 'table'
    })
  }
  return DecorationSet.create(doc, decos)
}

export function refreshremoteselections() {
  if (ed.tiptapinstance && ismarkdownfile(state.activenoteid)) {
    const doc = ed.tiptapinstance.state.doc
    if (!doc) return
    try {
      const set = buildremoteselectiondecos(doc)
      const tr = ed.tiptapinstance.state.tr.setMeta(remoteselectionpluginkey, {
        action: 'set',
        decorations: set
      })
      ed.tiptapinstance.view.dispatch(tr)
    } catch {}
    return
  }

  if (!ed.cmview) return
  const myid = state.currentuser?.id || state.currentuser?.user_id
  const len = ed.cmview.state.doc.length
  const decos = []
  for (const [author, data] of remotecursormap.entries()) {
    if (myid && author === myid) continue
    const range = remoteselectionrange(data)
    if (!range) continue
    const color = resolveauthorcolor(author)
    const from = Math.max(0, Math.min(range.from, len))
    const to = Math.max(from, Math.min(range.to, len))
    if (from < to) {
      decos.push(CMDecoration.mark({
        from,
        to,
        class: 'remote-user-selection',
        attributes: { style: `--remote-selection-bg: ${hextorgba(color, 0.32)};` }
      }))
    }
  }
  try {
    ed.cmview.dispatch({
      effects: setremoteselectioneffect.of(CMDecoration.set(decos))
    })
  } catch {}
}

// live collab lifecycle --------------------
export function collabpeerslive() {
  if (ishistorypreviewactive()) return false
  return Boolean(ed.collabprovider?.peerslive)
}

// editors stay read only until the live doc lands so nothing typed gets eaten --------------------
function setnoteeditlock(locked) {
  if (ed.tiptapinstance) {
    try {
      ed.tiptapinstance.setEditable(!locked && !ishistorypreviewactive(), false)
    } catch {}
  }
  if (ed.cmview && ed.cmlockcompartment) {
    try {
      ed.cmview.dispatch({
        effects: ed.cmlockcompartment.reconfigure(locked ? CMEditorState.readOnly.of(true) : [])
      })
    } catch {}
  }
}

function textdiffchange(cur, next) {
  if (cur === next) return null
  let start = 0
  const max = Math.min(cur.length, next.length)
  while (start < max && cur.charCodeAt(start) === next.charCodeAt(start)) start++
  let curend = cur.length
  let nextend = next.length
  while (curend > start && nextend > start && cur.charCodeAt(curend - 1) === next.charCodeAt(nextend - 1)) {
    curend--
    nextend--
  }
  return { from: start, to: curend, insert: next.slice(start, nextend) }
}

function bindtiptapcollab(provider) {
  if (!ed.tiptapinstance || ed.collabbound) return false
  registertiptapcollab(provider)
  ed.collabbound = 'rich'
  return true
}

function registertiptapcollab(provider, attempt = 0) {
  const fragment = provider.ydoc.getXmlFragment('prosemirror')
  const syncplugin = ySyncPlugin(fragment)
  const undoplugin = yUndoPlugin()
  // sync plugin rerenders from the fragment on bind so the server version always wins --------------------
  try {
    ed.tiptapinstance.registerPlugin(syncplugin, (plugin, plugins) => [...plugins, plugin, undoplugin])
  } catch (err) {
    console.warn('collab plugin bind threw', err)
  }

  // if a plugin view blows up mid build the state keeps the plugins but the views never come back --------------------
  // no sync view means typing never hits yjs and undo has nothing to undo, so rebind fresh ones
  if (tiptapcollabviewsok() || attempt >= 2) return
  setTimeout(() => {
    if (ed.collabbound !== 'rich' || ed.collabprovider !== provider || !ed.tiptapinstance) return
    ed.tiptapinstance.unregisterPlugin([ySyncPluginKey, yUndoPluginKey])
    registertiptapcollab(provider, attempt + 1)
  }, 0)
}

function tiptapcollabviewsok() {
  const view = ed.tiptapinstance?.view
  if (!view?.pluginViews) return true
  return view.pluginViews.length >= view.state.plugins.filter((plugin) => plugin.spec.view).length
}

function bindcmcollab(provider) {
  if (!ed.cmview || ed.collabbound) return false
  const ytext = provider.ydoc.getText('content')
  const change = textdiffchange(ed.cmview.state.doc.toString(), ytext.toString())

  // line the editor up with ytext first, ycollab assumes they already match --------------------
  if (change) {
    ed.isremoteapplying = true
    try {
      ed.cmview.dispatch({ changes: change })
    } finally {
      ed.isremoteapplying = false
    }
  }

  ed.cmundomanager = new Y.UndoManager(ytext)
  ed.cmview.dispatch({
    effects: [
      ed.cmhistorycompartment.reconfigure([]),
      ed.cmcollabcompartment.reconfigure([
        CMPrec.high(cmKeymap.of(yUndoManagerKeymap)),
        yCollab(ytext, null, { undoManager: ed.cmundomanager })
      ])
    ]
  })
  ed.collabbound = 'text'
  return true
}

function unbindcollab() {
  if (ed.collabbound === 'rich' && ed.tiptapinstance) {
    try {
      ed.tiptapinstance.unregisterPlugin([ySyncPluginKey, yUndoPluginKey])
    } catch (err) {
      console.error('collab unbind failed', err)
    }
  }
  if (ed.collabbound === 'text' && ed.cmview) {
    try {
      ed.cmview.dispatch({
        effects: [
          ed.cmcollabcompartment.reconfigure([]),
          ed.cmhistorycompartment.reconfigure(cmHistory())
        ]
      })
    } catch {}
  }
  if (ed.cmundomanager) {
    ed.cmundomanager.destroy()
    ed.cmundomanager = null
  }
  if (ed.rawsyncunsub) {
    try { ed.rawsyncunsub() } catch {}
    ed.rawsyncunsub = null
  }
  ed.collabbound = null
}

function bindrawrichsync(provider, noteid) {
  let timer = null
  const onupdate = (_u, origin) => {
    if (origin === provider) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(async () => {
      timer = null
      if (ed.collabprovider !== provider || !ed.cmview) return
      try {
        const res = await fetch(`/api/note?id=${encodeURIComponent(noteid)}`, { credentials: 'same-origin' })
        if (!res.ok) return
        const data = await res.json()
        const next = data?.note?.content
        if (typeof next === 'string' && next !== ed.cmview.state.doc.toString()) {
          const sel = ed.cmview.state.selection.main
          ed.isremoteapplying = true
          ed.cmview.dispatch({
            changes: { from: 0, to: ed.cmview.state.doc.length, insert: next },
            selection: { anchor: Math.min(sel.anchor, next.length), head: Math.min(sel.head, next.length) }
          })
          setTimeout(() => { ed.isremoteapplying = false }, 30)
        }
      } catch {}
    }, 150)
  }
  provider.doc.on('update', onupdate)
  ed.rawsyncunsub = () => {
    if (timer) clearTimeout(timer)
    provider.doc.off('update', onupdate)
  }
  ed.collabbound = 'raw-rich'
  return true
}

function bindactiveeditor(provider) {
  const active = state.activenoteid
  if (!active || active.startsWith('preview:') || ishistorypreviewactive()) return
  if (!isnoteidmatch(provider.noteid, active)) return

  const isplainview = document.getElementById('editor-container')?.classList.contains('plain-mode')
  let bound = false
  if (provider.kind === 'rich' && ismarkdownfile(active)) {
    bound = isplainview ? bindrawrichsync(provider, active) : bindtiptapcollab(provider)
  } else if (provider.kind === 'text' && !ismarkdownfile(active)) {
    bound = bindcmcollab(provider)
  }
  if (!bound) return

  if (ed.collablocktimer) {
    clearTimeout(ed.collablocktimer)
    ed.collablocktimer = null
  }
  ed.fallbackedit = false
  setnoteeditlock(false)
}

export function stopnotecollab() {
  unbindcollab()
  if (ed.collabprovider) {
    ed.collabprovider.disconnect()
    ed.collabprovider = null
  }
  window.dispatchEvent(new CustomEvent('collab-peers-offline'))
  if (ed.collablocktimer) {
    clearTimeout(ed.collablocktimer)
    ed.collablocktimer = null
  }
  ed.fallbackedit = false
  remotecursormap.clear()
  clearallremotecursors()
  refreshremoteselections()
}

export function schedulespotseen(noteid) {
  if (ed.spotseentimer) clearTimeout(ed.spotseentimer)
  ed.spotseentimer = setTimeout(() => {
    ed.spotseentimer = null
    if (!isnoteidmatch(noteid, state.activenoteid)) return
    try {
      if (ismarkdownfile(noteid) && ed.tiptapinstance) writespotseen(noteid, geteditormarkdown(ed.tiptapinstance))
      else if (ed.cmview) writespotseen(noteid, ed.cmview.state.doc.toString())
    } catch (err) {
      console.error('spot seen write failed', err)
    }
  }, 400)
}

// connect websocket for per keystroke yjs sync and cursors --------------------
export function connectnotesocket(noteid) {
  stopnotecollab()

  const author = state.currentuser?.id || state.currentuser?.user_id || 'unknown'
  const provider = new notecollabprovider({
    noteid,
    author,
    onsynced: () => {
      if (ed.collabprovider === provider) bindactiveeditor(provider)
    },
    onepochchange: () => {
      // server started a fresh doc, merging into it would double every line --------------------
      if (ed.collabprovider === provider) connectnotesocket(provider.noteid)
    },
    onstatus: (status) => {
      window.dispatchEvent(new CustomEvent(
        status === 'online' ? 'collab-peers-online' : 'collab-peers-offline'
      ))
    },
    oncursor: (data) => {
      if (!data?.author) return
      remotecursormap.set(data.author, data)
      refreshallremotecursors()
      refreshremoteselections()
    },
    oncursorleave: (data) => {
      if (!data?.author) return
      remotecursormap.delete(data.author)
      refreshallremotecursors()
      refreshremoteselections()
    },
    onpeerready: () => sendcurrentcursortopeers(),
    onvaultevent: handlevaultsocketmessage
  })
  ed.collabprovider = provider

  const active = state.activenoteid || ''
  if (!active.startsWith('preview:') && !ishistorypreviewactive()) {
    setnoteeditlock(true)
    // no sync after a few secs means the socket is toast, let them type and save over rest --------------------
    ed.collablocktimer = setTimeout(() => {
      ed.collablocktimer = null
      if (ed.collabprovider !== provider || ed.collabbound) return
      ed.fallbackedit = true
      setnoteeditlock(false)
    }, 4000)
  }

  provider.connect()
}

