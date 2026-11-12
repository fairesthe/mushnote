import { Editor, Extension, Mark, mergeAttributes, markInputRule, InputRule, ResizableNodeView, getRenderedAttributes } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from 'tiptap-markdown'
import Placeholder from '@tiptap/extension-placeholder'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { Plugin, PluginKey, NodeSelection } from '@tiptap/pm/state'
import { dropPoint } from '@tiptap/pm/transform'
import { Slice, Fragment } from '@tiptap/pm/model'
import { MarkdownSerializerState } from 'prosemirror-markdown'
import markdownit from 'markdown-it'
import katexPlugin from '@vscode/markdown-it-katex'
import taskLists from 'markdown-it-task-lists'
import katex from 'katex'
import { InlineMath as BaseInlineMath, BlockMath as BaseBlockMath } from '@tiptap/extension-mathematics'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'

// codemirror 6 imports for code files --------------------
import {
  EditorView as CMEditorView,
  lineNumbers as cmLineNumbers,
  highlightActiveLineGutter as cmHighlightActiveLineGutter,
  highlightActiveLine as cmHighlightActiveLine,
  keymap as cmKeymap,
  Decoration as CMDecoration,
  WidgetType as CMWidgetType
} from '@codemirror/view'
import {
  EditorState as CMEditorState,
  StateField as CMStateField,
  StateEffect as CMStateEffect,
  Compartment as CMCompartment
} from '@codemirror/state'
import {
  defaultKeymap as cmDefaultKeymap,
  history as cmHistory,
  historyKeymap as cmHistoryKeymap,
  indentWithTab as cmIndentWithTab,
  undo as cmUndo,
  redo as cmRedo
} from '@codemirror/commands'
import {
  bracketMatching as cmBracketMatching,
  foldGutter as cmFoldGutter,
  foldKeymap as cmFoldKeymap,
  indentOnInput as cmIndentOnInput,
  syntaxHighlighting as cmSyntaxHighlighting,
  defaultHighlightStyle as cmDefaultHighlightStyle
} from '@codemirror/language'
import { closeBrackets as cmCloseBrackets } from '@codemirror/autocomplete'
import { javascript as cmJavascript } from '@codemirror/lang-javascript'
import { html as cmHtml } from '@codemirror/lang-html'
import { css as cmCss } from '@codemirror/lang-css'
import { json as cmJson } from '@codemirror/lang-json'
import { python as cmPython } from '@codemirror/lang-python'
import { yaml as cmYaml } from '@codemirror/lang-yaml'
import { oneDark as cmOneDark } from '@codemirror/theme-one-dark'

// markdown it inline rule for ==highlight== syntax --------------------
export function mark_plugin(md) {
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

// configured markdown and latex renderer for chat messages --------------------
const chatkatexplugin = katexPlugin.default || katexPlugin
const chatmd = markdownit({
  html: false,
  linkify: true,
  breaks: true,
  typographer: true
})
  .use(chatkatexplugin, { throwOnError: false })
  .use(taskLists)
  .use(mark_plugin)

// disable fuzzy linking so filenames like todo.md or index.js are never turned into links --------------------
chatmd.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false })

const defaultlinkrender = chatmd.renderer.rules.link_open || function(tokens, idx, options, env, self) {
  return self.renderToken(tokens, idx, options)
}
chatmd.renderer.rules.link_open = function(tokens, idx, options, env, self) {
  const href = tokens[idx].attrGet('href') || ''
  const isexternal = /^(https?:|\/\/|mailto:|tel:)/i.test(href)

  if (isexternal) {
    tokens[idx].attrSet('target', '_blank')
    tokens[idx].attrSet('rel', 'noopener noreferrer')
    tokens[idx].attrJoin('class', 'external-link')
  } else {
    // internal note link --------------------
    tokens[idx].attrSet('data-note-link', href)
    tokens[idx].attrJoin('class', 'note-link')
    tokens[idx].attrSet('title', 'click to open (right click for new tab)')
  }

  return defaultlinkrender(tokens, idx, options, env, self)
}

export function renderchatmarkdown(text) {
  if (!text) return ''
  // normalize bracket math to dollar signs before passing to markdown it --------------------
  const normalized = text
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, math) => `$$${math}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, math) => `$${math}$`)
  return chatmd.render(normalized)
}

// inline latex math node for note editor --------------------
const InlineMath = BaseInlineMath.extend({
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
            md.use(chatkatexplugin)
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
const BlockMath = BaseBlockMath.extend({
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

// detect if clipboard or pasted text is a latex formula --------------------
function isvalidkatex(expr) {
  try {
    katex.renderToString(expr, { throwOnError: true })
    return true
  } catch {
    return false
  }
}

function detectlatex(rawtext) {
  if (!rawtext || typeof rawtext !== 'string') return null
  const text = rawtext.trim()
  if (!text) return null

  // check explicit wrappers first --------------------
  if (text.startsWith('$$') && text.endsWith('$$') && text.length > 4) {
    const inner = text.slice(2, -2).trim()
    if (inner && isvalidkatex(inner)) {
      return { latex: inner, isblock: true }
    }
  }

  if (text.startsWith('\\[') && text.endsWith('\\]') && text.length > 4) {
    const inner = text.slice(2, -2).trim()
    if (inner && isvalidkatex(inner)) {
      return { latex: inner, isblock: true }
    }
  }

  if (text.startsWith('$') && text.endsWith('$') && text.length > 2 && !text.slice(1, -1).includes('$')) {
    const inner = text.slice(1, -1).trim()
    if (inner && isvalidkatex(inner)) {
      return { latex: inner, isblock: false }
    }
  }

  if (text.startsWith('\\(') && text.endsWith('\\)') && text.length > 4) {
    const inner = text.slice(2, -2).trim()
    if (inner && isvalidkatex(inner)) {
      return { latex: inner, isblock: false }
    }
  }

  // check for latex environments --------------------
  if (/^\\begin\{[a-zA-Z*]+\}[\s\S]+\\end\{[a-zA-Z*]+\}$/.test(text)) {
    if (isvalidkatex(text)) {
      return { latex: text, isblock: true }
    }
  }

  // check for raw latex backslash commands or math operators --------------------
  const hascommand = /\\[a-zA-Z]+/.test(text)
  const hassuborsup = /[_^][0-9a-zA-Z{]/.test(text)
  const hasmathsymbols = /[=<>+*/-]/.test(text) && (hascommand || hassuborsup || /[a-zA-Z]\s*[=<>]\s*[0-9a-zA-Z]/.test(text))

  if (!hascommand && !hassuborsup && !hasmathsymbols) {
    return null
  }

  // exclude urls or windows paths --------------------
  if (/^(https?:\/\/|www\.)/i.test(text)) return null
  if (/^[a-zA-Z]:[\\/]/.test(text)) return null

  // if no commands and no sub or superscripts require strict formula structure --------------------
  if (!hascommand && !hassuborsup) {
    if (!/^[a-zA-Z0-9\s()=<>+*/.,-]+$/.test(text) || !/[=<>]/.test(text)) {
      return null
    }
    const words = text.split(/\s+/).filter(w => /^[a-zA-Z]{3,}$/.test(w))
    if (words.length > 2) return null
  }

  if (!isvalidkatex(text)) {
    return null
  }

  const isblock = text.includes('\n') || text.includes('\\\\') || text.length > 60 || text.startsWith('\\begin')
  return { latex: text, isblock }
}

// link extension with note linking and custom attributes --------------------
const NoteLink = Link.extend({
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
const ResizableImage = Image.extend({
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

export {
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
  katex,
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
}
