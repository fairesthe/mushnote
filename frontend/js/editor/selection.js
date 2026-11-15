import { state } from '../core/state.js'
import { Decoration, DecorationSet, CMDecoration, TextSelection, selectionmarkdown } from './rich/tiptap.bundle.js'
import {
  ed,
  tiptapeditorcontainer,
  noteeditor,
  pinpluginkey,
  setpineffect,
  clearpineffect
} from './editorshared.js'
import { ismarkdownfile } from './noteutils.js'

function gettiptapcopyrange() {
  if (!ed.tiptapinstance) return null
  const { from, to, empty } = ed.tiptapinstance.state.selection
  if (!empty && from !== to) return { from, to }
  if (ed.pinnedselection?.kind === 'tiptap') {
    const pin = ed.pinnedselection
    if (pin.from !== pin.to) return { from: pin.from, to: pin.to }
  }
  return null
}

function inserttiptapmarkdown(text) {
  const editor = ed.tiptapinstance
  if (!editor) return
  const parser = editor.storage?.markdown?.parser
  if (parser?.parse) {
    try {
      const html = parser.parse(text)
      editor.chain().focus().insertContent(html).run()
      return
    } catch {}
  }
  editor.chain().focus().insertContent(text).run()
}

function readliveeditorselectionpin() {
  if (!state.activenoteid) return null

  if (ed.tiptapinstance && ismarkdownfile(state.activenoteid)) {
    const { from, to, empty } = ed.tiptapinstance.state.selection
    if (empty || from === to) return null
    return { kind: 'tiptap', from, to }
  }

  if (ed.cmview) {
    const sel = ed.cmview.state.selection.main
    if (sel.from === sel.to) return null
    return { kind: 'cm', from: sel.from, to: sel.to }
  }

  if (noteeditor && !noteeditor.classList.contains('hidden')) {
    const start = noteeditor.selectionStart ?? 0
    const end = noteeditor.selectionEnd ?? 0
    if (start === end) return null
    return { kind: 'plain', start, end }
  }

  return null
}

function buildselectionreferencefrompin(pin) {
  if (!pin || !state.activenoteid) return null
  const notelabel = state.activenoteid.split('/').pop() || state.activenoteid

  if (pin.kind === 'tiptap' && ed.tiptapinstance) {
    const { from, to } = pin
    const text = ed.tiptapinstance.state.doc.textBetween(from, to, '\n').trim()
    if (!text) return null
    const before = ed.tiptapinstance.state.doc.textBetween(0, from, '\n')
    const selected = ed.tiptapinstance.state.doc.textBetween(from, to, '\n')
    const linestart = (before.match(/\n/g) || []).length + 1
    const lineend = linestart + (selected.match(/\n/g) || []).length
    return {
      type: 'reference',
      refKind: 'selection',
      name: linestart === lineend ? `${notelabel}:${linestart}` : `${notelabel}:${linestart}-${lineend}`,
      path: state.activenoteid,
      text,
      lineStart: linestart,
      lineEnd: lineend
    }
  }

  if (pin.kind === 'cm' && ed.cmview) {
    try {
      const doclen = ed.cmview.state.doc.length
      const from = Math.max(0, Math.min(pin.from, doclen))
      const to = Math.max(from, Math.min(pin.to, doclen))
      if (from === to) return null
      const text = ed.cmview.state.sliceDoc(from, to).trim()
      if (!text) return null
      const linestart = ed.cmview.state.doc.lineAt(from).number
      const lineend = ed.cmview.state.doc.lineAt(Math.max(from, to - 1)).number
      return {
        type: 'reference',
        refKind: 'selection',
        name: linestart === lineend ? `${notelabel}:${linestart}` : `${notelabel}:${linestart}-${lineend}`,
        path: state.activenoteid,
        text,
        lineStart: linestart,
        lineEnd: lineend
      }
    } catch {
      return null
    }
  }

  if (pin.kind === 'plain' && noteeditor) {
    const text = noteeditor.value.slice(pin.start, pin.end).trim()
    if (!text) return null
    const before = noteeditor.value.slice(0, pin.start)
    const chunk = noteeditor.value.slice(pin.start, pin.end)
    const linestart = (before.match(/\n/g) || []).length + 1
    const lineend = linestart + (chunk.match(/\n/g) || []).length
    return {
      type: 'reference',
      refKind: 'selection',
      name: linestart === lineend ? `${notelabel}:${linestart}` : `${notelabel}:${linestart}-${lineend}`,
      path: state.activenoteid,
      text,
      lineStart: linestart,
      lineEnd: lineend
    }
  }

  return null
}

