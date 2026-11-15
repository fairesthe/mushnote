import { api } from '../core/api.js'
import { state } from '../core/state.js'
import {
  applyconversationpersiststate,
  getconversationpersiststate,
  isagentchatbusy,
} from './assistant.js'

const aidrawer = document.getElementById('ai-drawer')
const btnconvpicker = document.getElementById('btn-ai-conv-picker')
const convtitleel = document.getElementById('ai-conv-title')
const panelchat = document.getElementById('ai-panel-chat')
const panelconversations = document.getElementById('ai-panel-conversations')
const convlistel = document.getElementById('ai-conversations-list')
const btnnewconv = document.getElementById('btn-ai-new-conversation')

let activeconversationid = null
let activetitle = 'new chat'
let titlegenerated = false
let conversationscache = []
let savetimer = null

function activestoragekey() {
  const uid = state.currentuser?.id || state.currentuser?.user_id || 'default'
  return `mushnote_active_conversation_${uid}`
}

function setconversationsmode(on) {
  if (!aidrawer) return
  aidrawer.classList.toggle('conversations-mode', on)
  if (panelconversations) {
    panelconversations.classList.toggle('hidden', !on)
  }
}

export function setconversationtitle(title) {
  activetitle = String(title || 'new chat').trim() || 'new chat'
  if (convtitleel) convtitleel.textContent = activetitle
}

export function getactiveconversationid() {
  return activeconversationid
}

function formatconvtime(iso) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  } catch {
    return ''
  }
}

function renderconversationslist() {
  if (!convlistel) return
  convlistel.innerHTML = ''
  for (const item of conversationscache) {
    const row = document.createElement('div')
    row.className = 'ai-conv-row'
    if (item.id === activeconversationid) row.classList.add('is-active')

    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'ai-conv-open'
    open.innerHTML = `<span class="ai-conv-open-title">${escapehtml(item.title || 'new chat')}</span><span class="ai-conv-open-meta">${formatconvtime(item.updated_at)}</span>`
    open.addEventListener('click', () => {
      switchconversation(item.id)
    })

    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'ai-conv-delete'
    del.title = 'delete conversation'
    del.textContent = '×'
    del.addEventListener('click', (e) => {
      e.stopPropagation()
      deleteconversationbyid(item.id)
    })

    row.appendChild(open)
    row.appendChild(del)
    convlistel.appendChild(row)
  }
}

function escapehtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export async function saveactiveconversation() {
  if (!activeconversationid) return
  const payload = getconversationpersiststate()
  const data = await api(`/api/conversations/${encodeURIComponent(activeconversationid)}`, {
    method: 'PUT',
    body: JSON.stringify({
      gemini_history: payload.gemini_history,
      display_log: payload.display_log,
      model: payload.model,
      last_system_prompt_meta: payload.last_system_prompt_meta,
    }),
  })
  const idx = conversationscache.findIndex((c) => c.id === activeconversationid)
  if (idx !== -1 && data.conversation) {
    conversationscache[idx] = {
      ...conversationscache[idx],
      title: data.conversation.title,
      updated_at: data.conversation.updated_at,
    }
  }
}

export function schedulesaveactiveconversation() {
  if (savetimer) clearTimeout(savetimer)
  savetimer = setTimeout(() => {
    savetimer = null
    saveactiveconversation().catch((err) => console.error('conversation save failed', err))
  }, 400)
}

export async function maybegeneratetitleforactive() {
  if (!activeconversationid || titlegenerated) return
  const payload = getconversationpersiststate()
  const userentries = payload.display_log.filter((e) => e.role === 'user')
  if (userentries.length < 1) return

  const firstentry = userentries[0]
  let first = String(firstentry?.prompt || '').trim()
  if (!first) {
    const attnames = (firstentry?.attachments || []).map((a) => a?.name).filter(Boolean)
    if (attnames.length) {
      first = attnames.join(', ')
    }
  }
  if (!first) return

  try {
    const data = await api(`/api/conversations/${encodeURIComponent(activeconversationid)}/title`, {
      method: 'POST',
      body: JSON.stringify({ first_message: first }),
    })
    titlegenerated = true
    if (data.conversation?.title) {
      setconversationtitle(data.conversation.title)
      const idx = conversationscache.findIndex((c) => c.id === activeconversationid)
      if (idx !== -1) conversationscache[idx].title = data.conversation.title
      renderconversationslist()
    }
  } catch (err) {
    console.error('title generation failed', err)
  }
}

