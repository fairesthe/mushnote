import { api } from '../core/api.js'
import { state } from '../core/state.js'
import {
  Editor,
  Placeholder,
  NoteDoubleEnterBreak,
  TaskListMarkdownInput,
  NodeSelection,
  dropPoint,
  Slice,
  Fragment,
  detectlatex,
  detectmermaid,
  MermaidExtension,
  notecontentextensions,
  patchnotemarkdown,
  cmUndo,
  cmRedo,
  ySyncPluginKey
} from './tiptap.bundle.js'
import { ed, editortoolbar, tiptapeditorcontainer } from './editorshared.js'
import { ismarkdownfile, geteditormarkdown, isexternalurl } from './noteutils.js'
import { handleimagepaste, pickandinsertimage } from './imageupload.js'
import {
  formatdraginsert,
  getdraggeditem,
  clearalldraghighlights,
  insertcontentintoactivenote
} from './dragdrop.js'
import { clearpinnededitorselection, geteditorselectionreference, openeditorselectionmenu } from './selection.js'
import {
  remoteselectionextension,
  pinselectionextension,
  liveflashextension,
  collabundo,
  collabredo,
  collabundoextension,
  flashextension
} from './tiptapplugins.js'
import { opennotelink, initeditorlinkevents } from './links.js'
import { schedulecursorbroadcast, collabpeerslive, schedulespotseen } from './collab.js'

function editmathnode(node, pos, label) {
  const current = node.attrs.latex || ''
  const updated = window.prompt(label, current)
  if (updated === null) return
  if (!updated.trim()) {
    ed.tiptapinstance.commands.deleteRange({ from: pos, to: pos + node.nodeSize })
  } else {
    ed.tiptapinstance.chain().setNodeSelection(pos).command(({ tr }) => {
      tr.setNodeMarkup(pos, undefined, { latex: updated.trim() })
      return true
    }).run()
  }
}

