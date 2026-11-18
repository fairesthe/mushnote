import path from 'node:path'
import fs from 'node:fs'
import { listnotes, readnote, writenote, movenoteorfolder, copynoteorfolder, deletenoteorfolder } from '../vault/vault.js'
import { gethourlytimeline, getfiletimeline, getrevisionbyid, formatlinediff, describechangestat } from '../vault/history.js'
import { getdoc, getdocifloaded, applydiff, migratedocentry, unliteralescapes, streaminsert, evictnotedoc, evictfolderdocs } from '../sync/sync.js'
import { log } from '../core/logger.js'
import { brightdatawebsearch, brightdatawebread, getbrightdataconfig } from '../integrations/brightdata.js'
import {
  fetchvideodetails,
  fetchtranscript,
  downloadyoutubemedia,
  captranscript,
  parseyoutubeurl,
  youtubecreatorlabel,
} from '../integrations/youtube.js'
import { extractarchive } from '../integrations/archive.js'
import { downloadorclone, islikelygiturl } from '../integrations/download.js'
import { runapirequest } from '../integrations/apirequest.js'
import { evaluatejavascript } from './evaljs.js'

// prefer in-memory ytext when a note is open in the collab doc --------------------
function noteforagent(vaultdir, noteid) {
  const note = readnote(vaultdir, noteid)
  if (!note) return null
  const live = getdocifloaded(noteid)
  if (live) note.content = live.getcontent()
  return note
}

// chat cite pills and raw html must never land in vault markdown --------------------
export function sanitizevaultmarkdown(text) {
  if (!text) return ''
  let out = String(text)
  // strip whole cite pills (names already live in the prose when the model writes correctly)
  out = out.replace(/\[(?:youtube|web|note|google|ai_overview):[^\]]*\]/gi, '')
  out = out.replace(/\\\[(?:youtube|web|note|google|ai_overview):[^\]]*\\\]/gi, '')
  out = out.replace(/<br\s*\/?>/gi, '\n')
  out = out.replace(/[ \t]+\n/g, '\n')
  out = out.replace(/ {2,}/g, ' ')
  out = out.replace(/ ([.,;:!?])/g, '$1')
  out = out.replace(/\n{4,}/g, '\n\n\n')
  return out.trimEnd() + (String(text).endsWith('\n') ? '\n' : '')
}

