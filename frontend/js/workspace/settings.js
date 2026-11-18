import { api, applytheme, parsereadingscale, resolveaccent } from '../core/api.js'
import { state } from '../core/state.js'
import { opennote, refreshreadingscale } from '../editor/editor.js'

// dom elements for sidebar settings --------------------
const sidebarpane = document.getElementById('sidebar-pane')
const sidebarfilesview = document.getElementById('sidebar-files-view')
const sidebarsettingsview = document.getElementById('sidebar-settings-view')
const sidebaruserbox = document.getElementById('sidebar-user-box')
const btnsettingslogout = document.getElementById('btn-settings-logout')

// user selection elements --------------------
const userselectionsection = document.getElementById('user-selection-section')
const btnsettingsuserpicker = document.getElementById('btn-settings-user-picker')
const settingsuserpickeravatar = document.getElementById('settings-user-picker-avatar')
const settingsuserpickername = document.getElementById('settings-user-picker-name')
const settingsuserpanel = document.getElementById('settings-user-panel')
const userradiolist = document.getElementById('user-radio-list')
const btntoggleadduser = document.getElementById('btn-toggle-add-user')
const forminlineadduser = document.getElementById('form-inline-add-user')
const inlinenewusername = document.getElementById('inline-new-username')
const inlinenewisadmin = document.getElementById('inline-new-is-admin')
const inlinenewisbot = document.getElementById('inline-new-is-bot')
const btncanceladduser = document.getElementById('btn-cancel-add-user')
const inlineaddusermsg = document.getElementById('inline-add-user-msg')

