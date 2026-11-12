import { api, hextorgba } from './api.js'
import { state } from './state.js'
import { rendertabs } from './tabs.js'
import { renderfolderview, updateactivefilerow, loadnotes } from './files.js'
import { renderpreview, hidepreview, updateviewpagebutton } from './preview.js'
import {
  Editor,
  Extension,
  StarterKit,
  Markdown,
  Placeholder,
  TaskList,
  TaskItem,
  Decoration,
  DecorationSet,
  Plugin,
  PluginKey,
  NodeSelection,
  dropPoint,
  Slice,
  Fragment,
  MarkdownSerializerState,
  Highlight,
  mark_plugin,
  InlineMath,
  BlockMath,
  detectlatex,
  Link,
  NoteLink,
  Image,
  ResizableImage,
  CMEditorView,
  CMEditorState,
  CMStateField,
  CMStateEffect,
  CMCompartment,
  CMDecoration,
  CMWidgetType,
  cmLineNumbers,
  cmHighlightActiveLineGutter,
  cmHighlightActiveLine,
  cmKeymap,
  cmDefaultKeymap,
  cmHistory,
  cmHistoryKeymap,
  cmIndentWithTab,
  cmUndo,
  cmRedo,
  cmBracketMatching,
  cmFoldGutter,
  cmFoldKeymap,
  cmIndentOnInput,
  cmSyntaxHighlighting,
  cmDefaultHighlightStyle,
  cmCloseBrackets,
  cmJavascript,
  cmHtml,
  cmCss,
  cmJson,
  cmPython,
  cmYaml,
  cmOneDark
} from './tiptap.bundle.js'

// dom elements for editor --------------------
const editorcontainer = document.getElementById('editor-container')
const emptystate = document.getElementById('empty-state')
const editortoolbar = document.getElementById('editor-toolbar')
const tiptapeditorcontainer = document.getElementById('tiptap-editor')
const plaineditorwrap = document.getElementById('plain-editor-wrap')
const codemirroreditor = document.getElementById('codemirror-editor')
const noteeditor = document.getElementById('note-editor')
const editorbackdrop = document.getElementById('editor-backdrop')
const imageviewercontainer = document.getElementById('image-viewer-container')
const imageviewerimg = document.getElementById('image-viewer-img')
const imageviewermeta = document.getElementById('image-viewer-meta')

let tiptapinstance = null
let cmview = null
let cmlanguagecompartment = null
let cmflashtimeout = null
const setflasheffect = CMStateEffect.define()
const clearflasheffect = CMStateEffect.define()
let notesocket = null
let savetimer = null
let istoolbarbound = false
let isplainbound = false
let flashtimeout = null
let plainflashtimeout = null
let isremoteapplying = false
let draggedimagenodepos = null
const flashpluginkey = new PluginKey('flashhighlight')

// check if file is markdown based on extension or mushnote default --------------------
export function ismarkdownfile(noteid) {
  if (!noteid) return false
  const clean = noteid.split('?')[0].split('#')[0].toLowerCase()
  const parts = clean.split('/')
  const filename = parts[parts.length - 1]
  const dotidx = filename.lastIndexOf('.')
  if (dotidx > 0) {
    const ext = filename.slice(dotidx + 1)
    return ext === 'md' || ext === 'markdown'
  }
  if (filename.startsWith('.')) {
    return false
  }
  return true
}

// clean up markdown output to prevent symbol corruption and runaway newlines --------------------
export function cleanmarkdown(text) {
  if (!text) return ''
  let cleaned = text
  // restore html escaped angle brackets in markdown --------------------
  cleaned = cleaned.replace(/&gt;/g, '>').replace(/&lt;/g, '<')
  // restore accidental backslash escaped list bullets and task checkboxes --------------------
  cleaned = cleaned.replace(/^([ \t]*)\\([*+->])(?:\s+|$)/gm, '$1$2 ')
  cleaned = cleaned.replace(/^([ \t]*[*+-]\s*)\\\[\s*([xX]?)\s*\\\]/gm, (match, prefix, checked) => `${prefix.trimEnd()} [${checked ? checked : ' '}]`)
  // collapse three or more consecutive newlines into at most one blank line --------------------
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n')
  return cleaned
}

// custom markdown it task list parser supporting empty checkboxes and items --------------------
function customtasklistrule(mdstate) {
  const tokens = mdstate.tokens
  for (let i = 2; i < tokens.length; i++) {
    if (tokens[i].type === 'inline' &&
        tokens[i - 1].type === 'paragraph_open' &&
        tokens[i - 2].type === 'list_item_open') {
      const text = tokens[i].content
      const match = text.match(/^\[([ xX])\](?:\s*([\s\S]*))?$/)
      if (match) {
        const checked = match[1].toLowerCase() === 'x'
        const itemtext = match[2] || ''
        tokens[i - 2].attrSet('class', 'task-list-item')
        for (let p = i - 2; p >= 0; p--) {
          if (tokens[p].type === 'bullet_list_open') {
            tokens[p].attrSet('class', 'contains-task-list')
            break
          }
        }
        const checkbox = new mdstate.Token('html_inline', '', 0)
        checkbox.content = `<input class="task-list-item-checkbox" type="checkbox"${checked ? ' checked=""' : ''} disabled="">`
        tokens[i].children = [checkbox]
        if (itemtext) {
          const texttoken = new mdstate.Token('text', '', 0)
          texttoken.content = ' ' + itemtext
          tokens[i].children.push(texttoken)
        }
        tokens[i].content = itemtext
      }
    }
  }
}

// compress and resize image to webp format --------------------
function compressimagetowebp(file, maxdim = 1920, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const img = new window.Image()
      img.onload = () => {
        let width = img.width
        let height = img.height

        if (width > maxdim || height > maxdim) {
          if (width > height) {
            height = Math.round((height * maxdim) / width)
            width = maxdim
          } else {
            width = Math.round((width * maxdim) / height)
            height = maxdim
          }
        }

        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, width, height)

        const dataurl = canvas.toDataURL('image/webp', quality)
        resolve({
          dataurl,
          width,
          height
        })
      }
      img.onerror = () => reject(new Error('failed to load image'))
      img.src = e.target.result
    }
    reader.onerror = () => reject(new Error('failed to read image file'))
    reader.readAsDataURL(file)
  })
}

// upload image file and insert markdown image tag into active note --------------------
export async function uploadandinsertimage(file, targetfolder = 'media') {
  if (!state.activenoteid) return

  try {
    const { dataurl } = await compressimagetowebp(file, 1920, 0.85)
    const timestamp = Date.now()
    const rawname = file.name && file.name !== 'image.png' && file.name !== 'blob'
      ? file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_\-]/g, '_').toLowerCase()
      : ''
    const filename = rawname ? `${rawname}-${timestamp}.webp` : `${timestamp}.webp`
    const uploadpath = targetfolder ? `${targetfolder}/${filename}` : `media/${filename}`
    const imageurl = `/${uploadpath}`
    const altname = rawname || 'image'
    const imagetag = `![${altname}](${imageurl})`

    await api('/api/upload', {
      method: 'POST',
      body: JSON.stringify({
        path: uploadpath,
        data: dataurl
      })
    })

    try {
      loadnotes()
    } catch {}

    if (!ismarkdownfile(state.activenoteid)) {
      if (cmview) {
        const sel = cmview.state.selection.main
        cmview.dispatch({
          changes: { from: sel.from, to: sel.to, insert: imagetag },
          selection: { anchor: sel.from + imagetag.length }
        })
      } else if (noteeditor) {
        const start = noteeditor.selectionStart || 0
        const end = noteeditor.selectionEnd || 0
        noteeditor.setRangeText(imagetag, start, end, 'end')
        noteeditor.dispatchEvent(new Event('input'))
      }
    } else if (tiptapinstance) {
      tiptapinstance.chain().focus().setImage({ src: imageurl, alt: altname }).run()
    }
  } catch (err) {
    console.error('image upload failed', err)
  }
}

// upload pasted image into media and pastes folder --------------------
async function handleimagepaste(file) {
  return uploadandinsertimage(file, 'media/pastes')
}

