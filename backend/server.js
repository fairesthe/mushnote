import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import express from 'express'
import { WebSocketServer } from 'ws'
import { loadconfig, saveconfig, getvaultpath, gethistorypath, getrootdir } from './core/config.js'
import { initvault, getnotepath, listnotes, listfolders, readnote, deletenote, movenoteorfolder, createfolder, deletefolder, copynoteorfolder, getuniqueconflictpath, initsystemnotes, readuserpreferences, updateuserpreferences, normalizepreferences, audiofilepattern } from './vault/vault.js'
import { extractaudiocover } from './vault/audiocover.js'
import { inithistory, getrevisionbyid, getfiletimeline, getevents, getnoteauthorship, getdeletednotes, gethourlytimeline } from './vault/history.js'
import { getdoc, getdocifloaded, applydiff, restorenoterevision, handlesocket, migratedocentry, evictnotedoc, evictfolderdocs } from './sync/sync.js'
import { verifypassword, setuserauth, createsession, getsession, extracttoken, formatavatarurl } from './core/auth.js'
import { runagentchat } from './agent/agent.js'
import { startjobscheduler } from './agent/jobs.js'
import { generateconversationtitle } from './agent/chat/conversationtitle.js'
import {
  listconversations,
  readconversation,
  createconversation,
  saveconversation,
  deleteconversation,
  conversationvaultpath,
  sanitizeconversationid,
} from './vault/conversations.js'
import { initvaultwatcher } from './vault/watcher.js'
import { log, printbanner, requestlogger } from './core/logger.js'
import { registerv1routes } from './http/v1routes.js'
import { getvapidpublickey, savesubscription, removesubscription, getsubscriptions, setuserpermission, getnotificationstatus } from './core/notifications.js'

// configuration and initialization --------------------
const config = loadconfig()
const vaultdir = getvaultpath(config)
const historydir = gethistorypath(config)
const rootdir = getrootdir()

initvault(vaultdir)
inithistory(historydir)
initsystemnotes(vaultdir, config.users || [])

const app = express()
const server = http.createServer(app)
const port = config.server?.port || 3000
const host = config.server?.host || 'localhost'

// live websocket server for yjs sync --------------------
const wss = new WebSocketServer({ noServer: true })

function broadcastvaultchange(payload) {
  if (!wss || !wss.clients) return
  const msg = JSON.stringify(payload)
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(msg)
    }
  }
}

app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ extended: true, limit: '50mb' }))
app.use(requestlogger)

// serve static frontend and resources --------------------
const frontenddir = path.join(rootdir, 'frontend')
const resourcesdir = path.join(rootdir, 'resources')
const iconsdir = path.join(resourcesdir, 'icons')
const vaultavatarsdir = path.join(vaultdir, 'avatars')
const resourcesavatarsdir = path.join(resourcesdir, 'avatars')
const katexdir = path.join(rootdir, 'backend', 'node_modules', 'katex', 'dist')

if (fs.existsSync(katexdir)) {
  app.use('/katex', express.static(katexdir))
}

// serve avatars directly from vault/avatars and resources without /resources prefix --------------------
if (fs.existsSync(vaultavatarsdir)) {
  app.use('/avatars', express.static(vaultavatarsdir))
  app.use('/vault/avatars', express.static(vaultavatarsdir))
  app.use('/notes/avatars', express.static(vaultavatarsdir))
}
if (fs.existsSync(resourcesavatarsdir)) {
  app.use('/avatars', express.static(resourcesavatarsdir))
}
app.use('/avatars', express.static(resourcesdir))

app.use('/icons', express.static(iconsdir))
app.use('/resources', express.static(resourcesdir))

// serve media folder inside vault statically --------------------
const vaultmediadir = path.join(vaultdir, 'media')
if (!fs.existsSync(vaultmediadir)) {
  fs.mkdirSync(vaultmediadir, { recursive: true })
}
app.use('/media', express.static(vaultmediadir))
app.use('/vault/media', express.static(vaultmediadir))

// serve vault files for browser preview and relative assets --------------------
app.use('/preview', (req, res, next) => {
  const rawpath = decodeURIComponent(req.path).replace(/^\/+/, '')
  const normpath = path.normalize(rawpath).replace(/^(\.\.[\/\\])+/, '')
  const fullpath = path.join(vaultdir, normpath)
  if (!fullpath.startsWith(vaultdir)) {
    return res.status(403).send('forbidden')
  }
  if (normpath.startsWith('system/') || normpath === 'system') {
    return res.status(403).send('access to system folder is restricted')
  }
  express.static(vaultdir, { dotfiles: 'ignore' })(req, res, next)
})

app.use('/logo.png', (req, res) => res.sendFile(path.join(resourcesdir, 'logo.png')))
app.use('/applogo-192.png', (req, res) => res.sendFile(path.join(resourcesdir, 'applogo-192.png')))
app.use('/applogo-512.png', (req, res) => res.sendFile(path.join(resourcesdir, 'applogo-512.png')))
app.use('/favicon.ico', (req, res) => res.sendFile(path.join(resourcesdir, 'logo.png')))
app.use('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json')
  res.sendFile(path.join(frontenddir, 'manifest.json'))
})
app.use('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript')
  res.sendFile(path.join(frontenddir, 'sw.js'))
})
app.use(express.static(frontenddir))

// friendly html page routes --------------------
app.get('/login', (req, res) => {
  res.redirect('/')
})

app.get('/editor', (req, res) => {
  res.sendFile(path.join(frontenddir, 'editor.html'))
})

app.get('/editor/*', (req, res) => {
  res.sendFile(path.join(frontenddir, 'editor.html'))
})

// same shell as editor -- mobile mode is decided by the path --------------------
app.get('/mobile', (req, res) => {
  res.sendFile(path.join(frontenddir, 'editor.html'))
})

// health check endpoint --------------------
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    vault: vaultdir,
    history: historydir
  })
})

