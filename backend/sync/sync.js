import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror'
import { Fragment } from '@tiptap/pm/model'
import { readnote, writenote, imagefilepattern, audiofilepattern, videofilepattern } from '../vault/vault.js'
import { recordhistory, recordevent, getrevisionbyid, getlatestrevision } from '../vault/history.js'
import { markdowntodoc, doctomarkdown, noteschema } from './markdown.js'

// wire protocol --------------------
// binary 0 is the standard y-protocols sync message
// binary 10 is a server to client update tagged with who made it so clients can flash it
// json hello and join make sure a client never merges a doc from an older server lineage
const messagesync = 0
const messageauthoredupdate = 10
const stateversion = 2
const savedelay = 500

// active documents and sockets in memory --------------------
const docmap = new Map()
const clientmap = new Map()

// one in-memory doc per vault file (todo and todo.md same key) --------------------
export function resolvenoteidkey(noteid) {
  const norm = String(noteid || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!norm) return norm
  const parts = norm.split('/').filter(Boolean)
  const lasti = parts.length - 1
  if (lasti >= 0 && !/\.[a-zA-Z0-9]+$/.test(parts[lasti])) {
    parts[lasti] = `${parts[lasti]}.md`
  }
  return parts.join('/')
}

function cleanid(noteid) {
  return String(noteid || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

function finddocentry(noteid) {
  const key = resolvenoteidkey(noteid)
  if (docmap.has(key)) return { key, entry: docmap.get(key) }
  const norm = cleanid(noteid)
  if (norm && docmap.has(norm)) return { key: norm, entry: docmap.get(norm) }
  return null
}

// markdown notes sync as rich text, everything else as plain text --------------------
function notekind(noteid) {
  const filename = (cleanid(noteid).split('/').pop() || '').toLowerCase()
  if (imagefilepattern.test(filename) || audiofilepattern.test(filename) || videofilepattern.test(filename)) return 'media'
  if (filename.startsWith('.')) return 'text'
  const dotidx = filename.lastIndexOf('.')
  if (dotidx <= 0) return 'rich'
  const ext = filename.slice(dotidx + 1)
  return ext === 'md' || ext === 'markdown' ? 'rich' : 'text'
}

function authorfromorigin(origin) {
  if (!origin) return 'system'
  if (typeof origin === 'string') return origin
  if (typeof origin === 'object') {
    if (origin._mushauthor) return origin._mushauthor
    if (origin.author) return origin.author
  }
  return 'user'
}

// persisted yjs state so reconnecting clients merge instead of duplicating --------------------
function yjsstatepath(historydir, noteid) {
  const safe = resolvenoteidkey(noteid).replace(/[^a-zA-Z0-9._-]+/g, '_')
  return path.join(historydir, 'ystate', `${safe}.bin`)
}

function writeyjsstate(historydir, noteid, doc) {
  try {
    const binpath = yjsstatepath(historydir, noteid)
    fs.mkdirSync(path.dirname(binpath), { recursive: true })
    fs.writeFileSync(binpath, Buffer.from(Y.encodeStateAsUpdate(doc)))
  } catch {}
}

function removeyjsstate(historydir, noteid) {
  try { fs.unlinkSync(yjsstatepath(historydir, noteid)) } catch {}
}

function moveyjsstate(historydir, oldid, newid) {
  try {
    const from = yjsstatepath(historydir, oldid)
    if (!fs.existsSync(from)) return
    fs.renameSync(from, yjsstatepath(historydir, newid))
  } catch {}
}

// only trust state files written by this sync version --------------------
function readyjsstate(historydir, noteid, doc) {
  try {
    const binpath = yjsstatepath(historydir, noteid)
    if (!fs.existsSync(binpath)) return false
    Y.applyUpdate(doc, fs.readFileSync(binpath), 'system')
    const meta = doc.getMap('mush')
    return meta.get('version') === stateversion && typeof meta.get('epoch') === 'string'
  } catch {
    return false
  }
}

function keepdiskwrite(prev, next) {
  const oldlen = String(prev || '').trim().length
  const newlen = String(next || '').trim().length
  if (oldlen > 80 && newlen === 0) return false
  if (oldlen > 400 && newlen < 40) return false
  return true
}

// shared content helpers per note kind --------------------
function readcontent(doc, kind) {
  if (kind === 'rich') {
    const root = yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment('prosemirror'), noteschema)
    return doctomarkdown(root)
  }
  if (kind === 'text') return doc.getText('content').toString()
  return ''
}

// editors keep an empty paragraph at the bottom that markdown cant hold --------------------
// dropping it on every server write made the client put it back and get blamed for +2 chars
function trailingemptycount(nodes) {
  let count = 0
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (!nodes[i].isempty) break
    count++
  }
  return count
}

