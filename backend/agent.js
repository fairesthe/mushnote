import { GoogleGenAI } from '@google/genai'
import { loadconfig, getvaultpath, gethistorypath } from './config.js'
import { readuserpreferences, readnote, listnotes } from './vault.js'
import { tooldeclarations, executetool, extractheadings } from './tools.js'
import { getweather } from './weather.js'
import { log } from './logger.js'
import { compresschathistory } from './chathistory.js'

// format local date and time with 12h am and pm --------------------
function formatlocalnow(d = new Date(), timezone = '') {
  try {
    const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    })
    const parts = Object.fromEntries(formatter.formatToParts(d).map(p => [p.type, p.value]))
    const dayperiod = parts.dayPeriod ? ` ${parts.dayPeriod}` : ''
    return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}${dayperiod}`
  } catch {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const year = d.getFullYear()
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    let hours = d.getHours()
    const mins = String(d.getMinutes()).padStart(2, '0')
    const ampm = hours >= 12 ? 'PM' : 'AM'
    hours = hours % 12 || 12
    return `${days[d.getDay()]} ${year}-${month}-${day} ${hours}:${mins} ${ampm}`
  }
}

// dynamic system prompt header builder --------------------
function buildsystemprompt(ainame, activeuser, allusers, activenoteid, opentabs = [], activenotecontent = '', aipersonality = '', weatherinfo = '', locationname = '', timezone = '') {
  const datestr = formatlocalnow(new Date(), timezone)
  const active = activeuser ? activeuser.name || activeuser.id : 'unknown'
  const userlist = allusers.map(u => u.name || u.id).join(', ')
  const tabslist = (opentabs && opentabs.length > 0)
    ? ` | Open Tabs: [${opentabs.join(', ')}]`
    : ''
  const ispreview = Boolean(activenoteid && activenoteid.startsWith('preview:'))
  const rawfile = ispreview ? activenoteid.slice('preview:'.length) : activenoteid
  const currentnote = activenoteid
    ? (ispreview ? ` | Active Note: [${activenoteid}] (User is currently previewing the rendered web page for ${rawfile})` : ` | Active Note: [${activenoteid}]`)
    : ''
  const locationline = locationname ? `\n- Location: ${locationname}` : ''
  const weatherline = weatherinfo ? `\n- Weather: ${weatherinfo}` : ''
  const personalitysection = aipersonality ? `\n\n${aipersonality}` : ''
  const activecontentblock = activenotecontent
    ? (ispreview
      ? `\n\nActive File Content [source code for preview ${rawfile}]:\n"""\n${activenotecontent}\n"""`
      : `\n\nActive File Content [${activenoteid}]:\n"""\n${activenotecontent}\n"""`)
    : ''

  return `Context:
- App: mushnote (collaborative note-taking application)
- Assistant: ${ainame} | Current User: ${active} | Users: ${userlist} | Now: ${datestr}${tabslist}${currentnote}${locationline}${weatherline}
- Unread Emails: 0
- Today's Events (0): none
- Upcoming (48h): none${activecontentblock}

How mushnote works:
- Storage and Vault:
  - All files and folders live inside the vault folder on disk as standard text files (.md, .txt, .json, .yaml, .csv, .py, .js, .html, etc.)
  - The special 'system/' directory inside the vault stores user preferences (system/<user>/preferences.yaml), personality profiles (system/<user>/personality.md), and global app configuration (system/config.yaml). Admins have access to system files
  - Every file modification is versioned in the history directory with timestamps, authorship, and diffs so past versions can be inspected or restored
- Workspace and Editor:
  - The main editor is a collaborative WYSIWYG editor supporting Markdown shortcuts, code blocks, task lists, image attachments, text highlighting using ==highlighted text== syntax, LaTeX math formulas (inline $...$ and block $$...$$), and clickable markdown links [label](target.md) that open other notes in tabs
  - Multi-tab navigation at the top tracks open files. Opening a file opens a tab, and deleting or closing a file automatically removes its tab
  - The left sidebar provides folder navigation, breadcrumbs, search, and context actions (new file, rename, move, delete, copy/paste)
  - Edits made by users or you (the AI) stream in real-time with visual flash highlights and avatar badges showing exact text changes
