import { log } from '../../core/logger.js'

const maxhistoryturns = 24
const recentfullturns = 6
const maxtextchars = 1200
const maxtooloutputchars = 280

function normalizerole(role) {
  if (role === 'assistant') return 'model'
  if (role === 'model' || role === 'user') return role
  return 'user'
}

function turnfromlegacy(entry) {
  const role = normalizerole(entry.role)
  const text = entry.content || entry.text || entry.prompt || entry.reply || ''
  if (!text) return null
  return { role, parts: [{ text }] }
}

function turnfromsdk(entry) {
  if (!entry || typeof entry !== 'object') return null
  const role = normalizerole(entry.role)
  const parts = Array.isArray(entry.parts) ? entry.parts : []
  if (parts.length === 0) {
    const text = entry.content || entry.text || ''
    if (!text) return null
    return { role, parts: [{ text }] }
  }
  return { role, parts }
}

function normalizeturns(rawhistory) {
  if (!Array.isArray(rawhistory)) return []
  const turns = []
  for (const entry of rawhistory) {
    const turn = Array.isArray(entry?.parts) ? turnfromsdk(entry) : turnfromlegacy(entry)
    if (turn) turns.push(turn)
  }
  return turns
}

function shrinktoolargs(args) {
  if (!args || typeof args !== 'object') return args
  const copy = { ...args }
  for (const key of ['replacement_text', 'target_text', 'content', 'edits']) {
    const val = copy[key]
    if (typeof val === 'string' && val.length > 240) {
      copy[key] = `${val.slice(0, 240)}...[truncated in history]`
    }
  }
  return copy
}

function tooloutputtext(output) {
  if (output == null) return ''
  if (typeof output === 'string') return output
  if (typeof output === 'object') {
    if (typeof output.output === 'string') return output.output
    if (typeof output.text === 'string') return output.text
    return JSON.stringify(output)
  }
  return String(output)
}

export function compacttooloutput(name, text) {
  if (!text) return null

  if (name === 'web_search') {
    try {
      const data = JSON.parse(text)
      const compact = {
        engine: data.engine,
        query: data.query,
        news: Boolean(data.news),
        search_type: data.search_type || (data.news ? 'news' : 'web'),
        general: data.general,
        results: (data.results || []).slice(0, 10).map((r) => {
          const row = {
            title: r.title,
            url: r.url,
            description: typeof r.description === 'string' ? r.description.slice(0, 200) : '',
          }
          if (r.date) row.date = r.date
          if (r.source) row.source = r.source
          return row
        }),
      }
      if (data.reply_hint) compact.reply_hint = data.reply_hint
      if (data.ai_overview) {
        compact.ai_overview = {
          blocks: (data.ai_overview.blocks || []).slice(0, 8).map((b) => ({
            type: b.type,
            text: typeof b.text === 'string' ? b.text.slice(0, 300) : '',
          })),
          references: (data.ai_overview.references || []).slice(0, 6),
        }
        compact.ai_overview_source_tag = data.ai_overview_source_tag || '[web:google.com]'
      }
      if (data.ai_overview_note) compact.ai_overview_note = data.ai_overview_note
      return JSON.stringify(compact)
    } catch {
      return null
    }
  }

  if (name === 'web_read_page') {
    try {
      const data = JSON.parse(text)
      const out = {
        url: data.url,
        source_tag: data.source_tag,
        format: data.format,
        char_count: data.char_count,
        truncated: data.truncated,
        content: typeof data.content === 'string' ? data.content.slice(0, 4000) : '',
      }
      if (data.reply_hint) out.reply_hint = data.reply_hint
      return JSON.stringify(out)
    } catch {
      return null
    }
  }

  if (name === 'youtube_video') {
    try {
      const data = JSON.parse(text)
      const action = data.action || 'info'
      if (action === 'download') {
        return JSON.stringify({
          action: 'download',
          media: data.media,
          path: data.path,
          title: data.title,
          format: data.format,
          size: data.size,
          reply_hint: data.reply_hint,
        })
      }
      if (action === 'transcript') {
        const total =
          typeof data.char_count === 'number'
            ? data.char_count
            : typeof data.transcript === 'string'
              ? data.transcript.length
              : 0
        return JSON.stringify({
          action: 'transcript',
          detail: data.detail || 'regular',
          title: data.title,
          creator: data.creator,
          description: typeof data.description === 'string' ? data.description.slice(0, 400) : '',
          source_tag: data.source_tag,
          truncated: data.truncated,
          char_count: total,
          reply_hint: data.reply_hint,
          transcript_note: total
            ? `captions fetched (${total} chars, detail ${data.detail || 'regular'}); transcript body omitted from folded tool output`
            : 'captions fetched; transcript omitted',
        })
      }
      return JSON.stringify({
        action: 'info',
        title: data.title,
        creator: data.creator,
        description: typeof data.description === 'string' ? data.description.slice(0, 400) : '',
        duration_seconds: data.duration_seconds,
        source_tag: data.source_tag,
        reply_hint: data.reply_hint,
      })
    } catch {
      return null
    }
  }

  return null
}

