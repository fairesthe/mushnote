import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// cached database instance --------------------
let dbinstance = null
let currentdbpath = null

// ensure base history directory and sqlite database exist --------------------
export function inithistory(historydir) {
  if (!fs.existsSync(historydir)) {
    fs.mkdirSync(historydir, { recursive: true })
  }

  const dbpath = path.join(historydir, 'history.db')
  if (dbinstance && currentdbpath === dbpath) {
    return dbinstance
  }

  const db = new DatabaseSync(dbpath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')

  // revisions table --------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id TEXT NOT NULL,
      author TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      content TEXT NOT NULL,
      char_count INTEGER NOT NULL
    )
  `)

  // audit events table for tracking moves renames deletes and edits --------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      author TEXT NOT NULL,
      old_path TEXT,
      new_path TEXT,
      timestamp INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      details TEXT
    )
  `)

  // fast lookup indexes --------------------
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_revisions_file ON revisions(file_id);
    CREATE INDEX IF NOT EXISTS idx_revisions_time ON revisions(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_file ON events(file_id);
    CREATE INDEX IF NOT EXISTS idx_events_time ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
  `)

  dbinstance = db
  currentdbpath = dbpath

  // older moves never carried their revisions along so stitch them back once --------------------
  if (db.prepare('PRAGMA user_version').get().user_version < 1) {
    backfillmoves(db)
    db.exec('PRAGMA user_version = 1')
  }

  return db
}

// path cleanup shared by every lookup --------------------
function cleanhistoryid(noteid) {
  return String(noteid || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

function relinkfile(db, oldid, newid, before = null) {
  const ids = historyfileids(oldid)
  const placeholders = ids.map(() => '?').join(', ')
  const timefilter = before === null ? '' : ' AND timestamp <= ?'
  const params = before === null ? [newid, ...ids] : [newid, ...ids, before]
  db.prepare(`UPDATE revisions SET file_id = ? WHERE file_id IN (${placeholders})${timefilter}`).run(...params)
  db.prepare(`UPDATE events SET file_id = ? WHERE file_id IN (${placeholders})${timefilter}`).run(...params)
}

function relinkfolder(db, oldfolder, newfolder, before = null) {
  const oldprefix = `${oldfolder}/`
  const newprefix = `${newfolder}/`
  const timefilter = before === null ? '' : ' AND timestamp <= ?'
  const params = [newprefix, oldprefix.length + 1, oldprefix.length, oldprefix]
  if (before !== null) params.push(before)
  for (const table of ['revisions', 'events']) {
    db.prepare(`UPDATE ${table} SET file_id = ? || substr(file_id, ?) WHERE substr(file_id, 1, ?) = ?${timefilter}`).run(...params)
  }
}

// keep revisions attached to a note through moves and renames --------------------
export function migratehistoryids(historydir, oldid, newid, isfolder = false) {
  const db = gethistorydb(historydir)
  const cleanold = cleanhistoryid(oldid)
  const cleannew = cleanhistoryid(newid)
  if (!cleanold || !cleannew || cleanold === cleannew) return
  if (isfolder) relinkfolder(db, cleanold, cleannew)
  else relinkfile(db, cleanold, cleannew)
}

function backfillmoves(db) {
  const moves = db.prepare(`
    SELECT event_type, old_path, new_path, timestamp FROM events
    WHERE event_type IN ('move', 'move_folder') AND old_path IS NOT NULL AND new_path IS NOT NULL
    ORDER BY timestamp ASC
  `).all()
  for (const move of moves) {
    const oldid = cleanhistoryid(move.old_path)
    const newid = cleanhistoryid(move.new_path)
    if (!oldid || !newid || oldid === newid) continue
    if (move.event_type === 'move_folder') relinkfolder(db, oldid, newid, move.timestamp)
    else relinkfile(db, oldid, newid, move.timestamp)
  }
}

// newest snapshot for a note, used to spot renames done outside the app --------------------
export function getlatestrevision(historydir, noteid) {
  const db = gethistorydb(historydir)
  const ids = historyfileids(noteid)
  const placeholders = ids.map(() => '?').join(', ')
  return db.prepare(`
    SELECT file_id, content FROM revisions
    WHERE file_id IN (${placeholders})
    ORDER BY timestamp DESC
    LIMIT 1
  `).get(...ids) || null
}

// every tracked note path living under a folder --------------------
export function gethistoryidsunder(historydir, folder) {
  const db = gethistorydb(historydir)
  const prefix = `${cleanhistoryid(folder)}/`
  return db.prepare('SELECT DISTINCT file_id FROM revisions WHERE substr(file_id, 1, ?) = ?')
    .all(prefix.length, prefix)
    .map(row => row.file_id)
}

// notes that have history but no file on disk anymore --------------------
export function getdeletednotes(historydir, existingids = []) {
  const db = gethistorydb(historydir)
  const existing = new Set()
  for (const id of existingids) {
    for (const variant of historyfileids(id)) existing.add(variant)
  }

  const rows = db.prepare(`
    SELECT file_id, MAX(timestamp) AS last_edit, COUNT(*) AS revision_count
    FROM revisions
    GROUP BY file_id
  `).all()

  const deleteevent = db.prepare(`
    SELECT author, timestamp FROM events
    WHERE event_type = 'delete' AND (file_id = ? OR old_path = ?)
    ORDER BY timestamp DESC
    LIMIT 1
  `)
  const folderdeletes = db.prepare(`
    SELECT old_path, author, timestamp FROM events
    WHERE event_type = 'delete_folder' AND old_path IS NOT NULL
    ORDER BY timestamp DESC
  `).all()

  // todo and todo.md are the same note so merge them --------------------
  const merged = new Map()
  for (const row of rows) {
    if (existing.has(row.file_id)) continue
    const base = row.file_id.split('/').pop()
    const key = base.includes('.') ? row.file_id : `${row.file_id}.md`
    const prev = merged.get(key)
    if (prev) {
      prev.revision_count += row.revision_count
      prev.last_edit = Math.max(prev.last_edit, row.last_edit)
      continue
    }
    merged.set(key, { note_id: key, last_edit: row.last_edit, revision_count: row.revision_count })
  }

  const notes = []
  for (const note of merged.values()) {
    const direct = deleteevent.get(note.note_id, note.note_id)
    const viafolder = folderdeletes.find(ev => note.note_id.startsWith(`${cleanhistoryid(ev.old_path)}/`))
    const deletion = direct || viafolder || null
    notes.push({
      ...note,
      deleted_at: deletion ? deletion.timestamp : null,
      deleted_by: deletion ? deletion.author : null
    })
  }

  notes.sort((a, b) => (b.deleted_at || b.last_edit) - (a.deleted_at || a.last_edit))
  return notes
}

// helper to get or initialize database --------------------
export function gethistorydb(historydir) {
  if (dbinstance) {
    return dbinstance
  }
  return inithistory(historydir)
}

// record audit event like rename move delete or create --------------------
export function recordevent(historydir, event) {
  const db = gethistorydb(historydir)
  const timestamp = event.timestamp || Date.now()
  const createdat = event.created_at || new Date(timestamp).toISOString()

  const insert = db.prepare(`
    INSERT INTO events (file_id, event_type, author, old_path, new_path, timestamp, created_at, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)

  insert.run(
    event.file_id || '',
    event.event_type || 'edit',
    event.author || 'unknown',
    event.old_path || null,
    event.new_path || null,
    timestamp,
    createdat,
    event.details || null
  )
}

