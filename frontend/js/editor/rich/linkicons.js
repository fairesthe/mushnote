import { state } from '../../core/state.js'
import {
  Extension,
  Decoration,
  DecorationSet,
  Plugin,
  PluginKey
} from './tiptap.bundle.js'
import { ed } from '../editorshared.js'
import { isexternalurl, isnoteidmatch, resolvenoteid } from '../noteutils.js'

export const linkiconspluginkey = new PluginKey('linkicons')

export function noteexists(noteid) {
  if (!noteid || !Array.isArray(state.allnotes)) return false
  return state.allnotes.some((n) => isnoteidmatch(n.note_id, noteid))
}

export function ismissingnotelink(href) {
  if (!href || isexternalurl(href)) return false
  const { noteid } = resolvenoteid(href)
  if (!noteid) return true
  return !noteexists(noteid)
}

function collectlinkranges(doc) {
  const ranges = []
  doc.descendants((node, pos) => {
    if (!node.isText) return
    const mark = node.marks.find((m) => m.type.name === 'link')
    if (!mark) return
    const from = pos
    const to = pos + node.nodeSize
    const href = mark.attrs.href || ''
    const last = ranges[ranges.length - 1]
    if (last && last.to === from && last.href === href) {
      last.to = to
      return
    }
    ranges.push({ from, to, href })
  })
  return ranges
}

function createlinkicon(href, missing) {
  const wrap = document.createElement('span')
  wrap.className = 'editor-link-icon' + (missing ? ' is-missing' : '')
  wrap.contentEditable = 'false'
  wrap.setAttribute('aria-hidden', 'true')
  const img = document.createElement('img')
  img.src = '/resources/icons/toolbar/link-tool.png'
  img.alt = ''
  img.draggable = false
  wrap.appendChild(img)
  wrap.title = missing ? 'missing note - click to create' : (isexternalurl(href) ? 'open link' : 'open note')
  return wrap
}

function buildlinkdecorations(doc) {
  const decos = []
  for (const range of collectlinkranges(doc)) {
    const missing = ismissingnotelink(range.href)
    if (missing) {
      decos.push(Decoration.inline(range.from, range.to, { class: 'is-missing-note' }))
    }
    decos.push(Decoration.widget(range.to, () => createlinkicon(range.href, missing), {
      side: 1,
      key: 'link-icon-' + range.from + '-' + range.to + '-' + (missing ? 'm' : 'o'),
    }))
  }
  return DecorationSet.create(doc, decos)
}

export function refreshlinkicons() {
  const editor = ed.tiptapinstance
  if (!editor?.view) return
  try {
    editor.view.dispatch(editor.state.tr.setMeta(linkiconspluginkey, { refresh: true }))
  } catch {}
}

export const linkiconsextension = Extension.create({
  name: 'linkicons',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: linkiconspluginkey,
        state: {
          init(_, { doc }) {
            return buildlinkdecorations(doc)
          },
          apply(tr, oldset, _old, state) {
            const meta = tr.getMeta(linkiconspluginkey)
            if (meta?.refresh || tr.docChanged) {
              return buildlinkdecorations(state.doc)
            }
            return oldset.map(tr.mapping, tr.doc)
          }
        },
        props: {
          decorations(editorstate) {
            return linkiconspluginkey.getState(editorstate)
          }
        }
      })
    ]
  }
})
