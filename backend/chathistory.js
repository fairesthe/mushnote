import { log } from './logger.js'

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

function shrinktooloutput(name, output) {
  let text = ''
  if (output == null) return ''
  if (typeof output === 'string') {
    text = output
  } else if (typeof output === 'object') {
    if (typeof output.output === 'string') {
      text = output.output
    } else if (typeof output.text === 'string') {
      text = output.text
    } else {
      text = JSON.stringify(output)
    }
  } else {
    text = String(output)
  }

  if (text.length <= maxtooloutputchars) return text

  if (name === 'file_open' || name === 'file_view' || name === 'file_outline') {
    const header = text.split('\n')[0] || text.slice(0, 80)
    return `${header}\n[truncated file payload in history: ${text.length} chars]`
  }

  return `${text.slice(0, maxtooloutputchars)}...[truncated ${text.length} chars]`
}

function compressparts(parts, aggressive) {
  if (!Array.isArray(parts)) return []
  const out = []

  for (const part of parts) {
    if (!part || typeof part !== 'object') continue

    if (part.functionResponse) {
      const name = part.functionResponse?.name || 'tool'
      const response = part.functionResponse?.response || {}
      const rawoutput = response.output !== undefined ? response.output : response
      const summary = shrinktooloutput(name, rawoutput)
      out.push({
        functionResponse: {
          name,
          response: { output: summary }
        }
      })
      continue
    }

    if (part.functionCall) {
      const name = part.functionCall?.name || 'tool'
      out.push({
        functionCall: {
          name,
          args: aggressive ? shrinktoolargs(part.functionCall?.args) : part.functionCall?.args
        }
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
      if (text.trim()) out.push({ text })
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

  return compressed
}