function keeptrailingempties(fragment, pmdoc) {
  const ynodes = fragment.toArray().map(node => ({ isempty: node instanceof Y.XmlElement && node.nodeName === 'paragraph' && node.length === 0 }))
  const pmnodes = []
  pmdoc.content.forEach(node => pmnodes.push({ isempty: node.type.name === 'paragraph' && node.content.size === 0 }))
  const missing = trailingemptycount(ynodes) - trailingemptycount(pmnodes)
  if (missing <= 0) return pmdoc
  const paragraph = pmdoc.type.schema.nodes.paragraph
  const extra = Array.from({ length: missing }, () => paragraph.create())
  return pmdoc.type.create(pmdoc.attrs, pmdoc.content.append(Fragment.from(extra)))
}

// structural diff keeps untouched blocks and their yjs history intact --------------------
function writecontent(doc, kind, next, origin) {
  if (kind === 'rich') {
    const fragment = doc.getXmlFragment('prosemirror')
    const pmdoc = keeptrailingempties(fragment, markdowntodoc(next))
    doc.transact(() => {
      updateYFragment(doc, fragment, pmdoc, { mapping: new Map(), isOMark: new Map() })
    }, origin)
    return
  }
  if (kind !== 'text') return
  const ytext = doc.getText('content')
  const cur = ytext.toString()
  if (cur === next) return
  let prefix = 0
  while (prefix < cur.length && prefix < next.length && cur[prefix] === next[prefix]) prefix++
  let curend = cur.length
  let nextend = next.length
  while (curend > prefix && nextend > prefix && cur[curend - 1] === next[nextend - 1]) {
    curend--
    nextend--
  }
  doc.transact(() => {
    if (curend > prefix) ytext.delete(prefix, curend - prefix)
    if (nextend > prefix) ytext.insert(prefix, next.slice(prefix, nextend))
  }, origin)
}

function broadcastjson(noteid, payload, except = null) {
  const clients = clientmap.get(noteid)
  if (!clients) return
  const msg = JSON.stringify(payload)
  for (const client of clients) {
    if (client !== except && client.readyState === 1) client.send(msg)
  }
}

