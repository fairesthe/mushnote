import mermaid from 'mermaid'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, NodeSelection, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

let inited = false
let renderseq = 0
const mermaideditorpluginkey = new PluginKey('mermaideditorpreview')

export function initmermaid() {
  if (inited) return
  const root = document.documentElement
  const dark =
    root.classList.contains('dark') ||
    root.getAttribute('data-theme') === 'dark' ||
    window.matchMedia?.('(prefers-color-scheme: dark)')?.matches
  mermaid.initialize({
    startOnLoad: false,
    theme: dark ? 'dark' : 'neutral',
    securityLevel: 'strict',
    fontFamily: 'inherit',
  })
  inited = true
}

const mermaidstartpattern =
  /^(flowchart\b|graph\b|sequencediagram\b|classdiagram\b|statediagram|erdiagram\b|journey\b|gantt\b|pie\b|gitgraph\b|mindmap\b|timeline\b|zenuml\b|sankey\b|c4context\b|blockdiag\b)/i

export function formatmermaidforpaste(source) {
  const body = String(source || '').replace(/\s+$/, '')
  if (!body.trim()) return ''
  return `\n\`\`\`mermaid\n${body}\n\`\`\`\n`
}

export function detectmermaid(rawtext) {
  if (!rawtext || typeof rawtext !== 'string') return null
  const text = rawtext.trim()
  if (!text) return null

  const fenced = text.match(/^```\s*mermaid\s*\n([\s\S]*?)```\s*$/i)
  if (fenced) {
    const inner = fenced[1].replace(/\s+$/, '')
    if (inner.trim()) {
      return { source: inner }
    }
    return null
  }

  const firstline = text.split('\n')[0].trim()
  if (mermaidstartpattern.test(firstline)) {
    return { source: text }
  }

  return null
}

function hashsource(text) {
  let h = 0
  const s = String(text || '')
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return String(h)
}

function storemermaidsource(target, source) {
  const fig = target?.closest?.('.mermaid-figure')
  if (fig) fig.setAttribute('data-mermaid-source', source)
}

