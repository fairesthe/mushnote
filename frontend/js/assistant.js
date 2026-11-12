import { api } from './api.js'
import { state } from './state.js'
import { loadnotes, navigatefolder } from './files.js'
import { opennote, closenote, saveworkspacestate } from './editor.js'
import { rendertabs, closetab } from './tabs.js'

// dom elements for ai assistant --------------------
const aidrawer = document.getElementById('ai-drawer')
const aiheadername = document.getElementById('ai-header-name')
const aidraweravatar = document.getElementById('ai-drawer-avatar')
const aibtnavatar = document.getElementById('ai-btn-avatar')
const aibtnlabel = document.getElementById('ai-btn-label')
const aimessages = document.getElementById('ai-messages')
const aiform = document.getElementById('ai-form')
const aiinput = document.getElementById('ai-input')
const aicontextmenu = document.getElementById('ai-context-menu')
const ctxitemdetailedview = document.getElementById('ctx-item-detailed-view')
const ctxitemcopychat = document.getElementById('ctx-item-copy-chat')

let aichathistory = []
export const conversationlog = []
let lastsystemprompt = ''

// update ai assistant name and avatar from server --------------------
export async function loadaiinfo() {
  try {
    const data = await api('/api/auth/users')
    if (data.users) {
      for (const u of data.users) {
        const isbot = Boolean(u.bot || u.role === 'ai')
        const color = u.preferences?.['user-color'] || (isbot ? '#10b981' : '#3b82f6')
        state.usercolormap[u.id] = color
        if (u.avatar) {
          state.useravatarmap[u.id] = u.avatar
        }
      }
    }
    const aiuser = data.users.find(u => u.bot || u.role === 'ai')
    if (aiuser) {
      state.ainame = aiuser.name || 'assistant'
      if (aiheadername) aiheadername.textContent = state.ainame
      if (aibtnlabel) aibtnlabel.textContent = state.ainame
      if (aidraweravatar) aidraweravatar.src = aiuser.avatar
      if (aibtnavatar) aibtnavatar.src = aiuser.avatar
      if (aiinput) {
        aiinput.placeholder = `ask ${state.ainame} anything...`
      }
    }
  } catch (err) {
    console.error('failed to load ai user info', err)
  }
}

// format visual tool item label and icon --------------------
export function formattoolmeta(call) {
  const name = call.name
  const args = call.args || {}

  if (name === 'note_outline') {
    const filename = args.note_id || 'note'
    return {
      icon: '📑',
      label: `outline of ${filename}`,
      colorclass: 'tool-badge-view'
    }
  }

  if (name === 'note_open') {
    const filename = args.note_id || 'note'
    const sectioninfo = args.heading ? ` (${args.heading})` : (args.start_line ? ` (lines ${args.start_line}+)` : '')
    return {
      icon: '👁',
      label: `viewed ${filename}${sectioninfo}`,
      colorclass: 'tool-badge-view'
    }
  }

  if (name === 'note_edit_diff') {
    const filename = args.note_id || 'note'
    const count = Array.isArray(args.edits) ? ` (${args.edits.length} edits)` : ''
    return {
      icon: '✏️',
      label: `edited ${filename}${count}`,
      colorclass: 'tool-badge-edit'
    }
  }

  if (name === 'note_create') {
    const filename = args.note_id || args.title || 'note'
    return {
      icon: '📝',
      label: `created ${filename}`,
      colorclass: 'tool-badge-create'
    }
  }

  if (name === 'note_open_for_user') {
    const filename = args.note_id || 'note'
    return {
      icon: '📂',
      label: `opened ${filename}`,
      colorclass: 'tool-badge-view'
    }
  }

  if (name === 'note_search') {
    const query = args.query ? `"${args.query}"` : 'vault'
    return {
      icon: '🔍',
      label: `searched ${query}`,
      colorclass: 'tool-badge-search'
    }
  }

  if (name === 'note_list_recent') {
    return {
      icon: '⏱',
      label: 'checked recent notes',
      colorclass: 'tool-badge-search'
    }
  }

  if (name === 'note_history') {
    const filename = args.note_id || 'note'
    return {
      icon: '📜',
      label: `checked history of ${filename}`,
      colorclass: 'tool-badge-view'
    }
  }

  if (name === 'note_move') {
    const src = args.source || 'item'
    const dest = args.destination || 'destination'
    return {
      icon: '🚚',
      label: `moved ${src} --> ${dest}`,
      colorclass: 'tool-badge-edit'
    }
  }

  if (name === 'note_copy') {
    const src = args.source || 'item'
    const dest = args.destination || 'destination'
    return {
      icon: '📋',
      label: `copied ${src} --> ${dest}`,
      colorclass: 'tool-badge-edit'
    }
  }

  if (name === 'note_delete') {
    const filename = args.note_id || 'note'
    return {
      icon: '🗑️',
      label: `deleted ${filename}`,
      colorclass: 'tool-badge-delete'
    }
  }

  if (name === 'folder_delete') {
    const foldername = args.folder_path || 'folder'
    return {
      icon: '🗑️',
      label: `deleted folder ${foldername}`,
      colorclass: 'tool-badge-delete'
    }
  }

  if (name === 'user_profile_update') {
    return {
      icon: '👤',
      label: `updated user profile for ${args.user_id || 'user'}`,
      colorclass: 'tool-badge-edit'
    }
  }

  return {
    icon: '⚡',
    label: `used ${name}`,
    colorclass: 'tool-badge-generic'
  }
}

