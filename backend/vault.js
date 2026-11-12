import fs from 'node:fs'
import path from 'node:path'
import { parse, stringify } from 'yaml'
import { recordevent, recordhistory } from './history.js'

// ensure vault directory and media folder exist --------------------
export function initvault(vaultdir) {
  if (!fs.existsSync(vaultdir)) {
    fs.mkdirSync(vaultdir, { recursive: true })
  }
  const mediadir = path.join(vaultdir, 'media')
  if (!fs.existsSync(mediadir)) {
    fs.mkdirSync(mediadir, { recursive: true })
  }
  const pastesdir = path.join(mediadir, 'pastes')
  if (!fs.existsSync(pastesdir)) {
    fs.mkdirSync(pastesdir, { recursive: true })
  }
}

// resolve clean safe note file path supporting folders and extensions --------------------
export function getnotepath(vaultdir, noteid) {
  const parts = noteid.replace(/\\/g, '/').split('/').filter(Boolean)
  const cleanedparts = parts.map(p => p.replace(/[^a-zA-Z0-9_.\- ()]/g, '_'))
  const lastindex = cleanedparts.length - 1
  if (lastindex >= 0) {
    const hasextension = /\.[a-zA-Z0-9]+$/i.test(cleanedparts[lastindex])
    if (!hasextension) {
      cleanedparts[lastindex] = `${cleanedparts[lastindex]}.md`
    }
  }
  return path.join(vaultdir, ...cleanedparts)
}

// extract title from markdown heading or yaml or note id --------------------
export function extracttitle(content, fallback) {
  const match = content.match(/^#\s+(.+)$/m)
  if (match) {
    return match[1].trim()
  }
  const yamlmatch = content.match(/^name:\s*(.+)$/m)
  if (yamlmatch) {
    return yamlmatch[1].replace(/['"]/g, '').trim()
  }
  const jsonmatch = content.match(/"(?:title|name)":\s*"([^"]+)"/)
  if (jsonmatch) {
    return jsonmatch[1].trim()
  }
  return fallback
}

// supported text and image file extensions for vault --------------------
export const textfilepattern = /\.(md|markdown|txt|json|yaml|yml|csv|tsv|xml|html|css|js|ts|py|sh|log|toml|ini|conf|env)$/i
export const imagefilepattern = /\.(png|jpg|jpeg|gif|webp|svg|ico|bmp)$/i
export const supportedfilepattern = /\.(md|markdown|txt|json|yaml|yml|csv|tsv|xml|html|css|js|ts|py|sh|log|toml|ini|conf|env|png|jpg|jpeg|gif|webp|svg|ico|bmp)$/i

// tracking internal disk operations so watcher skips them --------------------
const recentinternalwrites = new Map()
const recentinternaldeletes = new Set()

export function markinternalwrite(filepath, content = null) {
  const norm = path.normalize(filepath).toLowerCase()
  recentinternalwrites.set(norm, { content, time: Date.now() })
  if (recentinternalwrites.size > 200) {
    const cutoff = Date.now() - 5000
    for (const [key, val] of recentinternalwrites.entries()) {
      if (val.time < cutoff) recentinternalwrites.delete(key)
    }
  }
}

export function isinternalwrite(filepath, content) {
  const norm = path.normalize(filepath).toLowerCase()
  const entry = recentinternalwrites.get(norm)
  if (!entry) return false
  if (Date.now() - entry.time > 4000) {
    recentinternalwrites.delete(norm)
    return false
  }
  if (entry.content === null || entry.content === content) {
    return true
  }
  return false
}

export function markinternaldelete(filepath) {
  const norm = path.normalize(filepath).toLowerCase()
  recentinternaldeletes.add(norm)
  setTimeout(() => recentinternaldeletes.delete(norm), 3000)
}

export function isinternaldelete(filepath) {
  const norm = path.normalize(filepath).toLowerCase()
  if (recentinternaldeletes.has(norm)) {
    recentinternaldeletes.delete(norm)
    return true
  }
  return false
}

// list all text files in vault recursively --------------------
export function listnotes(vaultdir) {
  initvault(vaultdir)
  const notes = []

  function walk(currentdir, relprefix = '') {
    const entries = fs.readdirSync(currentdir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue
      }
      const fullpath = path.join(currentdir, entry.name)
      if (entry.isDirectory()) {
        const nextprefix = relprefix ? `${relprefix}/${entry.name}` : entry.name
        walk(fullpath, nextprefix)
      } else if (supportedfilepattern.test(entry.name)) {
        const relid = relprefix
          ? `${relprefix}/${entry.name}`
          : entry.name
        const stats = fs.statSync(fullpath)
        const isimage = imagefilepattern.test(entry.name)
        let title = entry.name
        let snippet = '[image]'

        if (!isimage) {
          try {
            const content = fs.readFileSync(fullpath, 'utf8')
            title = extracttitle(content, relid)
            snippet = content.slice(0, 100).replace(/\n/g, ' ')
          } catch {}
        }

        notes.push({
          note_id: relid,
          title,
          updated_at: stats.mtime.toISOString(),
          created_at: stats.birthtime.toISOString(),
          size: stats.size,
          snippet,
          is_image: isimage
        })
      }
    }
  }

  walk(vaultdir)
  return notes.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
}

// list all directories in vault recursively --------------------
export function listfolders(vaultdir) {
  initvault(vaultdir)
  const folders = []

  function walk(currentdir, relprefix = '') {
    const entries = fs.readdirSync(currentdir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue
      }
      if (entry.isDirectory()) {
        const relid = relprefix
          ? `${relprefix}/${entry.name}`
          : entry.name
        folders.push(relid)
        const fullpath = path.join(currentdir, entry.name)
        walk(fullpath, relid)
      }
    }
  }

  walk(vaultdir)
  return folders.sort()
}

