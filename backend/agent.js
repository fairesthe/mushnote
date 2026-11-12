import { GoogleGenAI } from '@google/genai'
import { loadconfig, getvaultpath, gethistorypath } from './config.js'
import { readuserpreferences, readnote } from './vault.js'
import { tooldeclarations, executetool } from './tools.js'
import { getweather } from './weather.js'

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
  const currentnote = activenoteid ? ` | Active Note: [${activenoteid}]` : ''
  const locationline = locationname ? `\n- Location: ${locationname}` : ''
  const weatherline = weatherinfo ? `\n- Weather: ${weatherinfo}` : ''
  const personalitysection = aipersonality ? `\n\n${aipersonality}` : ''
  const activecontentblock = activenotecontent
    ? `\n\nActive Note Content [${activenoteid}]:\n"""\n${activenotecontent}\n"""`
    : ''

  return `Context:
- App: mushnote (collaborative note-taking application)
- Assistant: ${ainame} | Current User: ${active} | Users: ${userlist} | Now: ${datestr}${tabslist}${currentnote}${locationline}${weatherline}
- Unread Emails: 0
- Today's Events (0): none
- Upcoming (48h): none${activecontentblock}

Rules:
- You are the built-in AI assistant for mushnote, a collaborative note-taking application.
- Before writing any message or response to the user, you MUST include your brief internal thoughts wrapped in <thought>...</thought> tags (e.g. <thought>reasoning or plan</thought>).
- When asking multiple-choice questions, yes/no confirmations, or quiz prompts, provide the options at the very end in an options tag:
  <options>["Option A", "Option B", "Option C"]</options>
- When grading quiz answers or checking facts, carefully verify the user's response against the note text. If their answer is incorrect, state that it is incorrect and explain the correct answer.
- When the user asks to open, view, or pull up a note in their editor, call note_open_for_user (or note_open with open_in_tab: true) to open it in a new tab for them.
- Rely primarily on the provided Active Note Content and conversation history for answering questions. Do NOT call note_search or note_open if the content is already in context, unless the user mentions edits or changes, the note is not active and might be updated, or you need to inspect unread sections.
- Never call note_search when the note ID is already known or open.
- For large notes not fully in context, call note_outline first to check headings, or use note_open with the 'heading' parameter to read only the relevant section instead of loading the entire document.
- When editing notes, use note_edit_diff. Choose the best mode: 'replace' to modify text, 'insert_after' to add new items under a heading or bullet without duplicating the anchor, 'insert_before' to insert before an anchor, 'delete' to remove text, or 'append' to add to the end of the note. For multiple edits, pass an 'edits' array to apply all changes in one call.
- To rename or move notes or folders, call note_move with 'source' and 'destination'. Destination can be a new filename, target folder path, or new folder name.
- To copy or duplicate notes or folders, call note_copy with 'source' and 'destination'. Destination can be a new filename, target folder path, or new folder name.
- To permanently delete notes or folders, call note_delete with 'note_id', or folder_delete with 'folder_path'.${personalitysection}`
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

  // load active note content snippet into system prompt if open --------------------
  let activenotecontent = ''
  if (active_note_id) {
    const note = readnote(vaultdir, active_note_id)
    if (note && note.content) {
      const lines = note.content.split('\n')
      if (lines.length <= 150) {
        activenotecontent = note.content
      } else {
        activenotecontent = lines.slice(0, 80).join('\n') + `\n\n[previewing lines 1-80 of ${lines.length} - use note_outline or note_open to read other sections]`
      }
    }
  }

  const userpref = readuserpreferences(vaultdir, active_user_id)
  const timezone = userpref?.timezone || conf.location?.timezone || conf.timezone || ''
  const systeminstruction = buildsystemprompt(ainame, activeuser, humanusers, active_note_id, open_tabs, activenotecontent, aipersonality, weatherinfo, locationname, timezone)
  const ai = new GoogleGenAI({ apiKey: conf.gemini?.api_key })

  // format conversation history for gemini chat session --------------------
  const chathistory = []
  if (history && Array.isArray(history)) {
    for (const turn of history) {
      if (turn.parts && Array.isArray(turn.parts)) {
        chathistory.push({
          role: turn.role === 'assistant' ? 'model' : turn.role,
          parts: turn.parts
        })
      } else {
        const role = turn.role === 'model' || turn.role === 'assistant' ? 'model' : 'user'
        const text = turn.content || turn.text || turn.prompt || turn.reply || ''
        if (text) {
          chathistory.push({
            role,
            parts: [{ text }]
          })
        }
      }
    }
  }

  const chat = ai.chats.create({
    model: 'gemini-3.5-flash-lite',
    history: chathistory,
    config: {
      systemInstruction: systeminstruction,
      tools: [{ functionDeclarations: tooldeclarations }],
      thinkingConfig: { thinkingLevel: 'minimal' },
      mediaResolution: 'MEDIA_RESOLUTION_LOW'
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

        for await (const chunk of stream) {
          if (chunk.functionCalls && chunk.functionCalls.length > 0) {
            functioncalls.push(...chunk.functionCalls)
          }
          const text = chunk.text
          if (text) {
            turntext += text
            if (onProgress) {
              onProgress('chunk', { text, fulltext: turntext })
            }
          }
        }

        return {
          text: turntext,
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
  if (prompt && typeof prompt === 'string') {
    messageparts.push({ text: prompt })
  }
  if (Array.isArray(attachments) && attachments.length > 0) {
    for (const att of attachments) {
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

  const initialpayload = messageparts.length > 0 ? messageparts : [{ text: '' }]
  let response = await sendstreamwithretry(initialpayload)
  let iterations = 0

  // tool execution loop --------------------
  while (response.functionCalls && response.functionCalls.length > 0 && iterations < 5) {
    iterations += 1
    const functionresponses = []

    for (const call of response.functionCalls) {
      if (onProgress) {
        onProgress('status', { status: `running ${call.name}...` })
      }

      const tooloutput = await executetool(call.name, call.args, {
        vaultdir,
        historydir,
        activeuser,
        activeuserid: active_user_id,
        isadmin: is_admin,
        ainame
      })

      toolcallsexecuted.push({
        name: call.name,
        args: call.args,
        output: tooloutput
      })

      if (onProgress) {
        onProgress('tool_call', {
          name: call.name,
          args: call.args,
          output: tooloutput
        })
      }

      functionresponses.push({
        functionResponse: {
          name: call.name,
          response: { output: tooloutput }
        }
      })
    }

    if (onProgress) {
      onProgress('status', { status: 'thinking...' })
    }

    response = await sendstreamwithretry(functionresponses)
  }

  const rawtext = response.text || ''
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
    updatedhistory = await chat.getHistory()
  } catch { }

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