function renderpinnedtiptap(from, to) {
  if (!ed.tiptapinstance) return
  const doc = ed.tiptapinstance.state.doc
  const decos = []
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return
    const nfrom = Math.max(from, pos)
    const nto = Math.min(to, pos + node.nodeSize)
    if (nfrom < nto) {
      decos.push(Decoration.inline(nfrom, nto, { class: 'editor-pinned-selection' }))
    }
  })
  if (!decos.length) return
  const set = DecorationSet.create(doc, decos)
  const tr = ed.tiptapinstance.state.tr.setMeta(pinpluginkey, { action: 'set', decorations: set })
  ed.tiptapinstance.view.dispatch(tr)
}

function clearpinnedtiptap() {
  if (!ed.tiptapinstance) return
  try {
    const tr = ed.tiptapinstance.state.tr.setMeta(pinpluginkey, { action: 'clear' })
    ed.tiptapinstance.view.dispatch(tr)
  } catch {}
}

function renderpinnedcm(from, to) {
  if (!ed.cmview) return
  const doclen = ed.cmview.state.doc.length
  const a = Math.max(0, Math.min(from, doclen))
  const b = Math.max(a, Math.min(to, doclen))
  if (a === b) return
  ed.cmview.dispatch({
    effects: setpineffect.of(CMDecoration.set([
      CMDecoration.mark({ class: 'editor-pinned-selection' }).range(a, b)
    ], true))
  })
}

function clearpinnedcm() {
  if (!ed.cmview) return
  try {
    ed.cmview.dispatch({ effects: clearpineffect.of(null) })
  } catch {}
}

export function clearpinnededitorselection() {
  ed.pinnedselection = null
  clearpinnedtiptap()
  clearpinnedcm()
  tiptapeditorcontainer?.classList.remove('has-pinned-selection')
}

function renderpinnededitorselection() {
  if (!ed.pinnedselection) return
  clearpinnedtiptap()
  clearpinnedcm()
  if (ed.pinnedselection.kind === 'tiptap') {
    renderpinnedtiptap(ed.pinnedselection.from, ed.pinnedselection.to)
    tiptapeditorcontainer?.classList.add('has-pinned-selection')
  } else if (ed.pinnedselection.kind === 'cm') {
    renderpinnedcm(ed.pinnedselection.from, ed.pinnedselection.to)
  }
}

// pin highlight when focus moves to ai column --------------------
export function captureeditorselectionforai() {
  const live = readliveeditorselectionpin()
  if (live) {
    ed.pinnedselection = live
  } else if (!ed.pinnedselection) {
    return false
  }
  renderpinnededitorselection()
  return true
}

// build reference payload from current editor text selection --------------------
export function geteditorselectionreference() {
  const live = readliveeditorselectionpin()
  if (live) return buildselectionreferencefrompin(live)
  if (ed.pinnedselection) return buildselectionreferencefrompin(ed.pinnedselection)
  return null
}

const editorcontextmenu = document.getElementById('editor-context-menu')
const ctxitemeditorcut = document.getElementById('ctx-item-editor-cut')
const ctxitemeditorcopy = document.getElementById('ctx-item-editor-copy')
const ctxitemeditorpaste = document.getElementById('ctx-item-editor-paste')
const ctxitemaskai = document.getElementById('ctx-item-ask-ai')
const ctxitemtableaddrow = document.getElementById('ctx-item-table-add-row')
const ctxitemtableaddcolumn = document.getElementById('ctx-item-table-add-column')
const ctxitemtableremoverow = document.getElementById('ctx-item-table-remove-row')
const ctxitemtableremovecolumn = document.getElementById('ctx-item-table-remove-column')
let editorcontextintable = false
let pendingtablepos = null
let pendingeditorselectionref = null
let iseditoraskmenubound = false
let ignoreeditorctxclickuntil = 0

function runtableaction(command) {
  if (!ed.tiptapinstance) return
  const clickpos = pendingtablepos
  closeeditorcontextmenu()
  if (clickpos != null) {
    try {
      const view = ed.tiptapinstance.view
      const $pos = view.state.doc.resolve(clickpos)
      view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)))
    } catch {}
  }
  if (!ed.tiptapinstance.isActive('table')) return
  ed.tiptapinstance.chain().focus()[command]().run()
}

function haseditorselection() {
  if (!state.activenoteid) return false
  if (readliveeditorselectionpin()) return true
  return Boolean(ed.pinnedselection)
}