// tool schema declarations for gemini --------------------
export const tooldeclarations = [
  {
    name: 'file_search',
    description: 'Search the vault: text/code by title path and content, media by filename path folder media_kind and size metadata. Set recent=true to list recently modified files (text by default, or include media). Optional path scopes text search inside one file.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'Keywords or search phrase (matches text body, titles, paths, and media metadata). Optional when recent=true.' },
        path: { type: 'STRING', description: 'Optional specific text file path to search within instead of all files' },
        recent: {
          type: 'BOOLEAN',
          description: 'If true, list recently modified files instead of keyword search (default text/code only; set include_media=true to include media)'
        },
        include_media: {
          type: 'BOOLEAN',
          description: 'When recent=true, also include media files in the recent list'
        },
        limit: { type: 'INTEGER', description: 'Max results (default 5 for search, 8 for recent, max 15)' }
      }
    }
  },
  {
    name: 'web_search',
    description: 'Bright Data SERP: web results with ai_overview when present, or google news when news=true.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'Search query' },
        news: { type: 'BOOLEAN', description: 'If true, search Google News (tbm=nws) instead of web results. No ai_overview in news mode.' },
        page: { type: 'INTEGER', description: 'Result page (1-based, default 1). ~10 results per page.' },
        limit: { type: 'INTEGER', description: 'Max URLs to return from this page (default 10, max 20)' }
      },
      required: ['query']
    }
  },
  {
    name: 'web_read_page',
    description: 'Fetch one https url to markdown or text. Returns content, source_tag, reply_hint.',
    parameters: {
      type: 'OBJECT',
      properties: {
        url: { type: 'STRING', description: 'Full https URL of the article or page to read' },
        max_chars: { type: 'INTEGER', description: 'Max characters to return (default 28000, max 50000)' }
      },
      required: ['url']
    }
  },
  {
    name: 'youtube_video',
    description: 'yt-dlp youtube actions: info, transcript, download. Transcript detail regular (default) or full for vault notes. Returns metadata, source_tag, reply_hint.',
    parameters: {
      type: 'OBJECT',
      properties: {
        url: { type: 'STRING', description: 'YouTube watch, shorts, or youtu.be url' },
        action: {
          type: 'STRING',
          enum: ['info', 'transcript', 'download'],
          description: 'info = metadata only, transcript = metadata + captions, download = save media to vault'
        },
        detail: {
          type: 'STRING',
          enum: ['regular', 'full'],
          description: 'For transcript only: regular = capped captions for chat summaries (default). full = large captions when turning a video into a vault note or long document'
        },
        media: {
          type: 'STRING',
          enum: ['audio', 'video'],
          description: 'For download only: audio (default mp3) or video (default muxed webm). use video when user asks to download the video'
        },
        max_chars: {
          type: 'INTEGER',
          description: 'For transcript only: override char cap. regular default 24000 max 80000. full default 400000 max 500000'
        },
        format: {
          type: 'STRING',
          description:
            'For download audio: mp3 etc (default mp3). For video: default muxed webm; mp4 or merge for merged mp4 via ffmpeg'
        },
        folder: { type: 'STRING', description: 'For download only: vault folder (default media/youtube)' },
        open_in_tab: { type: 'BOOLEAN', description: 'For download only: open saved file in editor tab (default true)' }
      },
      required: ['url', 'action']
    }
  },
  {
    name: 'textfile_read',
    description: 'Read a vault text or code file by path. mode=content (default) returns body with optional heading or line slice. mode=outline returns markdown headings and line numbers without full body. For images audio video or pdf use file_analyze instead.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'Target text file path (e.g. todo.md, data.json, scripts/run.py)' },
        mode: {
          type: 'STRING',
          description: 'content (default) returns file body. outline returns headings and line numbers only'
        },
        heading: {
          type: 'STRING',
          description: 'Optional heading name to read only that section and its subsections (for markdown files, content mode)'
        },
        start_line: {
          type: 'INTEGER',
          description: 'Optional 1-based start line number (content mode)'
        },
        line_count: {
          type: 'INTEGER',
          description: 'Optional number of lines to read when using start_line (default 150, max 450)'
        },
        open_in_tab: {
          type: 'BOOLEAN',
          description: 'Optional. Set to true if the user asked to open this file in their editor tabs.'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'file_analyze',
    description: 'Analyze a vault media file (image pdf audio video). Default loads the file into Gemini for visual or audio analysis. mode=metadata returns size dates type and media kind without loading the binary.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'Target media path (e.g. media/chat-uploads/photo.jpg, media/recording.wav, docs/report.pdf)' },
        mode: {
          type: 'STRING',
          description: 'content (default) loads media into AI context. metadata returns path size dates extension and media kind only'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'file_open_for_user',
    description: 'Open an existing file in a new tab in the editor for the user. Call this whenever the user asks to open, view, or pull up a file in their workspace.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'Target file path (e.g. todo.md, recipes/soup.md, data.json)' }
      },
      required: ['path']
    }
  },
  {
    name: 'textfile_create',
    description: 'Create a brand new text file with any extension (e.g. .md, .txt, .json, .yaml, .csv, .py, .js). Supports markdown formatting, highlighted text (==text==), and LaTeX math ($math$ and $$math$$).',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'Target file path or filename (e.g. todo.md, config.yaml, scripts/run.py, notes.txt). Defaults to .md if no extension is specified.' },
        content: { type: 'STRING', description: 'Initial file content' },
        folder: { type: 'STRING', description: 'Optional folder path if not included in path' },
        tags: {
          type: 'ARRAY',
          items: { type: 'STRING' },
          description: 'Optional tags'
        }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'file_move',
    description: 'Rename or move a file or folder in the vault. Can move a file into a folder, rename a file, or rename and move an entire folder.',
    parameters: {
      type: 'OBJECT',
      properties: {
        source: {
          type: 'STRING',
          description: 'Current file path or folder path (e.g. "todo.md" or "recipes" or "notes/shopping.txt")'
        },
        destination: {
          type: 'STRING',
          description: 'Target file path, new folder path, or target directory path (e.g. "archive/todo.md" or "cookbooks" or "archive/")'
        }
      },
      required: ['source', 'destination']
    }
  },
  {
    name: 'file_copy',
    description: 'Copy a file or entire folder in the vault to a new name or destination folder.',
    parameters: {
      type: 'OBJECT',
      properties: {
        source: {
          type: 'STRING',
          description: 'Current file path or folder path to duplicate (e.g. "todo.md" or "recipes")'
        },
        destination: {
          type: 'STRING',
          description: 'Target file path, new folder name, or target directory path (e.g. "todo_backup.md" or "backup/" or "recipes_copy")'
        }
      },
      required: ['source', 'destination']
    }
  },
  {
    name: 'file_delete',
    description: 'Permanently delete a file or folder and all its contents from the vault. Use when the user asks to delete, remove, or trash a file or folder.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: {
          type: 'STRING',
          description: 'Target file or folder path to delete (e.g. "todo.md" or "recipes" or "archive/2025")'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'archive_extract',
    description: 'Extract a .zip, .jar, .7z, or .rar archive already in the vault into a new folder next to it (same name as the archive without extension). Use when the user asks to unzip, extract, or unpack an archive or jar.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: {
          type: 'STRING',
          description: 'Vault path to the archive (e.g. media/chat-uploads/pack.zip, libs/app.jar, downloads/data.7z)'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'download',
    description: 'Download a file from an http(s) url into the vault, or shallow-clone a public git repo when the url is a git host or ends in .git. Use for saving assets, archives, pdfs, or cloning public repositories. Not for youtube (use youtube_video), page text (use web_read_page), or json apis (use api_request).',
    parameters: {
      type: 'OBJECT',
      properties: {
        url: {
          type: 'STRING',
          description: 'http(s) file url, or public git repo url (github/gitlab/bitbucket/codeberg/.git)'
        },
        destination: {
          type: 'STRING',
          description: 'Vault destination. File download: file path or folder (default media/downloads). Git clone: folder path (default repo name).'
        },
        mode: {
          type: 'STRING',
          enum: ['auto', 'file', 'git'],
          description: 'auto detects git urls, file forces raw download, git forces clone'
        }
      },
      required: ['url']
    }
  },
  {
    name: 'eval_js',
    description: 'Execute a sandboxed JavaScript expression or snippet for calculations, arithmetic, date/time math, string formatting, statistics, or data transformations. Standard globals like Math, Date, JSON, RegExp, Array, Object, Map, Set, and console.log are available. Always use this tool to calculate or verify math rather than computing mentally.',
    parameters: {
      type: 'OBJECT',
      properties: {
        code: {
          type: 'STRING',
          description: 'JavaScript code to execute (e.g. "Math.sqrt(144)" or "const d1 = new Date(); return d1.toISOString()")'
        },
        timeout_ms: {
          type: 'INTEGER',
          description: 'Optional execution timeout in ms (default 2000, max 5000)'
        }
      },
      required: ['code']
    }
  },
  {
    name: 'api_request',
    description: 'Make an http(s) API request (GET/POST/PUT/PATCH/DELETE) and return status, headers, and a truncated response body. Use for JSON or form APIs. Not for reading article pages (web_read_page), saving files into the vault (download), or youtube.',
    parameters: {
      type: 'OBJECT',
      properties: {
        method: {
          type: 'STRING',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'],
          description: 'HTTP method (default GET)'
        },
        url: {
          type: 'STRING',
          description: 'http(s) endpoint url'
        },
        headers: {
          type: 'STRING',
          description: 'Optional JSON object of request headers, e.g. {"Authorization":"Bearer ...","Content-Type":"application/json"}'
        },
        body: {
          type: 'STRING',
          description: 'Optional request body for POST/PUT/PATCH (raw string or JSON text)'
        },
        save_to: {
          type: 'STRING',
          description: 'Optional vault path to save the full response body'
        },
        max_chars: {
          type: 'INTEGER',
          description: 'Max response body characters returned to the model (default 32000, max 100000)'
        },
        timeout_ms: {
          type: 'INTEGER',
          description: 'Request timeout in ms (default 30000, max 120000)'
        }
      },
      required: ['url']
    }
  },
  {
    name: 'textfile_edit_diff',
    description: 'Edit an existing text file using targeted diffs. Supports replacing text, deleting snippets, inserting before/after anchors, or appending to the end. For multiple changes, pass an edits array.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'Target file path (e.g. todo.md, config.yaml, scripts/run.py)' },
        mode: {
          type: 'STRING',
          enum: ['replace', 'insert_after', 'insert_before', 'delete', 'append'],
          description: 'replace: swaps target_text with replacement_text; insert_after: inserts replacement_text right after target_text; insert_before: inserts replacement_text right before target_text; delete: removes target_text; append: adds replacement_text to end of file'
        },
        target_text: {
          type: 'STRING',
          description: 'Existing snippet or anchor in the file (required for replace, insert_after, insert_before, and delete)'
        },
        replacement_text: {
          type: 'STRING',
          description: 'New text to insert, replace, or append (optional for delete)'
        },
        edits: {
          type: 'ARRAY',
          description: 'Optional array of edit objects to execute multiple diffs atomically: [{ mode, target_text, replacement_text }]',
          items: {
            type: 'OBJECT',
            properties: {
              mode: {
                type: 'STRING',
                enum: ['replace', 'insert_after', 'insert_before', 'delete', 'append']
              },
              target_text: { type: 'STRING' },
              replacement_text: { type: 'STRING' }
            },
            required: ['mode']
          }
        }
      },
      required: ['path']
    }
  },
  {
    name: 'textfile_history',
    description: 'Browse edit history for a text file, including deleted files. Start with view "hourly" to get one row per hour of edits (who, how many saves, chars and lines changed). To see what changed in one hour, call again with view "chunk" and that row\'s chunk_id: returns every save in that hour plus the combined line diff. To read or recover one exact snapshot, use view "revision" with a revision_id.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'Target file path, deleted files work too' },
        view: {
          type: 'STRING',
          enum: ['hourly', 'chunk', 'revision'],
          description: 'hourly (default) lists hour chunks, chunk drills into one hour, revision returns one full snapshot'
        },
        chunk_id: { type: 'STRING', description: 'For view chunk: the chunk_id from an hourly row' },
        revision_id: { type: 'STRING', description: 'For view revision: a revision_id from a chunk view' },
        limit: { type: 'INTEGER', description: 'For view hourly: max rows (default 12, max 40)' }
      },
      required: ['path']
    }
  },
]

