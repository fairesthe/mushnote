import { api, applytheme, resolveaccent } from './api.js'
import { state } from './state.js'
import { applymobileboot, ismobilemode } from './mobile.js'
import { isextensionconnected } from './extension.js'
import { initfiles, loadnotes, closecontextmenu } from '../workspace/files.js'
import { initassistant, loadaiinfo } from '../chat/assistant.js'
import { initconversationstorage } from '../chat/conversations.js'
import { initlayout } from '../workspace/layout.js'
import { initsidebarsettings } from '../workspace/settings.js'
import { initpreview } from '../workspace/preview.js'
import { initosfiledrop } from '../workspace/osfiledrop.js'
import { initspellcheckdisabled } from './spellcheck.js'
import { opennote } from '../editor/editor.js'

// freeze mobile vs desktop from the url before any layout work --------------------
applymobileboot()

// register service worker for pwa installability --------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })

  // handle notification messages from service worker --------------------
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open_note' && e.data.note_id) {
      opennote(e.data.note_id, { newtab: true, switchfolder: true })
    } else if (e.data?.type === 'in_app_toast') {
      showinapptoast({
        title: e.data.title,
        body: e.data.body,
        note: e.data.note
      })
    }
  })
}

// display in-app notification toast --------------------
export function showinapptoast({ title = 'mushnote', body = '', note = null } = {}) {
  let container = document.getElementById('app-toast-container')
  if (!container) {
    container = document.createElement('div')
    container.id = 'app-toast-container'
    container.className = 'app-toast-container'
    document.body.appendChild(container)
  }

  const toast = document.createElement('div')
  toast.className = `app-toast${note ? ' is-clickable' : ''}`

  const safeTitle = document.createElement('span')
  safeTitle.textContent = title
  const safeBody = document.createElement('span')
  safeBody.textContent = body

  toast.innerHTML = `
    <img class="app-toast-icon" src="/applogo-192.png" alt="">
    <div class="app-toast-content">
      <div class="app-toast-title">${safeTitle.innerHTML}</div>
      <div class="app-toast-body">${safeBody.innerHTML}</div>
    </div>
    <button type="button" class="app-toast-close" aria-label="close">&times;</button>
  `

  const closebtn = toast.querySelector('.app-toast-close')
  const content = toast.querySelector('.app-toast-content')

  function dismiss() {
    toast.classList.add('is-leaving')
    setTimeout(() => toast.remove(), 220)
  }

  closebtn?.addEventListener('click', (e) => {
    e.stopPropagation()
    dismiss()
  })

  if (note) {
    content?.addEventListener('click', () => {
      opennote(note, { newtab: true, switchfolder: true })
      dismiss()
    })
  }

  container.appendChild(toast)

  // auto dismiss after 5 seconds --------------------
  setTimeout(() => {
    if (toast.isConnected) {
      dismiss()
    }
  }, 5000)
}

// dom elements for workspace header --------------------
const loggedavatar = document.getElementById('logged-avatar')
const loggedname = document.getElementById('logged-name')
const sidebaruserbox = document.getElementById('sidebar-user-box')

// boot check active user session --------------------
async function boot() {
  if (!ismobilemode() && !isextensionconnected()) {
    await new Promise(r => setTimeout(r, 300))
    if (!isextensionconnected()) {
      window.location.replace('/')
      return
    }
  }

  let res
  try {
    res = await api('/api/auth/me')
  } catch (err) {
    window.location.replace('/')
    return
  }

  if (!res || !res.user) {
    window.location.replace('/')
    return
  }

  state.currentuser = {
    ...res.user,
    id: res.user.id || res.user.user_id
  }
  if (res.user.avatar) {
    state.useravatarmap[state.currentuser.id] = res.user.avatar
  }
  state.usercolormap[state.currentuser.id] = resolveaccent(res.user.preferences)

  if (loggedavatar) loggedavatar.src = res.user.avatar
  if (loggedname) loggedname.textContent = res.user.name
  applytheme(res.user.preferences)

  try {
    initlayout()
    initfiles()
    initpreview()
    initosfiledrop()
    initassistant()
    await initconversationstorage()
    initsidebarsettings()

    loadaiinfo()
    await loadnotes()

    // open note from /editor/<path> url if present --------------------
    const match = window.location.pathname.match(/^\/editor\/(.+)$/)
    if (match && match[1]) {
      const targetid = decodeURIComponent(match[1])
      await opennote(targetid, { replacecurrent: true })
    }
  } catch (err) {
    console.error('ui initialization error', err)
  } finally {
    dismissloadingscreen()
  }
}

function dismissloadingscreen() {
  const loader = document.getElementById('app-loading-screen')
  if (!loader) return
  // allow browser a frame to commit loaded styles and layout before fading --------------------
  requestAnimationFrame(() => {
    loader.classList.add('is-loaded')
    setTimeout(() => {
      loader.remove()
    }, 320)
  })
}

// global keyboard shortcuts --------------------
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const aictx = document.getElementById('ai-context-menu')
    if (aictx && !aictx.classList.contains('hidden')) {
      aictx.classList.add('hidden')
    }
    const filectx = document.getElementById('file-context-menu')
    if (filectx && !filectx.classList.contains('hidden')) {
      closecontextmenu()
    }
    const editorctx = document.getElementById('editor-context-menu')
    if (editorctx && !editorctx.classList.contains('hidden')) {
      editorctx.classList.add('hidden')
    }
    const linkctx = document.getElementById('note-link-context-menu')
    if (linkctx && !linkctx.classList.contains('hidden')) {
      linkctx.classList.add('hidden')
    }
  }
})

initspellcheckdisabled()

// start application --------------------
boot()

