import path from 'node:path'
import fs from 'node:fs'
import { listnotes, readnote, writenote, movenoteorfolder, copynoteorfolder, deletenote, deletefolder } from '../vault/vault.js'
import { gethourlytimeline, getfiletimeline, getrevisionbyid, formatlinediff, describechangestat } from '../vault/history.js'
import { getdoc, getdocifloaded, applydiff, migratedocentry, unliteralescapes, streaminsert } from '../sync/sync.js'
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

// prefer in-memory ytext when a note is open in the collab doc --------------------
function noteforagent(vaultdir, noteid) {
  const note = readnote(vaultdir, noteid)
  if (!note) return null
  const live = getdocifloaded(noteid)
  if (live) note.content = live.getcontent()
  return note
}

// tool schema declarations for gemini --------------------
export const tooldeclarations = [
  {
    name: 'file_search',
    description: 'Fuzzy search files by title, tags, or content across the vault or within a specific file. Returns paths, line numbers, and snippets.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'Keywords or search phrase' },
        path: { type: 'STRING', description: 'Optional specific file path to search within instead of all files' },
        limit: { type: 'INTEGER', description: 'Max results (default 5, max 15)' }
      },
      required: ['query']
    }
  },
  {
    name: 'web_search',
    description: 'Bright Data SERP: ai_overview, organic results, reply_hint, ai_overview_source_tag when present.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'Search query' },
        page: { type: 'INTEGER', description: 'Result page (1-based, default 1). Page 2 is the next batch of organic results (~10 per page on Bing).' },
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
    description: 'yt-dlp youtube actions: info, transcript, download. Returns metadata, source_tag, reply_hint.',
    parameters: {
      type: 'OBJECT',
      properties: {
        url: { type: 'STRING', description: 'YouTube watch, shorts, or youtu.be url' },
        action: {
          type: 'STRING',
          enum: ['info', 'transcript', 'download'],
          description: 'info = metadata only, transcript = metadata + captions, download = save media to vault'
        },
        media: {
          type: 'STRING',
          enum: ['audio', 'video'],
          description: 'For download only: audio (default mp3) or video (default muxed webm). use video when user asks to download the video'
        },
        max_chars: { type: 'INTEGER', description: 'For transcript only: max transcript chars (default 24000, max 80000)' },
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
    name: 'file_list_recent',
    description: 'List recently modified files, optionally filtered by author.',
    parameters: {
      type: 'OBJECT',
      properties: {
        limit: { type: 'INTEGER', description: 'Number of files to return (default 8)' },
        author: {
          type: 'STRING',
          enum: ['me', 'partner', 'all'],
          description: 'Filter by last editor (default all)'
        }
      }
    }
  },
  {
    name: 'file_outline',
    description: 'Inspect the outline and structure of a file by headings and line numbers. Use this on large files to locate sections without loading full text.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'Target file path (e.g. todo.md or notes/meeting.txt)' }
      },
      required: ['path']
    }
  },
  {
    name: 'file_open',
    description: 'Read vault file content by path, optional heading or line slice.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'Target file path (e.g. todo.md, data.json, scripts/run.py)' },
        heading: {
          type: 'STRING',
          description: 'Optional heading name to read only that section and its subsections (for markdown files)'
        },
        start_line: {
          type: 'INTEGER',
          description: 'Optional 1-based start line number'
        },
        line_count: {
          type: 'INTEGER',
          description: 'Optional number of lines to read when using start_line (default 150, max 450)'
        },
        open_in_tab: {
          type: 'BOOLEAN',
          description: 'Optional. Set to true if the user asked to open or view this file in their editor tabs so it opens in a new tab for them.'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'file_view',
    description: 'Analyze or inspect any vault file by loading its raw content into AI context. For images, PDFs, audio, and video files, the actual media is passed to AI for visual or audio analysis. For text and code files, returns the text content. Use this when you need to actually see, listen to, or read a document that cannot be read as plain text, or when inspecting any binary or media file.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'Target file path in vault (e.g. media/recording.wav, media/photo.jpg, docs/report.pdf)' }
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
    name: 'file_create',
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
    description: 'Permanently delete a file from the vault. Use when the user asks to delete, remove, or trash a file.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: {
          type: 'STRING',
          description: 'Target file path to delete (e.g. "todo.md" or "recipes/soup.md" or "data.json")'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'folder_delete',
    description: 'Permanently delete a folder and all its contents from the vault. Use when the user asks to delete, remove, or trash a folder.',
    parameters: {
      type: 'OBJECT',
      properties: {
        folder_path: {
          type: 'STRING',
          description: 'Target folder path to delete (e.g. "recipes" or "archive/2025")'
        }
      },
      required: ['folder_path']
    }
  },
  {
    name: 'file_edit_diff',
    description: 'Edit an existing file using targeted diffs. Supports replacing text, deleting snippets, inserting before/after anchors, or appending to the end. For multiple changes, pass an edits array.',
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
    name: 'file_history',
    description: 'Browse edit history for a file, including deleted files. Start with view "hourly" to get one row per hour of edits (who, how many saves, chars and lines changed). To see what changed in one hour, call again with view "chunk" and that row\'s chunk_id: returns every save in that hour plus the combined line diff. To read or recover one exact snapshot, use view "revision" with a revision_id.',
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
  {
    name: 'user_profile_update',
    description: 'Save a durable personal or household fact (allergies, preferences, IDs) to user memory.',
    parameters: {
      type: 'OBJECT',
      properties: {
        scope: {
          type: 'STRING',
          enum: ['me', 'partner', 'shared'],
          description: 'Who this fact applies to'
        },
        key: { type: 'STRING', description: 'Short snake_case key (e.g. walnut_allergy)' },
        value: { type: 'STRING', description: 'Concise fact value' }
      },
      required: ['scope', 'key', 'value']
    }
  }
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
  return `${header}\n${rows.join('\n')}${more}\n\nnext: file_history with view "chunk" and a chunk_id shows each save and the diff for that hour`
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
    'next: file_history with view "revision" and a revision_id returns that full snapshot'
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
      return 'error: web search is not configured, add brightdata.api_key and brightdata.serp_zone to config.yaml'
    }

    try {
      const limit = Math.min(args.limit || 10, 20)
      const page = Math.min(Math.max(args.page || 1, 1), 10)
      const payload = await brightdatawebsearch(cfg, query, { limit, page })
      if (!payload.results || payload.results.length === 0) {
        return JSON.stringify({ ...payload, results: [], message: 'no organic results' })
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
        const maxchars = Math.min(args.max_chars || 24000, 80000)
        const payload = await fetchtranscript(url)
        const capped = captranscript(payload.transcript, maxchars)
        const creator = youtubecreatorlabel(payload.creator)
        const vid = payload.video_id || parseyoutubeurl(url)
        return JSON.stringify({
          action: 'transcript',
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
          reply_hint: `summarize from transcript. plain text for names and titles. one [youtube:${vid}|${creator}] per paragraph at end`,
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
      log.agent('youtube_video', action, String(err.message || err))
      return `error: youtube ${action} failed (${err.message || err})`
    }
  }

  if (name === 'web_read_page') {
    const url = (args.url || '').trim()
    if (!url) return 'error: url required'

    const cfg = config || {}
    if (!getbrightdataconfig(cfg).webreadenabled) {
      return 'error: web read is not configured, set brightdata.webview_zone (e.g. mushnote_webview) in config.yaml'
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

  // search files --------------------
  if (name === 'file_search') {
    const query = (args.query || '').toLowerCase()
    const limit = Math.min(args.limit || 5, 15)
    const rawtarget = args.path || args.file_path || args.note_id

    // search within a specific file if path provided --------------------
    if (rawtarget) {
      const finalid = resolvefilepath(vaultdir, rawtarget)
      const note = noteforagent(vaultdir, finalid)
      if (!note) return `error: file "${rawtarget}" not found`

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
      const full = noteforagent(vaultdir, note.note_id)
      const content = full ? full.content : ''
      const title = note.title || ''

      const titlematch = title.toLowerCase().includes(query) || note.note_id.toLowerCase().includes(query)
      const contentmatches = findmatchesincontent(content, query, 2)

      if (titlematch || contentmatches.length > 0) {
        const folder = note.note_id.includes('/')
          ? note.note_id.split('/').slice(0, -1).join('/')
          : 'root'
        let snippet = ''
        if (contentmatches.length > 0) {
          snippet = contentmatches.map(m => `line ${m.line}: "${m.text.slice(0, 100)}"`).join(' | ')
        } else {
          snippet = content.replace(/[#*\n]/g, ' ').slice(0, 80).trim()
        }
        const line = `[${note.note_id}] "${note.title}" | folder:${folder} | edited:${formatrelative(note.updated_at)} | ${snippet}`
        matches.push(line)
        if (matches.length >= limit) break
      }
    }

    return matches.length > 0 ? matches.join('\n') : 'no matching files found'
  }

  // list recent files --------------------
  if (name === 'file_list_recent') {
    const limit = Math.min(args.limit || 8, 15)
    const notes = listnotes(vaultdir).slice(0, limit)
    if (notes.length === 0) return 'no files found in vault'

    const lines = notes.map(n => {
      const folder = n.note_id.includes('/') ? n.note_id.split('/').slice(0, -1).join('/') : 'root'
      return `[${n.note_id}] "${n.title}" | folder:${folder} | edited:${formatrelative(n.updated_at)}`
    })
    return lines.join('\n')
  }

  // file outline to inspect headings and structure --------------------
  if (name === 'file_outline') {
    const rawtarget = args.path || args.file_path || args.note_id || ''
    const finalid = resolvefilepath(vaultdir, rawtarget)
    const note = noteforagent(vaultdir, finalid)
    if (!note) {
      return `error: file "${rawtarget}" not found`
    }

    const { headings, totallines } = extractheadings(note.content || '')
    if (headings.length === 0) {
      return `[${finalid}] (total lines: ${totallines})\n(no markdown headings found in this file)`
    }

    const lines = headings.map(h => {
      const indent = '  '.repeat(Math.max(0, h.level - 1))
      return `${indent}- line ${h.line}: ${h.raw}`
    })

    return `[${finalid}] (total lines: ${totallines}, headings: ${headings.length})\n${lines.join('\n')}`
  }

  // open file or chunk of file --------------------
  if (name === 'file_open') {
    const rawtarget = args.path || args.file_path || args.note_id || ''
    const finalid = resolvefilepath(vaultdir, rawtarget)
    const note = noteforagent(vaultdir, finalid)
    if (!note) {
      return `error: file "${rawtarget}" not found`
    }
    args.path = finalid
    args.file_path = finalid
    args.note_id = finalid

    const content = note.content || ''
    const lines = content.split('\n')

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
      return `[${finalid} (previewing lines 1-250 of ${lines.length})]\n\n${preview}\n\n[file truncated for token safety: total ${lines.length} lines. use file_open with heading parameter or start_line to read remaining sections]${headingslist}`
    }

    return content
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
  if (name === 'file_create') {
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

    let body = unliteralescapes(args.content ?? args.markdown ?? '')
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

  // delete file --------------------
  if (name === 'file_delete') {
    const rawid = (args.path || args.file_path || args.note_id || '').trim()
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
      const deleted = deletenote(vaultdir, cleanid, historydir, aiusername)
      if (deleted) {
        log.note('delete', cleanid, `by ${aiusername}`)
        args.path = cleanid
        args.file_path = cleanid
        args.note_id = cleanid
        return `success: permanently deleted file [${cleanid}]`
      }
      return `error: file "${cleanid}" not found`
    } catch (err) {
      return `error: ${err.message}`
    }
  }

  // delete folder --------------------
  if (name === 'folder_delete') {
    const rawfolder = (args.folder_path || '').trim()
    if (!rawfolder) {
      return 'error: folder_path is required'
    }

    const cleanfolder = rawfolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (cleanfolder.startsWith('system')) {
      if (!context.isadmin) {
        return 'error: access denied to system folders'
      }
    }

    try {
      const deleted = deletefolder(vaultdir, historydir, cleanfolder, 'ai')
      if (deleted) {
        args.folder_path = cleanfolder
        return `success: permanently deleted folder "${cleanfolder}"`
      }
      return `error: folder "${cleanfolder}" not found`
    } catch (err) {
      return `error: ${err.message}`
    }
  }

  // edit file with diff --------------------
  if (name === 'file_edit_diff') {
    const rawtarget = args.path || args.file_path || args.note_id || ''
    const finalid = resolvefilepath(vaultdir, rawtarget)
    try {
      const updated = await applydiff(vaultdir, historydir, finalid, {
        mode: args.mode,
        target_text: unliteralescapes(args.target_text),
        replacement_text: unliteralescapes(args.replacement_text),
        edits: Array.isArray(args.edits)
          ? args.edits.map(e => ({
              mode: e.mode,
              target_text: unliteralescapes(e.target_text),
              replacement_text: unliteralescapes(e.replacement_text)
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

  // file_view - load binary or text file for multimodal ai analysis --------------------
  if (name === 'file_view') {
    const rawpath = args.path || ''
    if (!rawpath) return 'error: path is required'

    const finalid = resolvefilepath(vaultdir, rawpath)

    const ext = path.extname(finalid).toLowerCase().slice(1)
    const mimetypes = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
      ico: 'image/x-icon', bmp: 'image/bmp',
      pdf: 'application/pdf',
      wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg',
      m4a: 'audio/mp4', aac: 'audio/aac',
      mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
      avi: 'video/avi', mkv: 'video/x-matroska'
    }
    const textexts = new Set([
      'md','markdown','txt','log','csv','tsv','json','yaml','yml',
      'toml','ini','env','conf','html','htm','css','js','ts',
      'py','sh','rb','go','rs','c','cpp','h'
    ])

    // text files - return as text --------------------
    if (textexts.has(ext)) {
      const note = noteforagent(vaultdir, finalid)
      if (!note) return `error: file "${rawpath}" not found`
      return note.content || '(empty file)'
    }

    const mimeType = mimetypes[ext]
    if (!mimeType) {
      return `error: file type ".${ext}" is not supported for viewing`
    }

    // binary files - read and encode --------------------
    const diskpath = path.join(vaultdir, ...finalid.split('/'))
    if (!fs.existsSync(diskpath)) {
      return `error: file "${rawpath}" not found`
    }

    const stats = fs.statSync(diskpath)
    const maxbytes = 15 * 1024 * 1024
    if (stats.size > maxbytes) {
      return `error: file "${finalid}" is too large to analyze inline (${Math.round(stats.size / 1048576)}mb, max 15mb)`
    }

    const buffer = fs.readFileSync(diskpath)
    const base64 = buffer.toString('base64')

    // return special marker object for agent.js to inject inlineData --------------------
    return {
      __inlinedata: true,
      mimeType,
      data: base64,
      path: finalid,
      size: stats.size,
      text: `[file: ${finalid} | type: ${mimeType} | size: ${Math.round(stats.size / 1024)}kb — loaded for analysis]`
    }
  }

  // file history --------------------
  if (name === 'file_history') {
    const rawtarget = args.path || args.file_path || args.note_id || ''
    const finalid = resolvefilepath(vaultdir, rawtarget)
    if (!finalid) return 'error: path required'
    const view = String(args.view || 'hourly').toLowerCase()
    if (view === 'chunk') return historychunkview(historydir, finalid, args.chunk_id)
    if (view === 'revision') return historyrevisionview(historydir, finalid, args.revision_id)
    return historyhourlyview(vaultdir, historydir, finalid, args.limit)
  }

  // update user memory facts --------------------
  if (name === 'user_profile_update') {
    const targetuserid = args.scope === 'partner' ? partneruser?.id : activeuser?.id
    if (!targetuserid) {
      return 'error: target user could not be identified'
    }
    const profilepath = `system/${targetuserid}/personality.md`
    const entry = getdoc(vaultdir, historydir, profilepath)
    const factline = `\n- ${args.key}: ${args.value}`
    entry.insertat(entry.getcontent().length, factline, 'ai')
    entry.flushtodisk('ai')

    return `saved fact "${args.key}" for ${targetuserid}`
  }

  return `error: unknown tool ${name}`
}