// open file picker to upload compressed image and insert at cursor --------------------
export function pickandinsertimage() {
  if (!state.activenoteid) return

  // record current cursor selection so focus return is exact --------------------
  let savedselection = null
  if (tiptapinstance) {
    savedselection = tiptapinstance.state.selection
  } else if (cmview) {
    savedselection = cmview.state.selection
  } else if (noteeditor) {
    savedselection = { start: noteeditor.selectionStart, end: noteeditor.selectionEnd }
  }

  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.style.display = 'none'

  input.addEventListener('change', async () => {
    const file = input.files?.[0]
    input.remove()
    if (!file) return

    // restore cursor selection before inserting --------------------
    if (tiptapinstance && savedselection) {
      try {
        tiptapinstance.commands.setTextSelection(savedselection)
      } catch {}
    } else if (cmview && savedselection) {
      try {
        cmview.dispatch({ selection: savedselection })
      } catch {}
    } else if (noteeditor && savedselection) {
      try {
        noteeditor.setSelectionRange(savedselection.start, savedselection.end)
      } catch {}
    }

    await uploadandinsertimage(file, 'media')
  })

  document.body.appendChild(input)
  input.click()
}

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

  if (ismd && tiptapinstance) {
    const editor = tiptapinstance
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
  if (cmview) {
    const view = cmview
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

// wire up plain text editor events once --------------------
function initplaineditor() {
  if (isplainbound || !noteeditor) return
  isplainbound = true

  noteeditor.addEventListener('input', () => {
    const targetnoteid = state.activenoteid
    if (!targetnoteid) return
    writespotseen(targetnoteid, noteeditor.value)
    if (savetimer) clearTimeout(savetimer)
    savetimer = setTimeout(async () => {
      try {
        await api('/api/notes', {
          method: 'POST',
          body: JSON.stringify({
            note_id: targetnoteid,
            content: noteeditor.value,
            author: state.currentuser ? state.currentuser.id : 'unknown'
          })
        })
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

initplaineditor()

// tiptap extension to display edit flash highlights --------------------
const flashextension = Extension.create({
  name: 'flashhighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: flashpluginkey,
        state: {
          init() {
            return DecorationSet.empty
          },
          apply(tr, oldset) {
            let set = oldset.map(tr.mapping, tr.doc)
            const meta = tr.getMeta(flashpluginkey)
            if (meta) {
              if (meta.action === 'set') {
                return meta.decorations
              }
              if (meta.action === 'clear') {
                return DecorationSet.empty
              }
            }
            return set
          }
        },
        props: {
          decorations(state) {
            return flashpluginkey.getState(state)
          }
        }
      })
    ]
  }
})

// resolve user highlight color with external gray fallback --------------------
export function resolveauthorcolor(author) {
  if (!author || author === 'external') return '#737373'
  if (state.usercolormap && state.usercolormap[author]) {
    return state.usercolormap[author]
  }
  if (author === 'ai' || author === (state.aiusername || 'ai')) {
    return '#3b82f6'
  }
  return '#10b981'
}

// create user avatar badge for flash highlights --------------------
function createavatarbadge(author, usercolor) {
  const isexternal = !author || author === 'external'
  const useravatar = isexternal
    ? '/resources/icons/files/common.png'
    : (state.useravatarmap?.[author] || (author === 'ai' ? '/avatars/ai.jpg' : `/avatars/${author}.png`))

  const anchor = document.createElement('span')
  anchor.className = 'edit-user-anchor'

  const badge = document.createElement('span')
  badge.className = 'edit-user-badge'
  badge.title = isexternal ? 'external edit' : author
  badge.style.setProperty('--flash-user-border', usercolor)
  badge.style.setProperty('--flash-user-glow', hextorgba(usercolor, 0.45))

  const img = document.createElement('img')
  img.src = useravatar
  img.alt = isexternal ? 'external' : author
  img.className = 'edit-user-img'

  const fallback = document.createElement('span')
  fallback.className = 'edit-user-fallback'
  fallback.textContent = isexternal ? 'E' : (author.charAt(0) || '?').toUpperCase()
  fallback.style.display = 'none'

  img.onerror = () => {
    img.style.display = 'none'
    fallback.style.display = 'block'
  }

  badge.appendChild(img)
  badge.appendChild(fallback)
  anchor.appendChild(badge)
  return anchor
}

// create deletion marker for removed text in place --------------------
function createdeletemarker(author, usercolor, deletedtext = '') {
  const marker = document.createElement('span')
  marker.className = 'edit-delete-marker'
  marker.style.setProperty('--flash-user-border', hextorgba(usercolor, 0.75))
  marker.style.setProperty('--flash-user-glow', hextorgba(usercolor, 0.35))
  marker.style.setProperty('--flash-user-bg', hextorgba(usercolor, 0.28))

  // collapse any newlines so deletion never creates vertical ghost lines --------------------
  const cleantext = (deletedtext || '').replace(/\r?\n+/g, ' ').trim()
  if (cleantext.length > 0) {
    const textspan = document.createElement('span')
    textspan.className = 'edit-delete-text'
    textspan.textContent = cleantext.length > 30 ? `${cleantext.slice(0, 30)}...` : cleantext
    marker.appendChild(textspan)
  } else {
    marker.classList.add('is-empty')
  }

  if (author) {
    const badge = createavatarbadge(author, usercolor)
    marker.appendChild(badge)
  }

  return marker
}

// codemirror avatar badge widget for flash highlights --------------------
class CMAvatarWidget extends CMWidgetType {
  constructor(author, usercolor) {
    super()
    this.author = author
    this.usercolor = usercolor
  }

  toDOM() {
    return createavatarbadge(this.author, this.usercolor)
  }

  eq(other) {
    return other.author === this.author && other.usercolor === this.usercolor
  }

  ignoreEvent() {
    return true
  }
}

// codemirror delete marker widget for removed text --------------------
class CMDeleteMarkerWidget extends CMWidgetType {
  constructor(author, usercolor, text) {
    super()
    this.author = author
    this.usercolor = usercolor
    this.text = text
  }

  toDOM() {
    return createdeletemarker(this.author, this.usercolor, this.text)
  }

  eq(other) {
    return other.author === this.author && other.usercolor === this.usercolor && other.text === this.text
  }

  ignoreEvent() {
    return true
  }
}

// codemirror state field tracking active flash decorations --------------------
const cmflashfield = CMStateField.define({
  create() {
    return CMDecoration.none
  },
  update(decos, tr) {
    decos = decos.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(setflasheffect)) {
        decos = effect.value
      } else if (effect.is(clearflasheffect)) {
        decos = CMDecoration.none
      }
    }
    return decos
  },
  provide: f => CMEditorView.decorations.from(f)
})

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
  if (cmview) return cmview
  const container = document.getElementById('codemirror-editor')
  if (!container) return null

  cmlanguagecompartment = new CMCompartment()

  const startstate = CMEditorState.create({
    doc: '',
    extensions: [
      cmLineNumbers(),
      cmHighlightActiveLineGutter(),
      cmHighlightActiveLine(),
      cmHistory(),
      cmFoldGutter(),
      cmIndentOnInput(),
      cmBracketMatching(),
      cmCloseBrackets(),
      cmOneDark,
      cmlanguagecompartment.of([]),
      cmflashfield,
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
        if (update.docChanged && !isremoteapplying) {
          const targetnoteid = state.activenoteid
          if (!targetnoteid) return
          const content = update.state.doc.toString()
          writespotseen(targetnoteid, content)

          if (savetimer) clearTimeout(savetimer)
          savetimer = setTimeout(async () => {
            try {
              await api('/api/notes', {
                method: 'POST',
                body: JSON.stringify({
                  note_id: targetnoteid,
                  content,
                  author: state.currentuser ? state.currentuser.id : 'unknown'
                })
              })
            } catch (err) {
              console.error('auto save failed', err)
            }
          }, 400)
        }
      })
    ]
  })

  cmview = new CMEditorView({
    state: startstate,
    parent: container
  })

  return cmview
}

// set content and configure language in codemirror --------------------
export function setcmcontent(text = '', filename = '') {
  const view = initcodemirror()
  if (!view) return

  const langext = getlanguageextension(filename)
  const currentdoc = view.state.doc.toString()

  if (currentdoc === text) {
    if (cmlanguagecompartment) {
      view.dispatch({
        effects: cmlanguagecompartment.reconfigure(langext)
      })
    }
    return
  }

  isremoteapplying = true
  try {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      effects: cmlanguagecompartment ? [cmlanguagecompartment.reconfigure(langext)] : []
    })
  } finally {
    setTimeout(() => {
      isremoteapplying = false
    }, 50)
  }
}

// render flash highlight in codemirror --------------------
export function rendercmflashhighlight(oldtext = '', newtext = '', edits = [], usercolor = '#3b82f6', author = '') {
  if (!cmview) return
  if (cmflashtimeout) {
    clearTimeout(cmflashtimeout)
    cmflashtimeout = null
  }

  // calculate diff range if not provided --------------------
  let diffstart = 0
  while (diffstart < oldtext.length && diffstart < newtext.length && oldtext[diffstart] === newtext[diffstart]) {
    diffstart++
  }

  let oldend = oldtext.length
  let newend = newtext.length
  while (oldend > diffstart && newend > diffstart && oldtext[oldend - 1] === newtext[newend - 1]) {
    oldend--
    newend--
  }

  const isdeletion = oldend > diffstart && newend <= diffstart
  const deletedtext = isdeletion ? oldtext.slice(diffstart, oldend) : ''

  let minstart = diffstart
  let maxend = newend

  if (Array.isArray(edits) && edits.length > 0) {
    for (const edit of edits) {
      const from = Math.max(0, Math.min(edit.from || 0, newtext.length))
      const to = Math.max(from, Math.min(edit.to || (edit.from + 1), newtext.length))
      if (from < minstart) minstart = from
      if (to > maxend) maxend = to
    }
  }

  const doc = cmview.state.doc
  const safe_from = Math.max(0, Math.min(minstart, doc.length))
  const safe_to = Math.max(safe_from, Math.min(maxend, doc.length))

  const decos = []
  if (isdeletion) {
    decos.push(CMDecoration.widget({
      widget: new CMDeleteMarkerWidget(author, usercolor, deletedtext),
      side: 1
    }).range(safe_from))
  } else if (safe_to > safe_from) {
    const style = `--flash-user-bg: ${hextorgba(usercolor, 0.28)}; --flash-user-border: ${hextorgba(usercolor, 0.75)}; --flash-user-glow: ${hextorgba(usercolor, 0.35)};`
    decos.push(CMDecoration.mark({
      class: 'edit-flash',
      attributes: { style }
    }).range(safe_from, safe_to))

    if (author) {
      decos.push(CMDecoration.widget({
        widget: new CMAvatarWidget(author, usercolor),
        side: 1
      }).range(safe_to))
    }
  }

  if (decos.length === 0) return

  cmview.dispatch({
    effects: setflasheffect.of(CMDecoration.set(decos, true))
  })

  cmflashtimeout = setTimeout(() => {
    if (cmview) {
      cmview.dispatch({ effects: clearflasheffect.of(null) })
    }
    cmflashtimeout = null
  }, 2250)
}

// flash whole code file for brand new file creation --------------------
export function flashwholecmnote(author, usercolor) {
  if (!cmview) return
  const doc = cmview.state.doc
  if (doc.length === 0) return

  const style = `--flash-user-bg: ${hextorgba(usercolor, 0.28)}; --flash-user-border: ${hextorgba(usercolor, 0.75)}; --flash-user-glow: ${hextorgba(usercolor, 0.35)};`
  const decos = [
    CMDecoration.mark({
      class: 'edit-flash',
      attributes: { style }
    }).range(0, doc.length)
  ]

  if (author) {
    decos.push(CMDecoration.widget({
      widget: new CMAvatarWidget(author, usercolor),
      side: 1
    }).range(doc.length))
  }

  cmview.dispatch({
    effects: setflasheffect.of(CMDecoration.set(decos, true))
  })

  if (cmflashtimeout) clearTimeout(cmflashtimeout)
  cmflashtimeout = setTimeout(() => {
    if (cmview) {
      cmview.dispatch({ effects: clearflasheffect.of(null) })
    }
    cmflashtimeout = null
  }, 2250)
}

