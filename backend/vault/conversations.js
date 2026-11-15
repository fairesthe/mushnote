import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { markinternalwrite, markinternaldelete } from './vault.js'

const schemaversion = 1

function conversationsdir(vaultdir, userid) {
  const user = String(userid || '').trim().toLowerCase()
  return path.join(vaultdir, 'system', user, 'conversations')
}

function conversationfilepath(vaultdir, userid, convid) {
  const safeid = sanitizeconversationid(convid)
  return path.join(conversationsdir(vaultdir, userid), `${safeid}.json`)
}

export function sanitizeconversationid(raw) {
  const id = String(raw || '').trim()
  if (!id || !/^[a-zA-Z0-9_-]{8,64}$/.test(id)) return null
  return id
}

export function conversationvaultpath(userid, convid) {
  return `system/${String(userid).toLowerCase()}/conversations/${sanitizeconversationid(convid)}.json`
}

function readjsonfile(filepath) {
  if (!fs.existsSync(filepath)) return null
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'))
  } catch {
    return null
  }
}

function writejsonfile(filepath, data) {
  const parent = path.dirname(filepath)
  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true })
  }
  const body = `${JSON.stringify(data, null, 2)}\n`
  markinternalwrite(filepath, body)
  fs.writeFileSync(filepath, body, 'utf8')
}

export function listconversations(vaultdir, userid) {
  const dir = conversationsdir(vaultdir, userid)
  if (!fs.existsSync(dir)) return []
  const items = []
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const full = path.join(dir, name)
    let stat
    try {
      stat = fs.statSync(full)
    } catch {
      continue
    }
    const rec = readjsonfile(full)
    if (!rec?.id) continue
    items.push({
      id: rec.id,
      title: rec.title || 'new chat',
      created_at: rec.created_at || stat.birthtime.toISOString(),
      updated_at: rec.updated_at || stat.mtime.toISOString(),
      message_count: Array.isArray(rec.display_log) ? rec.display_log.length : 0,
    })
  }
  return items.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
}

export function readconversation(vaultdir, userid, convid) {
  const id = sanitizeconversationid(convid)
  if (!id) return null
  const rec = readjsonfile(conversationfilepath(vaultdir, userid, id))
  if (!rec || rec.id !== id) return null
  return rec
}

export function createconversation(vaultdir, userid, opts = {}) {
  const id = sanitizeconversationid(opts.id) || crypto.randomUUID()
  const now = new Date().toISOString()
  const record = {
    schema_version: schemaversion,
    id,
    title: String(opts.title || 'new chat').trim() || 'new chat',
    title_generated: false,
    created_at: now,
    updated_at: now,
    model: opts.model || null,
    gemini_history: [],
    display_log: [],
    last_system_prompt_meta: null,
  }
  const filepath = conversationfilepath(vaultdir, userid, id)
  writejsonfile(filepath, record)
  return record
}

export function saveconversation(vaultdir, userid, convid, patch) {
  const id = sanitizeconversationid(convid)
  if (!id) throw new Error('invalid conversation id')
  const existing = readconversation(vaultdir, userid, id)
  if (!existing) throw new Error('conversation not found')

  const now = new Date().toISOString()
  const record = {
    ...existing,
    ...patch,
    id,
    schema_version: schemaversion,
    updated_at: now,
    gemini_history: Array.isArray(patch?.gemini_history)
      ? patch.gemini_history
      : existing.gemini_history,
    display_log: Array.isArray(patch?.display_log) ? patch.display_log : existing.display_log,
  }

  writejsonfile(conversationfilepath(vaultdir, userid, id), record)
  return record
}

export function deleteconversation(vaultdir, userid, convid) {
  const id = sanitizeconversationid(convid)
  if (!id) return false
  const filepath = conversationfilepath(vaultdir, userid, id)
  if (!fs.existsSync(filepath)) return false
  markinternaldelete(filepath)
  fs.unlinkSync(filepath)
  return true
}