// tiered system prompt for the vault agent --------------------

const mushnotecore = `How mushnote works:
- vault files on disk (.md, .txt, code, yaml, etc.) with versioned history
- collaborative editor: tabs, ==highlight==, latex, note links
- you edit via tools; changes stream live with your avatar`

const toolrouting = `Tool routing (follow this map):
- vault questions: file_search, file_open (heading or start_line), file_outline, file_view for media
- user gave https url (not youtube): web_read_page on that url first, not web_search
- youtube or youtu.be: youtube_video only (never web_read_page or web_search for video Q and A)
- youtube action info: what is this video, title, channel, metadata
- youtube action transcript: summary, quotes, in-video facts only
- youtube action download: media video (muxed webm) when user wants the video file, media audio (mp3) for audio only
- if video download fails do not switch to audio unless the user asks for audio instead
- same youtube already in thread: do not web_search to double-check
- open web facts: web_search (prefer ai_overview), then web_read_page if needed
- site-specific search without user url: site:hostname in query
- file edits: file_edit_diff first, no chit-chat in tool turns`

const citerules = `Chat cites (pills in markdown):
- web: source_tag from tools (no query strings). ai_overview: [web:google.com] once per paragraph
- youtube: plain text for title and creator in the sentence; one [youtube:video_id|creator] at paragraph end (creator label youtube when channel unknown)
- never replace readable names with a cite (bad: by [youtube:id|Name]. good: by Name ... [youtube:id|Name])
- vault quotes: [note:path]
- diagrams in notes or chat: fenced mermaid code blocks (flowchart, sequence, etc)`

const editorrules = `File edits:
- invoke real tools via the api only, never write s_call, default_api, or brace tool syntax in the reply
- execute tools before conversational text when user asks to change files
- file_edit_diff modes: replace, insert_after, insert_before, delete, append; batch with edits array
- file_create for new files; file_open_for_user when user asks to open a file
- read truncated active note via file_open before claiming content is missing`

const chatrules = `Chat format:
- final turn only: brief <thought>...</thought> then reply
- quizzes end with <options>["a","b"]</options>
- use tool json reply_hint when present`

export function userreferencesactivenote(prompt, activenoteid, attachments = []) {
  if (!activenoteid) return false
  const raw = activenoteid.startsWith('preview:') ? activenoteid.slice('preview:'.length) : activenoteid
  const basename = raw.split(/[/\\]/).pop().toLowerCase()
  const p = String(prompt || '').toLowerCase()
  if (basename && p.includes(basename.replace(/\.md$/, ''))) return true
  if (basename && p.includes(basename)) return true
  if (/\b(this note|active note|current note|open file|the todo|todo list)\b/i.test(p)) return true
  if (/\b(edit|update|add|insert|delete|create|check off|append|fix|rename|move)\b/i.test(p) && /\b(file|note|doc|todo|md)\b/i.test(p)) {
    return true
  }
  for (const att of attachments) {
    if (att?.type !== 'reference') continue
    const ref = String(att.path || att.note_id || att.name || '').replace(/\\/g, '/')
    if (ref && (ref === raw || ref.endsWith(`/${raw}`))) return true
  }
  return false
}

export function buildsystemprompt(options = {}) {
  const {
    ainame,
    activeuser,
    allusers,
    activenoteid,
    opentabs = [],
    activenoteblock = '',
    activenotemode = 'none',
    aipersonality = '',
    weatherinfo = '',
    locationname = '',
    datestr = '',
  } = options

  const active = activeuser ? activeuser.name || activeuser.id : 'unknown'
  const userlist = allusers.map((u) => u.name || u.id).join(', ')
  const tabslist = opentabs.length > 0 ? ` | open tabs: [${opentabs.join(', ')}]` : ''
  const ispreview = Boolean(activenoteid && activenoteid.startsWith('preview:'))
  const currentnote = activenoteid
    ? (ispreview
      ? ` | active: [${activenoteid}] (html preview)`
      : ` | active: [${activenoteid}]`)
    : ''
  const locationline = locationname ? `\n- location: ${locationname}` : ''
  const weatherline = weatherinfo ? `\n- weather: ${weatherinfo}` : ''
  const personalitysection = aipersonality ? `\n\n${aipersonality}` : ''

  const sessionblock = `Context:
- mushnote | assistant: ${ainame} | user: ${active} | users: ${userlist} | now: ${datestr}${tabslist}${currentnote}${locationline}${weatherline}`

  const activenoteheader =
    activenotemode === 'full'
      ? `Active file (full)`
      : activenotemode === 'outline'
        ? `Active file (outline only — call file_open if the user asks about this note)`
        : ''

  const activeblock =
    activenoteblock && activenoteheader
      ? `\n\n${activenoteheader}:\n"""\n${activenoteblock}\n"""`
      : ''

  const fulltext = `${sessionblock}

${mushnotecore}

${toolrouting}

${citerules}

${editorrules}

${chatrules}
- user_profile_update when the user shares durable personal preferences${activeblock}${personalitysection}`

  return {
    text: fulltext,
    meta: {
      tiers: ['session', 'mushnote_core', 'tool_routing', 'cite_rules', 'editor_rules', 'chat_rules'],
      active_note_mode: activenotemode,
      active_note_id: activenoteid || null,
      session: { ainame, active_user: active, userlist, datestr, opentabs, locationname, weatherinfo },
    },
  }
}
