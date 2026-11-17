import crypto from 'node:crypto'
import { loadconfig, saveconfig } from '../core/config.js'
import {
  listnotes,
  listfolders,
  readnote,
  initsystemnotes,
} from '../vault/vault.js'
import { getnoteauthorship } from '../vault/history.js'
import { getdoc, getdocifloaded, applydiff } from '../sync/sync.js'
import {
  verifypassword,
  setuserauth,
  createsession,
  getsession,
  extracttoken,
  formatavatarurl,
} from '../core/auth.js'
import { log } from '../core/logger.js'

function cleanusername(raw) {
  return String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]/g, '')
}

function getregistrationsecret(conf) {
  return String(conf?.integrations?.registration_secret || '').trim()
}

function canregister(req, conf) {
  const token = extracttoken(req)
  const session = getsession(token)
  if (session?.admin) return { ok: true, via: 'admin' }

  const bodysecret = String(req.body?.registration_secret || '').trim()
  const configsecret = getregistrationsecret(conf)
  if (configsecret && bodysecret && bodysecret === configsecret) {
    return { ok: true, via: 'secret' }
  }
  return { ok: false }
}

function builduserpayload(user, vaultdir, readuserpreferences) {
  const userid = user.username || user.id
  const prefs = readuserpreferences(vaultdir, userid) || {}
  const displayname = prefs.name || userid
  return {
    id: userid,
    username: userid,
    name: displayname,
    avatar: formatavatarurl(user.avatar),
    admin: Boolean(user.admin),
    bot: false,
    preferences: prefs,
  }
}

function issession(req) {
  const token = extracttoken(req)
  const session = getsession(token)
  if (!session?.user_id) return null
  return session
}

function notepathfromreq(req) {
  const raw = req.body?.note_id || req.body?.id || req.query?.id || req.params?.id || ''
  return String(raw).replace(/\\/g, '/').replace(/^\/+/, '').trim()
}

