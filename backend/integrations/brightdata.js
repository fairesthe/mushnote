// bright data serp and web read

const serpendpoint = 'https://api.brightdata.com/request'
const serpengine = 'google'
const serpresultsperpage = 10

export function getbrightdataconfig(conf) {
  const bd = conf?.brightdata || {}
  const apikey = String(bd.api_key || '').trim()
  const serpzone = String(bd.serp_zone || '').trim()
  const webviewzone = String(bd.webview_zone || '').trim()
  return {
    apikey,
    serpzone,
    webviewzone,
    country: bd.country || 'us',
    serpenabled: Boolean(apikey && serpzone),
    webreadenabled: Boolean(apikey && webviewzone),
  }
}

async function postbrightdata(apikey, body) {
  const response = await fetch(serpendpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apikey}`,
    },
    body: JSON.stringify(body),
  })

  const text = await response.text()
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    payload = text
  }

  if (!response.ok) {
    const msg =
      (payload && typeof payload === 'object' && (payload.error || payload.message || payload.errors?.[0]?.message)) ||
      (typeof payload === 'string' ? payload : text.slice(0, 280))
    throw new Error(`bright data ${response.status}: ${msg}`)
  }

  return payload
}

function unwrapserppayload(payload) {
  if (payload?.organic || payload?.general) {
    return payload
  }

  if (payload?.status_code != null) {
    const errcode = payload.headers?.['x-brd-error-code']
    const errmsg = payload.headers?.['x-brd-error']
    if (payload.status_code !== 200) {
      const hint =
        errcode === 'parse_no_parser'
          ? ' serp zone must use google full json'
          : ''
      throw new Error(`${errmsg || 'serp request failed'} (${payload.status_code})${hint}`)
    }

    const body = payload.body
    if (typeof body === 'string') {
      try {
        return JSON.parse(body)
      } catch {
        return { raw_body: body }
      }
    }
    if (body && typeof body === 'object') {
      return body
    }
  }

  return payload
}

function unwraprawbody(payload) {
  if (typeof payload === 'string') return payload
  if (payload?.status_code != null) {
    const errmsg = payload.headers?.['x-brd-error']
    if (payload.status_code !== 200) {
      throw new Error(`${errmsg || 'request failed'} (${payload.status_code})`)
    }
    const body = payload.body
    if (typeof body === 'string') return body
    if (body && typeof body === 'object' && body.markdown) return String(body.markdown)
  }
  if (payload?.markdown) return String(payload.markdown)
  if (payload?.content) return String(payload.content)
  return ''
}

function displaylinktohref(display) {
  const dl = String(display || '').trim()
  if (!dl) return ''
  if (/^https?:\/\//i.test(dl)) return dl
  return `https://${dl.replace(/^\/\//, '')}`
}

export function canonurl(raw, fallbackdisplay = '') {
  if (!raw) return displaylinktohref(fallbackdisplay)
  try {
    const parsed = new URL(raw)
    const isgoogle = parsed.hostname.includes('google.')

    if (isgoogle && parsed.pathname === '/url') {
      const direct = parsed.searchParams.get('url') || parsed.searchParams.get('q')
      if (direct && /^https?:\/\//i.test(direct)) return direct
    }

    if (isgoogle && parsed.pathname === '/goto') {
      const direct = parsed.searchParams.get('url')
      if (direct && /^https?:\/\//i.test(direct)) return direct
      const fromdisplay = displaylinktohref(fallbackdisplay)
      if (fromdisplay) return fromdisplay
    }

    if (isgoogle && (parsed.pathname === '/url' || parsed.pathname === '/goto')) {
      const fromdisplay = displaylinktohref(fallbackdisplay)
      if (fromdisplay) return fromdisplay
      return raw
    }
  } catch {
    return raw
  }
  return raw
}

export function resolvefetchurl(rawurl) {
  const trimmed = String(rawurl || '').trim()
  if (!trimmed) throw new Error('url required')
  const url = canonurl(trimmed, '')
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('url must be http or https')
  }

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('invalid url')
  }

  const host = parsed.hostname.toLowerCase()
  if (host.includes('google.') && (parsed.pathname === '/url' || parsed.pathname === '/goto')) {
    throw new Error('unwrap google redirect links before web_read_page')
  }
  if ((host.includes('google.') && parsed.pathname.startsWith('/search')) || host === 'google.com') {
    if (parsed.pathname.startsWith('/search')) {
      throw new Error('cannot fetch google search results pages, use web_search or a result url')
    }
  }
  if (host.includes('bing.com') && parsed.pathname.toLowerCase().startsWith('/search')) {
    throw new Error('cannot fetch bing search pages, use web_search or a result url')
  }
  return url
}

// short url for [web:...] cite badges (no query or hash) --------------------
export function citeshorturl(rawurl) {
  const resolved = resolvefetchurl(rawurl)
  try {
    const parsed = new URL(resolved)
    let path = parsed.pathname || '/'
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1)
    }
    return `${parsed.origin}${path}`
  } catch {
    return resolved
  }
}

