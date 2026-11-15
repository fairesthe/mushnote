import { Editor, Extension, InputRule } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from 'tiptap-markdown'
import Placeholder from '@tiptap/extension-placeholder'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { Plugin, PluginKey, NodeSelection, TextSelection } from '@tiptap/pm/state'
import { dropPoint, StepMap, Mapping } from '@tiptap/pm/transform'
import { Slice, Fragment } from '@tiptap/pm/model'
import markdownit from 'markdown-it'
import taskLists from 'markdown-it-task-lists'
import katex from 'katex'
import {
  mermaidmarkdownplugin,
  enhancemermaidinroot,
  MermaidExtension,
  detectmermaid,
  formatmermaidforpaste,
} from './mermaid-support.js'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import {
  mark_plugin,
  Highlight,
  InlineMath,
  BlockMath,
  NoteHardBreak,
  CustomBulletList,
  NoteLink,
  ResizableImage,
  katexmarkdownplugin,
  notecontentextensions,
  patchnotemarkdown,
  patchnotemarkdownserializer,
  patchnotemarkdownparser,
  notemarkdownfromeditor,
  notemarkdownfromdoc,
  cleanmarkdown,
  expandmarkdownblanklines,
  preparemarkdownforload,
  MarkdownSerializerState
} from '../../../backend/sync/noteschema.js'

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
import { Prec as CMPrec } from '@codemirror/state'
import { yCollab, ySyncAnnotation, yUndoManagerKeymap } from 'y-codemirror.next'

const youtubemetacache = new Map()
const YT_FAVICON = 'https://www.youtube.com/favicon.ico'
const NOTE_CITE_ICON = '/resources/icons/files/text.png'

function shortencitelabel(text, max = 34) {
  const raw = String(text || '').trim()
  if (!raw) return ''
  if (raw.length <= max) return raw
  return `${raw.slice(0, max - 1)}…`
}

function hostfromurl(raw) {
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
    return u.hostname.replace(/^www\./i, '')
  } catch {
    return ''
  }
}

