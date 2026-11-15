import path from 'node:path'
import fs from 'node:fs'
import { getuniqueconflictpath, markinternalwrite } from '../vault/vault.js'
import { log } from '../core/logger.js'

const defaulttimeoutms = 30000
const maxtimeoutms = 120000
const maxbodybytes = 2 * 1024 * 1024
const defaultmaxchars = 32000
const hardmaxchars = 100000
const allowedmethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])

function isprivatehostname(hostname) {
  const host = String(hostname || '').toLowerCase()
  if (!host) return true
  if (host === 'localhost' || host === '0.0.0.0' || host.endsWith('.local') || host.endsWith('.internal')) {
    return true
  }
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return true
  }
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

function parsepublichttpurl(raw) {
  let parsed
  try {
    parsed = new URL(String(raw || '').trim())
  } catch {
    throw new Error('invalid url')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('only http and https urls are allowed')
  }
  if (isprivatehostname(parsed.hostname)) {
    throw new Error('refusing to call private or local hosts')
  }
  return parsed
}

function cleanvaultrel(raw) {
  return String(raw || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

function isinsidedir(parentabs, childabs) {
  const root = path.resolve(parentabs)
  const child = path.resolve(childabs)
  if (child === root) return true
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  return child.startsWith(prefix)
}

function parseheaders(raw) {
  if (raw == null || raw === '') return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const out = {}
    for (const [k, v] of Object.entries(raw)) {
      if (k == null || v == null) continue
      out[String(k)] = String(v)
    }
    return out
  }
  const text = String(raw).trim()
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('headers must be a json object')
    }
    const out = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (k == null || v == null) continue
      out[String(k)] = String(v)
    }
    return out
  } catch (err) {
    throw new Error(`invalid headers json (${err.message || err})`)
  }
}

function blockedrequestheader(name) {
  const n = String(name || '').toLowerCase()
  // authorization is allowed for public authed apis --------------------
  return (
    n === 'host' ||
    n === 'content-length' ||
    n === 'transfer-encoding' ||
    n === 'connection' ||
    n === 'keep-alive' ||
    n === 'upgrade' ||
    n === 'cookie'
  )
}

function sanitizeheaders(headers) {
  const out = {}
  for (const [key, value] of Object.entries(headers || {})) {
    const name = String(key)
    if (blockedrequestheader(name)) continue
    out[name] = String(value)
  }
  return out
}

function normalizebody(body, headers) {
  if (body == null || body === '') return { body: undefined, headers }
  if (typeof body === 'object') {
    const next = { ...headers }
    if (!Object.keys(next).some((k) => k.toLowerCase() === 'content-type')) {
      next['Content-Type'] = 'application/json'
    }
    return { body: JSON.stringify(body), headers: next }
  }
  return { body: String(body), headers }
}

async function readresponsetext(res, maxbytes) {
  const declared = Number(res.headers.get('content-length') || 0)
  if (declared > maxbytes) {
    throw new Error(`response too large (${Math.round(declared / 1024)}kb, max ${Math.round(maxbytes / 1024)}kb)`)
  }

  if (!res.body) {
    return { text: '', bytes: 0, truncated: false }
  }

  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  let truncated = false
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxbytes) {
      truncated = true
      try { reader.cancel() } catch {}
      break
    }
    chunks.push(Buffer.from(value))
  }
  const buf = Buffer.concat(chunks)
  return {
    text: buf.toString('utf8'),
    bytes: buf.length,
    truncated
  }
}

function saveresponsefile(vaultdir, destraw, text) {
  let dest = cleanvaultrel(destraw)
  if (!dest) throw new Error('save_to path is required when saving')
  dest = getuniqueconflictpath(vaultdir, dest, false)
  const abs = path.resolve(path.join(vaultdir, ...dest.split('/')))
  if (!isinsidedir(vaultdir, abs)) {
    throw new Error('save_to must stay inside the vault')
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  markinternalwrite(abs, text)
  fs.writeFileSync(abs, text, 'utf8')
  return dest
}

// call an external http api and return a compact result for the agent --------------------
export async function runapirequest(opts = {}) {
  const method = String(opts.method || 'GET').trim().toUpperCase()
  if (!allowedmethods.has(method)) {
    throw new Error(`method must be one of ${[...allowedmethods].join(', ')}`)
  }

  const parsed = parsepublichttpurl(opts.url)
  const url = parsed.toString()
  let headers = sanitizeheaders(parseheaders(opts.headers))
  const normalized = normalizebody(opts.body, headers)
  headers = normalized.headers
  const body = method === 'GET' || method === 'HEAD' ? undefined : normalized.body

  const timeoutms = Math.min(
    Math.max(Number(opts.timeout_ms) || defaulttimeoutms, 1000),
    maxtimeoutms
  )
  const maxchars = Math.min(
    Math.max(Number(opts.max_chars) || defaultmaxchars, 500),
    hardmaxchars
  )

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutms)

  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      redirect: 'follow',
      signal: controller.signal
    })

    if (res.url) parsepublichttpurl(res.url)

    const raw = await readresponsetext(res, maxbodybytes)
    let bodytext = raw.text
    let bodytruncated = raw.truncated || bodytext.length > maxchars
    if (bodytext.length > maxchars) {
      bodytext = `${bodytext.slice(0, maxchars)}\n...[truncated ${raw.text.length} chars total]`
    }

    let savedpath = null
    if (opts.save_to && opts.vaultdir) {
      savedpath = saveresponsefile(opts.vaultdir, opts.save_to, raw.text)
    }

    const responseheaders = {}
    for (const [key, value] of res.headers.entries()) {
      const lower = key.toLowerCase()
      if (lower === 'set-cookie') continue
      responseheaders[key] = value
    }

    log.agent('api_request', `${method} ${url}`, `status ${res.status}`)

    return {
      ok: res.ok,
      method,
      url: res.url || url,
      status: res.status,
      status_text: res.statusText || '',
      headers: responseheaders,
      body: bodytext,
      body_truncated: bodytruncated,
      body_bytes: raw.bytes,
      saved_to: savedpath,
      reply_hint: savedpath
        ? `response saved to ${savedpath}. summarize status ${res.status} for the user`
        : `use status and body. do not dump huge json unless asked`
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`request timed out after ${timeoutms}ms`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}
