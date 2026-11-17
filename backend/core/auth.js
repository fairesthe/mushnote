import crypto from 'node:crypto'
import { loadconfig, saveconfig, getvaultpath } from './config.js'
import { readuserpreferences } from '../vault/vault.js'

// get or initialize stable secret key --------------------
function getsecret() {
  const conf = loadconfig()
  if (!conf.server) {
    conf.server = {}
  }
  if (!conf.server.secret) {
    conf.server.secret = crypto.randomBytes(32).toString('hex')
    saveconfig(conf)
  }
  return conf.server.secret
}

// hash password with random salt using scrypt --------------------
export function hashpassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const derived = crypto.scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${derived}`
}

// verify password against stored salt and hash --------------------
export function verifypassword(password, storedhash) {
  if (!storedhash || !storedhash.includes(':')) {
    return false
  }
  const [salt, key] = storedhash.split(':')
  const derived = crypto.scryptSync(password, salt, 64).toString('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(key, 'hex'))
  } catch {
    return false
  }
}

// update user auth field and persist into config yaml --------------------
export function setuserauth(userid, password) {
  const conf = loadconfig()
  const users = conf.users || []
  const user = users.find(u => (u.username || u.id) === userid)
  if (!user) {
    throw new Error('user not found')
  }
  const isbot = Boolean(user.bot || user.role === 'ai')
  if (isbot) {
    throw new Error('bot accounts cannot be logged into')
  }

  user.auth = hashpassword(password)
  saveconfig(conf)
  return user
}

// create signed stateless session token --------------------
export function createsession(user) {
  const secret = getsecret()
  const userid = user.username || user.id || user.user_id
  const payload = {
    user_id: userid,
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000
  }
  const payloadb64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = crypto.createHmac('sha256', secret).update(payloadb64).digest('base64url')
  return `${payloadb64}.${signature}`
}

// clean avatar path into a url the browser can actually load --------------------
export function formatavatarurl(avatar) {
  if (!avatar || typeof avatar !== 'string') return ''
  let cleaned = avatar.trim().replace(/\\/g, '/')
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

  cleaned = cleaned.replace(/^\/+/, '/')
  if (!cleaned.startsWith('/')) cleaned = `/${cleaned}`

  // already on a served root --------------------
  if (
    cleaned.startsWith('/avatars/') ||
    cleaned.startsWith('/media/') ||
    cleaned.startsWith('/preview/') ||
    cleaned.startsWith('/icons/') ||
    cleaned.startsWith('/resources/')
  ) {
    return cleaned
  }

  // vault image paths need /preview so express can serve them --------------------
  if (/\.(png|jpe?g|gif|webp|svg|ico)$/i.test(cleaned)) {
    return `/preview/${cleaned.replace(/^\/+/, '')}`
  }

  // legacy bare names still live under avatars --------------------
  return `/avatars/${cleaned.replace(/^\/+/, '')}`
}

// verify and decode signed session token --------------------
export function getsession(token) {
  if (!token || !token.includes('.')) {
    return null
  }
  const [payloadb64, signature] = token.split('.')
  const secret = getsecret()
  const expected = crypto.createHmac('sha256', secret).update(payloadb64).digest('base64url')

  if (signature.length !== expected.length) {
    return null
  }
  try {
    const valid = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    if (!valid) {
      return null
    }
    const payload = JSON.parse(Buffer.from(payloadb64, 'base64url').toString('utf8'))
    if (Date.now() > payload.exp) {
      return null
    }

    const conf = loadconfig()
    const user = (conf.users || []).find(u => (u.username || u.id) === payload.user_id)
    if (!user) {
      return null
    }
    const userid = user.username || user.id
    const vaultdir = getvaultpath(conf)
    const prefs = readuserpreferences(vaultdir, userid) || {}
    const displayname = prefs.name || userid
    const isadmin = Boolean(user.admin)
    const isbot = Boolean(user.bot || user.role === 'ai')

    return {
      user_id: userid,
      username: userid,
      name: displayname,
      avatar: formatavatarurl(user.avatar),
      admin: isadmin,
      bot: isbot,
      preferences: prefs
    }
  } catch {
    return null
  }
}

// extract session token from cookie header or authorization header --------------------
export function extracttoken(req) {
  const cookieheader = req.headers.cookie || ''
  for (const part of cookieheader.split(';')) {
    const [k, v] = part.trim().split('=')
    if (k === 'mushnote_session' && v) {
      return decodeURIComponent(v)
    }
  }
  const authheader = req.headers.authorization || ''
  return authheader.replace(/^Bearer\s+/i, '').trim()
}
