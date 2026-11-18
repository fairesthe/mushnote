import fs from 'node:fs'
import path from 'node:path'
import { log } from './logger.js'

// dynamic webpush loader to avoid crashing if npm install has not run --------------------
let webpushmod = null
let webpushchecked = false

async function loadwebpush() {
  if (webpushchecked) return webpushmod
  try {
    webpushmod = await import('web-push')
  } catch {
    webpushmod = null
  }
  webpushchecked = true
  return webpushmod
}

// path helpers for system notification files --------------------
function getvapidpath(vaultdir) {
  return path.join(vaultdir, 'system', 'vapid.json')
}

function getsubspath(vaultdir) {
  return path.join(vaultdir, 'system', 'push-subscriptions.json')
}

// ensure vapid keys exist and initialize webpush --------------------
let vapidinitialized = false
let cachedpublickey = null

export async function initvapid(vaultdir) {
  if (vapidinitialized && cachedpublickey) {
    return cachedpublickey
  }

  const wp = await loadwebpush()
  if (!wp || !wp.generateVAPIDKeys) {
    log.warn('push', 'disabled', 'web-push is not installed run npm install in backend')
    return null
  }

  const systemdir = path.join(vaultdir, 'system')
  if (!fs.existsSync(systemdir)) {
    fs.mkdirSync(systemdir, { recursive: true })
  }

  const vapidfile = getvapidpath(vaultdir)
  let keys = null

  if (fs.existsSync(vapidfile)) {
    try {
      keys = JSON.parse(fs.readFileSync(vapidfile, 'utf8'))
    } catch (err) {
      log.warn('vapid', 'corrupt', 'regenerating keys')
    }
  }

  if (!keys || !keys.publicKey || !keys.privateKey) {
    keys = wp.generateVAPIDKeys()
    fs.writeFileSync(vapidfile, JSON.stringify(keys, null, 2), 'utf8')
    log.server('vapid', 'generate', 'created new push keys')
  }

  wp.setVapidDetails(
    'mailto:admin@mushnote.local',
    keys.publicKey,
    keys.privateKey
  )

  cachedpublickey = keys.publicKey
  vapidinitialized = true
  return cachedpublickey
}

export async function getvapidpublickey(vaultdir) {
  return await initvapid(vaultdir)
}

// read and write notifications store containing subscriptions and permissions --------------------
function readnotificationsstore(vaultdir) {
  const filepath = getsubspath(vaultdir)
  if (!fs.existsSync(filepath)) {
    return { subscriptions: [], permissions: {} }
  }
  try {
    const raw = fs.readFileSync(filepath, 'utf8')
    const data = JSON.parse(raw)
    if (Array.isArray(data)) {
      return { subscriptions: data, permissions: {} }
    }
    return {
      subscriptions: Array.isArray(data.subscriptions) ? data.subscriptions : [],
      permissions: data.permissions && typeof data.permissions === 'object' ? data.permissions : {}
    }
  } catch {
    return { subscriptions: [], permissions: {} }
  }
}

function writenotificationsstore(vaultdir, store) {
  const systemdir = path.join(vaultdir, 'system')
  if (!fs.existsSync(systemdir)) {
    fs.mkdirSync(systemdir, { recursive: true })
  }
  const filepath = getsubspath(vaultdir)
  fs.writeFileSync(filepath, JSON.stringify(store, null, 2), 'utf8')
}

// read subscriptions list --------------------
function readsubscriptions(vaultdir) {
  const store = readnotificationsstore(vaultdir)
  return store.subscriptions
}

// save or update a subscription for a user --------------------
export function savesubscription(vaultdir, username, subscription, useragent = '') {
  if (!subscription || !subscription.endpoint) {
    return false
  }

  const store = readnotificationsstore(vaultdir)
  const normuser = String(username || '').trim().toLowerCase()
  const endpoint = subscription.endpoint

  // remove existing matching endpoint --------------------
  store.subscriptions = store.subscriptions.filter(s => s.subscription?.endpoint !== endpoint)

  store.subscriptions.push({
    user: normuser,
    subscription,
    user_agent: useragent,
    created_at: new Date().toISOString()
  })

  // mark permission as granted --------------------
  store.permissions[normuser] = 'granted'

  writenotificationsstore(vaultdir, store)
  log.server('push', normuser, 'saved push subscription')
  return true
}

