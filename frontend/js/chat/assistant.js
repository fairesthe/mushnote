import { api, resolveaccent } from '../core/api.js'
import { state } from '../core/state.js'
import { loadnotes, navigatefolder, clearalldraghighlights } from '../sidebar/files.js'
import { opennote, closenote, saveworkspacestate, marksessioncreated, opennotelink, isexternalurl, getdraggeditem, isnoteidmatch } from '../editor/editor.js'
import { getpreviewtargetid, renderpreview } from '../app/preview.js'
import { rendertabs, closetab } from '../sidebar/tabs.js'
import { updatetogglebuttons, ensureaidraweropen } from '../app/layout.js'
import {
  renderchatmarkdown,
  enhancechatcites,
  enhancemermaid,
  formatmermaidforpaste,
} from '../editor/tiptap.bundle.js'

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
const ctxitemcopychat = document.getElementById('ctx-item-copy-chat')
const aibubblecontextmenu = document.getElementById('ai-bubble-context-menu')
const ctxitemmsgcopy = document.getElementById('ctx-item-msg-copy')
const ctxitemmsgreply = document.getElementById('ctx-item-msg-reply')

const msgbubblemeta = new WeakMap()
let bubblecontexttarget = null
const btnaiattach = document.getElementById('btn-ai-attach')
const btnaisend = document.getElementById('btn-ai-send')
const aifileinput = document.getElementById('ai-file-input')
const aiattachmentspreview = document.getElementById('ai-attachments-preview')

let aichathistory = []
let agentchatinflight = false
export const conversationlog = []
let lastsystemprompt = ''
let lastsystempromptmeta = null
let lastagentmodel = ''
let currentattachments = []
const maxfiles = 4
const maxfilesize = 20 * 1024 * 1024

// resize image so max dimension is around 560 for fast uploads and low resolution --------------------
function resizeimage(file, maxdim = 560) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const img = new Image()
      img.onload = () => {
        let width = img.width
        let height = img.height

        if (width > maxdim || height > maxdim) {
          if (width > height) {
            height = Math.round((height * maxdim) / width)
            width = maxdim
          } else {
            width = Math.round((width * maxdim) / height)
            height = maxdim
          }
        }

        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, width, height)

        const dataurl = canvas.toDataURL('image/jpeg', 0.85)
        const base64 = dataurl.split(',')[1]
        resolve({
          name: file.name,
          type: 'image',
          mimeType: 'image/jpeg',
          data: base64,
          previewUrl: dataurl,
          size: Math.round((base64.length * 3) / 4)
        })
      }
      img.onerror = () => reject(new Error('failed to load image'))
      img.src = e.target.result
    }
    reader.onerror = () => reject(new Error('failed to read image file'))
    reader.readAsDataURL(file)
  })
}

// convert audio buffer to mono 16bit wav blob --------------------
function audiobuffertowav(audiobuffer, targetrate = 16000) {
  const numchannels = audiobuffer.numberOfChannels
  const sourcerate = audiobuffer.sampleRate
  const length = Math.floor((audiobuffer.length * targetrate) / sourcerate)
  const result = new Float32Array(length)

  for (let i = 0; i < length; i++) {
    const srcidx = Math.floor((i * sourcerate) / targetrate)
    let sum = 0
    for (let ch = 0; ch < numchannels; ch++) {
      sum += audiobuffer.getChannelData(ch)[srcidx] || 0
    }
    result[i] = sum / numchannels
  }

  const bytespersample = 2
  const blockalign = bytespersample
  const byteperiod = targetrate * blockalign
  const datalen = length * bytespersample
  const buffer = new ArrayBuffer(44 + datalen)
  const view = new DataView(buffer)

  function writestring(offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i))
    }
  }

  writestring(0, 'RIFF')
  view.setUint32(4, 36 + datalen, true)
  writestring(8, 'WAVE')
  writestring(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, targetrate, true)
  view.setUint32(28, byteperiod, true)
  view.setUint16(32, blockalign, true)
  view.setUint16(34, 16, true)
  writestring(36, 'data')
  view.setUint32(40, datalen, true)

  let offset = 44
  for (let i = 0; i < length; i++) {
    const sample = Math.max(-1, Math.min(1, result[i]))
    const intsample = sample < 0 ? sample * 0x8000 : sample * 0x7fff
    view.setInt16(offset, intsample, true)
    offset += 2
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

// read blob as base64 data url --------------------
function blobtodataurl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

// strip video of video track and convert audio to wav --------------------
async function convertvideotoaudio(file) {
  const arraybuffer = await file.arrayBuffer()
  const ctx = new (window.AudioContext || window.webkitAudioContext)()
  try {
    const audiobuffer = await ctx.decodeAudioData(arraybuffer)
    const wavblob = audiobuffertowav(audiobuffer, 16000)
    const dataurl = await blobtodataurl(wavblob)
    const base64 = dataurl.split(',')[1]
    const audioname = file.name.replace(/\.[^/.]+$/, '') + '.wav'
    return {
      name: audioname,
      type: 'audio',
      mimeType: 'audio/wav',
      data: base64,
      previewUrl: dataurl,
      size: wavblob.size
    }
  } finally {
    try { ctx.close() } catch {}
  }
}

// read direct audio or pdf file as base64 --------------------
async function readfileasbase64(file, type, mimeType) {
  const dataurl = await blobtodataurl(file)
  const base64 = dataurl.split(',')[1]
  return {
    name: file.name,
    type,
    mimeType: mimeType || file.type,
    data: base64,
    previewUrl: type === 'audio' ? dataurl : null,
    size: file.size
  }
}

// handle selected files for upload --------------------
async function handlefileupload(filelist) {
  if (!filelist || filelist.length === 0) return

  for (const file of filelist) {
    if (currentattachments.length >= maxfiles) {
      alert(`maximum ${maxfiles} files can be attached at a time`)
      break
    }

    if (file.size > maxfilesize) {
      alert(`file "${file.name}" exceeds maximum allowed size (20mb)`)
      continue
    }

    try {
      if (file.type.startsWith('image/')) {
        const att = await resizeimage(file, 560)
        currentattachments.push(att)
      } else if (file.type.startsWith('video/')) {
        const att = await convertvideotoaudio(file)
        currentattachments.push(att)
      } else if (file.type.startsWith('audio/')) {
        const att = await readfileasbase64(file, 'audio', file.type || 'audio/wav')
        currentattachments.push(att)
      } else if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        const att = await readfileasbase64(file, 'pdf', 'application/pdf')
        currentattachments.push(att)
      } else {
        alert(`unsupported file type for "${file.name}" (pdf, images, sound, and video only)`)
      }
    } catch (err) {
      console.error('failed to process attachment', err)
      alert(`could not process file "${file.name}"`)
    }
  }

  renderattachmentspreview()
  if (aifileinput) aifileinput.value = ''
}