// initialize tiptap markdown editor --------------------
export function inittiptapeditor() {
  if (tiptapinstance) return tiptapinstance
  if (!tiptapeditorcontainer) return null

  tiptapinstance = new Editor({
    element: tiptapeditorcontainer,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        history: true,
        codeBlock: {
          HTMLAttributes: {
            spellcheck: 'false',
            autocorrect: 'off',
            autocapitalize: 'off'
          }
        },
        code: {
          HTMLAttributes: {
            spellcheck: 'false',
            autocorrect: 'off',
            autocapitalize: 'off'
          }
        }
      }),
      Markdown.configure({
        html: false,
        tightLists: true,
        bulletListMarker: '-',
        linkify: false,
        breaks: false,
        transformPastedText: true,
        transformCopiedText: true
      }),
      Placeholder.configure({
        placeholder: 'start typing in markdown...'
      }),
      TaskList,
      TaskItem.configure({
        nested: true
      }),
      Highlight,
      InlineMath.configure({
        onClick: (node, pos) => {
          const current = node.attrs.latex || ''
          const updated = window.prompt('edit latex formula:', current)
          if (updated === null) return
          if (!updated.trim()) {
            tiptapinstance.commands.deleteRange({ from: pos, to: pos + node.nodeSize })
          } else {
            tiptapinstance.chain().setNodeSelection(pos).command(({ tr }) => {
              tr.setNodeMarkup(pos, undefined, { latex: updated.trim() })
              return true
            }).run()
          }
        }
      }),
      BlockMath.configure({
        onClick: (node, pos) => {
          const current = node.attrs.latex || ''
          const updated = window.prompt('edit block latex formula:', current)
          if (updated === null) return
          if (!updated.trim()) {
            tiptapinstance.commands.deleteRange({ from: pos, to: pos + node.nodeSize })
          } else {
            tiptapinstance.chain().setNodeSelection(pos).command(({ tr }) => {
              tr.setNodeMarkup(pos, undefined, { latex: updated.trim() })
              return true
            }).run()
          }
        }
      }),
      NoteLink.configure({
        openOnClick: false,
        autolink: true,
        markdownLinks: true,
        shouldAutoLink: (url) => /^(https?:\/\/|mailto:|tel:)/i.test(url),
        validate: (url) => /^(https?:\/\/|mailto:|tel:)/i.test(url),
        isAllowedUri: () => true,
        HTMLAttributes: {
          class: 'editor-link'
        }
      }),
      ResizableImage.configure({
        allowBase64: true,
        resize: {
          enabled: true,
          directions: ['bottom-right', 'right', 'bottom'],
          alwaysPreserveAspectRatio: true,
          minWidth: 30,
          minHeight: 30
        },
        HTMLAttributes: {
          class: 'editor-image'
        }
      }),
      flashextension
    ],
    editorProps: {
      handleClick: (view, pos, event) => {
        // select image and show resize handles when clicked --------------------
        const targetimg = event.target?.closest?.('[data-resize-container]') || (event.target?.tagName === 'IMG' ? event.target : null)
        if (targetimg) {
          try {
            const desc = view.docView?.nearestDesc?.(targetimg, true)
            const resolvedpos = desc && desc.node && desc.node.type.name === 'image' ? desc.posBefore : null
            if (typeof resolvedpos === 'number' && resolvedpos >= 0) {
              const tr = view.state.tr.setSelection(NodeSelection.create(view.state.doc, resolvedpos))
              view.dispatch(tr)
              return true
            }
          } catch (e) {
            console.warn('could not select image node', e)
          }
        }

        const link = event.target?.closest?.('a')
        if (!link) return false

        const href = link.getAttribute('data-note-link') || link.getAttribute('href')
        if (!href) return false

        // don't navigate if user was dragging or selecting text --------------------
        if (!view.state.selection.empty && !event.ctrlKey && !event.metaKey) {
          return false
        }

        event.preventDefault()
        event.stopPropagation()

        if (isexternalurl(href)) {
          window.open(href, '_blank', 'noopener,noreferrer')
          return true
        }

        // normal click navigates in current tab --------------------
        opennotelink(href, { newtab: false })
        return true
      },
      handleDOMEvents: {
        dragstart: (view, event) => {
          draggedimagenodepos = null
          const imgel = event.target?.closest?.('[data-resize-container]') || (event.target?.tagName === 'IMG' ? event.target : null)
          if (imgel) {
            try {
              const desc = view.docView?.nearestDesc?.(imgel, true)
              const resolvedpos = desc && desc.node && desc.node.type.name === 'image' ? desc.posBefore : null
              if (typeof resolvedpos === 'number' && resolvedpos >= 0) {
                draggedimagenodepos = resolvedpos
                window.__mushnote_dragged_image_pos = resolvedpos
                event.dataTransfer?.setData('application/mushnote-editor-image-pos', String(resolvedpos))
              }
            } catch (err) {
              console.warn('could not record dragged image pos', err)
            }
          }
          return false
        },
        dragend: () => {
          setTimeout(() => {
            draggedimagenodepos = null
            window.__mushnote_dragged_image_pos = null
          }, 300)
          return false
        },
        contextmenu: (view, event) => {
          const link = event.target?.closest?.('a')
          if (!link) return false

          const href = link.getAttribute('data-note-link') || link.getAttribute('href')
          if (!href || isexternalurl(href)) return false

          event.preventDefault()
          event.stopPropagation()

          // right click opens note link in new tab --------------------
          opennotelink(href, { newtab: true })
          return true
        },
        auxclick: (view, event) => {
          if (event.button !== 1) return false
          const link = event.target?.closest?.('a')
          if (!link) return false

          const href = link.getAttribute('data-note-link') || link.getAttribute('href')
          if (!href || isexternalurl(href)) return false

          event.preventDefault()
          event.stopPropagation()

          // middle click opens note link in new tab --------------------
          opennotelink(href, { newtab: true })
          return true
        }
      },
      handleKeyDown: (view, event) => {
        // allow copying selected image node as markdown tag with ctrl+c --------------------
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
          const sel = view.state.selection
          if (sel instanceof NodeSelection && sel.node && sel.node.type.name === 'image') {
            event.preventDefault()
            const node = sel.node
            const alt = node.attrs.alt || ''
            let src = node.attrs.src || ''
            const width = node.attrs.width
            const height = node.attrs.height

            let cleansrc = src
            let decoded = cleansrc
            try { decoded = decodeURIComponent(cleansrc) } catch {}
            const srcmatch = decoded.match(/^(.*?)\|(\d+)(?:x(\d+))?$/)
            if (srcmatch) cleansrc = srcmatch[1]

            let dim = ''
            if (width && height) {
              dim = `|${Math.round(width)}x${Math.round(height)}`
            } else if (width) {
              dim = `|${Math.round(width)}`
            }

            const title = node.attrs.title ? ` "${node.attrs.title.replace(/"/g, '\\"')}"` : ''
            const imagetag = `![${alt}](${cleansrc}${dim}${title})`

            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(imagetag).catch(() => {})
            }
            return true
          }
        }

        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
          event.preventDefault()
          handletoolbaraction('link')
          return true
        }
        return false
      },
      handlePaste: (view, event) => {
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

        const text = event.clipboardData?.getData('text/plain')
        if (!text) return false

        const detected = detectlatex(text)
        if (!detected) return false

        event.preventDefault()
        const { latex, isblock } = detected

        if (isblock) {
          tiptapinstance.commands.insertContent({
            type: 'blockMath',
            attrs: { latex }
          })
        } else {
          tiptapinstance.commands.insertContent({
            type: 'inlineMath',
            attrs: { latex }
          })
        }
        return true
      },
      handleDrop: (view, event, slice, moved) => {
        // file or folder dropped from sidebar --------------------
        const dragitem = getdraggeditem(event)
        if (dragitem) {
          event.preventDefault()
          event.stopPropagation()
          state.activefiledrag = null
          clearalldraghighlights()
          const coords = { left: event.clientX, top: event.clientY }
          const dropinfo = view.posAtCoords(coords)
          const droppos = dropinfo && typeof dropinfo.pos === 'number' ? dropinfo.pos : null
          const insertinfo = formatdraginsert(dragitem)
          insertcontentintoactivenote(insertinfo, droppos)
          return true
        }

        // image file pasted or dropped from desktop --------------------
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

        // move dragged image without duplicating or leaving a copy --------------------
        const editorposraw = event.dataTransfer?.getData('application/mushnote-editor-image-pos')
        let sourcepos = null
        if (editorposraw) {
          const parsed = parseInt(editorposraw, 10)
          if (!isNaN(parsed) && parsed >= 0) sourcepos = parsed
        }
        if (sourcepos === null && typeof window.__mushnote_dragged_image_pos === 'number' && window.__mushnote_dragged_image_pos >= 0) {
          sourcepos = window.__mushnote_dragged_image_pos
        }
        if (sourcepos === null && typeof draggedimagenodepos === 'number' && draggedimagenodepos >= 0) {
          sourcepos = draggedimagenodepos
        }
        if (sourcepos === null && view.state.selection instanceof NodeSelection && view.state.selection.node?.type?.name === 'image') {
          sourcepos = view.state.selection.from
        }

        // find image node from slice or document --------------------
        let imagenode = null
        if (sourcepos !== null) {
          const n = view.state.doc.nodeAt(sourcepos)
          if (n && n.type.name === 'image') {
            imagenode = n
          }
        }

        if (!imagenode && slice && slice.content) {
          slice.content.descendants(n => {
            if (!imagenode && n.type.name === 'image') {
              imagenode = n
              return false
            }
          })
        }

        // fallback if slice was serialized as markdown image in text or plain --------------------
        if (!imagenode) {
          const droppedtext = event.dataTransfer?.getData('text/plain') || ''
          const imgmatch = droppedtext.trim().match(/^!\[([^\]]*)\]\((.+)\)$/)
          if (imgmatch) {
            let alt = imgmatch[1]
            let cleanTarget = imgmatch[2].trim()
            let title = ''
            const titleMatch = cleanTarget.match(/^(\S+)(?:\s+["']([\s\S]*)["'])?$/)
            if (titleMatch) {
              cleanTarget = titleMatch[1]
              if (titleMatch[2]) title = titleMatch[2]
            }

            let width = null
            let height = null
            let decoded = cleanTarget
            try { decoded = decodeURIComponent(cleanTarget) } catch {}
            const dimMatch = decoded.match(/^(.*?)\|(\d+)(?:x(\d+))?$/)
            if (dimMatch) {
              cleanTarget = dimMatch[1]
              width = parseInt(dimMatch[2], 10)
              if (dimMatch[3]) height = parseInt(dimMatch[3], 10)
            }

            const altDimMatch = (alt || '').match(/^(.*?)\|(\d+)(?:x(\d+))?$/)
            if (altDimMatch) {
              alt = altDimMatch[1]
              if (!width) {
                width = parseInt(altDimMatch[2], 10)
                if (altDimMatch[3]) height = parseInt(altDimMatch[3], 10)
              }
            }

            const schema = view.state.schema
            if (schema.nodes.image) {
              imagenode = schema.nodes.image.create({
                src: cleanTarget,
                alt,
                title,
                width,
                height
              })
            }
          }
        }

        const isinternalimage = imagenode && (sourcepos !== null || view.dragging)

        if (isinternalimage) {
          event.preventDefault()
          event.stopPropagation()
          draggedimagenodepos = null
          window.__mushnote_dragged_image_pos = null

          // if sourcepos is still unknown find image with matching src in doc --------------------
          if (sourcepos === null && imagenode.attrs?.src) {
            view.state.doc.descendants((n, p) => {
              if (sourcepos === null && n.type.name === 'image' && n.attrs.src === imagenode.attrs.src) {
                sourcepos = p
                return false
              }
            })
          }

          const coords = { left: event.clientX, top: event.clientY }
          const dropcoords = view.posAtCoords(coords)
          if (!dropcoords) return true

          const sourcenode = (sourcepos !== null ? view.state.doc.nodeAt(sourcepos) : null) || imagenode
          const nodesize = sourcenode ? sourcenode.nodeSize : 1
          const targetpos = dropcoords.pos

          // do not move if dropped right back onto itself --------------------
          if (sourcepos !== null && targetpos >= sourcepos && targetpos <= sourcepos + nodesize) {
            return true
          }

          const tr = view.state.tr

          // delete original node at source position --------------------
          if (sourcepos !== null) {
            tr.delete(sourcepos, sourcepos + nodesize)
          }

          // map target position through the deletion --------------------
          let insertpos = tr.mapping.map(targetpos)

          // find valid drop position --------------------
          const imageslice = new Slice(Fragment.from(sourcenode), 0, 0)
          const validpoint = dropPoint(tr.doc, insertpos, imageslice)
          if (validpoint !== null && typeof validpoint === 'number') {
            insertpos = validpoint
          }

          // insert image at destination --------------------
          tr.insert(insertpos, sourcenode)

          // select the newly positioned image --------------------
          try {
            tr.setSelection(NodeSelection.create(tr.doc, insertpos))
          } catch {}

          view.dispatch(tr.setMeta('uiEvent', 'drop'))
          view.focus()
          return true
        }

        return false
      }
    },
    content: '',
    onUpdate: ({ editor }) => {
      if (isremoteapplying) return
      const targetnoteid = state.activenoteid
      if (!targetnoteid) return

      try {
        const livemd = cleanmarkdown(editor.storage.markdown.getMarkdown())
        writespotseen(targetnoteid, livemd)
      } catch {}

      if (savetimer) clearTimeout(savetimer)
      savetimer = setTimeout(async () => {
        try {
          const md = cleanmarkdown(editor.storage.markdown.getMarkdown())
          await api('/api/notes', {
            method: 'POST',
            body: JSON.stringify({
              note_id: targetnoteid,
              content: md,
              author: state.currentuser ? state.currentuser.id : 'unknown'
            })
          })
        } catch (err) {
          console.error('auto save failed', err)
        }
      }, 400)
    },
    onSelectionUpdate: () => {
      updatetoolbarstate()
    },
    onTransaction: () => {
      updatetoolbarstate()
    }
  })

  // patch markdown serializer and parser so symbols and lists stay clean --------------------
  const storage = tiptapinstance.storage?.markdown
  if (storage) {
    if (storage.serializer && storage.serializer.nodes) {
      storage.serializer.nodes.text = (state, node) => {
        state.text(node.text)
      }
      storage.serializer.nodes.inlineMath = (state, node) => {
        state.write(`$${node.attrs.latex}$`)
      }
      storage.serializer.nodes.blockMath = (state, node) => {
        state.write(`\n\n$$\n${node.attrs.latex}\n$$\n\n`)
      }
      storage.serializer.nodes.image = (state, node) => {
        const alt = node.attrs.alt || ''
        let src = node.attrs.src || ''
        const width = node.attrs.width
        const height = node.attrs.height

        // strip any existing obsidian dimension tag from src --------------------
        let cleansrc = src
        let decoded = cleansrc
        try { decoded = decodeURIComponent(cleansrc) } catch {}
        const srcmatch = decoded.match(/^(.*?)\|(\d+)(?:x(\d+))?$/)
        if (srcmatch) cleansrc = srcmatch[1]

        let dim = ''
        if (width && height) {
          dim = `|${Math.round(width)}x${Math.round(height)}`
        } else if (width) {
          dim = `|${Math.round(width)}`
        }

        const title = node.attrs.title ? ` "${node.attrs.title.replace(/"/g, '\\"')}"` : ''
        state.write(`![${alt}](${cleansrc}${dim}${title})`)
      }
    }

    if (storage.serializer) {
      if (storage.serializer.marks && !storage.serializer.marks.highlight) {
        storage.serializer.marks.highlight = {
          open: '==',
          close: '==',
          expelEnclosingWhitespace: true
        }
      }
      storage.serializer.serialize = (content) => {
        const state = new MarkdownSerializerState(
          storage.serializer.nodes,
          storage.serializer.marks,
          {
            hardBreakNodeName: 'hardBreak',
            tightLists: true
          }
        )
        state.renderContent(content)
        return cleanmarkdown(state.out)
      }
    }

    if (storage.parser && storage.parser.md) {
      const md = storage.parser.md
      try {
        mark_plugin(md)
      } catch {}
      try {
        md.core.ruler.at('github-task-lists', customtasklistrule)
      } catch {
        const origafter = md.core.ruler.after.bind(md.core.ruler)
        md.core.ruler.after = (aftername, rulename, fn, options) => {
          if (rulename === 'github-task-lists') {
            return origafter(aftername, rulename, customtasklistrule, options)
          }
          return origafter(aftername, rulename, fn, options)
        }
      }

      // parse obsidian image syntax ![alt](url|300x200) and ![alt|300x200](url) --------------------
      const origimagerender = md.renderer.rules.image || function(tokens, idx, options, env, self) {
        return self.renderToken(tokens, idx, options)
      }
      md.renderer.rules.image = function(tokens, idx, options, env, self) {
        const token = tokens[idx]
        let src = token.attrGet('src') || ''
        let width = null
        let height = null

        let decoded = src
        try { decoded = decodeURIComponent(src) } catch {}
        const srcmatch = decoded.match(/^(.*?)\|(\d+)(?:x(\d+))?$/)
        if (srcmatch) {
          src = srcmatch[1]
          width = srcmatch[2]
          if (srcmatch[3]) height = srcmatch[3]
          token.attrSet('src', src)
        }

        let alt = token.content || ''
        const altmatch = alt.match(/^(.*?)\|(\d+)(?:x(\d+))?$/)
        if (altmatch) {
          alt = altmatch[1]
          token.content = alt
          if (token.children && token.children[0]) {
            token.children[0].content = alt
          }
          if (!width) {
            width = altmatch[2]
            if (altmatch[3]) height = altmatch[3]
          }
        }

        if (width) token.attrSet('width', String(width))
        if (height) token.attrSet('height', String(height))
        return origimagerender(tokens, idx, options, env, self)
      }
    }
  }

  // bind toolbar click actions once --------------------
  if (editortoolbar && !istoolbarbound) {
    istoolbarbound = true
    editortoolbar.addEventListener('mousedown', (e) => {
      const btn = e.target.closest('.toolbar-btn')
      if (btn) {
        e.preventDefault()
      }
    })
    editortoolbar.addEventListener('click', (e) => {
      const btn = e.target.closest('.toolbar-btn')
      if (!btn) return
      e.preventDefault()
      const action = btn.dataset.action
      if (action) handletoolbaraction(action)
    })
  }

  initeditorlinkevents()
  return tiptapinstance
}

