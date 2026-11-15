import { api } from '../core/api.js'
import { state } from '../core/state.js'
import { schedulepreviewreload } from '../app/preview.js'
import { detectlatex, detectmermaid, formatmermaidforpaste } from './tiptap.bundle.js'
import { ed, noteeditor, editorbackdrop } from './editorshared.js'
import { handleimagepaste } from './imageupload.js'
import { writespotseen } from './session.js'

// wire up plain text editor events once --------------------
export function initplaineditor() {
  if (ed.isplainbound || !noteeditor) return
  ed.isplainbound = true

  noteeditor.addEventListener('input', () => {
    const targetnoteid = state.activenoteid
    if (!targetnoteid) return
    writespotseen(targetnoteid, noteeditor.value)
    if (ed.savetimer) clearTimeout(ed.savetimer)
    ed.savetimer = setTimeout(async () => {
      try {
        await api('/api/notes', {
          method: 'POST',
          body: JSON.stringify({
            note_id: targetnoteid,
            content: noteeditor.value,
            author: state.currentuser ? state.currentuser.id : 'unknown'
          })
        })
        schedulepreviewreload(targetnoteid)
      } catch (err) {
        console.error('auto save failed', err)
      }
    }, 400)
  })

  noteeditor.addEventListener('scroll', () => {
    if (editorbackdrop) {
      editorbackdrop.scrollTop = noteeditor.scrollTop
      editorbackdrop.scrollLeft = noteeditor.scrollLeft
    }
  })

  noteeditor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault()
      const start = noteeditor.selectionStart
      const end = noteeditor.selectionEnd
      const val = noteeditor.value
      noteeditor.value = val.substring(0, start) + '  ' + val.substring(end)
      noteeditor.selectionStart = noteeditor.selectionEnd = start + 2
      noteeditor.dispatchEvent(new Event('input'))
    }
  })

  // handle pasted images or latex into plain editor --------------------
  noteeditor.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items
    if (items) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item && item.type && item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) {
            e.preventDefault()
            handleimagepaste(file)
            return
          }
        }
      }
    }

    const text = e.clipboardData?.getData('text/plain')
    if (!text) return

    const mermaidpaste = detectmermaid(text)
    if (mermaidpaste) {
      e.preventDefault()
      const formatted = formatmermaidforpaste(mermaidpaste.source)
      const start = noteeditor.selectionStart
      const end = noteeditor.selectionEnd
      const val = noteeditor.value
      noteeditor.value = val.substring(0, start) + formatted + val.substring(end)
      noteeditor.selectionStart = noteeditor.selectionEnd = start + formatted.length
      noteeditor.dispatchEvent(new Event('input'))
      return
    }

    const detected = detectlatex(text)
    if (!detected) return
    const trimmed = text.trim()
    if (!trimmed.startsWith('$') && !trimmed.startsWith('\\[')) {
      e.preventDefault()
      const formatted = detected.isblock ? `\n$$\n${detected.latex}\n$$\n` : `$${detected.latex}$`
      const start = noteeditor.selectionStart
      const end = noteeditor.selectionEnd
      const val = noteeditor.value
      noteeditor.value = val.substring(0, start) + formatted + val.substring(end)
      noteeditor.selectionStart = noteeditor.selectionEnd = start + formatted.length
      noteeditor.dispatchEvent(new Event('input'))
    }
  })
}

