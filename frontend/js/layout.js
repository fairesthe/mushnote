import { state } from './state.js'

// dom elements for layout --------------------
const sidebarpane = document.getElementById('sidebar-pane')
const aidrawer = document.getElementById('ai-drawer')
const resizerleft = document.getElementById('resizer-left')
const resizerright = document.getElementById('resizer-right')
const tabtogglefiles = document.getElementById('tab-toggle-files')
const tabtoggleai = document.getElementById('tab-toggle-ai')
const btncloseai = document.getElementById('btn-close-ai')
const aiinput = document.getElementById('ai-input')

// update toggle buttons state arrows and positions --------------------
// open ai drawer and focus chat input --------------------
export function ensureaidraweropen() {
  if (!aidrawer) return
  if (aidrawer.classList.contains('is-collapsed')) {
    aidrawer.classList.remove('is-collapsed')
    updatetogglebuttons()
  }
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

// initialize layout toggles and resizers --------------------
export function initlayout() {
  updatetogglebuttons()

  if (tabtogglefiles && sidebarpane) {
    tabtogglefiles.addEventListener('click', () => {
      sidebarpane.classList.toggle('is-collapsed')
      updatetogglebuttons()
    })
  }

  if (tabtoggleai && aidrawer) {
    tabtoggleai.addEventListener('click', () => {
      aidrawer.classList.toggle('is-collapsed')
      updatetogglebuttons()
      if (!aidrawer.classList.contains('is-collapsed') && aiinput) {
        aiinput.focus()
      }
    })
  }

  if (btncloseai && aidrawer) {
    btncloseai.addEventListener('click', () => {
      aidrawer.classList.add('is-collapsed')
      updatetogglebuttons()
    })
  }

  // column resizing logic for sidebar and ai drawer --------------------
  let isresizingleft = false
  let isresizingright = false

  function stopresizing() {
    if (isresizingleft || isresizingright) {
      isresizingleft = false
      isresizingright = false
      if (resizerleft) resizerleft.classList.remove('is-dragging')
      if (resizerright) resizerright.classList.remove('is-dragging')
      document.body.classList.remove('is-resizing')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
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
    }
  })

  window.addEventListener('mouseup', stopresizing)
  window.addEventListener('blur', stopresizing)
}

