import { api, applytheme } from './api.js'
import { state } from './state.js'
import { opennote } from './editor.js'

// dom elements for sidebar settings --------------------
const sidebarfilesview = document.getElementById('sidebar-files-view')
const sidebarsettingsview = document.getElementById('sidebar-settings-view')
const sidebaruserbox = document.getElementById('sidebar-user-box')
const btnsettingsback = document.getElementById('btn-settings-back')
const btnsettingslogout = document.getElementById('btn-settings-logout')

// user selection elements --------------------
const userselectionsection = document.getElementById('user-selection-section')
const userradiolist = document.getElementById('user-radio-list')
const btntoggleadduser = document.getElementById('btn-toggle-add-user')
const forminlineadduser = document.getElementById('form-inline-add-user')
const inlinenewusername = document.getElementById('inline-new-username')
const inlinenewisadmin = document.getElementById('inline-new-is-admin')
const inlinenewisbot = document.getElementById('inline-new-is-bot')
const btncanceladduser = document.getElementById('btn-cancel-add-user')
const inlineaddusermsg = document.getElementById('inline-add-user-msg')

// clean avatar path without resources prefix --------------------
function cleanavatarurl(url) {
  if (!url) return ''
  let cleaned = url.trim()
  if (cleaned.startsWith('/resources/avatars/')) {
    cleaned = cleaned.replace('/resources/avatars/', '/avatars/')
  } else if (cleaned.startsWith('/resources/')) {
    cleaned = cleaned.replace('/resources/', '/avatars/')
  } else if (cleaned.startsWith('/notes/avatars/')) {
    cleaned = cleaned.replace('/notes/avatars/', '/avatars/')
  }
  return cleaned
}

// user settings form elements --------------------
const settingsheading = document.getElementById('settings-heading')
const formusersettings = document.getElementById('form-user-settings')
const settingdisplayname = document.getElementById('setting-display-name')
const settingavatarurl = document.getElementById('setting-avatar-url')
const btnjumppersonalitysidebar = document.getElementById('btn-jump-personality-sidebar')

const settingcoloruser = document.getElementById('setting-color-user')
const settingcoloruserhex = document.getElementById('setting-color-user-hex')
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

// switch between files and user settings view --------------------
export function togglesettingsview(showsettings) {
  if (!sidebarfilesview || !sidebarsettingsview) return
  if (showsettings) {
    sidebarfilesview.classList.add('hidden')
    sidebarsettingsview.classList.remove('hidden')
    loadinitialsettings()
  } else {
    sidebarsettingsview.classList.add('hidden')
    sidebarfilesview.classList.remove('hidden')
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
        <img class="user-radio-avatar" src="${u.avatar || (isbot ? '/avatars/ai.jpg' : '/avatars/wyatt.png')}" alt="${u.name}">
        <span class="user-radio-name">${u.name}</span>
        ${isbot ? '<span class="user-radio-badge bot">bot</span>' : ''}
        ${u.admin ? '<span class="user-radio-badge">admin</span>' : ''}
        ${iscurrent ? '<span class="user-radio-badge active">you</span>' : ''}
      `

      const radio = label.querySelector('input[type="radio"]')
      radio.addEventListener('change', () => {
        selecteduserid = uid
        updateradioselection()
        loadusersettings(selecteduserid)
      })

      userradiolist.appendChild(label)
    }
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

    const ucolor = prefs['user-color'] || '#3b82f6'
    if (settingcoloruser) settingcoloruser.value = ucolor
    if (settingcoloruserhex) settingcoloruserhex.value = ucolor

    const bcolor = prefs['bg-color'] || '#000000'
    if (settingcolorbg) settingcolorbg.value = bcolor
    if (settingcolorbghex) settingcolorbghex.value = bcolor

    const tcolor = prefs['text-color'] || '#ededed'
    if (settingcolortext) settingcolortext.value = tcolor
    if (settingcolortexthex) settingcolortexthex.value = tcolor

    const acolor = prefs['accent-color'] || '#ffffff'
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
  syncpair(settingcoloruser, settingcoloruserhex)
  syncpair(settingcolorbg, settingcolorbghex)
  syncpair(settingcolortext, settingcolortexthex)
  syncpair(settingcoloraccent, settingcoloraccenthex)

  // click user box in sidebar to open settings --------------------
  if (sidebaruserbox) {
    sidebaruserbox.addEventListener('click', () => {
      const isopen = !sidebarsettingsview.classList.contains('hidden')
      togglesettingsview(!isopen)
    })
  }

  // back to notes button --------------------
  if (btnsettingsback) {
    btnsettingsback.addEventListener('click', () => {
      togglesettingsview(false)
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
        'user-color': settingcoloruser.value,
        'bg-color': settingcolorbg.value,
        'text-color': settingcolortext.value,
        'accent-color': settingcoloraccent.value
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
}