// read note by id --------------------
export function readnote(vaultdir, noteid) {
  initvault(vaultdir)
  const filepath = getnotepath(vaultdir, noteid)
  if (!fs.existsSync(filepath)) {
    return null
  }

  const stats = fs.statSync(filepath)
  const isimage = imagefilepattern.test(filepath)
  if (isimage) {
    return {
      note_id: noteid,
      title: path.basename(filepath),
      content: '',
      is_image: true,
      image_url: `/api/raw?id=${encodeURIComponent(noteid)}`,
      size: stats.size,
      updated_at: stats.mtime.toISOString(),
      created_at: stats.birthtime.toISOString()
    }
  }

  const content = fs.readFileSync(filepath, 'utf8')
  const title = extracttitle(content, noteid)

  return {
    note_id: noteid,
    title,
    content,
    is_image: false,
    updated_at: stats.mtime.toISOString(),
    created_at: stats.birthtime.toISOString()
  }
}

// write note to disk ensuring parent directories exist --------------------
export function writenote(vaultdir, noteid, content) {
  initvault(vaultdir)
  const filepath = getnotepath(vaultdir, noteid)
  const parentdir = path.dirname(filepath)
  if (!fs.existsSync(parentdir)) {
    fs.mkdirSync(parentdir, { recursive: true })
  }
  markinternalwrite(filepath, content)
  fs.writeFileSync(filepath, content, 'utf8')
}

// delete note from disk --------------------
export function deletenote(vaultdir, noteid, historydir = null, author = 'unknown') {
  initvault(vaultdir)
  const filepath = getnotepath(vaultdir, noteid)
  if (fs.existsSync(filepath)) {
    if (historydir) {
      try {
        const content = fs.readFileSync(filepath, 'utf8')
        recordevent(historydir, {
          file_id: noteid,
          event_type: 'delete',
          author,
          old_path: noteid,
          details: `deleted file (${content.length} chars)`
        })
      } catch {}
    }
    markinternaldelete(filepath)
    fs.unlinkSync(filepath)
    return true
  }
  return false
}