// get or create live yjs document bound to vault and history --------------------
export function getdoc(vaultdir, historydir, noteid) {
  const found = finddocentry(noteid)
  if (found) return found.entry

  const storagekey = resolvenoteidkey(noteid)
  const kind = notekind(storagekey)
  let currentnoteid = storagekey
  let lastauthor = 'system'
  let savetimer = null
  let cached = null
  let dead = false

  let doc = new Y.Doc()
  const disknote = readnote(vaultdir, storagekey)
  const disk = disknote?.content || ''
  // a state file for a note that no longer exists on disk is stale --------------------
  const restored = kind !== 'media' && Boolean(disknote) && readyjsstate(historydir, storagekey, doc)

  if (!restored) {
    // fresh lineage, any client holding an older doc must reset instead of merging --------------------
    doc.destroy()
    doc = new Y.Doc()
    doc.transact(() => {
      const meta = doc.getMap('mush')
      meta.set('version', stateversion)
      meta.set('epoch', crypto.randomUUID())
      meta.set('kind', kind)
    }, 'system')
    if (disk) writecontent(doc, kind, disk, 'system')
    writeyjsstate(historydir, storagekey, doc)
  } else if (readcontent(doc, kind) !== disk) {
    // file changed while the server was off, fold it in without breaking lineage --------------------
    writecontent(doc, kind, disk, 'external')
    writeyjsstate(historydir, storagekey, doc)
  }

  const epoch = doc.getMap('mush').get('epoch')

  function savenow() {
    if (savetimer) {
      clearTimeout(savetimer)
      savetimer = null
    }
    if (kind === 'media' || dead) return
    const content = entry.getcontent()
    const disknote = readnote(vaultdir, currentnoteid)
    const exists = Boolean(disknote)
    const prev = exists ? disknote.content : null
    writeyjsstate(historydir, currentnoteid, doc)
    if (exists && content === prev) return
    if (exists && !keepdiskwrite(prev, content)) return
    writenote(vaultdir, currentnoteid, content)
    recordhistory(historydir, currentnoteid, lastauthor, content)
  }

  function schedulesave() {
    if (savetimer) clearTimeout(savetimer)
    savetimer = setTimeout(savenow, savedelay)
  }

  // relay every change to the other sockets on this note with its author --------------------
  doc.on('update', (update, origin) => {
    cached = null
    const author = authorfromorigin(origin)
    if (author !== 'system' && author !== 'external') lastauthor = author
    const clients = clientmap.get(currentnoteid)
    if (clients && clients.size > 0) {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageauthoredupdate)
      encoding.writeVarString(encoder, author)
      encoding.writeVarUint8Array(encoder, update)
      const message = encoding.toUint8Array(encoder)
      for (const client of clients) {
        if (client === origin || client.readyState !== 1 || !client._mushjoined) continue
        client.send(message)
      }
      broadcastjson(currentnoteid, {
        type: 'edit_event',
        note_id: currentnoteid,
        author,
        edit_id: (origin && typeof origin === 'object' && origin.edit_id) || null
      }, origin)
    }
    // external edits already live on disk, only the yjs state needs saving --------------------
    if (author === 'external') {
      writeyjsstate(historydir, currentnoteid, doc)
      return
    }
    schedulesave()
  })

  const entry = {
    get note_id() {
      return currentnoteid
    },
    set note_id(val) {
      currentnoteid = val
    },
    doc,
    kind,
    epoch,
    getcontent: () => {
      if (cached === null) cached = readcontent(doc, kind)
      return cached
    },
    setcontent: (next, origin = 'system') => {
      writecontent(doc, kind, String(next ?? ''), origin)
    },
    // markdown offsets for rich notes, exact text offsets for code files --------------------
    insertat: (pos, text, origin = 'system') => {
      if (!text) return
      if (kind === 'text') {
        const ytext = doc.getText('content')
        const at = Math.max(0, Math.min(pos, ytext.length))
        doc.transact(() => ytext.insert(at, text), origin)
        return
      }
      const cur = entry.getcontent()
      const at = Math.max(0, Math.min(pos, cur.length))
      writecontent(doc, kind, `${cur.slice(0, at)}${text}${cur.slice(at)}`, origin)
    },
    cancelsave: () => {
      if (savetimer) {
        clearTimeout(savetimer)
        savetimer = null
      }
    },
    flushtodisk: (author) => {
      if (author) lastauthor = author
      savenow()
    },
    movestate: (newid) => {
      moveyjsstate(historydir, currentnoteid, newid)
    },
    // deleted notes must never save again or they come back from the dead --------------------
    kill: () => {
      dead = true
      entry.cancelsave()
    }
  }

  docmap.set(storagekey, entry)
  return entry
}

// migrate in memory docs and connected clients when note or folder moves --------------------
function migrateone(oldkey, newkey) {
  const entry = docmap.get(oldkey)
  if (entry) {
    entry.cancelsave()
    entry.movestate(newkey)
    docmap.delete(oldkey)
    entry.note_id = newkey
    docmap.set(newkey, entry)
  }
  const clients = clientmap.get(oldkey)
  if (clients) {
    clientmap.delete(oldkey)
    clientmap.set(newkey, clients)
    broadcastjson(newkey, {
      type: 'note_renamed',
      old_note_id: oldkey,
      new_note_id: newkey
    })
  }
}

