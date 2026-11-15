import fs from 'node:fs'
import path from 'node:path'
import { parse, stringify } from 'yaml'
import { loadconfig, getvaultpath, gethistorypath } from '../core/config.js'
import { readuserpreferences, markinternalwrite } from '../vault/vault.js'
import { createconversation, saveconversation } from '../vault/conversations.js'
import { runagentchat } from './agent.js'
import { log } from '../core/logger.js'

const tickms = 30_000
const running = new Set()
let ticktimer = null
let tickbusy = false

function jobsdir(vaultdir, userid) {
  return path.join(vaultdir, 'system', String(userid || '').trim().toLowerCase(), 'jobs')
}

function runsfilepath(vaultdir, userid) {
  return path.join(jobsdir(vaultdir, userid), '.runs.yaml')
}

function ensurejobsdir(vaultdir, userid) {
  const dir = jobsdir(vaultdir, userid)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return dir
}

function readruns(vaultdir, userid) {
  const filepath = runsfilepath(vaultdir, userid)
  if (!fs.existsSync(filepath)) return {}
  try {
    const raw = parse(fs.readFileSync(filepath, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function writeruns(vaultdir, userid, runs) {
  ensurejobsdir(vaultdir, userid)
  const filepath = runsfilepath(vaultdir, userid)
  const body = stringify(runs || {})
  markinternalwrite(filepath, body)
  fs.writeFileSync(filepath, body, 'utf8')
}

// normalize to 24h HH:MM --------------------
export function parsetimehhmm(raw) {
  const text = String(raw || '').trim().toLowerCase()
  if (!text) return null

  const ampm = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i)
  if (ampm) {
    let hour = Number(ampm[1])
    const minute = Number(ampm[2] || '0')
    if (hour < 1 || hour > 12 || minute > 59) return null
    const period = ampm[3].toLowerCase()
    if (period === 'am') {
      if (hour === 12) hour = 0
    } else if (hour !== 12) {
      hour += 12
    }
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  }

  const match = text.match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function hhmmtoMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

function formatparts(date, timezone, options) {
  const opts = { ...options }
  if (timezone) opts.timeZone = timezone
  try {
    return Object.fromEntries(
      new Intl.DateTimeFormat('en-US', opts).formatToParts(date).map((p) => [p.type, p.value])
    )
  } catch {
    return Object.fromEntries(
      new Intl.DateTimeFormat('en-US', options).formatToParts(date).map((p) => [p.type, p.value])
    )
  }
}

function localhhmm(date, timezone) {
  const parts = formatparts(date, timezone, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  let hour = parts.hour
  // some locales still emit 24 as 24 --------------------
  if (hour === '24') hour = '00'
  return `${String(hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`
}

function localdatekey(date, timezone) {
  const parts = formatparts(date, timezone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return `${parts.year}-${parts.month}-${parts.day}`
}

function resolvetimezone(vaultdir, userid, conf) {
  const prefs = readuserpreferences(vaultdir, userid) || {}
  return (
    prefs.timezone ||
    conf.location?.timezone ||
    conf.timezone ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    'UTC'
  )
}

export function listjobs(vaultdir, userid) {
  const dir = jobsdir(vaultdir, userid)
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const name of fs.readdirSync(dir)) {
    if (!/\.ya?ml$/i.test(name)) continue
    if (name.startsWith('.')) continue
    const full = path.join(dir, name)
    let stat
    try {
      stat = fs.statSync(full)
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    let raw
    try {
      raw = parse(fs.readFileSync(full, 'utf8'))
    } catch (err) {
      out.push({
        name: name.replace(/\.ya?ml$/i, ''),
        path: `system/${userid}/jobs/${name}`,
        error: `invalid yaml: ${err.message || err}`,
      })
      continue
    }
    if (!raw || typeof raw !== 'object') {
      out.push({
        name: name.replace(/\.ya?ml$/i, ''),
        path: `system/${userid}/jobs/${name}`,
        error: 'job file must be a yaml object with time and prompt',
      })
      continue
    }
    const jobname = name.replace(/\.ya?ml$/i, '')
    const time = parsetimehhmm(raw.time)
    const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : ''
    if (!time || !prompt) {
      out.push({
        name: jobname,
        path: `system/${userid}/jobs/${name}`,
        error: 'job needs time (HH:MM) and prompt',
        raw_time: raw.time,
      })
      continue
    }
    out.push({
      name: jobname,
      path: `system/${userid}/jobs/${name}`,
      time,
      prompt,
    })
  }
  return out
}

function humanusers(conf) {
  return (conf.users || [])
    .filter((u) => !u.bot && u.role !== 'ai')
    .map((u) => ({
      id: u.username || u.id,
      admin: Boolean(u.admin),
    }))
    .filter((u) => u.id)
}

function jobdue(job, now, timezone, lastday) {
  const today = localdatekey(now, timezone)
  if (lastday === today) return false
  const nowmins = hhmmtoMinutes(localhhmm(now, timezone))
  const jobmins = hhmmtoMinutes(job.time)
  return nowmins >= jobmins
}

async function runjob(vaultdir, historydir, userid, isadmin, job) {
  const key = `${userid}/${job.name}`
  if (running.has(key)) return
  running.add(key)

  const title = `JOB: ${job.name}, ${job.time}`
  const started = new Date().toISOString()
  let conv = null

  try {
    log.agent('job', `${userid}/${job.name}`, `starting at ${job.time}`)
    conv = createconversation(vaultdir, userid, { title })

    const displaylog = [{
      role: 'user',
      prompt: job.prompt,
      attachments: [],
      active_note_id: null,
      open_tabs: [],
      timestamp: started,
      job: { name: job.name, time: job.time, path: job.path },
    }]

    // save prompt first so a crash still leaves a trail --------------------
    saveconversation(vaultdir, userid, conv.id, {
      title,
      display_log: displaylog,
      gemini_history: [],
      draft: { text: '', attachments: [] },
    })

    const result = await runagentchat(job.prompt, {
      active_user_id: userid,
      is_admin: isadmin,
      active_note_id: null,
      open_tabs: [],
      history: [],
      attachments: [],
    })

    displaylog.push({
      role: 'assistant',
      thought: result.thought || null,
      tool_calls: result.tool_calls_folded || [],
      reply: result.reply || '',
      options: result.options || [],
      timestamp: new Date().toISOString(),
    })

    saveconversation(vaultdir, userid, conv.id, {
      title,
      display_log: displaylog,
      gemini_history: result.history || [],
      model: result.model || null,
      last_system_prompt_meta: result.system_prompt_meta || null,
      draft: { text: '', attachments: [] },
    })

    log.agent('job', `${userid}/${job.name}`, `done → ${conv.id}`)
  } catch (err) {
    const errmsg = String(err?.message || err || 'job failed')
    log.agent('job', `${userid}/${job.name}`, `error: ${errmsg}`)
    try {
      if (!conv) {
        conv = createconversation(vaultdir, userid, { title })
      }
      const displaylog = [
        {
          role: 'user',
          prompt: job.prompt,
          attachments: [],
          active_note_id: null,
          open_tabs: [],
          timestamp: started,
          job: { name: job.name, time: job.time, path: job.path },
        },
        {
          role: 'assistant',
          error: errmsg,
          timestamp: new Date().toISOString(),
        },
      ]
      saveconversation(vaultdir, userid, conv.id, {
        title,
        display_log: displaylog,
        gemini_history: [],
        draft: { text: '', attachments: [] },
      })
    } catch (saveerr) {
      log.agent('job', `${userid}/${job.name}`, `failed to save error log: ${saveerr.message || saveerr}`)
    }
  } finally {
    running.delete(key)
  }
}

async function tickonce() {
  if (tickbusy) return
  tickbusy = true
  try {
    const conf = loadconfig()
    const vaultdir = getvaultpath(conf)
    const historydir = gethistorypath(conf)
    const now = new Date()

    for (const user of humanusers(conf)) {
      ensurejobsdir(vaultdir, user.id)
      const timezone = resolvetimezone(vaultdir, user.id, conf)
      const today = localdatekey(now, timezone)
      const runs = readruns(vaultdir, user.id)
      const jobs = listjobs(vaultdir, user.id)
      let runsdirty = false

      for (const job of jobs) {
        if (job.error) continue
        const lastday = typeof runs[job.name] === 'string' ? runs[job.name] : null
        if (!jobdue(job, now, timezone, lastday)) continue

        // stamp before run so a long job does not double fire on next tick --------------------
        runs[job.name] = today
        runsdirty = true
        writeruns(vaultdir, user.id, runs)

        await runjob(vaultdir, historydir, user.id, user.admin, job)
      }

      if (runsdirty) {
        // already written per due job
      }
    }
  } catch (err) {
    log.agent('job', 'tick', err.message || String(err))
  } finally {
    tickbusy = false
  }
}

export function startjobscheduler() {
  if (ticktimer) return
  log.agent('job', 'scheduler', `watching system/<user>/jobs every ${tickms / 1000}s`)
  // catch up shortly after boot --------------------
  setTimeout(() => {
    tickonce().catch(() => {})
  }, 5_000)
  ticktimer = setInterval(() => {
    tickonce().catch(() => {})
  }, tickms)
  if (typeof ticktimer.unref === 'function') ticktimer.unref()
}

export function stopjobscheduler() {
  if (!ticktimer) return
  clearInterval(ticktimer)
  ticktimer = null
}
