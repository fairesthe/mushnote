import { state } from '../core/state.js'
import { Decoration, DecorationSet, CMDecoration } from './tiptap.bundle.js'
import {
  ed,
  tiptapeditorcontainer,
  noteeditor,
  pinpluginkey,
  setpineffect,
  clearpineffect
} from './editorshared.js'
import { ismarkdownfile } from './noteutils.js'

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
    const text = ed.cmview.state.sliceDoc(pin.from, pin.to).trim()
    if (!text) return null
    const linestart = ed.cmview.state.doc.lineAt(pin.from).number
    const lineend = ed.cmview.state.doc.lineAt(pin.to).number
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
  ed.cmview.dispatch({
    effects: setpineffect.of(CMDecoration.set([
      CMDecoration.mark({ from, to, class: 'editor-pinned-selection' })
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
let pendingeditorselectionref = null
let iseditoraskmenubound = false

function haseditorselection() {
  if (!state.activenoteid) return false
  if (readliveeditorselectionpin()) return true
  return Boolean(ed.pinnedselection)
}

function runeditorcopy() {
  if (!haseditorselection()) return

  if (ed.tiptapinstance && ismarkdownfile(state.activenoteid)) {
    const { from, to } = ed.tiptapinstance.state.selection
    const text = ed.tiptapinstance.state.doc.textBetween(from, to, '\n')
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
    const { from, to } = ed.tiptapinstance.state.selection
    const text = ed.tiptapinstance.state.doc.textBetween(from, to, '\n')
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
      ed.tiptapinstance.chain().focus().insertContent(text).run()
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

function updateeditorcontextmenuitems(hassel, hasaskai) {
  if (ctxitemeditorcut) ctxitemeditorcut.classList.toggle('disabled', !hassel)
  if (ctxitemeditorcopy) ctxitemeditorcopy.classList.toggle('disabled', !hassel)
  if (ctxitemaskai) ctxitemaskai.classList.toggle('hidden', !hasaskai)
}

function closeeditorcontextmenu() {
  if (editorcontextmenu) editorcontextmenu.classList.add('hidden')
  pendingeditorselectionref = null
}

export function openeditorselectionmenu(x, y, ref) {
  if (!editorcontextmenu || !state.activenoteid) return
  pendingeditorselectionref = ref
  updateeditorcontextmenuitems(haseditorselection(), !!ref)
  editorcontextmenu.style.left = `${x}px`
  editorcontextmenu.style.top = `${y}px`
  editorcontextmenu.classList.remove('hidden')
}

export function initeditoraskaimenu() {
  if (iseditoraskmenubound) return
  iseditoraskmenubound = true

  document.addEventListener('click', closeeditorcontextmenu)

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

  if (ctxitemaskai) {
    ctxitemaskai.addEventListener('click', (e) => {
      e.stopPropagation()
      const ref = pendingeditorselectionref
      closeeditorcontextmenu()
      if (!ref) return
      captureeditorselectionforai()
      window.dispatchEvent(new CustomEvent('mushnote-add-ai-reference', { detail: ref }))
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

