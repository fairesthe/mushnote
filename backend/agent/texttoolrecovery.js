// recover when flash models write fake s_call tool syntax instead of real function calls --------------------

const hallpattern =
  /(?:<\s*)?s_call:[^:{\s]+:([\w]+)\s*\{([^}]*)\}/gi
const barepattern = /\b(youtube_video|web_search|web_read_page|file_search|file_open|file_create|file_edit_diff)\s*\{([^}]*)\}/gi

function parsebracketargs(inner) {
  const args = {}
  const raw = String(inner || '').trim()
  if (!raw) return args
  const re = /(\w+):((?:https?:\/\/[^,}]+)|[^,}]+)/gi
  let m
  while ((m = re.exec(raw)) !== null) {
    const key = m[1].toLowerCase()
    let val = String(m[2] || '').trim()
    if (val === 'true') args[key] = true
    else if (val === 'false') args[key] = false
    else if (/^\d+$/.test(val)) args[key] = Number(val)
    else args[key] = val
  }
  return args
}

export function recovertoolcallsfromtext(text) {
  if (!text || typeof text !== 'string') return []
  const found = []
  const seen = new Set()

  function push(name, inner) {
    const tool = String(name || '').trim()
    if (!tool || seen.has(tool)) return
    const args = parsebracketargs(inner)
    if (tool === 'youtube_video' && !args.url && !args.action) return
    seen.add(tool)
    found.push({ name: tool, args })
  }

  for (const match of text.matchAll(hallpattern)) {
    push(match[1], match[2])
  }
  if (found.length === 0) {
    for (const match of text.matchAll(barepattern)) {
      push(match[1], match[2])
    }
  }
  return found
}

export function striphallucinatedtoolcalls(text) {
  if (!text || typeof text !== 'string') return text
  return text
    .replace(hallpattern, '')
    .replace(barepattern, '')
    .replace(/^\s*[<{]\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}