// move or rename note file or folder on disk --------------------
export function movenoteorfolder(vaultdir, historydir, source, destination, author = 'unknown') {
  initvault(vaultdir)
  const cleansrc = source.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const cleandest = destination.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')

  if (!cleansrc || !cleandest) {
    throw new Error('source and destination cannot be empty')
  }

  // check if source is an existing directory --------------------
  const srcfolderpath = path.join(vaultdir, ...cleansrc.split('/'))
  if (fs.existsSync(srcfolderpath) && fs.statSync(srcfolderpath).isDirectory()) {
    let resolveddest = cleandest
    const destcheckpath = path.join(vaultdir, ...cleandest.split('/'))
    if (fs.existsSync(destcheckpath) && fs.statSync(destcheckpath).isDirectory() && cleansrc !== cleandest) {
      resolveddest = `${cleandest}/${path.basename(srcfolderpath)}`
    }
    if (cleansrc !== resolveddest) {
      resolveddest = getuniqueconflictpath(vaultdir, resolveddest, true)
    }
    const destfolderpath = path.join(vaultdir, ...resolveddest.split('/'))
    const parentdir = path.dirname(destfolderpath)
    if (!fs.existsSync(parentdir)) {
      fs.mkdirSync(parentdir, { recursive: true })
    }
    markinternaldelete(srcfolderpath)
    markinternalwrite(destfolderpath)
    fs.renameSync(srcfolderpath, destfolderpath)

    // record move event and migrate history directory if exists --------------------
    if (historydir) {
      recordevent(historydir, {
        file_id: resolveddest,
        event_type: 'move_folder',
        author,
        old_path: cleansrc,
        new_path: resolveddest,
        details: `folder moved or renamed from ${cleansrc} to ${resolveddest}`
      })
      const srchistdir = path.join(historydir, ...cleansrc.split('/'))
      const desthistdir = path.join(historydir, ...resolveddest.split('/'))
      if (fs.existsSync(srchistdir)) {
        const histparent = path.dirname(desthistdir)
        if (!fs.existsSync(histparent)) {
          fs.mkdirSync(histparent, { recursive: true })
        }
        fs.renameSync(srchistdir, desthistdir)
      }
    }

    return {
      type: 'folder',
      source: cleansrc,
      destination: resolveddest,
      message: `renamed folder "${cleansrc}" to "${resolveddest}"`
    }
  }

  // check if source is a note file --------------------
  let srcpath = getnotepath(vaultdir, cleansrc)
  let resolvedsrc = cleansrc
  if (!fs.existsSync(srcpath)) {
    // try fuzzy match against vault notes --------------------
    const allnotes = listnotes(vaultdir)
    const found = allnotes.find(n => n.note_id.toLowerCase() === cleansrc.toLowerCase() || n.note_id.toLowerCase() === `${cleansrc.toLowerCase()}.md`)
    if (found) {
      resolvedsrc = found.note_id
      srcpath = getnotepath(vaultdir, resolvedsrc)
    }
  }

  if (!fs.existsSync(srcpath)) {
    throw new Error(`note or folder "${source}" not found`)
  }

  // resolve destination path --------------------
  const destdircheck = path.join(vaultdir, ...cleandest.split('/'))
  const isdestdir = (destination.endsWith('/') || (fs.existsSync(destdircheck) && fs.statSync(destdircheck).isDirectory()))

  let resolveddest = cleandest
  if (isdestdir) {
    const filename = path.basename(srcpath)
    resolveddest = `${cleandest}/${filename}`
  } else if (!/\.[a-zA-Z0-9]+$/i.test(resolveddest)) {
    resolveddest = `${resolveddest}.md`
  }

  // resolve conflict if destination already exists --------------------
  if (resolvedsrc !== resolveddest) {
    resolveddest = getuniqueconflictpath(vaultdir, resolveddest, false)
  }

  const destpath = getnotepath(vaultdir, resolveddest)
  const parentdir = path.dirname(destpath)
  if (!fs.existsSync(parentdir)) {
    fs.mkdirSync(parentdir, { recursive: true })
  }

  markinternaldelete(srcpath)
  markinternalwrite(destpath)
  fs.renameSync(srcpath, destpath)

  // record move event in sqlite history and move legacy directory if exists --------------------
  if (historydir) {
    recordevent(historydir, {
      file_id: resolveddest,
      event_type: 'move',
      author,
      old_path: resolvedsrc,
      new_path: resolveddest,
      details: `moved from ${resolvedsrc} to ${resolveddest}`
    })
    const srchistdir = path.join(historydir, ...resolvedsrc.split('/'))
    const desthistdir = path.join(historydir, ...resolveddest.split('/'))
    if (fs.existsSync(srchistdir)) {
      const histparent = path.dirname(desthistdir)
      if (!fs.existsSync(histparent)) {
        fs.mkdirSync(histparent, { recursive: true })
      }
      fs.renameSync(srchistdir, desthistdir)
    }
  }

  return {
    type: 'note',
    source: resolvedsrc,
    destination: resolveddest,
    message: `moved note "${resolvedsrc}" to "${resolveddest}"`
  }
}

