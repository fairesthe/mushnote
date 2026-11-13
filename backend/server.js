import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import express from 'express'
import { WebSocketServer } from 'ws'
import { loadconfig, saveconfig, getvaultpath, gethistorypath, getrootdir } from './config.js'
import { initvault, getnotepath, listnotes, listfolders, readnote, deletenote, movenoteorfolder, createfolder, deletefolder, copynoteorfolder, getuniqueconflictpath, initsystemnotes, readuserpreferences, updateuserpreferences, normalizepreferences } from './vault.js'
import { inithistory, gethistory, getevents, getnoteauthorship } from './history.js'
import { getdoc, getdocifloaded, applydiff, handlesocket, migratedocentry } from './sync.js'
import { verifypassword, setuserauth, createsession, getsession, extracttoken, formatavatarurl } from './auth.js'
import { runagentchat } from './agent.js'
import { initvaultwatcher } from './watcher.js'
import { log, printbanner, requestlogger } from './logger.js'

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
app.use('/favicon.ico', (req, res) => res.sendFile(path.join(resourcesdir, 'logo.png')))
app.use(express.static(frontenddir))

// friendly html page routes --------------------
app.get('/login', (req, res) => {
  res.redirect('/')
})

app.get('/editor', (req, res) => {
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

// auth routes --------------------
app.get('/api/auth/users', (req, res) => {
  const conf = loadconfig()
  const users = (conf.users || []).map(u => {
    const userid = u.username || u.id
    const isbot = Boolean(u.bot || u.role === 'ai')
    const isadmin = Boolean(u.admin)
    const prefs = readuserpreferences(vaultdir, userid) || {}
    const displayname = prefs.name || (userid.charAt(0).toUpperCase() + userid.slice(1))
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
    const displayname = prefs.name || (userid.charAt(0).toUpperCase() + userid.slice(1))
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
  const displayname = prefs.name || (userid.charAt(0).toUpperCase() + userid.slice(1))
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
  res.setHeader('Set-Cookie', [
    'mushnote_session=; Path=/; HttpOnly; Max-Age=0',
    'gillium_session=; Path=/; HttpOnly; Max-Age=0'
  ])
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
    avatar: formatavatarurl(avatar) || (isbot ? '/avatars/default_ai.png' : '/avatars/default_admin.png')
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
  res.sendFile(filepath)
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
  const { note_id, title = '', content = '', author = 'wyatt', create_unique = false } = req.body
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
  if (entry.ytext.toString() === initialcontent) {
    return res.json({ status: 'ok', note_id: targetid })
  }

  entry.doc.transact(() => {
    entry.ytext.delete(0, entry.ytext.length)
    entry.ytext.insert(0, initialcontent)
  }, author)

  entry.flushtodisk(author)
  log.note('save', targetid, `by ${author} (${initialcontent.length} chars)`)
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

// get per user note edit history supporting nested paths --------------------
app.get('/api/history', (req, res) => {
  const noteid = req.query.id
  const limit = parseInt(req.query.limit || '5', 10)
  if (!noteid) {
    return res.status(400).json({ error: 'id query parameter required' })
  }
  const history = gethistory(historydir, noteid, limit)
  res.json({ history })
})

app.get('/api/notes/:id/history', (req, res) => {
  const limit = parseInt(req.query.limit || '5', 10)
  const history = gethistory(historydir, req.params.id, limit)
  res.json({ history })
})

// read audit events log across vault or for a specific file --------------------
app.get('/api/history/events', (req, res) => {
  const fileid = req.query.id || null
  const limit = parseInt(req.query.limit || '50', 10)
  const events = getevents(historydir, fileid, limit)
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

// gemini agent chat endpoint --------------------
app.post('/api/agent/chat', async (req, res) => {
  const token = extracttoken(req)
  const session = getsession(token)
  const activeuserid = session ? session.user_id : 'wyatt'
  const isadmin = session ? Boolean(session.admin) : false
  const { message = '', history = [], active_note_id, open_tabs = [], attachments = [] } = req.body

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
      if (lower.includes('503') || lower.includes('unavailable') || lower.includes('overloaded')) {
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

// live websocket server for yjs sync --------------------
const wss = new WebSocketServer({ noServer: true })

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

// start http and websocket server --------------------
server.listen(port, host, () => {
  const asciipath = path.join(rootdir, 'resources', 'ascii.txt')
  printbanner(port, host, vaultdir, historydir, asciipath)

  // watch vault directory for external file edits and sync live --------------------
  initvaultwatcher(vaultdir, historydir, wss)
})
