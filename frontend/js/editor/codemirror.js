import { api } from '../core/api.js'
import { state } from '../core/state.js'
import { schedulepreviewreload } from '../app/preview.js'
import {
  CMEditorView,
  CMEditorState,
  CMCompartment,
  cmLineNumbers,
  cmHighlightActiveLineGutter,
  cmHighlightActiveLine,
  cmKeymap,
  cmDefaultKeymap,
  cmHistory,
  cmHistoryKeymap,
  cmIndentWithTab,
  cmBracketMatching,
  cmFoldGutter,
  cmFoldKeymap,
  cmIndentOnInput,
  cmCloseBrackets,
  cmJavascript,
  cmHtml,
  cmCss,
  cmJson,
  cmPython,
  cmYaml,
  cmOneDark,
  ySyncAnnotation
} from './tiptap.bundle.js'
import { ed, remotecursormap } from './editorshared.js'
import { handleimagepaste } from './imageupload.js'
import {
  formatdraginsert,
  getdraggeditem,
  clearalldraghighlights,
  insertcontentintoactivenote
} from './dragdrop.js'
import { clearpinnededitorselection } from './selection.js'
import { queueremotecursorrefresh } from './tiptapplugins.js'
import {
  cmflashfield,
  cmpinfield,
  cmremoteselectionfield,
  cmliveflashfield,
  flashcmremotechanges
} from './cmplugins.js'
import { schedulecursorbroadcast, collabpeerslive, schedulespotseen } from './collab.js'

// resolve codemirror language extension based on file extension --------------------
export function getlanguageextension(filename) {
  if (!filename) return []
  const ext = (filename.split('.').pop() || '').toLowerCase()
  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
      return [cmJavascript()]
    case 'ts':
      return [cmJavascript({ typescript: true })]
    case 'jsx':
      return [cmJavascript({ jsx: true })]
    case 'tsx':
      return [cmJavascript({ jsx: true, typescript: true })]
    case 'html':
    case 'htm':
      return [cmHtml()]
    case 'css':
    case 'scss':
    case 'less':
      return [cmCss()]
    case 'json':
      return [cmJson()]
    case 'py':
      return [cmPython()]
    case 'yaml':
    case 'yml':
      return [cmYaml()]
    default:
      return []
  }
}

