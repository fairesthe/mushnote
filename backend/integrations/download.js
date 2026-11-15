import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { getuniqueconflictpath, markinternalwrite } from '../vault/vault.js'
import { log } from '../core/logger.js'

const maxdownloadbytes = 200 * 1024 * 1024
const downloadtimeoutms = 120000
const clonetimeoutms = 180000
const githosts = new Set([
  'github.com',
  'www.github.com',
  'gitlab.com',
  'www.gitlab.com',
  'bitbucket.org',
  'www.bitbucket.org',
  'codeberg.org',
  'www.codeberg.org',
  'git.sr.ht'
])

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

function parsehttpurl(raw) {
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
    throw new Error('refusing to download from private or local hosts')
  }
  return parsed
}

function lookslikegiturl(raw) {
  let parsed
  try {
    parsed = parsehttpurl(raw)
  } catch {
    return false
  }
  const host = parsed.hostname.toLowerCase()
  const pathname = parsed.pathname.replace(/\/+$/, '')
  if (pathname.endsWith('.git')) return true
  if (githosts.has(host) || [...githosts].some((h) => host.endsWith(`.${h.replace(/^www\./, '')}`))) {
    const parts = pathname.split('/').filter(Boolean)
    // owner/repo or ~user/repo style --------------------
    if (parts.length >= 2) return true
  }
  return false
}

function reponamefromurl(raw) {
  const parsed = parsehttpurl(raw)
  const parts = parsed.pathname.replace(/\/+$/, '').split('/').filter(Boolean)
  let name = parts[parts.length - 1] || 'repo'
  if (name.endsWith('.git')) name = name.slice(0, -4)
  name = name.replace(/[<>:"|?*\x00-\x1f]/g, '_').trim() || 'repo'
  return name
}

function filenamefromurl(raw) {
  const parsed = parsehttpurl(raw)
  const last = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '')
  const cleaned = last.replace(/[<>:"|?*\x00-\x1f]/g, '_').trim()
  if (cleaned && cleaned !== '.' && cleaned !== '..') return cleaned
  return 'download.bin'
}

function filenamefromcontentdisposition(header) {
  if (!header) return ''
  const star = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^["']|["']$/g, ''))
    } catch {
      return star[1].trim().replace(/^["']|["']$/g, '')
    }
  }
  const plain = header.match(/filename\s*=\s*("?)([^";]+)\1/i)
  if (plain?.[2]) return plain[2].trim()
  return ''
}

function destinationlookslikefolder(destrel, vaultdir) {
  if (!destrel) return true
  if (String(destrel).endsWith('/')) return true
  const abs = path.join(vaultdir, ...destrel.split('/'))
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return true
  const base = path.basename(destrel)
  // no extension usually means folder for agent destinations --------------------
  if (!path.extname(base)) return true
  return false
}

function resolvefiledestination(vaultdir, destraw, preferredname) {
  let dest = cleanvaultrel(destraw)
  if (!dest) dest = 'media/downloads'

  if (destinationlookslikefolder(dest, vaultdir)) {
    dest = cleanvaultrel(dest)
    const name = preferredname || 'download.bin'
    dest = dest ? `${dest}/${name}` : name
  }

  dest = getuniqueconflictpath(vaultdir, dest, false)
  const abs = path.resolve(path.join(vaultdir, ...dest.split('/')))
  if (!isinsidedir(vaultdir, abs)) {
    throw new Error('destination must stay inside the vault')
  }
  return { rel: dest, abs }
}

function resolveclonedeestination(vaultdir, destraw, reponame) {
  let dest = cleanvaultrel(destraw)
  if (!dest) dest = reponame
  else if (destinationlookslikefolder(dest, vaultdir) && path.basename(dest) !== reponame) {
    // if they gave a parent folder, nest the repo name --------------------
    const abs = path.join(vaultdir, ...dest.split('/'))
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      const nested = `${dest}/${reponame}`
      if (!fs.existsSync(path.join(vaultdir, ...nested.split('/')))) {
        dest = nested
      }
    }
  }

  dest = getuniqueconflictpath(vaultdir, dest, true)
  const abs = path.resolve(path.join(vaultdir, ...dest.split('/')))
  if (!isinsidedir(vaultdir, abs)) {
    throw new Error('destination must stay inside the vault')
  }
  if (fs.existsSync(abs)) {
    throw new Error(`destination already exists: ${dest}`)
  }
  return { rel: dest, abs }
}

async function fetchtofile(url, destabs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), downloadtimeoutms)
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'mushnote-download/1.0'
      }
    })
    if (!res.ok) {
      throw new Error(`download failed with http ${res.status}`)
    }

    // re-check final url after redirects --------------------
    if (res.url) parsehttpurl(res.url)

    const declared = Number(res.headers.get('content-length') || 0)
    if (declared > maxdownloadbytes) {
      throw new Error(`file too large (${Math.round(declared / (1024 * 1024))}mb, max ${Math.round(maxdownloadbytes / (1024 * 1024))}mb)`)
    }

    const namehint = filenamefromcontentdisposition(res.headers.get('content-disposition'))
    fs.mkdirSync(path.dirname(destabs), { recursive: true })
    markinternalwrite(destabs)

    const body = res.body
    if (!body) throw new Error('empty response body')

    const file = fs.createWriteStream(destabs)
    const reader = body.getReader()
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > maxdownloadbytes) {
          throw new Error(`file too large (max ${Math.round(maxdownloadbytes / (1024 * 1024))}mb)`)
        }
        if (!file.write(Buffer.from(value))) {
          await new Promise((resolve) => file.once('drain', resolve))
        }
      }
      await new Promise((resolve, reject) => {
        file.end(() => resolve())
        file.on('error', reject)
      })
    } catch (err) {
      try { file.destroy() } catch {}
      try { if (fs.existsSync(destabs)) fs.unlinkSync(destabs) } catch {}
      throw err
    }

    return {
      bytes: total,
      content_type: res.headers.get('content-type') || '',
      final_url: res.url || url,
      name_hint: namehint
    }
  } finally {
    clearTimeout(timer)
  }
}