// record revision snapshot and log edit event --------------------
export function recordhistory(historydir, noteid, author = 'unknown', content = '') {
  const db = gethistorydb(historydir)
  const cleanid = noteid.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')

  // check if last revision is identical to prevent duplicate snapshots --------------------
  const laststmt = db.prepare(`
    SELECT content FROM revisions
    WHERE file_id = ?
    ORDER BY timestamp DESC
    LIMIT 1
  `)
  const last = laststmt.get(cleanid)
  if (last && last.content === content) {
    return
  }

  const timestamp = Date.now()
  const createdat = new Date(timestamp).toISOString()
  const charcount = content.length

  const insertrev = db.prepare(`
    INSERT INTO revisions (file_id, author, timestamp, created_at, content, char_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  insertrev.run(cleanid, author, timestamp, createdat, content, charcount)

  // log audit edit event --------------------
  recordevent(historydir, {
    file_id: cleanid,
    event_type: 'edit',
    author,
    timestamp,
    created_at: createdat
  })
}

// normalize note path for history lookup --------------------
function historyfileids(noteid) {
  const cleanid = cleanhistoryid(noteid)
  const withmd = cleanid.endsWith('.md') ? cleanid : `${cleanid}.md`
  const stripped = cleanid.endsWith('.md') ? cleanid.slice(0, -3) : cleanid
  return [...new Set([cleanid, withmd, stripped])]
}

// load one revision snapshot by id --------------------
export function getrevisionbyid(historydir, revid) {
  const db = gethistorydb(historydir)
  const idnum = parseInt(String(revid), 10)
  if (!Number.isFinite(idnum)) return null

  const stmt = db.prepare(`
    SELECT id, file_id, author, timestamp, created_at, content, char_count
    FROM revisions
    WHERE id = ?
  `)
  const row = stmt.get(idnum)
  if (!row) return null

  return {
    id: String(row.id),
    file_id: row.file_id,
    timestamp: row.timestamp,
    author: row.author,
    created_at: row.created_at,
    char_count: row.char_count,
    content: row.content || ''
  }
}

// find inserted and removed spans between two bodies --------------------
function diffchangeregions(oldtext, newtext) {
  const oldstr = oldtext || ''
  const newstr = newtext || ''

  let start = 0
  while (start < oldstr.length && start < newstr.length && oldstr[start] === newstr[start]) {
    start++
  }

  let oldend = oldstr.length
  let newend = newstr.length
  while (oldend > start && newend > start && oldstr[oldend - 1] === newstr[newend - 1]) {
    oldend--
    newend--
  }

  return {
    added: newend > start ? newstr.slice(start, newend) : '',
    removed: oldend > start ? oldstr.slice(start, oldend) : ''
  }
}

// visible chars only so blank line shuffles dont count --------------------
// graphemes so emoji with variation selectors count as one
const graphemes = new Intl.Segmenter()
function visiblelength(text) {
  const stripped = (text || '').replace(/\s+/g, '')
  if (!stripped) return 0
  let count = 0
  for (const _ of graphemes.segment(stripped)) count++
  return count
}

// line level diff, falls back to one big block when the middle is huge --------------------
function difflines(oldlines, newlines) {
  let start = 0
  while (start < oldlines.length && start < newlines.length && oldlines[start] === newlines[start]) start++
  let oldend = oldlines.length
  let newend = newlines.length
  while (oldend > start && newend > start && oldlines[oldend - 1] === newlines[newend - 1]) {
    oldend--
    newend--
  }

  const a = oldlines.slice(start, oldend)
  const b = newlines.slice(start, newend)
  if (a.length * b.length > 250000) return [{ removed: a, added: b }]

  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }

  const blocks = []
  let block = null
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      block = null
      i++
      j++
      continue
    }
    if (!block) {
      block = { removed: [], added: [] }
      blocks.push(block)
    }
    if (j < b.length && (i >= a.length || table[i][j + 1] >= table[i + 1][j])) block.added.push(b[j++])
    else block.removed.push(a[i++])
  }
  return blocks
}

// line 2 in history list: real added and removed chars plus edited lines --------------------
function computechangestat(oldtext, newtext) {
  const stat = { added: 0, removed: 0, lines: 0, whitespace: false }
  const oldstr = oldtext || ''
  const newstr = newtext || ''
  if (oldstr === newstr) return stat

  const blocks = difflines(oldstr.split('\n'), newstr.split('\n'))
  for (const block of blocks) {
    const paired = Math.min(block.removed.length, block.added.length)
    for (let k = 0; k < paired; k++) {
      const { added, removed } = diffchangeregions(block.removed[k], block.added[k])
      stat.added += visiblelength(added)
      stat.removed += visiblelength(removed)
      if (visiblelength(added) || visiblelength(removed)) stat.lines++
    }
    for (const line of block.removed.slice(paired)) {
      stat.removed += visiblelength(line)
      if (line.trim()) stat.lines++
    }
    for (const line of block.added.slice(paired)) {
      stat.added += visiblelength(line)
      if (line.trim()) stat.lines++
    }
  }

  stat.whitespace = stat.added === 0 && stat.removed === 0
  return stat
}

// plain minus and plus lines so the ai can read what actually changed --------------------
export function formatlinediff(oldtext, newtext, maxlines = 80) {
  const blocks = difflines((oldtext || '').split('\n'), (newtext || '').split('\n'))
  const out = []
  for (const block of blocks) {
    for (const line of block.removed) if (line.trim()) out.push(`- ${line}`)
    for (const line of block.added) if (line.trim()) out.push(`+ ${line}`)
    out.push('')
  }
  while (out.length && !out[out.length - 1]) out.pop()
  if (out.length <= maxlines) return out.join('\n')
  return `${out.slice(0, maxlines).join('\n')}\n...[${out.length - maxlines} more diff lines]`
}

// one sentence summary of a stat for list rows --------------------
export function describechangestat(stat) {
  if (!stat) return ''
  if (stat.whitespace) return 'spacing only'
  const plural = stat.lines === 1 ? 'line' : 'lines'
  const verb = !stat.removed ? 'added' : !stat.added ? 'removed' : 'edited'
  return `+${stat.added} -${stat.removed} chars, ${stat.lines} ${plural} ${verb}`
}

// merge revisions and audit events for the history viewer --------------------
export function getfiletimeline(historydir, noteid, limit = 80) {
  const db = gethistorydb(historydir)
  const ids = historyfileids(noteid)
  const placeholders = ids.map(() => '?').join(', ')

  const revstmt = db.prepare(`
    SELECT id, file_id, author, timestamp, created_at, char_count, content
    FROM revisions
    WHERE file_id IN (${placeholders})
    ORDER BY timestamp DESC
    LIMIT ?
  `)
  const revrows = revstmt.all(...ids, limit)

  const events = getevents(historydir, noteid, limit)
  const items = []

  for (let i = 0; i < revrows.length; i++) {
    const r = revrows[i]
    const older = revrows[i + 1]
    const oldcontent = older ? older.content : ''
    const newcontent = r.content || ''

    items.push({
      kind: 'revision',
      id: String(r.id),
      author: r.author,
      timestamp: r.timestamp,
      created_at: r.created_at,
      stat: computechangestat(oldcontent, newcontent),
      char_count: r.char_count
    })
  }

  for (const ev of events) {
    if (ev.event_type === 'edit') continue
    const ts = ev.timestamp
    const labelmap = {
      delete: 'deleted this file',
      create: 'created this file',
      move: 'moved or renamed',
      move_folder: 'moved folder',
      rename: 'renamed'
    }
    items.push({
      kind: 'event',
      id: `event-${ev.id}`,
      event_id: ev.id,
      event_type: ev.event_type,
      author: ev.author,
      timestamp: ts,
      created_at: ev.created_at,
      preview: ev.details || ev.old_path || ev.new_path || '',
      label: labelmap[ev.event_type] || ev.event_type
    })
  }

  items.sort((a, b) => b.timestamp - a.timestamp)
  return items.slice(0, limit)
}

// squash revisions from the same clock hour into one row --------------------
// tzoffset is minutes like getTimezoneOffset so hours line up with the viewer
export function gethourlytimeline(historydir, noteid, limit = 80, tzoffset = 0) {
  const timeline = getfiletimeline(historydir, noteid, limit)
  const revisions = timeline.filter(item => item.kind === 'revision')
  const hourof = ts => Math.floor((ts - tzoffset * 60000) / 3600000)

  const groups = []
  for (let i = 0; i < revisions.length; i++) {
    const rev = revisions[i]
    const last = groups[groups.length - 1]
    if (last && last.hour === hourof(rev.timestamp)) {
      last.members.push(rev)
      last.oldestindex = i
      continue
    }
    groups.push({ hour: hourof(rev.timestamp), members: [rev], oldestindex: i })
  }

  const db = gethistorydb(historydir)
  const contentstmt = db.prepare('SELECT content FROM revisions WHERE id = ?')
  const contentof = id => (id ? contentstmt.get(parseInt(id, 10))?.content || '' : '')

  const items = groups.map(group => {
    const newest = group.members[0]
    const base = revisions[group.oldestindex + 1] || null
    const authors = []
    for (const member of group.members) {
      if (!authors.includes(member.author)) authors.push(member.author)
    }
    return {
      kind: 'group',
      id: `group-${newest.id}`,
      newest_id: newest.id,
      base_id: base ? base.id : null,
      revision_ids: group.members.map(member => member.id),
      authors,
      author: newest.author,
      timestamp: newest.timestamp,
      start: group.members[group.members.length - 1].timestamp,
      stat: computechangestat(base ? contentof(base.id) : '', contentof(newest.id))
    }
  })

  for (const item of timeline) {
    if (item.kind === 'event') items.push(item)
  }
  items.sort((a, b) => b.timestamp - a.timestamp)
  return items
}

// read audit events log for a file or all files --------------------
export function getevents(historydir, fileid = null, limit = 50) {
  const db = gethistorydb(historydir)

  if (fileid) {
    const cleanid = fileid.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const stmt = db.prepare(`
      SELECT * FROM events
      WHERE file_id = ? OR old_path = ? OR new_path = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `)
    return stmt.all(cleanid, cleanid, cleanid, limit)
  }

  const stmt = db.prepare(`
    SELECT * FROM events
    ORDER BY timestamp DESC
    LIMIT ?
  `)
  return stmt.all(limit)
}

// look up note creator and most recent editor from history --------------------
export function getnoteauthorship(historydir, noteid) {
  const db = gethistorydb(historydir)
  const ids = historyfileids(noteid)
  const placeholders = ids.map(() => '?').join(', ')

  // fetch revisions to find latest and initial authors --------------------
  const revs = db.prepare(`
    SELECT author, timestamp FROM revisions
    WHERE file_id IN (${placeholders})
    ORDER BY timestamp DESC
  `).all(...ids)

  // check audit events for explicit creation --------------------
  const createevent = db.prepare(`
    SELECT author, timestamp FROM events
    WHERE file_id IN (${placeholders}) AND event_type = 'create'
    ORDER BY timestamp ASC
    LIMIT 1
  `).get(...ids)

  const lastauthor = revs.length > 0 ? revs[0].author : 'external'
  const firstauthor = revs.length > 0 ? revs[revs.length - 1].author : lastauthor
  const createdby = createevent?.author || firstauthor || lastauthor
  const createdtime = createevent?.timestamp || (revs.length > 0 ? revs[revs.length - 1].timestamp : null)

  return {
    last_author: lastauthor,
    created_by: createdby,
    created_time: createdtime,
    revision_count: revs.length
  }
}