// add vault path or editor selection as a chat reference chip --------------------
export function addreferenceattachment(ref) {
  if (!ref || !ref.refKind) return false
  if (currentattachments.length >= maxfiles) {
    alert(`maximum ${maxfiles} files can be attached at a time`)
    return false
  }

  const duplicate = currentattachments.some((att) => {
    if (att.type !== 'reference' || att.refKind !== ref.refKind) return false
    if (ref.refKind === 'chat') {
      return att.text === ref.text && att.role === ref.role && att.logIndex === ref.logIndex
    }
    if (ref.refKind === 'selection') {
      return att.path === ref.path && att.lineStart === ref.lineStart && att.lineEnd === ref.lineEnd && att.text === ref.text
    }
    return att.path === ref.path
  })
  if (duplicate) return true

  const name = ref.name || ref.path || 'reference'
  currentattachments.push({
    type: 'reference',
    refKind: ref.refKind,
    name,
    path: ref.path || '',
    text: ref.text || '',
    lineStart: ref.lineStart || null,
    lineEnd: ref.lineEnd || null,
    role: ref.role || '',
    logIndex: ref.logIndex != null ? ref.logIndex : null,
    timestamp: ref.timestamp || ''
  })
  renderattachmentspreview()
  return true
}

function referenceiconsvg(refkind) {
  if (refkind === 'chat') {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#8b5cf6" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>'
  }
  if (refkind === 'folder') {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#3b82f6" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>'
  }
  if (refkind === 'selection') {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#f59e0b" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>'
  }
  return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#a3a3a3" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>'
}

function referencebadge(refkind) {
  if (refkind === 'chat') return 'reply'
  if (refkind === 'folder') return 'folder'
  if (refkind === 'selection') return 'text'
  return 'file'
}

function mapattachmentforapi(att) {
  if (att.type === 'reference') {
    return {
      name: att.name,
      type: 'reference',
      refKind: att.refKind,
      path: att.path,
      text: att.text,
      lineStart: att.lineStart,
      lineEnd: att.lineEnd,
      role: att.role,
      logIndex: att.logIndex,
      timestamp: att.timestamp
    }
  }
  return {
    name: att.name,
    type: att.type,
    mimeType: att.mimeType,
    data: att.data
  }
}

function renderreferencepill(att) {
  return `<div class="msg-attachment-pill">${referenceiconsvg(att.refKind)} <span>${att.name}</span></div>`
}

// render attachment preview chips at top of chat input --------------------
function renderattachmentspreview() {
  if (!aiattachmentspreview) return
  aiattachmentspreview.innerHTML = ''

  if (currentattachments.length === 0) {
    aiattachmentspreview.classList.add('hidden')
    return
  }

  aiattachmentspreview.classList.remove('hidden')

  currentattachments.forEach((att, index) => {
    const chip = document.createElement('div')
    chip.className = 'attachment-chip'
    chip.title = att.name

    if (att.type === 'image' && att.previewUrl) {
      const img = document.createElement('img')
      img.src = att.previewUrl
      img.className = 'attachment-thumb'
      img.alt = att.name
      chip.appendChild(img)
    } else {
      const iconbox = document.createElement('div')
      iconbox.className = 'attachment-icon-box'

      const svgicon = document.createElement('div')
      if (att.type === 'reference') {
        svgicon.innerHTML = referenceiconsvg(att.refKind)
      } else if (att.type === 'pdf') {
        svgicon.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#ef4444" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="9" y1="15" x2="15" y2="15"></line></svg>'
      } else {
        svgicon.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#10b981" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>'
      }

      const badge = document.createElement('span')
      badge.className = 'attachment-badge'
      if (att.type === 'reference') {
        badge.textContent = referencebadge(att.refKind)
      } else {
        badge.textContent = att.type === 'pdf' ? 'pdf' : 'sound'
      }

      const name = document.createElement('span')
      name.className = 'attachment-name'
      name.textContent = att.name

      iconbox.appendChild(svgicon)
      iconbox.appendChild(badge)
      iconbox.appendChild(name)
      chip.appendChild(iconbox)
    }

    const removebtn = document.createElement('button')
    removebtn.type = 'button'
    removebtn.className = 'attachment-remove'
    removebtn.textContent = 'x'
    removebtn.title = 'remove'
    removebtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      currentattachments.splice(index, 1)
      renderattachmentspreview()
    })

    chip.appendChild(removebtn)
    aiattachmentspreview.appendChild(chip)
  })
}

// auto resize textarea on input --------------------
function resizeaiinput() {
  if (!aiinput) return
  aiinput.style.height = 'auto'
  aiinput.style.height = `${Math.min(Math.max(aiinput.scrollHeight, 48), 160)}px`
}

