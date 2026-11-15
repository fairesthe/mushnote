// optional ffmpeg binary from ffmpeg-static for yt-dlp merge and mp3 --------------------

import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire(import.meta.url)

let cached
let probed = false

export function getffmpegpath() {
  if (probed) return cached ?? null
  probed = true
  cached = null
  try {
    const p = require('ffmpeg-static')
    if (p && typeof p === 'string' && fs.existsSync(p)) {
      cached = p
    }
  } catch {
    // package optional at install time
  }
  return cached
}

export function ytdlpffmpegopts() {
  const loc = getffmpegpath()
  if (!loc) return {}
  return { ffmpegLocation: loc }
}

export function hasffmpeg() {
  return Boolean(getffmpegpath())
}