// create empty folder in vault --------------------
export function createfolder(vaultdir, folderpath) {
  initvault(vaultdir)
  const cleanpath = folderpath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!cleanpath) {
    throw new Error('folder path cannot be empty')
  }
  const fullpath = path.join(vaultdir, ...cleanpath.split('/'))
  if (!fs.existsSync(fullpath)) {
    fs.mkdirSync(fullpath, { recursive: true })
  }
  return cleanpath
}

// delete folder and all its contents recursively --------------------
export function deletefolder(vaultdir, historydir, folderpath, author = 'unknown') {
  initvault(vaultdir)
  const cleanpath = folderpath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!cleanpath) {
    throw new Error('folder path cannot be empty')
  }
  const fullpath = path.join(vaultdir, ...cleanpath.split('/'))
  if (!fs.existsSync(fullpath) || !fs.statSync(fullpath).isDirectory()) {
    return false
  }

  if (historydir) {
    try {
      recordevent(historydir, {
        file_id: cleanpath,
        event_type: 'delete_folder',
        author,
        old_path: cleanpath,
        details: `deleted folder "${cleanpath}"`
      })
    } catch {}
  }

  markinternaldelete(fullpath)
  fs.rmSync(fullpath, { recursive: true, force: true })
  return true
}

// resolve collision by appending (2), (3), etc. until free path found --------------------
export function getuniqueconflictpath(vaultdir, targetid, isfolder = false) {
  const clean = targetid.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (isfolder) {
    let candidate = clean
    let fullpath = path.join(vaultdir, ...candidate.split('/'))
    if (!fs.existsSync(fullpath)) {
      return candidate
    }
    const parts = candidate.split('/')
    const foldername = parts.pop()
    const parent = parts.join('/')

    const match = foldername.match(/^(.*?)\s*\((\d+)\)$/)
    const base = match ? match[1] : foldername
    let num = match ? parseInt(match[2], 10) + 1 : 2

    while (true) {
      const nextname = `${base} (${num})`
      candidate = parent ? `${parent}/${nextname}` : nextname
      fullpath = path.join(vaultdir, ...candidate.split('/'))
      if (!fs.existsSync(fullpath)) {
        return candidate
      }
      num++
    }
  } else {
    let candidate = clean
    let fullpath = getnotepath(vaultdir, candidate)
    if (!fs.existsSync(fullpath)) {
      return candidate
    }
    const parts = candidate.split('/')
    const filename = parts.pop()
    const parent = parts.join('/')

    const extmatch = filename.match(/^(.+?)(\.[a-zA-Z0-9]+)$/)
    const namepart = extmatch ? extmatch[1] : filename
    const extpart = extmatch ? extmatch[2] : ''

    const nummatch = namepart.match(/^(.*?)\s*\((\d+)\)$/)
    const base = nummatch ? nummatch[1] : namepart
    let num = nummatch ? parseInt(nummatch[2], 10) + 1 : 2

    while (true) {
      const nextname = `${base} (${num})${extpart}`
      candidate = parent ? `${parent}/${nextname}` : nextname
      fullpath = getnotepath(vaultdir, candidate)
      if (!fs.existsSync(fullpath)) {
        return candidate
      }
      num++
    }
  }
}