function shrinktooloutput(name, output) {
  const text = tooloutputtext(output)
  if (!text) return ''

  const compacted = compacttooloutput(name, text)
  if (compacted != null) return compacted

  if (text.length <= maxtooloutputchars) return text

  if (name === 'textfile_read' || name === 'file_analyze' || name === 'textfile_history') {
    const header = text.split('\n')[0] || text.slice(0, 80)
    return `${header}\n[truncated file payload in history: ${text.length} chars]`
  }

  return `${text.slice(0, maxtooloutputchars)}...[truncated ${text.length} chars]`
}

export function foldtooloutputfordisplay(name, output) {
  const text = tooloutputtext(output)
  if (!text) return ''
  const compacted = compacttooloutput(name, text)
  if (compacted != null) return compacted
  if (text.length > 8000) {
    return `${text.slice(0, 8000)}\n...[debug copy truncated ${text.length} chars total]`
  }
  return text
}

function compressparts(parts, aggressive) {
  if (!Array.isArray(parts)) return []
  const out = []

  for (const part of parts) {
    if (!part || typeof part !== 'object') continue

    // ids pair calls with responses so they survive, media blobs inside responses do not --------------------
    if (part.functionResponse) {
      const fr = part.functionResponse
      const name = fr.name || 'tool'
      const response = fr.response || {}
      const iserror = response.error !== undefined && response.output === undefined
      const rawoutput = iserror ? response.error : (response.output !== undefined ? response.output : response)
      const summary = shrinktooloutput(name, rawoutput)
      const media = Array.isArray(fr.parts) && fr.parts.length ? ` [${fr.parts.length} media part(s) not stored in history]` : ''
      out.push({
        functionResponse: {
          ...(fr.id ? { id: fr.id } : {}),
          name,
          response: iserror ? { error: `${summary}${media}` } : { output: `${summary}${media}` }
        }
      })
      continue
    }

    // recent turns keep the thought signature so gemini 3 can pick its reasoning back up --------------------
    if (part.functionCall) {
      const fc = part.functionCall
      out.push({
        functionCall: {
          ...(fc.id ? { id: fc.id } : {}),
          name: fc.name || 'tool',
          args: aggressive ? shrinktoolargs(fc.args) : fc.args
        },
        ...(!aggressive && part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {})
      })
      continue
    }

    if (part.inlineData) {
      const mime = part.inlineData?.mimeType || 'media'
      out.push({ text: `[${mime} was shown in a prior turn, not stored in history]` })
      continue
    }

    if (typeof part.text === 'string') {
      let text = part.text
      if (part.thought) {
        continue
      }
      if (aggressive && text.length > maxtextchars) {
        text = `${text.slice(0, maxtextchars)}\n[truncated ${text.length - maxtextchars} chars]`
      }
      if (!text.trim()) continue
      out.push(!aggressive && part.thoughtSignature ? { text, thoughtSignature: part.thoughtSignature } : { text })
      continue
    }

    if (aggressive) {
      continue
    }
    out.push(part)
  }

  return out
}

// shrink tool payloads and cap turn count before sending to gemini --------------------
export function compresschathistory(rawhistory) {
  let turns = normalizeturns(rawhistory)
  if (turns.length === 0) return []

  const originalcount = turns.length
  if (turns.length > maxhistoryturns) {
    const dropped = turns.length - maxhistoryturns
    turns = [
      { role: 'user', parts: [{ text: `[${dropped} earlier chat turns omitted from context]` }] },
      ...turns.slice(-maxhistoryturns)
    ]
    log.agent('history', `dropped ${dropped} turns`, `keeping ${maxhistoryturns}`)
  }

  const splitat = Math.max(0, turns.length - recentfullturns)
  const compressed = turns.map((turn, idx) => {
    const aggressive = idx < splitat
    const parts = compressparts(turn.parts, aggressive)
    if (parts.length === 0) return null
    return { role: turn.role, parts }
  }).filter(Boolean)

  // a trailing call with no answer would poison the next request so drop it --------------------
  const last = compressed[compressed.length - 1]
  if (last?.role === 'model' && last.parts.some(p => p.functionCall)) {
    last.parts = last.parts.filter(p => !p.functionCall)
    if (last.parts.length === 0) compressed.pop()
  }

  return compressed
}