// execute toolbar format actions --------------------
function handletoolbaraction(action) {
  if (!tiptapinstance) return
  tiptapinstance.chain().focus()

  switch (action) {
    case 'h1':
      tiptapinstance.chain().focus().toggleHeading({ level: 1 }).run()
      break
    case 'h2':
      tiptapinstance.chain().focus().toggleHeading({ level: 2 }).run()
      break
    case 'h3':
      tiptapinstance.chain().focus().toggleHeading({ level: 3 }).run()
      break
    case 'bold':
      tiptapinstance.chain().focus().toggleBold().run()
      break
    case 'italic':
      tiptapinstance.chain().focus().toggleItalic().run()
      break
    case 'strike':
      tiptapinstance.chain().focus().toggleStrike().run()
      break
    case 'highlight':
      tiptapinstance.chain().focus().toggleHighlight().run()
      break
    case 'link': {
      const current = tiptapinstance.getAttributes('link').href || ''
      const url = window.prompt('enter note filename (e.g. todo.md) or web url:', current)
      if (url === null) break
      if (!url.trim()) {
        tiptapinstance.chain().focus().unsetLink().run()
      } else {
        tiptapinstance.chain().focus().setLink({ href: url.trim() }).run()
      }
      break
    }
    case 'image':
      pickandinsertimage()
      break
    case 'latex': {
      const formula = window.prompt('enter latex formula (e.g. E = mc^2):', '')
      if (formula && formula.trim()) {
        tiptapinstance.chain().focus().insertContent({
          type: 'inlineMath',
          attrs: { latex: formula.trim() }
        }).run()
      }
      break
    }
    case 'code':
      tiptapinstance.chain().focus().toggleCode().run()
      break
    case 'bullet-list':
      tiptapinstance.chain().focus().toggleBulletList().run()
      break
    case 'ordered-list':
      tiptapinstance.chain().focus().toggleOrderedList().run()
      break
    case 'task-list':
      tiptapinstance.chain().focus().toggleTaskList().run()
      break
    case 'blockquote':
      tiptapinstance.chain().focus().toggleBlockquote().run()
      break
    case 'code-block':
      tiptapinstance.chain().focus().toggleCodeBlock().run()
      break
    case 'horizontal-rule':
      tiptapinstance.chain().focus().setHorizontalRule().run()
      break
    case 'undo':
      if (ismarkdownfile(state.activenoteid)) {
        tiptapinstance?.chain()?.focus()?.undo()?.run()
      } else if (cmview) {
        cmUndo(cmview)
      }
      break
    case 'redo':
      if (ismarkdownfile(state.activenoteid)) {
        tiptapinstance?.chain()?.focus()?.redo()?.run()
      } else if (cmview) {
        cmRedo(cmview)
      }
      break
  }

  updatetoolbarstate()
}