export function migratedocentry(oldid, newid, isfolder = false) {
  const cleanold = cleanid(oldid)
  const cleannew = cleanid(newid)

  if (isfolder) {
    const oldprefix = `${cleanold}/`
    const newprefix = `${cleannew}/`
    const keys = new Set([...docmap.keys(), ...clientmap.keys()])
    for (const key of keys) {
      if (key.startsWith(oldprefix)) migrateone(key, `${newprefix}${key.slice(oldprefix.length)}`)
    }
    return
  }

  const oldkey = resolvenoteidkey(cleanold)
  const newkey = resolvenoteidkey(cleannew)
  for (const key of [oldkey, cleanold]) {
    if (docmap.has(key) || clientmap.has(key)) {
      migrateone(key, newkey)
      break
    }
  }
}

// check if document is currently loaded in memory --------------------
export function getdocifloaded(noteid) {
  const found = finddocentry(noteid)
  return found ? found.entry : null
}

// apply external filesystem change into live yjs memory and sqlite history --------------------
export function applyexternalchange(vaultdir, historydir, noteid, newcontent) {
  const found = finddocentry(noteid)
  if (!found) {
    // file is not open so compare against the last saved revision
    // windows fires watch events on read and access so identical content must be a no-op
    const latest = getlatestrevision(historydir, noteid)
    if (latest && latest.content === newcontent) return false
    recordhistory(historydir, noteid, 'external', newcontent)
    return true
  }
  const { key, entry } = found
  if (entry.getcontent() === newcontent) return false
  entry.cancelsave()
  entry.setcontent(newcontent, 'external')
  recordhistory(historydir, key, 'external', newcontent)
  return true
}

// stop live collab from resurrecting a note we just deleted --------------------
export function evictnotedoc(historydir, noteid) {
  const found = finddocentry(noteid)
  if (found) {
    found.entry.kill()
    docmap.delete(found.key)
    const clients = clientmap.get(found.key)
    if (clients) {
      clientmap.delete(found.key)
      for (const client of clients) {
        try { client.close(4000, 'note deleted') } catch {}
      }
    }
  }
  removeyjsstate(historydir, noteid)
}

// drop every live doc under a folder path after the folder is wiped --------------------
export function evictfolderdocs(historydir, folderpath) {
  const prefix = `${cleanid(folderpath)}/`
  const keys = [...docmap.keys()].filter((key) => key === cleanid(folderpath) || key.startsWith(prefix))
  for (const key of keys) {
    evictnotedoc(historydir, key)
  }
}

// handle file deleted on disk externally --------------------
export function handleexternaldelete(vaultdir, historydir, noteid) {
  evictnotedoc(historydir, noteid)
  recordevent(historydir, {
    file_id: noteid,
    event_type: 'delete',
    author: 'external',
    old_path: noteid,
    details: 'file deleted on disk externally'
  })
}

// convert literal escaped newlines and tabs from json function arguments --------------------
export function unliteralescapes(str) {
  if (typeof str !== 'string') return str
  if (!str.includes('\\')) return str
  return str
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\t/g, '\t')
}