function runeditorcopy() {
  if (!haseditorselection()) return

  if (ed.tiptapinstance && ismarkdownfile(state.activenoteid)) {
    const range = gettiptapcopyrange()
    if (!range) return
    const text = selectionmarkdown(ed.tiptapinstance, range.from, range.to)
    void navigator.clipboard.writeText(text).catch(() => {
      ed.tiptapinstance.chain().focus().run()
      document.execCommand('copy')
    })
    return
  }

  if (ed.cmview) {
    const sel = ed.cmview.state.selection.main
    const text = ed.cmview.state.sliceDoc(sel.from, sel.to)
    void navigator.clipboard.writeText(text)
    return
  }

  if (noteeditor && !noteeditor.classList.contains('hidden')) {
    const start = noteeditor.selectionStart ?? 0
    const end = noteeditor.selectionEnd ?? 0
    const text = noteeditor.value.slice(start, end)
    void navigator.clipboard.writeText(text).catch(() => {
      noteeditor.focus()
      document.execCommand('copy')
    })
  }
}

function runeditorcut() {
  if (!haseditorselection()) return

  if (ed.tiptapinstance && ismarkdownfile(state.activenoteid)) {
    const range = gettiptapcopyrange()
    if (!range) return
    const { from, to } = range
    const text = selectionmarkdown(ed.tiptapinstance, from, to)
    void navigator.clipboard.writeText(text).then(() => {
      ed.tiptapinstance.chain().focus().deleteRange({ from, to }).run()
    }).catch(() => {
      ed.tiptapinstance.chain().focus().run()
      if (document.execCommand('cut')) return
      ed.tiptapinstance.chain().focus().deleteRange({ from, to }).run()
    })
    return
  }

  if (ed.cmview) {
    const sel = ed.cmview.state.selection.main
    const text = ed.cmview.state.sliceDoc(sel.from, sel.to)
    void navigator.clipboard.writeText(text).then(() => {
      ed.cmview.dispatch({
        changes: { from: sel.from, to: sel.to, insert: '' },
        selection: { anchor: sel.from }
      })
    })
    return
  }

  if (noteeditor && !noteeditor.classList.contains('hidden')) {
    const start = noteeditor.selectionStart ?? 0
    const end = noteeditor.selectionEnd ?? 0
    const text = noteeditor.value.slice(start, end)
    void navigator.clipboard.writeText(text).then(() => {
      const val = noteeditor.value
      noteeditor.value = val.slice(0, start) + val.slice(end)
      noteeditor.selectionStart = noteeditor.selectionEnd = start
      noteeditor.dispatchEvent(new Event('input', { bubbles: true }))
    }).catch(() => {
      noteeditor.focus()
      document.execCommand('cut')
    })
  }
}

function runeditorpaste() {
  const pastetext = (text) => {
    if (typeof text !== 'string') return

    if (ed.tiptapinstance && ismarkdownfile(state.activenoteid)) {
      inserttiptapmarkdown(text)
      return
    }

    if (ed.cmview) {
      const sel = ed.cmview.state.selection.main
      ed.cmview.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text },
        selection: { anchor: sel.from + text.length }
      })
      ed.cmview.focus()
      return
    }

    if (noteeditor && !noteeditor.classList.contains('hidden')) {
      const start = noteeditor.selectionStart ?? 0
      const end = noteeditor.selectionEnd ?? 0
      const val = noteeditor.value
      noteeditor.value = val.slice(0, start) + text + val.slice(end)
      const caret = start + text.length
      noteeditor.selectionStart = noteeditor.selectionEnd = caret
      noteeditor.focus()
      noteeditor.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }

  void navigator.clipboard.readText().then(pastetext).catch(() => {
    if (ed.tiptapinstance && ismarkdownfile(state.activenoteid)) {
      ed.tiptapinstance.chain().focus().run()
    } else if (ed.cmview) {
      ed.cmview.focus()
    } else if (noteeditor) {
      noteeditor.focus()
    }
    document.execCommand('paste')
  })
}

function updateeditorcontextmenuitems(hassel, hasaskai, intable = false) {
  if (ctxitemeditorcut) ctxitemeditorcut.classList.toggle('disabled', !hassel)
  if (ctxitemeditorcopy) ctxitemeditorcopy.classList.toggle('disabled', !hassel)
  if (ctxitemaskai) ctxitemaskai.classList.toggle('hidden', !hasaskai)
  if (ctxitemtableaddrow) ctxitemtableaddrow.classList.toggle('hidden', !intable)
  if (ctxitemtableaddcolumn) ctxitemtableaddcolumn.classList.toggle('hidden', !intable)
  if (ctxitemtableremoverow) ctxitemtableremoverow.classList.toggle('hidden', !intable)
  if (ctxitemtableremovecolumn) ctxitemtableremovecolumn.classList.toggle('hidden', !intable)
}

