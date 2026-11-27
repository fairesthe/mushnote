import { api } from '../core/api.js'
import { initspellcheckdisabled } from '../core/spellcheck.js'
import { pickworkspacepath, initmobilekeyboard, ismobiledevice } from '../core/mobile.js'

initspellcheckdisabled()
initmobilekeyboard()

// register service worker for pwa installability --------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

// login page state and elements --------------------
let selecteduser = null

const userslist = document.getElementById('users-list')

// password dialog elements --------------------
const passworddialog = document.getElementById('password-dialog')
const dialogavatar = document.getElementById('dialog-avatar')
const dialogusername = document.getElementById('dialog-user-name')
const dialogsubtext = document.getElementById('dialog-subtext')
const passwordform = document.getElementById('password-form')
const pwdlabel = document.getElementById('pwd-label')
const pwdinput = document.getElementById('pwd-input')
const confirmgroup = document.getElementById('confirm-group')
const pwdconfirminput = document.getElementById('pwd-confirm-input')
const errormsg = document.getElementById('error-message')
const btncancel = document.getElementById('btn-cancel')

// check active session on load --------------------
async function checkauth() {
  const urlparams = new URLSearchParams(window.location.search)
  if (urlparams.get('logout') === 'true') {
    try {
      await api('/api/auth/logout', { method: 'POST' })
    } catch {}
    window.history.replaceState({}, '', '/')
    loadusers()
    return
  }

  try {
    const res = await api('/api/auth/me')
    if (res && res.user) {
      window.location.replace(pickworkspacepath())
      return
    }
  } catch {}

  loadusers()
}

// load user list for login view --------------------
async function loadusers() {
  try {
    const data = await api('/api/auth/users')
    if (!userslist) return
    userslist.innerHTML = ''

    // only show human users eligible for login --------------------
    const loginusers = data.users.filter(u => u.can_login && !u.bot)

    for (const user of loginusers) {
      const card = document.createElement('div')
      card.className = 'user-card'

      const statuslabel = user.has_auth ? 'tap to log in' : 'set up password'

      const badges = []
      if (user.admin) {
        badges.push('<div class="user-badge admin">admin</div>')
      }

      card.innerHTML = `
        <div class="user-avatar-wrap">
          <img class="user-avatar-img" src="${user.avatar}" alt="${user.name}">
        </div>
        <div class="user-meta">
          <div class="user-name">${user.name}</div>
          <div class="user-subtext">${statuslabel}</div>
        </div>
        ${badges.join('')}
      `

      // clicking card prompts password --------------------
      const handletrigger = (e) => {
        e.preventDefault()
        openpassworddialog(user)
      }
      card.addEventListener('touchend', handletrigger)
      card.addEventListener('click', handletrigger)

      userslist.appendChild(card)
    }
  } catch (err) {
    console.error('failed to load users', err)
  }
}

// open password dialog for selected user --------------------
function openpassworddialog(user) {
  selecteduser = user
  errormsg.textContent = ''
  errormsg.classList.add('hidden')
  passwordform.reset()

  dialogavatar.src = user.avatar
  dialogusername.textContent = user.name

  if (user.has_auth) {
    dialogsubtext.textContent = 'enter password to continue'
    pwdlabel.textContent = 'password'
    confirmgroup.classList.add('hidden')
    pwdconfirminput.required = false
  } else {
    dialogsubtext.textContent = 'first login - set your password'
    pwdlabel.textContent = 'create password'
    confirmgroup.classList.remove('hidden')
    pwdconfirminput.required = true
  }

  document.body.classList.add('dialog-open')
  passworddialog.classList.remove('hidden')
  window.scrollTo(0, 0)
  // immediate focus during the touch interaction avoids safari auto pan --------------------
  if (pwdinput) {
    try {
      pwdinput.focus({ preventScroll: true })
    } catch {}
  }
}

// close password dialog --------------------
function closepassworddialog() {
  if (pwdinput) pwdinput.blur()
  if (pwdconfirminput) pwdconfirminput.blur()
  passworddialog.classList.add('hidden')
  document.body.classList.remove('dialog-open')
  selecteduser = null
  window.scrollTo(0, 0)
  void document.body.offsetHeight
}

if (btncancel) {
  btncancel.addEventListener('click', closepassworddialog)
}

if (passworddialog) {
  passworddialog.addEventListener('click', (e) => {
    if (e.target === passworddialog) {
      closepassworddialog()
    }
  })
}

// handle password submit --------------------
if (passwordform) {
  passwordform.addEventListener('submit', async (e) => {
    e.preventDefault()
    errormsg.textContent = ''
    errormsg.classList.add('hidden')

    if (!selecteduser) return

    const password = pwdinput.value
    const issetup = !selecteduser.has_auth

    if (issetup) {
      const confirm = pwdconfirminput.value
      if (password !== confirm) {
        errormsg.textContent = 'passwords do not match'
        errormsg.classList.remove('hidden')
        return
      }
    }

    const endpoint = issetup ? '/api/auth/setup-password' : '/api/auth/login'

    try {
      await api(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          user_id: selecteduser.id,
          password
        })
      })

      window.location.replace(pickworkspacepath())
    } catch (err) {
      errormsg.textContent = err.message || 'login failed'
      errormsg.classList.remove('hidden')
    }
  })
}