- Your Role and Capabilities:
  - You are an autonomous assistant integrated directly into the workspace with access to vault file tools
  - You can inspect outlines, read specific sections or full files, perform targeted diff edits, create files of any extension, move or copy files and folders, and open files in tabs for the user
  - When editing, your changes appear live in the user's editor with your avatar and highlight color

Rules:
- Actions before conversation: when the user asks to edit, add, update, insert, delete, or create files or content, you MUST invoke the function call directly. Never output <thought> tags, text, or filler before or alongside tool calls. Execute the tools first with no text in that turn
- When editing files, use file_edit_diff. Choose the best mode: 'replace' to modify text, 'insert_after' to add new items under a heading or bullet without duplicating the anchor, 'insert_before' to insert before an anchor, 'delete' to remove text, or 'append' to add to the end of the file. For multiple edits, pass an 'edits' array to apply all changes in one call
- When creating files, use file_create. You can specify any file extension (e.g. .md, .txt, .json, .yaml, .csv, .py, .js). If no extension is specified, it defaults to .md
- You can read and write highlighted text in files using ==highlighted text== syntax (e.g. ==key takeaway==) to highlight important points or terms for the user
- You can read and write LaTeX math formulas in files using inline ($...$) and block ($$...$$) syntax
- You can link to other notes or files using standard markdown links [label](path/to/file.md) or [label](file.md), which render as clickable links for the user to open tabs both in notes and in chat responses
- In chat responses, you can format math formulas using LaTeX (inline $...$ or block $$...$$) and markdown (headings, lists, code blocks, and ==highlight==) which render visually for the user
- Only in your final conversational response (after tool execution is finished), include your brief internal thoughts wrapped in <thought>...</thought> tags before your reply text (e.g. <thought>reasoning or plan</thought>)
- When asking multiple-choice questions, yes/no confirmations, or quiz prompts, provide the options at the very end in an options tag:
  <options>["Option A", "Option B", "Option C"]</options>
