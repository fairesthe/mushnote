import { Mark, mergeAttributes, markInputRule, InputRule, wrappingInputRule, ResizableNodeView, getRenderedAttributes } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from 'tiptap-markdown'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import BulletList from '@tiptap/extension-bullet-list'
import HardBreak from '@tiptap/extension-hard-break'
import { Fragment } from '@tiptap/pm/model'
import { MarkdownSerializerState } from 'prosemirror-markdown'
import katexPlugin from '@vscode/markdown-it-katex'
import { InlineMath as BaseInlineMath, BlockMath as BaseBlockMath } from '@tiptap/extension-mathematics'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'

// shared by the browser editor and the server so markdown round trips the same on both sides --------------------

// markdown it inline rule for ==highlight== syntax --------------------
export function mark_plugin(md) {
  // tiptap-markdown reruns setup on every parse so only register once per instance --------------------
  if (md.__mushmark) return
  md.__mushmark = true

  function tokenize(state, silent) {
    let start = state.pos
    const marker = state.src.charCodeAt(start)

    if (silent) return false
    if (marker !== 0x3D) return false

    const scanned = state.scanDelims(state.pos, true)
    let len = scanned.length
    const ch = String.fromCharCode(marker)

    if (len < 2) return false

    if (len % 2) {
      const token = state.push('text', '', 0)
      token.content = ch
      len--
      start++
    }

    for (let i = 0; i < len; i += 2) {
      const token = state.push('text', '', 0)
      token.content = ch + ch

      state.delimiters.push({
        marker,
        length: len,
        jump: i / 2,
        token: state.tokens.length - 1,
        level: state.level,
        end: -1,
        open: scanned.can_open,
        close: scanned.can_close
      })
    }

    state.pos += scanned.length
    return true
  }

  function postProcess(state, delimiters) {
    const lonemarkers = []
    const max = delimiters.length

    for (let i = 0; i < max; i++) {
      const startdelim = delimiters[i]

      if (startdelim.marker !== 0x3D) continue
      if (startdelim.end === -1) continue

      const enddelim = delimiters[startdelim.end]

      const starttoken = state.tokens[startdelim.token]
      starttoken.type = 'mark_open'
      starttoken.tag = 'mark'
      starttoken.nesting = 1
      starttoken.markup = '=='
      starttoken.content = ''

      const endtoken = state.tokens[enddelim.token]
      endtoken.type = 'mark_close'
      endtoken.tag = 'mark'
      endtoken.nesting = -1
      endtoken.markup = '=='
      endtoken.content = ''

      if (state.tokens[enddelim.token - 1].type === 'text' &&
          state.tokens[enddelim.token - 1].content === '=') {
        lonemarkers.push(enddelim.token - 1)
      }
    }

    while (lonemarkers.length) {
      let i = lonemarkers.pop()
      let j = i + 1
      while (j < state.tokens.length && state.tokens[j].type === 'mark_close') j++
      j--
      if (i !== j) {
        const token = state.tokens[i]
        state.tokens[i] = state.tokens[j]
        state.tokens[j] = token
      }
    }
  }

  md.inline.ruler.before('emphasis', 'mark', tokenize)
  md.inline.ruler2.before('emphasis', 'mark', function (state) {
    const delimiters = state.delimiters
    const max = state.delimiters.length

    postProcess(state, delimiters)

    for (let curr = 0; curr < max; curr++) {
      if (delimiters[curr].marker === 0x3D) {
        postProcess(state, delimiters[curr].delimiters || [])
      }
    }
  })
}

// tiptap highlight mark with == markdown serializer and parser --------------------
const starthighlightregex = /(?:^|\s)(==(?!\s+==)([^=]+)==)$/

export const Highlight = Mark.create({
  name: 'highlight',

  addOptions() {
    return {
      HTMLAttributes: {}
    }
  },

  parseHTML() {
    return [
      {
        tag: 'mark'
      }
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return ['mark', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0]
  },

  addCommands() {
    return {
      setHighlight: attributes => ({ commands }) => {
        return commands.setMark(this.name, attributes)
      },
      toggleHighlight: attributes => ({ commands }) => {
        return commands.toggleMark(this.name, attributes)
      },
      unsetHighlight: () => ({ commands }) => {
        return commands.unsetMark(this.name)
      }
    }
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Shift-h': () => this.editor.commands.toggleHighlight()
    }
  },

  addInputRules() {
    return [
      markInputRule({
        find: starthighlightregex,
        type: this.type
      })
    ]
  },

  addStorage() {
    return {
      markdown: {
        serialize: {
          open: '==',
          close: '==',
          expelEnclosingWhitespace: true
        },
        parse: {
          setup(md) {
            mark_plugin(md)
          }
        }
      }
    }
  }
})

