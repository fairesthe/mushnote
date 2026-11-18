// youtube via yt-dlp (youtube-dl-exec)

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import defaultyoutubedl, { create } from 'youtube-dl-exec'
import { hasffmpeg, ytdlpffmpegopts } from './ffmpegpath.js'

// resolve yt-dlp binary: prefer local node_modules binary, fallback to system PATH --------------------
function getytdlrunner() {
  const localpath = defaultyoutubedl.constants?.YOUTUBE_DL_PATH
  if (localpath && fs.existsSync(localpath)) {
    return defaultyoutubedl
  }
  try {
    const sys = spawnSync('yt-dlp', ['--version'], { encoding: 'utf8' })
    if (sys.status === 0) {
      return create('yt-dlp')
    }
  } catch {}
  return defaultyoutubedl
}

const youtubedl = (...args) => getytdlrunner()(...args)

const defaultlangs = ['en', 'en-us', 'en-gb']

export function parseyoutubeurl(raw) {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return null
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  if (host === 'youtu.be') {
    const id = parsed.pathname.slice(1).split('/')[0]
    return id && /^[\w-]{6,}$/.test(id) ? id : null
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    if (parsed.pathname === '/watch') {
      return parsed.searchParams.get('v')
    }
    if (parsed.pathname.startsWith('/shorts/')) {
      return parsed.pathname.split('/')[2] || null
    }
    if (parsed.pathname.startsWith('/embed/')) {
      return parsed.pathname.split('/')[2] || null
    }
  }
  return null
}

export function normalizeyoutubeurl(raw) {
  const id = parseyoutubeurl(raw)
  if (!id) throw new Error('invalid or unsupported youtube url')
  return `https://www.youtube.com/watch?v=${id}`
}

const ytdlpflags = {
  noWarnings: true,
  noCheckCertificates: true,
  noPlaylist: true,
}

function ytdlflags() {
  return { ...ytdlpflags, ...ytdlpffmpegopts() }
}

export async function fetchvideoinfo(url) {
  const watchurl = normalizeyoutubeurl(url)
  const info = await youtubedl(watchurl, {
    ...ytdlflags(),
    dumpSingleJson: true,
    skipDownload: true,
  })
  if (!info || typeof info !== 'object') {
    throw new Error('could not read video metadata')
  }
  return info
}

function capdescription(text, maxchars = 6000) {
  const raw = String(text || '').trim()
  if (!raw) return ''
  if (raw.length <= maxchars) return raw
  return `${raw.slice(0, maxchars)}\n\n[description truncated: ${raw.length} chars total]`
}

export function youtubecreatorlabel(creator) {
  const c = String(creator || '').trim()
  return c || 'youtube'
}

export function slimvideoinfo(info, opts = {}) {
  const descap = Math.min(Math.max(opts.description_max || 6000, 500), 12000)
  const creator = youtubecreatorlabel(info.channel || info.uploader || '')
  return {
    url: String(info.webpage_url || info.original_url || '').trim() || undefined,
    video_id: info.id || null,
    title: String(info.title || '').trim(),
    creator,
    channel_id: info.channel_id || info.uploader_id || null,
    channel_url: info.channel_url || info.uploader_url || null,
    description: capdescription(info.description, descap),
    duration_seconds: typeof info.duration === 'number' ? info.duration : null,
    view_count: typeof info.view_count === 'number' ? info.view_count : null,
    upload_date: info.upload_date || null,
    categories: Array.isArray(info.categories) ? info.categories.slice(0, 6) : [],
    tags: Array.isArray(info.tags) ? info.tags.slice(0, 12) : [],
    source_tag: info.id ? `youtube:${info.id}` : 'youtube:video',
  }
}

export async function fetchvideodetails(url, opts = {}) {
  const watchurl = normalizeyoutubeurl(url)
  const info = await fetchvideoinfo(watchurl)
  return { ...slimvideoinfo(info, opts), url: watchurl }
}

function pickcaptiontracks(subs, langs, manual) {
  if (!subs || typeof subs !== 'object') return null
  const keys = Object.keys(subs)
  for (const want of langs) {
    const exact = keys.find((k) => k.toLowerCase() === want)
    if (exact && subs[exact]?.length) {
      return { lang: exact, tracks: subs[exact], manual }
    }
  }
  for (const want of langs) {
    const partial = keys.find((k) => k.toLowerCase().startsWith(want.split('-')[0]))
    if (partial && subs[partial]?.length) {
      return { lang: partial, tracks: subs[partial], manual }
    }
  }
  return null
}

