import { api } from './api.js'
import { state } from './state.js'
import { loadnotes, navigatefolder } from './files.js'
import { opennote, closenote, saveworkspacestate, marksessioncreated, opennotelink, isexternalurl } from './editor.js'
import { rendertabs, closetab } from './tabs.js'
import { updatetogglebuttons } from './layout.js'
import { renderchatmarkdown } from './tiptap.bundle.js'

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
const btnaiattach = document.getElementById('btn-ai-attach')
const aifileinput = document.getElementById('ai-file-input')
const aiattachmentspreview = document.getElementById('ai-attachments-preview')

let aichathistory = []
export const conversationlog = []
let lastsystemprompt = ''
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
      if (att.type === 'pdf') {
        svgicon.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#ef4444" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="9" y1="15" x2="15" y2="15"></line></svg>'
      } else {
        svgicon.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#10b981" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>'
      }

      const badge = document.createElement('span')
      badge.className = 'attachment-badge'
      badge.textContent = att.type === 'pdf' ? 'pdf' : 'sound'

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
      state.aiavatar = aiuser.avatar || '/avatars/ai.jpg'
      if (aiheadername) aiheadername.textContent = state.ainame
      if (aibtnlabel) aibtnlabel.textContent = state.ainame
      if (aidraweravatar) aidraweravatar.src = aiuser.avatar
      if (aibtnavatar) aibtnavatar.src = aiuser.avatar
      if (aiinput) {
        aiinput.placeholder = `ask ${state.ainame} anything...`
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

  return {
    element: container,
    toggle,
    isopen: () => isopen,
    setcontent: (newcontent) => {
      if (typeof newcontent === 'string') {
        body.textContent = newcontent
      } else {
        body.innerHTML = ''
        body.appendChild(newcontent)
      }
    }
  }
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
      const code = pre.querySelector('code') ? pre.querySelector('code').textContent : pre.textContent
      try {
        await navigator.clipboard.writeText(code)
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
  const prompt = text ? text.trim() : ''
  const attached = [...currentattachments]

  if (!prompt && attached.length === 0) return
  if (!aimessages) return

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

  // render user message with attachments and copy button --------------------
  const usermsg = document.createElement('div')
  usermsg.className = 'ai-msg user'

  let attachmenthtml = ''
  if (attached.length > 0) {
    attachmenthtml = '<div class="msg-attachments">'
    for (const a of attached) {
      if (a.type === 'image' && a.previewUrl) {
        attachmenthtml += `<img src="${a.previewUrl}" class="msg-attachment-img" alt="${a.name}" title="${a.name}">`
      } else if (a.type === 'audio') {
        attachmenthtml += `<div class="msg-attachment-pill"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#10b981" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg> <span>${a.name}</span></div>`
      } else {
        attachmenthtml += `<div class="msg-attachment-pill"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#ef4444" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg> <span>${a.name}</span></div>`
      }
    }
    attachmenthtml += '</div>'
  }

  const textdisplay = prompt ? `<div class="msg-bubble rendered-md">${renderchatmarkdown(prompt)}</div>` : ''
  usermsg.innerHTML = `${attachmenthtml}${textdisplay}`
  appendcopyactions(usermsg, prompt || (attached.length ? attached.map(a => a.name).join(', ') : ''))
  const userbubble = usermsg.querySelector('.msg-bubble')
  if (userbubble) attachblockcopyactions(userbubble)
  aimessages.appendChild(usermsg)

  const detailed = isdetailedview()

  // render active live status placeholder --------------------
  let statusmsg
  if (detailed) {
    statusmsg = document.createElement('div')
    statusmsg.className = 'ai-msg agent'
    statusmsg.innerHTML = '<div class="msg-bubble">thinking...</div>'
  } else {
    statusmsg = document.createElement('div')
    statusmsg.className = 'ai-activity-status'
    statusmsg.textContent = 'thinking...'
  }
  aimessages.appendChild(statusmsg)
  aimessages.scrollTop = aimessages.scrollHeight

  function updatestatus(statustext) {
    if (!statusmsg || !statusmsg.parentNode) return
    if (detailed) {
      const bubble = statusmsg.querySelector('.msg-bubble')
      if (bubble) bubble.textContent = statustext
    } else {
      statusmsg.textContent = statustext
    }
  }

  function removestatus() {
    if (statusmsg && statusmsg.parentNode) {
      statusmsg.remove()
    }
  }

  try {
    const token = localStorage.getItem('mushnote_token') || localStorage.getItem('gillium_token')
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream'
    }
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    const response = await fetch('/api/agent/chat', {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify({
        message: prompt,
        attachments: attached.map(a => ({
          name: a.name,
          type: a.type,
          mimeType: a.mimeType,
          data: a.data
        })),
        active_note_id: state.activenoteid,
        open_tabs: state.opentabs,
        history: aichathistory
      })
    })

    if (!response.ok && !response.headers.get('content-type')?.includes('text/event-stream')) {
      const errdata = await response.json().catch(() => ({}))
      throw new Error(errdata.error || 'request failed')
    }

    const nonadminnodes = []
    let thoughtwrap = null
    let thoughtblock = null
    let agentmsg = null
    let agentbubble = null
    const toolscollected = []
    let donedata = null

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
            agentbubble.innerHTML = renderchatmarkdown(pendingreplytext)
            attachblockcopyactions(agentbubble)
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
        agentbubble.innerHTML = renderchatmarkdown(cleantext)
        attachblockcopyactions(agentbubble)
        aimessages.scrollTop = aimessages.scrollHeight
      }
    }

    let pendingthoughttext = ''
    let thoughtdebouncetimer = null

    function renderbufferedthought(fullthought) {
      pendingthoughttext = sanitizestreamtext(fullthought)
      if (!thoughtdebouncetimer) {
        thoughtdebouncetimer = setTimeout(() => {
          thoughtdebouncetimer = null
          if (thoughtblock && pendingthoughttext) {
            thoughtblock.setcontent(pendingthoughttext)
            aimessages.scrollTop = aimessages.scrollHeight
          }
        }, 75)
      }
    }

    function flushbufferedthought(fullthought) {
      if (thoughtdebouncetimer) {
        clearTimeout(thoughtdebouncetimer)
        thoughtdebouncetimer = null
      }
      const cleantext = sanitizestreamtext(fullthought || pendingthoughttext)
      if (thoughtblock && cleantext) {
        thoughtblock.setcontent(cleantext)
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
          updatestatus(statustext)
        } else if (eventname === 'thought') {
          if (detailed) {
            removestatus()
            if (!thoughtblock) {
              thoughtwrap = document.createElement('div')
              thoughtwrap.className = 'ai-collapsible'
              thoughtblock = createcollapsible({
                icon: '💭',
                title: 'thought...',
                content: sanitizestreamtext(parsed.full?.trim() || parsed.delta || '')
              })
              thoughtwrap.appendChild(thoughtblock.element)
              aimessages.appendChild(thoughtwrap)
            }
            if (parsed.done) {
              flushbufferedthought(parsed.full?.trim() || '')
              setTimeout(() => {
                thoughtblock.toggle(false)
              }, 1400)
            } else {
              renderbufferedthought(parsed.full?.trim() || '')
            }
          } else {
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
          if (!detailed) {
            const toolstatus = document.createElement('div')
            toolstatus.className = 'ai-activity-status'
            toolstatus.textContent = formatnonadmintooltext(parsed)
            aimessages.appendChild(toolstatus)
            nonadminnodes.push(toolstatus)
          }
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

    removestatus()

    const finaltools = (data.tool_calls && data.tool_calls.length > 0) ? data.tool_calls : toolscollected

    // render used tools dropdown if detailed view or concise status lines if simple view --------------------
    if (finaltools.length > 0) {
      if (detailed) {
        const toolswrap = document.createElement('div')
        toolswrap.className = 'ai-collapsible'

        const count = finaltools.length
        const countlabel = count === 1 ? '1 tool' : `${count} tools`

        const listcontainer = document.createElement('div')
        const subcontrollers = []

        for (const call of finaltools) {
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
        if (agentmsg && agentmsg.parentNode === aimessages) {
          aimessages.insertBefore(toolswrap, agentmsg)
        } else {
          aimessages.appendChild(toolswrap)
        }

        // auto close individual tools and main tools container with smooth timing --------------------
        for (let i = 0; i < subcontrollers.length; i++) {
          setTimeout(() => {
            subcontrollers[i].toggle(false)
          }, 1200 + i * 200)
        }

        setTimeout(() => {
          maintoolsblock.toggle(false)
        }, 1600 + subcontrollers.length * 200)
      }

      // refresh notes tree in sidebar only so active editor view and animations are not interrupted --------------------
      await loadnotes()

      // if ai generated a new file or opened a file for user open it in a new tab --------------------
      for (const call of finaltools) {
        const isnewfile = call.name === 'file_create'
        const isuseropen = call.name === 'file_open_for_user' || (call.name === 'file_open' && call.args?.open_in_tab)
        let targetfileid = call.args?.path || call.args?.file_path || call.args?.note_id
        if (!targetfileid && call.name === 'file_create') {
          // fallback to parse file id from output --------------------
          const match = String(call.output || '').match(/\[(.*?)\]/)
          if (match) targetfileid = match[1]
        }
        if (isnewfile && targetfileid) {
          marksessioncreated(targetfileid)
        }
        if ((isnewfile || isuseropen) && targetfileid) {
          await opennote(targetfileid, { newtab: true, force: true })
        }

        // close tabs if file was deleted --------------------
        if (call.name === 'file_delete') {
          const delid = call.args?.path || call.args?.file_path || call.args?.note_id
          if (delid) closetab(delid)
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

    // flush buffered streams and render agent response --------------------
    flushbufferedthought(data.thought)
    const finalreply = sanitizestreamtext(data.reply ?? (rawreplytext || (agentbubble ? agentbubble.textContent : '')))
    flushbufferedreply(finalreply)

    if (!agentmsg) {
      agentmsg = document.createElement('div')
      agentmsg.className = 'ai-msg agent'
      agentbubble = document.createElement('div')
      agentbubble.className = 'msg-bubble rendered-md'
      agentbubble.innerHTML = renderchatmarkdown(finalreply) || '(no response)'
      attachblockcopyactions(agentbubble)
      agentmsg.appendChild(agentbubble)
      aimessages.appendChild(agentmsg)
    } else if (agentbubble) {
      agentbubble.classList.add('rendered-md')
      agentbubble.innerHTML = renderchatmarkdown(finalreply) || '(no response)'
      attachblockcopyactions(agentbubble)
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

    appendcopyactions(agentmsg, finalreply || '')

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
      const modelturncontent = (finalreply || '') + (data.options?.length ? `\n<options>${JSON.stringify(data.options)}</options>` : '')
      aichathistory.push({ role: 'user', content: prompt })
      aichathistory.push({ role: 'model', content: modelturncontent })
    }

    // record assistant response in conversation log --------------------
    conversationlog.push({
      role: 'assistant',
      thought: data.thought?.trim() || null,
      tool_calls: finaltools,
      reply: finalreply || '',
      options: data.options || [],
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    removestatus()
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

  // drag and drop files into drawer --------------------
  if (aidrawer) {
    aidrawer.addEventListener('dragover', (e) => {
      e.preventDefault()
    })
    aidrawer.addEventListener('drop', (e) => {
      e.preventDefault()
      if (e.dataTransfer?.files?.length) {
        handlefileupload(e.dataTransfer.files)
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
