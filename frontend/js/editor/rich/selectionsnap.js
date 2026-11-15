import {
  Extension,
  Plugin,
  PluginKey,
  TextSelection,
  NodeSelection
} from './tiptap.bundle.js'

// blocks that should be grabbed whole when you select across them --------------------
export function issnapnode(node) {
  if (!node) return false
  const name = node.type.name
  if (name === 'blockMath' || name === 'inlineMath' || name === 'table') return true
  if (name === 'codeBlock' && String(node.attrs?.language || '').toLowerCase() === 'mermaid') return true
  return false
}

export function expandrangeforsnapnodes(doc, from, to) {
  if (!doc) return { from, to }
  let a = Math.min(from, to)
  let b = Math.max(from, to)
  if (a === b) return { from: a, to: b }

  let changed = true
  // loop so nested snaps (rare) settle --------------------
  while (changed) {
    changed = false
    doc.descendants((node, pos) => {
      if (!issnapnode(node)) return true
      const end = pos + node.nodeSize
      if (!(a < end && b > pos)) return true

      // keep editing inside mermaid source when both ends stay in the text --------------------
      if (node.type.name === 'codeBlock') {
        if (a >= pos + 1 && b <= end - 1) return false
      }

      // keep cell text selection local when both ends stay inside the table --------------------
      if (node.type.name === 'table') {
        if (a > pos && b < end) return false
      }

      const nexta = Math.min(a, pos)
      const nextb = Math.max(b, end)
      if (nexta !== a || nextb !== b) {
        a = nexta
        b = nextb
        changed = true
      }
      return false
    })
  }

  a = Math.max(0, Math.min(a, doc.content.size))
  b = Math.max(a, Math.min(b, doc.content.size))
  return { from: a, to: b }
}

function iscellselection(sel) {
  return Boolean(sel && (sel.$anchorCell || sel.$headCell || sel.constructor?.name === 'CellSelection'))
}

export const wholesnapselectionextension = Extension.create({
  name: 'wholesnapselection',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('wholesnapselection'),
        appendTransaction(transactions, _oldstate, newstate) {
          if (!transactions.some((tr) => tr.selectionSet)) return null
          const sel = newstate.selection
          if (!sel || sel.empty) return null
          if (sel instanceof NodeSelection) return null
          if (iscellselection(sel)) return null

          const { from, to } = sel
          const expanded = expandrangeforsnapnodes(newstate.doc, from, to)
          if (expanded.from === from && expanded.to === to) return null

          const forward = sel.head >= sel.anchor
          const anchor = forward ? expanded.from : expanded.to
          const head = forward ? expanded.to : expanded.from

          // single atom math node becomes a node selection --------------------
          const node = newstate.doc.nodeAt(expanded.from)
          if (
            node
            && issnapnode(node)
            && expanded.to === expanded.from + node.nodeSize
            && (node.isAtom || node.type.name === 'blockMath' || node.type.name === 'inlineMath')
          ) {
            try {
              return newstate.tr.setSelection(NodeSelection.create(newstate.doc, expanded.from))
            } catch {
              // fall through to text selection
            }
          }

          try {
            return newstate.tr.setSelection(TextSelection.create(newstate.doc, anchor, head))
          } catch {
            return null
          }
        }
      })
    ]
  }
})
