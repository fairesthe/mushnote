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
      text: `[${title}](${path})`
    }
  }

  // paths otherwise for code files, folders, and plain text --------------------
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