// remove subscription by endpoint --------------------
export function removesubscription(vaultdir, endpoint) {
  if (!endpoint) return false
  const store = readnotificationsstore(vaultdir)
  const prevlen = store.subscriptions.length
  store.subscriptions = store.subscriptions.filter(s => s.subscription?.endpoint !== endpoint)
  if (store.subscriptions.length !== prevlen) {
    writenotificationsstore(vaultdir, store)
    return true
  }
  return false
}

// record user notification permission (granted denied or default) --------------------
export function setuserpermission(vaultdir, username, permission) {
  const normuser = String(username || '').trim().toLowerCase()
  if (!normuser) return
  const store = readnotificationsstore(vaultdir)
  const cleanperm = String(permission || '').trim().toLowerCase()
  if (!cleanperm) return
  store.permissions[normuser] = cleanperm
  writenotificationsstore(vaultdir, store)
}

// compute notification status for user: enabled denied or not set --------------------
export function getnotificationstatus(vaultdir, username) {
  const store = readnotificationsstore(vaultdir)
  const normuser = String(username || '').trim().toLowerCase()
  const usersubs = store.subscriptions.filter(s => s.user === normuser)
  if (usersubs.length > 0) {
    return 'enabled'
  }
  const perm = store.permissions[normuser]
  if (perm === 'denied') {
    return 'denied'
  }
  if (perm === 'granted') {
    return 'enabled'
  }
  return 'not set'
}

// get active subscriptions count or list for a user --------------------
export function getsubscriptions(vaultdir, username = null) {
  const subs = readsubscriptions(vaultdir)
  if (!username) return subs
  const normuser = String(username).trim().toLowerCase()
  return subs.filter(s => s.user === normuser)
}

// send push notification payload to target user or all users --------------------
export async function sendpushnotification(vaultdir, targetuser, payload) {
  const wp = await loadwebpush()
  const pubkey = await initvapid(vaultdir)
  if (!wp || !wp.sendNotification || !pubkey) {
    return { success: false, sent: 0, total: 0, note: 'web-push is not installed run npm install in backend' }
  }

  const allsubs = readsubscriptions(vaultdir)
  if (!allsubs || allsubs.length === 0) {
    return { success: true, sent: 0, total: 0, note: 'no push subscriptions registered' }
  }

  const normtarget = targetuser ? String(targetuser).trim().toLowerCase() : ''
  const isall = !normtarget || normtarget === 'all' || normtarget === '*'

  const targets = isall
    ? allsubs
    : allsubs.filter(s => s.user === normtarget)

  if (targets.length === 0) {
    return { success: true, sent: 0, total: 0, note: `no subscriptions found for ${normtarget}` }
  }

  // sensible defaults for title body icon and badge --------------------
  const notificationdata = {
    title: payload.title || 'mushnote',
    body: payload.body || 'new notification from mushnote',
    icon: payload.icon || '/applogo-192.png',
    badge: payload.badge || '/logo.png',
    data: payload.data || {}
  }

  const payloadstring = JSON.stringify(notificationdata)
  let sentcount = 0
  const expiredendpoints = []

  for (const item of targets) {
    try {
      await wp.sendNotification(item.subscription, payloadstring)
      sentcount++
    } catch (err) {
      const statuscode = err?.statusCode
      // 404 or 410 indicates subscription has expired or unsubscribed --------------------
      if (statuscode === 404 || statuscode === 410) {
        expiredendpoints.push(item.subscription?.endpoint)
      } else {
        log.warn('push', 'failed', err?.message || err)
      }
    }
  }

  // prune expired subscriptions if any --------------------
  if (expiredendpoints.length > 0) {
    const store = readnotificationsstore(vaultdir)
    store.subscriptions = store.subscriptions.filter(s => !expiredendpoints.includes(s.subscription?.endpoint))
    writenotificationsstore(vaultdir, store)
    log.server('push', 'prune', `removed ${expiredendpoints.length} expired subscriptions`)
  }

  return {
    success: true,
    sent: sentcount,
    total: targets.length
  }
}