// format relative time string --------------------
function formatrelative(iso) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${Math.max(1, mins)}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// extract headings from markdown text --------------------
export function extractheadings(markdown) {
  const lines = markdown.split('\n')
  const headings = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const match = line.match(/^(#{1,6})\s+(.+)$/)
    if (match) {
      headings.push({
        level: match[1].length,
        title: match[2].trim(),
        line: i + 1,
        raw: match[0]
      })
    }
  }

  return { headings, totallines: lines.length }
}

// find matching lines and snippets inside note content --------------------
function findmatchesincontent(content, query, maxmatches = 3) {
  const lines = content.split('\n')
  const q = query.toLowerCase()
  const matches = []
  let currentheading = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('#')) {
      currentheading = line.replace(/^#+\s*/, '').trim()
    }
    if (line.toLowerCase().includes(q)) {
      matches.push({
        line: i + 1,
        text: line.trim(),
        heading: currentheading
      })
      if (matches.length >= maxmatches) break
    }
  }
  return matches
}

// extract specific section under a heading --------------------
function getheadingsection(markdown, targetheading) {
  const lines = markdown.split('\n')
  const { headings } = extractheadings(markdown)
  const target = targetheading.toLowerCase().replace(/^#+\s*/, '').trim()

  const matchindex = headings.findIndex(h => h.title.toLowerCase() === target || h.title.toLowerCase().includes(target))
  if (matchindex === -1) {
    return null
  }

  const startheading = headings[matchindex]
  const startline = startheading.line - 1
  let endline = lines.length

  // section ends at next heading of equal or higher level --------------------
  for (let j = matchindex + 1; j < headings.length; j++) {
    if (headings[j].level <= startheading.level) {
      endline = headings[j].line - 1
      break
    }
  }

  const sectionlines = lines.slice(startline, endline)
  return {
    heading: startheading.title,
    startline: startheading.line,
    endline,
    content: sectionlines.join('\n')
  }
}

// resolve target file path from name or partial path --------------------
function resolvefilepath(vaultdir, raw) {
  if (!raw) return ''
  const clean = raw.trim().replace(/\\/g, '/')
  const allnotes = listnotes(vaultdir)
  const exact = allnotes.find(n => n.note_id.toLowerCase() === clean.toLowerCase())
  if (exact) return exact.note_id
  const withmd = allnotes.find(n => n.note_id.toLowerCase() === `${clean.toLowerCase()}.md`)
  if (withmd) return withmd.note_id
  const bytitle = allnotes.find(n => n.title.toLowerCase() === clean.toLowerCase() || n.note_id.split('/').pop().toLowerCase() === clean.toLowerCase())
  if (bytitle) return bytitle.note_id
  return clean
}

const analyzemimetypes = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
  ico: 'image/x-icon', bmp: 'image/bmp',
  pdf: 'application/pdf',
  wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  avi: 'video/avi', mkv: 'video/x-matroska'
}

function isanalyzemediapath(finalid) {
  const ext = path.extname(finalid).toLowerCase().slice(1)
  return Boolean(analyzemimetypes[ext])
}

function formatfilemetadata(vaultdir, finalid, note) {
  const diskpath = path.join(vaultdir, ...finalid.split('/'))
  const stats = fs.existsSync(diskpath) ? fs.statSync(diskpath) : null
  const content = note?.content || ''
  const bytes = stats?.size ?? note?.size ?? Buffer.byteLength(content, 'utf8')
  const ext = path.extname(finalid).toLowerCase().slice(1) || '(none)'
  const media = note?.media_kind || null
  const mimeType = analyzemimetypes[ext] || null
  const metalines = [
    `path: ${finalid}`,
    `title: ${note?.title || path.basename(finalid)}`,
    `extension: ${ext}`,
    `size: ${bytes} bytes (${bytes < 1024 ? `${bytes}b` : `${Math.round(bytes / 1024)}kb`})`,
    `created: ${note?.created_at || stats?.birthtime?.toISOString?.() || 'unknown'}`,
    `updated: ${note?.updated_at || stats?.mtime?.toISOString?.() || 'unknown'}`,
  ]
  if (mimeType) metalines.push(`mime: ${mimeType}`)
  if (media) {
    metalines.push(`media_kind: ${media}`)
    if (note?.media_url) metalines.push(`media_url: ${note.media_url}`)
  }
  return metalines.join('\n')
}

