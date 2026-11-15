import { GoogleGenAI } from '@google/genai'
import { loadconfig, getvaultpath, gethistorypath } from '../core/config.js'
import { readuserpreferences, readnote, listnotes } from '../vault/vault.js'
import { tooldeclarations, executetool, extractheadings } from './tools.js'
import { getweather } from '../integrations/weather.js'
import { log } from '../core/logger.js'
import { compresschathistory, foldtooloutputfordisplay } from './chathistory.js'
import { sanitizereplycites } from './chatreplysanitize.js'
import { recovertoolcallsfromtext, striphallucinatedtoolcalls } from './texttoolrecovery.js'
import { buildsystemprompt, userreferencesactivenote } from './agentprompt.js'

const agentmodel = 'gemini-3.5-flash-lite'
const maxtooliterations = 8

// one functionResponse per call with the matching id, media rides inside it --------------------
// tool errors go under "error" so the model can tell a failure from a result
function buildfunctionresponse(call, tooloutput) {
  const base = { name: call.name }
  if (call.id) base.id = call.id

  if (tooloutput && typeof tooloutput === 'object' && tooloutput.__inlinedata) {
    return {
      functionResponse: {
        ...base,
        response: { output: tooloutput.text, path: tooloutput.path },
        parts: [{ inlineData: { mimeType: tooloutput.mimeType, data: tooloutput.data } }]
      }
    }
  }
  if (tooloutput && typeof tooloutput === 'object' && typeof tooloutput.error === 'string') {
    return { functionResponse: { ...base, response: { error: tooloutput.error } } }
  }
  if (typeof tooloutput === 'string' && /^error:/i.test(tooloutput)) {
    return { functionResponse: { ...base, response: { error: tooloutput.replace(/^error:\s*/i, '') } } }
  }
  return { functionResponse: { ...base, response: { output: tooloutput } } }
}

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

function resolveactivenoteblock(vaultdir, activenoteid, prompt, attachments) {
  if (!activenoteid) return { block: '', mode: 'none' }
  const rawtargetid = activenoteid.startsWith('preview:') ? activenoteid.slice('preview:'.length) : activenoteid
  const note = readnote(vaultdir, rawtargetid)
  if (!note?.content) return { block: '', mode: 'none' }

  const includenote = userreferencesactivenote(prompt, activenoteid, attachments)
  const lines = note.content.split('\n')
  const { headings } = extractheadings(note.content)
  const headinglines =
    headings.length > 0
      ? headings.map((h) => `- line ${h.line}: ${h.raw}`).join('\n')
      : '- (no headings)'

  if (includenote) {
    if (lines.length <= 450) {
      return { block: note.content, mode: 'full' }
    }
    const preview = lines.slice(0, 250).join('\n')
    return {
      block: `${preview}\n\n[previewing lines 1-250 of ${lines.length} — use file_open for more]\n\nsections:\n${headinglines}`,
      mode: 'full',
    }
  }

  const peek = lines.slice(0, 48).join('\n')
  return {
    block: `file: ${activenoteid} (${lines.length} lines, not inlined — unrelated chat)\n\npeek:\n${peek}\n\nsections:\n${headinglines}`,
    mode: 'outline',
  }
}

function recoveredresultstext(functionresponses) {
  const blocks = functionresponses.map(({ functionResponse: fr }) => {
    const body = fr.response?.error !== undefined ? `error: ${fr.response.error}` : fr.response?.output
    return `[${fr.name} result]\n${typeof body === 'string' ? body : JSON.stringify(body)}`
  })
  return `you wrote tool calls as plain text instead of calling the tools. they were run anyway, results below. use real function calls next time.\n\n${blocks.join('\n\n')}`
}