// format concise gray status text for non-admin tool execution --------------------
export function formatnonadmintooltext(call) {
  const name = call.name
  const args = call.args || {}

  if (name === 'note_open') {
    const filename = args.note_id || 'note'
    return `reading ${filename}...`
  }
  if (name === 'note_outline') {
    const filename = args.note_id || 'note'
    return `reading outline of ${filename}...`
  }
  if (name === 'note_search') {
    return args.query ? `searching notes for "${args.query}"...` : 'searching notes...'
  }
  if (name === 'note_edit_diff') {
    const filename = args.note_id || 'note'
    return `editing ${filename}...`
  }
  if (name === 'note_create') {
    const filename = args.title || args.note_id || 'note'
    return `creating ${filename}...`
  }
  if (name === 'note_open_for_user') {
    const filename = args.note_id || 'note'
    return `opening ${filename}...`
  }
  if (name === 'note_list_recent') {
    return 'checking recent notes...'
  }
  if (name === 'note_history') {
    const filename = args.note_id || 'note'
    return `reading history of ${filename}...`
  }
  if (name === 'note_move') {
    const src = args.source || 'item'
    return `moving ${src}...`
  }
  if (name === 'note_copy') {
    const src = args.source || 'item'
    return `copying ${src}...`
  }
  if (name === 'note_delete') {
    const filename = args.note_id || 'note'
    return `deleting ${filename}...`
  }
  if (name === 'folder_delete') {
    const foldername = args.folder_path || 'folder'
    return `deleting folder ${foldername}...`
  }

  if (name === 'user_profile_update') {
    return 'updating profile...'
  }
  return `using ${name}...`
}

// create smooth collapsible widget --------------------
export function createcollapsible(options) {
  const { icon, title, content, isinner = false } = options
  const container = document.createElement('div')
  container.className = isinner ? 'tool-item-wrap is-open' : 'ai-details is-open'

  const header = document.createElement('div')
  header.className = isinner ? 'tool-item-summary' : 'ai-summary'
  header.innerHTML = `
    <span class="ai-summary-icon">${icon}</span>
    <span class="ai-summary-label">${title}</span>
    <span class="ai-summary-chevron">▶</span>
  `

  const wrapper = document.createElement('div')
  wrapper.className = 'ai-collapsible-wrapper is-open'

  const inner = document.createElement('div')
  inner.className = 'ai-collapsible-inner'

  const body = document.createElement('div')
  body.className = 'ai-details-body'
  if (typeof content === 'string') {
    body.textContent = content
  } else {
    body.appendChild(content)
  }

  inner.appendChild(body)
  wrapper.appendChild(inner)
  container.appendChild(header)
  container.appendChild(wrapper)

  let isopen = true
  function toggle(targetstate) {
    isopen = targetstate !== undefined ? targetstate : !isopen
    if (isopen) {
      container.classList.add('is-open')
      wrapper.classList.add('is-open')
    } else {
      container.classList.remove('is-open')
      wrapper.classList.remove('is-open')
    }
  }

  header.addEventListener('click', (e) => {
    e.stopPropagation()
    toggle()
  })

  return { element: container, toggle, isopen: () => isopen }
}