// copy note or folder on disk --------------------
export function copynoteorfolder(vaultdir, historydir, source, destination, author = 'unknown') {
  initvault(vaultdir)
  const cleansrc = source.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const cleandest = destination.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')

  if (!cleansrc || !cleandest) {
    throw new Error('source and destination cannot be empty')
  }

  // check if source is an existing folder --------------------
  const srcfolderpath = path.join(vaultdir, ...cleansrc.split('/'))
  if (fs.existsSync(srcfolderpath) && fs.statSync(srcfolderpath).isDirectory()) {
    let destfolderpath = path.join(vaultdir, ...cleandest.split('/'))
    let targetname = cleandest

    // if target directory already exists copy inside it --------------------
    if (fs.existsSync(destfolderpath) && fs.statSync(destfolderpath).isDirectory() && cleansrc !== cleandest) {
      targetname = `${cleandest}/${path.basename(srcfolderpath)}`
    }

    targetname = getuniqueconflictpath(vaultdir, targetname, true)
    destfolderpath = path.join(vaultdir, ...targetname.split('/'))

    const parentdir = path.dirname(destfolderpath)
    if (!fs.existsSync(parentdir)) {
      fs.mkdirSync(parentdir, { recursive: true })
    }

    fs.cpSync(srcfolderpath, destfolderpath, { recursive: true })

    if (historydir) {
      recordevent(historydir, {
        file_id: targetname,
        event_type: 'copy_folder',
        author,
        old_path: cleansrc,
        new_path: targetname,
        details: `copied folder from ${cleansrc} to ${targetname}`
      })
    }

    return {
      type: 'folder',
      source: cleansrc,
      destination: targetname,
      message: `copied folder "${cleansrc}" to "${targetname}"`
    }
  }

  // resolve source note or file --------------------
  let srcpath = getnotepath(vaultdir, cleansrc)
  let resolvedsrc = cleansrc
  if (!fs.existsSync(srcpath)) {
    const allnotes = listnotes(vaultdir)
    const found = allnotes.find(n => n.note_id.toLowerCase() === cleansrc.toLowerCase() || n.note_id.toLowerCase() === `${cleansrc.toLowerCase()}.md`)
    if (found) {
      resolvedsrc = found.note_id
      srcpath = getnotepath(vaultdir, resolvedsrc)
    }
  }

  if (!fs.existsSync(srcpath)) {
    throw new Error(`note or folder "${source}" not found`)
  }

  // resolve destination path --------------------
  const destdircheck = path.join(vaultdir, ...cleandest.split('/'))
  const isdestdir = (destination.endsWith('/') || (fs.existsSync(destdircheck) && fs.statSync(destdircheck).isDirectory()))

  let resolveddest = cleandest
  if (isdestdir) {
    const filename = path.basename(srcpath)
    resolveddest = `${cleandest}/${filename}`
  } else if (!/\.[a-zA-Z0-9]+$/i.test(resolveddest)) {
    resolveddest = `${resolveddest}.md`
  }

  // if copying in same location or target exists ensure unique copy name --------------------
  resolveddest = getuniqueconflictpath(vaultdir, resolveddest, false)
  const destpath = getnotepath(vaultdir, resolveddest)

  const parentdir = path.dirname(destpath)
  if (!fs.existsSync(parentdir)) {
    fs.mkdirSync(parentdir, { recursive: true })
  }

  const content = fs.readFileSync(srcpath, 'utf8')
  markinternalwrite(destpath, content)
  fs.writeFileSync(destpath, content, 'utf8')

  if (historydir) {
    recordhistory(historydir, resolveddest, author, content)
    recordevent(historydir, {
      file_id: resolveddest,
      event_type: 'copy',
      author,
      old_path: resolvedsrc,
      new_path: resolveddest,
      details: `copied from ${resolvedsrc} to ${resolveddest}`
    })
  }

  return {
    type: 'file',
    source: resolvedsrc,
    destination: resolveddest,
    message: `copied "${resolvedsrc}" to "${resolveddest}"`
  }
}