export function registerv1routes(app, ctx) {
  const { vaultdir, historydir, checksystemaccess, readuserpreferences } = ctx

  app.get('/api/v1', (_req, res) => {
    res.json({
      name: 'mushnote external api',
      version: 1,
      auth: ['POST /api/v1/auth/login', 'POST /api/v1/auth/register'],
      notes: [
        'GET /api/v1/notes',
        'GET /api/v1/notes/file?id=path/to/note.md',
        'PUT /api/v1/notes/file',
        'PATCH /api/v1/notes/file',
      ],
    })
  })

  app.post('/api/v1/auth/register', (req, res) => {
    const conf = loadconfig()
    const gate = canregister(req, conf)
    if (!gate.ok) {
      return res.status(403).json({
        error: 'registration forbidden (admin session or valid registration_secret required)',
      })
    }

    const username = cleanusername(req.body?.username || req.body?.user_id)
    const password = String(req.body?.password || '')
    if (!username) {
      return res.status(400).json({ error: 'username is required (lowercase letters, numbers, _, -)' })
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'password is required (min 8 characters)' })
    }

    const exists = (conf.users || []).some((u) => (u.username || u.id) === username)
    if (exists) {
      return res.status(400).json({ error: 'username already exists' })
    }

    if (username === 'ai' || username === 'admin') {
      return res.status(400).json({ error: 'reserved username' })
    }

    const newuser = {
      username,
      admin: false,
      bot: false,
      avatar: '/avatars/default_user.png',
    }
    if (!conf.users) conf.users = []
    conf.users.push(newuser)
    saveconfig(conf)
    initsystemnotes(vaultdir, [newuser])
    setuserauth(username, password)

    const userpayload = builduserpayload(newuser, vaultdir, readuserpreferences)
    const token = createsession(userpayload)
    log.auth('register', username, `integration user via ${gate.via}`)
    res.status(201).json({
      status: 'created',
      token,
      user: userpayload,
    })
  })

  app.post('/api/v1/auth/login', (req, res) => {
    const user_id = cleanusername(req.body?.user_id || req.body?.username)
    const password = String(req.body?.password || '')
    if (!user_id || !password) {
      return res.status(400).json({ error: 'user_id and password are required' })
    }

    const conf = loadconfig()
    const user = (conf.users || []).find((u) => (u.username || u.id) === user_id)
    if (!user) {
      return res.status(404).json({ error: 'user not found' })
    }
    if (Boolean(user.bot || user.role === 'ai')) {
      return res.status(403).json({ error: 'bot accounts cannot log in' })
    }
    if (!user.auth) {
      return res.status(400).json({ error: 'password not set for this user' })
    }
    if (!verifypassword(password, user.auth)) {
      return res.status(401).json({ error: 'invalid credentials' })
    }

    const userpayload = builduserpayload(user, vaultdir, readuserpreferences)
    const token = createsession(userpayload)
    res.json({ status: 'ok', token, user: userpayload, expires_in_days: 30 })
  })

  app.get('/api/v1/auth/me', (req, res) => {
    const session = issession(req)
    if (!session) return res.status(401).json({ error: 'unauthorized' })
    res.json({ user: session })
  })

  app.get('/api/v1/notes', (req, res) => {
    const session = issession(req)
    if (!session) return res.status(401).json({ error: 'unauthorized' })

    const isadmin = Boolean(session.admin)
    const currentuser = session.user_id
    let notes = listnotes(vaultdir)
    let folders = listfolders(vaultdir)
    if (!isadmin) {
      notes = notes.filter((n) => {
        if (!n.note_id.startsWith('system/')) return true
        return n.note_id.split('/')[1] === currentuser
      })
      folders = folders.filter((f) => {
        if (!f.startsWith('system/')) return true
        return f.split('/')[1] === currentuser
      })
    }
    res.json({ notes, folders })
  })

  app.get('/api/v1/notes/file', (req, res) => {
    const session = issession(req)
    if (!session) return res.status(401).json({ error: 'unauthorized' })
    const noteid = notepathfromreq(req)
    if (!noteid) return res.status(400).json({ error: 'id query parameter required' })

    if (!checksystemaccess(noteid, session)) {
      return res.status(403).json({ error: 'forbidden' })
    }
    const note = readnote(vaultdir, noteid)
    if (!note) return res.status(404).json({ error: 'note not found' })

    const loadeddoc = getdocifloaded(noteid)
    if (loadeddoc) note.content = loadeddoc.getcontent()
    const authorship = getnoteauthorship(historydir, noteid)
    note.last_author = authorship.last_author
    note.created_by = authorship.created_by
    res.json({ note })
  })

  app.put('/api/v1/notes/file', (req, res) => {
    const session = issession(req)
    if (!session) return res.status(401).json({ error: 'unauthorized' })

    const noteid = notepathfromreq(req)
    if (!noteid) return res.status(400).json({ error: 'note_id is required' })

    if (!checksystemaccess(noteid, session)) {
      return res.status(403).json({ error: 'forbidden' })
    }

    const { content = '', title = '' } = req.body || {}
    let body = String(content)
    const titletext = String(title || '').trim()
    if (titletext && !body.startsWith('#')) {
      body = `# ${titletext}\n\n${body}`
    }

    const author = session.user_id
    const entry = getdoc(vaultdir, historydir, noteid)
    const existed = entry.getcontent().length > 0

    entry.setcontent(body, author)
    entry.flushtodisk(author)
    log.note('v1 put', noteid, `by ${author} (${body.length} chars)`)

    res.status(existed ? 200 : 201).json({
      status: existed ? 'updated' : 'created',
      note_id: noteid,
      bytes: body.length,
    })
  })

  app.patch('/api/v1/notes/file', async (req, res) => {
    const session = issession(req)
    if (!session) return res.status(401).json({ error: 'unauthorized' })

    const noteid = notepathfromreq(req)
    if (!noteid) return res.status(400).json({ error: 'note_id is required' })
    if (!checksystemaccess(noteid, session)) {
      return res.status(403).json({ error: 'forbidden' })
    }

    const append = String(req.body?.append || req.body?.content || '')
    const insert = String(req.body?.insert || '')
    const author = session.user_id

    if (append) {
      const entry = getdoc(vaultdir, historydir, noteid)
      const current = entry.getcontent()
      const glue = current.endsWith('\n') || !current ? '' : '\n'
      const next = `${current}${glue}${append}`
      entry.setcontent(next, author)
      entry.flushtodisk(author)
      return res.json({ status: 'appended', note_id: noteid, bytes: next.length })
    }

    if (insert && req.body?.target) {
      try {
        const updated = await applydiff(vaultdir, historydir, noteid, {
          mode: req.body.mode || 'insert_after',
          target: req.body.target,
          replacement_text: insert,
          author,
        })
        return res.json({ status: 'patched', note_id: noteid, content: updated })
      } catch (err) {
        return res.status(400).json({ error: err.message || String(err) })
      }
    }

    return res.status(400).json({ error: 'append or insert with target required' })
  })
}

export function ensureintegrationsecret() {
  const conf = loadconfig()
  if (!conf.integrations) conf.integrations = {}
  if (!conf.integrations.registration_secret) {
    conf.integrations.registration_secret = crypto.randomBytes(24).toString('hex')
    saveconfig(conf)
  }
  return conf.integrations.registration_secret
}