// inline latex math node for note editor --------------------
export const katexmarkdownplugin = katexPlugin.default || katexPlugin

export const InlineMath = BaseInlineMath.extend({
  addInputRules() {
    return [
      ...(this.parent?.() || []),
      new InputRule({
        find: /(?:^|\s)\$([^$\n]+)\$$/,
        handler: ({ state, range, match }) => {
          const latex = match[1]?.trim()
          if (!latex) return null
          const { tr } = state
          tr.replaceWith(range.from, range.to, this.type.create({ latex }))
        }
      })
    ]
  },
  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          state.write(`$${node.attrs.latex}$`)
        },
        parse: {
          setup(md) {
            if (md.__mushkatex) return
            md.__mushkatex = true
            md.use(katexmarkdownplugin)
          },
          updateDOM(dom) {
            dom.querySelectorAll('.katex-display').forEach(el => {
              const ann = el.querySelector('annotation[encoding="application/x-tex"]')
              const latex = ann ? ann.textContent.trim() : ''
              const div = document.createElement('div')
              div.setAttribute('data-type', 'block-math')
              div.setAttribute('data-latex', latex)
              const parent = el.closest('p.katex-block') || el
              parent.replaceWith(div)
            })
            dom.querySelectorAll('.katex').forEach(el => {
              const ann = el.querySelector('annotation[encoding="application/x-tex"]')
              const latex = ann ? ann.textContent.trim() : ''
              const span = document.createElement('span')
              span.setAttribute('data-type', 'inline-math')
              span.setAttribute('data-latex', latex)
              el.replaceWith(span)
            })
          }
        }
      }
    }
  }
})

// block display latex math node for note editor --------------------
export const BlockMath = BaseBlockMath.extend({
  addInputRules() {
    return [
      ...(this.parent?.() || []),
      new InputRule({
        find: /^\$\$([^$]+)\$\$$/,
        handler: ({ state, range, match }) => {
          const latex = match[1]?.trim()
          if (!latex) return null
          const { tr } = state
          tr.replaceWith(range.from, range.to, this.type.create({ latex }))
        }
      })
    ]
  },
  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          state.write(`\n\n$$\n${node.attrs.latex}\n$$\n\n`)
        }
      }
    }
  }
})

// hard breaks round trip as <br> in saved markdown --------------------
export const NoteHardBreak = HardBreak.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state) {
          state.write('<br>')
        },
        parse: {}
      }
    }
  }
})

