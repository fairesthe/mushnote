import { cleanmarkdown } from '../rich/tiptap.bundle.js'
import {
  ed,
  tiptapeditorcontainer,
  plaineditorwrap,
  noteeditor
} from '../editorshared.js'
import { ismarkdownfile } from '../noteutils.js'
import {
  resolveauthorcolor,
  rendercmflashhighlight,
  flashwholecmnote,
  cleareditorflashhighlights,
  flashwholenote,
  renderflashhighlight
} from '../collab/flash.js'
import { setcmcontent } from '../plain/codemirror.js'
import { stopnotecollab } from '../collab/collab.js'

let historypreviewactive = false

export function ishistorypreviewactive() {
  return historypreviewactive
}

function sethistorydomlock(on) {
  tiptapeditorcontainer?.classList.toggle('history-preview-lock', on)
  plaineditorwrap?.classList.toggle('history-preview-lock', on)
  document.getElementById('codemirror-editor')?.classList.toggle('history-preview-lock', on)
}

export function sethistorypreviewactive(on) {
  historypreviewactive = on
  // revision previews rewrite the editor so it must be cut loose from the live doc first --------------------
  if (on) stopnotecollab()
  sethistorydomlock(on)
  if (ed.tiptapinstance) {
    try {
      ed.tiptapinstance.setEditable(!on)
    } catch {}
  }
}

// show one revision in the editor with persistent diff marks --------------------
export function showhistoryrevisionpreview({ content, priorcontent, author, noteid }) {
  cleareditorflashhighlights()
  sethistorypreviewactive(true)
  const ismd = ismarkdownfile(noteid)
  const color = resolveauthorcolor(author)

  if (ismd && ed.tiptapinstance) {
    ed.isremoteapplying = true
    try {
      if (priorcontent !== null && priorcontent !== undefined) {
        ed.tiptapinstance.commands.setContent(cleanmarkdown(priorcontent), { emitUpdate: false })
        const olddoc = ed.tiptapinstance.state.doc
        ed.tiptapinstance.commands.setContent(cleanmarkdown(content), { emitUpdate: false })
        renderflashhighlight(olddoc, ed.tiptapinstance.state.doc, [], color, author, { persistent: true })
      } else {
        ed.tiptapinstance.commands.setContent(cleanmarkdown(content), { emitUpdate: false })
        flashwholenote(author, color, { persistent: true })
      }
    } finally {
      ed.isremoteapplying = false
    }
    return
  }

  if (ed.cmview) {
    setcmcontent(content, noteid)
    if (priorcontent !== null && priorcontent !== undefined) {
      rendercmflashhighlight(priorcontent, content, [], color, author, { persistent: true })
    } else {
      flashwholecmnote(author, color, { persistent: true })
    }
  } else if (noteeditor && !noteeditor.classList.contains('hidden')) {
    noteeditor.value = content
    noteeditor.readOnly = true
  }
}