// check whether user has access to view or edit system notes --------------------
function checksystemaccess(noteid, session) {
  if (!noteid || !noteid.startsWith('system/')) {
    return true
  }
  if (session?.admin) {
    return true
  }
  const parts = noteid.split('/')
  const folderuser = parts[1]
  return Boolean(session?.user_id && folderuser === session.user_id)
}

registerv1routes(app, {
  vaultdir,
  historydir,
  checksystemaccess,
  readuserpreferences,
})

// auth routes --------------------
app.get('/api/auth/users', (req, res) => {
  const conf = loadconfig()
  const users = (conf.users || []).map(u => {
    const userid = u.username || u.id
    const isbot = Boolean(u.bot || u.role === 'ai')
    const isadmin = Boolean(u.admin)
    const prefs = readuserpreferences(vaultdir, userid) || {}
    const displayname = prefs.name || userid
    return {
      id: userid,
      username: userid,
      name: displayname,
      avatar: formatavatarurl(u.avatar),
      admin: isadmin,
      bot: isbot,
      has_auth: Boolean(u.auth),
      can_login: !isbot,
      preferences: {
        ...normalizepreferences(prefs),
        'last-open-note': prefs['last-open-note'] || null
      }
    }
  })
  res.json({ users })
})

app.post('/api/auth/setup-password', (req, res) => {
  const { user_id, password } = req.body
  if (!user_id || !password) {
    return res.status(400).json({ error: 'user_id and password are required' })
  }

  const conf = loadconfig()
  const user = (conf.users || []).find(u => (u.username || u.id) === user_id)
  if (!user) {
    return res.status(404).json({ error: 'user not found' })
  }
  const isbot = Boolean(user.bot || user.role === 'ai')
  if (isbot) {
    return res.status(403).json({ error: 'bot accounts cannot be logged into' })
  }
  if (user.auth) {
    return res.status(400).json({ error: 'user already has auth set' })
  }

  try {
    const updated = setuserauth(user_id, password)
    const userid = updated.username || updated.id
    const prefs = readuserpreferences(vaultdir, userid) || {}
    const displayname = prefs.name || userid
    const userpayload = {
      id: userid,
      username: userid,
      name: displayname,
      avatar: formatavatarurl(updated.avatar),
      admin: Boolean(updated.admin),
      bot: false,
      preferences: prefs
    }
    const token = createsession(userpayload)
    res.setHeader('Set-Cookie', `mushnote_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`)
    res.json({
      status: 'ok',
      token,
      user: userpayload
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/auth/login', (req, res) => {
  const { user_id, password } = req.body
  if (!user_id || !password) {
    return res.status(400).json({ error: 'user_id and password are required' })
  }

  const conf = loadconfig()
  const user = (conf.users || []).find(u => (u.username || u.id) === user_id)
  if (!user) {
    return res.status(404).json({ error: 'user not found' })
  }
  const isbot = Boolean(user.bot || user.role === 'ai')
  if (isbot) {
    return res.status(403).json({ error: 'bot accounts cannot be logged into' })
  }
  if (!user.auth) {
    return res.status(400).json({ error: 'auth not configured for this user' })
  }

  const valid = verifypassword(password, user.auth)
  if (!valid) {
    log.auth('failed', user_id, 'invalid credentials')
    return res.status(401).json({ error: 'invalid credentials' })
  }

  const userid = user.username || user.id
  const prefs = readuserpreferences(vaultdir, userid) || {}
  const displayname = prefs.name || userid
  const userpayload = {
    id: userid,
    username: userid,
    name: displayname,
    avatar: formatavatarurl(user.avatar),
    admin: Boolean(user.admin),
    bot: false,
    preferences: prefs
  }
  const token = createsession(userpayload)
  log.auth('login', userid, `${displayname} signed in`)
  res.setHeader('Set-Cookie', `mushnote_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`)
  res.json({
    status: 'ok',
    token,
    user: userpayload
  })
})

app.get('/api/auth/me', (req, res) => {
  const token = extracttoken(req)
  const session = getsession(token)
  if (!session) {
    return res.status(401).json({ authenticated: false, user: null })
  }
  res.json({ authenticated: true, user: session })
})

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'mushnote_session=; Path=/; HttpOnly; Max-Age=0')
  res.json({ status: 'ok' })
})

// admin create user account --------------------
app.post('/api/admin/users', (req, res) => {
  const token = extracttoken(req)
  const session = getsession(token)
  if (!session || !session.admin) {
    return res.status(403).json({ error: 'admin privileges required' })
  }

  const { username, admin = false, bot = false, avatar } = req.body
  const cleanusername = String(username || '').toLowerCase().trim().replace(/[^a-z0-9_-]/g, '')
  if (!cleanusername) {
    return res.status(400).json({ error: 'valid username is required' })
  }

  const conf = loadconfig()
  const exists = (conf.users || []).some(u => (u.username || u.id) === cleanusername)
  if (exists) {
    return res.status(400).json({ error: 'username already exists' })
  }

  const isbot = Boolean(bot)
  const newuser = {
    username: cleanusername,
    admin: Boolean(admin),
    bot: isbot,
    avatar: formatavatarurl(avatar) || (isbot ? '/avatars/default_ai.png' : '/avatars/default_user.png')
  }

  if (!conf.users) {
    conf.users = []
  }
  conf.users.push(newuser)
  saveconfig(conf)
  initsystemnotes(vaultdir, [newuser])

  res.status(201).json({ status: 'created', user: newuser })
})

// admin delete user account --------------------
app.delete('/api/admin/users/:username', (req, res) => {
  const token = extracttoken(req)
  const session = getsession(token)
  if (!session || !session.admin) {
    return res.status(403).json({ error: 'admin privileges required' })
  }

  const targetname = String(req.params.username || '').toLowerCase().trim()
  if (targetname === session.user_id) {
    return res.status(400).json({ error: 'cannot delete your own account' })
  }

  const conf = loadconfig()
  const aiusername = conf.gemini?.['ai-username'] || conf.gemini?.ai_username || 'ai'
  if (targetname === aiusername) {
    return res.status(400).json({ error: 'cannot delete the ai assistant account' })
  }

  const targetuser = (conf.users || []).find(u => (u.username || u.id) === targetname)
  if (!targetuser) {
    return res.status(404).json({ error: 'user not found' })
  }

  conf.users = conf.users.filter(u => (u.username || u.id) !== targetname)
  saveconfig(conf)

  // clean up system user folder if it exists --------------------
  const usersystemdir = path.join(vaultdir, 'system', targetname)
  if (fs.existsSync(usersystemdir)) {
    try {
      fs.rmSync(usersystemdir, { recursive: true, force: true })
    } catch (err) {
      console.error('failed to remove user system dir', err)
    }
  }

  res.json({ status: 'ok', deleted: targetname })
})

