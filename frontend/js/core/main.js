import { api, applytheme, resolveaccent } from './api.js'
import { state } from './state.js'
import { initfiles, loadnotes, closecontextmenu } from '../workspace/files.js'
import { initassistant, loadaiinfo } from '../chat/assistant.js'
import { initconversationstorage } from '../chat/conversations.js'
import { initlayout } from '../workspace/layout.js'
import { initsidebarsettings } from '../workspace/settings.js'
import { initpreview } from '../workspace/preview.js'
import { initosfiledrop } from '../workspace/osfiledrop.js'
import { initspellcheckdisabled } from './spellcheck.js'

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
    loadnotes()
  } catch (err) {
    console.error('ui initialization error', err)
  }
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