export function createmermaidcopyactions(getsource, label = 'copy mermaid') {
  const actions = document.createElement('div')
  actions.className = 'chat-block-actions mermaid-block-actions'

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'btn-copy-code'
  btn.title = label
  btn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> <span>${label}</span>`

  const defaulthtml = btn.innerHTML
  btn.addEventListener('click', async (e) => {
    e.stopPropagation()
    const raw = typeof getsource === 'function' ? getsource() : String(getsource || '')
    const text = formatmermaidforpaste(raw) || raw
    try {
      await navigator.clipboard.writeText(text)
      btn.innerHTML = `<span class="copy-success-text">copied</span>`
      setTimeout(() => {
        btn.innerHTML = defaulthtml
      }, 1000)
    } catch (err) {
      console.error('failed to copy mermaid', err)
    }
  })

  actions.appendChild(btn)
  return actions
}

export function attachmermaidcopyactions(root) {
  if (!root?.querySelectorAll) return
  root.querySelectorAll('.mermaid-figure.mermaid-block').forEach((fig) => {
    if (fig.dataset.hasCopy === '1') return
    if (!fig.getAttribute('data-mermaid-source')?.trim()) return
    fig.dataset.hasCopy = '1'
    fig.appendChild(
      createmermaidcopyactions(() => fig.getAttribute('data-mermaid-source') || '')
    )
  })
}

async function rendersourceintotarget(target, source) {
  const trimmed = String(source || '').trim()
  if (!trimmed) {
    target.innerHTML = ''
    target.removeAttribute('data-mermaid-hash')
    storemermaidsource(target, '')
    return
  }
  const hash = hashsource(trimmed)
  if (target.getAttribute('data-mermaid-hash') === hash) return
  storemermaidsource(target, trimmed)
  initmermaid()
  const id = `mmd-${++renderseq}-${Math.abs(Number(hash) || 0)}`
  try {
    const { svg } = await mermaid.render(id, trimmed)
    target.innerHTML = svg
    target.classList.remove('mermaid-error')
    target.setAttribute('data-mermaid-hash', hash)
    target.removeAttribute('title')
  } catch (err) {
    target.classList.add('mermaid-error')
    target.setAttribute('data-mermaid-hash', hash)
    target.innerHTML = ''
    target.title = String(err?.message || err || 'mermaid error')
  }
}

export function mermaidmarkdownplugin(md) {
  const defaultfence = md.renderer.rules.fence
  md.renderer.rules.fence = (tokens, idx, options, env, slf) => {
    const token = tokens[idx]
    const info = String(token.info || '').trim().toLowerCase().split(/\s+/)[0]
    if (info === 'mermaid') {
      const code = token.content
      const esc = md.utils.escapeHtml(code)
      return `<figure class="mermaid-figure mermaid-block"><div class="mermaid-diagram-shell"><div class="mermaid-diagram" data-mermaid-pending="1">${esc}</div></div></figure>\n`
    }
    return defaultfence(tokens, idx, options, env, slf)
  }
}

export async function enhancemermaidinroot(root) {
  if (!root?.querySelectorAll) return
  const pending = root.querySelectorAll('.mermaid-diagram[data-mermaid-pending="1"]')
  const jobs = []
  for (const el of pending) {
    const source = el.textContent || ''
    el.removeAttribute('data-mermaid-pending')
    jobs.push(rendersourceintotarget(el, source))
  }
  await Promise.all(jobs)
  attachmermaidcopyactions(root)
}

function ismermaidlang(language) {
  return String(language || '').trim().toLowerCase() === 'mermaid'
}

function ismermaidpreviewdom(node) {
  if (!node) return false
  const el = node.nodeType === 1 ? node : node.parentElement
  if (!el) return false
  return Boolean(
    el.classList?.contains('mermaid-editor-wrap')
    || el.classList?.contains('mermaid-editor-diagram')
    || el.classList?.contains('mermaid-block-actions')
    || el.closest?.('.mermaid-editor-wrap')
  )
}

function escapeforattr(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function createmermaidpreviewdom(source, hash) {
  const wrap = document.createElement('figure')
  wrap.className = 'mermaid-figure mermaid-editor-wrap'
  wrap.contentEditable = 'false'
  wrap.setAttribute('contenteditable', 'false')
  wrap.setAttribute('data-mermaid-preview', '1')
  wrap.setAttribute('data-mermaid-hash', hash)
  wrap.setAttribute('data-mermaid-source', escapeforattr(source))
  wrap.title = 'click to edit mermaid source'

  const shell = document.createElement('div')
  shell.className = 'mermaid-diagram-shell'
  const diagram = document.createElement('div')
  diagram.className = 'mermaid-editor-diagram'
  diagram.contentEditable = 'false'
  diagram.setAttribute('contenteditable', 'false')
  shell.appendChild(diagram)
  wrap.appendChild(shell)
  rendersourceintotarget(diagram, source).catch(() => {})
  return wrap
}

function selectioninsidemermaid(selection, pos, nodesize) {
  const from = selection.from
  const to = selection.to
  return from >= pos && to <= pos + nodesize
}

function selectioncoversmermaid(selection, pos, nodesize) {
  return selection.from <= pos && selection.to >= pos + nodesize
}

function buildmermaiddecorations(state) {
  const out = []
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'codeBlock' || !ismermaidlang(node.attrs.language)) return
    const source = node.textContent
    const hash = hashsource(source)
    const covered = selectioncoversmermaid(state.selection, pos, node.nodeSize)
    // key keeps the same preview dom when the block moves --------------------
    out.push(Decoration.widget(pos, () => {
      const wrap = createmermaidpreviewdom(source, hash)
      if (covered) wrap.classList.add('is-node-selected')
      return wrap
    }, {
      side: -1,
      key: `mmd-${pos}-${hash}-${covered ? 'sel' : 'ok'}`,
      ignoreSelection: true,
      stopEvent: (event) => event.type !== 'mousedown' && event.type !== 'click'
    }))
    if (selectioninsidemermaid(state.selection, pos, node.nodeSize)) {
      out.push(Decoration.node(pos, pos + node.nodeSize, { class: 'mermaid-source-open' }))
    }
  })
  return DecorationSet.create(state.doc, out)
}

function focusmermaidsource(view, event) {
  const wrap = event.target?.closest?.('.mermaid-editor-wrap')
  if (!wrap || !view?.dom?.contains(wrap)) return false
  event.preventDefault()
  event.stopPropagation()
  try {
    const pos = view.posAtDOM(wrap, 0)
    const node = view.state.doc.nodeAt(pos)
    if (!node || node.type.name !== 'codeBlock' || !ismermaidlang(node.attrs.language)) return true
    const sel = node.textContent.length
      ? TextSelection.create(view.state.doc, pos + 1)
      : NodeSelection.create(view.state.doc, pos)
    view.dispatch(view.state.tr.setSelection(sel))
    view.focus()
  } catch {}
  return true
}

export const MermaidExtension = Extension.create({
  name: 'mermaidDiagram',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: mermaideditorpluginkey,
        state: {
          init: (_, state) => buildmermaiddecorations(state),
          apply(tr, old, _oldstate, newstate) {
            if (!tr.docChanged && !tr.selectionSet) return old
            return buildmermaiddecorations(newstate)
          }
        },
        props: {
          decorations(state) {
            return mermaideditorpluginkey.getState(state)
          },
          // preview figure is pure chrome - never scrape it into the note --------------------
          ignoreMutation(mutation) {
            if (!mutation) return false
            if (mutation.type === 'childList') {
              const nodes = [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])]
              if (nodes.some((n) => ismermaidpreviewdom(n))) return true
            }
            const t = mutation.target
            return ismermaidpreviewdom(t) || ismermaidpreviewdom(t?.parentElement)
          },
          transformPastedHTML(html) {
            // preview widgets are chrome - turn stored source back into a code block first --------------------
            return String(html || '')
              .replace(
                /<figure[^>]*data-mermaid-source="([^"]*)"[^>]*>[\s\S]*?<\/figure>/gi,
                (_, encoded) => {
                  let source = encoded
                  try {
                    source = encoded
                      .replace(/&quot;/g, '"')
                      .replace(/&#39;/g, "'")
                      .replace(/&amp;/g, '&')
                      .replace(/&lt;/g, '<')
                      .replace(/&gt;/g, '>')
                  } catch {}
                  const esc = String(source)
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                  return `<pre><code class="language-mermaid">${esc}</code></pre>`
                }
              )
              .replace(/<figure[^>]*mermaid-editor-wrap[\s\S]*?<\/figure>/gi, '')
              .replace(/copy mermaid/gi, '')
          },
          handleDOMEvents: {
            mousedown(view, event) {
              if (ismermaidpreviewdom(event.target)) {
                return focusmermaidsource(view, event)
              }
              return false
            },
          },
        },
      }),
    ]
  },
})