// bullet lists skip `- [ ]` so task list input can own that prefix --------------------
const bulletListInputRegex = /^\s*([-+*])(?!\s+\[)\s$/

export const CustomBulletList = BulletList.extend({
  addInputRules() {
    let rule = wrappingInputRule({
      find: bulletListInputRegex,
      type: this.type
    })
    if (this.options.keepMarks || this.options.keepAttributes) {
      rule = wrappingInputRule({
        find: bulletListInputRegex,
        type: this.type,
        keepMarks: this.options.keepMarks,
        keepAttributes: this.options.keepAttributes,
        getAttributes: () => this.editor.getAttributes(this.type.name),
        editor: this.editor
      })
    }
    return [rule]
  }
})

// link extension with note linking and custom attributes --------------------
export const NoteLink = Link.extend({
  name: 'link',

  renderHTML({ HTMLAttributes }) {
    const href = HTMLAttributes.href || ''
    const isexternal = /^(https?:|\/\/|mailto:|tel:)/i.test(href)
    const attrs = {
      ...HTMLAttributes,
      class: isexternal ? 'editor-link external-link' : 'editor-link note-link'
    }
    if (isexternal) {
      attrs.target = '_blank'
      attrs.rel = 'noopener noreferrer'
    } else {
      attrs['data-note-link'] = href
      attrs.title = 'click to open (right click for new tab)'
    }
    return ['a', mergeAttributes(this.options.HTMLAttributes, attrs), 0]
  }
})

// custom resizable node view that preserves aspect ratio on corner handles only --------------------
class CustomResizableNodeView extends ResizableNodeView {
  handleResize(deltaX, deltaY) {
    if (!this.activeHandle) return
    const iscorner = this.activeHandle.includes('-')

    let width = this.startWidth
    let height = this.startHeight

    if (iscorner) {
      // corner handle scales width and height together preserving aspect ratio --------------------
      const isright = this.activeHandle.includes('right')
      const isleft = this.activeHandle.includes('left')
      const isbottom = this.activeHandle.includes('bottom')
      const istop = this.activeHandle.includes('top')

      const newwidth = this.startWidth + (isright ? deltaX : (isleft ? -deltaX : 0))
      const newheight = this.startHeight + (isbottom ? deltaY : (istop ? -deltaY : 0))

      const dims = this.applyAspectRatio(newwidth, newheight, this.activeHandle)
      const constrained = this.applyConstraints(dims.width, dims.height, true)
      width = constrained.width
      height = constrained.height
    } else if (this.activeHandle.includes('right') || this.activeHandle.includes('left')) {
      // horizontal edge handle adjusts width only and keeps height unchanged --------------------
      const isright = this.activeHandle.includes('right')
      const newwidth = this.startWidth + (isright ? deltaX : -deltaX)
      const constrained = this.applyConstraints(newwidth, this.startHeight, false)
      width = constrained.width
      height = this.startHeight
    } else if (this.activeHandle.includes('bottom') || this.activeHandle.includes('top')) {
      // vertical edge handle adjusts height only and keeps width unchanged --------------------
      const isbottom = this.activeHandle.includes('bottom')
      const newheight = this.startHeight + (isbottom ? deltaY : -deltaY)
      const constrained = this.applyConstraints(this.startWidth, newheight, false)
      width = this.startWidth
      height = constrained.height
    }

    this.element.style.width = `${Math.round(width)}px`
    this.element.style.height = `${Math.round(height)}px`
    if (this.onResize) this.onResize(Math.round(width), Math.round(height))
  }
}

// custom resizable image extension with obsidian syntax support --------------------
export const ResizableImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: el => {
          const w = el.getAttribute('width') || el.style.width
          return w ? parseInt(w, 10) : null
        },
        renderHTML: attrs => {
          if (!attrs.width) return {}
          return { width: attrs.width }
        }
      },
      height: {
        default: null,
        parseHTML: el => {
          const h = el.getAttribute('height') || el.style.height
          return h ? parseInt(h, 10) : null
        },
        renderHTML: attrs => {
          if (!attrs.height) return {}
          return { height: attrs.height }
        }
      }
    }
  },

  addNodeView() {
    if (!this.options.resize || !this.options.resize.enabled || typeof document === 'undefined') return null
    const { directions, minWidth, minHeight, alwaysPreserveAspectRatio } = this.options.resize
    const resizemanagedattributes = new Set(['src', 'width', 'height'])

    return ({ node, getPos, HTMLAttributes, editor }) => {
      const el = document.createElement('img')
      el.draggable = false
      const mergedattributes = mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)
      Object.entries(mergedattributes).forEach(([key, value]) => {
        if (value != null) {
          switch (key) {
            case 'src':
            case 'width':
            case 'height':
              break
            default:
              el.setAttribute(key, value)
          }
        }
      })
      if (mergedattributes.src !== null) el.src = mergedattributes.src

      let previoushtmlattributes = { ...HTMLAttributes }
      const syncimagesource = (src) => {
        if (typeof src === 'string' && src !== '') {
          if (el.getAttribute('src') !== src) el.src = src
          return
        }
        if (el.hasAttribute('src')) el.removeAttribute('src')
        if (el.src !== '') el.src = ''
      }
      syncimagesource(HTMLAttributes.src)

      const onupdate = (updatednode) => {
        if (updatednode.type !== node.type) return false
        const extensionattributes = editor.extensionManager.attributes.filter((attribute) => attribute.type === updatednode.type.name)
        const newhtmlattributes = getRenderedAttributes(updatednode, extensionattributes)
        Object.keys(previoushtmlattributes).forEach((key) => {
          if (!resizemanagedattributes.has(key) && !(key in newhtmlattributes)) el.removeAttribute(key)
        })
        Object.entries(newhtmlattributes).forEach(([key, value]) => {
          if (resizemanagedattributes.has(key)) return
          if (value != null) el.setAttribute(key, value)
          else el.removeAttribute(key)
        })
        syncimagesource(newhtmlattributes.src)
        previoushtmlattributes = newhtmlattributes
        return true
      }

      const nodeview = new CustomResizableNodeView({
        element: el,
        editor,
        node,
        getPos,
        onResize: (width, height) => {
          el.style.width = `${width}px`
          el.style.height = `${height}px`
        },
        onCommit: (width, height) => {
          const pos = getPos()
          if (pos === void 0) return
          this.editor.chain().setNodeSelection(pos).updateAttributes(this.name, {
            width,
            height
          }).run()
        },
        onUpdate: onupdate,
        options: {
          directions,
          min: {
            width: minWidth,
            height: minHeight
          },
          preserveAspectRatio: alwaysPreserveAspectRatio === true
        }
      })

      const dom = nodeview.dom
      const shownodeview = () => {
        dom.style.visibility = ''
        dom.style.pointerEvents = ''
        if (nodeview.element.offsetHeight > 0 && (!nodeview.initialHeight || nodeview.initialHeight === 0)) {
          nodeview.applyInitialSize()
        }
      }
      dom.style.visibility = 'hidden'
      dom.style.pointerEvents = 'none'

      // allow moving image by dragging without leaving duplicates --------------------
      dom.setAttribute('draggable', 'true')
      dom.addEventListener('dragstart', (e) => {
        if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-resize-handle')) {
          e.preventDefault()
          return
        }
        const currentpos = typeof getPos === 'function' ? getPos() : null
        if (typeof currentpos === 'number' && currentpos >= 0) {
          e.dataTransfer.setData('application/mushnote-editor-image-pos', String(currentpos))
          e.dataTransfer.effectAllowed = 'move'
          window.__mushnote_dragged_image_pos = currentpos
        }
      })
      dom.addEventListener('dragend', () => {
        setTimeout(() => {
          window.__mushnote_dragged_image_pos = null
        }, 300)
      })

      if (el.complete && el.naturalWidth > 0) shownodeview()
      else {
        el.onload = shownodeview
        el.onerror = shownodeview
      }
      return nodeview
    }
  }
})

