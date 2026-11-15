import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import sevenBin from '7zip-bin'
import { createExtractorFromFile } from 'node-unrar-js'
import { getuniqueconflictpath } from '../vault/vault.js'
import { log } from '../core/logger.js'

const archiveexts = new Set(['.zip', '.jar', '.7z', '.rar'])
const maxarchivesize = 200 * 1024 * 1024
const maxextractedbytes = 500 * 1024 * 1024
const maxextractedfiles = 5000

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

function run7za(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(sevenBin.path7za, args, { windowsHide: true })
    let stderr = ''
    let stdout = ''
    proc.stderr.on('data', (d) => { stderr += String(d) })
    proc.stdout.on('data', (d) => { stdout += String(d) })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error((stderr || stdout || `7za exited ${code}`).trim().slice(0, 400)))
    })
  })
}

function walkfiles(dirabs) {
  const out = []
  if (!fs.existsSync(dirabs)) return out
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
      if (ent.isDirectory()) stack.push(full)
      else if (ent.isFile()) out.push(full)
    }
  }
  return out
}

function auditextracted(destabs) {
  const files = walkfiles(destabs)
  if (files.length > maxextractedfiles) {
    throw new Error(`extraction produced too many files (${files.length}, max ${maxextractedfiles})`)
  }
  let total = 0
  for (const file of files) {
    if (!isinsidedir(destabs, file)) {
      throw new Error('extraction tried to write outside the destination folder')
    }
    try {
      total += fs.statSync(file).size
    } catch {}
    if (total > maxextractedbytes) {
      throw new Error(`extraction exceeded size limit (${Math.round(maxextractedbytes / (1024 * 1024))}mb)`)
    }
  }
  return { filecount: files.length, bytes: total }
}

function listtoplevel(destabs, limit = 12) {
  if (!fs.existsSync(destabs)) return []
  const names = fs.readdirSync(destabs)
  return names.slice(0, limit)
}

async function extractwith7za(archiveabs, destabs) {
  fs.mkdirSync(destabs, { recursive: true })
  // -o must stick to the path with no space --------------------
  await run7za(['x', archiveabs, `-o${destabs}`, '-y', '-bso0', '-bsp0'])
}

async function extractwithunrar(archiveabs, destabs) {
  fs.mkdirSync(destabs, { recursive: true })
  const extractor = await createExtractorFromFile({
    filepath: archiveabs,
    targetPath: destabs,
    filenameTransform: (filename) => {
      const cleaned = String(filename || '').replace(/\\/g, '/')
      if (!cleaned || cleaned.includes('..') || path.isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) {
        throw new Error(`blocked unsafe archive path: ${filename}`)
      }
      return cleaned
    }
  })
  const list = extractor.getFileList()
  const headers = [...list.fileHeaders]
  if (headers.length > maxextractedfiles) {
    throw new Error(`archive lists too many files (${headers.length}, max ${maxextractedfiles})`)
  }
  let listedbytes = 0
  for (const h of headers) {
    listedbytes += Number(h.unpSize) || 0
    if (listedbytes > maxextractedbytes) {
      throw new Error(`archive uncompressed size exceeds limit (${Math.round(maxextractedbytes / (1024 * 1024))}mb)`)
    }
  }
  // must consume the generator or nothing is written --------------------
  const extracted = extractor.extract()
  // eslint-disable-next-line no-unused-vars
  for (const _ of extracted.files) { /* drain */ }
}

// extract a vault archive into a sibling folder named after the archive --------------------
export async function extractarchive(vaultdir, archivepath) {
  const clean = cleanvaultrel(archivepath)
  if (!clean) throw new Error('path is required')

  const ext = path.extname(clean).toLowerCase()
  if (!archiveexts.has(ext)) {
    throw new Error(`unsupported archive type "${ext || '(none)'}". use .zip, .jar, .7z, or .rar`)
  }

  const archiveabs = path.resolve(path.join(vaultdir, ...clean.split('/')))
  if (!isinsidedir(vaultdir, archiveabs)) {
    throw new Error('archive path must stay inside the vault')
  }
  if (!fs.existsSync(archiveabs) || !fs.statSync(archiveabs).isFile()) {
    throw new Error(`archive not found: ${clean}`)
  }

  const archivesize = fs.statSync(archiveabs).size
  if (archivesize > maxarchivesize) {
    throw new Error(`archive too large (${Math.round(archivesize / (1024 * 1024))}mb, max ${Math.round(maxarchivesize / (1024 * 1024))}mb)`)
  }

  const parentrel = clean.includes('/') ? clean.split('/').slice(0, -1).join('/') : ''
  const basename = path.basename(clean, ext)
  const destwanted = parentrel ? `${parentrel}/${basename}` : basename
  const destrel = getuniqueconflictpath(vaultdir, destwanted, true)
  const destabs = path.resolve(path.join(vaultdir, ...destrel.split('/')))

  if (!isinsidedir(vaultdir, destabs)) {
    throw new Error('destination must stay inside the vault')
  }

  try {
    if (ext === '.rar') {
      await extractwithunrar(archiveabs, destabs)
    } else {
      await extractwith7za(archiveabs, destabs)
    }
    const stats = auditextracted(destabs)
    const top = listtoplevel(destabs)
    log.agent('archive', clean, `--> ${destrel} (${stats.filecount} files)`)
    return {
      archive: clean,
      destination: destrel,
      file_count: stats.filecount,
      bytes: stats.bytes,
      top_level: top,
    }
  } catch (err) {
    // wipe a failed partial extract so the vault stays clean --------------------
    try {
      if (fs.existsSync(destabs)) fs.rmSync(destabs, { recursive: true, force: true })
    } catch {}
    throw err
  }
}

export function isarchivepath(filepath) {
  const ext = path.extname(String(filepath || '')).toLowerCase()
  return archiveexts.has(ext)
}
