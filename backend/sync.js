import * as yjs from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { readnote, writenote } from './vault.js'
import { recordhistory, recordevent } from './history.js'

// active documents in memory --------------------
const docmap = new Map()
const clientmap = new Map()
const messagesync = 0

// get or create live yjs document bound to vault and history --------------------
export function getdoc(vaultdir, historydir, noteid) {
  if (docmap.has(noteid)) {
    return docmap.get(noteid)
  }

  const doc = new yjs.Doc()
  const ytext = doc.getText('content')
  let currentnoteid = noteid
  let lastauthor = 'system'
  let savetimer = null

  // load existing content from disk if present --------------------
  const existing = readnote(vaultdir, noteid)
  if (existing && existing.content) {
    ytext.insert(0, existing.content)
  }

  // broadcast text edits to connected clients with author and ranges --------------------
  ytext.observe((event, transaction) => {
    const origin = transaction.origin
    const author = (typeof origin === 'object' && origin !== null) ? origin.author : (origin || 'user')
    const editid = (typeof origin === 'object' && origin !== null) ? origin.edit_id : null
    const clients = clientmap.get(currentnoteid)
    if (!clients || clients.size === 0) {
      return
    }

    let index = 0
    const edits = []
    for (const op of event.changes.delta) {
      if (op.retain) {
        index += op.retain
      }
      if (op.insert) {
        const len = typeof op.insert === 'string' ? op.insert.length : 1
        edits.push({ type: 'insert', from: index, to: index + len, text: op.insert })
        index += len
      }
      if (op.delete) {
        edits.push({ type: 'delete', from: index, to: index + op.delete })
      }
    }

    if (edits.length === 0) {
      return
    }

    const payload = JSON.stringify({
      type: 'edit_event',
      note_id: currentnoteid,
      author,
      edit_id: editid,
      edits,
      content: ytext.toString()
    })

    for (const client of clients) {
      if (client.readyState === 1) {
        client.send(payload)
      }
    }
  })

  // schedule debounced disk save on changes --------------------
  function schedulesave(author) {
    if (author && author !== 'system') {
      lastauthor = author
    }
    if (savetimer) {
      clearTimeout(savetimer)
    }
    savetimer = setTimeout(() => {
      const content = ytext.toString()
      writenote(vaultdir, currentnoteid, content)
      recordhistory(historydir, currentnoteid, lastauthor, content)
      savetimer = null
    }, 500)
  }

  // broadcast updates to connected clients --------------------
  doc.on('update', (update, origin) => {
    const clients = clientmap.get(currentnoteid)
    if (clients && clients.size > 0) {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messagesync)
      syncProtocol.writeUpdate(encoder, update)
      const message = encoding.toUint8Array(encoder)

      for (const client of clients) {
        if (client !== origin && client.readyState === 1) {
          client.send(message)
        }
      }
    }

    const author = typeof origin === 'string' ? origin : 'user'
    schedulesave(author)
  })

  const entry = {
    get note_id() {
      return currentnoteid
    },
    set note_id(val) {
      currentnoteid = val
    },
    doc,
    ytext,
    getcontent: () => ytext.toString(),
    cancelsave: () => {
      if (savetimer) {
        clearTimeout(savetimer)
        savetimer = null
      }
    },
    flushtodisk: (author) => {
      if (savetimer) {
        clearTimeout(savetimer)
        savetimer = null
      }
      if (author) {
        lastauthor = author
      }
      const content = ytext.toString()
      writenote(vaultdir, currentnoteid, content)
      recordhistory(historydir, currentnoteid, lastauthor, content)
    }
  }

  docmap.set(noteid, entry)
  return entry
}