// read user preferences helper --------------------
export function readuserpreferences(vaultdir, userid) {
  const prefspath = path.join(vaultdir, 'system', userid, 'preferences.yaml')
  if (!fs.existsSync(prefspath)) {
    return null
  }
  try {
    const raw = fs.readFileSync(prefspath, 'utf8')
    return parse(raw)
  } catch {
    return null
  }
}

// update user preferences helper --------------------
export function updateuserpreferences(vaultdir, userid, updates = {}) {
  const prefspath = path.join(vaultdir, 'system', userid, 'preferences.yaml')
  let existing = readuserpreferences(vaultdir, userid) || {}
  existing = { ...existing, ...updates }
  const yamlcontent = stringify(existing)
  markinternalwrite(prefspath, yamlcontent)
  fs.writeFileSync(prefspath, yamlcontent, 'utf8')
  return existing
}

// auto initialize system user notes from config --------------------
export function initsystemnotes(vaultdir, users = []) {
  initvault(vaultdir)
  const systemdir = path.join(vaultdir, 'system')
  if (!fs.existsSync(systemdir)) {
    fs.mkdirSync(systemdir, { recursive: true })
  }

  // clean up legacy flat note files if they exist --------------------
  for (const user of users) {
    const userid = user.username || user.id
    if (!userid) {
      continue
    }
    const legacynote = path.join(systemdir, `${userid}.md`)
    if (fs.existsSync(legacynote)) {
      fs.unlinkSync(legacynote)
    }

    const userfolder = path.join(systemdir, userid)
    if (!fs.existsSync(userfolder)) {
      fs.mkdirSync(userfolder, { recursive: true })
    }

    // create preferences yaml --------------------
    const prefspath = path.join(userfolder, 'preferences.yaml')
    if (!fs.existsSync(prefspath)) {
      const displayname = user.name || (userid.charAt(0).toUpperCase() + userid.slice(1))
      const isai = Boolean(user.bot || user.role === 'ai')
      const prefs = {
        name: displayname,
        'user-color': isai ? '#10b981' : '#3b82f6',
        'bg-color': '#000000',
        'text-color': '#ededed',
        'accent-color': '#ffffff',
        'reading-scale': 100
      }
      const yamlprefs = stringify(prefs)
      markinternalwrite(prefspath, yamlprefs)
      fs.writeFileSync(prefspath, yamlprefs, 'utf8')
    }

    // create personality markdown --------------------
    const personalitypath = path.join(userfolder, 'personality.md')
    if (!fs.existsSync(personalitypath)) {
      const isai = Boolean(user.bot || user.role === 'ai')
      const template = isai
        ? '# personality and behavior\n\n- minimal and concise\n- personal assistant for household notes and calendar\n'
        : '# personality and details\n\n## details\n- \n\n## preferences\n- \n'
      markinternalwrite(personalitypath, template)
      fs.writeFileSync(personalitypath, template, 'utf8')
    }
  }
}
