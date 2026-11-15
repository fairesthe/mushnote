const ignoreinputtypes = new Set(['checkbox', 'radio', 'range', 'color', 'file', 'hidden', 'button', 'submit'])

function shouldnospell(el) {
  if (!el || el.nodeType !== 1) return false
  const tag = el.tagName
  if (tag === 'TEXTAREA') return true
  if (tag === 'INPUT') {
    const type = (el.getAttribute('type') || 'text').toLowerCase()
    return !ignoreinputtypes.has(type)
  }
  const ce = el.getAttribute('contenteditable')
  if (ce === '' || ce === 'true') return true
  if (el.classList?.contains('ProseMirror')) return true
  if (el.classList?.contains('cm-content')) return true
  return false
}

export function marknospellcheck(el) {
  if (!shouldnospell(el)) return
  el.spellcheck = false
  el.setAttribute('spellcheck', 'false')
  el.setAttribute('autocorrect', 'off')
  el.setAttribute('autocapitalize', 'off')
  el.setAttribute('data-gramm', 'false')
  el.setAttribute('data-gramm_editor', 'false')
  el.setAttribute('data-enable-grammarly', 'false')
}

function scanroot(root) {
  if (!root || root.nodeType !== 1) return
  if (shouldnospell(root)) marknospellcheck(root)
  root.querySelectorAll?.('input, textarea, [contenteditable], .ProseMirror, .cm-content')?.forEach((el) => {
    marknospellcheck(el)
  })
}

export function initspellcheckdisabled() {
  scanroot(document.documentElement)
  const obs = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        scanroot(node)
      }
    }
  })
  if (document.body) {
    obs.observe(document.body, { childList: true, subtree: true })
  }
}