export function closeeditorcontextmenu() {
  if (editorcontextmenu) editorcontextmenu.classList.add('hidden')
  pendingeditorselectionref = null
  editorcontextintable = false
  pendingtablepos = null
}

export function openeditorselectionmenu(x, y, ref, options = {}) {
  if (!editorcontextmenu || !state.activenoteid) return
  // some browsers fire a click right after contextmenu --------------------
  ignoreeditorctxclickuntil = Date.now() + 400
  // pin live selection so ask still works after right click collapses caret --------------------
  const live = readliveeditorselectionpin()
  if (live) ed.pinnedselection = live
  pendingeditorselectionref = ref || (ed.pinnedselection && buildselectionreferencefrompin(ed.pinnedselection)) || null
  editorcontextintable = Boolean(options.intable)
  pendingtablepos = typeof options.tablepos === 'number' ? options.tablepos : null
  updateeditorcontextmenuitems(haseditorselection(), !!pendingeditorselectionref, editorcontextintable)
  editorcontextmenu.style.left = `${x}px`
  editorcontextmenu.style.top = `${y}px`
  editorcontextmenu.classList.remove('hidden')
  // pin render after menu is up so a cm dispatch mid-contextmenu cant kill the menu --------------------
  if (ed.pinnedselection) {
    try {
      renderpinnededitorselection()
    } catch {}
  }
}

function runaskaifrommenu(e) {
  e.preventDefault()
  e.stopPropagation()
  const ref = pendingeditorselectionref || geteditorselectionreference()
  closeeditorcontextmenu()
  if (!ref) return
  try {
    captureeditorselectionforai()
  } catch {}
  window.dispatchEvent(new CustomEvent('mushnote-add-ai-reference', { detail: ref }))
}

export function initeditoraskaimenu() {
  if (iseditoraskmenubound) return
  iseditoraskmenubound = true

  // keep editor selection when interacting with the menu --------------------
  if (editorcontextmenu) {
    editorcontextmenu.addEventListener('mousedown', (e) => {
      e.preventDefault()
    })
  }

  document.addEventListener('click', (e) => {
    if (Date.now() < ignoreeditorctxclickuntil) return
    if (editorcontextmenu && !editorcontextmenu.classList.contains('hidden') && editorcontextmenu.contains(e.target)) return
    closeeditorcontextmenu()
  })

  if (ctxitemeditorcut) {
    ctxitemeditorcut.addEventListener('click', (e) => {
      e.stopPropagation()
      if (ctxitemeditorcut.classList.contains('disabled')) return
      closeeditorcontextmenu()
      runeditorcut()
    })
  }

  if (ctxitemeditorcopy) {
    ctxitemeditorcopy.addEventListener('click', (e) => {
      e.stopPropagation()
      if (ctxitemeditorcopy.classList.contains('disabled')) return
      closeeditorcontextmenu()
      runeditorcopy()
    })
  }

  if (ctxitemeditorpaste) {
    ctxitemeditorpaste.addEventListener('click', (e) => {
      e.stopPropagation()
      closeeditorcontextmenu()
      runeditorpaste()
    })
  }

  // mousedown so it fires even when menu preventDefault suppresses click quirks --------------------
  if (ctxitemaskai) {
    ctxitemaskai.addEventListener('mousedown', runaskaifrommenu)
  }

  if (ctxitemtableaddrow) {
    ctxitemtableaddrow.addEventListener('click', (e) => {
      e.stopPropagation()
      if (ctxitemtableaddrow.classList.contains('hidden')) return
      runtableaction('addRowAfter')
    })
  }

  if (ctxitemtableaddcolumn) {
    ctxitemtableaddcolumn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (ctxitemtableaddcolumn.classList.contains('hidden')) return
      runtableaction('addColumnAfter')
    })
  }

  if (ctxitemtableremoverow) {
    ctxitemtableremoverow.addEventListener('click', (e) => {
      e.stopPropagation()
      if (ctxitemtableremoverow.classList.contains('hidden')) return
      runtableaction('deleteRow')
    })
  }

  if (ctxitemtableremovecolumn) {
    ctxitemtableremovecolumn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (ctxitemtableremovecolumn.classList.contains('hidden')) return
      runtableaction('deleteColumn')
    })
  }
}

export function initeditorselectionpin() {
  if (ed.iseditorpinbound) return
  ed.iseditorpinbound = true

  const attach = (el) => {
    if (!el) return
    el.addEventListener('mousedown', () => {
      captureeditorselectionforai()
    }, true)
  }

  attach(document.getElementById('ai-drawer'))
  attach(document.getElementById('resizer-right'))
  attach(document.getElementById('tab-toggle-ai'))
}