// update ai assistant name and avatar from server --------------------
export async function loadaiinfo() {
  try {
    const data = await api('/api/auth/users')
    if (data.users) {
      for (const u of data.users) {
        const isbot = Boolean(u.bot || u.role === 'ai')
        state.usercolormap[u.id] = resolveaccent(u.preferences)
        if (u.avatar) {
          state.useravatarmap[u.id] = u.avatar
        }
      }
    }
    const aiuser = data.users.find(u => u.bot || u.role === 'ai')
    if (aiuser) {
      state.aiuserid = aiuser.id || aiuser.username || 'ai'
      state.ainame = aiuser.name || 'assistant'
      state.aiavatar = aiuser.avatar || null
      if (aiuser.avatar) {
        state.useravatarmap[state.aiuserid] = aiuser.avatar
      }
      if (aiheadername) aiheadername.textContent = state.ainame
      if (aibtnlabel) aibtnlabel.textContent = state.ainame
      if (aidraweravatar) {
        if (aiuser.avatar) aidraweravatar.src = aiuser.avatar
        else aidraweravatar.removeAttribute('src')
      }
      if (aibtnavatar) {
        if (aiuser.avatar) aibtnavatar.src = aiuser.avatar
        else aibtnavatar.removeAttribute('src')
      }
      if (aiinput) {
        aiinput.placeholder = `ask ${state.ainame} anything...`
      }
      const ctxaskai = document.getElementById('ctx-item-ask-ai')
      if (ctxaskai) {
        ctxaskai.innerHTML = `<img class="btn-icon-img" src="/resources/icons/files/text.png" alt="ask"> ask ${state.ainame}`
      }
      updatetogglebuttons()
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

  if (name === 'file_outline') {
    const filename = args.path || args.file_path || args.note_id || 'file'
    return {
      icon: '📑',
      label: `outline of ${filename}`,
      colorclass: 'tool-badge-view'
    }
  }

  if (name === 'file_open') {
    const filename = args.path || args.file_path || args.note_id || 'file'
    const sectioninfo = args.heading ? ` (${args.heading})` : (args.start_line ? ` (lines ${args.start_line}+)` : '')
    return {
      icon: '👁',
      label: `viewed ${filename}${sectioninfo}`,
      colorclass: 'tool-badge-view'
    }
  }

  if (name === 'file_edit_diff') {
    const filename = args.path || args.file_path || args.note_id || 'file'
    const count = Array.isArray(args.edits) ? ` (${args.edits.length} edits)` : ''
    return {
      icon: '✏️',
      label: `edited ${filename}${count}`,
      colorclass: 'tool-badge-edit'
    }
  }

  if (name === 'file_create') {
    const filename = args.path || args.filename || args.title || args.note_id || 'file'
    return {
      icon: '📝',
      label: `created ${filename}`,
      colorclass: 'tool-badge-create'
    }
  }

  if (name === 'file_open_for_user') {
    const filename = args.path || args.file_path || args.note_id || 'file'
    return {
      icon: '📂',
      label: `opened ${filename}`,
      colorclass: 'tool-badge-view'
    }
  }

  if (name === 'file_search') {
    const query = args.query ? `"${args.query}"` : 'vault'
    return {
      icon: '🔍',
      label: `searched ${query}`,
      colorclass: 'tool-badge-search'
    }
  }

  if (name === 'web_search') {
    const query = args.query ? `"${args.query}"` : 'web'
    return {
      icon: '🌐',
      label: `web search ${query}`,
      colorclass: 'tool-badge-search'
    }
  }

  if (name === 'web_read_page') {
    let host = 'page'
    if (args.url) {
      try {
        host = new URL(args.url).hostname
      } catch {
        host = 'page'
      }
    }
    return {
      icon: '📰',
      label: `read ${host}`,
      colorclass: 'tool-badge-search'
    }
  }

  if (name === 'youtube_video') {
    const action = String(args.action || 'info').toLowerCase()
    if (action === 'download') {
      return {
        icon: '⬇️',
        label: 'saved youtube audio',
        colorclass: 'tool-badge-create'
      }
    }
    if (action === 'transcript') {
      return {
        icon: '🎬',
        label: 'youtube transcript',
        colorclass: 'tool-badge-search'
      }
    }
    return {
      icon: '🎬',
      label: 'youtube info',
      colorclass: 'tool-badge-search'
    }
  }

  if (name === 'file_list_recent') {
    return {
      icon: '⏱',
      label: 'checked recent files',
      colorclass: 'tool-badge-search'
    }
  }

  if (name === 'file_history') {
    const filename = args.path || args.file_path || args.note_id || 'file'
    return {
      icon: '📜',
      label: `checked history of ${filename}`,
      colorclass: 'tool-badge-view'
    }
  }

  if (name === 'file_move') {
    const src = args.source || 'item'
    const dest = args.destination || 'destination'
    return {
      icon: '🚚',
      label: `moved ${src} --> ${dest}`,
      colorclass: 'tool-badge-edit'
    }
  }

  if (name === 'file_copy') {
    const src = args.source || 'item'
    const dest = args.destination || 'destination'
    return {
      icon: '📋',
      label: `copied ${src} --> ${dest}`,
      colorclass: 'tool-badge-edit'
    }
  }

  if (name === 'file_delete') {
    const filename = args.path || args.file_path || args.note_id || 'file'
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

  if (name === 'file_create') {
    const filename = args.path || args.filename || args.title || args.note_id
    return filename && filename !== 'file' ? `creating ${filename}...` : 'creating a file...'
  }
  if (name === 'file_open') {
    const filename = args.path || args.file_path || args.note_id
    return filename && filename !== 'file' ? `reading ${filename}...` : 'reading a file...'
  }
  if (name === 'file_outline') {
    const filename = args.path || args.file_path || args.note_id
    return filename && filename !== 'file' ? `reading outline of ${filename}...` : 'checking outline...'
  }
  if (name === 'file_search') {
    return args.query ? `searching files for "${args.query}"...` : 'searching files...'
  }
  if (name === 'web_search') {
    return args.query ? `searching web for "${args.query}"...` : 'searching web...'
  }
  if (name === 'web_read_page') {
    if (args.url) {
      try {
        return `reading ${new URL(args.url).hostname}...`
      } catch {
        return 'reading web page...'
      }
    }
    return 'reading web page...'
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
  if (name === 'file_edit_diff') {
    const filename = args.path || args.file_path || args.note_id
    return filename && filename !== 'file' ? `editing ${filename}...` : 'editing file...'
  }
  if (name === 'file_open_for_user') {
    const filename = args.path || args.file_path || args.note_id
    return filename && filename !== 'file' ? `opening ${filename}...` : 'opening file...'
  }
  if (name === 'file_list_recent') {
    return 'checking recent files...'
  }
  if (name === 'file_history') {
    const filename = args.path || args.file_path || args.note_id
    return filename && filename !== 'file' ? `reading history of ${filename}...` : 'checking file history...'
  }
  if (name === 'file_move') {
    const src = args.source || 'item'
    return `moving ${src}...`
  }
  if (name === 'file_copy') {
    const src = args.source || 'item'
    return `copying ${src}...`
  }
  if (name === 'file_delete') {
    const filename = args.path || args.file_path || args.note_id
    return filename && filename !== 'file' ? `deleting ${filename}...` : 'deleting file...'
  }
  if (name === 'folder_delete') {
    const foldername = args.folder_path || 'folder'
    return `deleting folder ${foldername}...`
  }

  if (name === 'user_profile_update') {
    return 'updating profile...'
  }
  return 'working...'
}

function bubbleplaintext(bubble) {
  if (!bubble) return ''
  return (bubble.innerText || bubble.textContent || '').trim()
}

function quotemessagefrommeta(meta) {
  if (!meta?.text) return false
  const role = meta.role || 'assistant'
  return addreferenceattachment({
    refKind: 'chat',
    name: shortreplylabel(meta.text, role),
    text: meta.text,
    role,
    logIndex: meta.logIndex != null ? meta.logIndex : null,
    timestamp: meta.timestamp || ''
  })
}

function shortreplylabel(text, role, max = 42) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim()
  const who = role === 'user' ? 'you' : 'assistant'
  if (!raw) return `reply to ${who}`
  const clip = raw.length > max ? `${raw.slice(0, max - 1)}…` : raw
  return `reply: ${clip}`
}

export function appendcopyactions(msgel, texttocopy, replyopts = null) {
  const actionswrap = document.createElement('div')
  actionswrap.className = 'msg-actions'

  const copyicon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`
  const replyicon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>`

  const copybtn = document.createElement('button')
  copybtn.type = 'button'
  copybtn.className = 'btn-copy-msg'
  copybtn.title = 'copy'
  copybtn.innerHTML = copyicon

  copybtn.addEventListener('click', async (e) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(texttocopy)
      copybtn.innerHTML = `<span class="copy-success-text">copied</span>`
      setTimeout(() => {
        copybtn.innerHTML = copyicon
      }, 1000)
    } catch (err) {
      console.error('failed to copy text', err)
    }
  })

  actionswrap.appendChild(copybtn)

  if (replyopts && replyopts.text) {
    const replybtn = document.createElement('button')
    replybtn.type = 'button'
    replybtn.className = 'btn-reply-msg'
    replybtn.title = 'reply with reference'
    replybtn.innerHTML = replyicon
    replybtn.addEventListener('click', (e) => {
      e.stopPropagation()
      const ok = quotemessagefrommeta(replyopts)
      if (ok) {
        replybtn.innerHTML = `<span class="copy-success-text">quoted</span>`
        setTimeout(() => {
          replybtn.innerHTML = replyicon
        }, 900)
        if (aiinput) aiinput.focus()
        ensureaidraweropen()
      }
    })
    actionswrap.appendChild(replybtn)
  }

  msgel.appendChild(actionswrap)
  msgbubblemeta.set(msgel, {
    copy: texttocopy,
    reply: replyopts && replyopts.text ? replyopts : null
  })
}

// attach copy button under code blocks and latex math in chat --------------------
export function attachblockcopyactions(bubbleel) {
  if (!bubbleel) return

  // attach copy button under code blocks --------------------
  const preblocks = bubbleel.querySelectorAll('pre')
  preblocks.forEach(pre => {
    if (pre.dataset.hasCopy) return
    pre.dataset.hasCopy = 'true'

    const actions = document.createElement('div')
    actions.className = 'chat-block-actions'

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'btn-copy-code'
    btn.title = 'copy code'
    btn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> <span>copy</span>`

    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const codeel = pre.querySelector('code')
      const code = codeel ? codeel.textContent : pre.textContent
      const lang = codeel?.className?.match(/language-(\S+)/)?.[1]?.toLowerCase()
      let copytext = code
      if (lang === 'mermaid') {
        copytext = formatmermaidforpaste(code) || code
      }
      try {
        await navigator.clipboard.writeText(copytext)
        btn.innerHTML = `<span class="copy-success-text">copied</span>`
        setTimeout(() => {
          btn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> <span>copy</span>`
        }, 1000)
      } catch (err) {
        console.error('failed to copy code', err)
      }
    })

    actions.appendChild(btn)
    pre.insertAdjacentElement('afterend', actions)
  })

  // attach copy button under latex math blocks --------------------
  const mathblocks = bubbleel.querySelectorAll('.katex-block, .katex-display')
  const targetblocks = []
  mathblocks.forEach(mb => {
    if (mb.matches('.katex-display') && mb.closest('.katex-block')) return
    targetblocks.push(mb)
  })

  targetblocks.forEach(mb => {
    if (mb.dataset.hasCopy) return
    mb.dataset.hasCopy = 'true'

    const ann = mb.querySelector('annotation[encoding="application/x-tex"]')
    const latextext = ann ? ann.textContent.trim() : mb.textContent.trim()

    const actions = document.createElement('div')
    actions.className = 'chat-block-actions'

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'btn-copy-code'
    btn.title = 'copy latex'
    btn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> <span>copy latex</span>`

    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      try {
        await navigator.clipboard.writeText(latextext)
        btn.innerHTML = `<span class="copy-success-text">copied</span>`
        setTimeout(() => {
          btn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> <span>copy latex</span>`
        }, 1000)
      } catch (err) {
        console.error('failed to copy latex', err)
      }
    })

    actions.appendChild(btn)
    mb.insertAdjacentElement('afterend', actions)
  })
}

