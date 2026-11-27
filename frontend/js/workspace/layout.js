import { state } from '../core/state.js'
import { captureeditorselectionforai } from '../editor/editor.js'
import { ismobilemode, setmobilepanel, getmobilepanel } from '../core/mobile.js'

// dom elements for layout --------------------
const sidebarpane = document.getElementById('sidebar-pane')
const aidrawer = document.getElementById('ai-drawer')
const resizerleft = document.getElementById('resizer-left')
const resizerright = document.getElementById('resizer-right')
const tabtogglefiles = document.getElementById('tab-toggle-files')
const tabtoggleai = document.getElementById('tab-toggle-ai')
const btncloseai = document.getElementById('btn-close-ai')
const aiinput = document.getElementById('ai-input')

function aiwidthstoragekey() {
  const userid = state.currentuser?.id || 'anon'
  return `mushnote_ai_width_${userid}`
}

function restoreaiwidth() {
  if (!aidrawer) return
  const saved = Number(localStorage.getItem(aiwidthstoragekey()))
  if (!saved || saved < 220 || saved > 720) return
  aidrawer.style.width = `${saved}px`
  aidrawer.style.minWidth = `${saved}px`
  document.documentElement.style.setProperty('--ai-drawer-width', `${saved}px`)
}

function aidrawerstoragekey() {
  const userid = state.currentuser?.id || 'anon'
  return `mushnote_ai_open_${userid}`
}

function sidebarstoragekey() {
  const userid = state.currentuser?.id || 'anon'
  return `mushnote_sidebar_open_${userid}`
}

function saveaidraweropen() {
  if (!aidrawer) return
  const open = !aidrawer.classList.contains('is-collapsed')
  localStorage.setItem(aidrawerstoragekey(), open ? '1' : '0')
  window.postMessage({ type: 'MUSHNOTE_AI_STATE', open }, '*')
}

function savesidebaropen() {
  if (!sidebarpane) return
  const open = !sidebarpane.classList.contains('is-collapsed')
  localStorage.setItem(sidebarstoragekey(), open ? '1' : '0')
}

function restoreaidraweropen() {
  if (!aidrawer) return
  const saved = localStorage.getItem(aidrawerstoragekey())
  if (saved === null) return
  aidrawer.classList.toggle('is-collapsed', saved !== '1')
}

function restoresidebaropen() {
  if (!sidebarpane) return
  const saved = localStorage.getItem(sidebarstoragekey())
  if (saved === null) return
  sidebarpane.classList.toggle('is-collapsed', saved !== '1')
}

function syncaiinputsize() {
  // dynamic import avoids a circular dependency with assistant.js --------------------
  requestAnimationFrame(() => {
    import('../chat/assistant.js').then((m) => m.resizeaiinput?.()).catch(() => {})
  })
}

// update toggle buttons state arrows and positions --------------------
// open ai drawer and focus chat input --------------------
export function ensureaidraweropen() {
  if (!aidrawer) return
  if (ismobilemode()) {
    setmobilepanel('ai')
    captureeditorselectionforai()
    syncaiinputsize()
    if (aiinput) aiinput.focus()
    return
  }
  if (aidrawer.classList.contains('is-collapsed')) {
    aidrawer.classList.remove('is-collapsed')
    updatetogglebuttons()
    saveaidraweropen()
  }
  captureeditorselectionforai()
  syncaiinputsize()
  if (aiinput) {
    aiinput.focus()
  }
}

export function updatetogglebuttons() {
  if (tabtogglefiles && sidebarpane) {
    const filesopen = !sidebarpane.classList.contains('is-collapsed')
    tabtogglefiles.classList.toggle('panel-open', filesopen)
    tabtogglefiles.classList.toggle('panel-closed', !filesopen)
    tabtogglefiles.title = filesopen ? 'collapse files' : 'open files'
    tabtogglefiles.innerHTML = filesopen
      ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>'
      : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>'
  }

  if (tabtoggleai && aidrawer) {
    const aiopen = !aidrawer.classList.contains('is-collapsed')
    tabtoggleai.classList.toggle('panel-open', aiopen)
    tabtoggleai.classList.toggle('panel-closed', !aiopen)
    tabtoggleai.title = aiopen ? 'collapse ai assistant' : 'open ai assistant'
    if (aiopen) {
      tabtoggleai.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>'
    } else {
      const name = state.ainame || 'assistant'
      const avatar = state.aiavatar
      const avatarmarkup = avatar
        ? `<img class="tab-toggle-ai-avatar" src="${avatar}" alt="${name}">`
        : ''
      tabtoggleai.innerHTML = `${avatarmarkup}<span class="tab-toggle-ai-name">${name}</span>`
    }
  }
}

function initmobilenav() {
  const nav = document.getElementById('mobile-bottom-nav')
  if (!nav) return
  nav.querySelectorAll('.mobile-nav-btn').forEach((btn) => {
    const handlepanelclick = (e) => {
      const panel = btn.dataset.panel
      if (!panel) return
      setmobilepanel(panel)
      // focus synchronously during the user touch gesture so ios safari displays the keyboard --------------------
      if (panel === 'ai') {
        const aiinput = document.getElementById('ai-input')
        if (aiinput) {
          try {
            aiinput.focus()
          } catch {}
        }
        captureeditorselectionforai()
      }
      updatetogglebuttons()
    }
    btn.addEventListener('touchstart', (e) => {
      if (btn.dataset.panel === 'ai') {
        const aiinput = document.getElementById('ai-input')
        if (aiinput) {
          try {
            aiinput.focus()
          } catch {}
        }
      }
    }, { passive: true })
    btn.addEventListener('touchend', (e) => {
      e.preventDefault()
      handlepanelclick(e)
    })
    btn.addEventListener('click', handlepanelclick)
  })
  // default: ai assistant on mobile --------------------
  setmobilepanel(getmobilepanel() || 'ai')
  updatetogglebuttons()
}