- When grading quiz answers or checking facts, carefully verify the user's response against the file text. If their answer is incorrect, state that it is incorrect and explain the correct answer.
- When the user asks to open, view, or pull up a file in their editor, call file_open_for_user (or file_open with open_in_tab: true) to open it in a new tab for them.
- Rely primarily on the provided Active File Content and conversation history for answering questions. If the Active File Content is marked as truncated [previewing lines ... of ...], or if you need sections or items not visible in the preview, you MUST call file_open (with heading or start_line) or file_outline to read the rest before concluding items do not exist or creating derivative files.
- file_search accepts an optional path parameter to search within a specific file, returning matching line numbers and section headings.
- For large files not fully in context, call file_outline first to check headings, or use file_open with the 'heading' or 'start_line' parameter to read only the relevant section instead of loading the entire document.
- To rename or move files or folders, call file_move with 'source' and 'destination'. Destination can be a new filename, target folder path, or new folder name.
- To copy or duplicate files or folders, call file_copy with 'source' and 'destination'. Destination can be a new filename, target folder path, or new folder name.
- To permanently delete files or folders, call file_delete with 'path', or folder_delete with 'folder_path'.
- To view, listen to, or analyze any file (images, PDFs, audio recordings, video), call file_view with the vault path. The file content is loaded directly into your AI context so you can see, hear, or read it. For text and code files, file_open is preferred; use file_view only for binary or media files.
- During conversation, if the user shares personal information, preferences, interests, habits, goals, or facts about themselves or their partner, call user_profile_update immediately to record them. Do not wait for the conversation to end. Use scope 'me' for the active user and 'partner' for the other user. Examples: dietary preferences, hobbies, work, relationships, recurring tasks, things they like or dislike.${personalitysection}`
}

// format tool call summary on a single line --------------------
function formattoolargs(call) {
  const args = call.args || {}
  const target = args.path || args.file_path || args.note_id || args.source || args.folder_path || args.query || args.heading || ''
  const mode = args.mode ? `mode: ${args.mode}` : ''
  const parts = [target, mode].filter(Boolean).join(' ')
  return parts ? `(${parts})` : ''
}

// format user friendly live status text while tool executes --------------------
function formattoolstatus(call) {
  const name = call.name
  const args = call.args || {}
  const target = args.path || args.filename || args.title || args.note_id || ''

  if (name === 'file_create') {
    return target ? `creating ${target}...` : 'creating a file...'
  }
  if (name === 'file_open' || name === 'file_open_for_user') {
    return target ? `opening ${target}...` : 'reading a file...'
  }
  if (name === 'file_view') {
    return target ? `analyzing ${target}...` : 'loading file for analysis...'
  }
  if (name === 'file_edit_diff') {
    return target ? `editing ${target}...` : 'editing file...'
  }
  if (name === 'file_search') {
    return args.query ? `searching files for "${args.query}"...` : 'searching files...'
  }
  if (name === 'file_outline') {
    return target ? `reading outline of ${target}...` : 'checking outline...'
  }
  if (name === 'file_list_recent') {
    return 'checking recent files...'
  }
  if (name === 'file_history') {
    return target ? `reading history of ${target}...` : 'checking file history...'
  }
  if (name === 'file_move') {
    return args.source ? `moving ${args.source}...` : 'moving file...'
  }
  if (name === 'file_copy') {
    return args.source ? `copying ${args.source}...` : 'copying file...'
  }
  if (name === 'file_delete') {
    return target ? `deleting ${target}...` : 'deleting file...'
  }
  if (name === 'folder_delete') {
    return args.folder_path ? `deleting folder ${args.folder_path}...` : 'deleting folder...'
  }
  if (name === 'user_profile_update') {
    return 'updating profile...'
  }
  return 'working...'
}

// turn reference attachments into prompt text for the model --------------------
function formatreferenceattachment(att, vaultdir) {
  if (!att || att.type !== 'reference') return ''

  if (att.refKind === 'selection' && att.text) {
    const loc = att.path ? ` from "${att.path}"` : ''
    const lines = att.lineStart && att.lineEnd
      ? ` (lines ${att.lineStart}-${att.lineEnd})`
      : ''
    return `[attached text selection${loc}${lines}]\n\`\`\`\n${att.text}\n\`\`\``
  }

  if (att.refKind === 'file' && att.path) {
    const note = readnote(vaultdir, att.path)
    if (note && typeof note.content === 'string' && note.content.length > 0) {
      const maxchars = 12000
      const body = note.content.length > maxchars
        ? `${note.content.slice(0, maxchars)}\n...[truncated — use file_open for the rest]`
        : note.content
      return `[attached vault file: ${att.path}]\n\`\`\`\n${body}\n\`\`\``
    }
    return `[attached vault file: ${att.path} — use file_open or file_view to load it]`
  }

  if (att.refKind === 'folder' && att.path) {
    const prefix = `${att.path}/`
    const children = listnotes(vaultdir)
      .filter((n) => n.note_id === att.path || n.note_id.startsWith(prefix))
      .slice(0, 40)
      .map((n) => `- ${n.note_id}`)
    const listing = children.length > 0 ? `\n${children.join('\n')}` : ''
    return `[attached vault folder: ${att.path}]${listing}`
  }

  return ''
}