// find character bounds of target text with resilient matching fallbacks --------------------
function findtargetbounds(current, target) {
  if (!target) return null
  const cleantargetraw = unliteralescapes(target)

  // exact match --------------------
  const exactidx = current.indexOf(cleantargetraw)
  if (exactidx !== -1) {
    return { from: exactidx, to: exactidx + cleantargetraw.length }
  }

  // normalize crlf to lf --------------------
  const normalizedcurrent = current.replace(/\r\n/g, '\n')
  const normalizedtarget = cleantargetraw.replace(/\r\n/g, '\n')
  const normidx = normalizedcurrent.indexOf(normalizedtarget)
  if (normidx !== -1) {
    return mapnormalizedindices(current, normidx, normalizedtarget.length)
  }

  // normalize smart quotes and typography --------------------
  function cleanquotes(str) {
    return str
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/\u00A0/g, ' ')
  }

  const cleancurrent = cleanquotes(normalizedcurrent)
  const cleantarget = cleanquotes(normalizedtarget)
  const cleanidx = cleancurrent.indexOf(cleantarget)
  if (cleanidx !== -1) {
    return mapnormalizedindices(current, cleanidx, normalizedtarget.length)
  }

  // trimmed lines fallback for multi line block matching --------------------
  const targetlines = normalizedtarget.split('\n').map(l => l.trimEnd())
  const currentlines = normalizedcurrent.split('\n').map(l => l.trimEnd())
  if (targetlines.length > 0 && targetlines[0]) {
    for (let i = 0; i <= currentlines.length - targetlines.length; i++) {
      let match = true
      for (let j = 0; j < targetlines.length; j++) {
        if (currentlines[i + j].trim() !== targetlines[j].trim()) {
          match = false
          break
        }
      }
      if (match) {
        const rawlines = normalizedcurrent.split('\n')
        let startchar = 0
        for (let k = 0; k < i; k++) {
          startchar += rawlines[k].length + 1
        }
        let endchar = startchar
        for (let k = 0; k < targetlines.length; k++) {
          endchar += rawlines[i + k].length + (k < targetlines.length - 1 ? 1 : 0)
        }
        return mapnormalizedindices(current, startchar, endchar - startchar)
      }
    }
  }

  // single line trimmed fallback --------------------
  const trimmedtarget = normalizedtarget.trim()
  if (trimmedtarget.length > 2) {
    const rawlines = normalizedcurrent.split('\n')
    let charcount = 0
    for (const rawline of rawlines) {
      if (rawline.trim() === trimmedtarget || rawline.includes(trimmedtarget)) {
        const lineidx = rawline.indexOf(trimmedtarget)
        const matchstart = charcount + (lineidx !== -1 ? lineidx : 0)
        const matchlen = lineidx !== -1 ? trimmedtarget.length : rawline.length
        return mapnormalizedindices(current, matchstart, matchlen)
      }
      charcount += rawline.length + 1
    }
  }

  return null
}

// map character offsets from normalized string back to raw text with crlf --------------------
function mapnormalizedindices(original, normstart, normlength) {
  let origidx = 0
  let normidx = 0

  while (origidx < original.length && normidx < normstart) {
    if (original[origidx] === '\r' && original[origidx + 1] === '\n') {
      origidx += 2
    } else {
      origidx += 1
    }
    normidx += 1
  }
  const from = origidx

  let count = 0
  while (origidx < original.length && count < normlength) {
    if (original[origidx] === '\r' && original[origidx + 1] === '\n') {
      origidx += 2
    } else {
      origidx += 1
    }
    count += 1
  }
  const to = origidx

  return { from, to }
}