// initialize layout toggles and resizers --------------------
export function initlayout() {
  if (ismobilemode()) {
    initmobilenav()
    return
  }

  restoresidebaropen()
  restoreaidraweropen()
  restoreaiwidth()
  if (document.body.classList.contains('ai-panel-only') && aidrawer) {
    aidrawer.classList.remove('is-collapsed')
    if (aiinput) setTimeout(() => aiinput.focus(), 50)
  }
  updatetogglebuttons()

  // sync ai drawer open/width from extension across all tabs --------------------
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.type !== 'MUSHNOTE_AI_STATE_SYNC' || !aidrawer) return
    if (!document.body.classList.contains('ai-panel-only') && typeof e.data.open === 'boolean') {
      aidrawer.classList.toggle('is-collapsed', !e.data.open)
      localStorage.setItem(aidrawerstoragekey(), e.data.open ? '1' : '0')
      updatetogglebuttons()
    }
    if (typeof e.data.width === 'number' && e.data.width >= 220 && e.data.width <= 720) {
      localStorage.setItem(aiwidthstoragekey(), String(e.data.width))
      if (!document.body.classList.contains('ai-panel-only')) {
        aidrawer.style.width = `${e.data.width}px`
        aidrawer.style.minWidth = `${e.data.width}px`
        document.documentElement.style.setProperty('--ai-drawer-width', `${e.data.width}px`)
      }
    }
  })

  // sync sidebar and ai drawer state across open tabs --------------------
  window.addEventListener('storage', (e) => {
    if (e.key === sidebarstoragekey() && sidebarpane) {
      sidebarpane.classList.toggle('is-collapsed', e.newValue !== '1')
      updatetogglebuttons()
    } else if (e.key === aidrawerstoragekey() && aidrawer) {
      aidrawer.classList.toggle('is-collapsed', e.newValue !== '1')
      updatetogglebuttons()
      if (!aidrawer.classList.contains('is-collapsed')) {
        syncaiinputsize()
      }
    }
  })

  if (tabtogglefiles && sidebarpane) {
    tabtogglefiles.addEventListener('click', () => {
      sidebarpane.classList.toggle('is-collapsed')
      updatetogglebuttons()
      savesidebaropen()
    })
  }

  if (tabtoggleai && aidrawer) {
    tabtoggleai.addEventListener('click', () => {
      aidrawer.classList.toggle('is-collapsed')
      updatetogglebuttons()
      saveaidraweropen()
      if (!aidrawer.classList.contains('is-collapsed')) {
        captureeditorselectionforai()
        syncaiinputsize()
        if (aiinput) aiinput.focus()
      }
    })
  }
  if (aidrawer && !aidrawer.classList.contains('is-collapsed')) {
    syncaiinputsize()
  }

  if (btncloseai && aidrawer) {
    btncloseai.addEventListener('click', () => {
      aidrawer.classList.add('is-collapsed')
      updatetogglebuttons()
      saveaidraweropen()
    })
  }

  // column resizing logic for sidebar and ai drawer --------------------
  let isresizingleft = false
  let isresizingright = false

  function stopresizing() {
    if (isresizingleft || isresizingright) {
      const wasright = isresizingright
      isresizingleft = false
      isresizingright = false
      if (resizerleft) resizerleft.classList.remove('is-dragging')
      if (resizerright) resizerright.classList.remove('is-dragging')
      document.body.classList.remove('is-resizing')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      if (wasright && aidrawer) {
        const w = parseInt(aidrawer.style.width, 10)
        if (w >= 220 && w <= 720) {
          localStorage.setItem(aiwidthstoragekey(), String(w))
          window.postMessage({ type: 'MUSHNOTE_AI_WIDTH', width: w }, '*')
        }
      }
    }
  }

  if (resizerleft) {
    resizerleft.addEventListener('mousedown', (e) => {
      if (sidebarpane && sidebarpane.classList.contains('is-collapsed')) return
      e.preventDefault()
      isresizingleft = true
      resizerleft.classList.add('is-dragging')
      document.body.classList.add('is-resizing')
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    })
  }

  if (resizerright) {
    resizerright.addEventListener('mousedown', (e) => {
      if (aidrawer && aidrawer.classList.contains('is-collapsed')) return
      e.preventDefault()
      isresizingright = true
      resizerright.classList.add('is-dragging')
      document.body.classList.add('is-resizing')
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    })
  }

  window.addEventListener('mousemove', (e) => {
    if (!isresizingleft && !isresizingright) return
    if (isresizingleft && sidebarpane) {
      const newwidth = Math.max(160, Math.min(e.clientX, 600))
      sidebarpane.style.width = `${newwidth}px`
      sidebarpane.style.minWidth = `${newwidth}px`
      document.documentElement.style.setProperty('--sidebar-width', `${newwidth}px`)
    }
    if (isresizingright && aidrawer) {
      const newwidth = Math.max(220, Math.min(window.innerWidth - e.clientX, 700))
      aidrawer.style.width = `${newwidth}px`
      aidrawer.style.minWidth = `${newwidth}px`
      document.documentElement.style.setProperty('--ai-drawer-width', `${newwidth}px`)
    }
  })

  window.addEventListener('mouseup', stopresizing)
  window.addEventListener('blur', stopresizing)
}