// attach copy button under message appearing on hover --------------------
export function appendcopyactions(msgel, texttocopy) {
  const actionswrap = document.createElement('div')
  actionswrap.className = 'msg-actions'

  const copybtn = document.createElement('button')
  copybtn.type = 'button'
  copybtn.className = 'btn-copy-msg'
  copybtn.title = 'copy'
  copybtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`

  copybtn.addEventListener('click', async (e) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(texttocopy)
      copybtn.innerHTML = `<span class="copy-success-text">copied</span>`
      setTimeout(() => {
        copybtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`
      }, 1000)
    } catch (err) {
      console.error('failed to copy text', err)
    }
  })

  actionswrap.appendChild(copybtn)
  msgel.appendChild(actionswrap)
}

// fade and remove non-admin activity status node --------------------
function cleanactivitystatus(node, delay = 800) {
  if (!node) return
  setTimeout(() => {
    node.classList.add('fade-out')
    setTimeout(() => {
      node.remove()
    }, 320)
  }, delay)
}

// send user prompt to ai assistant --------------------
export async function senduserprompt(text) {
  const prompt = text.trim()
  if (!prompt || !aimessages) return

  if (aiinput) aiinput.value = ''

  // record user prompt in conversation log --------------------
  conversationlog.push({
    role: 'user',
    prompt,
    active_note_id: state.activenoteid,
    open_tabs: [...state.opentabs],
    timestamp: new Date().toISOString()
  })

  // render user message with copy button --------------------
  const usermsg = document.createElement('div')
  usermsg.className = 'ai-msg user'
  usermsg.innerHTML = `<div class="msg-bubble">${prompt}</div>`
  appendcopyactions(usermsg, prompt)
  aimessages.appendChild(usermsg)

  const detailed = isdetailedview()

  // render active live status placeholder --------------------
  let statusmsg
  if (detailed) {
    statusmsg = document.createElement('div')
    statusmsg.className = 'ai-msg agent'
    statusmsg.innerHTML = `<div class="msg-bubble">thinking...</div>`
  } else {
    statusmsg = document.createElement('div')
    statusmsg.className = 'ai-activity-status'
    statusmsg.textContent = 'thinking...'
  }
  aimessages.appendChild(statusmsg)
  aimessages.scrollTop = aimessages.scrollHeight

  try {
    const data = await api('/api/agent/chat', {
      method: 'POST',
      body: JSON.stringify({
        message: prompt,
        active_note_id: state.activenoteid,
        open_tabs: state.opentabs,
        history: aichathistory
      })
    })

    if (data.system_prompt) {
      lastsystemprompt = data.system_prompt
    }

    statusmsg.remove()

    const nonadminnodes = []

    // render thought dropdown if detailed view or concise status if simple view --------------------
    if (data.thought && data.thought.trim()) {
      if (detailed) {
        const thoughtwrap = document.createElement('div')
        thoughtwrap.className = 'ai-collapsible'
        const thoughtblock = createcollapsible({
          icon: '💭',
          title: 'thought...',
          content: data.thought.trim()
        })
        thoughtwrap.appendChild(thoughtblock.element)
        aimessages.appendChild(thoughtwrap)

        setTimeout(() => {
          thoughtblock.toggle(false)
        }, 1400)
      } else {
        const thoughtstatus = document.createElement('div')
        thoughtstatus.className = 'ai-activity-status'
        thoughtstatus.textContent = 'thinking...'
        aimessages.appendChild(thoughtstatus)
        nonadminnodes.push(thoughtstatus)
      }
    }

    // render used tools dropdown if detailed view or concise status lines if simple view --------------------
    if (data.tool_calls && data.tool_calls.length > 0) {
      if (detailed) {
        const toolswrap = document.createElement('div')
        toolswrap.className = 'ai-collapsible'

        const count = data.tool_calls.length
        const countlabel = count === 1 ? '1 tool' : `${count} tools`

        const listcontainer = document.createElement('div')
        const subcontrollers = []

        for (const call of data.tool_calls) {
          const meta = formattoolmeta(call)
          const outputstr = typeof call.output === 'object'
            ? JSON.stringify(call.output, null, 2)
            : String(call.output || '(no output)')
          const argsstr = JSON.stringify(call.args || {}, null, 2)

          const contentnode = document.createElement('div')
          contentnode.innerHTML = `
            <div><strong>args:</strong> ${argsstr}</div>
            <div style="margin-top:6px"><strong>output:</strong>\n${outputstr}</div>
          `

          const subtool = createcollapsible({
            icon: `<span class="${meta.colorclass}">${meta.icon}</span>`,
            title: `<span>${meta.label}</span>`,
            content: contentnode,
            isinner: true
          })

          subcontrollers.push(subtool)
          listcontainer.appendChild(subtool.element)
        }

        const maintoolsblock = createcollapsible({
          icon: '🛠',
          title: `used tools (${countlabel})...`,
          content: listcontainer
        })

        toolswrap.appendChild(maintoolsblock.element)
        aimessages.appendChild(toolswrap)

        // auto close individual tools and main tools container with smooth timing --------------------
        for (let i = 0; i < subcontrollers.length; i++) {
          setTimeout(() => {
            subcontrollers[i].toggle(false)
          }, 1200 + i * 200)
        }

        setTimeout(() => {
          maintoolsblock.toggle(false)
        }, 1600 + subcontrollers.length * 200)
      } else {
        // concise gray tool activity lines for non-admin --------------------
        for (const call of data.tool_calls) {
          const toolstatus = document.createElement('div')
          toolstatus.className = 'ai-activity-status'
          toolstatus.textContent = formatnonadmintooltext(call)
          aimessages.appendChild(toolstatus)
          nonadminnodes.push(toolstatus)
        }
      }

      // refresh notes tree in sidebar only so active editor view and animations are not interrupted --------------------
      await loadnotes()

      // if ai generated a new note or opened a note for user open it in a new tab --------------------
      if (data.tool_calls && Array.isArray(data.tool_calls)) {
        for (const call of data.tool_calls) {
          const isnewnote = call.name === 'note_create'
          const isuseropen = call.name === 'note_open_for_user' || (call.name === 'note_open' && call.args?.open_in_tab)
          let targetnoteid = call.args?.note_id
          if (!targetnoteid && call.name === 'note_create') {
            // fallback to parse note id from output --------------------
            const match = String(call.output || '').match(/\[(.*?)\]/)
            if (match) targetnoteid = match[1]
          }
          if ((isnewnote || isuseropen) && targetnoteid) {
            await opennote(targetnoteid, { newtab: true, force: true })
          }

          // close tabs if note was deleted --------------------
          if (call.name === 'note_delete' && call.args?.note_id) {
            closetab(call.args.note_id)
          }

          // close tabs and safely adjust folder view if folder was deleted --------------------
          if (call.name === 'folder_delete' && call.args?.folder_path) {
            const delfolder = call.args.folder_path
            const delprefix = `${delfolder}/`
            const tabsremaining = state.opentabs.filter(t => !t.startsWith(delprefix) && t !== delfolder)
            if (tabsremaining.length !== state.opentabs.length) {
              state.opentabs = tabsremaining
              if (state.activenoteid && (state.activenoteid.startsWith(delprefix) || state.activenoteid === delfolder)) {
                if (tabsremaining.length > 0) {
                  opennote(tabsremaining[0], { force: true, replacecurrent: false, switchfolder: false })
                } else {
                  closenote()
                }
              }
              rendertabs()
              saveworkspacestate()
            }
            if (state.currentfolder === delfolder || state.currentfolder.startsWith(delprefix)) {
              const parentparts = delfolder.split('/').slice(0, -1)
              navigatefolder(parentparts.join('/'))
            }
          }

          // update open tabs if note or folder was moved or renamed --------------------
          if (call.name === 'note_move' && call.args) {
            const src = call.args.source
            const dest = call.args.destination
                    const isfolder = call.args.move_type === 'folder'
                    if (src && dest) {
                      let tabsmodified = false
                      if (isfolder) {
                        const srcprefix = src.endsWith('/') ? src : `${src}/`
                        const destprefix = dest.endsWith('/') ? dest : `${dest}/`
                        state.opentabs = state.opentabs.map(tabid => {
                          if (tabid.startsWith(srcprefix)) {
                            tabsmodified = true
                            return `${destprefix}${tabid.slice(srcprefix.length)}`
                          }
                          return tabid
                        })
                        if (state.activenoteid && state.activenoteid.startsWith(srcprefix)) {
                          state.activenoteid = `${destprefix}${state.activenoteid.slice(srcprefix.length)}`
                        }
                          if (state.currentfolder && (state.currentfolder === src || state.currentfolder.startsWith(srcprefix))) {
                            state.currentfolder = `${destprefix}${state.currentfolder.slice(srcprefix.length)}`.replace(/\/$/, '')
                          }
                        } else {
                          if (state.opentabs.includes(src)) {
                            state.opentabs = state.opentabs.map(t => t === src ? dest : t)
                            tabsmodified = true
                          }
                          if (state.activenoteid === src) {
                            state.activenoteid = dest
                          }
                        }
                        if (tabsmodified) {
                          rendertabs()
                          saveworkspacestate()
                        }
                      }
                    }
                  }
                }
              }

              // render agent response --------------------
              const agentmsg = document.createElement('div')
              agentmsg.className = 'ai-msg agent'
              agentmsg.innerHTML = `<div class="msg-bubble">${data.reply || '(no response)'}</div>`

              // render interactive options chips if present --------------------
              if (data.options && data.options.length > 0) {
                const optionsrow = document.createElement('div')
                optionsrow.className = 'ai-options-row'

                for (const optiontext of data.options) {
                  const btn = document.createElement('button')
                  btn.type = 'button'
                  btn.className = 'ai-option-btn'
                  btn.textContent = optiontext

                  btn.addEventListener('click', (e) => {
                    e.preventDefault()
                    e.stopPropagation()

                    // disable all sibling buttons and highlight clicked --------------------
                    const allbtns = optionsrow.querySelectorAll('.ai-option-btn')
                    allbtns.forEach(b => b.classList.add('disabled'))
                    btn.classList.add('selected')

                    // auto send selected answer --------------------
                    senduserprompt(optiontext)
                  })

                  optionsrow.appendChild(btn)
                }

                agentmsg.appendChild(optionsrow)
              }

              appendcopyactions(agentmsg, data.reply || '')
              aimessages.appendChild(agentmsg)

              // fade and remove non-detailed activity status lines once done --------------------
              if (!detailed && nonadminnodes.length > 0) {
                for (const node of nonadminnodes) {
                  cleanactivitystatus(node, 800)
                }
              }

              // update chat history with full sdk turns or fallback append --------------------
              if (data.history && Array.isArray(data.history)) {
                aichathistory = data.history
              } else {
                const modelturncontent = data.reply + (data.options?.length ? `\n<options>${JSON.stringify(data.options)}</options>` : '')
                aichathistory.push({ role: 'user', content: prompt })
                aichathistory.push({ role: 'model', content: modelturncontent })
              }

              // record assistant response in conversation log --------------------
              conversationlog.push({
                role: 'assistant',
                thought: data.thought?.trim() || null,
                tool_calls: data.tool_calls || [],
                reply: data.reply || '',
                options: data.options || [],
                timestamp: new Date().toISOString()
              })
            } catch (err) {
              statusmsg.remove()
              let displayerr = err.message || 'request failed'
              let issoft = false
              let ishard = false

              // record error in conversation log --------------------
              conversationlog.push({
                role: 'assistant',
                error: displayerr,
                timestamp: new Date().toISOString()
              })

              // parse nested json error payloads --------------------
              try {
                const parsed = JSON.parse(displayerr)
                if (parsed.error?.code === 503 || parsed.error?.status === 'UNAVAILABLE') {
                  displayerr = 'one second...'
                  issoft = true
                } else if (parsed.error?.code === 429 || parsed.error?.status === 'RESOURCE_EXHAUSTED') {
                  const msg = (parsed.error.message || '').toLowerCase()
                  if (msg.includes('quota') || msg.includes('daily') || msg.includes('exceeded')) {
                    displayerr = 'limits reached. try again later!'
                    ishard = true
                  } else {
                    displayerr = 'one second...'
                    issoft = true
                  }
                } else if (parsed.error?.message) {
                  displayerr = parsed.error.message.toLowerCase()
                }
              } catch {
                const lower = displayerr.toLowerCase()
                if (lower.includes('one second')) {
                  issoft = true
                } else if (lower.includes('limits reached')) {
                  ishard = true
                } else if (lower.includes('503') || lower.includes('unavailable') || lower.includes('overloaded')) {
                  displayerr = 'one second...'
                  issoft = true
                } else if (lower.includes('429') || lower.includes('resource_exhausted')) {
                  if (lower.includes('quota') || lower.includes('daily') || lower.includes('exceeded')) {
                    displayerr = 'limits reached. try again later!'
                    ishard = true
                  } else {
                    displayerr = 'one second...'
                    issoft = true
                  }
                }
              }

              const errmsg = document.createElement('div')
              errmsg.className = 'ai-msg agent'
              if (issoft) {
                errmsg.innerHTML = `<div class="msg-bubble" style="color:#777777;border-color:#1c1c1c;background-color:#080808">${displayerr}</div>`
              } else if (ishard) {
                errmsg.innerHTML = `<div class="msg-bubble" style="color:#ffaa00;border-color:#3d2f0a;background-color:#191408">${displayerr}</div>`
              } else {
                errmsg.innerHTML = `<div class="msg-bubble" style="color:#ff6b6b;border-color:#4a1515;background-color:#140505">${displayerr}</div>`
              }
              appendcopyactions(errmsg, displayerr)
              aimessages.appendChild(errmsg)
            }

            aimessages.scrollTop = aimessages.scrollHeight
          }

          // check if detailed view is enabled for current user --------------------
          export function isdetailedview() {
            const userid = state.currentuser?.id || state.currentuser?.user_id
            const isadmin = Boolean(state.currentuser?.admin)
            const key = `mushnote_detailed_view_${userid || 'default'}`
            const stored = localStorage.getItem(key) ?? localStorage.getItem(`gillium_detailed_view_${userid || 'default'}`)
            if (stored === null) {
              return isadmin
            }
            return stored === 'true'
          }

          // set detailed view preference in local storage --------------------
          export function setdetailedview(enabled) {
            const userid = state.currentuser?.id || state.currentuser?.user_id
            const key = `mushnote_detailed_view_${userid || 'default'}`
            localStorage.setItem(key, String(Boolean(enabled)))
          }

          // update ai context menu items state --------------------
          function updatecontextmenuui() {
            const isdetailed = isdetailedview()
            const chk = document.getElementById('chk-detailed-view')
            if (chk) {
              chk.checked = isdetailed
            }
            if (ctxitemcopychat) {
              if (state.currentuser?.admin) {
                ctxitemcopychat.classList.remove('hidden')
              } else {
                ctxitemcopychat.classList.add('hidden')
              }
            }
          }

          // close custom context menu for ai assistant --------------------
          function closeaicontextmenu() {
            if (aicontextmenu) {
              aicontextmenu.classList.add('hidden')
            }
          }

          // initialize assistant chat form and context menu --------------------
          export function initassistant() {
            if (aiinput && state.ainame) {
              aiinput.placeholder = `ask ${state.ainame} anything...`
            }

            if (aiform) {
              aiform.addEventListener('submit', (e) => {
                e.preventDefault()
                const prompt = aiinput?.value?.trim()
                if (prompt) {
                  senduserprompt(prompt)
                }
              })
            }

            // right click to open context menu for assistant --------------------
            if (aidrawer) {
              aidrawer.addEventListener('contextmenu', (e) => {
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
                  return
                }
                e.preventDefault()
                if (!aicontextmenu) return
                updatecontextmenuui()
                aicontextmenu.style.left = `${e.clientX}px`
                aicontextmenu.style.top = `${e.clientY}px`
                aicontextmenu.classList.remove('hidden')
              })
            }

            document.addEventListener('click', closeaicontextmenu)

            // toggle detailed view checkbox --------------------
            if (ctxitemdetailedview) {
              ctxitemdetailedview.addEventListener('click', (e) => {
                e.stopPropagation()
                const nextstate = !isdetailedview()
                setdetailedview(nextstate)
                updatecontextmenuui()
                closeaicontextmenu()
              })
            }

            // copy full conversation with system prompt in json format --------------------
            if (ctxitemcopychat) {
              ctxitemcopychat.addEventListener('click', async () => {
                const payload = {
                  system_prompt: lastsystemprompt || null,
                  conversation: conversationlog
                }
                const json = JSON.stringify(payload, null, 2)
                try {
                  await navigator.clipboard.writeText(json)
                  ctxitemcopychat.innerHTML = '<span style="color:#10b981">copied</span>'
                  setTimeout(() => {
                    ctxitemcopychat.innerHTML = '<img class="btn-icon-img" src="/resources/icons/files/text.png" alt="copy"> copy conversation'
                    closeaicontextmenu()
                  }, 900)
                } catch (err) {
                  console.error('failed to copy conversation to clipboard', err)
                  closeaicontextmenu()
                }
              })
            }
          }