// initialize tiptap markdown editor --------------------
export function inittiptapeditor() {
  if (ed.tiptapinstance) return ed.tiptapinstance
  if (!tiptapeditorcontainer) return null

  ed.tiptapinstance = new Editor({
    element: tiptapeditorcontainer,
    extensions: [
      ...notecontentextensions({
        oninlinemathclick: (node, pos) => editmathnode(node, pos, 'edit latex formula:'),
        onblockmathclick: (node, pos) => editmathnode(node, pos, 'edit block latex formula:')
      }),
      Placeholder.configure({
        placeholder: 'start typing in markdown...'
      }),
      NoteDoubleEnterBreak,
      TaskListMarkdownInput,
      MermaidExtension,
      collabundoextension,
      flashextension,
      liveflashextension,
      pinselectionextension,
      remoteselectionextension
    ],
    editorProps: {
      attributes: {
        spellcheck: 'false',
        autocorrect: 'off',
        autocapitalize: 'off',
        'data-gramm': 'false',
        'data-gramm_editor': 'false',
        'data-enable-grammarly': 'false',
      },
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
          ed.draggedimagenodepos = null
          const imgel = event.target?.closest?.('[data-resize-container]') || (event.target?.tagName === 'IMG' ? event.target : null)
          if (imgel) {
            try {
              const desc = view.docView?.nearestDesc?.(imgel, true)
              const resolvedpos = desc && desc.node && desc.node.type.name === 'image' ? desc.posBefore : null
              if (typeof resolvedpos === 'number' && resolvedpos >= 0) {
                ed.draggedimagenodepos = resolvedpos
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
            ed.draggedimagenodepos = null
            window.__mushnote_dragged_image_pos = null
          }, 300)
          return false
        },
        contextmenu: (view, event) => {
          const link = event.target?.closest?.('a')
          if (link) {
            const href = link.getAttribute('data-note-link') || link.getAttribute('href')
            if (href && !isexternalurl(href)) {
              event.preventDefault()
              event.stopPropagation()
              opennotelink(href, { newtab: true })
              return true
            }
          }

          event.preventDefault()
          event.stopPropagation()
          const ref = geteditorselectionreference()
          openeditorselectionmenu(event.clientX, event.clientY, ref)
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

        const mermaidpaste = detectmermaid(text)
        if (mermaidpaste) {
          event.preventDefault()
          ed.tiptapinstance.commands.insertContent({
            type: 'codeBlock',
            attrs: { language: 'mermaid' },
            content: [{ type: 'text', text: mermaidpaste.source }],
          })
          return true
        }

        const detected = detectlatex(text)
        if (!detected) return false

        event.preventDefault()
        const { latex, isblock } = detected

        if (isblock) {
          ed.tiptapinstance.commands.insertContent({
            type: 'blockMath',
            attrs: { latex }
          })
        } else {
          ed.tiptapinstance.commands.insertContent({
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
        if (sourcepos === null && typeof ed.draggedimagenodepos === 'number' && ed.draggedimagenodepos >= 0) {
          sourcepos = ed.draggedimagenodepos
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
          ed.draggedimagenodepos = null
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
      if (ed.isremoteapplying) return
      const targetnoteid = state.activenoteid
      if (!targetnoteid) return
      schedulespotseen(targetnoteid)
      const syncstate = ySyncPluginKey.getState(editor.state)
      if (syncstate?.isChangeOrigin) return
      if (ed.pinnedselection) clearpinnededitorselection()

      // the yjs binding carries every keystroke, rest save is only the no websocket fallback --------------------
      if (ed.collabbound || !ed.fallbackedit) return

      if (ed.savetimer) clearTimeout(ed.savetimer)
      ed.savetimer = setTimeout(async () => {
        try {
          const md = geteditormarkdown(editor)
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
    onSelectionUpdate: ({ editor }) => {
      if (editor.isFocused) {
        clearpinnededitorselection()
      }
      updatetoolbarstate()
      if (collabpeerslive()) {
        const { head, anchor } = editor.state.selection
        schedulecursorbroadcast(head, anchor)
      }
    },
    onTransaction: () => {
      updatetoolbarstate()
    }
  })

  // same markdown rules the server uses so both sides agree on every note --------------------
  patchnotemarkdown(ed.tiptapinstance)

  // bind toolbar click actions once --------------------
  if (editortoolbar && !ed.istoolbarbound) {
    ed.istoolbarbound = true
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
  return ed.tiptapinstance
}

// execute toolbar format actions --------------------
function handletoolbaraction(action) {
  if (!ed.tiptapinstance) return
  ed.tiptapinstance.chain().focus()

  switch (action) {
    case 'h1':
      ed.tiptapinstance.chain().focus().toggleHeading({ level: 1 }).run()
      break
    case 'h2':
      ed.tiptapinstance.chain().focus().toggleHeading({ level: 2 }).run()
      break
    case 'h3':
      ed.tiptapinstance.chain().focus().toggleHeading({ level: 3 }).run()
      break
    case 'bold':
      ed.tiptapinstance.chain().focus().toggleBold().run()
      break
    case 'italic':
      ed.tiptapinstance.chain().focus().toggleItalic().run()
      break
    case 'strike':
      ed.tiptapinstance.chain().focus().toggleStrike().run()
      break
    case 'highlight':
      ed.tiptapinstance.chain().focus().toggleHighlight().run()
      break
    case 'link': {
      const current = ed.tiptapinstance.getAttributes('link').href || ''
      const url = window.prompt('enter note filename (e.g. todo.md) or web url:', current)
      if (url === null) break
      if (!url.trim()) {
        ed.tiptapinstance.chain().focus().unsetLink().run()
      } else {
        ed.tiptapinstance.chain().focus().setLink({ href: url.trim() }).run()
      }
      break
    }
    case 'image':
      pickandinsertimage()
      break
    case 'latex': {
      const formula = window.prompt('enter latex formula (e.g. E = mc^2):', '')
      if (formula && formula.trim()) {
        ed.tiptapinstance.chain().focus().insertContent({
          type: 'inlineMath',
          attrs: { latex: formula.trim() }
        }).run()
      }
      break
    }
    case 'code':
      ed.tiptapinstance.chain().focus().toggleCode().run()
      break
    case 'bullet-list':
      ed.tiptapinstance.chain().focus().toggleBulletList().run()
      break
    case 'ordered-list':
      ed.tiptapinstance.chain().focus().toggleOrderedList().run()
      break
    case 'task-list':
      ed.tiptapinstance.chain().focus().toggleTaskList().run()
      break
    case 'blockquote':
      ed.tiptapinstance.chain().focus().toggleBlockquote().run()
      break
    case 'code-block':
      ed.tiptapinstance.chain().focus().toggleCodeBlock().run()
      break
    case 'horizontal-rule':
      ed.tiptapinstance.chain().focus().setHorizontalRule().run()
      break
    case 'undo':
      if (ismarkdownfile(state.activenoteid)) {
        ed.tiptapinstance?.commands.focus()
        collabundo()
      } else if (ed.cmview) {
        if (ed.collabbound === 'text' && ed.cmundomanager) ed.cmundomanager.undo()
        else cmUndo(ed.cmview)
      }
      break
    case 'redo':
      if (ismarkdownfile(state.activenoteid)) {
        ed.tiptapinstance?.commands.focus()
        collabredo()
      } else if (ed.cmview) {
        if (ed.collabbound === 'text' && ed.cmundomanager) ed.cmundomanager.redo()
        else cmRedo(ed.cmview)
      }
      break
  }

  updatetoolbarstate()
}

// update active highlights on toolbar buttons based on current selection --------------------
export function updatetoolbarstate() {
  if (!ed.tiptapinstance || !editortoolbar) return
  const buttons = editortoolbar.querySelectorAll('.toolbar-btn')
  for (const btn of buttons) {
    const action = btn.dataset.action
    if (!action) continue
    let isactive = false
    switch (action) {
      case 'h1': isactive = ed.tiptapinstance.isActive('heading', { level: 1 }); break
      case 'h2': isactive = ed.tiptapinstance.isActive('heading', { level: 2 }); break
      case 'h3': isactive = ed.tiptapinstance.isActive('heading', { level: 3 }); break
      case 'bold': isactive = ed.tiptapinstance.isActive('bold'); break
      case 'italic': isactive = ed.tiptapinstance.isActive('italic'); break
      case 'strike': isactive = ed.tiptapinstance.isActive('strike'); break
      case 'highlight': isactive = ed.tiptapinstance.isActive('highlight'); break
      case 'link': isactive = ed.tiptapinstance.isActive('link'); break
      case 'code': isactive = ed.tiptapinstance.isActive('code'); break
      case 'bullet-list': isactive = ed.tiptapinstance.isActive('bulletList'); break
      case 'ordered-list': isactive = ed.tiptapinstance.isActive('orderedList'); break
      case 'task-list': isactive = ed.tiptapinstance.isActive('taskList'); break
      case 'blockquote': isactive = ed.tiptapinstance.isActive('blockquote'); break
      case 'code-block': isactive = ed.tiptapinstance.isActive('codeBlock'); break
    }
    btn.classList.toggle('is-active', isactive)
  }
}