// boot login screen --------------------
if (ismobiledevice()) {
  checkauth()
  initpwainstall()
} else {
  initdesktopgate()
}

// dismiss loading screen once login screen elements populate --------------------
window.addEventListener('load', () => {
  dismissloadingscreen()
})

function dismissloadingscreen() {
  const loader = document.getElementById('app-loading-screen')
  if (!loader) return
  requestAnimationFrame(() => {
    loader.classList.add('is-loaded')
    setTimeout(() => {
      loader.remove()
    }, 320)
  })
}

// pwa install banner and instructions sheet --------------------
function initpwainstall() {
  const ismobile = ismobiledevice()
  const isstandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true
  if (!ismobile || isstandalone) return

  const dismissed = sessionStorage.getItem('mushnote_pwa_dismissed')
  if (dismissed === 'true') return

  const banner = document.getElementById('pwa-install-banner')
  const btninstall = document.getElementById('btn-pwa-install')
  const btnclose = document.getElementById('btn-pwa-banner-close')
  const backdrop = document.getElementById('pwa-sheet-backdrop')
  const sheet = document.getElementById('pwa-instructions-sheet')
  const sheetbody = document.getElementById('pwa-sheet-body')
  const sheetsclose = document.getElementById('btn-pwa-sheet-close')
  if (!banner || !btninstall || !btnclose) return

  let deferredprompt = null
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferredprompt = e
  })

  banner.classList.remove('hidden')

  btnclose.addEventListener('click', () => {
    banner.classList.add('hidden')
    sessionStorage.setItem('mushnote_pwa_dismissed', 'true')
  })

  function closesheet() {
    backdrop?.classList.add('hidden')
    sheet?.classList.add('hidden')
  }

  function opensheet() {
    const ua = navigator.userAgent || ''
    const isios = /iphone|ipad|ipod/i.test(ua)
    const issamsung = /samsungbrowser/i.test(ua)
    const ischrome = /chrome|crios/i.test(ua)

    let steps = []
    if (isios) {
      steps = [
        'tap the <strong>share button</strong> in safari (box with arrow pointing up)',
        'scroll down and tap <strong>add to home screen</strong>',
        'tap <strong>add</strong> on the top right to finish'
      ]
    } else if (issamsung) {
      steps = [
        'tap the <strong>menu icon</strong> (three lines or dots at bottom/top)',
        'tap <strong>add page to</strong> and select <strong>home screen</strong>',
        'confirm by tapping <strong>add / install</strong>'
      ]
    } else if (ischrome) {
      steps = [
        'tap the <strong>three dots menu</strong> on top right',
        'select <strong>install app</strong> or <strong>add to home screen</strong>',
        'confirm the installation prompt'
      ]
    } else {
      steps = [
        'open your browser <strong>menu / options</strong>',
        'select <strong>install app</strong> or <strong>add to home screen</strong>',
        'confirm installation'
      ]
    }

    if (sheetbody) {
      sheetbody.innerHTML = `
        <div class="pwa-step-list">
          ${steps.map((s, idx) => `
            <div class="pwa-step-item">
              <span class="pwa-step-num">${idx + 1}</span>
              <span class="pwa-step-text">${s}</span>
            </div>
          `).join('')}
        </div>
        <p class="pwa-sheet-hint">once installed mushnote runs in standalone full-screen mode</p>
      `
    }

    backdrop?.classList.remove('hidden')
    sheet?.classList.remove('hidden')
  }

  btninstall.addEventListener('click', async () => {
    if (deferredprompt) {
      deferredprompt.prompt()
      const choice = await deferredprompt.userChoice
      if (choice?.outcome === 'accepted') {
        banner.classList.add('hidden')
      }
      deferredprompt = null
    } else {
      opensheet()
    }
  })

  backdrop?.addEventListener('click', closesheet)
  sheetsclose?.addEventListener('click', closesheet)
}

// desktop extension gate (no login page without extension) --------------------
function initdesktopgate() {
  const picker = document.getElementById('user-picker')
  const gate = document.getElementById('desktop-ext-gate')
  let detected = false

  function unlock() {
    if (detected) return
    detected = true
    gate?.classList.add('hidden')
    picker?.classList.remove('hidden')
    checkauth()
  }

  window.addEventListener('message', (e) => {
    if (e.source === window && e.data?.type === 'MUSHNOTE_EXT_READY') {
      unlock()
    }
  })

  window.postMessage({ type: 'MUSHNOTE_EXT_PING' }, '*')

  setTimeout(() => {
    if (!detected) {
      picker?.classList.add('hidden')
      gate?.classList.remove('hidden')
    }
  }, 250)
}