function applychatmarkdownto(el, text) {
  if (!el) return
  el.innerHTML = renderchatmarkdown(text)
  attachblockcopyactions(el)
  enhancemermaid(el).catch(() => {})
  enhancechatcites(el).catch(() => {})
}

function shouldshowactivityspinner(label) {
  const t = String(label || 'thinking...').trim().toLowerCase()
  if (!t || t === 'thinking...' || t === 'thinking' || t === 'reconnecting...') return false
  if (t.startsWith('thinking')) return false
  return true
}

function buildactivitystatusel(label) {
  const row = document.createElement('span')
  row.className = 'ai-activity-status-inner'
  const text = document.createElement('span')
  text.className = 'ai-activity-label'
  text.textContent = label || 'thinking...'
  row.appendChild(text)
  if (shouldshowactivityspinner(label)) {
    const spinner = document.createElement('span')
    spinner.className = 'ai-activity-spinner'
    spinner.setAttribute('aria-hidden', 'true')
    row.appendChild(spinner)
  }
  return row
}

function setagentinputenabled(enabled) {
  const busy = !enabled
  if (aiinput) {
    aiinput.disabled = busy
    aiinput.setAttribute('aria-busy', busy ? 'true' : 'false')
    if (busy) {
      aiinput.placeholder = 'waiting for reply...'
    } else if (state.ainame) {
      aiinput.placeholder = `ask ${state.ainame} anything...`
    }
  }
  if (btnaiattach) btnaiattach.disabled = busy
  if (btnaisend) btnaisend.disabled = busy
  const box = aiinput?.closest('.ai-input-box')
  if (box) box.classList.toggle('is-busy', busy)
  if (!busy && aiinput && !aiinput.disabled) {
    requestAnimationFrame(() => {
      aiinput.focus()
    })
  }
}