function picksubtitleformat(tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null
  const order = ['vtt', 'srt', 'json3', 'ttml']
  for (const ext of order) {
    const hit = tracks.find((t) => t.ext === ext)
    if (hit?.url) return hit
  }
  return tracks.find((t) => t.url) || null
}

function parsecaptiontext(body, ext) {
  const raw = String(body || '')
  if (!raw.trim()) return ''
  if (ext === 'json3') {
    try {
      const data = JSON.parse(raw)
      const events = data?.events || []
      const lines = []
      for (const ev of events) {
        if (!ev?.segs) continue
        const line = ev.segs.map((s) => s.utf8 || '').join('').replace(/\n/g, ' ').trim()
        if (line) lines.push(line)
      }
      return dedupelines(lines).join('\n')
    } catch {
      return ''
    }
  }
  const lines = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('WEBVTT')) continue
    if (trimmed.startsWith('Kind:') || trimmed.startsWith('Language:')) continue
    if (/^\d+$/.test(trimmed)) continue
    if (/^\d{2}:\d{2}/.test(trimmed) && trimmed.includes('-->')) continue
    if (/^NOTE/.test(trimmed)) continue
    if (/^\{.*\}$/.test(trimmed)) continue
    lines.push(trimmed)
  }
  return dedupelines(lines).join('\n')
}

function dedupelines(lines) {
  const out = []
  let prev = ''
  for (const line of lines) {
    if (!line || line === prev) continue
    out.push(line)
    prev = line
  }
  return out
}

async function downloadcaptionurl(track) {
  const res = await fetch(track.url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; mushnote/1.0)',
    },
  })
  if (!res.ok) {
    throw new Error(`caption download failed (${res.status})`)
  }
  return res.text()
}

export async function fetchtranscript(url, opts = {}) {
  const watchurl = normalizeyoutubeurl(url)
  const langs = (opts.langs || defaultlangs).map((l) => String(l).toLowerCase())
  const info = await fetchvideoinfo(watchurl)

  let pick = pickcaptiontracks(info.subtitles, langs, true)
  if (!pick) {
    pick = pickcaptiontracks(info.automatic_captions, langs, false)
  }
  if (!pick) {
    throw new Error('no captions available for this video (manual or auto)')
  }

  const format = picksubtitleformat(pick.tracks)
  if (!format?.url) {
    throw new Error('no downloadable caption format found')
  }

  const body = await downloadcaptionurl(format)
  const text = parsecaptiontext(body, format.ext)
  if (!text.trim()) {
    throw new Error('caption file was empty')
  }

  const meta = slimvideoinfo(info, opts)
  return {
    ...meta,
    url: watchurl,
    video_id: meta.video_id || parseyoutubeurl(watchurl),
    language: pick.lang,
    manual_captions: pick.manual,
    transcript: text,
    source_tag: `${meta.source_tag} (${pick.lang}${pick.manual ? '' : ', auto'})`,
  }
}

function findnewfile(dir, videoid, ext) {
  if (!fs.existsSync(dir)) return null
  const exts = Array.isArray(ext) ? ext : [ext]
  const lowered = exts.map((e) => String(e).toLowerCase())
  for (const name of fs.readdirSync(dir)) {
    const hit = lowered.some((e) => name.toLowerCase().endsWith(`.${e}`))
    if (!hit) continue
    if (videoid && name.includes(videoid)) {
      return path.join(dir, name)
    }
  }
  let newest = null
  let mtime = 0
  for (const name of fs.readdirSync(dir)) {
    const hit = lowered.some((e) => name.toLowerCase().endsWith(`.${e}`))
    if (!hit) continue
    const full = path.join(dir, name)
    const stat = fs.statSync(full)
    if (stat.mtimeMs >= mtime) {
      mtime = stat.mtimeMs
      newest = full
    }
  }
  return newest
}

const videowebmdefault =
  'best*[acodec!=none][vcodec!=none][ext=webm]/best*[acodec!=none][vcodec!=none][ext=mp4]/best[acodec!=none][vcodec!=none]/b'
const videomergedformat = 'bestvideo*+bestaudio/best'

function pickvideoformat(formatoverride) {
  const f = String(formatoverride || '').trim()
  if (!f) return videowebmdefault
  const lower = f.toLowerCase()
  if (lower === 'merge' || lower === 'mp4') {
    return hasffmpeg() ? videomergedformat : videowebmdefault
  }
  if (lower === 'webm') return videowebmdefault
  return f
}

