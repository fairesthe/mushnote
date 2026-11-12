import { api, applytheme } from './api.js'
import { state } from './state.js'
import { initfiles, loadnotes } from './files.js'
import { initassistant, loadaiinfo } from './assistant.js'
import { initlayout } from './layout.js'
import { initsidebarsettings } from './settings.js'

// dom elements for workspace header --------------------
const loggedavatar = document.getElementById('logged-avatar')
const loggedname = document.getElementById('logged-name')
const sidebaruserbox = document.getElementById('sidebar-user-box')

// boot check active user session --------------------
async function boot() {
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

  if (loggedavatar) loggedavatar.src = res.user.avatar
  if (loggedname) loggedname.textContent = res.user.name
  applytheme(res.user.preferences)

  try {
    initlayout()
    initfiles()
    initassistant()
    initsidebarsettings()

    loadaiinfo()
    loadnotes()
  } catch (err) {
    console.error('ui initialization error', err)
  }
}

// global keyboard shortcuts --------------------
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const newnotedialog = document.getElementById('new-note-dialog')
    if (newnotedialog && !newnotedialog.classList.contains('hidden')) {
      newnotedialog.classList.add('hidden')
    }
    const aictx = document.getElementById('ai-context-menu')
    if (aictx && !aictx.classList.contains('hidden')) {
      aictx.classList.add('hidden')
    }
    const filectx = document.getElementById('file-context-menu')
    if (filectx && !filectx.classList.contains('hidden')) {
      filectx.classList.add('hidden')
    }
  }
})

// start application --------------------
boot()