// migrate in memory docs and connected clients when note or folder moves --------------------
export function migratedocentry(oldid, newid, isfolder = false) {
  const cleanold = oldid.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const cleannew = newid.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')

  if (isfolder) {
    const oldprefix = `${cleanold}/`
    const newprefix = `${cleannew}/`

    for (const [key, entry] of Array.from(docmap.entries())) {
      if (key.startsWith(oldprefix)) {
        if (entry.cancelsave) {
          entry.cancelsave()
        }
        const subpath = key.slice(oldprefix.length)
        const targetkey = `${newprefix}${subpath}`
        docmap.delete(key)
        entry.note_id = targetkey
        docmap.set(targetkey, entry)
      }
    }

    for (const [key, clients] of Array.from(clientmap.entries())) {
      if (key.startsWith(oldprefix)) {
        const subpath = key.slice(oldprefix.length)
        const targetkey = `${newprefix}${subpath}`
        clientmap.delete(key)
        clientmap.set(targetkey, clients)

        const payload = JSON.stringify({
          type: 'note_renamed',
          old_note_id: key,
          new_note_id: targetkey
        })
        for (const client of clients) {
          if (client.readyState === 1) {
            client.send(payload)
          }
        }
      }
    }
    return
  }

  // single note migration --------------------
  for (const [key, entry] of Array.from(docmap.entries())) {
    if (key === cleanold || key === `${cleanold}.md` || cleanold === `${key}.md`) {
      if (entry.cancelsave) {
        entry.cancelsave()
      }
      docmap.delete(key)
      entry.note_id = cleannew
      docmap.set(cleannew, entry)
    }
  }

  for (const [key, clients] of Array.from(clientmap.entries())) {
    if (key === cleanold || key === `${cleanold}.md` || cleanold === `${key}.md`) {
      clientmap.delete(key)
      clientmap.set(cleannew, clients)
      const payload = JSON.stringify({
        type: 'note_renamed',
        old_note_id: key,
        new_note_id: cleannew
      })
      for (const client of clients) {
        if (client.readyState === 1) {
          client.send(payload)
        }
      }
    }
  }
}

// check if document is currently loaded in memory --------------------
export function getdocifloaded(noteid) {
  if (docmap.has(noteid)) return docmap.get(noteid)
  if (!noteid.endsWith('.md') && docmap.has(`${noteid}.md`)) return docmap.get(`${noteid}.md`)
  if (noteid.endsWith('.md') && docmap.has(noteid.slice(0, -3))) return docmap.get(noteid.slice(0, -3))
  return null
}

// apply external filesystem change into live yjs memory and sqlite history --------------------
export function applyexternalchange(vaultdir, historydir, noteid, newcontent) {
  let matchedid = noteid
  let entry = docmap.get(noteid)

  if (!entry && !noteid.endsWith('.md')) {
    const withmd = `${noteid}.md`
    if (docmap.has(withmd)) {
      entry = docmap.get(withmd)
      matchedid = withmd
    }
  } else if (!entry && noteid.endsWith('.md')) {
    const stripped = noteid.slice(0, -3)
    if (docmap.has(stripped)) {
      entry = docmap.get(stripped)
      matchedid = stripped
    }
  }

  if (entry) {
    const current = entry.ytext.toString()
    if (current === newcontent) {
      return false
    }

    // compute common prefix and suffix to yield minimal edit range --------------------
    let prefixlen = 0
    while (prefixlen < current.length && prefixlen < newcontent.length && current[prefixlen] === newcontent[prefixlen]) {
      prefixlen++
    }

    let currentsuffix = current.length
    let newsuffix = newcontent.length
    while (currentsuffix > prefixlen && newsuffix > prefixlen && current[currentsuffix - 1] === newcontent[newsuffix - 1]) {
      currentsuffix--
      newsuffix--
    }

    const deletecount = currentsuffix - prefixlen
    const inserttext = newcontent.slice(prefixlen, newsuffix)

    entry.doc.transact(() => {
      if (deletecount > 0) {
        entry.ytext.delete(prefixlen, deletecount)
      }
      if (inserttext.length > 0) {
        entry.ytext.insert(prefixlen, inserttext)
      }
    }, 'external')

    recordhistory(historydir, matchedid, 'external', newcontent)
    return true
  }

  // note is not loaded in memory, still log history snapshot in sqlite --------------------
  recordhistory(historydir, noteid, 'external', newcontent)
  return true
}