// update active highlights on toolbar buttons based on current selection --------------------
function updatetoolbarstate() {
  if (!tiptapinstance || !editortoolbar) return
  const buttons = editortoolbar.querySelectorAll('.toolbar-btn')
  for (const btn of buttons) {
    const action = btn.dataset.action
    let isactive = false
    switch (action) {
      case 'h1': isactive = tiptapinstance.isActive('heading', { level: 1 }); break
      case 'h2': isactive = tiptapinstance.isActive('heading', { level: 2 }); break
      case 'h3': isactive = tiptapinstance.isActive('heading', { level: 3 }); break
      case 'bold': isactive = tiptapinstance.isActive('bold'); break
      case 'italic': isactive = tiptapinstance.isActive('italic'); break
      case 'strike': isactive = tiptapinstance.isActive('strike'); break
      case 'highlight': isactive = tiptapinstance.isActive('highlight'); break
      case 'link': isactive = tiptapinstance.isActive('link'); break
      case 'code': isactive = tiptapinstance.isActive('code'); break
      case 'bullet-list': isactive = tiptapinstance.isActive('bulletList'); break
      case 'ordered-list': isactive = tiptapinstance.isActive('orderedList'); break
      case 'task-list': isactive = tiptapinstance.isActive('taskList'); break
      case 'blockquote': isactive = tiptapinstance.isActive('blockquote'); break
      case 'code-block': isactive = tiptapinstance.isActive('codeBlock'); break
    }
    btn.classList.toggle('is-active', isactive)
  }
}

// helper to match note ids with or without md extension or folder prefix --------------------
export function isnoteidmatch(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  const norma = a.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const normb = b.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (norma === normb) return true
  const stripmda = norma.replace(/\.md$/, '')
  const stripmdb = normb.replace(/\.md$/, '')
  if (stripmda === stripmdb) return true
  const basea = stripmda.split('/').pop()
  const baseb = stripmdb.split('/').pop()
  if (!stripmda.includes('/') && baseb === stripmda) return true
  if (!stripmdb.includes('/') && basea === stripmdb) return true
  return false
}

// check if url is external web or protocol link --------------------
export function isexternalurl(url) {
  if (!url || typeof url !== 'string') return false
  const trimmed = url.trim()
  if (trimmed.startsWith(window.location.origin)) {
    return false
  }
  return /^(https?:|\/\/|mailto:|tel:)/i.test(trimmed)
}

// resolve target path or title to actual note id and optional anchor --------------------
export function resolvenoteid(rawtarget) {
  if (!rawtarget || typeof rawtarget !== 'string') return { noteid: '', anchor: null }

  let target = decodeURIComponent(rawtarget.trim())

  // strip origin if full url on same host --------------------
  if (target.startsWith(window.location.origin)) {
    target = target.slice(window.location.origin.length)
  }

  let anchor = null
  const hashidx = target.indexOf('#')
  if (hashidx >= 0) {
    anchor = target.slice(hashidx + 1).trim()
    target = target.slice(0, hashidx).trim()
  }

  const queryidx = target.indexOf('?')
  if (queryidx >= 0) {
    target = target.slice(0, queryidx).trim()
  }

  // if only anchor was provided stay in active note --------------------
  if (!target && anchor) {
    return { noteid: state.activenoteid, anchor }
  }

  // normalize slashes and strip leading prefixes --------------------
  target = target.replace(/\\/g, '/')
  target = target.replace(/^(\.\/)+/, '')
  target = target.replace(/^\/+/, '')

  // match against cached vault notes list --------------------
  if (state.allnotes && state.allnotes.length > 0) {
    const exact = state.allnotes.find(n => n.note_id === target)
    if (exact) return { noteid: exact.note_id, anchor }

    if (!target.includes('.')) {
      const withmd = state.allnotes.find(n => n.note_id === `${target}.md`)
      if (withmd) return { noteid: withmd.note_id, anchor }
    }

    const matched = state.allnotes.find(n => isnoteidmatch(n.note_id, target))
    if (matched) return { noteid: matched.note_id, anchor }

    if (!target.includes('/')) {
      const bybase = state.allnotes.find(n => {
        const base = n.note_id.split('/').pop()
        return base === target || base === `${target}.md`
      })
      if (bybase) return { noteid: bybase.note_id, anchor }
    }
  }

  // fallback formatting when not found in memory --------------------
  let finalid = target
  if (!finalid.includes('.')) {
    finalid = `${finalid}.md`
  }
  return { noteid: finalid, anchor }
}

// scroll editor view to matching heading anchor --------------------
export function scrolltoanchor(anchor) {
  if (!anchor) return
  setTimeout(() => {
    const clean = decodeURIComponent(anchor).toLowerCase().replace(/[^a-z0-9_-]/g, '')
    const headings = tiptapeditorcontainer ? tiptapeditorcontainer.querySelectorAll('h1, h2, h3, h4, h5, h6') : []
    for (const h of headings) {
      const textslug = h.textContent.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '')
      if (textslug === clean || h.textContent.trim().toLowerCase() === anchor.toLowerCase()) {
        h.scrollIntoView({ behavior: 'smooth', block: 'start' })
        h.style.transition = 'background-color 0.3s ease'
        h.style.backgroundColor = 'rgba(59, 130, 246, 0.25)'
        setTimeout(() => { h.style.backgroundColor = '' }, 1200)
        break
      }
    }
  }, 180)
}

// open note from link in current or new tab and scroll to anchor if given --------------------
export async function opennotelink(rawtarget, options = {}) {
  if (!rawtarget) return
  const { noteid, anchor } = resolvenoteid(rawtarget)
  if (!noteid) return

  const { newtab = false } = options
  await opennote(noteid, { newtab, replacecurrent: !newtab, switchfolder: true })

  if (anchor) {
    scrolltoanchor(anchor)
  }
}

// handle clicking and right clicking note links in editor container --------------------
let iseditorlinksbound = false
export function initeditorlinkevents() {
  if (iseditorlinksbound || !tiptapeditorcontainer) return
  iseditorlinksbound = true

  // left click navigates in current tab --------------------
  tiptapeditorcontainer.addEventListener('click', (e) => {
    const link = e.target.closest('a')
    if (!link) return

    const href = link.getAttribute('data-note-link') || link.getAttribute('href') || link.href
    if (!href) return

    if (isexternalurl(href)) {
      window.open(href, '_blank', 'noopener,noreferrer')
      e.preventDefault()
      e.stopPropagation()
      return
    }

    e.preventDefault()
    e.stopPropagation()
    opennotelink(href, { newtab: false })
  })

  // right click opens note link in new tab --------------------
  tiptapeditorcontainer.addEventListener('contextmenu', (e) => {
    const link = e.target.closest('a')
    if (!link) return

    const href = link.getAttribute('data-note-link') || link.getAttribute('href') || link.href
    if (!href || isexternalurl(href)) return

    e.preventDefault()
    e.stopPropagation()
    opennotelink(href, { newtab: true })
  })

  // middle click opens note link in new tab --------------------
  tiptapeditorcontainer.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return
    const link = e.target.closest('a')
    if (!link) return

    const href = link.getAttribute('data-note-link') || link.getAttribute('href') || link.href
    if (!href || isexternalurl(href)) return

    e.preventDefault()
    e.stopPropagation()
    opennotelink(href, { newtab: true })
  })

  // fallback image paste listener for editor workspace --------------------
  if (editorcontainer) {
    editorcontainer.addEventListener('paste', (e) => {
      if (e.defaultPrevented) return
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
    })

    // drag and drop files and folders into editor workspace --------------------
    editorcontainer.addEventListener('dragover', (e) => {
      const ismushitem = state.activefiledrag || e.dataTransfer?.types?.includes('application/mushnote-item')
      const hasfiles = e.dataTransfer?.types?.includes('Files')
      if (!ismushitem && !hasfiles) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      editorcontainer.classList.add('drag-over')
    })

    editorcontainer.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && editorcontainer.contains(e.relatedTarget)) return
      editorcontainer.classList.remove('drag-over')
    })

    editorcontainer.addEventListener('drop', async (e) => {
      editorcontainer.classList.remove('drag-over')
      if (e.defaultPrevented) return

      const dragitem = getdraggeditem(e)
      const files = e.dataTransfer?.files

      if (dragitem) {
        e.preventDefault()
        e.stopPropagation()
        state.activefiledrag = null
        clearalldraghighlights()

        if (!state.activenoteid) return

        let droppos = null
        if (ismarkdownfile(state.activenoteid) && tiptapinstance?.view) {
          const coords = { left: e.clientX, top: e.clientY }
          const dropinfo = tiptapinstance.view.posAtCoords(coords)
          if (dropinfo && typeof dropinfo.pos === 'number') {
            droppos = dropinfo.pos
          }
        } else if (cmview) {
          const dropinfo = cmview.posAtCoords({ x: e.clientX, y: e.clientY })
          if (typeof dropinfo?.pos === 'number') {
            droppos = dropinfo.pos
          }
        }

        const insertinfo = formatdraginsert(dragitem)
        insertcontentintoactivenote(insertinfo, droppos)
        return
      }

      if (files && files.length > 0) {
        for (let i = 0; i < files.length; i++) {
          if (files[i].type && files[i].type.startsWith('image/')) {
            e.preventDefault()
            e.stopPropagation()
            handleimagepaste(files[i])
            return
          }
        }
      }
    })
  }
}

// connect websocket for real time edit events and sync --------------------
export function connectnotesocket(noteid) {
  if (notesocket) {
    try {
      notesocket.close()
    } catch {}
    notesocket = null
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const author = state.currentuser ? state.currentuser.id : 'unknown'
  const wsurl = `${protocol}//${window.location.host}/ws/${encodeURIComponent(noteid)}?author=${encodeURIComponent(author)}`

  notesocket = new WebSocket(wsurl)

  notesocket.onmessage = (event) => {
    try {
      if (typeof event.data !== 'string') return
      const data = JSON.parse(event.data)
      const myid = state.currentuser?.id || state.currentuser?.user_id

      if (data.type === 'edit_event' && isnoteidmatch(data.note_id, state.activenoteid)) {
        if (data.author && myid && data.author === myid) return
        handleotheruseredit(data)
      } else if (data.type === 'vault_changed') {
        if (data.action === 'create' && data.note_id) {
          marksessioncreated(data.note_id)
        }
        window.dispatchEvent(new CustomEvent('vault-changed', { detail: data }))
      } else if (data.type === 'note_renamed') {
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
          connectnotesocket(newid)
          let newfilename = newid.split('/').pop() || newid
          if (!newfilename.includes('.')) {
            newfilename = `${newfilename}.md`
          }
          document.title = `${newfilename} - mushnote`
        }
        if (modified) {
          rendertabs()
          updateviewpagebutton()
    saveworkspacestate()
        }
      }
    } catch {}
  }
}

// track session start time and notes born during active session --------------------
export const sessionstarttime = (() => {
  try {
    const stored = sessionStorage.getItem('mushnote_session_start')
    if (stored) {
      const parsed = parseInt(stored, 10)
      if (!isNaN(parsed) && parsed > 0) return parsed
    }
  } catch {}
  const now = Date.now()
  try {
    sessionStorage.setItem('mushnote_session_start', String(now))
  } catch {}
  return now
})()

