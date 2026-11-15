import { state } from '../core/state.js'
import { ed, noteeditor } from './editorshared.js'
import { ismarkdownfile } from './noteutils.js'

// format text or markdown tag to insert when dropping a file or folder into a note --------------------
export function formatdraginsert(item) {
  if (!item || !item.path) return { type: 'path', text: '' }
  const path = item.path
  const name = item.name || path.split('/').pop() || path
  const title = item.title || name

  const isimage = item.isimage || /\.(png|jpg|jpeg|gif|webp|svg|ico|bmp)$/i.test(path)
  const ismarkdown = item.ismarkdown || (item.type === 'file' && (path.endsWith('.md') || path.endsWith('.markdown')))
  const isfolder = item.type === 'folder'

  if (isimage) {
    const url = path.startsWith('media/') ? `/${path}` : `/api/raw?id=${encodeURIComponent(path)}`
    return {
      type: 'image',
      url,
      alt: name,
      text: `![${name}](${url})`
    }
  }

  if (ismarkdown) {
    return {
      type: 'link',
      url: path,
      label: title,
      text: `[${title}](${path})`
    }
  }

  // vault files become real links in md notes (not escaped bracket text) --------------------
  if (!isfolder && item.type === 'file') {
    return {
      type: 'link',
      url: path,
      label: name,
      text: `[${name}](${path})`
    }
  }

  // folders and plain path inserts --------------------
  return {
    type: 'path',
    text: path
  }
}

// extract dragged item data from event --------------------
export function getdraggeditem(e) {
  try {
    const raw = e?.dataTransfer?.getData('application/mushnote-item')
    if (raw) return JSON.parse(raw)
  } catch {}
  if (state.activefiledrag && e?.dataTransfer?.types?.includes('application/mushnote-item')) {
    return state.activefiledrag
  }
  return null
}

// one or many vault items from a sidebar drag --------------------
export function getdraggeditems(e) {
  const item = getdraggeditem(e) || state.activefiledrag
  if (!item) return []
  if (Array.isArray(item.items) && item.items.length) return item.items.filter((i) => i?.path)
  if (item.path) return [item]
  return []
}

// drop every dragged vault item into the open note --------------------
export function insertdraggeditemsintoactivenote(items) {
  const list = (items || []).filter((i) => i?.path)
  if (!list.length || !state.activenoteid) return

  const ismd = ismarkdownfile(state.activenoteid)
  for (let i = 0; i < list.length; i++) {
    insertcontentintoactivenote(formatdraginsert(list[i]))
    if (i >= list.length - 1) continue
    if (ismd && ed.tiptapinstance) {
      const sep = /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i.test(list[i].path || '') ? '\n' : ' '
      ed.tiptapinstance.chain().focus().insertContent(sep).run()
    } else if (ed.cmview) {
      const view = ed.cmview
      const pos = view.state.selection.main.head
      view.dispatch({
        changes: { from: pos, to: pos, insert: '\n' },
        selection: { anchor: pos + 1 }
      })
    }
  }
}

// clear all drag target visual indicators --------------------
export function clearalldraghighlights() {
  document.querySelectorAll('.drag-over, .is-drag-source').forEach(el => {
    el.classList.remove('drag-over', 'is-drag-source')
  })
}

// insert text, markdown link, or image into active note --------------------
export function insertcontentintoactivenote(insertinfo, pos = null) {
  if (!state.activenoteid || !insertinfo) return
  state.activefiledrag = null
  clearalldraghighlights()

  const ismd = ismarkdownfile(state.activenoteid)

  if (ismd && ed.tiptapinstance) {
    const editor = ed.tiptapinstance
    if (pos !== null && typeof pos === 'number') {
      try {
        editor.commands.setTextSelection(pos)
      } catch {}
    }
    if (insertinfo.type === 'image') {
      editor.chain().focus().setImage({ src: insertinfo.url, alt: insertinfo.alt || 'image' }).run()
    } else if (insertinfo.type === 'link' && insertinfo.url) {
      const label = insertinfo.label || insertinfo.alt || String(insertinfo.url).split('/').pop() || insertinfo.url
      editor.chain().focus().insertContent({
        type: 'text',
        text: label,
        marks: [{ type: 'link', attrs: { href: insertinfo.url } }]
      }).run()
    } else {
      editor.chain().focus().insertContent(insertinfo.text).run()
    }
    return
  }

  // code or plain text file in codemirror or textarea --------------------
  const text = insertinfo.text || insertinfo
  if (ed.cmview) {
    const view = ed.cmview
    let targetfrom = view.state.selection.main.from
    let targetto = view.state.selection.main.to
    if (pos !== null && typeof pos === 'number') {
      targetfrom = pos
      targetto = pos
    }
    view.dispatch({
      changes: { from: targetfrom, to: targetto, insert: text },
      selection: { anchor: targetfrom + text.length }
    })
    view.focus()
  } else if (noteeditor) {
    const start = noteeditor.selectionStart || 0
    const end = noteeditor.selectionEnd || 0
    noteeditor.setRangeText(text, start, end, 'end')
    noteeditor.dispatchEvent(new Event('input'))
    noteeditor.focus()
  }
}

