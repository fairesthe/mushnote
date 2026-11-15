import { api } from '../core/api.js'
import { initspellcheckdisabled } from '../core/spellcheck.js'

initspellcheckdisabled()

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
      window.location.replace('/editor.html')
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
      card.addEventListener('click', () => {
        openpassworddialog(user)
      })

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

  passworddialog.classList.remove('hidden')
  pwdinput.focus()
}

// close password dialog --------------------
function closepassworddialog() {
  passworddialog.classList.add('hidden')
  selecteduser = null
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

      window.location.replace('/editor.html')
    } catch (err) {
      errormsg.textContent = err.message || 'login failed'
      errormsg.classList.remove('hidden')
    }
  })
}

// boot login screen --------------------
checkauth()