// execute chat request with autonomous tool handling --------------------
export async function runagentchat(prompt, options = {}) {
  const { active_user_id, is_admin = false, active_note_id, open_tabs = [], history = [], attachments = [], onProgress } = options
  const conf = loadconfig()
  const vaultdir = getvaultpath(conf)
  const historydir = gethistorypath(conf)

  // resolve ai name and personality --------------------
  const users = conf.users || []
  const aiusername = conf.gemini?.['ai-username'] || conf.gemini?.ai_username || 'ai'
  const aiconf = users.find(u => (u.username || u.id) === aiusername) || users.find(u => u.bot || u.role === 'ai') || { username: 'ai', id: 'ai' }
  const aiprefs = readuserpreferences(vaultdir, aiconf.username || aiconf.id) || {}
  const ainame = aiprefs.name || 'Ai'

  const aipersonalitynote = readnote(vaultdir, `system/${aiconf.username || aiconf.id}/personality.md`)
  const aipersonality = aipersonalitynote ? aipersonalitynote.content : ''

  // resolve human users --------------------
  const humanusers = users.filter(u => !u.bot && u.role !== 'ai').map(u => {
    const userid = u.username || u.id
    const prefs = readuserpreferences(vaultdir, userid) || {}
    return {
      id: userid,
      name: prefs.name || userid
    }
  })

  const activeuser = humanusers.find(u => u.id === active_user_id) || humanusers[0]
  const locationname = typeof conf.location === 'string'
    ? conf.location
    : (conf.location?.city || conf.location?.query || conf.location?.name || '')
  const weatherinfo = await getweather(conf.location)

  // load active note content into system prompt if open --------------------
  let activenotecontent = ''
  if (active_note_id) {
    const rawtargetid = active_note_id.startsWith('preview:') ? active_note_id.slice('preview:'.length) : active_note_id
    const note = readnote(vaultdir, rawtargetid)
    if (note && note.content) {
      const lines = note.content.split('\n')
      if (lines.length <= 450) {
        activenotecontent = note.content
      } else {
        const { headings } = extractheadings(note.content)
        const headingslist = headings.length > 0
          ? '\n\nsections:\n' + headings.map(h => `- line ${h.line}: ${h.raw}`).join('\n')
          : ''
        activenotecontent = lines.slice(0, 250).join('\n') + `\n\n[previewing lines 1-250 of ${lines.length} - use file_open with heading or start_line to read remaining sections]${headingslist}`
      }
    }
  }

  const userpref = readuserpreferences(vaultdir, active_user_id)
  const timezone = userpref?.timezone || conf.location?.timezone || conf.timezone || ''
  const systeminstruction = buildsystemprompt(ainame, activeuser, humanusers, active_note_id, open_tabs, activenotecontent, aipersonality, weatherinfo, locationname, timezone)
  const ai = new GoogleGenAI({ apiKey: conf.gemini?.api_key })

  const chathistory = compresschathistory(history)

  const chat = ai.chats.create({
    model: 'gemini-3.5-flash-lite',
    history: chathistory,
    config: {
      systemInstruction: systeminstruction,
      tools: [{ functionDeclarations: tooldeclarations }],
      thinkingConfig: { thinkingLevel: 'minimal' },
      mediaResolution: 'MEDIA_RESOLUTION_MEDIUM'
    }
  })

  const toolcallsexecuted = []

  // execute send message stream with automatic retries for transient overload --------------------
  async function sendstreamwithretry(msgpayload, maxtries = 3) {
    let attempt = 0
    let delay = 1500
    while (attempt < maxtries) {
      try {
        const stream = await chat.sendMessageStream({ message: msgpayload })
        let turntext = ''
        const functioncalls = []
        let hasfunctioncalls = false
        const textbuffer = []

        for await (const chunk of stream) {
          // gather any function calls directly or via parts --------------------
          if (chunk.functionCalls && chunk.functionCalls.length > 0) {
            hasfunctioncalls = true
            functioncalls.push(...chunk.functionCalls)
          }

          // extract text and any nested function calls from parts directly --------------------
          let text = ''
          const parts = chunk.candidates?.[0]?.content?.parts || []
          for (const part of parts) {
            if (part.functionCall) {
              hasfunctioncalls = true
              if (!functioncalls.includes(part.functionCall)) {
                functioncalls.push(part.functionCall)
              }
            } else if (typeof part.text === 'string' && !part.thought) {
              text += part.text
            }
          }

          if (text) {
            turntext += text
            if (!hasfunctioncalls) {
              textbuffer.push(text)
              // buffer briefly to ensure model is not emitting filler before tool call --------------------
              if (textbuffer.length >= 2 || turntext.length > 60) {
                while (textbuffer.length > 0) {
                  const buffered = textbuffer.shift()
                  if (onProgress && !hasfunctioncalls) {
                    onProgress('chunk', { text: buffered, fulltext: turntext })
                  }
                }
              }
            }
          }

          if (hasfunctioncalls && textbuffer.length > 0) {
            textbuffer.length = 0
          }
        }

        // flush any remaining buffered text if this turn made no tool calls --------------------
        if (!hasfunctioncalls && textbuffer.length > 0 && onProgress) {
          while (textbuffer.length > 0) {
            const buffered = textbuffer.shift()
            onProgress('chunk', { text: buffered, fulltext: turntext })
          }
        }

        return {
          text: hasfunctioncalls ? '' : turntext,
          functionCalls: functioncalls
        }
      } catch (err) {
        attempt += 1
        const errmsg = String(err.message || err)
        const istransient = errmsg.includes('503') || errmsg.includes('UNAVAILABLE') || errmsg.includes('overloaded')

        if (istransient && attempt < maxtries) {
          await new Promise(r => setTimeout(r, delay))
          delay *= 1.5
          continue
        }
        throw err
      }
    }
  }

  // construct initial message parts with text and attachments --------------------
  const messageparts = []
  const refblocks = []
  if (Array.isArray(attachments) && attachments.length > 0) {
    for (const att of attachments) {
      if (att?.type === 'reference') {
        const block = formatreferenceattachment(att, vaultdir)
        if (block) refblocks.push(block)
        continue
      }
      if (att && att.data && att.mimeType) {
        messageparts.push({
          inlineData: {
            mimeType: att.mimeType,
            data: att.data
          }
        })
      }
    }
  }

  let usertext = prompt && typeof prompt === 'string' ? prompt.trim() : ''
  if (refblocks.length > 0) {
    const refsection = refblocks.join('\n\n')
    usertext = usertext ? `${usertext}\n\n${refsection}` : refsection
  }
  if (usertext) {
    messageparts.unshift({ text: usertext })
  }

  const initialpayload = messageparts.length > 0 ? messageparts : [{ text: '' }]
  const starttime = Date.now()
  const preview = prompt ? (prompt.length > 55 ? `${prompt.slice(0, 55)}...` : prompt).replace(/\r?\n/g, ' ') : 'attachments'
  const userlabel = activeuser?.name || activeuser?.id || 'unknown'
  log.agent('prompt', `[${active_note_id || 'no active note'}]`, `user: ${userlabel} | "${preview}"`)

  let response = await sendstreamwithretry(initialpayload)
  let iterations = 0

  // tool execution loop --------------------
  while (response.functionCalls && response.functionCalls.length > 0 && iterations < 8) {
    iterations += 1
    const functionresponses = []

    for (const call of response.functionCalls) {
      log.agent('tool', call.name, formattoolargs(call))
      if (onProgress) {
        onProgress('status', { status: formattoolstatus(call) })
      }

      const tooloutput = await executetool(call.name, call.args, {
        vaultdir,
        historydir,
        activeuser,
        activeuserid: active_user_id,
        isadmin: is_admin,
        ainame,
        aiusername: aiconf.username || aiconf.id || 'ai'
      })

      toolcallsexecuted.push({
        name: call.name,
        args: call.args,
        output: tooloutput?.__inlinedata ? tooloutput.text : tooloutput
      })

      if (onProgress) {
        onProgress('tool_call', {
          name: call.name,
          args: call.args,
          output: tooloutput?.__inlinedata ? tooloutput.text : tooloutput
        })
      }

      // check if tool returned inline media data --------------------
      if (tooloutput && typeof tooloutput === 'object' && tooloutput.__inlinedata) {
        functionresponses.push({
          functionResponse: {
            name: call.name,
            response: { output: tooloutput.text, path: tooloutput.path }
          }
        })
        functionresponses.push({
          inlineData: {
            mimeType: tooloutput.mimeType,
            data: tooloutput.data
          }
        })
      } else {
        functionresponses.push({
          functionResponse: {
            name: call.name,
            response: { output: tooloutput }
          }
        })
      }
    }

    if (onProgress) {
      onProgress('status', { status: 'thinking...' })
    }

    response = await sendstreamwithretry(functionresponses)
  }

  let rawtext = response.text || ''

  // if tool loop ended without conversational text ask agent to provide summary reply --------------------
  if (!rawtext.trim() && toolcallsexecuted.length > 0) {
    try {
      const summaryturn = await sendstreamwithretry([{ text: 'all requested actions have completed please provide your final conversational reply to the user summarizing what was done' }])
      rawtext = summaryturn.text || ''
    } catch (e) {
      log.agent('warn', 'failed to generate summary reply', e.message)
    }
    if (!rawtext.trim()) {
      const lastcall = toolcallsexecuted[toolcallsexecuted.length - 1]
      rawtext = `completed ${toolcallsexecuted.length} action(s) including ${lastcall.name}`
    }
  }
  const thoughtmatch = rawtext.match(/<thought>([\s\S]*?)<\/thought>/i)
  const thought = thoughtmatch ? thoughtmatch[1].replace(/<\/?[a-zA-Z0-9_\-:]+(?:\s+[^>]*)?>/gi, '').trim() : ''
  let cleantext = rawtext.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim()

  // extract interactive response options if provided --------------------
  let optionslist = []
  const optionsmatch = cleantext.match(/<options>([\s\S]*?)<\/options>/i)
  if (optionsmatch) {
    const rawoptions = optionsmatch[1].trim()
    try {
      const parsed = JSON.parse(rawoptions)
      if (Array.isArray(parsed)) {
        optionslist = parsed.map(o => String(o).trim()).filter(Boolean)
      }
    } catch {
      optionslist = rawoptions
        .split(/[,\n]/)
        .map(s => s.replace(/["'[\]]/g, '').trim())
        .filter(Boolean)
    }
    cleantext = cleantext.replace(/<options>[\s\S]*?<\/options>/gi, '').trim()
  } else {
    // fallback for plain text options format --------------------
    const fallbackmatch = cleantext.match(/\n\s*options:\s*(\[[\s\S]*?\])/i) || cleantext.match(/\n\s*options:\s*([^\n]+)$/i)
    if (fallbackmatch) {
      const rawoptions = fallbackmatch[1].trim()
      try {
        const parsed = JSON.parse(rawoptions)
        if (Array.isArray(parsed)) {
          optionslist = parsed.map(o => String(o).trim()).filter(Boolean)
        }
      } catch {
        optionslist = rawoptions
          .split(/[,\n]/)
          .map(s => s.replace(/["'[\]]/g, '').trim())
          .filter(Boolean)
      }
      cleantext = cleantext.slice(0, fallbackmatch.index).trim()
    }
  }

  // strip any remaining xml tags from reply --------------------
  cleantext = cleantext.replace(/<\/?[a-zA-Z0-9_\-:]+(?:\s+[^>]*)?>/gi, '').trim()

  let updatedhistory = []
  try {
    const rawhistory = await chat.getHistory()
    updatedhistory = compresschathistory(rawhistory)
  } catch { }

  const elapsed = Date.now() - starttime
  log.agent('reply', `${cleantext.length} chars`, `completed in ${elapsed}ms`)

  return {
    reply: cleantext,
    thought,
    options: optionslist,
    tool_calls: toolcallsexecuted,
    ai_name: ainame,
    system_prompt: systeminstruction,
    history: updatedhistory
  }
}