// load binary media for file_analyze so agent.js can inject inlineData --------------------
function loadmediaforanalyze(vaultdir, finalid) {
  const ext = path.extname(finalid).toLowerCase().slice(1)
  const mimeType = analyzemimetypes[ext]
  if (!mimeType) {
    return `error: file type ".${ext}" is not supported for file_analyze`
  }

  const diskpath = path.join(vaultdir, ...finalid.split('/'))
  if (!fs.existsSync(diskpath)) {
    return `error: file "${finalid}" not found`
  }

  const stats = fs.statSync(diskpath)
  const maxbytes = 15 * 1024 * 1024
  if (stats.size > maxbytes) {
    return `error: file "${finalid}" is too large to analyze inline (${Math.round(stats.size / 1048576)}mb, max 15mb)`
  }

  const buffer = fs.readFileSync(diskpath)
  return {
    __inlinedata: true,
    mimeType,
    data: buffer.toString('base64'),
    path: finalid,
    size: stats.size,
    text: `[file: ${finalid} | type: ${mimeType} | size: ${Math.round(stats.size / 1024)}kb — loaded for analysis]`
  }
}

// history views for the ai, hourly overview first then drill down --------------------
function historytime(ts, withminutes = false) {
  const opts = withminutes
    ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: 'numeric' }
  return `${new Date(ts).toLocaleString('en-US', opts).toLowerCase()} (${formatrelative(new Date(ts).toISOString())})`
}

function historyhourlyview(vaultdir, historydir, noteid, rawlimit) {
  const limit = Math.min(Math.max(parseInt(rawlimit, 10) || 12, 1), 40)
  const items = gethourlytimeline(historydir, noteid, 200, new Date().getTimezoneOffset())
  if (items.length === 0) return `no history found for file [${noteid}]`

  const missing = !readnote(vaultdir, noteid)
  const rows = items.slice(0, limit).map((item) => {
    if (item.kind === 'event') {
      const detail = item.preview ? ` | ${item.preview}` : ''
      return `event | ${historytime(item.timestamp, true)} | ${item.label} by ${item.author}${detail}`
    }
    const saves = `${item.revision_ids.length} save${item.revision_ids.length === 1 ? '' : 's'}`
    return `chunk_id=${item.newest_id} | ${historytime(item.timestamp)} | ${item.authors.join(', ')} | ${saves} | ${describechangestat(item.stat)}`
  })
  const more = items.length > limit ? `\n...[${items.length - limit} older rows, raise limit to see them]` : ''
  const header = `history for [${noteid}]${missing ? ' (file is deleted from the vault, restore by recreating it from a revision)' : ''}, newest first`
  return `${header}\n${rows.join('\n')}${more}\n\nnext: textfile_history with view "chunk" and a chunk_id shows each save and the diff for that hour`
}

function historychunkview(historydir, noteid, chunkid) {
  if (!chunkid) return 'error: chunk_id required for view chunk, get one from the hourly view first'
  const items = gethourlytimeline(historydir, noteid, 200, new Date().getTimezoneOffset())
  const group = items.find(item => item.kind === 'group' && (item.newest_id === String(chunkid) || item.revision_ids.includes(String(chunkid))))
  if (!group) return `error: chunk ${chunkid} not found for [${noteid}], call the hourly view again`

  const stats = new Map(getfiletimeline(historydir, noteid, 400)
    .filter(item => item.kind === 'revision')
    .map(item => [item.id, item]))
  const saves = group.revision_ids.map((id) => {
    const rev = stats.get(id)
    return rev ? `revision_id=${id} | ${historytime(rev.timestamp, true)} | ${rev.author} | ${describechangestat(rev.stat)}` : `revision_id=${id}`
  })

  const newest = getrevisionbyid(historydir, group.newest_id)
  const base = group.base_id ? getrevisionbyid(historydir, group.base_id) : null
  const diff = formatlinediff(base?.content || '', newest?.content || '', 120)
  const basenote = base ? `compared against revision_id=${base.id} from before this hour` : 'first chunk on record, everything counts as added'
  return [
    `chunk ${group.newest_id} for [${noteid}] | ${historytime(group.timestamp)} | ${group.authors.join(', ')} | ${describechangestat(group.stat)}`,
    '',
    'saves (newest first):',
    ...saves,
    '',
    `combined diff (${basenote}):`,
    diff || '(no visible line changes)',
    '',
    'next: textfile_history with view "revision" and a revision_id returns that full snapshot'
  ].join('\n')
}

function historyrevisionview(historydir, noteid, revisionid) {
  if (!revisionid) return 'error: revision_id required for view revision'
  const rev = getrevisionbyid(historydir, revisionid)
  if (!rev) return `error: revision ${revisionid} not found`
  const belongs = [noteid, `${noteid}.md`, noteid.replace(/\.md$/, '')].includes(rev.file_id)
  if (!belongs) return `error: revision ${revisionid} belongs to [${rev.file_id}], not [${noteid}]`
  const maxchars = 16000
  const body = rev.content.length > maxchars ? `${rev.content.slice(0, maxchars)}\n...[truncated, ${rev.content.length} chars total]` : rev.content
  return `revision_id=${rev.id} of [${noteid}] by ${rev.author} at ${historytime(rev.timestamp, true)}\n\`\`\`\n${body}\n\`\`\``
}