function slimresult(item) {
  if (!item) return null
  const display = item.display_link || item.source || ''
  const url = canonurl(item.link || item.url || '', display)
  if (!url) return null
  const description = String(item.description || item.snippet || '').trim()
  const row = {
    title: String(item.title || '').trim(),
    url,
    description: description.slice(0, 600),
    source: String(item.source || item.display_link || '').trim(),
  }
  const date = String(item.date || item.published || '').trim()
  if (date) row.date = date.slice(0, 80)
  return row
}

function normalizeresults(payload, { news = false } = {}) {
  const organic = payload?.organic || payload?.results?.organic || []
  const newsrows = payload?.news || payload?.results?.news || []
  const source = news ? (newsrows.length ? newsrows : organic) : (organic.length ? organic : newsrows)
  const rows = []
  for (const item of source) {
    const row = slimresult(item)
    if (row) rows.push(row)
  }
  return rows
}

function flattenoverviewtexts(texts) {
  if (!Array.isArray(texts)) return []
  const blocks = []
  for (const t of texts) {
    const snippet = String(t?.snippet || '').trim()
    if (Array.isArray(t?.list)) {
      for (const item of t.list) {
        const line = String(item?.snippet || '').trim()
        if (line) blocks.push({ type: item.type || 'list_item', text: line.slice(0, 900) })
      }
    }
    if (snippet) {
      blocks.push({ type: t.type || 'paragraph', text: snippet.slice(0, 1200) })
    }
  }
  return blocks
}

function slimaioverview(overview) {
  if (!overview || typeof overview !== 'object') return null
  const blocks = flattenoverviewtexts(overview.texts)
  const references = []
  for (const ref of overview.references || []) {
    const href = canonurl(ref.href || ref.link || '', ref.source || '')
    if (!href || !/^https?:\/\//i.test(href)) continue
    references.push({
      title: String(ref.title || '').trim().slice(0, 200),
      url: href,
      source: String(ref.source || '').trim().slice(0, 120),
    })
    if (references.length >= 12) break
  }
  if (blocks.length === 0 && references.length === 0) return null
  return { blocks, references }
}

function slimgeneral(general) {
  if (!general || typeof general !== 'object') return {}
  return {
    search_engine: general.search_engine,
    query: general.query,
    detected_query: general.detected_query,
    results_cnt: general.results_cnt,
    search_time: general.search_time,
    language: general.language,
    country: general.country,
    gl: general.gl,
  }
}

function countletters(str) {
  return (str.match(/[a-zA-Z]/g) || []).length
}

// drop runs of repetitive markdown chrome (images, empty nav links, duplicate lines)
function trimmarkdownbloat(content) {
  if (!content) return ''
  const lines = content.split('\n')
  const out = []
  let chromestreak = 0
  let prevtrimmed = ''

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      chromestreak = 0
      prevtrimmed = ''
      out.push(line)
      continue
    }

    if (trimmed === prevtrimmed) {
      continue
    }
    prevtrimmed = trimmed

    const letters = countletters(trimmed)
    const imgonly =
      /^!\[[^\]]*\]\([^)]+\)$/.test(trimmed) ||
      /^\[!\[[^\]]*\]\([^)]+\)\]\([^)]+\)$/.test(trimmed)
    const linkonly = /^\[[^\]]{0,80}\]\([^)]+\)$/.test(trimmed) && letters < 20
    const ischrome = imgonly || linkonly || (letters < 12 && /\[|\]|!\(/.test(trimmed))

    if (ischrome) {
      chromestreak += 1
      if (chromestreak <= 8) out.push(line)
      continue
    }

    chromestreak = 0
    out.push(line)
  }

  return out.join('\n').replace(/\n{4,}/g, '\n\n\n').trim()
}

function htmltidy(html) {
  if (!html) return ''
  let text = html
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '')
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '')
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|br|blockquote)>/gi, '\n')
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<[^>]+>/g, ' ')
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
  text = text.replace(/[ \t]+\n/g, '\n')
  text = text.replace(/\n{3,}/g, '\n\n')
  text = text.replace(/[ \t]{2,}/g, ' ')
  return text.trim()
}

function serpaiofailureretry(err) {
  const msg = String(err?.message || err || '').toLowerCase()
  return (
    msg.includes('502') ||
    msg.includes('rejected') ||
    msg.includes('response body was rejected') ||
    msg.includes('redirect location was rejected')
  )
}

function buildgoogleserpbody(cfg, query, page, withaio, { news = false } = {}) {
  const googlestart = (page - 1) * serpresultsperpage
  const start = googlestart > 0 ? `&start=${googlestart}` : ''
  // news mode skips ai overview (google news tab has none) --------------------
  const aioparam = withaio && !news ? '&brd_ai_overview=2' : ''
  const newsparam = news ? '&tbm=nws' : ''
  const targeturl = `https://www.google.com/search?q=${encodeURIComponent(query)}&brd_json=1&gl=us&hl=en${start}${newsparam}${aioparam}`
  return {
    zone: cfg.serpzone,
    url: targeturl,
    format: 'json',
    country: cfg.country,
  }
}