// every extension that shapes the document schema --------------------
// the editor and the server must build from this exact list or yjs drops unknown nodes
const nospell = {
  spellcheck: 'false',
  autocorrect: 'off',
  autocapitalize: 'off'
}

export function notecontentextensions(opts = {}) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      undoRedo: false,
      bulletList: false,
      hardBreak: false,
      link: false,
      trailingNode: opts.headless ? false : undefined,
      dropcursor: opts.headless ? false : undefined,
      gapcursor: opts.headless ? false : undefined,
      codeBlock: { HTMLAttributes: nospell },
      code: { HTMLAttributes: nospell }
    }),
    Markdown.configure({
      html: true,
      tightLists: true,
      bulletListMarker: '-',
      linkify: false,
      breaks: true,
      transformPastedText: !opts.headless,
      transformCopiedText: !opts.headless
    }),
    NoteHardBreak,
    CustomBulletList,
    TaskList,
    TaskItem.configure({
      nested: true
    }),
    Highlight,
    InlineMath.configure({
      onClick: opts.oninlinemathclick
    }),
    BlockMath.configure({
      onClick: opts.onblockmathclick
    }),
    NoteLink.configure({
      openOnClick: false,
      autolink: !opts.headless,
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
        enabled: !opts.headless,
        directions: ['bottom-right', 'right', 'bottom'],
        alwaysPreserveAspectRatio: true,
        minWidth: 30,
        minHeight: 30
      },
      HTMLAttributes: {
        class: 'editor-image'
      }
    })
  ]
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
  // trim runaway blank lines only at five or more, keep intentional spacing --------------------
  cleaned = cleaned.replace(/\n{5,}/g, '\n\n\n\n')
  return cleaned
}

// extra blank lines in md become empty blocks before markdown-it parse --------------------
export function expandmarkdownblanklines(text) {
  if (!text) return ''
  return text.replace(/\n{3,}/g, (match) => {
    const extra = Math.max(0, (match.length >> 1) - 1)
    if (extra === 0) return match
    const spacer = Array(extra).fill('<p></p>').join('\n')
    return `\n\n${spacer}\n`
  })
}

export function preparemarkdownforload(text) {
  return expandmarkdownblanklines(cleanmarkdown(text))
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
  splitmixedtasklists(mdstate)
}