// split streamed text so rich notes only ever see whole lines and whole fenced blocks --------------------
function streamchunks(text, kind) {
  if (kind === 'rich') {
    const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [text]
    const chunks = []
    let fence = null
    let pending = ''
    for (const line of lines) {
      pending += line
      const trimmed = line.trim()
      const opener = trimmed.match(/^(```+|~~~+|\$\$)/)
      if (fence) {
        if (trimmed.startsWith(fence)) fence = null
      } else if (opener && !(opener[1] === '$$' && trimmed.length > 2 && trimmed.endsWith('$$'))) {
        fence = opener[1]
      }
      if (!fence) {
        chunks.push(pending)
        pending = ''
      }
    }
    if (pending) chunks.push(pending)
    return chunks
  }

  const rawtokens = text.match(/\S+\s*|\s+/g) || [text]
  const chunks = []
  let currentchunk = ''
  for (const tok of rawtokens) {
    currentchunk += tok
    if (tok.includes('\n') || currentchunk.length >= 24 || currentchunk.split(/\s+/).length >= 4) {
      chunks.push(currentchunk)
      currentchunk = ''
    }
  }
  if (currentchunk) chunks.push(currentchunk)
  return chunks
}

// find where our streamed text ended up after someone else typed or markdown got normalized --------------------
function relocatestream(current, written, expected) {
  if (current.slice(Math.max(0, expected - written.length), expected) === written) return expected
  const lines = written.split('\n').map(l => l.trim()).filter(Boolean)
  const tail = lines[lines.length - 1]
  if (!tail) return Math.min(expected, current.length)
  let best = -1
  let idx = current.indexOf(tail)
  while (idx !== -1) {
    if (best === -1 || Math.abs(idx - expected) < Math.abs(best - expected)) best = idx
    idx = current.indexOf(tail, idx + 1)
  }
  if (best === -1) return Math.min(expected, current.length)
  let pos = best + tail.length
  if (written.endsWith('\n')) {
    const nl = current.indexOf('\n', pos)
    pos = nl === -1 ? current.length : nl + 1
  }
  return pos
}

// helper to stream text insertion in natural chunks so the ai types live --------------------
export async function streaminsert(entry, insertpos, text, origin) {
  if (!text) return
  const author = (typeof origin === 'object' && origin !== null) ? origin.author : (origin || 'ai')
  const chunks = author === 'ai' ? streamchunks(text, entry.kind) : [text]

  if (chunks.length <= 1) {
    entry.insertat(insertpos, text, origin)
    return
  }

  if (entry.kind === 'text') {
    // relative positions survive anyone typing above the insertion point --------------------
    const ytext = entry.doc.getText('content')
    let rel = Y.createRelativePositionFromTypeIndex(ytext, Math.max(0, Math.min(insertpos, ytext.length)))
    for (const chunk of chunks) {
      const abs = Y.createAbsolutePositionFromRelativePosition(rel, entry.doc)
      const at = abs ? abs.index : ytext.length
      entry.doc.transact(() => ytext.insert(at, chunk), origin)
      rel = Y.createRelativePositionFromTypeIndex(ytext, at + chunk.length, -1)
      await new Promise(r => setTimeout(r, 85))
    }
    return
  }

  // rich notes must never splice into roundtripped markdown
  // each getcontent serialize made incomplete chunks and cite pills explode into <br> soup
  const cur = entry.getcontent()
  const at = Math.max(0, Math.min(insertpos, cur.length))
  const before = cur.slice(0, at)
  const after = cur.slice(at)
  let built = ''
  for (const chunk of chunks) {
    built += chunk
    entry.setcontent(`${before}${built}${after}`, origin)
    await new Promise(r => setTimeout(r, 85))
  }
}

// swap target for replacement without ever leaving a hole in a rich note --------------------
// deleting first let the markdown rebuild eat the empty line so the insert landed glued to the next heading
async function streamreplace(entry, current, bounds, replacement, origin) {
  if (entry.kind !== 'rich') {
    if (bounds.to > bounds.from) {
      entry.setcontent(`${current.slice(0, bounds.from)}${current.slice(bounds.to)}`, origin)
    }
    if (replacement) await streaminsert(entry, bounds.from, replacement, origin)
    return
  }

  // same rule as streaminsert: always rebuild from the original replacement text
  // never splice chunks into a getcontent() roundtrip mid-stream
  const before = current.slice(0, bounds.from)
  const after = current.slice(bounds.to)
  const author = (typeof origin === 'object' && origin !== null) ? origin.author : (origin || 'ai')
  const chunks = author === 'ai' ? streamchunks(replacement, entry.kind) : [replacement]
  if (chunks.length <= 1) {
    entry.setcontent(`${before}${replacement || ''}${after}`, origin)
    return
  }
  let built = ''
  for (const chunk of chunks) {
    built += chunk
    entry.setcontent(`${before}${built}${after}`, origin)
    await new Promise(r => setTimeout(r, 85))
  }
}

// apply diff directly into the live note with resilient matching and multiple modes --------------------
export async function applydiff(vaultdir, historydir, noteid, options) {
  const { author = 'ai' } = options
  const entry = getdoc(vaultdir, historydir, noteid)

  const editlist = Array.isArray(options.edits)
    ? options.edits
    : [{
        mode: options.mode || 'replace',
        target_text: options.target_text || options.target || '',
        replacement_text: options.replacement_text !== undefined ? options.replacement_text : ''
      }]

  if (editlist.length === 0) {
    return entry.getcontent()
  }

  for (let editidx = 0; editidx < editlist.length; editidx++) {
    const edit = editlist[editidx]
    const editid = `${author}_edit_${Date.now()}_${editidx}`
    const origin = { author, edit_id: editid }
    const mode = edit.mode || 'replace'
    const target = unliteralescapes(edit.target_text || '')
    const replacement = unliteralescapes(edit.replacement_text !== undefined ? edit.replacement_text : '')
    const current = entry.getcontent()

    if (mode === 'replace') {
      const bounds = findtargetbounds(current, target)
      if (!bounds) {
        throw new Error(`target text not found in note: "${target.slice(0, 40)}"`)
      }
      await streamreplace(entry, current, bounds, replacement, origin)
    } else if (mode === 'delete') {
      const bounds = findtargetbounds(current, target)
      if (!bounds) {
        throw new Error(`target text not found in note: "${target.slice(0, 40)}"`)
      }
      // if deleting a full line clean up its newline --------------------
      let deletefrom = bounds.from
      let deletelen = bounds.to - bounds.from
      if (!target.endsWith('\n') && !target.startsWith('\n')) {
        if (current[bounds.to] === '\n') {
          deletelen += 1
        } else if (deletefrom > 0 && current[deletefrom - 1] === '\n') {
          deletefrom -= 1
          deletelen += 1
        }
      }
      entry.setcontent(`${current.slice(0, deletefrom)}${current.slice(deletefrom + deletelen)}`, origin)
    } else if (mode === 'insert_after') {
      const bounds = findtargetbounds(current, target)
      if (!bounds) {
        throw new Error(`target text not found in note: "${target.slice(0, 40)}"`)
      }
      let insertpos = bounds.to
      let texttoinsert = replacement
      if (current[bounds.to] === '\n') {
        insertpos = bounds.to + 1
        if (!texttoinsert.endsWith('\n')) {
          texttoinsert = `${texttoinsert}\n`
        }
      } else if (!texttoinsert.startsWith('\n') && !texttoinsert.startsWith(' ')) {
        texttoinsert = `\n${texttoinsert}`
      }
      await streaminsert(entry, insertpos, texttoinsert, origin)
    } else if (mode === 'insert_before') {
      const bounds = findtargetbounds(current, target)
      if (!bounds) {
        throw new Error(`target text not found in note: "${target.slice(0, 40)}"`)
      }
      let texttoinsert = replacement
      if (bounds.from > 0 && current[bounds.from - 1] === '\n' && !texttoinsert.endsWith('\n')) {
        texttoinsert = `${texttoinsert}\n`
      }
      await streaminsert(entry, bounds.from, texttoinsert, origin)
    } else if (mode === 'append') {
      const text = replacement || ''
      let separator = ''
      if (current.length > 0) {
        if (current.endsWith('\n\n')) {
          separator = ''
        } else if (current.endsWith('\n')) {
          separator = text.startsWith('\n') ? '' : '\n'
        } else {
          separator = text.startsWith('\n\n') ? '' : (text.startsWith('\n') ? '\n' : '\n\n')
        }
      }
      await streaminsert(entry, current.length, `${separator}${text}`, origin)
    } else {
      throw new Error(`invalid edit mode "${mode}"`)
    }

    if (editidx < editlist.length - 1 && author === 'ai') {
      await new Promise(r => setTimeout(r, 120))
    }
  }

  return entry.getcontent()
}

// register and handle websocket connection --------------------
export function handlesocket(socket, vaultdir, historydir, noteid, author = 'user') {
  const entry = getdoc(vaultdir, historydir, noteid)
  const wskey = () => entry.note_id
  socket._mushauthor = author
  socket._mushjoined = false

  if (!clientmap.has(wskey())) {
    clientmap.set(wskey(), new Set())
  }
  clientmap.get(wskey()).add(socket)

  // tell the client which doc lineage this is before any yjs bytes flow --------------------
  socket.send(JSON.stringify({
    type: 'hello',
    note_id: wskey(),
    epoch: entry.epoch,
    kind: entry.kind
  }))

  function sendsyncstep1() {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messagesync)
    syncProtocol.writeSyncStep1(encoder, entry.doc)
    socket.send(encoding.toUint8Array(encoder))
  }

  socket.on('message', (raw, isbinary) => {
    if (!isbinary) {
      let parsed = null
      try {
        parsed = JSON.parse(raw.toString('utf8'))
      } catch {
        return
      }
      if (!parsed) return

      if (parsed.type === 'join') {
        if (parsed.epoch && parsed.epoch !== entry.epoch) {
          socket.send(JSON.stringify({ type: 'hello', note_id: wskey(), epoch: entry.epoch, kind: entry.kind }))
          return
        }
        socket._mushjoined = true
        sendsyncstep1()
        broadcastjson(wskey(), { type: 'cursor_query', note_id: wskey(), author }, socket)
        return
      }

      // relay text cursor events to peers --------------------
      if (parsed.type === 'cursor_event' || parsed.type === 'cursor_leave') {
        broadcastjson(wskey(), parsed, socket)
      }
      return
    }

    if (!socket._mushjoined) return
    try {
      const decoder = decoding.createDecoder(new Uint8Array(raw))
      const messagetype = decoding.readVarUint(decoder)
      if (messagetype !== messagesync) return
      const replyencoder = encoding.createEncoder()
      encoding.writeVarUint(replyencoder, messagesync)
      syncProtocol.readSyncMessage(decoder, replyencoder, entry.doc, socket)
      if (encoding.length(replyencoder) > 1) {
        socket.send(encoding.toUint8Array(replyencoder))
      }
    } catch (err) {
      console.error('bad sync packet', wskey(), err?.message || err)
    }
  })

  // cleanup on disconnect --------------------
  socket.on('close', () => {
    const key = wskey()
    const clients = clientmap.get(key)
    if (!clients || !clients.has(socket)) return
    clients.delete(socket)
    if (clients.size === 0) {
      clientmap.delete(key)
      // killed docs must not flush or deleted notes come back from the dead --------------------
      entry.flushtodisk()
      return
    }
    broadcastjson(key, { type: 'cursor_leave', note_id: key, author })
  })
}

// restore note body from a stored revision snapshot --------------------
export function restorenoterevision(vaultdir, historydir, noteid, revid, author = 'user') {
  const rev = getrevisionbyid(historydir, revid)
  if (!rev) {
    throw new Error('revision not found')
  }

  const cleannote = cleanid(noteid)
  const cleanrevfile = cleanid(rev.file_id)
  const notevariants = new Set([
    cleannote,
    cleannote.endsWith('.md') ? cleannote.slice(0, -3) : `${cleannote}.md`
  ])
  if (!notevariants.has(cleanrevfile)) {
    throw new Error('revision does not belong to this note')
  }

  const hadfile = Boolean(readnote(vaultdir, cleannote))
  if (!hadfile) {
    writenote(vaultdir, cleannote, rev.content || '')
    recordevent(historydir, {
      file_id: cleannote,
      event_type: 'create',
      author,
      new_path: cleannote,
      details: `restored from revision ${rev.id}`
    })
  }

  const entry = getdoc(vaultdir, historydir, cleannote)
  entry.setcontent(rev.content || '', { author, edit_id: `restore_${rev.id}` })
  entry.flushtodisk(author)

  return {
    note_id: cleannote,
    revision_id: rev.id,
    content: rev.content || '',
    recreated: !hadfile
  }
}