function videowantmerge(formatoverride) {
  const lower = String(formatoverride || '').trim().toLowerCase()
  return hasffmpeg() && (lower === 'merge' || lower === 'mp4')
}

export async function downloadyoutubemedia(url, vaultdir, opts = {}) {
  const watchurl = normalizeyoutubeurl(url)
  const info = await fetchvideoinfo(watchurl)
  const videoid = info.id || parseyoutubeurl(watchurl)
  const folder = String(opts.folder || 'media/youtube').replace(/\\/g, '/').replace(/^\/+/, '')
  const outdir = path.join(vaultdir, ...folder.split('/'))
  fs.mkdirSync(outdir, { recursive: true })

  const template = path.join(outdir, '%(title).80B [%(id)s].%(ext)s')
  const media = String(opts.media || 'audio').toLowerCase()

  if (media === 'video') {
    const formatopt = String(opts.format || '').trim()
    let merged = videowantmerge(formatopt)
    let note = merged ? 'merged mp4 (format mp4 or merge)' : 'muxed webm preferred'

    async function runvideo(fmt, mergefmt) {
      await youtubedl(watchurl, {
        ...ytdlflags(),
        format: fmt,
        mergeOutputFormat: mergefmt || undefined,
        output: template,
      })
    }

    function formatunavailable(err) {
      const msg = String(err?.message || err || '').toLowerCase()
      return msg.includes('requested format is not available') || msg.includes('format is not available')
    }

    try {
      await runvideo(pickvideoformat(formatopt), merged ? 'mp4' : undefined)
    } catch (err) {
      if (hasffmpeg() && !merged && !videowantmerge(formatopt) && formatunavailable(err)) {
        merged = true
        try {
          await runvideo(videomergedformat, 'webm')
          note = 'merged webm with ffmpeg (youtube had no single muxed file)'
        } catch {
          await runvideo(videomergedformat, 'mp4')
          note = 'merged mp4 with ffmpeg (youtube had no single muxed file)'
        }
      } else {
        throw err
      }
    }

    const diskpath = findnewfile(outdir, videoid, ['mp4', 'webm', 'mkv', 'm4v'])
    if (!diskpath) {
      throw new Error(
        merged
          ? 'video download finished but output file was not found'
          : 'video download finished but no muxed file found (install ffmpeg-static or system ffmpeg)'
      )
    }
    const ext = path.extname(diskpath).slice(1).toLowerCase() || 'webm'
    const relparts = path.relative(vaultdir, diskpath).split(path.sep).join('/')
    return {
      ok: true,
      media: 'video',
      path: relparts,
      title: String(info.title || path.basename(diskpath)).trim(),
      video_id: videoid,
      format: ext,
      size: fs.statSync(diskpath).size,
      url: watchurl,
      note,
    }
  }

  const format = String(opts.format || 'mp3').toLowerCase()
  await youtubedl(watchurl, {
    ...ytdlflags(),
    extractAudio: true,
    audioFormat: format,
    audioQuality: 0,
    embedThumbnail: true,
    addMetadata: true,
    output: template,
  })

  const diskpath = findnewfile(outdir, videoid, format)
  if (!diskpath) {
    throw new Error('download finished but output file was not found')
  }

  const relparts = path.relative(vaultdir, diskpath).split(path.sep).join('/')
  return {
    ok: true,
    media: 'audio',
    path: relparts,
    title: String(info.title || path.basename(diskpath)).trim(),
    video_id: videoid,
    format,
    size: fs.statSync(diskpath).size,
    url: watchurl,
  }
}

export async function downloadaudio(url, vaultdir, opts = {}) {
  return downloadyoutubemedia(url, vaultdir, { ...opts, media: 'audio' })
}

// hard ceiling keeps one caption dump inside flash-lite's 1m context with room left --------------------
const transcriptabsolutemax = 500000

export function captranscript(text, maxchars) {
  const cap = Math.max(1000, Math.min(maxchars || 24000, transcriptabsolutemax))
  const raw = String(text || '')
  if (raw.length <= cap) {
    return { text: raw, truncated: false, char_count: raw.length }
  }
  return {
    text: `${raw.slice(0, cap)}\n\n[transcript truncated: ${raw.length} chars total]`,
    truncated: true,
    char_count: raw.length,
  }
}