// update user password --------------------
app.post('/api/user/password', (req, res) => {
  const token = extracttoken(req)
  const session = getsession(token)
  if (!session) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  const { current_password, new_password, target_user } = req.body
  if (!new_password || typeof new_password !== 'string' || new_password.length < 1) {
    return res.status(400).json({ error: 'valid new password is required' })
  }

  const targetuserid = (target_user && session.admin ? target_user : session.user_id).toLowerCase().trim()
  const conf = loadconfig()
  const user = (conf.users || []).find(u => (u.username || u.id) === targetuserid)
  if (!user) {
    return res.status(404).json({ error: 'user not found' })
  }
  if (user.bot) {
    return res.status(400).json({ error: 'cannot set password for bot accounts' })
  }

  // verify current password if user has auth and is changing own password --------------------
  if (targetuserid === session.user_id && user.auth) {
    if (!current_password || !verifypassword(current_password, user.auth)) {
      return res.status(400).json({ error: 'current password is incorrect' })
    }
  }

  setuserauth(targetuserid, new_password)
  res.json({ status: 'ok' })
})

// get user preferences and config --------------------
app.get('/api/user/preferences', (req, res) => {
  const token = extracttoken(req)
  const session = getsession(token)
  if (!session) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  const targetuserid = (req.query.user_id || session.user_id).toLowerCase().trim()
  if (targetuserid !== session.user_id && !session.admin) {
    return res.status(403).json({ error: 'forbidden' })
  }

  const conf = loadconfig()
  const user = (conf.users || []).find(u => (u.username || u.id) === targetuserid)
  if (!user) {
    return res.status(404).json({ error: 'user not found' })
  }

  const prefs = readuserpreferences(vaultdir, targetuserid) || {}
  res.json({
    user_id: targetuserid,
    username: targetuserid,
    avatar: formatavatarurl(user.avatar) || '',
    admin: Boolean(user.admin),
    bot: Boolean(user.bot || user.role === 'ai'),
    preferences: prefs
  })
})

// update user preferences and config fields --------------------
app.post('/api/user/preferences', (req, res) => {
  const token = extracttoken(req)
  const session = getsession(token)
  if (!session) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  const { user_id, preferences = {}, avatar, admin, bot } = req.body
  const targetuserid = (user_id || session.user_id).toLowerCase().trim()
  if (targetuserid !== session.user_id && !session.admin) {
    return res.status(403).json({ error: 'forbidden' })
  }

  const conf = loadconfig()
  const user = (conf.users || []).find(u => (u.username || u.id) === targetuserid)
  if (!user) {
    return res.status(404).json({ error: 'user not found' })
  }

  const updated = updateuserpreferences(vaultdir, targetuserid, preferences)

  let configchanged = false
  if (typeof avatar === 'string') {
    const cleanavatar = formatavatarurl(avatar)
    if (cleanavatar !== user.avatar) {
      user.avatar = cleanavatar
      configchanged = true
    }
  }
  if (session.admin && typeof admin === 'boolean' && admin !== user.admin && !user.bot) {
    user.admin = admin
    configchanged = true
  }
  if (session.admin && typeof bot === 'boolean' && bot !== user.bot && targetuserid !== session.user_id) {
    user.bot = bot
    configchanged = true
  }
  if (configchanged) {
    saveconfig(conf)
  }

  res.json({ status: 'ok', preferences: updated, user })
})