const sessioncreatednotes = new Set()

export function marksessioncreated(noteid) {
  if (!noteid) return
  const normid = noteid.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  sessioncreatednotes.add(normid)
  if (normid.endsWith('.md')) {
    sessioncreatednotes.add(normid.slice(0, -3))
  } else {
    sessioncreatednotes.add(`${normid}.md`)
  }
}

export function iscreatedduringsession(noteid, notemeta = {}) {
  if (!noteid) return false
  const normid = noteid.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (sessioncreatednotes.has(normid)) return true
  const withmd = normid.endsWith('.md') ? normid : `${normid}.md`
  if (sessioncreatednotes.has(withmd)) return true
  const stripped = normid.endsWith('.md') ? normid.slice(0, -3) : normid
  if (sessioncreatednotes.has(stripped)) return true

  const birthtime = notemeta.created_time || (notemeta.created_at ? new Date(notemeta.created_at).getTime() : 0)
  if (birthtime && birthtime >= (sessionstarttime - 3000)) {
    return true
  }
  return false
}

// local browser storage for tracking what the current user last saw in each note --------------------
function getseenstoragekey() {
  const userid = state.currentuser?.id || state.currentuser?.user_id || 'default'
  return `mushnote_seen_notes_${userid}`
}

function loadseenmap() {
  try {
    const raw = localStorage.getItem(getseenstoragekey())
    if (raw) return JSON.parse(raw)
  } catch {}
  return {}
}

export function writespotseen(noteid, content) {
  if (!noteid) return
  try {
    const key = getseenstoragekey()
    const map = loadseenmap()
    const normid = noteid.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    map[normid] = {
      content: typeof content === 'string' ? content : '',
      updated_at: Date.now()
    }
    // prune oldest entries when exceeding cap to save space --------------------
    const keys = Object.keys(map)
    if (keys.length > 150) {
      const sorted = keys.sort((a, b) => (map[a]?.updated_at || 0) - (map[b]?.updated_at || 0))
      for (let i = 0; i < keys.length - 150; i++) {
        delete map[sorted[i]]
      }
    }
    localStorage.setItem(key, JSON.stringify(map))
  } catch {}
}

export function getspotseen(noteid) {
  if (!noteid) return null
  const map = loadseenmap()
  const normid = noteid.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (map[normid]) return map[normid]
  const withmd = normid.endsWith('.md') ? normid : `${normid}.md`
  if (map[withmd]) return map[withmd]
  const stripped = normid.endsWith('.md') ? normid.slice(0, -3) : normid
  if (map[stripped]) return map[stripped]
  return null
}

// highlight entire markdown note when viewed for first time if created by someone else --------------------
export function flashwholenote(author = 'ai', usercolor = '#3b82f6') {
  if (!tiptapinstance) return
  const doc = tiptapinstance.state.doc
  if (!doc || doc.content.size <= 0) return

  const style = `--flash-user-bg: ${hextorgba(usercolor, 0.28)}; --flash-user-border: ${hextorgba(usercolor, 0.75)}; --flash-user-glow: ${hextorgba(usercolor, 0.35)};`
  const decos = []

  let textfound = false
  doc.nodesBetween(0, doc.content.size, (node, pos) => {
    if (node.isText) {
      textfound = true
      decos.push(Decoration.inline(pos, pos + node.nodeSize, { class: 'edit-flash', style }))
    }
  })

  if (!textfound) {
    doc.nodesBetween(0, doc.content.size, (node, pos) => {
      if (node.isBlock) {
        decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'edit-flash', style }))
      }
    })
  }

  // attach creator avatar badge at the bottom right end of note --------------------
  if (author) {
    const badgepos = Math.max(0, doc.content.size)
    decos.push(Decoration.widget(badgepos, () => createavatarbadge(author, usercolor), { side: 1 }))
  }

  if (decos.length > 0) {
    try {
      const decoset = DecorationSet.create(doc, decos)
      const tr = tiptapinstance.state.tr.setMeta(flashpluginkey, { action: 'set', decorations: decoset })
      tiptapinstance.view.dispatch(tr)

      if (flashtimeout) clearTimeout(flashtimeout)
      flashtimeout = setTimeout(() => {
        if (!tiptapinstance) return
        try {
          const cleartr = tiptapinstance.state.tr.setMeta(flashpluginkey, { action: 'clear' })
          tiptapinstance.view.dispatch(cleartr)
        } catch {}
        flashtimeout = null
      }, 2500)
    } catch (err) {
      console.warn('failed to apply whole note flash', err)
    }
  }
}

// highlight entire plain text note for someone elses note --------------------
export function flashwholeplainnote(text, author = 'ai', usercolor = '#3b82f6') {
  if (!editorbackdrop || !noteeditor || !text) return
  renderplainflashhighlight('', text, [{ from: 0, to: text.length }], usercolor, author)
}

// active flash decorations for concurrent edits --------------------
const activeedits = new Map()
let flashcleartimer = null

// dispatch active flash decorations onto current editor document --------------------
export function updateflashdecorations() {
  if (!tiptapinstance) return
  const doc = tiptapinstance.state.doc
  if (!doc) return

  const now = Date.now()
  for (const [key, item] of activeedits.entries()) {
    if (item.expire <= now) {
      activeedits.delete(key)
    }
  }

  if (activeedits.size === 0) {
    try {
      const tr = tiptapinstance.state.tr.setMeta(flashpluginkey, { action: 'clear' })
      tiptapinstance.view.dispatch(tr)
    } catch {}
    if (flashcleartimer) {
      clearTimeout(flashcleartimer)
      flashcleartimer = null
    }
    return
  }

  const decos = []
  for (const item of activeedits.values()) {
    const style = `--flash-user-bg: ${hextorgba(item.usercolor, 0.28)}; --flash-user-border: ${hextorgba(item.usercolor, 0.75)}; --flash-user-glow: ${hextorgba(item.usercolor, 0.35)};`

    if (item.type === 'insert') {
      const from = Math.max(0, Math.min(item.from, doc.content.size))
      const to = Math.max(from, Math.min(item.to, doc.content.size))
      if (from < to) {
        let textfound = false
        doc.nodesBetween(from, to, (node, pos) => {
          if (node.isText) {
            textfound = true
            const nfrom = Math.max(from, pos)
            const nto = Math.min(to, pos + node.nodeSize)
            if (nfrom < nto) {
              decos.push(Decoration.inline(nfrom, nto, { class: 'edit-flash', style }))
            }
          }
        })
        if (!textfound) {
          doc.nodesBetween(from, to, (node, pos) => {
            if (node.isBlock) {
              decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'edit-flash', style }))
            }
          })
        }
        if (item.author) {
          decos.push(Decoration.widget(to, () => createavatarbadge(item.author, item.usercolor), { side: 1 }))
        }
      }
    } else if (item.type === 'delete') {
      const delpos = Math.max(0, Math.min(item.pos, doc.content.size))
      decos.push(Decoration.widget(delpos, () => createdeletemarker(item.author, item.usercolor, item.text), { side: 1, stopEvent: () => true }))
    }
  }

  if (decos.length > 0) {
    try {
      const decoset = DecorationSet.create(doc, decos)
      const tr = tiptapinstance.state.tr.setMeta(flashpluginkey, { action: 'set', decorations: decoset })
      tiptapinstance.view.dispatch(tr)
    } catch (err) {
      console.warn('failed to apply flash decoration', err)
    }
  }

  // schedule cleanup when earliest active edit expires --------------------
  if (flashcleartimer) {
    clearTimeout(flashcleartimer)
    flashcleartimer = null
  }
  let minexpire = Infinity
  for (const item of activeedits.values()) {
    if (item.expire < minexpire) {
      minexpire = item.expire
    }
  }
  if (minexpire !== Infinity) {
    const delay = Math.max(30, minexpire - now + 30)
    flashcleartimer = setTimeout(() => {
      flashcleartimer = null
      updateflashdecorations()
    }, delay)
  }
}

// handle remote user edit event for plain text editor --------------------
// handle remote edits for non-markdown code files --------------------
function handleplainotheruseredit(data = {}) {
  if (!state.activenoteid) return
  const author = data.author || 'ai'
  const usercolor = resolveauthorcolor(author)

  function applyplaincontent(text) {
    const view = initcodemirror()
    if (!view) return

    const oldtext = view.state.doc.toString()
    if (oldtext === text) return

    if (savetimer) {
      clearTimeout(savetimer)
      savetimer = null
    }

    // calculate diff range --------------------
    let diffstart = 0
    while (diffstart < oldtext.length && diffstart < text.length && oldtext[diffstart] === text[diffstart]) {
      diffstart++
    }

    let oldend = oldtext.length
    let newend = text.length
    while (oldend > diffstart && newend > diffstart && oldtext[oldend - 1] === text[newend - 1]) {
      oldend--
      newend--
    }

    const inserted = text.slice(diffstart, newend)

    isremoteapplying = true
    try {
      view.dispatch({
        changes: { from: diffstart, to: oldend, insert: inserted }
      })
    } finally {
      setTimeout(() => {
        isremoteapplying = false
      }, 50)
    }

    writespotseen(state.activenoteid, text)
    rendercmflashhighlight(oldtext, text, data.edits || [], usercolor, author)
  }

  if (typeof data.content === 'string') {
    applyplaincontent(data.content)
    return
  }

  api(`/api/note?id=${encodeURIComponent(state.activenoteid)}`).then(res => {
    if (!res || !res.note) return
    applyplaincontent(res.note.content || '')
  }).catch(() => {})
}

