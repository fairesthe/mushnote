import mermaid from 'mermaid'
import { Extension } from '@tiptap/core'

let inited = false
let renderseq = 0

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
  const id = `mmd-${++renderseq}-${Math.abs(hash)}`
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

let editorrefreshtimer = null

export async function refreshmermaidineditor(root) {
  if (!root?.querySelectorAll) return
  const codes = root.querySelectorAll('pre > code.language-mermaid')
  const jobs = []
  for (const code of codes) {
    const pre = code.closest('pre')
    if (!pre?.parentNode) continue
    const source = code.textContent || ''
    let wrap = pre.previousElementSibling
    if (!wrap?.classList?.contains('mermaid-editor-wrap')) {
      wrap = document.createElement('figure')
      wrap.className = 'mermaid-figure mermaid-editor-wrap'
      const shell = document.createElement('div')
      shell.className = 'mermaid-diagram-shell'
      const diagram = document.createElement('div')
      diagram.className = 'mermaid-editor-diagram'
      diagram.setAttribute('contenteditable', 'false')
      shell.appendChild(diagram)
      wrap.appendChild(shell)
      wrap.appendChild(createmermaidcopyactions(() => code.textContent || ''))
      pre.parentNode.insertBefore(wrap, pre)
    }
    const diagram = wrap.querySelector('.mermaid-editor-diagram')
    if (diagram) jobs.push(rendersourceintotarget(diagram, source))
  }
  const orphans = []
  root.querySelectorAll('.mermaid-editor-wrap').forEach((wrap) => {
    const code = wrap.nextElementSibling?.querySelector?.('code.language-mermaid')
    if (!code) orphans.push(wrap)
  })
  orphans.forEach((el) => el.remove())
  await Promise.all(jobs)
}

export const MermaidExtension = Extension.create({
  name: 'mermaidDiagram',
  onCreate() {
    schedulemermaideditorrefresh(this.editor.view.dom)
  },
  onUpdate() {
    schedulemermaideditorrefresh(this.editor.view.dom)
  },
})

function schedulemermaideditorrefresh(dom) {
  if (!dom) return
  if (editorrefreshtimer) clearTimeout(editorrefreshtimer)
  editorrefreshtimer = setTimeout(() => {
    editorrefreshtimer = null
    refreshmermaidineditor(dom).catch(() => {})
  }, 160)
}