// notifications public vapid key --------------------
app.get('/api/notifications/vapid-public-key', async (req, res) => {
  try {
    const key = await getvapidpublickey(vaultdir)
    res.json({ public_key: key })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// register push subscription --------------------
app.post('/api/notifications/subscribe', (req, res) => {
  const token = extracttoken(req)
  const session = getsession(token)
  if (!session) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  const { subscription } = req.body || {}
  if (!subscription) {
    return res.status(400).json({ error: 'subscription is required' })
  }

  const saved = savesubscription(vaultdir, session.user_id, subscription, req.headers['user-agent'] || '')
  res.json({ status: saved ? 'ok' : 'failed' })
})

// unregister push subscription --------------------
app.post('/api/notifications/unsubscribe', (req, res) => {
  const token = extracttoken(req)
  const session = getsession(token)
  if (!session) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  const { endpoint } = req.body || {}
  removesubscription(vaultdir, endpoint)
  res.json({ status: 'ok' })
})

// check notification status for current user --------------------
app.get('/api/notifications/status', (req, res) => {
  const token = extracttoken(req)
  const session = getsession(token)
  if (!session) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  const status = getnotificationstatus(vaultdir, session.user_id)
  const subs = getsubscriptions(vaultdir, session.user_id)
  res.json({ status, enabled: status === 'enabled', count: subs.length })
})

// update notification permission for current user --------------------
app.post('/api/notifications/permission', (req, res) => {
  const token = extracttoken(req)
  const session = getsession(token)
  if (!session) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  const { permission } = req.body || {}
  setuserpermission(vaultdir, session.user_id, permission)
  const status = getnotificationstatus(vaultdir, session.user_id)
  res.json({ status: 'ok', notification_status: status })
})

// list all notes and folders in vault respecting user permissions --------------------
app.get('/api/notes', (req, res) => {
  const token = extracttoken(req)
  const session = getsession(token)
  const isadmin = Boolean(session?.admin)
  const currentuser = session?.user_id

  let notes = listnotes(vaultdir)
  let folders = listfolders(vaultdir)
  if (!isadmin) {
    notes = notes.filter(n => {
      if (!n.note_id.startsWith('system/')) {
        return true
      }
      const parts = n.note_id.split('/')
      const folderuser = parts[1]
      return Boolean(currentuser && folderuser === currentuser)
    })
    folders = folders.filter(f => {
      if (!f.startsWith('system/')) {
        return true
      }
      const parts = f.split('/')
      const folderuser = parts[1]
      return Boolean(currentuser && folderuser === currentuser)
    })
  }

  res.json({ notes, folders })
})

// read single note supporting nested paths --------------------
app.get('/api/note', (req, res) => {
  const token = extracttoken(req)
  const session = getsession(token)
  const noteid = req.query.id
  if (!noteid) {
    return res.status(400).json({ error: 'id query parameter required' })
  }
  if (!checksystemaccess(noteid, session)) {
    return res.status(403).json({ error: 'forbidden' })
  }

  const note = readnote(vaultdir, noteid)
  if (!note) {
    return res.status(404).json({ error: 'note not found' })
  }
  const loadeddoc = getdocifloaded(noteid)
  if (loadeddoc) {
    note.content = loadeddoc.getcontent()
  }
  const authorship = getnoteauthorship(historydir, noteid)
  note.last_author = authorship.last_author
  note.created_by = authorship.created_by
  note.created_time = authorship.created_time || (note.created_at ? new Date(note.created_at).getTime() : 0)
  note.revision_count = authorship.revision_count
  res.json({ note })
})

// serve raw vault file (e.g. images) --------------------
app.get('/api/raw', (req, res) => {
  const token = extracttoken(req)
  const session = getsession(token)
  const noteid = req.query.id
  if (!noteid) {
    return res.status(400).json({ error: 'id query parameter required' })
  }
  if (!checksystemaccess(noteid, session)) {
    return res.status(403).json({ error: 'forbidden' })
  }

  const filepath = getnotepath(vaultdir, noteid)
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'file not found' })
  }
  // keep pdfs inline so the in-tab iframe can render them --------------------
  if (/\.pdf$/i.test(filepath)) {
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', 'inline')
  }
  res.sendFile(filepath)
})

// embedded cover art from audio file tags --------------------
app.get('/api/media/cover', async (req, res) => {
  const token = extracttoken(req)
  const session = getsession(token)
  const noteid = req.query.id
  if (!noteid) {
    return res.status(400).json({ error: 'id query parameter required' })
  }
  if (!checksystemaccess(noteid, session)) {
    return res.status(403).json({ error: 'forbidden' })
  }

  const filepath = getnotepath(vaultdir, noteid)
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'file not found' })
  }
  const basename = path.basename(filepath).toLowerCase()
  if (!audiofilepattern.test(basename)) {
    return res.status(404).json({ error: 'no cover for this file type' })
  }

  const cover = await extractaudiocover(filepath)
  if (!cover) {
    return res.status(404).json({ error: 'no embedded cover art' })
  }

  res.setHeader('content-type', cover.mimetype)
  res.setHeader('cache-control', 'public, max-age=300')
  res.send(cover.data)
})

// legacy single segment read --------------------
app.get('/api/notes/:id', (req, res) => {
  const token = extracttoken(req)
  const session = getsession(token)
  const noteid = req.params.id
  if (!checksystemaccess(noteid, session)) {
    return res.status(403).json({ error: 'forbidden' })
  }
  const note = readnote(vaultdir, noteid)
  if (!note) {
    return res.status(404).json({ error: 'note not found' })
  }
  const loadeddoc = getdocifloaded(noteid)
  if (loadeddoc) {
    note.content = loadeddoc.getcontent()
  }
  const authorship = getnoteauthorship(historydir, noteid)
  note.last_author = authorship.last_author
  note.created_by = authorship.created_by
  note.created_time = authorship.created_time || (note.created_at ? new Date(note.created_at).getTime() : 0)
  note.revision_count = authorship.revision_count
  res.json({ note })
})

// create or overwrite note --------------------
app.post('/api/notes', (req, res) => {
  const token = extracttoken(req)
  const session = getsession(token)
  const { note_id, title = '', content = '', create_unique = false } = req.body
  const author = session?.user_id || req.body?.author || 'unknown'
  if (!note_id) {
    return res.status(400).json({ error: 'note_id is required' })
  }

  const targetid = create_unique ? getuniqueconflictpath(vaultdir, note_id, false) : note_id

  if (!checksystemaccess(targetid, session)) {
    return res.status(403).json({ error: 'forbidden' })
  }

  const initialcontent = title && !content.startsWith('#')
    ? `# ${title}\n\n${content}`
    : content

  const entry = getdoc(vaultdir, historydir, targetid)
  const disknote = readnote(vaultdir, targetid)
  const exists = Boolean(disknote)
  const currentbody = entry.getcontent()
  if (exists && currentbody === initialcontent) {
    return res.json({ status: 'ok', note_id: targetid })
  }
  if (exists && currentbody.trim().length > 80 && !String(initialcontent || '').trim()) {
    return res.status(409).json({ error: 'refusing empty overwrite' })
  }
  if (exists && currentbody.trim().length > 400 && String(initialcontent || '').trim().length < 40) {
    return res.status(409).json({ error: 'refusing collapsed overwrite' })
  }

  entry.setcontent(initialcontent, author)
  entry.flushtodisk(author)
  log.note('save', targetid, `by ${author} (${initialcontent.length} chars)`)
  broadcastvaultchange({ type: 'vault_changed', action: 'create', note_id: targetid })
  res.status(201).json({ status: 'created', note_id: targetid })
})