// render flash highlight behind text in editor backdrop for plain text files --------------------
export function renderplainflashhighlight(oldtext, newtext, edits = [], usercolor = '#3b82f6', author = '') {
  if (!editorbackdrop || !noteeditor) return

  let minstart = newtext.length
  let maxend = 0

  let diffstart = 0
  while (diffstart < oldtext.length && diffstart < newtext.length && oldtext[diffstart] === newtext[diffstart]) {
    diffstart++
  }

  let oldend = oldtext.length
  let newend = newtext.length
  while (oldend > diffstart && newend > diffstart && oldtext[oldend - 1] === newtext[newend - 1]) {
    oldend--
    newend--
  }

  const isdeletion = oldend > diffstart && newend <= diffstart
  const deletedtext = isdeletion ? oldtext.slice(diffstart, oldend) : ''

  if (newend > diffstart) {
    minstart = diffstart
    maxend = newend
  } else if (Array.isArray(edits) && edits.length > 0) {
    for (const edit of edits) {
      const from = Math.max(0, Math.min(edit.from || 0, newtext.length))
      const to = Math.max(from, Math.min(edit.to || edit.from + 1, newtext.length))
      if (from < minstart) minstart = from
      if (to > maxend) maxend = to
    }
  }

  const bgcolor = hextorgba(usercolor, 0.28)
  const bordercolor = hextorgba(usercolor, 0.75)
  const glowcolor = hextorgba(usercolor, 0.35)

  editorbackdrop.style.setProperty('--flash-user-bg', bgcolor)
  editorbackdrop.style.setProperty('--flash-user-border', bordercolor)
  editorbackdrop.style.setProperty('--flash-user-glow', glowcolor)

  editorbackdrop.innerHTML = ''

  if (isdeletion) {
    const before = newtext.slice(0, diffstart)
    const after = newtext.slice(diffstart)
    if (before) {
      const beforespan = document.createElement('span')
      beforespan.textContent = before
      editorbackdrop.appendChild(beforespan)
    }
    const marker = createdeletemarker(author, usercolor, deletedtext)
    editorbackdrop.appendChild(marker)
    if (after) {
      const afterspan = document.createElement('span')
      afterspan.textContent = after
      editorbackdrop.appendChild(afterspan)
    }
  } else if (minstart < maxend && maxend <= newtext.length) {
    const before = newtext.slice(0, minstart)
    const highlighted = newtext.slice(minstart, maxend)
    const after = newtext.slice(maxend)

    if (before) {
      const beforespan = document.createElement('span')
      beforespan.textContent = before
      editorbackdrop.appendChild(beforespan)
    }

    let lastflashspan = null
    const lines = highlighted.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.length > 0) {
        const flashspan = document.createElement('span')
        flashspan.className = 'edit-flash'
        flashspan.textContent = line
        editorbackdrop.appendChild(flashspan)
        lastflashspan = flashspan
      }
      if (i < lines.length - 1) {
        editorbackdrop.appendChild(document.createTextNode('\n'))
      }
    }

    if (lastflashspan && author) {
      const badge = createavatarbadge(author, usercolor)
      lastflashspan.appendChild(badge)
    }

    if (after) {
      const afterspan = document.createElement('span')
      afterspan.textContent = after
      editorbackdrop.appendChild(afterspan)
    }
  }

  editorbackdrop.scrollTop = noteeditor.scrollTop
  editorbackdrop.scrollLeft = noteeditor.scrollLeft

  if (plainflashtimeout) clearTimeout(plainflashtimeout)
  plainflashtimeout = setTimeout(() => {
    if (editorbackdrop) editorbackdrop.innerHTML = ''
    plainflashtimeout = null
  }, 2250)
}

// handle remote user edit event --------------------
function handleotheruseredit(data = {}) {
  if (!state.activenoteid) return
  if (!ismarkdownfile(state.activenoteid)) {
    handleplainotheruseredit(data)
    return
  }
  if (!tiptapinstance) return
  const author = data.author || 'ai'
  const usercolor = resolveauthorcolor(author)

  function applycontent(text) {
    if (!tiptapinstance) return
    const cleaned = cleanmarkdown(text || '')
    const currentmd = tiptapinstance.storage.markdown.getMarkdown()
    if (currentmd === cleaned) return

    if (savetimer) {
      clearTimeout(savetimer)
      savetimer = null
    }

    const olddoc = tiptapinstance.state.doc
    try {
      isremoteapplying = true
      tiptapinstance.commands.setContent(cleaned, { emitUpdate: false })
    } finally {
      setTimeout(() => {
        isremoteapplying = false
      }, 50)
    }
    const newdoc = tiptapinstance.state.doc
    writespotseen(state.activenoteid, cleaned)

    // compute diff between old and new state for this edit step --------------------
    let diffstart = null
    let diffend = null
    if (olddoc && olddoc.content && newdoc.content) {
      diffstart = olddoc.content.findDiffStart(newdoc.content)
      if (diffstart !== null) {
        diffend = olddoc.content.findDiffEnd(newdoc.content)
      }
    }

    if (diffstart !== null && diffend !== null) {
      const endinnew = diffend.b
      const endinold = diffend.a
      const shift = endinnew - endinold

      // shift existing active edits that come after diffstart --------------------
      if (shift !== 0) {
        for (const item of activeedits.values()) {
          if (item.type === 'insert') {
            if (item.from >= diffstart) {
              item.from = Math.max(0, Math.min(newdoc.content.size, item.from + shift))
              item.to = Math.max(0, Math.min(newdoc.content.size, item.to + shift))
            }
          } else if (item.type === 'delete') {
            if (item.pos >= diffstart) {
              item.pos = Math.max(0, Math.min(newdoc.content.size, item.pos + shift))
            }
          }
        }
      }

      // record deletion only if text was removed without replacement --------------------
      if (endinold > diffstart && endinnew <= diffstart) {
        let deletedtext = ''
        if (olddoc && olddoc.content) {
          try {
            deletedtext = olddoc.textBetween(diffstart, Math.min(endinold, olddoc.content.size), ' ')
          } catch {}
        }
        const delpos = Math.max(0, Math.min(diffstart, newdoc.content.size))
        const delkey = data.edit_id ? `${data.edit_id}_del` : `${author}_del_${Date.now()}_${delpos}`
        activeedits.set(delkey, {
          type: 'delete',
          pos: delpos,
          text: deletedtext,
          author,
          usercolor,
          expire: Date.now() + 2200
        })
      }

      // record insertion if new text was added --------------------
      if (endinnew > diffstart) {
        const editkey = data.edit_id || `${author}_edit_${Math.floor(diffstart / 30)}`
        if (activeedits.has(editkey)) {
          const existing = activeedits.get(editkey)
          existing.from = Math.min(existing.from, diffstart)
          existing.to = endinnew
          existing.expire = Date.now() + 2200
        } else {
          activeedits.set(editkey, {
            type: 'insert',
            from: diffstart,
            to: endinnew,
            author,
            usercolor,
            expire: Date.now() + 2200
          })
        }
      }
    }

    updateflashdecorations()
    refreshallremotecursors()
  }

  if (typeof data.content === 'string') {
    applycontent(data.content)
    return
  }

  api(`/api/note?id=${encodeURIComponent(state.activenoteid)}`).then(res => {
    if (!res || !res.note) return
    applycontent(res.note.content || '')
  }).catch(() => {})
}

// save workspace tab state to local storage --------------------
export function saveworkspacestate() {
  const userid = state.currentuser?.id || 'guest'
  const ws = {
    opentabs: state.opentabs,
    activenoteid: state.activenoteid,
    currentfolder: state.currentfolder
  }
  try {
    localStorage.setItem(`mushnote_ws_${userid}`, JSON.stringify(ws))
  } catch {}
}