// clean avatar path into a url the browser can actually load --------------------
function cleanavatarurl(url) {
  if (!url) return ''
  let cleaned = url.trim().replace(/\\/g, '/')
  if (!cleaned) return ''
  if (/^https?:\/\//i.test(cleaned)) return cleaned

  if (cleaned.startsWith('/resources/avatars/')) {
    cleaned = cleaned.replace('/resources/avatars/', '/avatars/')
  } else if (cleaned.startsWith('/resources/')) {
    cleaned = `/avatars/${cleaned.slice('/resources/'.length)}`
  } else if (cleaned.startsWith('/vault/avatars/')) {
    cleaned = cleaned.replace('/vault/avatars/', '/avatars/')
  } else if (cleaned.startsWith('/notes/avatars/')) {
    cleaned = cleaned.replace('/notes/avatars/', '/avatars/')
  } else if (cleaned.startsWith('/vault/media/')) {
    cleaned = cleaned.replace('/vault/media/', '/media/')
  } else if (cleaned.startsWith('/vault/')) {
    cleaned = `/preview/${cleaned.slice('/vault/'.length)}`
  }

  if (!cleaned.startsWith('/')) cleaned = `/${cleaned}`

  if (
    cleaned.startsWith('/avatars/') ||
    cleaned.startsWith('/media/') ||
    cleaned.startsWith('/preview/') ||
    cleaned.startsWith('/icons/') ||
    cleaned.startsWith('/resources/')
  ) {
    return cleaned
  }

  // vault images outside media or avatars are served under /preview --------------------
  if (/\.(png|jpe?g|gif|webp|svg|ico)$/i.test(cleaned)) {
    return `/preview/${cleaned.replace(/^\/+/, '')}`
  }

  return `/avatars/${cleaned.replace(/^\/+/, '')}`
}

// user settings form elements --------------------
const settingsheading = document.getElementById('settings-heading')
const formusersettings = document.getElementById('form-user-settings')
const settingdisplayname = document.getElementById('setting-display-name')
const settingavatarurl = document.getElementById('setting-avatar-url')
const settingreadingscale = document.getElementById('setting-reading-scale')
const settingreadingscaleval = document.getElementById('setting-reading-scale-val')
const btnresetreadingscale = document.getElementById('btn-reset-reading-scale')
const btnjumppersonalitysidebar = document.getElementById('btn-jump-personality-sidebar')

const settingcolorbg = document.getElementById('setting-color-bg')
const settingcolorbghex = document.getElementById('setting-color-bg-hex')
const settingcolortext = document.getElementById('setting-color-text')
const settingcolortexthex = document.getElementById('setting-color-text-hex')
const settingcoloraccent = document.getElementById('setting-color-accent')
const settingcoloraccenthex = document.getElementById('setting-color-accent-hex')

const pwdcurrentwrap = document.getElementById('pwd-current-wrap')
const settingcurrentpwd = document.getElementById('setting-current-pwd')
const settingnewpwd = document.getElementById('setting-new-pwd')
const settingadminrolewrap = document.getElementById('setting-admin-role-wrap')
const settinguserisadmin = document.getElementById('setting-user-is-admin')
const settingbotrolewrap = document.getElementById('setting-bot-role-wrap')
const settinguserisbot = document.getElementById('setting-user-is-bot')
const usersettingsmsg = document.getElementById('user-settings-msg')

// delete account triple check elements --------------------
const deleteaccountwrap = document.getElementById('delete-account-wrap')
const btndeletestep0 = document.getElementById('btn-delete-step-0')
const deletecheck1 = document.getElementById('delete-check-1')
const deletenamepreview1 = document.getElementById('delete-name-preview-1')
const btndeleteconfirm1 = document.getElementById('btn-delete-confirm-1')
const btndeletecancel1 = document.getElementById('btn-delete-cancel-1')

const deletecheck2 = document.getElementById('delete-check-2')
const btndeleteconfirm2 = document.getElementById('btn-delete-confirm-2')
const btndeletecancel2 = document.getElementById('btn-delete-cancel-2')

const deletecheck3 = document.getElementById('delete-check-3')
const deletenamepreview3 = document.getElementById('delete-name-preview-3')
const deleteconfirminput = document.getElementById('delete-confirm-input')
const btndeletefinal = document.getElementById('btn-delete-final')
const btndeletecancel3 = document.getElementById('btn-delete-cancel-3')
const admindeletemsg = document.getElementById('admin-delete-msg')

let selecteduserid = null
let loadedusers = []

// helper to bind color picker and hex input --------------------
function syncpair(picker, input) {
  if (!picker || !input) return
  picker.addEventListener('input', () => {
    input.value = picker.value
  })
  input.addEventListener('input', () => {
    const val = input.value.trim()
    if (/^#[0-9a-fA-F]{6}$/.test(val)) {
      picker.value = val
    }
  })
}

// show inline status message --------------------
function showstatus(el, message, iserror = false) {
  if (!el) return
  el.textContent = message
  el.className = iserror ? 'settings-msg error' : 'settings-msg success'
  el.classList.remove('hidden')
  setTimeout(() => {
    el.classList.add('hidden')
  }, 4000)
}

// reset triple check state --------------------
function resettriplecheck() {
  if (btndeletestep0) btndeletestep0.classList.remove('hidden')
  if (deletecheck1) deletecheck1.classList.add('hidden')
  if (deletecheck2) deletecheck2.classList.add('hidden')
  if (deletecheck3) deletecheck3.classList.add('hidden')
  if (deleteconfirminput) {
    deleteconfirminput.value = ''
  }
  if (btndeletefinal) {
    btndeletefinal.disabled = true
  }
}

function setusersselectmode(on) {
  if (!sidebarsettingsview) return
  sidebarsettingsview.classList.toggle('users-mode', on)
  userselectionsection?.classList.toggle('is-open', on)
  settingsuserpanel?.classList.toggle('hidden', !on)
}

function updateselectedusercard() {
  const uid = selecteduserid
  const fromlist = loadedusers.find((u) => (u.id || u.username) === uid)
  const name = fromlist?.name
    || settingdisplayname?.value
    || state.currentuser?.name
    || uid
    || 'select user'
  const avatar = cleanavatarurl(
    fromlist?.avatar
    || settingavatarurl?.value
    || state.currentuser?.avatar
    || ''
  )
  if (settingsuserpickername) settingsuserpickername.textContent = name
  if (settingsuserpickeravatar) {
    settingsuserpickeravatar.src = avatar
    settingsuserpickeravatar.alt = name
  }
}

// switch between files and user settings view --------------------
export function togglesettingsview(showsettings) {
  if (!sidebarfilesview || !sidebarsettingsview) return
  if (showsettings) {
    sidebarfilesview.classList.add('hidden')
    sidebarsettingsview.classList.remove('hidden')
    sidebarpane?.classList.add('settings-open')
    setusersselectmode(false)
    loadinitialsettings()
  } else {
    sidebarsettingsview.classList.add('hidden')
    sidebarfilesview.classList.remove('hidden')
    sidebarpane?.classList.remove('settings-open')
    setusersselectmode(false)
    resettriplecheck()
  }
}

// load initial settings on opening --------------------
async function loadinitialsettings() {
  const isadmin = Boolean(state.currentuser?.admin)
  selecteduserid = state.currentuser?.id || state.currentuser?.username

  if (isadmin && userselectionsection) {
    userselectionsection.classList.remove('hidden')
    await refreshuserlist()
  } else if (userselectionsection) {
    userselectionsection.classList.add('hidden')
  }

  await loadusersettings(selecteduserid)
  renderpwanotifications()
}

// fetch all users and render radio list for admin --------------------
async function refreshuserlist() {
  try {
    const data = await api('/api/auth/users')
    loadedusers = data.users || []

    if (!userradiolist) return
    userradiolist.innerHTML = ''

    for (const u of loadedusers) {
      const uid = u.id || u.username
      const isbot = Boolean(u.bot || u.role === 'ai')
      const ischecked = uid === selecteduserid
      const iscurrent = uid === (state.currentuser?.id || state.currentuser?.username)

      const label = document.createElement('label')
      label.className = `user-radio-label${ischecked ? ' selected' : ''}`

      label.innerHTML = `
        <input type="radio" name="selected_user" value="${uid}" ${ischecked ? 'checked' : ''}>
        <img class="user-radio-avatar" src="${cleanavatarurl(u.avatar || '')}" alt="${u.name || uid}">
        <span class="user-radio-name">${u.name || uid}</span>
        ${isbot ? '<span class="user-radio-badge bot">bot</span>' : ''}
        ${u.admin ? '<span class="user-radio-badge">admin</span>' : ''}
        ${iscurrent ? '<span class="user-radio-badge active">you</span>' : ''}
      `

      const radio = label.querySelector('input[type="radio"]')
      radio.addEventListener('change', () => {
        selecteduserid = uid
        updateradioselection()
        updateselectedusercard()
        loadusersettings(selecteduserid)
        setusersselectmode(false)
      })

      userradiolist.appendChild(label)
    }

    updateselectedusercard()
  } catch (err) {
    console.error('failed to load user list', err)
  }
}

// update active class on radio labels --------------------
function updateradioselection() {
  if (!userradiolist) return
  const labels = userradiolist.querySelectorAll('.user-radio-label')
  labels.forEach(lbl => {
    const input = lbl.querySelector('input[type="radio"]')
    if (input && input.value === selecteduserid) {
      lbl.classList.add('selected')
      input.checked = true
    } else {
      lbl.classList.remove('selected')
    }
  })
}

// load settings for a specific user --------------------
async function loadusersettings(targetuserid) {
  if (!targetuserid) return
  resettriplecheck()

  const myid = state.currentuser?.id || state.currentuser?.username
  const isadmin = Boolean(state.currentuser?.admin)
  const isself = targetuserid === myid

  try {
    const data = await api(`/api/user/preferences?user_id=${encodeURIComponent(targetuserid)}`)
    const prefs = data.preferences || {}

    if (settingsheading) {
      settingsheading.textContent = isself ? 'user settings' : `settings - ${prefs.name || targetuserid}`
    }

    if (settingdisplayname) {
      settingdisplayname.value = prefs.name || targetuserid
    }
    if (settingavatarurl) {
      settingavatarurl.value = cleanavatarurl(data.avatar || '')
    }

    // keep the select-user card in sync with loaded prefs --------------------
    const listed = loadedusers.find((u) => (u.id || u.username) === targetuserid)
    if (listed) {
      listed.name = prefs.name || listed.name || targetuserid
      listed.avatar = cleanavatarurl(data.avatar || listed.avatar || '')
    }
    updateselectedusercard()

    const rawscale = prefs['reading-scale']
    const scale = parsereadingscale(rawscale)
    const scalepercent = Math.round(scale * 100)
    if (settingreadingscale) settingreadingscale.value = scalepercent
    if (settingreadingscaleval) settingreadingscaleval.textContent = `${scalepercent}%`

    const bcolor = prefs['bg-color'] || '#000000'
    if (settingcolorbg) settingcolorbg.value = bcolor
    if (settingcolorbghex) settingcolorbghex.value = bcolor

    const tcolor = prefs['text-color'] || '#ededed'
    if (settingcolortext) settingcolortext.value = tcolor
    if (settingcolortexthex) settingcolortexthex.value = tcolor

    const acolor = resolveaccent(prefs)
    if (settingcoloraccent) settingcoloraccent.value = acolor
    if (settingcoloraccenthex) settingcoloraccenthex.value = acolor

    if (settingcurrentpwd) settingcurrentpwd.value = ''
    if (settingnewpwd) settingnewpwd.value = ''

    // current password is only required when changing own password --------------------
    if (pwdcurrentwrap) {
      if (isself) {
        pwdcurrentwrap.classList.remove('hidden')
      } else {
        pwdcurrentwrap.classList.add('hidden')
      }
    }

    // admin role checkbox visibility --------------------
    if (settingadminrolewrap && settinguserisadmin) {
      if (isadmin && !isself) {
        settingadminrolewrap.classList.remove('hidden')
        settinguserisadmin.checked = Boolean(data.admin)
        settinguserisadmin.disabled = false
      } else {
        settingadminrolewrap.classList.add('hidden')
      }
    }

    // bot role checkbox visibility --------------------
    if (settingbotrolewrap && settinguserisbot) {
      if (isadmin) {
        settingbotrolewrap.classList.remove('hidden')
        settinguserisbot.checked = Boolean(data.bot)
        settinguserisbot.disabled = isself
      } else {
        settingbotrolewrap.classList.add('hidden')
      }
    }

    // delete account section visibility --------------------
    if (deleteaccountwrap) {
      if (isadmin && !isself) {
        deleteaccountwrap.classList.remove('hidden')
      } else {
        deleteaccountwrap.classList.add('hidden')
      }
    }
  } catch (err) {
    console.error('failed to load preferences for user', targetuserid, err)
  }
}

// initialize all sidebar settings listeners --------------------
export function initsidebarsettings() {
  // sync color pairs --------------------
  syncpair(settingcolorbg, settingcolorbghex)
  syncpair(settingcolortext, settingcolortexthex)
  syncpair(settingcoloraccent, settingcoloraccenthex)

  // live reading scale slider and reset --------------------
  if (settingreadingscale) {
    settingreadingscale.addEventListener('input', () => {
      const val = parseInt(settingreadingscale.value, 10) || 100
      if (settingreadingscaleval) {
        settingreadingscaleval.textContent = `${val}%`
      }
      const myid = state.currentuser?.id || state.currentuser?.username
      if (selecteduserid === myid) {
        document.documentElement.style.setProperty('--reading-scale', val / 100)
        refreshreadingscale()
      }
    })
  }

  if (btnresetreadingscale) {
    btnresetreadingscale.addEventListener('click', () => {
      if (settingreadingscale) {
        settingreadingscale.value = 100
      }
      if (settingreadingscaleval) {
        settingreadingscaleval.textContent = '100%'
      }
      const myid = state.currentuser?.id || state.currentuser?.username
      if (selecteduserid === myid) {
        document.documentElement.style.setProperty('--reading-scale', 1)
        refreshreadingscale()
      }
    })
  }

  // click user box in sidebar to open settings --------------------
  if (sidebaruserbox) {
    sidebaruserbox.addEventListener('click', () => {
      const isopen = !sidebarsettingsview.classList.contains('hidden')
      togglesettingsview(!isopen)
    })
  }

  // admin select user picker (same idea as ai conv menu) --------------------
  if (btnsettingsuserpicker) {
    btnsettingsuserpicker.addEventListener('click', () => {
      const isopen = sidebarsettingsview?.classList.contains('users-mode')
      setusersselectmode(!isopen)
    })
  }

  // logout button --------------------
  if (btnsettingslogout) {
    btnsettingslogout.addEventListener('click', async () => {
      try {
        await api('/api/auth/logout', { method: 'POST' })
      } catch {}
      window.location.replace('/?logout=true')
    })
  }

  // toggle inline add account form --------------------
  if (btntoggleadduser && forminlineadduser) {
    btntoggleadduser.addEventListener('click', () => {
      const ishidden = forminlineadduser.classList.contains('hidden')
      if (ishidden) {
        forminlineadduser.classList.remove('hidden')
        if (inlinenewusername) inlinenewusername.focus()
      } else {
        forminlineadduser.classList.add('hidden')
      }
    })
  }

  if (btncanceladduser && forminlineadduser) {
    btncanceladduser.addEventListener('click', () => {
      forminlineadduser.classList.add('hidden')
      forminlineadduser.reset()
    })
  }

  // submit inline add user form --------------------
  if (forminlineadduser) {
    forminlineadduser.addEventListener('submit', async (e) => {
      e.preventDefault()
      const uname = inlinenewusername.value.trim().toLowerCase()
      if (!uname) return

      try {
        await api('/api/admin/users', {
          method: 'POST',
          body: JSON.stringify({
            username: uname,
            admin: Boolean(inlinenewisadmin?.checked),
            bot: Boolean(inlinenewisbot?.checked)
          })
        })

        showstatus(inlineaddusermsg, `account ${uname} created`)
        forminlineadduser.reset()
        forminlineadduser.classList.add('hidden')

        selecteduserid = uname
        updateradioselection()
        setusersselectmode(false)
        await refreshuserlist()
        await loadusersettings(selecteduserid)
      } catch (err) {
        showstatus(inlineaddusermsg, err.message, true)
      }
    })
  }

  // jump to personality note --------------------
  if (btnjumppersonalitysidebar) {
    btnjumppersonalitysidebar.addEventListener('click', () => {
      if (!selecteduserid) return
      opennote(`system/${selecteduserid}/personality.md`)
    })
  }

  // submit user settings form --------------------
  if (formusersettings) {
    formusersettings.addEventListener('submit', async (e) => {
      e.preventDefault()
      if (!selecteduserid) return

      const myid = state.currentuser?.id || state.currentuser?.username
      const isself = selecteduserid === myid
      const isadmin = Boolean(state.currentuser?.admin)

      const prefs = {
        name: settingdisplayname.value.trim(),
        accent: settingcoloraccent.value,
        'bg-color': settingcolorbg.value,
        'text-color': settingcolortext.value,
        'reading-scale': settingreadingscale ? (parseInt(settingreadingscale.value, 10) || 100) : 100
      }

      const payload = {
        user_id: selecteduserid,
        preferences: prefs,
        avatar: cleanavatarurl(settingavatarurl.value)
      }

      if (isadmin && !isself && settinguserisadmin) {
        payload.admin = settinguserisadmin.checked
      }

      if (isadmin && !isself && settinguserisbot) {
        payload.bot = settinguserisbot.checked
      }

      try {
        await api('/api/user/preferences', {
          method: 'POST',
          body: JSON.stringify(payload)
        })

        // if editing self update local state and active theme --------------------
        state.usercolormap[selecteduserid] = prefs.accent

        if (isself) {
          state.currentuser.name = prefs.name || selecteduserid
          state.currentuser.avatar = payload.avatar
          state.currentuser.preferences = prefs

          const loggedname = document.getElementById('logged-name')
          const loggedavatar = document.getElementById('logged-avatar')
          if (loggedname) loggedname.textContent = state.currentuser.name
          if (loggedavatar && payload.avatar) loggedavatar.src = payload.avatar

          applytheme(prefs)
        }

        // update password if filled --------------------
        const newpwd = settingnewpwd?.value?.trim()
        if (newpwd) {
          await api('/api/user/password', {
            method: 'POST',
            body: JSON.stringify({
              target_user: selecteduserid,
              current_password: settingcurrentpwd?.value || '',
              new_password: newpwd
            })
          })
          if (settingcurrentpwd) settingcurrentpwd.value = ''
          if (settingnewpwd) settingnewpwd.value = ''
        }

        if (isadmin) {
          await refreshuserlist()
        }

        showstatus(usersettingsmsg, 'settings saved successfully')
      } catch (err) {
        showstatus(usersettingsmsg, err.message, true)
      }
    })
  }

  // triple check delete account flow --------------------
  if (btndeletestep0) {
    btndeletestep0.addEventListener('click', () => {
      if (!selecteduserid) return
      const myid = state.currentuser?.id || state.currentuser?.username
      if (selecteduserid === myid) {
        showstatus(admindeletemsg, 'cannot delete your own account', true)
        return
      }

      if (deletenamepreview1) deletenamepreview1.textContent = `@${selecteduserid}`
      btndeletestep0.classList.add('hidden')
      deletecheck1.classList.remove('hidden')
    })
  }

  if (btndeletecancel1) {
    btndeletecancel1.addEventListener('click', resettriplecheck)
  }

  if (btndeleteconfirm1) {
    btndeleteconfirm1.addEventListener('click', () => {
      deletecheck1.classList.add('hidden')
      deletecheck2.classList.remove('hidden')
    })
  }

  if (btndeletecancel2) {
    btndeletecancel2.addEventListener('click', resettriplecheck)
  }

  if (btndeleteconfirm2) {
    btndeleteconfirm2.addEventListener('click', () => {
      deletecheck2.classList.add('hidden')
      if (deletenamepreview3) deletenamepreview3.textContent = selecteduserid
      deletecheck3.classList.remove('hidden')
      if (deleteconfirminput) {
        deleteconfirminput.value = ''
        deleteconfirminput.focus()
      }
    })
  }

  if (btndeletecancel3) {
    btndeletecancel3.addEventListener('click', resettriplecheck)
  }

  if (deleteconfirminput) {
    deleteconfirminput.addEventListener('input', () => {
      const match = deleteconfirminput.value.trim().toLowerCase() === String(selecteduserid).toLowerCase()
      if (btndeletefinal) {
        btndeletefinal.disabled = !match
      }
    })
  }

  if (btndeletefinal) {
    btndeletefinal.addEventListener('click', async () => {
      if (!selecteduserid) return
      const deletedname = selecteduserid
      try {
        await api(`/api/admin/users/${encodeURIComponent(deletedname)}`, {
          method: 'DELETE'
        })
        showstatus(admindeletemsg, `account ${deletedname} deleted`)
        resettriplecheck()

        // switch selection back to own user --------------------
        selecteduserid = state.currentuser?.id || state.currentuser?.username
        await refreshuserlist()
        await loadusersettings(selecteduserid)
      } catch (err) {
        showstatus(admindeletemsg, err.message, true)
      }
    })
  }

  // mobile pwa notifications --------------------
  initpwanotifications()
}

// mobile pwa detection for android and ios only --------------------
function ismobilepwa() {
  const isstandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true
  const ua = navigator.userAgent || ''
  const isandroid = /android/i.test(ua)
  const isios = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  return isstandalone && (isandroid || isios)
}

// helper to convert url safe base64 to uint8array --------------------
function urlb64touint8array(base64string) {
  const padding = '='.repeat((4 - (base64string.length % 4)) % 4)
  const base64 = (base64string + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawdata = window.atob(base64)
  const outputarray = new Uint8Array(rawdata.length)
  for (let i = 0; i < rawdata.length; ++i) {
    outputarray[i] = rawdata.charCodeAt(i)
  }
  return outputarray
}

// subscribe client to push notifications on server --------------------
async function subscribepush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
  try {
    const reg = await navigator.serviceWorker.ready
    const res = await api('/api/notifications/vapid-public-key')
    if (!res || !res.public_key) return
    const appserverkey = urlb64touint8array(res.public_key)
    let sub = await reg.pushManager.getSubscription()
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: appserverkey
      })
    }
    if (sub) {
      await api('/api/notifications/subscribe', {
        method: 'POST',
        body: JSON.stringify({ subscription: sub })
      })
    }
  } catch (err) {
    // push subscription failed or blocked
  }
}