async function loadconversationbyid(id) {
  const data = await api(`/api/conversations/${encodeURIComponent(id)}`)
  const rec = data.conversation
  activeconversationid = rec.id
  titlegenerated = Boolean(rec.title_generated)
  setconversationtitle(rec.title || 'new chat')
  localStorage.setItem(activestoragekey(), rec.id)
  applyconversationpersiststate(rec)
}

export async function switchconversation(id) {
  if (!id || id === activeconversationid) {
    setconversationsmode(false)
    return
  }
  if (isagentchatbusy()) return

  await saveactiveconversation().catch(() => {})
  await loadconversationbyid(id)
  setconversationsmode(false)
  renderconversationslist()
}

export async function createnewconversation() {
  if (isagentchatbusy()) return
  await saveactiveconversation().catch(() => {})
  const data = await api('/api/conversations', { method: 'POST', body: JSON.stringify({ title: 'new chat' }) })
  const rec = data.conversation
  conversationscache.unshift({
    id: rec.id,
    title: rec.title,
    created_at: rec.created_at,
    updated_at: rec.updated_at,
    message_count: 0,
  })
  activeconversationid = rec.id
  titlegenerated = false
  setconversationtitle(rec.title)
  localStorage.setItem(activestoragekey(), rec.id)
  applyconversationpersiststate({ gemini_history: [], display_log: [] })
  setconversationsmode(false)
  renderconversationslist()
}

async function deleteconversationbyid(id) {
  if (!id) return
  if (isagentchatbusy()) return
  try {
    await api(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' })
  } catch (err) {
    console.error('delete conversation failed', err)
    return
  }
  conversationscache = conversationscache.filter((c) => c.id !== id)
  if (activeconversationid === id) {
    if (conversationscache.length > 0) {
      await loadconversationbyid(conversationscache[0].id)
    } else {
      await createnewconversation()
    }
  }
  renderconversationslist()
}

async function refreshconversationslist() {
  const data = await api('/api/conversations')
  conversationscache = data.conversations || []
  renderconversationslist()
}

export async function initconversationstorage() {
  if (!state.currentuser) return

  try {
    const data = await api('/api/conversations')
    conversationscache = data.conversations || []

    let pickid = localStorage.getItem(activestoragekey())
    if (pickid && !conversationscache.some((c) => c.id === pickid)) {
      pickid = null
    }
    if (!pickid && conversationscache.length > 0) {
      pickid = conversationscache[0].id
    }

    if (!pickid) {
      const created = await api('/api/conversations', { method: 'POST', body: JSON.stringify({ title: 'new chat' }) })
      const rec = created.conversation
      conversationscache = [
        {
          id: rec.id,
          title: rec.title,
          created_at: rec.created_at,
          updated_at: rec.updated_at,
          message_count: 0,
        },
      ]
      pickid = rec.id
    }

    await loadconversationbyid(pickid)
    renderconversationslist()
  } catch (err) {
    console.error('conversation init failed', err)
  }

  if (btnconvpicker) {
    btnconvpicker.addEventListener('click', async () => {
      const open = !aidrawer?.classList.contains('conversations-mode')
      if (open) {
        await refreshconversationslist()
        setconversationsmode(true)
      } else {
        setconversationsmode(false)
      }
    })
  }

  if (btnnewconv) {
    btnnewconv.addEventListener('click', () => {
      createnewconversation().catch((err) => console.error(err))
    })
  }
}