function faviconurlforhost(host) {
  if (!host) return ''
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`
}

function parseyoutubetarget(target) {
  const clean = String(target || '').trim()
  const pipe = clean.indexOf('|')
  if (pipe !== -1) {
    return {
      id: clean.slice(0, pipe).trim(),
      creator: clean.slice(pipe + 1).trim(),
    }
  }
  return { id: clean, creator: '' }
}

function youtubeidfromtarget(target) {
  const { id: raw } = parseyoutubetarget(target)
  let id = raw
  const vparam = raw.match(/[?&]v=([\w-]{6,})/i)
  if (vparam) id = vparam[1]
  else if (/youtu\.be\//i.test(raw)) {
    const short = raw.match(/youtu\.be\/([\w-]+)/i)
    if (short) id = short[1]
  }
  return id
}

function citemarklabel(kind, target) {
  const clean = String(target || '').trim()
  if (!clean) return kind
  if (kind === 'web') {
    return hostfromurl(clean) || 'web'
  }
  if (kind === 'note') {
    const parts = clean.replace(/\\/g, '/').split('/')
    return shortencitelabel(parts[parts.length - 1] || clean, 28)
  }
  if (kind === 'youtube') {
    const { creator } = parseyoutubetarget(clean)
    if (creator) return shortencitelabel(creator, 28)
    return 'youtube'
  }
  return shortencitelabel(clean, 24)
}

function citehref(kind, target) {
  const clean = String(target || '').trim()
  if (kind === 'web') {
    return /^https?:\/\//i.test(clean) ? clean : `https://${clean}`
  }
  if (kind === 'note') {
    return clean.replace(/\\/g, '/')
  }
  if (kind === 'youtube') {
    if (/^https?:\/\//i.test(clean)) return clean
    const id = youtubeidfromtarget(clean)
    return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`
  }
  return '#'
}

// inline [web:url] [note:path] [youtube:id] cite badges in chat --------------------
function cite_plugin(md) {
  const citepattern = /^\[(web|note|youtube|google|ai_overview):([^\]]*)\]/i

  function parserule(state, silent) {
    const src = state.src.slice(state.pos)
    const match = src.match(citepattern)
    if (!match) return false
    if (silent) return true

    let kind = match[1].toLowerCase()
    let target = match[2].trim()
    if (kind === 'google' || kind === 'ai_overview') {
      kind = 'web'
      target = 'google.com'
    }
    const token = state.push('chat_cite', '', 0)
    token.meta = { kind, target }
    state.pos += match[0].length
    return true
  }

  md.inline.ruler.before('link', 'chat_cite', parserule)

  md.renderer.rules.chat_cite = (tokens, idx) => {
    const { kind, target } = tokens[idx].meta || {}
    const esc = md.utils.escapeHtml
    const label = esc(citemarklabel(kind, target))
    const href = esc(citehref(kind, target))
    const classes = `ai-cite-badge ai-cite-${esc(kind)}`
    let icon = ''
    if (kind === 'web') {
      const host = hostfromurl(target)
      const iconurl = esc(faviconurlforhost(host))
      icon = `<img class="ai-cite-favicon" src="${iconurl}" width="18" height="18" alt="" loading="lazy" decoding="async">`
    } else if (kind === 'youtube') {
      const vid = esc(youtubeidfromtarget(target))
      icon = `<img class="ai-cite-favicon" src="${YT_FAVICON}" width="18" height="18" alt="" loading="lazy" decoding="async">`
      const dataid = vid ? ` data-youtube-id="${vid}"` : ''
      const titletip = esc(href)
      return `<a href="${href}" class="${classes} external-link"${dataid} target="_blank" rel="noopener noreferrer" title="${titletip}"><span class="ai-cite-icon-wrap">${icon}</span><span class="ai-cite-label">${label}</span></a>`
    } else if (kind === 'note') {
      icon = `<img class="ai-cite-favicon" src="${NOTE_CITE_ICON}" width="18" height="18" alt="" loading="lazy" decoding="async">`
    }
    if (kind === 'note') {
      const title = esc(href)
      return `<a href="${href}" class="${classes} note-link" data-note-link="${href}" title="open ${title}"><span class="ai-cite-icon-wrap">${icon}</span><span class="ai-cite-label">${label}</span></a>`
    }
    const title = esc(href)
    return `<a href="${href}" class="${classes} external-link" target="_blank" rel="noopener noreferrer" title="${title}"><span class="ai-cite-icon-wrap">${icon}</span><span class="ai-cite-label">${label}</span></a>`
  }
}

export async function enhancechatcites(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return
  const badges = root.querySelectorAll('a.ai-cite-youtube[data-youtube-id]')
  const jobs = []
  for (const el of badges) {
    const id = el.getAttribute('data-youtube-id')
    if (!id) continue
    const label = el.querySelector('.ai-cite-label')
    if (!label) continue
    if (label.dataset.enhanced === '1') continue
    const current = label.textContent || ''
    if (current && current !== 'youtube') {
      label.dataset.enhanced = '1'
      continue
    }
    jobs.push((async () => {
      let meta = youtubemetacache.get(id)
      if (!meta) {
        meta = { creator: '', title: '' }
        try {
          const watch = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`
          const res = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(watch)}`)
          if (res.ok) {
            const data = await res.json()
            meta.creator = String(data.author_name || '').trim()
            meta.title = String(data.title || '').trim()
          }
        } catch {
          // noembed optional
        }
        if (meta.creator || meta.title) youtubemetacache.set(id, meta)
      }
      if (label.isConnected) {
        const creatorlabel = meta.creator ? shortencitelabel(meta.creator, 28) : 'youtube'
        if (current === 'youtube' || !current) label.textContent = creatorlabel
        if (meta.title) el.title = meta.title
        else if (meta.creator) el.title = meta.creator
      }
      label.dataset.enhanced = '1'
    })())
  }
  await Promise.all(jobs)
}

// configured markdown and latex renderer for chat messages --------------------
const chatkatexplugin = katexmarkdownplugin
const chatmd = markdownit({
  html: false,
  linkify: true,
  breaks: true,
  typographer: true
})
  .use(chatkatexplugin, { throwOnError: false })
  .use(mermaidmarkdownplugin)
  .use(taskLists)
  .use(mark_plugin)
  .use(cite_plugin)

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

export async function enhancemermaid(root) {
  return enhancemermaidinroot(root)
}

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

// markdown task list typing: `- [ ] ` and `- [x] ` --------------------
function settaskitemchecked(tr, state, checked) {
  const { $from } = state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name === 'taskItem') {
      const pos = $from.before(depth)
      tr.setNodeMarkup(pos, undefined, {
        ...$from.node(depth).attrs,
        checked
      })
      return true
    }
  }
  return false
}

// second enter on a trailing empty line after text becomes a hard break --------------------
function shouldcollapseemptytobreak(state) {
  const { $from, empty } = state.selection
  if (!empty) return null
  const para = $from.parent
  if (para.type.name !== 'paragraph' || para.content.size > 0) return null
  const depth = $from.depth
  if (depth < 1) return null
  const blockindex = $from.index(depth - 1)
  if (blockindex === 0) return null
  const docblock = $from.node(depth - 1)
  const prev = docblock.child(blockindex - 1)
  if (prev.type.name !== 'paragraph' || prev.content.size === 0) return null
  for (let i = blockindex + 1; i < docblock.childCount; i++) {
    const sibling = docblock.child(i)
    if (sibling.content.size > 0) return null
    if (sibling.type.name !== 'paragraph') return null
  }
  return { $from, para, depth }
}

const NoteDoubleEnterBreak = Extension.create({
  name: 'noteDoubleEnterBreak',
  priority: 1001,
  addCommands() {
    return {
      collapseEmptyLineToBreak: () => ({ state, dispatch }) => {
        const info = shouldcollapseemptytobreak(state)
        if (!info) return false
        const { $from, para, depth } = info
        const emptyfrom = $from.before(depth)
        const emptyto = emptyfrom + para.nodeSize
        const breakpos = emptyfrom - 1
        if (!dispatch) return true
        const tr = state.tr
        tr.insert(breakpos, state.schema.nodes.hardBreak.create())
        tr.delete(emptyfrom + 1, emptyto + 1)
        tr.setSelection(TextSelection.create(tr.doc, breakpos + 1))
        dispatch(tr)
        return true
      }
    }
  },
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        if (editor.isActive('codeBlock') || editor.isActive('heading')) return false
        if (editor.isActive('taskItem') || editor.isActive('listItem')) return false
        if (!shouldcollapseemptytobreak(editor.state)) return false
        return editor.commands.collapseEmptyLineToBreak()
      }
    }
  }
})

const TaskListMarkdownInput = Extension.create({
  name: 'taskListMarkdownInput',
  priority: 200,
  addInputRules() {
  return [
      new InputRule({
        find: /^\s*([-+*])\s+\[([ |xX])\]\s$/,
        handler: ({ chain, range, match }) => {
          const checked = match[2].toLowerCase() === 'x'
          return chain()
            .deleteRange(range)
            .toggleTaskList()
            .command(({ tr, state }) => settaskitemchecked(tr, state, checked))
            .run()
        }
      }),
      new InputRule({
        find: /^\[([ |xX])\]\s$/,
        handler: ({ editor, chain, range, match }) => {
          if (!editor.isActive('listItem') || editor.isActive('taskItem')) return null
          const checked = match[1].toLowerCase() === 'x'
          return chain()
            .deleteRange(range)
            .command(({ tr, state }) => {
              const { $from } = state.selection
              let listItemDepth = -1
              let bulletDepth = -1
              for (let depth = $from.depth; depth > 0; depth--) {
                const name = $from.node(depth).type.name
                if (name === 'listItem' && listItemDepth < 0) listItemDepth = depth
                if (name === 'bulletList' && bulletDepth < 0) bulletDepth = depth
              }
              if (listItemDepth < 0 || bulletDepth < 0) return false
              const bulletPos = $from.before(bulletDepth)
              const listItemPos = $from.before(listItemDepth)
              tr.setNodeMarkup(bulletPos, state.schema.nodes.taskList)
              tr.setNodeMarkup(listItemPos, state.schema.nodes.taskItem, { checked })
              return true
            })
            .run()
        }
      })
    ]
  }
})

export {
  Editor,
  Extension,
  StarterKit,
  Markdown,
  Placeholder,
  NoteHardBreak,
  CustomBulletList,
  NoteDoubleEnterBreak,
  TaskListMarkdownInput,
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
  detectmermaid,
  formatmermaidforpaste,
  Link,
  NoteLink,
  Image,
  ResizableImage,
  MermaidExtension,
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
  cmOneDark,
  CMPrec,
  StepMap,
  Mapping,
  Highlight,
  mark_plugin,
  notecontentextensions,
  patchnotemarkdown,
  patchnotemarkdownserializer,
  patchnotemarkdownparser,
  notemarkdownfromeditor,
  notemarkdownfromdoc,
  cleanmarkdown,
  expandmarkdownblanklines,
  preparemarkdownforload,
  yCollab,
  ySyncAnnotation,
  yUndoManagerKeymap
}

export { notecollabprovider, Y } from './collab-provider.js'
export { ySyncPlugin, ySyncPluginKey, yUndoPlugin, yUndoPluginKey, undo as yundo, redo as yredo } from 'y-prosemirror'
