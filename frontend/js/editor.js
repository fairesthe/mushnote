import { api, hextorgba } from './api.js'
import { state } from './state.js'
import { rendertabs } from './tabs.js'
import { renderfolderview, updateactivefilerow } from './files.js'
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
  PluginKey
} from './tiptap.bundle.js'

// dom elements for editor --------------------
const editorcontainer = document.getElementById('editor-container')
const emptystate = document.getElementById('empty-state')
const editortoolbar = document.getElementById('editor-toolbar')
const tiptapeditorcontainer = document.getElementById('tiptap-editor')
const imageviewercontainer = document.getElementById('image-viewer-container')
const imageviewerimg = document.getElementById('image-viewer-img')
const imageviewermeta = document.getElementById('image-viewer-meta')

let tiptapinstance = null
let notesocket = null
let savetimer = null
let istoolbarbound = false
let flashtimeout = null
const flashpluginkey = new PluginKey('flashhighlight')

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

// create user avatar badge for flash highlights --------------------
function createavatarbadge(author, usercolor) {
  const useravatar = state.useravatarmap?.[author]
    || (author === 'ai' ? '/avatars/ai.jpg' : `/avatars/${author}.png`)

  const anchor = document.createElement('span')
  anchor.className = 'edit-user-anchor'

  const badge = document.createElement('span')
  badge.className = 'edit-user-badge'
  badge.title = author
  badge.style.setProperty('--flash-user-border', usercolor)
  badge.style.setProperty('--flash-user-glow', hextorgba(usercolor, 0.45))

  const img = document.createElement('img')
  img.src = useravatar
  img.alt = author
  img.className = 'edit-user-img'

  const fallback = document.createElement('span')
  fallback.className = 'edit-user-fallback'
  fallback.textContent = (author.charAt(0) || '?').toUpperCase()
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

  if (deletedtext && deletedtext.length > 0) {
    const textspan = document.createElement('span')
    textspan.className = 'edit-delete-text'
    textspan.textContent = deletedtext.length > 300 ? `${deletedtext.slice(0, 300)}...` : deletedtext
    marker.appendChild(textspan)
  } else {
    marker.classList.add('is-empty')
  }

  if (author && author !== 'external') {
    const badge = createavatarbadge(author, usercolor)
    marker.appendChild(badge)
  }

  return marker
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
        linkify: true,
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
      flashextension
    ],
    content: '',
    onUpdate: ({ editor }) => {
      if (!state.activenoteid) return

      if (savetimer) clearTimeout(savetimer)
      savetimer = setTimeout(async () => {
        try {
          const md = editor.storage.markdown.getMarkdown()
          await api('/api/notes', {
            method: 'POST',
            body: JSON.stringify({
              note_id: state.activenoteid,
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

  // bind toolbar click actions once --------------------
  if (editortoolbar && !istoolbarbound) {
    istoolbarbound = true
    editortoolbar.addEventListener('click', (e) => {
      const btn = e.target.closest('.toolbar-btn')
      if (!btn) return
      e.preventDefault()
      const action = btn.dataset.action
      if (action) handletoolbaraction(action)
    })
  }

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
      tiptapinstance.chain().focus().undo().run()
      break
    case 'redo':
      tiptapinstance.chain().focus().redo().run()
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
          const newtitle = newid.split('/').pop() || newid
          document.title = `${newtitle} - mushnote`
        }
        if (modified) {
          rendertabs()
          saveworkspacestate()
        }
      }
    } catch {}
  }
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
        if (item.author && item.author !== 'external') {
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

// handle remote user edit event --------------------
function handleotheruseredit(data = {}) {
  if (!state.activenoteid || !tiptapinstance) return
  const author = data.author || 'ai'
  const usercolor = author === 'external' ? '#737373' : (state.usercolormap[author] || (author === 'ai' ? '#3b82f6' : '#10b981'))

  function applycontent(text) {
    if (!tiptapinstance) return
    const currentmd = tiptapinstance.storage.markdown.getMarkdown()
    if (currentmd === text) return

    if (savetimer) {
      clearTimeout(savetimer)
      savetimer = null
    }

    const olddoc = tiptapinstance.state.doc
    tiptapinstance.commands.setContent(text, false)
    const newdoc = tiptapinstance.state.doc

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

      // record deletion if text was removed from old doc --------------------
      if (endinold > diffstart) {
        let deletedtext = ''
        if (olddoc && olddoc.content) {
          try {
            deletedtext = olddoc.textBetween(diffstart, Math.min(endinold, olddoc.content.size), '\n')
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
  if (editorcontainer) editorcontainer.classList.add('hidden')
  if (imageviewercontainer) imageviewercontainer.classList.add('hidden')
  if (emptystate) emptystate.classList.remove('hidden')
  updateactivefilerow()

  if (tiptapinstance) {
    tiptapinstance.commands.setContent('', false)
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
  const fallbacktitle = noteid.split('/').pop() || noteid
  document.title = `${fallbacktitle} - mushnote`
  const opts = typeof options === 'boolean' ? { force: options } : (options || {})
  const { newtab = false, replacecurrent = true, switchfolder = true } = opts

  // manage open tabs list --------------------
  if (newtab) {
    if (!state.opentabs.includes(noteid)) {
      state.opentabs.push(noteid)
    }
  } else if (replacecurrent) {
    if (state.opentabs.length === 0) {
      state.opentabs = [noteid]
    } else if (state.opentabs.includes(noteid)) {
      // note already in tabs so keep existing tabs
    } else if (state.activenoteid && state.opentabs.includes(state.activenoteid)) {
      const idx = state.opentabs.indexOf(state.activenoteid)
      state.opentabs[idx] = noteid
    } else {
      state.opentabs.push(noteid)
    }
  } else {
    if (!state.opentabs.includes(noteid)) {
      state.opentabs.push(noteid)
    }
  }

  // deduplicate tabs --------------------
  state.opentabs = Array.from(new Set(state.opentabs))

  state.activenoteid = noteid
  rendertabs()

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
    const notetitle = data?.note?.title || fallbacktitle
    document.title = `${notetitle} - mushnote`

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

      const editor = inittiptapeditor()
      if (editor) {
        editor.commands.setContent(data.note.content || '', false)
        updatetoolbarstate()
      }
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

    saveworkspacestate()
  } catch (err) {
    console.error('failed to read note', err)
  }
}

// compatible helper stubs for cursors and animation --------------------
export function refreshallremotecursors() {}
export function clearallremotecursors() {}
export function broadcastcursorposition() {}

// render flash highlight on tiptap editor for additions and deletions --------------------
export function renderflashhighlight(olddoc, newdoc, edits = [], usercolor = '#3b82f6', author = '') {
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

    // deletion or replacement --------------------
    if (endinold > diffstart) {
      let deletedtext = ''
      if (olddoc && olddoc.content) {
        try {
          deletedtext = olddoc.textBetween(diffstart, Math.min(endinold, olddoc.content.size), '\n')
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

      if (author && author !== 'external') {
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
        if (author && author !== 'external') {
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
