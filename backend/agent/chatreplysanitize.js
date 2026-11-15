// clean up model cite mistakes in final chat replies --------------------

function dedupeidenticalyoutubecites(paragraph) {
  const cites = [...paragraph.matchAll(/\[youtube:[^\]]+\]/gi)]
  if (cites.length <= 1) return paragraph
  const key = cites[0][0].toLowerCase()
  if (!cites.every((c) => c[0].toLowerCase() === key)) return paragraph
  let seen = 0
  const total = cites.length
  return paragraph
    .replace(/\[youtube:[^\]]+\]/gi, () => {
      seen++
      return seen < total ? '' : cites[total - 1][0]
    })
    .replace(/  +/g, ' ')
    .replace(/ ([.,;:])/g, '$1')
}

export function sanitizereplycites(text) {
  if (!text || typeof text !== 'string') return text

  let out = text

  // never render creator as a pill in "by creator" attribution
  out = out.replace(
    /\b(by|from)\s+\[youtube:([^\]|]+)(?:\|([^\]]+))?\]/gi,
    (_, prep, _id, creator) => (creator ? `${prep} ${creator}` : `${prep}`)
  )

  // bare youtube cite gets youtube as pill label when channel unknown
  out = out.replace(/\[youtube:([^|\]]+)\]/gi, (full, id) => {
    if (/\|/.test(full)) return full
    return `[youtube:${id.trim()}|youtube]`
  })
  out = out.replace(/\[youtube:([^|\]]+)\|\s*\]/gi, '[youtube:$1|youtube]')

  const blocks = out.split(/\n\n+/)
  out = blocks.map(dedupeidenticalyoutubecites).join('\n\n')

  return out.trim()
}