// handle file deleted on disk externally --------------------
export function handleexternaldelete(vaultdir, historydir, noteid) {
  if (docmap.has(noteid)) {
    docmap.delete(noteid)
  }
  const withmd = noteid.endsWith('.md') ? noteid : `${noteid}.md`
  if (docmap.has(withmd)) {
    docmap.delete(withmd)
  }
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

// helper to stream text insertion in natural multi-word chunks into ytext --------------------
export async function streaminsert(entry, insertpos, text, origin) {
  if (!text) return
  const author = (typeof origin === 'object' && origin !== null) ? origin.author : (origin || 'ai')
  if (author !== 'ai') {
    entry.doc.transact(() => {
      entry.ytext.insert(insertpos, text)
    }, origin)
    return
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

  const delay = 85
  let pos = insertpos
  for (const chunk of chunks) {
    entry.doc.transact(() => {
      entry.ytext.insert(pos, chunk)
    }, origin)
    pos += chunk.length
    if (chunks.length > 1) {
      await new Promise(r => setTimeout(r, delay))
    }
  }
}

// apply diff directly into yjs text document with resilient matching and multiple modes --------------------
export async function applydiff(vaultdir, historydir, noteid, options) {
  const { author = 'ai' } = options
  const entry = getdoc(vaultdir, historydir, noteid)

  const editlist = Array.isArray(options.edits)
    ? options.edits
    : [{
        mode: options.mode || 'replace',
        target_text: options.target_text || '',
        replacement_text: options.replacement_text !== undefined ? options.replacement_text : ''
      }]

  if (editlist.length === 0) {
    return entry.ytext.toString()
  }

  for (let editidx = 0; editidx < editlist.length; editidx++) {
    const edit = editlist[editidx]
    const editid = `${author}_edit_${Date.now()}_${editidx}`
    const origin = { author, edit_id: editid }
    const mode = edit.mode || 'replace'
    const target = unliteralescapes(edit.target_text || '')
    const replacement = unliteralescapes(edit.replacement_text !== undefined ? edit.replacement_text : '')
    const current = entry.ytext.toString()

    if (mode === 'replace') {
      const bounds = findtargetbounds(current, target)
      if (!bounds) {
        throw new Error(`target text not found in note: "${target.slice(0, 40)}"`)
      }
      if (bounds.to > bounds.from) {
        entry.doc.transact(() => {
          entry.ytext.delete(bounds.from, bounds.to - bounds.from)
        }, origin)
      }
      if (replacement) {
        await streaminsert(entry, bounds.from, replacement, origin)
      }
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
      entry.doc.transact(() => {
        entry.ytext.delete(deletefrom, deletelen)
      }, origin)
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
      await streaminsert(entry, entry.ytext.length, `${separator}${text}`, origin)
    } else {
      throw new Error(`invalid edit mode "${mode}"`)
    }

    if (editidx < editlist.length - 1 && author === 'ai') {
      await new Promise(r => setTimeout(r, 120))
    }
  }

  return entry.ytext.toString()
}

// register and handle websocket connection --------------------
export function handlesocket(socket, vaultdir, historydir, noteid, author = 'user') {
  const entry = getdoc(vaultdir, historydir, noteid)

  if (!clientmap.has(noteid)) {
    clientmap.set(noteid, new Set())
  }
  clientmap.get(noteid).add(socket)

  // notify other clients that a user opened note --------------------
  const querymsg = JSON.stringify({
    type: 'cursor_query',
    note_id: noteid,
    author
  })
  const existingclients = clientmap.get(noteid)
  for (const client of existingclients) {
    if (client !== socket && client.readyState === 1) {
      client.send(querymsg)
    }
  }

  // send initial sync step 1 --------------------
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messagesync)
  syncProtocol.writeSyncStep1(encoder, entry.doc)
  socket.send(encoding.toUint8Array(encoder))

  // handle incoming sync messages from client --------------------
  socket.on('message', (raw) => {
    // relay text cursor events to peers --------------------
    try {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8')
      if (text.startsWith('{')) {
        const parsed = JSON.parse(text)
        if (parsed.type === 'cursor_event' || parsed.type === 'cursor_leave') {
          const clients = clientmap.get(noteid)
          if (clients) {
            for (const client of clients) {
              if (client !== socket && client.readyState === 1) {
                client.send(text)
              }
            }
          }
          return
        }
      }
    } catch {}

    try {
      const bytes = new Uint8Array(raw)
      const decoder = decoding.createDecoder(bytes)
      const messagetype = decoding.readVarUint(decoder)

      if (messagetype === messagesync) {
        const replyencoder = encoding.createEncoder()
        encoding.writeVarUint(replyencoder, messagesync)
        syncProtocol.readSyncMessage(decoder, replyencoder, entry.doc, author)

        if (encoding.length(replyencoder) > 1) {
          socket.send(encoding.toUint8Array(replyencoder))
        }
      }
    } catch {
      // ignore bad binary packets --------------------
    }
  })

  // cleanup on disconnect --------------------
  socket.on('close', () => {
    const clients = clientmap.get(noteid)
    if (clients) {
      clients.delete(socket)
      if (clients.size === 0) {
        clientmap.delete(noteid)
      } else {
        // notify remaining clients that author left note --------------------
        const leavemsg = JSON.stringify({
          type: 'cursor_leave',
          note_id: noteid,
          author
        })
        for (const client of clients) {
          if (client.readyState === 1) {
            client.send(leavemsg)
          }
        }
      }
    }
  })
}