function rungitclone(url, destabs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'git',
      ['clone', '--depth', '1', '--single-branch', url, destabs],
      {
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: 'echo',
          // block credential helpers prompting --------------------
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'credential.helper',
          GIT_CONFIG_VALUE_0: ''
        }
      }
    )
    let stderr = ''
    let stdout = ''
    const timer = setTimeout(() => {
      try { proc.kill() } catch {}
      reject(new Error('git clone timed out'))
    }, clonetimeoutms)

    proc.stderr.on('data', (d) => { stderr += String(d) })
    proc.stdout.on('data', (d) => { stdout += String(d) })
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else {
        const msg = (stderr || stdout || `git clone exited ${code}`).trim().slice(0, 400)
        reject(new Error(msg.includes('Authentication') || msg.includes('not found')
          ? 'git clone failed (repo missing, private, or not public)'
          : msg))
      }
    })
  })
}

function countfiles(dirabs) {
  let count = 0
  const stack = [dirabs]
  while (stack.length) {
    const cur = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name)
      if (ent.isDirectory()) {
        if (ent.name === '.git') continue
        stack.push(full)
      } else if (ent.isFile()) {
        count++
      }
    }
  }
  return count
}

// download a normal https file into the vault --------------------
export async function downloadurltofile(vaultdir, url, destination = '') {
  parsehttpurl(url)
  const folderish = !cleanvaultrel(destination) || destinationlookslikefolder(cleanvaultrel(destination), vaultdir)
  const preferred = filenamefromurl(url)
  let dest = resolvefiledestination(vaultdir, destination, preferred)

  const meta = await fetchtofile(url, dest.abs)

  // prefer server filename when the agent only named a folder --------------------
  if (folderish && meta.name_hint) {
    const cleanedhint = cleanvaultrel(meta.name_hint).split('/').pop()
    if (cleanedhint && cleanedhint !== path.basename(dest.rel)) {
      const parent = dest.rel.includes('/') ? dest.rel.split('/').slice(0, -1).join('/') : ''
      const altwanted = parent ? `${parent}/${cleanedhint}` : cleanedhint
      const altrel = getuniqueconflictpath(vaultdir, altwanted, false)
      const altabs = path.resolve(path.join(vaultdir, ...altrel.split('/')))
      if (isinsidedir(vaultdir, altabs) && altrel !== dest.rel) {
        try {
          fs.renameSync(dest.abs, altabs)
          dest = { rel: altrel, abs: altabs }
        } catch {}
      }
    }
  }

  markinternalwrite(dest.abs)
  log.agent('download', url, `--> ${dest.rel} (${meta.bytes} bytes)`)
  return {
    kind: 'file',
    url: meta.final_url || url,
    path: dest.rel,
    bytes: meta.bytes,
    content_type: meta.content_type
  }
}

// shallow clone a public git repo into the vault --------------------
export async function clonegitrepotovault(vaultdir, url, destination = '') {
  parsehttpurl(url)
  const reponame = reponamefromurl(url)
  const dest = resolveclonedeestination(vaultdir, destination, reponame)

  markinternalwrite(dest.abs)
  try {
    await rungitclone(url, dest.abs)
  } catch (err) {
    try {
      if (fs.existsSync(dest.abs)) fs.rmSync(dest.abs, { recursive: true, force: true })
    } catch {}
    throw err
  }

  const filecount = countfiles(dest.abs)
  log.agent('git_clone', url, `--> ${dest.rel} (${filecount} files)`)
  return {
    kind: 'git',
    url,
    path: dest.rel,
    repo_name: reponame,
    file_count: filecount
  }
}

export async function downloadorclone(vaultdir, url, destination = '', mode = 'auto') {
  const normalized = String(mode || 'auto').toLowerCase()
  const wantgit = normalized === 'git' || normalized === 'clone' || (normalized === 'auto' && lookslikegiturl(url))
  if (wantgit) {
    return clonegitrepotovault(vaultdir, url, destination)
  }
  return downloadurltofile(vaultdir, url, destination)
}

export function islikelygiturl(url) {
  return lookslikegiturl(url)
}