// markdown-it glues `- [ ]` and `-` lists into one list when only a blank line sits between them --------------------
// tiptap cant fit plain items in a task list so they turned into ordered lists, split them back apart
function splitmixedtasklists(mdstate) {
  const out = []
  const stack = []
  const makelisttoken = (type, nesting, like) => {
    const tok = new mdstate.Token(type, 'ul', nesting)
    tok.level = like.level
    tok.markup = like.markup
    tok.block = true
    return tok
  }
  const setkind = (tok, kind) => {
    tok.attrs = (tok.attrs || []).filter(([key]) => key !== 'class')
    if (kind === 'task') tok.attrs.push(['class', 'contains-task-list'])
    if (!tok.attrs.length) tok.attrs = null
  }

  const lines = mdstate.src.split('\n')
  const isblank = (line) => !lines[line] || !lines[line].trim()
  // the glued list went loose because of the gap, each half gets its own tight or loose call --------------------
  const fixtightness = (run) => {
    if (!run.split || !run.items.length) return
    const first = run.items[0].map?.[0]
    const last = run.items[run.items.length - 1].map
    if (first === undefined || !last) return
    let end = last[1]
    while (end > last[0] && isblank(end - 1)) end--
    let tight = true
    for (let line = first; line < end; line++) {
      if (isblank(line)) {
        tight = false
        break
      }
    }
    for (const para of run.paragraphs) para.hidden = tight
  }

  for (const tok of mdstate.tokens) {
    if (tok.type === 'bullet_list_open') {
      stack.push({ open: tok, kind: null, run: { items: [], paragraphs: [], split: false } })
    } else if (tok.type === 'bullet_list_close') {
      fixtightness(stack.pop().run)
    } else if (tok.type === 'list_item_open' && stack.length) {
      const top = stack[stack.length - 1]
      if (tok.level === top.open.level + 1) {
        const kind = tok.attrGet('class') === 'task-list-item' ? 'task' : 'plain'
        if (top.kind && top.kind !== kind) {
          const open = makelisttoken('bullet_list_open', 1, top.open)
          out.push(makelisttoken('bullet_list_close', -1, top.open), open)
          top.run.split = true
          fixtightness(top.run)
          top.open = open
          top.run = { items: [], paragraphs: [], split: true }
        }
        top.kind = kind
        top.run.items.push(tok)
        setkind(top.open, kind)
      }
    } else if ((tok.type === 'paragraph_open' || tok.type === 'paragraph_close') && stack.length) {
      const top = stack[stack.length - 1]
      if (tok.level === top.open.level + 2) top.run.paragraphs.push(tok)
    }
    out.push(tok)
  }
  mdstate.tokens = out
}

// obsidian style image sizes ![alt](src|300x200) --------------------
function serializeimage(state, node) {
  const alt = node.attrs.alt || ''
  const src = node.attrs.src || ''
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

// tiptap-markdown rebuilds serializer.nodes on every read so overrides go in at serialize time --------------------
const nodeoverrides = {
  image: serializeimage
}

// export each top level block with blank lines between --------------------
export function patchnotemarkdownserializer(editor) {
  const storage = editor?.storage?.markdown
  if (!storage?.serializer) return
  storage.serializer.serialize = (content) => {
    const state = new MarkdownSerializerState(
      { ...storage.serializer.nodes, ...nodeoverrides },
      storage.serializer.marks,
      {
        hardBreakNodeName: 'hardBreak',
        tightLists: true
      }
    )
    state.renderContent(content)
    state.flushClose(2)
    return state.out
  }
}

export function patchnotemarkdownparser(editor) {
  const storage = editor?.storage?.markdown
  if (!storage?.parser?.parse) return
  const origparse = storage.parser.parse.bind(storage.parser)
  storage.parser.parse = (content, opts) => {
    if (typeof content === 'string') {
      content = expandmarkdownblanklines(content)
    }
    return origparse(content, opts)
  }
}

// every serializer and parser tweak notes depend on, applied once per editor --------------------
export function patchnotemarkdown(editor) {
  patchnotemarkdownserializer(editor)
  patchnotemarkdownparser(editor)
  const storage = editor?.storage?.markdown
  if (!storage) return

  if (storage.parser && storage.parser.md) {
    const md = storage.parser.md
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

// serialize any prosemirror doc block by block so blank paragraphs survive --------------------
export function notemarkdownfromdoc(editor, doc) {
  const storage = editor?.storage?.markdown
  const serializer = storage?.serializer
  if (!serializer?.serialize) {
    return storage?.getMarkdown?.() || ''
  }
  const parts = []
  let blockok = true
  doc.forEach((node) => {
    if (!node.isBlock) return
    try {
      const chunk = serializer.serialize(Fragment.from(node)).replace(/\n+$/g, '')
      parts.push(chunk)
    } catch (err) {
      blockok = false
      console.error('block markdown serialize failed', node.type.name, err)
    }
  })
  if (blockok) {
    return parts.join('\n\n')
  }
  try {
    return serializer.serialize(doc.content)
  } catch {
    return ''
  }
}

export function notemarkdownfromeditor(editor) {
  if (!editor?.state?.doc) return ''
  return notemarkdownfromdoc(editor, editor.state.doc)
}

// final markdown that hits disk, same cleanup the editor always applied --------------------
export function notemarkdownforsave(editor, doc) {
  return cleanmarkdown(notemarkdownfromdoc(editor, doc))
}

export { MarkdownSerializerState }