// execute tool calls against the vault --------------------
export async function executetool(name, args, context) {
  const { vaultdir, historydir, activeuser, partneruser, aiusername = 'ai', config } = context

  // web search --------------------
  if (name === 'web_search') {
    const query = (args.query || '').trim()
    if (!query) return 'error: query required'

    const cfg = config || {}
    if (!getbrightdataconfig(cfg).serpenabled) {
      return 'error: web search is not configured. tell the user clearly that web search is currently disabled because brightdata (api_key and serp_zone) is not configured in config.yaml, then proceed using your own internal knowledge or vault files'
    }

    try {
      const limit = Math.min(args.limit || 10, 20)
      const page = Math.min(Math.max(args.page || 1, 1), 10)
      const news = args.news === true || args.news === 'true' || args.news === 1 || args.news === '1'
      const payload = await brightdatawebsearch(cfg, query, { limit, page, news })
      if (!payload.results || payload.results.length === 0) {
        return JSON.stringify({
          ...payload,
          results: [],
          message: news ? 'no news results' : 'no organic results'
        })
      }
      return JSON.stringify(payload)
    } catch (err) {
      log.agent('web_search', 'error', String(err.message || err))
      return `error: web search failed (${err.message || err})`
    }
  }

  if (name === 'youtube_video') {
    const url = (args.url || '').trim()
    if (!url) return 'error: url required'
    if (!parseyoutubeurl(url)) return 'error: not a supported youtube url'

    const action = String(args.action || 'info').toLowerCase()
    if (!['info', 'transcript', 'download'].includes(action)) {
      return 'error: action must be info, transcript, or download'
    }

    try {
      if (action === 'info') {
        const details = await fetchvideodetails(url)
        const vid = details.video_id || parseyoutubeurl(url)
        const creator = youtubecreatorlabel(details.creator)
        return JSON.stringify({
          action: 'info',
          ...details,
          creator,
          reply_hint: `identify video in prose (title and by ${creator} as plain text). one [youtube:${vid}|${creator}] at paragraph end`,
        })
      }

      if (action === 'transcript') {
        const detail = String(args.detail || 'regular').toLowerCase() === 'full' ? 'full' : 'regular'
        const maxchars = detail === 'full'
          ? Math.min(args.max_chars || 400000, 500000)
          : Math.min(args.max_chars || 24000, 80000)
        const payload = await fetchtranscript(url)
        const capped = captranscript(payload.transcript, maxchars)
        const creator = youtubecreatorlabel(payload.creator)
        const vid = payload.video_id || parseyoutubeurl(url)
        const replyhint = detail === 'full'
          ? `full transcript for a thorough vault note or long document. keep structure depth and specifics from the captions. plain text for names and titles. one [youtube:${vid}|${creator}] per chat paragraph at end. never put cite pills in file content`
          : `summarize from transcript. plain text for names and titles. one [youtube:${vid}|${creator}] per paragraph at end`
        return JSON.stringify({
          action: 'transcript',
          detail,
          url: payload.url,
          video_id: vid,
          title: payload.title,
          creator,
          channel_url: payload.channel_url,
          description: payload.description,
          duration_seconds: payload.duration_seconds,
          view_count: payload.view_count,
          upload_date: payload.upload_date,
          language: payload.language,
          manual_captions: payload.manual_captions,
          source_tag: payload.source_tag,
          truncated: capped.truncated,
          char_count: capped.char_count,
          transcript: capped.text,
          reply_hint: replyhint,
        })
      }

      const openintab = args.open_in_tab !== false
      const media = String(args.media || 'audio').toLowerCase()
      const saved = await downloadyoutubemedia(url, vaultdir, {
        media,
        format: args.format || (media === 'video' ? '' : 'mp3'),
        folder: args.folder || 'media/youtube',
      })
      return JSON.stringify({
        action: 'download',
        ok: true,
        media: saved.media || media,
        open_in_tab: openintab,
        path: saved.path,
        title: saved.title,
        video_id: saved.video_id,
        format: saved.format,
        size: saved.size,
        url: saved.url,
        note: saved.note,
        reply_hint: `saved ${saved.media || media} at ${saved.path}. use file_open_for_user when the user should play it in a tab`,
      })
    } catch (err) {
      const errdetail = err.stderr || err.stdout || err.message || String(err)
      log.agent('youtube_video', action, errdetail)
      return `error: youtube ${action} failed (${errdetail}). tell the user clearly that reading or accessing this youtube video failed due to this error, do not hallucinate video contents or search the web for it`
    }
  }

  if (name === 'web_read_page') {
    const url = (args.url || '').trim()
    if (!url) return 'error: url required'

    const cfg = config || {}
    if (!getbrightdataconfig(cfg).webreadenabled) {
      return 'error: web page reading is not configured. tell the user clearly that reading live web pages is currently disabled because brightdata.webview_zone is not configured in config.yaml'
    }

    try {
      const maxchars = Math.min(args.max_chars || 28000, 50000)
      const payload = await brightdatawebread(cfg, url, { max_chars: maxchars })
      if (!payload.content) {
        return JSON.stringify({ ...payload, content: '', message: 'empty page body' })
      }
      return JSON.stringify(payload)
    } catch (err) {
      log.agent('web_read_page', 'error', String(err.message || err))
      return `error: web read failed (${err.message || err})`
    }
  }

  // search text content and media titles or metadata --------------------
  if (name === 'file_search') {
    const query = (args.query || '').toLowerCase().trim()
    const recent = args.recent === true || args.recent === 'true' || args.recent === 1 || args.recent === '1'
    const includemedia = args.include_media === true || args.include_media === 'true' || args.include_media === 1 || args.include_media === '1'
    const rawtarget = args.path || args.file_path || args.note_id
    const terms = query.split(/\s+/).filter(Boolean)

    function notefolders(noteid) {
      return noteid.includes('/') ? noteid.split('/').slice(0, -1).join('/') : 'root'
    }

    function mediametahaystack(note) {
      const ext = path.extname(note.note_id).toLowerCase().slice(1)
      const sizekb = note.size != null ? `${Math.round(note.size / 1024)}kb` : ''
      return [
        note.note_id,
        note.title || '',
        notefolders(note.note_id),
        ext,
        note.media_kind || '',
        note.snippet || '',
        note.size != null ? String(note.size) : '',
        sizekb,
        note.created_at || '',
        note.updated_at || '',
      ].join(' ').toLowerCase()
    }

    function matchesallterms(haystack) {
      if (!terms.length) return false
      return terms.every((t) => haystack.includes(t))
    }

    // recent files mode (folded from textfile_list_recent) --------------------
    if (recent) {
      const limit = Math.min(args.limit || 8, 15)
      let notes = listnotes(vaultdir)
      if (!includemedia) {
        notes = notes.filter((n) => !n.media_kind && !isanalyzemediapath(n.note_id))
      }
      notes = notes.slice(0, limit)
      if (notes.length === 0) return includemedia ? 'no files found in vault' : 'no text files found in vault'

      return notes.map((n) => {
        const folder = notefolders(n.note_id)
        if (n.media_kind || isanalyzemediapath(n.note_id)) {
          const sizekb = n.size != null ? `${Math.round(n.size / 1024)}kb` : '?'
          return `[${n.note_id}] "${n.title}" | media:${n.media_kind || 'file'} | folder:${folder} | size:${sizekb} | edited:${formatrelative(n.updated_at)}`
        }
        return `[${n.note_id}] "${n.title}" | folder:${folder} | edited:${formatrelative(n.updated_at)}`
      }).join('\n')
    }

    if (!query) return 'error: query is required unless recent=true'

    const limit = Math.min(args.limit || 5, 15)

    // search within a specific text file if path provided --------------------
    if (rawtarget) {
      const finalid = resolvefilepath(vaultdir, rawtarget)
      const note = noteforagent(vaultdir, finalid)
      if (!note) return `error: file "${rawtarget}" not found`
      if (note.media_kind || isanalyzemediapath(finalid)) {
        return `error: [${finalid}] is media. drop path and search by filename or media_kind, or use file_analyze`
      }

      const matches = findmatchesincontent(note.content || '', query, limit)
      if (matches.length === 0) return `no matches found for "${query}" in [${finalid}]`
      return `matches for "${query}" in [${finalid}]:\n` + matches.map(m => {
        const hinfo = m.heading ? ` (under "${m.heading}")` : ''
        return `- line ${m.line}${hinfo}: ${m.text}`
      }).join('\n')
    }

    // search across all files in vault --------------------
    const notes = listnotes(vaultdir)
    const matches = []

    for (const note of notes) {
      const folder = notefolders(note.note_id)

      // media: match title path folder kind size metadata only --------------------
      if (note.media_kind || isanalyzemediapath(note.note_id)) {
        if (!matchesallterms(mediametahaystack(note))) continue
        const sizekb = note.size != null ? `${Math.round(note.size / 1024)}kb` : '?'
        matches.push(
          `[${note.note_id}] "${note.title}" | media:${note.media_kind || 'file'} | folder:${folder} | size:${sizekb} | edited:${formatrelative(note.updated_at)}`
        )
        if (matches.length >= limit) break
        continue
      }

      const full = noteforagent(vaultdir, note.note_id)
      const content = full ? full.content : ''
      const title = note.title || ''
      const pathhay = `${note.note_id} ${title} ${folder}`.toLowerCase()
      const titlematch = matchesallterms(pathhay)
      const contentmatches = findmatchesincontent(content, query, 2)

      if (titlematch || contentmatches.length > 0) {
        let snippet = ''
        if (contentmatches.length > 0) {
          snippet = contentmatches.map(m => `line ${m.line}: "${m.text.slice(0, 100)}"`).join(' | ')
        } else {
          snippet = content.replace(/[#*\n]/g, ' ').slice(0, 80).trim()
        }
        matches.push(`[${note.note_id}] "${note.title}" | folder:${folder} | edited:${formatrelative(note.updated_at)} | ${snippet}`)
        if (matches.length >= limit) break
      }
    }

    return matches.length > 0 ? matches.join('\n') : 'no matching files found'
  }

  // read text or code files (content or outline) --------------------
  if (name === 'textfile_read') {
    const rawtarget = args.path || args.file_path || args.note_id || ''
    const finalid = resolvefilepath(vaultdir, rawtarget)
    const note = noteforagent(vaultdir, finalid)
    if (!note) {
      return `error: file "${rawtarget}" not found`
    }
    args.path = finalid
    args.file_path = finalid
    args.note_id = finalid

    if (note.media_kind || isanalyzemediapath(finalid)) {
      return `error: "${finalid}" is media. use file_analyze (or mode=metadata) instead of textfile_read`
    }

    const content = note.content || ''
    const lines = content.split('\n')
    const modeoutline = String(args.mode || '').toLowerCase() === 'outline'

    // outline mode - headings only --------------------
    if (modeoutline) {
      const { headings, totallines } = extractheadings(content)
      if (headings.length === 0) {
        return `[${finalid}] (total lines: ${totallines})\n(no markdown headings found in this file)`
      }
      const outline = headings.map(h => {
        const indent = '  '.repeat(Math.max(0, h.level - 1))
        return `${indent}- line ${h.line}: ${h.raw}`
      })
      return `[${finalid}] (total lines: ${totallines}, headings: ${headings.length})\n${outline.join('\n')}`
    }

    // if specific heading was requested --------------------
    if (args.heading) {
      const section = getheadingsection(content, args.heading)
      if (!section) {
        const { headings } = extractheadings(content)
        const available = headings.map(h => `"${h.title}"`).join(', ')
        return `error: heading "${args.heading}" not found in "${finalid}". available headings: ${available || 'none'}`
      }
      return `[${finalid} > ${section.heading} (lines ${section.startline}-${section.endline})]\n\n${section.content}`
    }

    // if line slice was requested --------------------
    if (args.start_line) {
      const start = Math.max(1, Math.min(args.start_line, lines.length))
      const count = Math.min(Math.max(1, args.line_count || 150), 450)
      const end = Math.min(start + count - 1, lines.length)
      const slice = lines.slice(start - 1, end).join('\n')
      return `[${finalid} (lines ${start}-${end} of ${lines.length})]\n\n${slice}`
    }

    // token safeguard for very large files --------------------
    if (lines.length > 450) {
      const preview = lines.slice(0, 250).join('\n')
      const { headings } = extractheadings(content)
      const headingslist = headings.length > 0
        ? '\n\navailable headings:\n' + headings.map(h => `  - line ${h.line}: ${h.raw}`).join('\n')
        : ''
      return `[${finalid} (previewing lines 1-250 of ${lines.length})]\n\n${preview}\n\n[file truncated for token safety: total ${lines.length} lines. use textfile_read with heading, start_line, or mode=outline]${headingslist}`
    }

    return content
  }

  // analyze media files with gemini or return metadata only --------------------
  if (name === 'file_analyze') {
    const rawtarget = args.path || args.file_path || args.note_id || ''
    if (!rawtarget) return 'error: path is required'
    const finalid = resolvefilepath(vaultdir, rawtarget)
    const note = readnote(vaultdir, finalid)
    if (!note && !fs.existsSync(path.join(vaultdir, ...finalid.split('/')))) {
      return `error: file "${rawtarget}" not found`
    }
    args.path = finalid
    args.file_path = finalid
    args.note_id = finalid

    const modemeta = String(args.mode || '').toLowerCase() === 'metadata' || args.metadata === true
    if (modemeta) {
      return formatfilemetadata(vaultdir, finalid, note)
    }

    if (!isanalyzemediapath(finalid) && !note?.media_kind) {
      return `error: "${finalid}" looks like text. use textfile_read to read it, or file_analyze with mode=metadata for basic file info`
    }

    return loadmediaforanalyze(vaultdir, finalid)
  }

  // open file in new tab for user --------------------
  if (name === 'file_open_for_user') {
    const rawtarget = args.path || args.file_path || args.note_id || ''
    const finalid = resolvefilepath(vaultdir, rawtarget)
    const note = readnote(vaultdir, finalid)
    if (!note) {
      return `error: file "${rawtarget}" not found`
    }
    // check system access permissions for non-admin --------------------
    if (finalid.startsWith('system/')) {
      const parts = finalid.split('/')
      const folderuser = parts[1]
      const currentuser = context.activeuserid || context.activeuser?.id
      if (!context.isadmin && folderuser !== currentuser) {
        return `error: access denied to system file "${finalid}"`
      }
    }
    args.path = finalid
    args.file_path = finalid
    args.note_id = finalid
    return `success: opened "${finalid}" in a new tab for the user`
  }

  // create file with optional extension --------------------
  if (name === 'textfile_create') {
    let rawpath = (args.path || args.filename || args.title || 'untitled.md').trim()
    const folder = args.folder ? args.folder.replace(/[^a-zA-Z0-9_\-\/]/g, '').trim() : ''

    // normalize slashes and sanitize path segments --------------------
    const parts = rawpath.replace(/\\/g, '/').split('/').filter(Boolean)
    if (folder && parts.length === 1) {
      parts.unshift(...folder.split('/').filter(Boolean))
    }
    const filename = parts.pop() || 'untitled.md'
    const cleanedfilename = filename.replace(/[^a-zA-Z0-9_\-. ]/g, '').trim()
    const hasext = /\.[a-zA-Z0-9]+$/i.test(cleanedfilename)
    const finalfilename = hasext ? cleanedfilename : `${cleanedfilename}.md`
    const finalpath = parts.length > 0 ? `${parts.join('/')}/${finalfilename}` : finalfilename

    let body = sanitizevaultmarkdown(unliteralescapes(args.content ?? args.markdown ?? ''))
    const ismarkdown = /\.(md|markdown)$/i.test(finalfilename)
    if (ismarkdown && body && !body.startsWith('#') && !body.startsWith('---')) {
      const basetitle = finalfilename.replace(/\.[a-zA-Z0-9]+$/i, '').replace(/_/g, ' ')
      body = `# ${basetitle}\n\n${body}`
    }

    const entry = getdoc(vaultdir, historydir, finalpath)
    entry.setcontent('', aiusername)

    // stream initial content in natural multi-word chunks into file --------------------
    const editid = `ai_create_${Date.now()}`
    await streaminsert(entry, 0, body, { author: aiusername, edit_id: editid })

    entry.flushtodisk(aiusername)
    log.note('save', finalpath, `by ${aiusername} (${body.length} chars)`)

    args.path = finalpath
    args.file_path = finalpath
    args.note_id = finalpath

    return `created file [${finalpath}] successfully`
  }

  // move or rename file or folder --------------------
  if (name === 'file_move') {
    const rawsrc = (args.source || '').trim()
    const rawdest = (args.destination || '').trim()
    if (!rawsrc || !rawdest) {
      return 'error: source and destination are required'
    }

    // check system access permissions for non-admin --------------------
    const cleansrc = rawsrc.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const cleandest = rawdest.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (cleansrc.startsWith('system') || cleandest.startsWith('system')) {
      if (!context.isadmin) {
        return 'error: access denied to system files and folders'
      }
    }

    try {
      const res = movenoteorfolder(vaultdir, historydir, rawsrc, rawdest, aiusername)
      migratedocentry(res.source, res.destination, res.type === 'folder')
      log.note('move', `${res.source} --> ${res.destination}`, `by ${aiusername}`)
      args.source = res.source
      args.destination = res.destination
      args.move_type = res.type
      return `success: ${res.message}`
    } catch (err) {
      return `error: ${err.message}`
    }
  }

  // copy file or folder --------------------
  if (name === 'file_copy') {
    const rawsrc = (args.source || '').trim()
    const rawdest = (args.destination || '').trim()
    if (!rawsrc || !rawdest) {
      return 'error: source and destination are required'
    }

    // check system access permissions for non-admin --------------------
    const cleansrc = rawsrc.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const cleandest = rawdest.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (cleansrc.startsWith('system') || cleandest.startsWith('system')) {
      if (!context.isadmin) {
        return 'error: access denied to system files and folders'
      }
    }

    try {
      const res = copynoteorfolder(vaultdir, historydir, rawsrc, rawdest, aiusername)
      log.note('copy', `${res.source} --> ${res.destination}`, `by ${aiusername}`)
      args.source = res.source
      args.destination = res.destination
      args.copy_type = res.type
      return `success: ${res.message}`
    } catch (err) {
      return `error: ${err.message}`
    }
  }

  // extract zip jar 7z or rar beside the archive --------------------
  if (name === 'archive_extract') {
    const rawpath = (args.path || args.file_path || args.archive || '').trim()
    if (!rawpath) return 'error: path is required'

    const cleanpath = rawpath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (cleanpath.startsWith('system')) {
      if (!context.isadmin) {
        return 'error: access denied to system files'
      }
    }

    try {
      const res = await extractarchive(vaultdir, cleanpath)
      args.path = res.archive
      args.destination = res.destination
      const tops = (res.top_level || []).slice(0, 8).join(', ')
      const topbit = tops ? ` top: ${tops}` : ''
      return `success: extracted [${res.archive}] into [${res.destination}] (${res.file_count} files, ${res.bytes} bytes).${topbit}`
    } catch (err) {
      return `error: ${err.message}`
    }
  }

  // http api get or post style requests --------------------
  if (name === 'api_request') {
    const url = (args.url || '').trim()
    if (!url) return 'error: url is required'

    const saveTo = (args.save_to || '').trim()
    if (saveTo.replace(/\\/g, '/').replace(/^\/+/, '').startsWith('system')) {
      if (!context.isadmin) {
        return 'error: access denied to system paths'
      }
    }

    try {
      const res = await runapirequest({
        method: args.method,
        url,
        headers: args.headers,
        body: args.body,
        save_to: saveTo || '',
        max_chars: args.max_chars,
        timeout_ms: args.timeout_ms,
        vaultdir
      })
      args.method = res.method
      args.url = res.url
      if (res.saved_to) args.save_to = res.saved_to
      args.status = res.status
      return JSON.stringify(res)
    } catch (err) {
      log.agent('api_request', url, String(err.message || err))
      return `error: api request failed (${err.message || err})`
    }
  }

  // download http(s) file or clone public git repo into the vault --------------------
  if (name === 'download') {
    const url = (args.url || '').trim()
    if (!url) return 'error: url is required'

    const destination = (args.destination || args.path || args.folder || '').trim()
    const mode = String(args.mode || 'auto').toLowerCase()
    if (destination.replace(/\\/g, '/').replace(/^\/+/, '').startsWith('system')) {
      if (!context.isadmin) {
        return 'error: access denied to system paths'
      }
    }

    try {
      const res = await downloadorclone(vaultdir, url, destination, mode)
      args.url = res.url || url
      args.destination = res.path
      args.path = res.path
      args.kind = res.kind
      if (res.kind === 'git') {
        return JSON.stringify({
          ok: true,
          kind: 'git',
          url: res.url,
          path: res.path,
          repo_name: res.repo_name,
          file_count: res.file_count,
          reply_hint: `cloned public repo into ${res.path}. open or browse files from there`
        })
      }
      return JSON.stringify({
        ok: true,
        kind: 'file',
        url: res.url,
        path: res.path,
        bytes: res.bytes,
        content_type: res.content_type,
        reply_hint: `saved file at ${res.path}. use file_open_for_user if the user should open it, or archive_extract if it is a zip jar 7z or rar`
      })
    } catch (err) {
      log.agent('download', url, String(err.message || err))
      const hint = islikelygiturl(url) && mode !== 'file'
        ? ' (if this should be a raw file download, retry with mode file)'
        : ''
      return `error: download failed (${err.message || err})${hint}`
    }
  }

  // delete file or folder --------------------
  if (name === 'file_delete') {
    const rawid = (args.path || args.file_path || args.note_id || args.folder_path || '').trim()
    if (!rawid) {
      return 'error: path is required'
    }

    const cleanid = rawid.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (cleanid.startsWith('system')) {
      if (!context.isadmin) {
        return 'error: access denied to system files'
      }
    }

    try {
      const res = deletenoteorfolder(vaultdir, historydir, cleanid, aiusername)
      if (res.success) {
        if (res.type === 'file') {
          evictnotedoc(historydir, res.path)
        } else {
          evictfolderdocs(historydir, res.path)
        }
        log.note('delete', res.path, `by ${aiusername} (${res.type})`)
        args.path = res.path
        args.delete_type = res.type
        return `success: permanently deleted ${res.type} [${res.path}]`
      }
      return `error: file or folder "${cleanid}" not found`
    } catch (err) {
      return `error: ${err.message}`
    }
  }

  // edit file with diff --------------------
  if (name === 'textfile_edit_diff') {
    const rawtarget = args.path || args.file_path || args.note_id || ''
    const finalid = resolvefilepath(vaultdir, rawtarget)
    try {
      const updated = await applydiff(vaultdir, historydir, finalid, {
        mode: args.mode,
        target_text: unliteralescapes(args.target_text),
        replacement_text: sanitizevaultmarkdown(unliteralescapes(args.replacement_text)),
        edits: Array.isArray(args.edits)
          ? args.edits.map(e => ({
              mode: e.mode,
              target_text: unliteralescapes(e.target_text),
              replacement_text: sanitizevaultmarkdown(unliteralescapes(e.replacement_text))
            }))
          : undefined,
        author: aiusername
      })
      const entry = getdoc(vaultdir, historydir, finalid)
      entry.flushtodisk(aiusername)
      log.note('save', finalid, `by ${aiusername} (${updated.length} chars)`)
      args.path = finalid
      args.file_path = finalid
      args.note_id = finalid
      const editcount = Array.isArray(args.edits) ? args.edits.length : 1
      return `success: file [${finalid}] updated with ${editcount} edit(s) (${updated.length} chars total)`
    } catch (err) {
      return `error: ${err.message}`
    }
  }

  // evaluate sandboxed javascript --------------------
  if (name === 'eval_js') {
    const rawcode = (args.code || '').trim()
    if (!rawcode) return 'error: code is required'
    const timeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : 2000
    const res = evaluatejavascript(rawcode, timeout)
    if (!res.success) {
      return `error: ${res.error || 'execution failed'}`
    }
    const parts = []
    if (res.result !== undefined) parts.push(`result: ${res.result}`)
    if (res.logs) parts.push(`logs:\n${res.logs}`)
    return parts.length ? parts.join('\n\n') : 'success (no output)'
  }

  // file history --------------------
  if (name === 'textfile_history') {
    const rawtarget = args.path || args.file_path || args.note_id || ''
    const finalid = resolvefilepath(vaultdir, rawtarget)
    if (!finalid) return 'error: path required'
    const view = String(args.view || 'hourly').toLowerCase()
    if (view === 'chunk') return historychunkview(historydir, finalid, args.chunk_id)
    if (view === 'revision') return historyrevisionview(historydir, finalid, args.revision_id)
    return historyhourlyview(vaultdir, historydir, finalid, args.limit)
  }

  return `error: unknown tool ${name}`
}