// load workspace tab state from local storage --------------------
export function loadworkspacestate() {
  const userid = state.currentuser?.id || 'guest'
  try {
    const raw = localStorage.getItem(`mushnote_ws_${userid}`)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

// close current note editor --------------------
export function closenote() {
  activeedits.clear()
  if (flashcleartimer) {
    clearTimeout(flashcleartimer)
    flashcleartimer = null
  }
  if (plainflashtimeout) {
    clearTimeout(plainflashtimeout)
    plainflashtimeout = null
  }
  if (cmflashtimeout) {
    clearTimeout(cmflashtimeout)
    cmflashtimeout = null
  }
  if (editorbackdrop) {
    editorbackdrop.innerHTML = ''
  }
  if (noteeditor) {
    noteeditor.value = ''
  }
  if (notesocket) {
    notesocket.close()
    notesocket = null
  }
  if (state.activenoteid) {
    const closedid = state.activenoteid
    state.opentabs = state.opentabs.filter(t => !isnoteidmatch(t, closedid))
  }
  state.activenoteid = null
  document.title = 'mushnote'
  if (editorcontainer) {
    editorcontainer.classList.add('hidden')
    editorcontainer.classList.remove('plain-mode')
  }
  if (imageviewercontainer) imageviewercontainer.classList.add('hidden')
  hidepreview()
  updateviewpagebutton()
  if (emptystate) emptystate.classList.remove('hidden')
  updateactivefilerow()

  if (tiptapinstance) {
    tiptapinstance.commands.setContent('', false)
  }
  if (cmview) {
    cmview.dispatch({
      changes: { from: 0, to: cmview.state.doc.length, insert: '' }
    })
  }

  // update tabs bar and persist workspace --------------------
  rendertabs()
  saveworkspacestate()

  // clear last open note preference on server --------------------
  if (state.currentuser) {
    if (!state.currentuser.preferences) state.currentuser.preferences = {}
    state.currentuser.preferences['last-open-note'] = null
    api('/api/user/preferences', {
      method: 'POST',
      body: JSON.stringify({
        preferences: { 'last-open-note': null }
      })
    }).catch(() => {})
  }
}

// open note in center wysiwyg editor --------------------
export async function opennote(noteid, options = {}) {
  activeedits.clear()
  if (flashcleartimer) {
    clearTimeout(flashcleartimer)
    flashcleartimer = null
  }
  if (plainflashtimeout) {
    clearTimeout(plainflashtimeout)
    plainflashtimeout = null
  }
  if (cmflashtimeout) {
    clearTimeout(cmflashtimeout)
    cmflashtimeout = null
  }
  if (savetimer) {
    clearTimeout(savetimer)
    savetimer = null
  }
  const ispreview = noteid.startsWith('preview:')
  const rawtargetid = ispreview ? noteid.slice('preview:'.length) : noteid
  let tabname = rawtargetid.split('/').pop() || rawtargetid
  if (!ispreview && !tabname.includes('.')) {
    tabname = `${tabname}.md`
  }
  document.title = ispreview ? `preview: ${tabname} - mushnote` : `${tabname} - mushnote`
  const opts = typeof options === 'boolean' ? { force: options } : (options || {})
  const { newtab = false, replacecurrent = true, switchfolder = true } = opts

  // manage open tabs list --------------------
  if (newtab) {
    if (!state.opentabs.some(t => isnoteidmatch(t, noteid))) {
      state.opentabs.push(noteid)
    }
  } else if (replacecurrent) {
    if (state.opentabs.length === 0) {
      state.opentabs = [noteid]
    } else if (state.opentabs.some(t => isnoteidmatch(t, noteid))) {
      // note already in tabs so keep existing tabs
    } else if (state.activenoteid && state.opentabs.some(t => isnoteidmatch(t, state.activenoteid))) {
      const idx = state.opentabs.findIndex(t => isnoteidmatch(t, state.activenoteid))
      state.opentabs[idx] = noteid
    } else {
      state.opentabs.push(noteid)
    }
  } else {
    if (!state.opentabs.some(t => isnoteidmatch(t, noteid))) {
      state.opentabs.push(noteid)
    }
  }

  // deduplicate tabs --------------------
  state.opentabs = Array.from(new Set(state.opentabs))

  state.activenoteid = noteid
  rendertabs()

  if (ispreview) {
    if (emptystate) emptystate.classList.add('hidden')
    if (editorcontainer) editorcontainer.classList.add('hidden')
    if (imageviewercontainer) imageviewercontainer.classList.add('hidden')
    updateactivefilerow()
    updateviewpagebutton()
    await renderpreview(rawtargetid)
    updateviewpagebutton()
    saveworkspacestate()
    return
  }

  hidepreview()

  // switch folder view only if requested --------------------
  if (switchfolder) {
    const notefolder = noteid.includes('/')
      ? noteid.split('/').slice(0, -1).join('/')
      : ''

    if (state.currentfolder !== notefolder) {
      state.currentfolder = notefolder
    }
    renderfolderview()
  } else {
    updateactivefilerow()
  }

  try {
    const data = await api(`/api/note?id=${encodeURIComponent(noteid)}`)
    if (emptystate) emptystate.classList.add('hidden')
    document.title = `${tabname} - mushnote`

    if (data.note.is_image) {
      if (editorcontainer) editorcontainer.classList.add('hidden')
      if (imageviewercontainer) {
        imageviewercontainer.classList.remove('hidden')
        if (imageviewerimg) imageviewerimg.src = data.note.image_url || `/api/raw?id=${encodeURIComponent(noteid)}`
        if (imageviewermeta) {
          const sizestr = data.note.size ? ` - ${Math.round(data.note.size / 1024)} kb` : ''
          imageviewermeta.textContent = `${data.note.title}${sizestr}`
        }
      }
    } else {
      if (imageviewercontainer) imageviewercontainer.classList.add('hidden')
      if (editorcontainer) editorcontainer.classList.remove('hidden')

      const ismd = ismarkdownfile(noteid)
      const currentcontent = data.note.content || ''
      const seendata = getspotseen(noteid)
      const myid = state.currentuser?.id || state.currentuser?.user_id || ''
      const createdby = data.note.created_by || 'external'
      const lastauthor = data.note.last_author || createdby || 'external'

      // case 1: brand new note created during this session by someone else --------------------
      const isbrandnew = !seendata
      const isduringsession = iscreatedduringsession(noteid, data.note)
      const isothercreator = isbrandnew && isduringsession && createdby && createdby !== myid && currentcontent.trim().length > 0

      // case 2: note was modified since local user last saw it --------------------
      const hasunseenchanges = seendata && seendata.content !== currentcontent

      if (ismd) {
        if (editorcontainer) editorcontainer.classList.remove('plain-mode')
        if (editortoolbar) editortoolbar.classList.remove('hidden')
        if (tiptapeditorcontainer) tiptapeditorcontainer.classList.remove('hidden')
        if (plaineditorwrap) plaineditorwrap.classList.add('hidden')

        const editor = inittiptapeditor()
        if (editor) {
          try {
            isremoteapplying = true
            if (isothercreator) {
              editor.commands.setContent(cleanmarkdown(currentcontent), { emitUpdate: false })
              const creatorcolor = resolveauthorcolor(createdby)
              flashwholenote(createdby, creatorcolor)
            } else if (hasunseenchanges) {
              editor.commands.setContent(cleanmarkdown(seendata.content), { emitUpdate: false })
              const olddoc = editor.state.doc
              editor.commands.setContent(cleanmarkdown(currentcontent), { emitUpdate: false })
              const authorcolor = resolveauthorcolor(lastauthor)
              renderflashhighlight(olddoc, editor.state.doc, [], authorcolor, lastauthor)
            } else {
              editor.commands.setContent(cleanmarkdown(currentcontent), { emitUpdate: false })
            }
          } finally {
            setTimeout(() => {
              isremoteapplying = false
            }, 50)
          }
          updatetoolbarstate()
        }
      } else {
        if (editorcontainer) editorcontainer.classList.add('plain-mode')
        if (editortoolbar) editortoolbar.classList.add('hidden')
        if (tiptapeditorcontainer) tiptapeditorcontainer.classList.add('hidden')
        if (plaineditorwrap) plaineditorwrap.classList.remove('hidden')

        setcmcontent(currentcontent, noteid)

        if (isothercreator) {
          const creatorcolor = resolveauthorcolor(createdby)
          flashwholecmnote(createdby, creatorcolor)
        } else if (hasunseenchanges) {
          const authorcolor = resolveauthorcolor(lastauthor)
          rendercmflashhighlight(seendata.content, currentcontent, [], authorcolor, lastauthor)
        }
      }

      writespotseen(noteid, currentcontent)
      connectnotesocket(noteid)
    }

    // persist last open note into user preferences on server --------------------
    if (state.currentuser) {
      if (!state.currentuser.preferences) state.currentuser.preferences = {}
      if (state.currentuser.preferences['last-open-note'] !== noteid) {
        state.currentuser.preferences['last-open-note'] = noteid
        api('/api/user/preferences', {
          method: 'POST',
          body: JSON.stringify({
            preferences: { 'last-open-note': noteid }
          })
        }).catch(() => {})
      }
    }

    updateviewpagebutton()
    saveworkspacestate()
  } catch (err) {
    console.error('failed to read note', err)
  }
}

// compatible helper stubs for cursors and animation --------------------
export function refreshallremotecursors() {}
export function clearallremotecursors() {}
export function broadcastcursorposition() {}

// remeasure editor for reading scale updates --------------------
export function refreshreadingscale() {
  if (cmview) {
    cmview.requestMeasure()
  }
}

// render flash highlight on editor for additions and deletions --------------------
export function renderflashhighlight(olddoc, newdoc, edits = [], usercolor = '#3b82f6', author = '') {
  if (!ismarkdownfile(state.activenoteid)) {
    const oldtext = typeof olddoc === 'string' ? olddoc : (cmview ? cmview.state.doc.toString() : '')
    const newtext = typeof newdoc === 'string' ? newdoc : (cmview ? cmview.state.doc.toString() : '')
    rendercmflashhighlight(oldtext, newtext, edits, usercolor, author)
    return
  }

  if (!tiptapinstance) return
  const doc = newdoc || tiptapinstance.state.doc
  if (!doc) return

  if (flashtimeout) {
    clearTimeout(flashtimeout)
    flashtimeout = null
  }

  const decos = []
  const bgcolor = hextorgba(usercolor, 0.28)
  const bordercolor = hextorgba(usercolor, 0.75)
  const glowcolor = hextorgba(usercolor, 0.35)
  const style = `--flash-user-bg: ${bgcolor}; --flash-user-border: ${bordercolor}; --flash-user-glow: ${glowcolor};`

  let diffstart = null
  let diffend = null

  if (olddoc && olddoc.content && doc.content) {
    diffstart = olddoc.content.findDiffStart(doc.content)
    if (diffstart !== null) {
      diffend = olddoc.content.findDiffEnd(doc.content)
    }
  }

  if (diffstart !== null && diffend !== null) {
    const endinnew = diffend.b
    const endinold = diffend.a

    // pure deletion without replacement --------------------
    if (endinold > diffstart && endinnew <= diffstart) {
      let deletedtext = ''
      if (olddoc && olddoc.content) {
        try {
          deletedtext = olddoc.textBetween(diffstart, Math.min(endinold, olddoc.content.size), ' ')
        } catch {}
      }
      const delpos = Math.max(0, Math.min(diffstart, doc.content.size))
      decos.push(Decoration.widget(delpos, () => createdeletemarker(author, usercolor, deletedtext), { side: 1, stopEvent: () => true }))
    }

    if (endinnew > diffstart) {
      // addition --------------------
      const from = diffstart
      const to = Math.min(endinnew, doc.content.size)

      doc.nodesBetween(from, to, (node, pos) => {
        if (node.isText) {
          const nfrom = Math.max(from, pos)
          const nto = Math.min(to, pos + node.nodeSize)
          if (nfrom < nto) {
            decos.push(Decoration.inline(nfrom, nto, {
              class: 'edit-flash',
              style
            }))
          }
        }
      })

      if (decos.length === 0) {
        doc.nodesBetween(from, to, (node, pos) => {
          if (node.isBlock) {
            decos.push(Decoration.node(pos, pos + node.nodeSize, {
              class: 'edit-flash',
              style
            }))
          }
        })
      }

      if (author) {
        const badgepos = Math.min(to, doc.content.size)
        decos.push(Decoration.widget(badgepos, () => createavatarbadge(author, usercolor), { side: 1 }))
      }
    }
  } else if (Array.isArray(edits) && edits.length > 0) {
    // fallback to delta edits if findDiff did not produce a range --------------------
    for (const edit of edits) {
      if (edit.type === 'delete') {
        const delpos = Math.max(0, Math.min(edit.from || 0, doc.content.size))
        const deltext = edit.text || ''
        decos.push(Decoration.widget(delpos, () => createdeletemarker(author, usercolor, deltext), { side: 1, stopEvent: () => true }))
      } else if (edit.type === 'insert') {
        const from = Math.max(0, Math.min(edit.from || 0, doc.content.size))
        const to = Math.max(from, Math.min(edit.to || (from + (edit.text?.length || 1)), doc.content.size))
        doc.nodesBetween(from, to, (node, pos) => {
          if (node.isText) {
            const nfrom = Math.max(from, pos)
            const nto = Math.min(to, pos + node.nodeSize)
            if (nfrom < nto) {
              decos.push(Decoration.inline(nfrom, nto, { class: 'edit-flash', style }))
            }
          }
        })
        if (author) {
          decos.push(Decoration.widget(to, () => createavatarbadge(author, usercolor), { side: 1 }))
        }
      }
    }
  }

  if (decos.length === 0) return

  try {
    const decoset = DecorationSet.create(doc, decos)
    const tr = tiptapinstance.state.tr.setMeta(flashpluginkey, { action: 'set', decorations: decoset })
    tiptapinstance.view.dispatch(tr)

    flashtimeout = setTimeout(() => {
      if (!tiptapinstance) return
      try {
        const cleartr = tiptapinstance.state.tr.setMeta(flashpluginkey, { action: 'clear' })
        tiptapinstance.view.dispatch(cleartr)
      } catch {}
      flashtimeout = null
    }, 2250)
  } catch (err) {
    console.warn('failed to apply flash decoration', err)
  }
}

// initialize editor note link click and contextmenu listeners on load --------------------
initeditorlinkevents()