// render mobile pwa notifications section --------------------
function renderpwanotifications() {
  const card = document.getElementById('pwa-notifications-card')
  const control = document.getElementById('pwa-notif-control')
  const instructions = document.getElementById('pwa-notif-instructions')
  if (!card || !control || !instructions) return

  if (!ismobilepwa()) {
    card.classList.add('hidden')
    return
  }

  card.classList.remove('hidden')
  const permission = ('Notification' in window) ? Notification.permission : 'default'
  const ua = navigator.userAgent || ''
  const isandroid = /android/i.test(ua)

  // denied state: red x with device settings help --------------------
  if (permission === 'denied') {
    api('/api/notifications/permission', { method: 'POST', body: JSON.stringify({ permission: 'denied' }) }).catch(() => {})
    control.innerHTML = `
      <div class="pwa-notif-status-denied">
        <span class="pwa-notif-x">&times;</span>
        <span>notifications denied</span>
      </div>
    `
    const devicename = isandroid ? 'android' : 'ios'
    const steptext = isandroid
      ? `<li>touch and hold <strong>mushnote</strong> on your home screen and tap <strong>app info</strong> (or go to device <strong>settings --> apps --> mushnote</strong>)</li>
         <li>tap <strong>notifications</strong></li>
         <li>turn on <strong>allow notifications</strong></li>`
      : `<li>open your device <strong>settings</strong></li>
         <li>tap <strong>notifications</strong> (or find <strong>mushnote</strong> in the app list)</li>
         <li>tap <strong>mushnote</strong> and turn on <strong>allow notifications</strong></li>`

    instructions.innerHTML = `
      <div class="pwa-notif-help-title">how to enable in ${devicename} settings:</div>
      <ol class="pwa-notif-help-steps">${steptext}</ol>
    `
    instructions.classList.remove('hidden')
    return
  }

  // granted state: accent colored checkmark and green text --------------------
  if (permission === 'granted') {
    control.innerHTML = `
      <div class="pwa-notif-status-granted">
        <span class="pwa-notif-checkmark">&#10003;</span>
        <span class="pwa-notif-granted-text">notifications enabled</span>
      </div>
    `
    instructions.classList.add('hidden')
    instructions.innerHTML = ''
    subscribepush()
    return
  }

  // unchecked checkbox when not enabled yet --------------------
  control.innerHTML = `
    <label class="pwa-notif-checkbox-label">
      <input type="checkbox" id="pwa-notif-toggle" class="pwa-notif-checkbox">
      <span>enable notifications</span>
    </label>
  `
  instructions.classList.add('hidden')
  instructions.innerHTML = ''

  const toggle = document.getElementById('pwa-notif-toggle')
  if (toggle) {
    toggle.addEventListener('change', async () => {
      if (!toggle.checked) return
      if (!('Notification' in window)) return
      try {
        const nextperm = await Notification.requestPermission()
        api('/api/notifications/permission', { method: 'POST', body: JSON.stringify({ permission: nextperm }) }).catch(() => {})
        if (nextperm === 'granted') {
          await subscribepush()
        }
      } catch {}
      renderpwanotifications()
    })
  }
}

// initialize pwa notifications listeners --------------------
function initpwanotifications() {
  renderpwanotifications()

  // refresh status when switching back from device settings --------------------
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      renderpwanotifications()
    }
  })
  window.addEventListener('focus', () => {
    renderpwanotifications()
  })
}