// format tool call summary on a single line --------------------
function formattoolargs(call) {
  const args = call.args || {}
  const target = args.path || args.file_path || args.note_id || args.source || args.folder_path || args.query || args.url || args.heading || ''
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
  if (name === 'web_search') {
    return args.query ? `searching web for "${args.query}"...` : 'searching web...'
  }
  if (name === 'web_read_page') {
    const target = args.url || 'page'
    try {
      const parsed = new URL(target)
      return `reading ${parsed.hostname}...`
    } catch {
      return 'reading web page...'
    }
  }
  if (name === 'youtube_video') {
    const action = String(args.action || 'info').toLowerCase()
    if (action === 'transcript') return 'fetching youtube transcript...'
    if (action === 'download') {
      const media = String(args.media || 'audio').toLowerCase()
      return media === 'video' ? 'downloading youtube video...' : 'downloading youtube audio...'
    }
    return 'reading youtube details...'
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

  if (att.refKind === 'chat' && att.text) {
    const who = att.role === 'user' ? 'user' : 'assistant'
    const label = att.name || `prior ${who} message`
    const when = att.timestamp ? ` (${att.timestamp})` : ''
    const maxchars = 6000
    const body = String(att.text).length > maxchars
      ? `${String(att.text).slice(0, maxchars)}\n...[truncated in reference]`
      : String(att.text)
    return `[attached chat reference — ${label}${when}]\n\`\`\`\n${body}\n\`\`\`\nThe user is replying in context of this quoted message. Address their new prompt in relation to it.`
  }

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

  const userpref = readuserpreferences(vaultdir, active_user_id)
  const timezone = userpref?.timezone || conf.location?.timezone || conf.timezone || ''
  const datestr = formatlocalnow(new Date(), timezone)
  const { block: activenoteblock, mode: activenotemode } = resolveactivenoteblock(
    vaultdir,
    active_note_id,
    prompt,
    attachments
  )
  const systempromptpack = buildsystemprompt({
    ainame,
    activeuser,
    allusers: humanusers,
    activenoteid: active_note_id,
    opentabs: open_tabs,
    activenoteblock,
    activenotemode,
    aipersonality,
    weatherinfo,
    locationname,
    datestr,
  })
  const systeminstruction = systempromptpack.text
  const systempromptmeta = systempromptpack.meta
  const ai = new GoogleGenAI({ apiKey: conf.gemini?.api_key })

  const chathistory = compresschathistory(history)

  const chat = ai.chats.create({
    model: agentmodel,
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
          // parts are the source of truth, chunk.functionCalls is just a view over them --------------------
          let text = ''
          const parts = chunk.candidates?.[0]?.content?.parts || []
          for (const part of parts) {
            if (part.functionCall) {
              hasfunctioncalls = true
              functioncalls.push(part.functionCall)
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
        const lowererr = errmsg.toLowerCase()
        const istransient =
          errmsg.includes('503') ||
          errmsg.includes('UNAVAILABLE') ||
          lowererr.includes('overloaded') ||
          lowererr.includes('error in input stream')

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

  if (!response.functionCalls?.length && response.text) {
    const recovered = recovertoolcallsfromtext(response.text)
    if (recovered.length > 0) {
      log.agent('recover', recovered.map((c) => c.name).join(', '), 'text tool syntax')
      response = {
        text: striphallucinatedtoolcalls(response.text),
        functionCalls: recovered,
        recovered: true,
      }
    }
  }

  // tool execution loop --------------------
  while (response.functionCalls && response.functionCalls.length > 0) {
    // gemini 3 wants exactly one response per call even when we stop early --------------------
    if (iterations >= maxtooliterations) {
      log.agent('warn', 'tool budget used up', `${response.functionCalls.length} call(s) skipped`)
      const skipped = response.functionCalls.map(call => buildfunctionresponse(call, {
        error: 'tool budget for this message is used up. do not call more tools, reply to the user with what you have and say what is left to do'
      }))
      response = await sendstreamwithretry(response.recovered ? [{ text: recoveredresultstext(skipped) }] : skipped)
      break
    }
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
        aiusername: aiconf.username || aiconf.id || 'ai',
        config: conf,
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

      functionresponses.push(buildfunctionresponse(call, tooloutput))
    }

    if (onProgress) {
      onProgress('status', { status: 'thinking...' })
    }

    // calls scraped out of plain text never existed in the chat so answer them as text too --------------------
    response = await sendstreamwithretry(response.recovered
      ? [{ text: recoveredresultstext(functionresponses) }]
      : functionresponses)
  }

  let rawtext = response.text || ''

  // if tool loop ended without conversational text ask agent to provide summary reply --------------------
  // never nudge with text while calls are still unanswered, that breaks call and response matching
  if (!rawtext.trim() && toolcallsexecuted.length > 0) {
    if (!response.functionCalls?.length) {
      try {
        const summaryturn = await sendstreamwithretry([{ text: 'all requested actions have completed please provide your final conversational reply to the user summarizing what was done' }])
        rawtext = summaryturn.text || ''
      } catch (e) {
        log.agent('warn', 'failed to generate summary reply', e.message)
      }
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
  cleantext = striphallucinatedtoolcalls(cleantext)
  cleantext = sanitizereplycites(cleantext)

  let updatedhistory = []
  try {
    const rawhistory = await chat.getHistory()
    updatedhistory = compresschathistory(rawhistory)
  } catch { }

  const elapsed = Date.now() - starttime
  log.agent('reply', `${cleantext.length} chars`, `completed in ${elapsed}ms`)

  const toolcallsfolded = toolcallsexecuted.map((call) => ({
    name: call.name,
    args: call.args,
    output: foldtooloutputfordisplay(call.name, call.output),
  }))

  return {
    reply: cleantext,
    thought,
    options: optionslist,
    tool_calls: toolcallsexecuted,
    tool_calls_folded: toolcallsfolded,
    ai_name: ainame,
    model: agentmodel,
    system_prompt: systeminstruction,
    system_prompt_meta: systempromptmeta,
    history: updatedhistory,
  }
}