async function fetchserp(apikey, body) {
  const payload = await postbrightdata(apikey, body)
  return unwrapserppayload(payload)
}

export async function brightdatawebsearch(conf, query, opts = {}) {
  const cfg = getbrightdataconfig(conf)
  if (!cfg.serpenabled) {
    throw new Error('bright data not configured, set brightdata.api_key and brightdata.serp_zone in config.yaml')
  }

  const q = String(query || '').trim()
  if (!q) {
    throw new Error('query required')
  }

  const news = Boolean(opts.news)
  const page = Math.min(Math.max(Number(opts.page) || 1, 1), 10)
  const googlestart = (page - 1) * serpresultsperpage

  let aioretried = false
  let serp
  if (news) {
    try {
      serp = await fetchserp(cfg.apikey, buildgoogleserpbody(cfg, q, page, false, { news: true }))
    } catch (err) {
      // same flaky 502 path as organic, just retry the news url once --------------------
      if (!serpaiofailureretry(err)) throw err
      serp = await fetchserp(cfg.apikey, buildgoogleserpbody(cfg, q, page, false, { news: true }))
    }
  } else {
    try {
      serp = await fetchserp(cfg.apikey, buildgoogleserpbody(cfg, q, page, true))
    } catch (err) {
      if (!serpaiofailureretry(err)) {
        throw err
      }
      aioretried = true
      serp = await fetchserp(cfg.apikey, buildgoogleserpbody(cfg, q, page, false))
    }
  }
  const limit = Math.min(Math.max(opts.limit || 10, 1), 20)
  const rows = normalizeresults(serp, { news })
  const seen = new Set()
  const results = []
  for (const row of rows) {
    if (seen.has(row.url)) continue
    seen.add(row.url)
    results.push(row)
    if (results.length >= limit) break
  }

  const pagination = serp.pagination || {}
  const ai_overview = news ? null : slimaioverview(serp.ai_overview)

  const out = {
    provider: 'brightdata',
    engine: serpengine,
    query: q,
    news,
    search_type: news ? 'news' : 'web',
    page,
    results_per_page: serpresultsperpage,
    offset: googlestart,
    next_page: pagination.next_page ?? null,
    general: slimgeneral(serp.general),
    result_count: results.length,
    results,
  }
  if (news) {
    out.reply_hint = 'google news results: open urls with web_read_page if needed. cite page source_tag at paragraph end'
  } else if (ai_overview) {
    out.ai_overview = ai_overview
    out.ai_overview_source_tag = '[web:google.com]'
    out.reply_hint =
      'facts from ai_overview: cite [web:google.com] once at end of paragraph. prefer overview over opening many pages'
  } else {
    out.reply_hint = 'organic results only: open urls with web_read_page if needed. cite page source_tag at paragraph end'
  }
  if (!news) {
    if (aioretried) {
      out.ai_overview_note = 'overview capture failed, retried without ai overview'
    } else if (!ai_overview) {
      out.ai_overview_note = 'no google ai overview on this query'
    }
  }
  return out
}

export async function brightdatawebread(conf, rawurl, opts = {}) {
  const cfg = getbrightdataconfig(conf)
  if (!cfg.webreadenabled) {
    throw new Error('web read not configured, set brightdata.api_key and brightdata.webview_zone in config.yaml')
  }

  const url = resolvefetchurl(rawurl)
  const maxchars = Math.min(Math.max(Number(opts.max_chars) || 28000, 2000), 50000)

  let content = ''
  let contentformat = 'markdown'
  let markdownerr = null

  try {
    const payload = await postbrightdata(cfg.apikey, {
      zone: cfg.webviewzone,
      url,
      format: 'raw',
      data_format: 'markdown',
      country: opts.country || cfg.country || 'us',
    })
    content = unwraprawbody(payload).trim()
  } catch (err) {
    markdownerr = err.message
  }

  if (!content || content.length < 80) {
    try {
      const payload = await postbrightdata(cfg.apikey, {
        zone: cfg.webviewzone,
        url,
        format: 'raw',
        country: opts.country || cfg.country || 'us',
      })
      const html = unwraprawbody(payload)
      content = htmltidy(html)
      contentformat = 'text'
    } catch (err) {
      throw new Error(err.message || markdownerr || 'page read failed')
    }
  }

  content = trimmarkdownbloat(content)

  const truncated = content.length > maxchars
  const clipped = content.slice(0, maxchars)

  const citeurl = citeshorturl(url)
  return {
    provider: 'brightdata',
    url,
    cite_url: citeurl,
    format: contentformat,
    source_tag: `[web:${citeurl}]`,
    reply_hint: `quote using source_tag ${`[web:${citeurl}]`} at end of paragraph (plain site name in prose is fine)`,
    char_count: clipped.length,
    truncated,
    content: clipped,
  }
}