function isnetworkretryerror(err) {
  const msg = String(err?.message || err || '').toLowerCase()
  return (
    msg.includes('failed to fetch') ||
    msg.includes('fetch failed') ||
    msg.includes('networkerror') ||
    msg.includes('network request failed') ||
    msg.includes('load failed') ||
    msg.includes('error in input stream')
  )
}

function lasthistoryusertext() {
  const last = aichathistory[aichathistory.length - 1]
  if (!last || last.role !== 'user') return ''
  if (typeof last.content === 'string') return last.content.trim()
  const parts = Array.isArray(last.parts) ? last.parts : []
  return parts.map((p) => p?.text || '').join('').trim()
}

function appenduserprompttohistory(prompttext) {
  const content = typeof prompttext === 'string' ? prompttext.trim() : ''
  if (!content) return
  if (lasthistoryusertext() === content) return
  aichathistory.push({ role: 'user', content })
}

// send user prompt to ai assistant --------------------
export async function senduserprompt(text) {
  const prompt = text ? text.trim() : ''
  const attached = [...currentattachments]

  if (!prompt && attached.length === 0) return
  if (!aimessages) return
  if (agentchatinflight) return

  agentchatinflight = true
  setagentinputenabled(false)

  if (aiinput) {
    aiinput.value = ''
    resizeaiinput()
  }

  currentattachments = []
  renderattachmentspreview()

  // record user prompt in conversation log --------------------
  conversationlog.push({
    role: 'user',
    prompt,
    attachments: attached.map(a => ({ name: a.name, type: a.type, size: a.size })),
    active_note_id: state.activenoteid,
    open_tabs: [...state.opentabs],
    timestamp: new Date().toISOString()
  })

  const isfirstuserturn = conversationlog.filter((e) => e.role === 'user').length === 1
  if (isfirstuserturn) {
    import('./conversations.js')
      .then((m) => m.maybegeneratetitleforactive())
      .catch(() => {})
  }

  // render user message with attachments and copy button --------------------
  const usermsg = document.createElement('div')
  usermsg.className = 'ai-msg user'

  let attachmenthtml = ''
  if (attached.length > 0) {
    attachmenthtml = '<div class="msg-attachments">'
    for (const a of attached) {
      if (a.type === 'reference') {
        attachmenthtml += renderreferencepill(a)
      } else if (a.type === 'image' && a.previewUrl) {
        attachmenthtml += `<img src="${a.previewUrl}" class="msg-attachment-img" alt="${a.name}" title="${a.name}">`
      } else if (a.type === 'audio') {
        attachmenthtml += `<div class="msg-attachment-pill"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#10b981" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg> <span>${a.name}</span></div>`
      } else {
        attachmenthtml += `<div class="msg-attachment-pill"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#ef4444" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg> <span>${a.name}</span></div>`
      }
    }
    attachmenthtml += '</div>'
  }

  if (attachmenthtml) {
    const attwrap = document.createElement('div')
    attwrap.innerHTML = attachmenthtml
    usermsg.appendChild(attwrap.firstElementChild || attwrap)
  }
  if (prompt) {
    const userbubble = document.createElement('div')
    userbubble.className = 'msg-bubble rendered-md'
    applychatmarkdownto(userbubble, prompt)
    usermsg.appendChild(userbubble)
  }
  const userlogindex = conversationlog.length - 1
  const userlogentry = conversationlog[userlogindex]
  const usertextcopy = prompt || (attached.length ? attached.map(a => a.name).join(', ') : '')
  appendcopyactions(usermsg, usertextcopy, prompt ? {
    text: prompt,
    role: 'user',
    logIndex: userlogindex,
    timestamp: userlogentry?.timestamp || ''
  } : null)
  aimessages.appendChild(usermsg)

  // render active live status placeholder --------------------
  let statusmsg = document.createElement('div')
  statusmsg.className = 'ai-activity-status'
  statusmsg.appendChild(buildactivitystatusel('thinking...'))
  aimessages.appendChild(statusmsg)
  aimessages.scrollTop = aimessages.scrollHeight

  function ensurestatusmsg() {
    if (statusmsg && statusmsg.parentNode) return
    statusmsg = document.createElement('div')
    statusmsg.className = 'ai-activity-status'
    statusmsg.appendChild(buildactivitystatusel('thinking...'))
    aimessages.appendChild(statusmsg)
  }

  function updatestatus(statustext) {
    ensurestatusmsg()
    statusmsg.replaceChildren(buildactivitystatusel(statustext))
    aimessages.scrollTop = aimessages.scrollHeight
  }

  function removestatus() {
    if (statusmsg && statusmsg.parentNode) {
      statusmsg.remove()
    }
  }

  try {
    const token = localStorage.getItem('mushnote_token')
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream'
    }
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    const chatbody = JSON.stringify({
      message: prompt,
      attachments: attached.map(mapattachmentforapi),
      active_note_id: state.activenoteid,
      open_tabs: state.opentabs,
      history: aichathistory
    })

    for (let chatattempt = 0; chatattempt < 2; chatattempt++) {
      if (chatattempt > 0) {
        updatestatus('reconnecting...')
        await new Promise((r) => setTimeout(r, 1200))
        ensurestatusmsg()
        updatestatus('thinking...')
      }

      try {
    const response = await fetch('/api/agent/chat', {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: chatbody
    })

    if (!response.ok && !response.headers.get('content-type')?.includes('text/event-stream')) {
      const errdata = await response.json().catch(() => ({}))
      throw new Error(errdata.error || 'request failed')
    }

    let agentmsg = null
    let agentbubble = null
    const toolscollected = []
    let donedata = null
    let liveontoolstatus = false

    // clean all tags and unclosed tags in progress --------------------
    function sanitizestreamtext(str) {
      if (!str) return ''
      return str.replace(/<\/?[a-zA-Z0-9_\-:]+(?:\s+[^>]*)?>/gi, '').replace(/<[a-zA-Z0-9_\-:]*$/i, '')
    }

    let rawreplytext = ''
    let pendingreplytext = ''
    let replydebouncetimer = null

    function renderbufferedreply(fulltext) {
      pendingreplytext = sanitizestreamtext(fulltext)
      if (!replydebouncetimer) {
        replydebouncetimer = setTimeout(() => {
          replydebouncetimer = null
          if (agentbubble && pendingreplytext) {
            agentbubble.classList.add('rendered-md')
            applychatmarkdownto(agentbubble, pendingreplytext)
            aimessages.scrollTop = aimessages.scrollHeight
          }
        }, 75)
      }
    }

    function flushbufferedreply(fulltext) {
      if (replydebouncetimer) {
        clearTimeout(replydebouncetimer)
        replydebouncetimer = null
      }
      const cleantext = sanitizestreamtext(fulltext || pendingreplytext)
      if (agentbubble && cleantext) {
        agentbubble.classList.add('rendered-md')
        applychatmarkdownto(agentbubble, cleantext)
        aimessages.scrollTop = aimessages.scrollHeight
      }
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const parts = buffer.split('\n\n')
      buffer = parts.pop()

      for (const part of parts) {
        if (!part.trim()) continue
        let eventname = 'message'
        let rawdata = ''

        for (const line of part.split('\n')) {
          if (line.startsWith('event: ')) {
            eventname = line.slice(7).trim()
          } else if (line.startsWith('data: ')) {
            rawdata += line.slice(6)
          }
        }

        if (!rawdata) continue
        let parsed
        try {
          parsed = JSON.parse(rawdata)
        } catch {
          continue
        }

        if (eventname === 'status') {
          let statustext = parsed.status || parsed.text || 'thinking...'
          if (statustext.startsWith('running ') || statustext.startsWith('using ')) {
            const toolname = statustext.replace(/^(running|using)\s+/, '').replace(/\.\.\.$/, '')
            statustext = formatnonadmintooltext({ name: toolname, args: {} })
          }
          liveontoolstatus = statustext !== 'thinking...' && !/^thinking\b/i.test(statustext)
          updatestatus(statustext)
        } else if (eventname === 'thought') {
          if (!liveontoolstatus) {
            updatestatus('thinking...')
          }
        } else if (eventname === 'token') {
          removestatus()
          if (!agentmsg) {
            agentmsg = document.createElement('div')
            agentmsg.className = 'ai-msg agent'
            agentbubble = document.createElement('div')
            agentbubble.className = 'msg-bubble rendered-md'
            agentmsg.appendChild(agentbubble)
            aimessages.appendChild(agentmsg)
          }
          rawreplytext = parsed.full || (rawreplytext + (parsed.delta || ''))
          renderbufferedreply(rawreplytext)
        } else if (eventname === 'tool_call') {
          toolscollected.push(parsed)
          if (agentmsg) {
            agentmsg.remove()
            agentmsg = null
            agentbubble = null
          }
          rawreplytext = ''
          pendingreplytext = ''
          liveontoolstatus = false
        } else if (eventname === 'done') {
          donedata = parsed
        } else if (eventname === 'error') {
          throw new Error(parsed.error || 'request failed')
        }
      }
    }

    const data = donedata || {}
    if (data.system_prompt) {
      lastsystemprompt = data.system_prompt
    }
    if (data.system_prompt_meta) {
      lastsystempromptmeta = data.system_prompt_meta
    }
    if (data.model) {
      lastagentmodel = data.model
    }

    removestatus()

    const finaltools = (data.tool_calls && data.tool_calls.length > 0) ? data.tool_calls : toolscollected

    if (finaltools.length > 0) {
      // refresh notes tree in sidebar only so active editor view and animations are not interrupted --------------------
      await loadnotes()

      if (state.activenoteid?.startsWith('preview:')) {
        const previewtarget = getpreviewtargetid(state.activenoteid)
        if (previewtarget) {
          const sourcetouched = finaltools.some((call) => {
            const toolpath = call.args?.path || call.args?.file_path || call.args?.note_id
            if (!toolpath) return false
            if (call.name !== 'file_edit_diff' && call.name !== 'file_create') return false
            return isnoteidmatch(toolpath, previewtarget)
          })
          if (sourcetouched) {
            await renderpreview(previewtarget)
          }
        }
      }

      // if ai generated a new file or opened a file for user open it in a new tab --------------------
      for (const call of finaltools) {
        const isnewfile = call.name === 'file_create'
        const isuseropen = call.name === 'file_open_for_user' || (call.name === 'file_open' && call.args?.open_in_tab)
        let targetfileid = call.args?.path || call.args?.file_path || call.args?.note_id
        if (call.name === 'youtube_video' && String(call.args?.action || '').toLowerCase() === 'download') {
          try {
            const parsed = typeof call.output === 'string' ? JSON.parse(call.output) : call.output
            if (parsed?.path && parsed?.open_in_tab !== false) {
              targetfileid = parsed.path
            }
          } catch {}
        }
        if (!targetfileid && call.name === 'file_create') {
          // fallback to parse file id from output --------------------
          const match = String(call.output || '').match(/\[(.*?)\]/)
          if (match) targetfileid = match[1]
        }
        if (isnewfile && targetfileid) {
          marksessioncreated(targetfileid)
        }
        if ((isnewfile || isuseropen || (call.name === 'youtube_video' && String(call.args?.action || '').toLowerCase() === 'download')) && targetfileid) {
          await loadnotes()
          await opennote(targetfileid, { newtab: true, force: true })
        }

        // close tabs if file was deleted --------------------
        if (call.name === 'file_delete') {
          const delid = call.args?.path || call.args?.file_path || call.args?.note_id
          if (delid) {
            closetab(delid)
            closetab(`preview:${delid}`)
          }
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

        // update open tabs if file or folder was moved or renamed --------------------
        if (call.name === 'file_move' && call.args) {
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

    const finalreply = sanitizestreamtext(data.reply ?? (rawreplytext || (agentbubble ? agentbubble.textContent : '')))
    flushbufferedreply(finalreply)

    if (!agentmsg) {
      agentmsg = document.createElement('div')
      agentmsg.className = 'ai-msg agent'
      agentbubble = document.createElement('div')
      agentbubble.className = 'msg-bubble rendered-md'
      applychatmarkdownto(agentbubble, finalreply || '(no response)')
      agentmsg.appendChild(agentbubble)
      aimessages.appendChild(agentmsg)
    } else if (agentbubble) {
      agentbubble.classList.add('rendered-md')
      applychatmarkdownto(agentbubble, finalreply || '(no response)')
    }

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

    const assistantlogindex = conversationlog.length
    appendcopyactions(agentmsg, finalreply || '', finalreply ? {
      text: finalreply,
      role: 'assistant',
      logIndex: assistantlogindex,
      timestamp: new Date().toISOString()
    } : null)

    // update chat history with full sdk turns or fallback append --------------------
    if (data.history && Array.isArray(data.history)) {
      aichathistory = data.history
    } else {
      const modelturncontent = (finalreply || '') + (data.options?.length ? `\n<options>${JSON.stringify(data.options)}</options>` : '')
      aichathistory.push({ role: 'user', content: prompt })
      aichathistory.push({ role: 'model', content: modelturncontent })
    }

    const debugtools =
      data.tool_calls_folded?.length > 0
        ? data.tool_calls_folded
        : finaltools.map((call) => ({
          name: call.name,
          args: call.args,
          output: call.output,
        }))

    // record assistant response in conversation log (folded tools match gemini history) --------------------
    conversationlog.push({
      role: 'assistant',
      thought: data.thought?.trim() || null,
      tool_calls: debugtools,
      reply: finalreply || '',
      options: data.options || [],
      timestamp: new Date().toISOString()
    })
        break
      } catch (innerErr) {
        if (chatattempt === 0 && isnetworkretryerror(innerErr)) continue
        throw innerErr
      }
    }
  } catch (err) {
    removestatus()
    let displayerr = err.message || 'request failed'
    let issoft = false
    let ishard = false

    appenduserprompttohistory(prompt)

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
      if (lower.includes('networkerror') || lower.includes('failed to fetch')) {
        displayerr = 'connection failed. check that the app server is running and try again'
      } else if (lower.includes('one second')) {
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
      } else if (lower.includes('error in input stream')) {
        displayerr = 'one second...'
        issoft = true
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
  } finally {
    agentchatinflight = false
    setagentinputenabled(true)
    if (aimessages) aimessages.scrollTop = aimessages.scrollHeight
    import('./conversations.js')
      .then((m) => {
        m.schedulesaveactiveconversation()
        m.maybegeneratetitleforactive().catch(() => {})
      })
      .catch(() => {})
  }
}

export function isagentchatbusy() {
  return agentchatinflight
}

export function getconversationpersiststate() {
  return {
    gemini_history: Array.isArray(aichathistory) ? aichathistory : [],
    display_log: conversationlog.map((e) => ({ ...e })),
    model: lastagentmodel || null,
    last_system_prompt_meta: lastsystempromptmeta,
  }
}

export function clearaimessagespane() {
  if (aimessages) aimessages.innerHTML = ''
}

export function replayconversationlogtoui() {
  if (!aimessages) return
  clearaimessagespane()
  for (let i = 0; i < conversationlog.length; i++) {
    const entry = conversationlog[i]
    if (entry.role === 'user') {
      const usermsg = document.createElement('div')
      usermsg.className = 'ai-msg user'
      const attached = entry.attachments || []
      if (attached.length > 0) {
        const attwrap = document.createElement('div')
        attwrap.className = 'msg-attachments'
        for (const a of attached) {
          if (a.type === 'reference') {
            const frag = document.createElement('div')
            frag.innerHTML = renderreferencepill(a)
            if (frag.firstElementChild) attwrap.appendChild(frag.firstElementChild)
          } else {
            const pill = document.createElement('div')
            pill.className = 'msg-attachment-pill'
            pill.textContent = a.name || 'file'
            attwrap.appendChild(pill)
          }
        }
        usermsg.appendChild(attwrap)
      }
      if (entry.prompt) {
        const bubble = document.createElement('div')
        bubble.className = 'msg-bubble rendered-md'
        applychatmarkdownto(bubble, entry.prompt)
        usermsg.appendChild(bubble)
      }
      const copytext = entry.prompt || attached.map((a) => a.name).join(', ')
      appendcopyactions(usermsg, copytext)
      aimessages.appendChild(usermsg)
      continue
    }
    if (entry.role === 'assistant') {
      const agentmsg = document.createElement('div')
      agentmsg.className = 'ai-msg agent'
      const text = entry.error || entry.reply || ''
      if (text) {
        const bubble = document.createElement('div')
        bubble.className = 'msg-bubble rendered-md'
        if (entry.error) {
          bubble.style.color = '#ff6b6b'
        }
        applychatmarkdownto(bubble, text)
        agentmsg.appendChild(bubble)
      }
      appendcopyactions(agentmsg, text)
      aimessages.appendChild(agentmsg)
    }
  }
  aimessages.scrollTop = aimessages.scrollHeight
}

export function applyconversationpersiststate(rec) {
  aichathistory = Array.isArray(rec?.gemini_history) ? [...rec.gemini_history] : []
  conversationlog.length = 0
  if (Array.isArray(rec?.display_log)) {
    for (const entry of rec.display_log) conversationlog.push({ ...entry })
  }
  if (rec?.model) lastagentmodel = rec.model
  if (rec?.last_system_prompt_meta) lastsystempromptmeta = rec.last_system_prompt_meta
  replayconversationlogtoui()
}

// update ai context menu items state --------------------
function updatecontextmenuui() {
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

function closebubblecontextmenu() {
  if (aibubblecontextmenu) {
    aibubblecontextmenu.classList.add('hidden')
  }
  bubblecontexttarget = null
}

function openbubblecontextmenu(x, y, target) {
  if (!aibubblecontextmenu || !target?.text) return
  bubblecontexttarget = target
  closeaicontextmenu()
  aibubblecontextmenu.style.left = `${x}px`
  aibubblecontextmenu.style.top = `${y}px`
  aibubblecontextmenu.classList.remove('hidden')
}

// initialize assistant chat form and context menu --------------------
export function initassistant() {
  if (aiinput && state.ainame) {
    aiinput.placeholder = `ask ${state.ainame} anything...`
  }

  // attach file button trigger --------------------
  if (btnaiattach && aifileinput) {
    btnaiattach.addEventListener('click', () => {
      aifileinput.click()
    })
    aifileinput.addEventListener('change', () => {
      if (aifileinput.files && aifileinput.files.length) {
        handlefileupload(aifileinput.files)
      }
    })
  }

  // multiline input and key handling --------------------
  const aiinputbox = document.querySelector('.ai-input-box')
  if (aiinputbox && aiinput) {
    aiinputbox.addEventListener('click', (e) => {
      if (e.target.closest('#btn-ai-attach') || e.target.closest('#btn-ai-send')) return
      aiinput.focus()
    })
  }

  if (aiinput) {
    aiinput.addEventListener('input', resizeaiinput)
    aiinput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        const prompt = aiinput.value?.trim() || ''
        if (prompt || currentattachments.length > 0) {
          senduserprompt(prompt)
        }
      }
    })

    // paste file support --------------------
    aiinput.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items
      if (!items) return
      const files = []
      for (const item of items) {
        if (item.kind === 'file') {
          const f = item.getAsFile()
          if (f) files.push(f)
        }
      }
      if (files.length > 0) {
        handlefileupload(files)
      }
    })
  }

  // click note links in chat messages --------------------
  if (aimessages) {
    aimessages.addEventListener('click', (e) => {
      const link = e.target.closest('a')
      if (!link) return

      const notetarget = link.dataset.noteLink || link.getAttribute('data-note-link')
      const href = link.getAttribute('href')
      const target = notetarget || href
      if (!target) return

      if (isexternalurl(target)) {
        return
      }

      e.preventDefault()
      e.stopPropagation()
      opennotelink(target, { newtab: false })
    })

    aimessages.addEventListener('contextmenu', (e) => {
      const msgel = e.target.closest('.ai-msg')
      if (msgel) {
        const bubble = msgel.querySelector('.msg-bubble')
        if (bubble && !e.target.closest('.msg-actions')) {
          const stored = msgbubblemeta.get(msgel)
          const text = stored?.copy || bubbleplaintext(bubble)
          if (text) {
            e.preventDefault()
            e.stopPropagation()
            const reply = stored?.reply || {
              text,
              role: msgel.classList.contains('user') ? 'user' : 'assistant',
              logIndex: null,
              timestamp: ''
            }
            openbubblecontextmenu(e.clientX, e.clientY, { text, reply })
            return
          }
        }
      }

      const link = e.target.closest('a')
      if (!link) return

      const notetarget = link.dataset.noteLink || link.getAttribute('data-note-link')
      const href = link.getAttribute('href')
      const target = notetarget || href
      if (!target || isexternalurl(target)) return

      e.preventDefault()
      e.stopPropagation()
      opennotelink(target, { newtab: true })
    })

    aimessages.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return
      const link = e.target.closest('a')
      if (!link) return

      const notetarget = link.dataset.noteLink || link.getAttribute('data-note-link')
      const href = link.getAttribute('href')
      const target = notetarget || href
      if (!target || isexternalurl(target)) return

      e.preventDefault()
      e.stopPropagation()
      opennotelink(target, { newtab: true })
    })
  }

  if (aiform) {
    aiform.addEventListener('submit', (e) => {
      e.preventDefault()
      const prompt = aiinput?.value?.trim() || ''
      if (prompt || currentattachments.length > 0) {
        senduserprompt(prompt)
      }
    })
  }

  function isvaultitemdrag(e) {
    return Boolean(state.activefiledrag || e.dataTransfer?.types?.includes('application/mushnote-item'))
  }

  function handledropontochat(e) {
    const vaultitem = getdraggeditem(e)
    if (vaultitem && (vaultitem.type === 'file' || vaultitem.type === 'folder')) {
      e.preventDefault()
      e.stopPropagation()
      state.activefiledrag = null
      clearalldraghighlights()
      const label = vaultitem.name || vaultitem.title || vaultitem.path?.split('/').pop() || vaultitem.path
      addreferenceattachment({
        refKind: vaultitem.type === 'folder' ? 'folder' : 'file',
        name: label,
        path: vaultitem.path
      })
      ensureaidraweropen()
      return true
    }
    if (e.dataTransfer?.files?.length) {
      e.preventDefault()
      e.stopPropagation()
      handlefileupload(e.dataTransfer.files)
      return true
    }
    return false
  }

  function bindchatdropzone(el) {
    if (!el) return
    el.addEventListener('dragover', (e) => {
      if (!isvaultitemdrag(e) && !e.dataTransfer?.types?.includes('Files')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      el.classList.add('drag-over')
    })
    el.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && el.contains(e.relatedTarget)) return
      el.classList.remove('drag-over')
    })
    el.addEventListener('drop', (e) => {
      el.classList.remove('drag-over')
      handledropontochat(e)
    })
  }

  // drag vault items or files into chat --------------------
  bindchatdropzone(aidrawer)
  bindchatdropzone(aiform)
  if (aiinput) bindchatdropzone(aiinput)

  window.addEventListener('mushnote-add-ai-reference', (e) => {
    if (!e.detail) return
    if (addreferenceattachment(e.detail)) {
      ensureaidraweropen()
    }
  })

  // right click to open context menu for assistant --------------------
  if (aidrawer) {
    aidrawer.addEventListener('contextmenu', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
        return
      }
      if (e.target.closest('.ai-msg')?.querySelector('.msg-bubble')) {
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

  document.addEventListener('click', () => {
    closeaicontextmenu()
    closebubblecontextmenu()
  })

  if (ctxitemmsgcopy) {
    ctxitemmsgcopy.addEventListener('click', async (e) => {
      e.stopPropagation()
      const text = bubblecontexttarget?.text
      if (!text) return
      try {
        await navigator.clipboard.writeText(text)
      } catch (err) {
        console.error('failed to copy message', err)
      }
      closebubblecontextmenu()
    })
  }

  if (ctxitemmsgreply) {
    ctxitemmsgreply.addEventListener('click', (e) => {
      e.stopPropagation()
      const reply = bubblecontexttarget?.reply
      if (reply?.text && quotemessagefrommeta(reply)) {
        ensureaidraweropen()
        if (aiinput) aiinput.focus()
      }
      closebubblecontextmenu()
    })
  }

  // copy full conversation with system prompt in json format --------------------
  if (ctxitemcopychat) {
    ctxitemcopychat.addEventListener('click', async () => {
      const payload = {
        export_version: 2,
        model: lastagentmodel || null,
        system_prompt: lastsystemprompt || null,
        system_prompt_meta: lastsystempromptmeta || null,
        notes: {
          tool_outputs: 'tool_calls outputs are folded like gemini history (youtube transcripts omitted)',
        },
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