// initialize codemirror 6 editor for non-markdown code files --------------------
export function initcodemirror() {
  if (ed.cmview) return ed.cmview
  const container = document.getElementById('codemirror-editor')
  if (!container) return null

  ed.cmlanguagecompartment = new CMCompartment()
  ed.cmhistorycompartment = new CMCompartment()
  ed.cmcollabcompartment = new CMCompartment()
  ed.cmlockcompartment = new CMCompartment()

  const startstate = CMEditorState.create({
    doc: '',
    extensions: [
      cmLineNumbers(),
      cmHighlightActiveLineGutter(),
      cmHighlightActiveLine(),
      ed.cmhistorycompartment.of(cmHistory()),
      ed.cmcollabcompartment.of([]),
      ed.cmlockcompartment.of([]),
      cmliveflashfield,
      cmFoldGutter(),
      cmIndentOnInput(),
      cmBracketMatching(),
      cmCloseBrackets(),
      cmOneDark,
      CMEditorView.contentAttributes.of({
        spellcheck: 'false',
        autocorrect: 'off',
        autocapitalize: 'off',
        'data-gramm': 'false',
        'data-gramm_editor': 'false',
        'data-enable-grammarly': 'false',
      }),
      ed.cmlanguagecompartment.of([]),
      cmflashfield,
      cmpinfield,
      cmremoteselectionfield,
      cmKeymap.of([
        ...cmDefaultKeymap,
        ...cmHistoryKeymap,
        ...cmFoldKeymap,
        cmIndentWithTab
      ]),
      CMEditorView.domEventHandlers({
        paste(event, view) {
          const items = event.clipboardData?.items
          if (items) {
            for (let i = 0; i < items.length; i++) {
              const item = items[i]
              if (item && item.type && item.type.startsWith('image/')) {
                const file = item.getAsFile()
                if (file) {
                  event.preventDefault()
                  handleimagepaste(file)
                  return true
                }
              }
            }
          }
          return false
        },
        drop(event, view) {
          const dragitem = getdraggeditem(event)
          if (dragitem) {
            event.preventDefault()
            event.stopPropagation()
            state.activefiledrag = null
            clearalldraghighlights()
            const droppos = view.posAtCoords({ x: event.clientX, y: event.clientY })
            const insertinfo = formatdraginsert(dragitem)
            insertcontentintoactivenote(insertinfo, typeof droppos?.pos === 'number' ? droppos.pos : null)
            return true
          }
          const files = event.dataTransfer?.files
          if (files && files.length > 0) {
            for (let i = 0; i < files.length; i++) {
              if (files[i].type && files[i].type.startsWith('image/')) {
                event.preventDefault()
                event.stopPropagation()
                handleimagepaste(files[i])
                return true
              }
            }
          }
          return false
        }
      }),
      CMEditorView.updateListener.of((update) => {
        if (update.selectionSet && update.view.hasFocus) {
          clearpinnededitorselection()
        }
        if (update.selectionSet && collabpeerslive()) {
          const sel = update.state.selection.main
          schedulecursorbroadcast(sel.head, sel.anchor)
        }
        if (update.docChanged && remotecursormap.size) {
          for (const data of remotecursormap.values()) {
            for (const key of ['head', 'anchor', 'from', 'to']) {
              if (typeof data[key] === 'number') data[key] = update.changes.mapPos(Math.min(data[key], update.startState.doc.length), key === 'from' ? 1 : -1)
            }
          }
        }
        if (update.docChanged || update.state.field(cmliveflashfield, false) !== update.startState.field(cmliveflashfield, false)) {
          queueremotecursorrefresh()
        }
        if (update.docChanged && !ed.isremoteapplying) {
          const targetnoteid = state.activenoteid
          if (!targetnoteid) return
          const isremote = update.transactions.some(tr => tr.annotation(ySyncAnnotation))
          if (isremote) {
            flashcmremotechanges(update)
          } else if (ed.pinnedselection) {
            clearpinnededitorselection()
          }
          schedulespotseen(targetnoteid)

          // yjs carries the change from here, rest save is only the no websocket fallback --------------------
          if (ed.collabbound || !ed.fallbackedit) return
          const content = update.state.doc.toString()

          if (ed.savetimer) clearTimeout(ed.savetimer)
          ed.savetimer = setTimeout(async () => {
            try {
              await api('/api/notes', {
                method: 'POST',
                body: JSON.stringify({
                  note_id: targetnoteid,
                  content,
                  author: state.currentuser ? state.currentuser.id : 'unknown'
                })
              })
              schedulepreviewreload(targetnoteid)
            } catch (err) {
              console.error('auto save failed', err)
            }
          }, 400)
        }
      })
    ]
  })

  ed.cmview = new CMEditorView({
    state: startstate,
    parent: container
  })

  return ed.cmview
}

// set content and configure language in codemirror --------------------
export function setcmcontent(text = '', filename = '') {
  const view = initcodemirror()
  if (!view) return

  const langext = getlanguageextension(filename)
  const currentdoc = view.state.doc.toString()

  if (currentdoc === text) {
    if (ed.cmlanguagecompartment) {
      view.dispatch({
        effects: ed.cmlanguagecompartment.reconfigure(langext)
      })
    }
    return
  }

  ed.isremoteapplying = true
  try {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      effects: ed.cmlanguagecompartment ? [ed.cmlanguagecompartment.reconfigure(langext)] : []
    })
  } finally {
    setTimeout(() => {
      ed.isremoteapplying = false
    }, 50)
  }
}