// upload file into vault --------------------
app.post('/api/upload', (req, res) => {
  const token = extracttoken(req)
  const session = getsession(token)
  if (!session) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  const { path: filepath, data } = req.body
  if (!filepath || !data) {
    return res.status(400).json({ error: 'path and data are required' })
  }

  // sanitize path relative to vault and resolve conflict --------------------
  const normpath = path.normalize(filepath).replace(/^(\.\.[\/\\])+/, '').replace(/\\/g, '/')
  const uniquepath = getuniqueconflictpath(vaultdir, normpath, false)
  const fullpath = path.join(vaultdir, uniquepath)
  const dir = path.dirname(fullpath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  // decode base64 buffer --------------------
  const base64str = data.includes(',') ? data.split(',')[1] : data
  const buffer = Buffer.from(base64str, 'base64')
  fs.writeFileSync(fullpath, buffer)

  log.note('upload', uniquepath, `saved ${buffer.length} bytes`)
  res.json({
    status: 'ok',
    path: uniquepath,
    url: '/' + uniquepath.replace(/\\/g, '/')
  })
})

// edit note with diff --------------------
app.post('/api/notes/:id/diff', async (req, res) => {
  const token = extracttoken(req)
  const session = getsession(token)
  if (!checksystemaccess(req.params.id, session)) {
    return res.status(403).json({ error: 'forbidden' })
  }

  try {
    const updated = await applydiff(vaultdir, historydir, req.params.id, req.body)
    log.note('diff', req.params.id, `by ${req.body?.author || 'agent'}`)
    res.json({ status: 'ok', content: updated })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// every history route needs a logged in session --------------------
app.use('/api/history', (req, res, next) => {
  const session = getsession(extracttoken(req))
  if (!session) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  req.session = session
  next()
})

// timeline of revisions and events, hourly groups or every save --------------------
app.get('/api/history', (req, res) => {
  const noteid = req.query.id
  if (!noteid) {
    return res.status(400).json({ error: 'id query parameter required' })
  }
  if (!checksystemaccess(noteid, req.session)) {
    return res.status(403).json({ error: 'forbidden' })
  }

  const limit = parseInt(req.query.limit || '80', 10)
  const tzoffset = parseInt(req.query.tz || '0', 10) || 0
  res.json({
    timeline: req.query.hourly === '1'
      ? gethourlytimeline(historydir, noteid, limit, tzoffset)
      : getfiletimeline(historydir, noteid, limit),
    note_missing: !readnote(vaultdir, noteid)
  })
})

// notes with history whose file is gone from the vault --------------------
app.get('/api/history/deleted', (req, res) => {
  const existing = listnotes(vaultdir).map(note => note.note_id)
  // chat logs churn constantly and arent notes anyway
  const notes = getdeletednotes(historydir, existing)
    .filter(note => checksystemaccess(note.note_id, req.session))
    .filter(note => !/^system\/[^/]+\/conversations\//.test(note.note_id))
  res.json({ notes })
})

app.get('/api/history/revision/:revid', (req, res) => {
  const rev = getrevisionbyid(historydir, req.params.revid)
  if (!rev) {
    return res.status(404).json({ error: 'revision not found' })
  }
  if (!checksystemaccess(rev.file_id, req.session)) {
    return res.status(403).json({ error: 'forbidden' })
  }
  res.json({ revision: rev })
})

app.post('/api/history/restore', (req, res) => {
  const noteid = req.body?.note_id || req.body?.id
  const revid = req.body?.revision_id
  if (!noteid || !revid) {
    return res.status(400).json({ error: 'note_id and revision_id required' })
  }
  if (!checksystemaccess(noteid, req.session)) {
    return res.status(403).json({ error: 'forbidden' })
  }

  try {
    const author = req.session.user_id || 'user'
    const result = restorenoterevision(vaultdir, historydir, noteid, revid, author)
    log.note('restore', noteid, `rev ${revid} by ${author}`)
    res.json({ status: 'ok', ...result })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// audit events for one file, or the whole vault minus system paths the user cant see --------------------
app.get('/api/history/events', (req, res) => {
  const fileid = req.query.id || null
  if (fileid && !checksystemaccess(fileid, req.session)) {
    return res.status(403).json({ error: 'forbidden' })
  }
  const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 500)
  const events = getevents(historydir, fileid, limit)
    .filter(ev => [ev.file_id, ev.old_path, ev.new_path].every(p => !p || checksystemaccess(p, req.session)))
  res.json({ events })
})

// delete note supporting nested paths --------------------
app.delete('/api/note', (req, res) => {
  const token = extracttoken(req)
  const session = getsession(token)
  const noteid = req.query.id
  if (!noteid) {
    return res.status(400).json({ error: 'id query parameter required' })
  }
  if (!checksystemaccess(noteid, session)) {
    return res.status(403).json({ error: 'forbidden' })
  }
  const author = session?.user_id || 'user'
  const deleted = deletenote(vaultdir, noteid, historydir, author)
  if (!deleted) {
    return res.status(404).json({ error: 'note not found' })
  }
  // kill live yjs before any tab close can flush the note back onto disk --------------------
  evictnotedoc(historydir, noteid)
  log.note('delete', noteid, `by ${author}`)
  res.json({ status: 'deleted', note_id: noteid })
})

app.delete('/api/notes/:id', (req, res) => {
  const token = extracttoken(req)
  const session = getsession(token)
  if (!checksystemaccess(req.params.id, session)) {
    return res.status(403).json({ error: 'forbidden' })
  }
  const author = session?.user_id || 'user'
  const deleted = deletenote(vaultdir, req.params.id, historydir, author)
  if (!deleted) {
    return res.status(404).json({ error: 'note not found' })
  }
  evictnotedoc(historydir, req.params.id)
  log.note('delete', req.params.id, `by ${author}`)
  res.json({ status: 'deleted', note_id: req.params.id })
})

// rename or move note or folder endpoint --------------------
app.post('/api/note/rename', (req, res) => {
  const { old_id, new_id } = req.body
  if (!old_id || !new_id) {
    return res.status(400).json({ error: 'old_id and new_id are required' })
  }
  const token = extracttoken(req)
  const session = getsession(token)
  if (!checksystemaccess(old_id, session) || !checksystemaccess(new_id, session)) {
    return res.status(403).json({ error: 'forbidden' })
  }
  const author = session?.user_id || 'user'
  try {
    const result = movenoteorfolder(vaultdir, historydir, old_id, new_id, author)
    migratedocentry(result.source, result.destination, result.type === 'folder')
    log.note('move', `${result.source} --> ${result.destination}`, `by ${author}`)
    res.json({ status: 'ok', source: result.source, destination: result.destination, type: result.type })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// create folder endpoint --------------------
app.post('/api/folder', (req, res) => {
  const { folder_path } = req.body
  if (!folder_path) {
    return res.status(400).json({ error: 'folder_path is required' })
  }
  const token = extracttoken(req)
  const session = getsession(token)
  if (!checksystemaccess(folder_path, session)) {
    return res.status(403).json({ error: 'forbidden' })
  }
  const author = session?.user_id || 'user'
  try {
    const created = createfolder(vaultdir, folder_path)
    log.vault('create', folder_path, `by ${author}`)
    broadcastvaultchange({ type: 'vault_changed', action: 'create_folder', folder_path })
    res.status(201).json({ status: 'ok', folder: created })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// delete folder endpoint --------------------
app.delete('/api/folder', (req, res) => {
  const folderpath = req.query.path || req.body?.folder_path
  if (!folderpath) {
    return res.status(400).json({ error: 'path parameter is required' })
  }
  const token = extracttoken(req)
  const session = getsession(token)
  if (!checksystemaccess(folderpath, session)) {
    return res.status(403).json({ error: 'forbidden' })
  }
  const author = session?.user_id || 'user'
  try {
    const deleted = deletefolder(vaultdir, historydir, folderpath, author)
    if (!deleted) {
      return res.status(404).json({ error: 'folder not found' })
    }
    evictfolderdocs(historydir, folderpath)
    log.vault('delete', folderpath, `by ${author}`)
    res.json({ status: 'deleted', folder: folderpath })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// copy note or folder endpoint --------------------
app.post('/api/note/copy', (req, res) => {
  const { source, destination } = req.body
  if (!source || !destination) {
    return res.status(400).json({ error: 'source and destination are required' })
  }
  const token = extracttoken(req)
  const session = getsession(token)
  if (!checksystemaccess(source, session) || !checksystemaccess(destination, session)) {
    return res.status(403).json({ error: 'forbidden' })
  }
  const author = session?.user_id || 'user'
  try {
    const result = copynoteorfolder(vaultdir, historydir, source, destination, author)
    log.note('copy', `${result.source} --> ${result.destination}`, `by ${author}`)
    res.json({ status: 'ok', ...result })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// per-user ai conversations under system/<user>/conversations --------------------
function requiresession(req, res) {
  const token = extracttoken(req)
  const session = getsession(token)
  if (!session?.user_id) {
    res.status(401).json({ error: 'not authenticated' })
    return null
  }
  return session
}

app.get('/api/conversations', (req, res) => {
  const session = requiresession(req, res)
  if (!session) return
  const items = listconversations(vaultdir, session.user_id)
  res.json({ conversations: items })
})

app.post('/api/conversations', (req, res) => {
  const session = requiresession(req, res)
  if (!session) return
  const title = String(req.body?.title || 'new chat').trim() || 'new chat'
  const record = createconversation(vaultdir, session.user_id, { title })
  log.agent('conversation', 'create', `${session.user_id} ${record.id}`)
  res.status(201).json({ conversation: record })
})

app.get('/api/conversations/:id', (req, res) => {
  const session = requiresession(req, res)
  if (!session) return
  const id = sanitizeconversationid(req.params.id)
  if (!id) return res.status(400).json({ error: 'invalid id' })
  const vaultpath = conversationvaultpath(session.user_id, id)
  if (!checksystemaccess(vaultpath, session)) {
    return res.status(403).json({ error: 'forbidden' })
  }
  const record = readconversation(vaultdir, session.user_id, id)
  if (!record) return res.status(404).json({ error: 'conversation not found' })
  res.json({ conversation: record })
})

app.put('/api/conversations/:id', (req, res) => {
  const session = requiresession(req, res)
  if (!session) return
  const id = sanitizeconversationid(req.params.id)
  if (!id) return res.status(400).json({ error: 'invalid id' })
  const vaultpath = conversationvaultpath(session.user_id, id)
  if (!checksystemaccess(vaultpath, session)) {
    return res.status(403).json({ error: 'forbidden' })
  }
  const patch = {}
  if (req.body?.title !== undefined) patch.title = String(req.body.title || '').trim() || 'new chat'
  if (req.body?.title_generated !== undefined) patch.title_generated = Boolean(req.body.title_generated)
  if (req.body?.gemini_history !== undefined) patch.gemini_history = req.body.gemini_history
  if (req.body?.display_log !== undefined) patch.display_log = req.body.display_log
  if (req.body?.model !== undefined) patch.model = req.body.model
  if (req.body?.last_system_prompt_meta !== undefined) {
    patch.last_system_prompt_meta = req.body.last_system_prompt_meta
  }
  if (req.body?.draft !== undefined) {
    patch.draft = req.body.draft
  }
  try {
    const record = saveconversation(vaultdir, session.user_id, id, patch)
    res.json({ conversation: record })
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) })
  }
})

app.delete('/api/conversations/:id', (req, res) => {
  const session = requiresession(req, res)
  if (!session) return
  const id = sanitizeconversationid(req.params.id)
  if (!id) return res.status(400).json({ error: 'invalid id' })
  const vaultpath = conversationvaultpath(session.user_id, id)
  if (!checksystemaccess(vaultpath, session)) {
    return res.status(403).json({ error: 'forbidden' })
  }
  const ok = deleteconversation(vaultdir, session.user_id, id)
  if (!ok) return res.status(404).json({ error: 'conversation not found' })
  log.agent('conversation', 'delete', `${session.user_id} ${id}`)
  res.json({ status: 'deleted', id })
})

app.post('/api/conversations/:id/title', async (req, res) => {
  const session = requiresession(req, res)
  if (!session) return
  const id = sanitizeconversationid(req.params.id)
  if (!id) return res.status(400).json({ error: 'invalid id' })
  const vaultpath = conversationvaultpath(session.user_id, id)
  if (!checksystemaccess(vaultpath, session)) {
    return res.status(403).json({ error: 'forbidden' })
  }
  const record = readconversation(vaultdir, session.user_id, id)
  if (!record) return res.status(404).json({ error: 'conversation not found' })
  const firstmessage =
    String(req.body?.first_message || '').trim() ||
    record.display_log?.find((e) => e.role === 'user')?.prompt ||
    ''
  const title = await generateconversationtitle(firstmessage)
  const updated = saveconversation(vaultdir, session.user_id, id, {
    title,
    title_generated: true,
  })
  res.json({ conversation: updated, title })
})

// parse user agent into readable os device and browser --------------------
function parseclientinfo(req) {
  const custom = req.body?.client_info
  if (custom && typeof custom === 'string') return custom.slice(0, 120)

  const ua = req.headers['user-agent'] || ''
  if (!ua) return 'unknown'

  let os = 'unknown os'
  if (/windows phone/i.test(ua)) os = 'Windows Phone'
  else if (/win64|wow64|windows nt 10/i.test(ua)) os = 'Windows'
  else if (/windows nt/i.test(ua)) os = 'Windows'
  else if (/android/i.test(ua)) os = 'Android'
  else if (/iphone|ipad|ipod/i.test(ua)) os = 'iOS'
  else if (/macintosh|mac os x/i.test(ua)) os = 'macOS'
  else if (/linux/i.test(ua)) os = 'Linux'

  let device = 'desktop'
  if (/samsung.*mobile|sm-[a-z0-9]+/i.test(ua)) device = 'Samsung Galaxy'
  else if (/pixel/i.test(ua)) device = 'Google Pixel'
  else if (/iphone/i.test(ua)) device = 'iPhone'
  else if (/ipad/i.test(ua)) device = 'iPad'
  else if (/mobile/i.test(ua)) device = 'mobile'
  else if (/tablet/i.test(ua)) device = 'tablet'

  let browser = 'unknown browser'
  if (/samsungbrowser/i.test(ua)) browser = 'Samsung Internet'
  else if (/edg\//i.test(ua)) browser = 'Edge'
  else if (/firefox|fxios/i.test(ua)) browser = 'Firefox'
  else if (/chrome|crios/i.test(ua)) browser = 'Chrome'
  else if (/safari/i.test(ua) && !/chrome/i.test(ua)) browser = 'Safari'

  return `${os}, ${device}, ${browser}`
}

// pending browser extension fetch requests --------------------
const pendingbrowserfetches = new Map()
let browserfetchseq = 0

app.post('/api/agent/browser-result', (req, res) => {
  const { requestId, ok, data, error } = req.body || {}
  const entry = pendingbrowserfetches.get(requestId)
  if (!entry) {
    return res.status(404).json({ error: 'request not found or timed out' })
  }
  pendingbrowserfetches.delete(requestId)
  clearTimeout(entry.timer)
  if (ok) {
    entry.resolve(data)
  } else {
    entry.reject(new Error(error || 'browser fetch failed'))
  }
  res.json({ ok: true })
})

// gemini agent chat endpoint --------------------
app.post('/api/agent/chat', async (req, res) => {
  const token = extracttoken(req)
  const session = getsession(token)
  const activeuserid = session ? session.user_id : 'wyatt'
  const isadmin = session ? Boolean(session.admin) : false
  const { message = '', history = [], active_note_id, open_tabs = [], attachments = [], notification_permission } = req.body
  const clientinfo = parseclientinfo(req)

  if (notification_permission) {
    setuserpermission(vaultdir, activeuserid, notification_permission)
  }

  if (!message && (!attachments || attachments.length === 0)) {
    return res.status(400).json({ error: 'message or attachment is required' })
  }

  // set up server-sent events headers for per-token streaming --------------------
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  if (res.flushHeaders) res.flushHeaders()

  function sendevent(event, data) {
    if (res.writableEnded) return
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  let fulltext = ''
  let replyemitted = ''
  let thoughtdone = false
  let thoughtemitted = ''
  let tokenflushdebouncetimer = null
  let pendingtokendata = null

  // strip any xml tags like <tag> or </tag> --------------------
  function stripalltags(str) {
    if (!str) return ''
    return str.replace(/<\/?[a-zA-Z0-9_\-:]+(?:\s+[^>]*)?>/gi, '')
  }

  // hold back trailing unclosed tag in progress --------------------
  function cliptrailingtag(str) {
    if (!str) return ''
    const lastopen = str.lastIndexOf('<')
    if (lastopen !== -1) {
      const afteropen = str.slice(lastopen)
      if (!afteropen.includes('>')) {
        return str.slice(0, lastopen)
      }
    }
    return str
  }

  function flushpendingtoken() {
    if (tokenflushdebouncetimer) {
      clearTimeout(tokenflushdebouncetimer)
      tokenflushdebouncetimer = null
    }
    if (pendingtokendata) {
      const data = pendingtokendata
      pendingtokendata = null
      sendevent('token', data)
    }
  }

  function scheduletokenemit(delta, full) {
    pendingtokendata = { delta, full }
    if (!tokenflushdebouncetimer) {
      tokenflushdebouncetimer = setTimeout(() => {
        flushpendingtoken()
      }, 70)
    }
  }

  function handlechunk(chunk) {
    fulltext += chunk

    const thoughtstart = fulltext.search(/<thought>/i)
    const thoughtend = fulltext.search(/<\/thought>/i)

    if (thoughtstart !== -1 && !thoughtdone) {
      if (thoughtend !== -1) {
        thoughtdone = true
        const rawthought = fulltext.slice(thoughtstart + 9, thoughtend)
        const cleanedthought = stripalltags(rawthought).trim()
        const thoughtdelta = cleanedthought.slice(thoughtemitted.length)
        if (thoughtdelta) {
          thoughtemitted = cleanedthought
          sendevent('thought', { delta: thoughtdelta, full: thoughtemitted, done: true })
        }

        let after = fulltext.slice(thoughtend + 10)
        const optidx = after.search(/<options/i)
        if (optidx !== -1) {
          after = after.slice(0, optidx)
        }
        let cleanreply = stripalltags(after)
        cleanreply = cliptrailingtag(cleanreply)
        const delta = cleanreply.slice(replyemitted.length)
        if (delta) {
          replyemitted = cleanreply
          scheduletokenemit(delta, replyemitted)
        }
      } else {
        let curthought = fulltext.slice(thoughtstart + 9)
        curthought = stripalltags(curthought)
        curthought = cliptrailingtag(curthought)
        const delta = curthought.slice(thoughtemitted.length)
        if (delta) {
          thoughtemitted = curthought
          sendevent('thought', { delta, full: curthought, done: false })
        }
      }
    } else if (thoughtstart === -1 || thoughtdone) {
      if (!thoughtdone) {
        if (fulltext.trimStart().startsWith('<') && !fulltext.includes('>')) {
          return
        }
        if (fulltext.includes('>') && !/<thought>/i.test(fulltext)) {
          thoughtdone = true
        } else if (fulltext.length > 20 && !/<thought/i.test(fulltext)) {
          thoughtdone = true
        }
      }

      if (thoughtdone) {
        const thoughtmatch = fulltext.match(/<\/thought>/i)
        let after = thoughtmatch ? fulltext.slice(thoughtmatch.index + 10) : fulltext
        const optidx = after.search(/<options/i)
        if (optidx !== -1) {
          after = after.slice(0, optidx)
        }
        let cleanreply = stripalltags(after)
        cleanreply = cliptrailingtag(cleanreply)
        const delta = cleanreply.slice(replyemitted.length)
        if (delta) {
          replyemitted = cleanreply
          scheduletokenemit(delta, replyemitted)
        }
      }
    }
  }

  try {
    const result = await runagentchat(message, {
      active_user_id: activeuserid,
      is_admin: isadmin,
      active_note_id,
      open_tabs,
      history,
      attachments,
      client_info: clientinfo,
      requestbrowserfetch: (url, timeoutms = 25000) => {
        const requestId = `bf_${++browserfetchseq}_${Date.now()}`
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingbrowserfetches.delete(requestId)
            reject(new Error('browser fetch timed out (is the mushnote extension installed?)'))
          }, timeoutms)
          pendingbrowserfetches.set(requestId, { resolve, reject, timer })
          sendevent('browser_fetch', { requestId, url })
        })
      },
      onProgress: (event, data) => {
        if (event === 'chunk') {
          handlechunk(data.text)
        } else if (event === 'tool_call') {
          flushpendingtoken()
          fulltext = ''
          replyemitted = ''
          pendingtokendata = null
          sendevent('tool_call', data)
        } else {
          flushpendingtoken()
          sendevent(event, data)
        }
      }
    })

    flushpendingtoken()
    sendevent('done', result)
    res.end()
  } catch (err) {
    let cleanmessage = err.message || 'unknown error'
    let errortype = 'error'

    // clean up raw json errors from google genai sdk --------------------
    try {
      const parsed = JSON.parse(cleanmessage)
      if (parsed.error) {
        const code = parsed.error.code
        const status = parsed.error.status
        if (code === 503 || status === 'UNAVAILABLE') {
          cleanmessage = 'one second...'
          errortype = 'soft'
        } else if (code === 429 || status === 'RESOURCE_EXHAUSTED') {
          const msg = (parsed.error.message || '').toLowerCase()
          if (msg.includes('quota') || msg.includes('daily') || msg.includes('exceeded')) {
            cleanmessage = 'limits reached. try again later!'
            errortype = 'hard'
          } else {
            cleanmessage = 'one second...'
            errortype = 'soft'
          }
        } else if (parsed.error.message) {
          cleanmessage = parsed.error.message.toLowerCase()
        }
      }
    } catch {
      const lower = cleanmessage.toLowerCase()
      if (lower.includes('error in input stream')) {
        cleanmessage = 'one second...'
        errortype = 'soft'
      } else if (lower.includes('503') || lower.includes('unavailable') || lower.includes('overloaded')) {
        cleanmessage = 'one second...'
        errortype = 'soft'
      } else if (lower.includes('429') || lower.includes('resource_exhausted')) {
        if (lower.includes('quota') || lower.includes('daily') || lower.includes('exceeded')) {
          cleanmessage = 'limits reached. try again later!'
          errortype = 'hard'
        } else {
          cleanmessage = 'one second...'
          errortype = 'soft'
        }
      }
    }

    sendevent('error', { error: cleanmessage, error_type: errortype })
    res.end()
  }
})


server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`)
  if (url.pathname.startsWith('/ws')) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request)
    })
  } else {
    socket.destroy()
  }
})

wss.on('connection', (ws, request) => {
  const url = new URL(request.url, `http://${request.headers.host}`)
  // decode pathname to preserve slashes and path components --------------------
  const pathsegments = url.pathname.replace(/^\/ws\/?/, '')
  const noteid = decodeURIComponent(pathsegments) || url.searchParams.get('note') || 'scratchpad'
  const author = url.searchParams.get('author') || 'anonymous'

  handlesocket(ws, vaultdir, historydir, noteid, author)
})

// verify required media binaries are installed --------------------
for (const [bin, arg] of [['yt-dlp', '--version'], ['ffmpeg', '-version']]) {
  try {
    execFileSync(bin, [arg], { stdio: 'ignore' })
  } catch {
    console.error(`error: required dependency "${bin}" is not installed or not on PATH`)
    process.exit(1)
  }
}

// start http and websocket server --------------------
server.listen(port, host, () => {
  const asciipath = path.join(rootdir, 'resources', 'ascii.txt')
  printbanner(port, host, vaultdir, historydir, asciipath)

  // watch vault directory for external file edits and sync live --------------------
  initvaultwatcher(vaultdir, historydir, wss)

  // scheduled jobs under system/<user>/jobs --------------------
  startjobscheduler()
})
