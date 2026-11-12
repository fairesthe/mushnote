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

  return db
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

// read revision history for a file --------------------
export function gethistory(historydir, noteid, limit = 5) {
  const db = gethistorydb(historydir)
  const cleanid = noteid.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')

  const stmt = db.prepare(`
    SELECT id, file_id, author, timestamp, created_at, content
    FROM revisions
    WHERE file_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `)

  const rows = stmt.all(cleanid, limit)
  return rows.map(r => ({
    id: String(r.id),
    timestamp: r.timestamp,
    author: r.author,
    created_at: r.created_at,
    preview: (r.content || '').slice(0, 150),
    content: r.content
  }))
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
  const cleanid = noteid.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const withmd = cleanid.endsWith('.md') ? cleanid : `${cleanid}.md`
  const stripped = cleanid.endsWith('.md') ? cleanid.slice(0, -3) : cleanid

  // fetch revisions to find latest and initial authors --------------------
  const revstmt = db.prepare(`
    SELECT author, timestamp FROM revisions
    WHERE file_id = ? OR file_id = ? OR file_id = ?
    ORDER BY timestamp DESC
  `)
  const revs = revstmt.all(cleanid, withmd, stripped)

  // check audit events for explicit creation --------------------
  const eventstmt = db.prepare(`
    SELECT author, timestamp FROM events
    WHERE (file_id = ? OR file_id = ? OR file_id = ?) AND event_type = 'create'
    ORDER BY timestamp ASC
    LIMIT 1
  `)
  const createevent = eventstmt.get(cleanid, withmd, stripped)

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
