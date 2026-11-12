import path from 'node:path'
import { listnotes, readnote, writenote, movenoteorfolder, copynoteorfolder, deletenote, deletefolder } from './vault.js'
import { gethistory } from './history.js'
import { getdoc, applydiff, migratedocentry, unliteralescapes, streaminsert } from './sync.js'

// tool schema declarations for gemini --------------------
export const tooldeclarations = [
  {
    name: 'note_search',
    description: 'Fuzzy search notes by title, tags, or content. Returns compact IDs and snippets.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'Keywords or title phrase' },
        limit: { type: 'INTEGER', description: 'Max results (default 5, max 10)' }
      },
      required: ['query']
    }
  },
  {
    name: 'note_list_recent',
    description: 'List recently modified notes, optionally filtered by author.',
    parameters: {
      type: 'OBJECT',
      properties: {
        limit: { type: 'INTEGER', description: 'Number of notes to return (default 8)' },
        author: {
          type: 'STRING',
          enum: ['me', 'partner', 'all'],
          description: 'Filter by last editor (default all)'
        }
      }
    }
  },
  {
    name: 'note_outline',
    description: 'Inspect the outline and table of contents of a note by headings and line numbers. Use this on large notes to locate sections without loading full text.',
    parameters: {
      type: 'OBJECT',
      properties: {
        note_id: { type: 'STRING', description: 'Target note ID or path' }
      },
      required: ['note_id']
    }
  },
  {
    name: 'note_open',
    description: 'Read content from a note. Supports reading specific sections by heading or line slice to conserve tokens on large notes.',
    parameters: {
      type: 'OBJECT',
      properties: {
        note_id: { type: 'STRING', description: 'Note ID or path' },
        heading: {
          type: 'STRING',
          description: 'Optional heading name to read only that section and its subsections'
        },
        start_line: {
          type: 'INTEGER',
          description: 'Optional 1-based start line number'
        },
        line_count: {
          type: 'INTEGER',
          description: 'Optional number of lines to read when using start_line (default 80, max 250)'
        },
        open_in_tab: {
          type: 'BOOLEAN',
          description: 'Optional. Set to true if the user asked to open or view this note in their editor tabs so it opens in a new tab for them.'
        }
      },
      required: ['note_id']
    }
  },
  {
    name: 'note_open_for_user',
    description: 'Open an existing note in a new tab in the editor for the user. Call this whenever the user asks to open, view, or pull up a note in their workspace.',
    parameters: {
      type: 'OBJECT',
      properties: {
        note_id: { type: 'STRING', description: 'Target note ID or path (e.g. recipes/soup.md or meeting.md)' }
      },
      required: ['note_id']
    }
  },
  {
    name: 'note_create',
    description: 'Create a brand new Markdown note. Do not use to edit existing notes.',
    parameters: {
      type: 'OBJECT',
      properties: {
        title: { type: 'STRING', description: 'Note title' },
        folder: { type: 'STRING', description: 'Optional folder path (e.g. Travel, Recipes)' },
        markdown: { type: 'STRING', description: 'Initial Markdown body' },
        tags: {
          type: 'ARRAY',
          items: { type: 'STRING' },
          description: 'Optional tags without #'
        }
      },
      required: ['title', 'markdown']
    }
  },
  {
    name: 'note_move',
    description: 'Rename or move a note or folder in the vault. Can move a note into a folder, rename a note, or rename and move an entire folder.',
    parameters: {
      type: 'OBJECT',
      properties: {
        source: {
          type: 'STRING',
          description: 'Current note ID or folder path (e.g. "todo.md" or "recipes" or "notes/shopping.md")'
        },
        destination: {
          type: 'STRING',
          description: 'Target note ID, new folder path, or target directory path (e.g. "archive/todo.md" or "cookbooks" or "archive/")'
        }
      },
      required: ['source', 'destination']
    }
  },
  {
    name: 'note_copy',
    description: 'Copy a note or entire folder in the vault to a new name or destination folder.',
    parameters: {
      type: 'OBJECT',
      properties: {
        source: {
          type: 'STRING',
          description: 'Current note ID or folder path to duplicate (e.g. "todo.md" or "recipes")'
        },
        destination: {
          type: 'STRING',
          description: 'Target note ID, new folder name, or target directory path (e.g. "todo_backup.md" or "backup/" or "recipes_copy")'
        }
      },
      required: ['source', 'destination']
    }
  },
  {
    name: 'note_delete',
    description: 'Permanently delete a note from the vault. Use when the user asks to delete, remove, or trash a note.',
    parameters: {
      type: 'OBJECT',
      properties: {
        note_id: {
          type: 'STRING',
          description: 'Target note ID or path to delete (e.g. "todo.md" or "recipes/soup.md")'
        }
      },
      required: ['note_id']
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
    name: 'note_edit_diff',
    description: 'Edit an existing note using targeted diffs. Supports replacing text, deleting snippets, inserting before/after anchors, or appending to the end. For multiple changes, pass an edits array.',
    parameters: {
      type: 'OBJECT',
      properties: {
        note_id: { type: 'STRING', description: 'Target note ID (e.g. recipes/soup.md or meeting.md)' },
        mode: {
          type: 'STRING',
          enum: ['replace', 'insert_after', 'insert_before', 'delete', 'append'],
          description: 'replace: swaps target_text with replacement_text; insert_after: inserts replacement_text right after target_text; insert_before: inserts replacement_text right before target_text; delete: removes target_text; append: adds replacement_text to end of note'
        },
        target_text: {
          type: 'STRING',
          description: 'Existing snippet or anchor in the note (required for replace, insert_after, insert_before, and delete)'
        },
        replacement_text: {
          type: 'STRING',
          description: 'New Markdown text to insert, replace, or append (optional for delete)'
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
      required: ['note_id']
    }
  },
  {
    name: 'note_history',
    description: 'View per user edit history diffs for a note to check changes or recover text.',
    parameters: {
      type: 'OBJECT',
      properties: {
        note_id: { type: 'STRING', description: 'Target note ID' },
        limit: { type: 'INTEGER', description: 'Number of past revisions to show (default 5)' }
      },
      required: ['note_id']
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
function extractheadings(markdown) {
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

// execute tool calls against the vault --------------------
export async function executetool(name, args, context) {
  const { vaultdir, historydir, activeuser, partneruser } = context

  // search notes --------------------
  if (name === 'note_search') {
    const query = (args.query || '').toLowerCase()
    const limit = Math.min(args.limit || 5, 10)
    const notes = listnotes(vaultdir)
    const matches = []

    for (const note of notes) {
      const full = readnote(vaultdir, note.note_id)
      const content = full ? full.content.toLowerCase() : ''
      const title = (note.title || '').toLowerCase()

      if (title.includes(query) || content.includes(query) || note.note_id.toLowerCase().includes(query)) {
        const folder = note.note_id.includes('/')
          ? note.note_id.split('/').slice(0, -1).join('/')
          : 'root'
        const snippet = (full?.content || '')
          .replace(/[#*\n]/g, ' ')
          .slice(0, 80)
          .trim()
        const line = `[${note.note_id}] "${note.title}" | folder:${folder} | edited:${formatrelative(note.updated_at)} | "...${snippet}..."`
        matches.push(line)
        if (matches.length >= limit) break
      }
    }

    return matches.length > 0 ? matches.join('\n') : 'no matching notes found'
  }

  // list recent notes --------------------
  if (name === 'note_list_recent') {
    const limit = Math.min(args.limit || 8, 15)
    const notes = listnotes(vaultdir).slice(0, limit)
    if (notes.length === 0) return 'no notes found in vault'

    const lines = notes.map(n => {
      const folder = n.note_id.includes('/') ? n.note_id.split('/').slice(0, -1).join('/') : 'root'
      return `[${n.note_id}] "${n.title}" | folder:${folder} | edited:${formatrelative(n.updated_at)}`
    })
    return lines.join('\n')
  }

  // note outline to inspect headings and structure --------------------
  if (name === 'note_outline') {
    const note = readnote(vaultdir, args.note_id)
    if (!note) {
      return `error: note "${args.note_id}" not found`
    }

    const { headings, totallines } = extractheadings(note.content || '')
    if (headings.length === 0) {
      return `[${args.note_id}] (total lines: ${totallines})\n(no markdown headings found in this note)`
    }

    const lines = headings.map(h => {
      const indent = '  '.repeat(Math.max(0, h.level - 1))
      return `${indent}- line ${h.line}: ${h.raw}`
    })

    return `[${args.note_id}] (total lines: ${totallines}, headings: ${headings.length})\n${lines.join('\n')}`
  }

  // open note or chunk of note --------------------
  if (name === 'note_open') {
    const rawid = (args.note_id || '').trim().replace(/\\/g, '/')
    const allnotes = listnotes(vaultdir)
    let matched = allnotes.find(n => n.note_id.toLowerCase() === rawid.toLowerCase() || n.note_id.toLowerCase() === `${rawid.toLowerCase()}.md`)
    if (!matched) {
      matched = allnotes.find(n => n.title.toLowerCase() === rawid.toLowerCase() || n.note_id.split('/').pop().replace(/\.md$/i, '').toLowerCase() === rawid.toLowerCase())
    }
    const finalid = matched ? matched.note_id : (rawid.endsWith('.md') ? rawid : `${rawid}.md`)
    const note = readnote(vaultdir, finalid)
    if (!note) {
      return `error: note "${args.note_id}" not found`
    }
    args.note_id = finalid

    const content = note.content || ''
    const lines = content.split('\n')

    // if specific heading was requested --------------------
    if (args.heading) {
      const section = getheadingsection(content, args.heading)
      if (!section) {
        const { headings } = extractheadings(content)
        const available = headings.map(h => `"${h.title}"`).join(', ')
        return `error: heading "${args.heading}" not found in "${args.note_id}". available headings: ${available || 'none'}`
      }
      return `[${args.note_id} > ${section.heading} (lines ${section.startline}-${section.endline})]\n\n${section.content}`
    }

    // if line slice was requested --------------------
    if (args.start_line) {
      const start = Math.max(1, Math.min(args.start_line, lines.length))
      const count = Math.min(Math.max(1, args.line_count || 80), 250)
      const end = Math.min(start + count - 1, lines.length)
      const slice = lines.slice(start - 1, end).join('\n')
      return `[${args.note_id} (lines ${start}-${end} of ${lines.length})]\n\n${slice}`
    }

    // token safeguard for very large notes --------------------
    if (lines.length > 250) {
      const preview = lines.slice(0, 150).join('\n')
      return `[${args.note_id} (previewing lines 1-150 of ${lines.length})]\n\n${preview}\n\n[note truncated for token safety: total ${lines.length} lines. use note_outline to check headings or note_open with heading parameter to read specific sections]`
    }

    return content
  }

  // open note in new tab for user --------------------
  if (name === 'note_open_for_user') {
    const rawid = (args.note_id || '').trim().replace(/\\/g, '/')
    const allnotes = listnotes(vaultdir)
    let matched = allnotes.find(n => n.note_id.toLowerCase() === rawid.toLowerCase() || n.note_id.toLowerCase() === `${rawid.toLowerCase()}.md`)
    if (!matched) {
      matched = allnotes.find(n => n.title.toLowerCase() === rawid.toLowerCase() || n.note_id.split('/').pop().replace(/\.md$/i, '').toLowerCase() === rawid.toLowerCase())
    }
    const finalid = matched ? matched.note_id : (rawid.endsWith('.md') ? rawid : `${rawid}.md`)
    const note = readnote(vaultdir, finalid)
    if (!note) {
      return `error: note "${args.note_id}" not found`
    }
    // check system access permissions for non-admin --------------------
    if (finalid.startsWith('system/')) {
      const parts = finalid.split('/')
      const folderuser = parts[1]
      const currentuser = context.activeuserid || context.activeuser?.id
      if (!context.isadmin && folderuser !== currentuser) {
        return `error: access denied to system note "${finalid}"`
      }
    }
    args.note_id = finalid
    return `success: opened "${finalid}" in a new tab for the user`
  }

  // create note --------------------
  if (name === 'note_create') {
    const cleantitle = (args.title || 'untitled').replace(/[^a-zA-Z0-9_\- ]/g, '').trim()
    const folder = args.folder ? args.folder.replace(/[^a-zA-Z0-9_\-\/]/g, '').trim() : ''
    const filename = `${cleantitle.toLowerCase().replace(/\s+/g, '_')}.md`
    const noteid = folder ? `${folder}/${filename}` : filename

    let body = unliteralescapes(args.markdown || '')
    if (!body.startsWith('#')) {
      body = `# ${cleantitle}\n\n${body}`
    }

    const entry = getdoc(vaultdir, historydir, noteid)
    entry.doc.transact(() => {
      entry.ytext.delete(0, entry.ytext.length)
    }, 'ai')

    // stream initial content in natural multi-word chunks into file --------------------
    const editid = `ai_create_${Date.now()}`
    await streaminsert(entry, 0, body, { author: 'ai', edit_id: editid })

    entry.flushtodisk('ai')

    // save created note id onto args for client --------------------
    args.note_id = noteid

    return `created note [${noteid}] successfully`
  }

  // move or rename note or folder --------------------
  if (name === 'note_move') {
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
        return 'error: access denied to system notes and folders'
      }
    }

    try {
      const res = movenoteorfolder(vaultdir, historydir, rawsrc, rawdest, 'ai')
      migratedocentry(res.source, res.destination, res.type === 'folder')
      args.source = res.source
      args.destination = res.destination
      args.move_type = res.type
      return `success: ${res.message}`
    } catch (err) {
      return `error: ${err.message}`
    }
  }

  // copy note or folder --------------------
  if (name === 'note_copy') {
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
        return 'error: access denied to system notes and folders'
      }
    }

    try {
      const res = copynoteorfolder(vaultdir, historydir, rawsrc, rawdest, 'ai')
      args.source = res.source
      args.destination = res.destination
      args.copy_type = res.type
      return `success: ${res.message}`
    } catch (err) {
      return `error: ${err.message}`
    }
  }

  // delete note --------------------
  if (name === 'note_delete') {
    const rawid = (args.note_id || '').trim()
    if (!rawid) {
      return 'error: note_id is required'
    }

    const cleanid = rawid.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (cleanid.startsWith('system')) {
      if (!context.isadmin) {
        return 'error: access denied to system notes'
      }
    }

    try {
      const deleted = deletenote(vaultdir, cleanid, historydir, 'ai')
      if (deleted) {
        args.note_id = cleanid
        return `success: permanently deleted note [${cleanid}]`
      }
      return `error: note "${cleanid}" not found`
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

  // edit note with diff --------------------
  if (name === 'note_edit_diff') {
    try {
      const updated = await applydiff(vaultdir, historydir, args.note_id, {
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
        author: 'ai'
      })
      const entry = getdoc(vaultdir, historydir, args.note_id)
      entry.flushtodisk('ai')
      const editcount = Array.isArray(args.edits) ? args.edits.length : 1
      return `success: note [${args.note_id}] updated with ${editcount} edit(s) (${updated.length} chars total)`
    } catch (err) {
      return `error: ${err.message}`
    }
  }

  // note history --------------------
  if (name === 'note_history') {
    const limit = args.limit || 5
    const history = gethistory(historydir, args.note_id, limit)
    if (history.length === 0) return `no history found for note [${args.note_id}]`
    const lines = history.map(h => `[rev:${h.id}] ${formatrelative(new Date(h.timestamp).toISOString())} by ${h.author}: "${h.preview.slice(0, 60)}..."`)
    return lines.join('\n')
  }

  // update user memory facts --------------------
  if (name === 'user_profile_update') {
    const targetuserid = args.scope === 'partner' ? partneruser?.id : activeuser?.id
    if (!targetuserid) {
      return 'error: target user could not be identified'
    }
    const profilepath = `system/${targetuserid}/personality.md`
    const entry = getdoc(vaultdir, historydir, profilepath)
    const current = entry.ytext.toString()
    const factline = `\n- ${args.key}: ${args.value}`

    entry.doc.transact(() => {
      entry.ytext.insert(entry.ytext.length, factline)
    }, 'ai')
    entry.flushtodisk('ai')

    return `saved fact "${args.key}" for ${targetuserid}`
  }

  return `error: unknown tool ${name}`
}

