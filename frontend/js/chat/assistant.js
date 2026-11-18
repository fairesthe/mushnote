import { api, resolveaccent } from '../core/api.js'
import { ismobilemode } from '../core/mobile.js'
import { state } from '../core/state.js'
import { loadnotes, navigatefolder, clearalldraghighlights, getfileicon } from '../workspace/files.js'
import {
  opennote,
  closenote,
  saveworkspacestate,
  marksessioncreated,
  opennotelink,
  isexternalurl,
  getdraggeditems,
  isnoteidmatch
} from '../editor/editor.js'
import { getpreviewtargetid, renderpreview } from '../workspace/preview.js'
import { rendertabs, closetab } from '../workspace/tabs.js'
import { updatetogglebuttons, ensureaidraweropen } from '../workspace/layout.js'
import {
  renderchatmarkdown,
  enhancechatcites,
  enhancemermaid,
  formatmermaidforpaste,
} from '../editor/rich/tiptap.bundle.js'

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
const chatuploadfolder = 'media/chat-uploads'

function sanitizeuploadfilename(name) {
  const cleaned = String(name || 'file').replace(/[^a-zA-Z0-9_\-. ]/g, '').trim()
  return cleaned || 'file'
}

function vaultpreviewurl(vaultpath) {
  if (!vaultpath) return null
  return `/api/raw?id=${encodeURIComponent(vaultpath)}`
}

function isimageattachment(att) {
  if (!att) return false
  if (att.type === 'image' || att.mediaKind === 'image') return true
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(att.path || att.name || '')
}

// resize image so max dimension is around 560 for fast uploads and low resolution --------------------
function resizeimagetodataurl(file, maxdim = 560) {
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
        resolve({
          dataurl,
          mimeType: 'image/jpeg',
          size: Math.round(((dataurl.split(',')[1] || '').length * 3) / 4),
          filename: sanitizeuploadfilename(file.name.replace(/\.[^.]+$/, '') + '.jpg')
        })
      }
      img.onerror = () => reject(new Error('failed to load image'))
      img.src = e.target.result
    }
    reader.onerror = () => reject(new Error('failed to read image file'))
    reader.readAsDataURL(file)
  })
}

// save processed chat attachment into media/chat-uploads --------------------
async function uploadchattovault(dataurl, filename, { label } = {}) {
  const { withuploadui, uploaddataurl, sanitizeuploadname } = await import('../workspace/upload.js')
  const safe = sanitizeuploadname(filename)
  const uploadpath = `${chatuploadfolder}/${Date.now()}-${safe}`
  const res = await withuploadui(label || `uploading ${safe}...`, async ({ signal, setprogress }) => {
    setprogress(12)
    return uploaddataurl(uploadpath, dataurl, {
      signal,
      onprogress: (pct) => setprogress(12 + Math.round(pct * 0.88))
    })
  })
  try { loadnotes() } catch { }
  return res.path || uploadpath
}

function makeuploadattachment({ name, path, mediaKind, mimeType, size, previewUrl }) {
  return {
    type: 'reference',
    refKind: 'upload',
    name: name || path.split('/').pop() || 'upload',
    path,
    mediaKind: mediaKind || '',
    mimeType: mimeType || '',
    size: size || null,
    previewUrl: previewUrl || (mediaKind === 'image' ? vaultpreviewurl(path) : null)
  }
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
    const audioname = sanitizeuploadfilename(file.name.replace(/\.[^/.]+$/, '') + '.wav')
    return {
      name: audioname,
      mediaKind: 'audio',
      mimeType: 'audio/wav',
      dataurl,
      size: wavblob.size
    }
  } finally {
    try { ctx.close() } catch { }
  }
}

// read direct audio or pdf file as data url for vault upload --------------------
async function readfileforupload(file, mediaKind, mimeType) {
  const dataurl = await blobtodataurl(file)
  return {
    name: sanitizeuploadfilename(file.name),
    mediaKind,
    mimeType: mimeType || file.type,
    dataurl,
    size: file.size
  }
}

function isarchivefilename(name) {
  return /\.(zip|jar|7z|rar)$/i.test(String(name || ''))
}

function isarchivefile(file) {
  if (!file) return false
  if (isarchivefilename(file.name)) return true
  const mime = String(file.type || '').toLowerCase()
  return (
    mime === 'application/zip' ||
    mime === 'application/x-zip-compressed' ||
    mime === 'application/java-archive' ||
    mime === 'application/x-7z-compressed' ||
    mime === 'application/vnd.rar' ||
    mime === 'application/x-rar-compressed'
  )
}

function archivemimeforfile(file) {
  const name = String(file?.name || '').toLowerCase()
  if (name.endsWith('.jar')) return 'application/java-archive'
  if (name.endsWith('.7z')) return 'application/x-7z-compressed'
  if (name.endsWith('.rar')) return 'application/vnd.rar'
  return file?.type || 'application/zip'
}

// handle selected files for upload --------------------
export async function handlefileupload(filelist) {
  // clone in case this came from a live dataTransfer FileList --------------------
  const files = Array.from(filelist || [])
  if (!files.length) return

  for (const file of files) {
    if (currentattachments.length >= maxfiles) {
      alert(`maximum ${maxfiles} files can be attached at a time`)
      break
    }

    if (file.size > maxfilesize) {
      alert(`file "${file.name}" exceeds maximum allowed size (20mb)`)
      continue
    }

    try {
      let prepared = null
      if (file.type.startsWith('image/')) {
        const resized = await resizeimagetodataurl(file, 560)
        prepared = {
          name: resized.filename,
          mediaKind: 'image',
          mimeType: resized.mimeType,
          dataurl: resized.dataurl,
          size: resized.size
        }
      } else if (file.type.startsWith('video/')) {
        prepared = await convertvideotoaudio(file)
      } else if (file.type.startsWith('audio/')) {
        prepared = await readfileforupload(file, 'audio', file.type || 'audio/wav')
      } else if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        prepared = await readfileforupload(file, 'pdf', 'application/pdf')
      } else if (isarchivefile(file)) {
        prepared = await readfileforupload(file, 'archive', archivemimeforfile(file))
      } else {
        alert(`unsupported file type for "${file.name}" (pdf, images, sound, video, and zip/7z/rar only)`)
        continue
      }

      const vaultpath = await uploadchattovault(prepared.dataurl, prepared.name, {
        label: `uploading ${prepared.name}...`
      })
      currentattachments.push(makeuploadattachment({
        name: prepared.name,
        path: vaultpath,
        mediaKind: prepared.mediaKind,
        mimeType: prepared.mimeType,
        size: prepared.size,
        previewUrl: prepared.mediaKind === 'image' ? vaultpreviewurl(vaultpath) : null
      }))
    } catch (err) {
      if (err?.name === 'AbortError') break
      console.error('failed to process attachment', err)
      alert(`could not process file "${file.name}"`)
    }
  }

  renderattachmentspreview()
  scheduledraftsave()
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
  scheduledraftsave()
  return true
}

function scheduledraftsave() {
  import('./conversations.js')
    .then((m) => m.schedulesaveactiveconversation())
    .catch(() => { })
}

function clonedraftattachments(list) {
  return (Array.isArray(list) ? list : []).map((att) => {
    if (!att || typeof att !== 'object') return null
    if (att.type === 'reference') {
      return {
        type: 'reference',
        refKind: att.refKind,
        name: att.name || '',
        path: att.path || '',
        text: att.text || '',
        lineStart: att.lineStart || null,
        lineEnd: att.lineEnd || null,
        role: att.role || '',
        logIndex: att.logIndex != null ? att.logIndex : null,
        timestamp: att.timestamp || '',
        mediaKind: att.mediaKind || '',
        mimeType: att.mimeType || '',
        previewUrl: att.previewUrl || (att.refKind === 'upload' && att.path && isimageattachment(att)
          ? vaultpreviewurl(att.path)
          : null),
        size: att.size || null,
      }
    }
    // legacy base64 drafts still clone but prefer path uploads going forward --------------------
    return {
      name: att.name || '',
      type: att.type || 'file',
      mimeType: att.mimeType || '',
      data: att.data || '',
      previewUrl: att.previewUrl || null,
      size: att.size || null,
    }
  }).filter(Boolean)
}

function referencebadge(refkind) {
  if (refkind === 'chat') return 'reply'
  if (refkind === 'folder') return 'folder'
  if (refkind === 'selection') return 'selection'
  if (refkind === 'upload') return 'upload'
  return 'note'
}

function attachmenticonpath(att) {
  if (!att) return '/resources/icons/files/common.png'
  if (att.mediaKind === 'image' || att.type === 'image') return '/resources/icons/files/image.png'
  if (att.mediaKind === 'audio' || att.type === 'audio') return '/resources/icons/files/audio.png'
  if (att.mediaKind === 'pdf' || att.type === 'pdf') return '/resources/icons/files/pdf.png'
  if (att.mediaKind === 'archive' || isarchivefilename(att.path || att.name || '')) {
    return '/resources/icons/files/archive.png'
  }
  if (att.type === 'reference') {
    if (att.refKind === 'folder') return '/resources/icons/files/folder.png'
    if (att.refKind === 'upload') return getfileicon(att.path || att.name || '')
    return '/resources/icons/general/reference.png'
  }
  return getfileicon(att.name || '')
}

function attachmenttypelabel(att) {
  if (!att) return 'file'
  if (att.mediaKind) return att.mediaKind
  if (att.type === 'reference') return referencebadge(att.refKind)
  if (att.type === 'image') return 'image'
  if (att.type === 'audio') return 'audio'
  if (att.type === 'pdf') return 'pdf'
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
      timestamp: att.timestamp,
      mediaKind: att.mediaKind || '',
      mimeType: att.mimeType || ''
    }
  }
  // legacy inline base64 still supported --------------------
  return {
    name: att.name,
    type: att.type,
    mimeType: att.mimeType,
    data: att.data
  }
}

function mapattachmentforlog(att) {
  if (att.type === 'reference') {
    return {
      name: att.name,
      type: 'reference',
      refKind: att.refKind,
      path: att.path,
      mediaKind: att.mediaKind || '',
      previewUrl: att.previewUrl || (isimageattachment(att) && att.path ? vaultpreviewurl(att.path) : null),
      size: att.size || null,
      text: att.refKind === 'chat' || att.refKind === 'selection' ? att.text : undefined,
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
    size: att.size,
    previewUrl: att.previewUrl || null
  }
}

function renderattachmentpill(att) {
  const icon = attachmenticonpath(att)
  const label = escapehtml(att.name || 'file')
  return `<div class="msg-attachment-pill"><img class="attachment-pill-icon" src="${icon}" alt=""> <span>${label}</span></div>`
}

function escapehtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
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
    const thumburl = att.previewUrl || (isimageattachment(att) && att.path ? vaultpreviewurl(att.path) : null)
    if (isimageattachment(att) && thumburl) chip.classList.add('has-thumb')
    chip.title = att.path ? `${att.name} (${att.path})` : att.name

    if (isimageattachment(att) && thumburl) {
      const img = document.createElement('img')
      img.src = thumburl
      img.className = 'attachment-thumb'
      img.alt = att.name
      chip.appendChild(img)
    } else {
      const icon = document.createElement('img')
      icon.className = 'attachment-type-icon'
      icon.src = attachmenticonpath(att)
      icon.alt = ''

      const meta = document.createElement('div')
      meta.className = 'attachment-meta'

      const badge = document.createElement('span')
      badge.className = 'attachment-badge'
      badge.textContent = attachmenttypelabel(att)

      const name = document.createElement('span')
      name.className = 'attachment-name'
      name.textContent = att.name

      meta.append(badge, name)
      chip.append(icon, meta)
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
      scheduledraftsave()
    })

    chip.appendChild(removebtn)
    aiattachmentspreview.appendChild(chip)
  })
}

// auto resize textarea on input --------------------
export function resizeaiinput() {
  if (!aiinput) return
  const ismobile = ismobilemode()
  if (ismobile) {
    if (!aiinput.value) {
      aiinput.style.height = '20px'
      aiinput.style.overflowY = 'hidden'
      return
    }
    aiinput.style.height = '0px'
    const next = Math.min(Math.max(aiinput.scrollHeight, 20), 40)
    aiinput.style.height = `${next}px`
    aiinput.style.overflowY = next >= 40 ? 'auto' : 'hidden'
    return
  }

  const maxh = 140
  const line = parseFloat(getComputedStyle(aiinput).lineHeight)
  const minh = Number.isFinite(line) && line > 0 ? Math.ceil(line) : 20
  // empty field: never trust scrollHeight (often huge before first layout) --------------------
  if (!aiinput.value) {
    aiinput.style.height = `${minh}px`
    return
  }
  aiinput.style.height = '0px'
  const next = Math.min(Math.max(aiinput.scrollHeight, minh), maxh)
  aiinput.style.height = `${next}px`
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
        ctxaskai.innerHTML = `<img class="btn-icon-img" src="/resources/icons/general/ask.png" alt="ask"> ask ${state.ainame}`
      }
      updatetogglebuttons()
    }
  } catch (err) {
    console.error('failed to load ai user info', err)
  }
}

const tooliconfallback = '/resources/icons/general/tool.png'
const tooliconmap = {
  file_search: '/resources/icons/tools/tool-file-search.png',
  web_search: '/resources/icons/tools/tool-web-search.png',
  web_read_page: '/resources/icons/tools/tool-web-read-page.png',
  youtube_video: '/resources/icons/tools/tool-youtube-video.png',
  textfile_read: '/resources/icons/tools/tool-textfile-read.png',
  file_analyze: '/resources/icons/tools/tool-file-analyze.png',
  file_open_for_user: '/resources/icons/tools/tool-file-open-for-user.png',
  textfile_create: '/resources/icons/tools/tool-textfile-create.png',
  file_move: '/resources/icons/tools/tool-file-move.png',
  file_copy: '/resources/icons/tools/tool-file-copy.png',
  file_delete: '/resources/icons/tools/tool-file-delete.png',
  archive_extract: '/resources/icons/tools/tool-archive-extract.png',
  download: '/resources/icons/tools/tool-download.png',
  api_request: '/resources/icons/tools/tool-api-request.png',
  eval_js: '/resources/icons/tools/tool-eval-js.png',
  notify: '/resources/icons/tools/tool-notify.png',
  textfile_edit_diff: '/resources/icons/tools/tool-textfile-edit-diff.png',
  textfile_history: '/resources/icons/tools/tool-textfile-history.png'
}

export function gettoolicon(name) {
  return tooliconmap[name] || tooliconfallback
}

// warm tool icons into the browser cache so status badges never flash blank --------------------
function preloadtoolicons() {
  const urls = new Set([
    tooliconfallback,
    '/resources/icons/general/thought.png',
    ...Object.values(tooliconmap)
  ])
  for (const src of urls) {
    const img = new Image()
    img.decoding = 'async'
    img.src = src
  }
}
preloadtoolicons()

// format visual tool item label and icon --------------------
export function formattoolmeta(call) {
  const name = call.name
  const args = call.args || {}
  const icon = gettoolicon(name)

  if (name === 'textfile_read') {
    const filename = args.path || args.file_path || args.note_id || 'file'
    if (String(args.mode || '').toLowerCase() === 'outline') {
      return { icon, label: `outline of ${filename}`, colorclass: 'tool-badge-view' }
    }
    const sectioninfo = args.heading ? ` (${args.heading})` : (args.start_line ? ` (lines ${args.start_line}+)` : '')
    return { icon, label: `read ${filename}${sectioninfo}`, colorclass: 'tool-badge-view' }
  }

  if (name === 'file_analyze') {
    const filename = args.path || args.file_path || args.note_id || 'file'
    if (String(args.mode || '').toLowerCase() === 'metadata') {
      return { icon, label: `metadata ${filename}`, colorclass: 'tool-badge-view' }
    }
    return { icon, label: `analyzed ${filename}`, colorclass: 'tool-badge-view' }
  }

  if (name === 'textfile_edit_diff') {
    const filename = args.path || args.file_path || args.note_id || 'file'
    const count = Array.isArray(args.edits) ? ` (${args.edits.length} edits)` : ''
    return { icon, label: `edited ${filename}${count}`, colorclass: 'tool-badge-edit' }
  }

  if (name === 'textfile_create') {
    const filename = args.path || args.filename || args.title || args.note_id || 'file'
    return { icon, label: `created ${filename}`, colorclass: 'tool-badge-create' }
  }

  if (name === 'file_open_for_user') {
    const filename = args.path || args.file_path || args.note_id || 'file'
    return { icon, label: `opened ${filename}`, colorclass: 'tool-badge-view' }
  }

  if (name === 'file_search') {
    const recent = args.recent === true || args.recent === 'true' || args.recent === 1 || args.recent === '1'
    if (recent) return { icon, label: 'checked recent files', colorclass: 'tool-badge-search' }
    const query = args.query ? `"${args.query}"` : 'vault'
    return { icon, label: `searched ${query}`, colorclass: 'tool-badge-search' }
  }

  if (name === 'web_search') {
    const query = args.query ? `"${args.query}"` : ''
    const news = args.news === true || args.news === 'true' || args.news === 1 || args.news === '1'
    return {
      icon,
      label: news
        ? (query ? `searched news for ${query}` : 'searched news')
        : (query ? `searched web for ${query}` : 'searched web'),
      colorclass: 'tool-badge-search'
    }
  }

  if (name === 'web_read_page') {
    const target = String(args.url || '').trim() || 'page'
    return { icon, label: `read ${target}`, colorclass: 'tool-badge-search' }
  }

  if (name === 'youtube_video') {
    const action = String(args.action || 'info').toLowerCase()
    if (action === 'download') {
      const media = String(args.media || 'audio').toLowerCase()
      return {
        icon,
        label: media === 'video' ? 'downloaded youtube video' : 'downloaded youtube audio',
        colorclass: 'tool-badge-create'
      }
    }
    if (action === 'transcript') {
      const detail = String(args.detail || 'regular').toLowerCase() === 'full' ? 'full' : 'regular'
      return {
        icon,
        label: detail === 'full' ? 'fetched youtube transcript (full)' : 'fetched youtube transcript',
        colorclass: 'tool-badge-search'
      }
    }
    return { icon, label: 'checked youtube info', colorclass: 'tool-badge-search' }
  }

  if (name === 'textfile_history') {
    const filename = args.path || args.file_path || args.note_id || 'file'
    return { icon, label: `checked history of ${filename}`, colorclass: 'tool-badge-view' }
  }

  if (name === 'file_move') {
    const src = args.source || 'item'
    const dest = args.destination || 'destination'
    return { icon, label: `moved ${src} --> ${dest}`, colorclass: 'tool-badge-edit' }
  }

  if (name === 'file_copy') {
    const src = args.source || 'item'
    const dest = args.destination || 'destination'
    return { icon, label: `copied ${src} --> ${dest}`, colorclass: 'tool-badge-edit' }
  }

  if (name === 'file_delete') {
    const filename = args.path || args.file_path || args.note_id || 'item'
    const isfolder = args.delete_type === 'folder'
    return { icon, label: isfolder ? `deleted folder ${filename}` : `deleted ${filename}`, colorclass: 'tool-badge-delete' }
  }

  if (name === 'archive_extract') {
    const filename = (args.path || args.file_path || 'archive').split('/').pop()
    const dest = args.destination ? ` --> ${String(args.destination).split('/').pop()}` : ''
    return { icon, label: `extracted ${filename}${dest}`, colorclass: 'tool-badge-create' }
  }

  if (name === 'download') {
    const dest = args.destination || args.path || ''
    const short = dest ? String(dest).split('/').pop() : ''
    const kind = String(args.kind || args.mode || '').toLowerCase()
    if (kind === 'git' || kind === 'clone' || /github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|\.git(\b|$)/i.test(String(args.url || ''))) {
      return { icon, label: short ? `cloned ${short}` : 'cloned repo', colorclass: 'tool-badge-create' }
    }
    return { icon, label: short ? `downloaded ${short}` : 'downloaded file', colorclass: 'tool-badge-create' }
  }

  if (name === 'api_request') {
    const method = String(args.method || 'GET').toUpperCase()
    const target = String(args.url || '').trim()
    const status = args.status != null ? ` ${args.status}` : ''
    return {
      icon,
      label: target ? `${method}${status} ${target}` : `${method} request`,
      colorclass: 'tool-badge-search'
    }
  }

  if (name === 'eval_js') {
    const code = String(args.code || '').replace(/\s+/g, ' ').trim()
    const snippet = code.length > 28 ? `${code.slice(0, 28)}...` : (code || 'code')
    return {
      icon,
      label: `evaluated \`${snippet}\``,
      colorclass: 'tool-badge-view'
    }
  }

  if (name === 'notify') {
    const userlabel = args.user ? ` ${args.user}` : ''
    const title = args.title ? `: ${args.title}` : ''
    return {
      icon,
      label: `notified${userlabel}${title}`,
      colorclass: 'tool-badge-notify'
    }
  }

  return { icon, label: `used ${name}`, colorclass: 'tool-badge-generic' }
}

// format concise status text for tool execution --------------------
export function formattoolstatustext(call) {
  const name = call.name
  const args = call.args || {}

  if (name === 'textfile_create') {
    const filename = args.path || args.filename || args.title || args.note_id
    return filename && filename !== 'file' ? `creating ${filename}...` : 'creating a file...'
  }
  if (name === 'textfile_read') {
    const filename = args.path || args.file_path || args.note_id
    if (String(args.mode || '').toLowerCase() === 'outline') {
      return filename && filename !== 'file' ? `reading outline of ${filename}...` : 'checking outline...'
    }
    return filename && filename !== 'file' ? `reading ${filename}...` : 'reading a file...'
  }
  if (name === 'file_analyze') {
    const filename = args.path || args.file_path || args.note_id
    if (String(args.mode || '').toLowerCase() === 'metadata') {
      return filename && filename !== 'file' ? `checking ${filename}...` : 'checking file...'
    }
    return filename && filename !== 'file' ? `analyzing ${filename}...` : 'analyzing file...'
  }
  if (name === 'file_search') {
    const recent = args.recent === true || args.recent === 'true' || args.recent === 1 || args.recent === '1'
    if (recent) return 'checking recent files...'
    return args.query ? `searching files for "${args.query}"...` : 'searching files...'
  }
  if (name === 'web_search') {
    const news = args.news === true || args.news === 'true' || args.news === 1 || args.news === '1'
    if (news) return args.query ? `searching news for "${args.query}"...` : 'searching news...'
    return args.query ? `searching web for "${args.query}"...` : 'searching web...'
  }
  if (name === 'web_read_page') {
    const target = String(args.url || '').trim()
    return target ? `reading ${target}...` : 'reading web page...'
  }
  if (name === 'youtube_video') {
    const action = String(args.action || 'info').toLowerCase()
    if (action === 'transcript') {
      const detail = String(args.detail || 'regular').toLowerCase() === 'full' ? 'full' : 'regular'
      return detail === 'full' ? 'fetching full youtube transcript...' : 'fetching youtube transcript...'
    }
    if (action === 'download') {
      const media = String(args.media || 'audio').toLowerCase()
      return media === 'video' ? 'downloading youtube video...' : 'downloading youtube audio...'
    }
    return 'reading youtube details...'
  }
  if (name === 'textfile_edit_diff') {
    const filename = args.path || args.file_path || args.note_id
    return filename && filename !== 'file' ? `editing ${filename}...` : 'editing file...'
  }
  if (name === 'file_open_for_user') {
    const filename = args.path || args.file_path || args.note_id
    return filename && filename !== 'file' ? `opening ${filename}...` : 'opening file...'
  }
  if (name === 'textfile_history') {
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
    return filename && filename !== 'file' ? `deleting ${filename}...` : 'deleting...'
  }
  if (name === 'archive_extract') {
    const filename = args.path || args.file_path || 'archive'
    return `extracting ${filename}...`
  }
  if (name === 'download') {
    const mode = String(args.mode || 'auto').toLowerCase()
    const dest = args.destination || args.path || ''
    if (mode === 'git' || mode === 'clone' || /github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|\.git(\b|$)/i.test(String(args.url || ''))) {
      return dest ? `cloning into ${dest}...` : 'cloning repo...'
    }
    return dest ? `downloading to ${dest}...` : 'downloading file...'
  }
  if (name === 'api_request') {
    const method = String(args.method || 'GET').toUpperCase()
    const target = String(args.url || '').trim()
    return target ? `${method} ${target}...` : `${method} request...`
  }
  if (name === 'eval_js') {
    return 'calculating...'
  }
  if (name === 'notify') {
    return args.user ? `sending notification to ${args.user}...` : 'sending notification...'
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

// quiz or choice chips under an assistant bubble --------------------
function buildoptionsrow(options, selectedanswer = null) {
  const list = (options || []).map((o) => String(o).trim()).filter(Boolean)
  if (!list.length) return null

  const optionsrow = document.createElement('div')
  optionsrow.className = 'ai-options-row'
  const answered = selectedanswer != null && list.some((o) => o === selectedanswer)

  for (const optiontext of list) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'ai-option-btn'
    btn.textContent = optiontext

    if (answered) {
      btn.classList.add('disabled')
      if (optiontext === selectedanswer) btn.classList.add('selected')
    } else {
      btn.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        const allbtns = optionsrow.querySelectorAll('.ai-option-btn')
        allbtns.forEach((b) => b.classList.add('disabled'))
        btn.classList.add('selected')
        senduserprompt(optiontext)
      })
    }

    optionsrow.appendChild(btn)
  }

  return optionsrow
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

const copybtniconsvg = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`

function makeblockcopybutton(label, gettext) {
  const actions = document.createElement('div')
  actions.className = 'chat-block-actions'

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'btn-copy-code'
  btn.title = label
  const idle = `${copybtniconsvg} <span>${label}</span>`
  btn.innerHTML = idle

  btn.addEventListener('click', async (e) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(gettext())
      btn.innerHTML = `<span class="copy-success-text">copied</span>`
      setTimeout(() => {
        btn.innerHTML = idle
      }, 1000)
    } catch (err) {
      console.error(`failed to ${label}`, err)
    }
  })

  actions.appendChild(btn)
  return actions
}

// turn a rendered chat table back into gfm pipe markdown --------------------
function htmltabletomarkdown(table) {
  const rows = [...table.querySelectorAll('tr')].map(tr =>
    [...tr.querySelectorAll('th, td')].map(cell => {
      const text = (cell.textContent || '').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')
      return text || ' '
    })
  ).filter(cells => cells.length > 0)
  if (!rows.length) return ''

  const width = Math.max(...rows.map(r => r.length))
  const pad = (cells) => {
    while (cells.length < width) cells.push(' ')
    return cells
  }
  const lines = rows.map(cells => `| ${pad(cells).join(' | ')} |`)
  const divider = `| ${Array(width).fill('---').join(' | ')} |`
  return [lines[0], divider, ...lines.slice(1)].join('\n')
}

// attach copy button under code blocks and latex math in chat --------------------
export function attachblockcopyactions(bubbleel) {
  if (!bubbleel) return

  // attach copy button under code blocks --------------------
  const preblocks = bubbleel.querySelectorAll('pre')
  preblocks.forEach(pre => {
    if (pre.dataset.hasCopy) return
    pre.dataset.hasCopy = 'true'

    const actions = makeblockcopybutton('copy', () => {
      const codeel = pre.querySelector('code')
      const code = codeel ? codeel.textContent : pre.textContent
      const lang = codeel?.className?.match(/language-(\S+)/)?.[1]?.toLowerCase()
      if (lang === 'mermaid') return formatmermaidforpaste(code) || code
      return code
    })
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
    mb.insertAdjacentElement('afterend', makeblockcopybutton('copy latex', () => latextext))
  })

  // attach copy button under markdown tables --------------------
  bubbleel.querySelectorAll('table').forEach(table => {
    if (table.dataset.hasCopy) return
    table.dataset.hasCopy = 'true'
    table.insertAdjacentElement('afterend', makeblockcopybutton('copy table', () => htmltabletomarkdown(table)))
  })
}

function applychatmarkdownto(el, text) {
  if (!el) return
  el.innerHTML = renderchatmarkdown(text)
  attachblockcopyactions(el)
  enhancemermaid(el).catch(() => { })
  enhancechatcites(el).catch(() => { })
}

function isactivityworking(label, done = false) {
  if (done) return false
  const t = String(label || 'thinking...').trim().toLowerCase()
  if (!t || t === 'thinking...' || t === 'thinking' || t === 'reconnecting...') return false
  if (t.startsWith('thinking')) return false
  return true
}

function buildactivitystatusel(label, toolname = '', done = false) {
  const row = document.createElement('span')
  row.className = 'ai-activity-status-inner'
  const working = isactivityworking(label, done)
  const icon = document.createElement('img')
  icon.className = working ? 'ai-activity-icon is-working' : 'ai-activity-icon'
  icon.alt = ''
  icon.src = toolname
    ? gettoolicon(toolname)
    : (working ? tooliconfallback : '/resources/icons/general/thought.png')
  row.appendChild(icon)
  const text = document.createElement('span')
  text.className = 'ai-activity-label'
  const rawlabel = label || 'thinking...'
  if (rawlabel.includes('`')) {
    const parts = rawlabel.split(/(`[^`]+`)/g)
    for (const part of parts) {
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
        const codeel = document.createElement('code')
        codeel.textContent = part.slice(1, -1)
        text.appendChild(codeel)
      } else if (part) {
        text.appendChild(document.createTextNode(part))
      }
    }
  } else {
    text.textContent = rawlabel
  }
  row.appendChild(text)
  return row
}

function appenddonetoolactivity(call, beforeel = null) {
  if (!aimessages || !call?.name) return null
  const meta = formattoolmeta(call)
  const el = document.createElement('div')
  el.className = 'ai-activity-status is-done'
  el.dataset.toolName = call.name
  el.appendChild(buildactivitystatusel(meta.label, call.name, true))
  if (beforeel && beforeel.parentNode === aimessages) {
    aimessages.insertBefore(el, beforeel)
  } else {
    aimessages.appendChild(el)
  }
  return el
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
    attachments: attached.map(mapattachmentforlog),
    active_note_id: state.activenoteid,
    open_tabs: [...state.opentabs],
    timestamp: new Date().toISOString()
  })

  const isfirstuserturn = conversationlog.filter((e) => e.role === 'user').length === 1
  if (isfirstuserturn) {
    import('./conversations.js')
      .then((m) => m.maybegeneratetitleforactive())
      .catch(() => { })
  }

  // render user message with attachments and copy button --------------------
  const usermsg = document.createElement('div')
  usermsg.className = 'ai-msg user'

  let attachmenthtml = ''
  if (attached.length > 0) {
    attachmenthtml = '<div class="msg-attachments">'
    for (const a of attached) {
      const thumburl = a.previewUrl || (isimageattachment(a) && a.path ? vaultpreviewurl(a.path) : null)
      if (isimageattachment(a) && thumburl) {
        const title = a.path ? `${a.name} (${a.path})` : a.name
        attachmenthtml += `<img src="${thumburl}" class="msg-attachment-img" alt="${escapehtml(a.name)}" title="${escapehtml(title)}">`
      } else {
        attachmenthtml += renderattachmentpill(a)
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

  // live status line plus finished tool lines left in chat --------------------
  let livestatusel = null
  let livetoolname = ''

  function clearlivestatus() {
    if (livestatusel && livestatusel.parentNode) {
      livestatusel.remove()
    }
    livestatusel = null
    livetoolname = ''
  }

  function setlivestatus(statustext, toolname = '') {
    if (!livestatusel || !livestatusel.parentNode) {
      livestatusel = document.createElement('div')
      livestatusel.className = 'ai-activity-status is-live'
      aimessages.appendChild(livestatusel)
    }
    livetoolname = toolname || ''
    livestatusel.classList.add('is-live')
    livestatusel.classList.remove('is-done')
    livestatusel.replaceChildren(buildactivitystatusel(statustext, toolname, false))
    aimessages.scrollTop = aimessages.scrollHeight
  }

  function committoolactivity(call) {
    if (!call?.name) return
    const meta = formattoolmeta(call)
    if (livestatusel && livestatusel.parentNode && livetoolname === call.name) {
      livestatusel.classList.remove('is-live')
      livestatusel.classList.add('is-done')
      livestatusel.dataset.toolName = call.name
      livestatusel.replaceChildren(buildactivitystatusel(meta.label, call.name, true))
      livestatusel = null
      livetoolname = ''
    } else {
      clearlivestatus()
      appenddonetoolactivity(call)
    }
    aimessages.scrollTop = aimessages.scrollHeight
  }

  function updatestatus(statustext, toolname = '') {
    // new tool while another is still live --> leave the previous one as past tense --------------------
    if (toolname && livetoolname && livetoolname !== toolname && livestatusel) {
      committoolactivity({ name: livetoolname, args: {} })
    }
    setlivestatus(statustext, toolname)
  }

  function removestatus() {
    clearlivestatus()
  }

  setlivestatus('thinking...')
  aimessages.scrollTop = aimessages.scrollHeight

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
      history: aichathistory,
      notification_permission: ('Notification' in window) ? Notification.permission : undefined
    })

    for (let chatattempt = 0; chatattempt < 2; chatattempt++) {
      if (chatattempt > 0) {
        updatestatus('reconnecting...')
        await new Promise((r) => setTimeout(r, 1200))
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

            let paintedtoolstatus = false

            if (eventname === 'status') {
              let statustext = parsed.status || parsed.text || 'thinking...'
              let toolname = parsed.tool || ''
              if (statustext.startsWith('running ') || statustext.startsWith('using ')) {
                toolname = toolname || statustext.replace(/^(running|using)\s+/, '').replace(/\.\.\.$/, '')
                statustext = formattoolstatustext({ name: toolname, args: {} })
              }
              const isthinking = statustext === 'thinking...' || /^thinking\b/i.test(statustext)
              // keep finished and in-progress tool lines while the model thinks between rounds --------------------
              if (isthinking && (liveontoolstatus || livetoolname) && !toolname) continue
              liveontoolstatus = Boolean(toolname) || !isthinking
              updatestatus(statustext, toolname)
              paintedtoolstatus = Boolean(toolname) || liveontoolstatus
            } else if (eventname === 'thought') {
              if (!liveontoolstatus && !livetoolname) {
                updatestatus('thinking...')
              }
            } else if (eventname === 'token') {
              removestatus()
              liveontoolstatus = false
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
              // leave this tool in chat as a past-tense line --------------------
              if (parsed?.name) {
                committoolactivity(parsed)
                liveontoolstatus = true
                paintedtoolstatus = true
              }
            } else if (eventname === 'done') {
              donedata = parsed
            } else if (eventname === 'error') {
              throw new Error(parsed.error || 'request failed')
            }

            // let the browser paint tool badges when several sse events arrive in one chunk --------------------
            if (paintedtoolstatus) {
              await new Promise((resolve) => requestAnimationFrame(resolve))
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
                if (call.name !== 'textfile_edit_diff' && call.name !== 'textfile_create') return false
                return isnoteidmatch(toolpath, previewtarget)
              })
              if (sourcetouched) {
                await renderpreview(previewtarget)
              }
            }
          }

          // if ai generated a new file or opened a file for user open it in a new tab --------------------
          for (const call of finaltools) {
            const isnewfile = call.name === 'textfile_create'
            const isuseropen = call.name === 'file_open_for_user'
              || (call.name === 'textfile_read' && call.args?.open_in_tab)
            let targetfileid = call.args?.path || call.args?.file_path || call.args?.note_id
            if (call.name === 'youtube_video' && String(call.args?.action || '').toLowerCase() === 'download') {
              try {
                const parsed = typeof call.output === 'string' ? JSON.parse(call.output) : call.output
                if (parsed?.path && parsed?.open_in_tab !== false) {
                  targetfileid = parsed.path
                }
              } catch { }
            }
            if (!targetfileid && call.name === 'textfile_create') {
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

            // close tabs and safely adjust folder view if file or folder was deleted --------------------
            if (call.name === 'file_delete') {
              const delid = call.args?.path || call.args?.file_path || call.args?.note_id
              const isfolder = call.args?.delete_type === 'folder'
              if (delid && isfolder) {
                const delprefix = `${delid}/`
                const tabsremaining = state.opentabs.filter(t => !t.startsWith(delprefix) && t !== delid)
                if (tabsremaining.length !== state.opentabs.length) {
                  state.opentabs = tabsremaining
                  if (state.activenoteid && (state.activenoteid.startsWith(delprefix) || state.activenoteid === delid)) {
                    if (tabsremaining.length > 0) {
                      opennote(tabsremaining[0], { force: true, replacecurrent: false, switchfolder: false })
                    } else {
                      closenote()
                    }
                  }
                  rendertabs()
                  saveworkspacestate()
                }
                if (state.currentfolder === delid || state.currentfolder.startsWith(delprefix)) {
                  const parentparts = delid.split('/').slice(0, -1)
                  navigatefolder(parentparts.join('/'))
                }
              } else if (delid) {
                closetab(delid)
                closetab(`preview:${delid}`)
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
        const optionsrow = buildoptionsrow(data.options || [])
        if (optionsrow) agentmsg.appendChild(optionsrow)

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
    const statusicon = issoft
      ? '/resources/icons/general/warning.png'
      : '/resources/icons/general/error.png'
    const bubbleclass = issoft ? 'ai-status-soft' : (ishard ? 'ai-status-hard' : 'ai-status-error')
    errmsg.innerHTML = `<div class="msg-bubble ${bubbleclass}"><img class="ai-status-icon" src="${statusicon}" alt=""> <span>${displayerr}</span></div>`
    appendcopyactions(errmsg, displayerr)
    aimessages.appendChild(errmsg)
  } finally {
    agentchatinflight = false
    setagentinputenabled(true)
    if (aimessages) aimessages.scrollTop = aimessages.scrollHeight
    import('./conversations.js')
      .then((m) => {
        m.saveactiveconversation().catch(() => { })
        m.maybegeneratetitleforactive().catch(() => { })
      })
      .catch(() => { })
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
    draft: {
      text: aiinput ? aiinput.value : '',
      attachments: clonedraftattachments(currentattachments),
    },
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
          const thumburl = a.previewUrl || (isimageattachment(a) && a.path ? vaultpreviewurl(a.path) : null)
          if (isimageattachment(a) && thumburl) {
            const img = document.createElement('img')
            img.src = thumburl
            img.className = 'msg-attachment-img'
            img.alt = a.name || 'image'
            img.title = a.path ? `${a.name} (${a.path})` : (a.name || 'image')
            attwrap.appendChild(img)
          } else {
            const frag = document.createElement('div')
            frag.innerHTML = renderattachmentpill(a)
            if (frag.firstElementChild) attwrap.appendChild(frag.firstElementChild)
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
      const tools = Array.isArray(entry.tool_calls) ? entry.tool_calls : []
      for (const call of tools) {
        appenddonetoolactivity(call)
      }
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

      // restore quiz or choice answer bubbles from history --------------------
      if (!entry.error) {
        const next = conversationlog[i + 1]
        const selected = next?.role === 'user' ? String(next.prompt || '').trim() : null
        const optionsrow = buildoptionsrow(entry.options || [], selected)
        if (optionsrow) agentmsg.appendChild(optionsrow)
      }

      if (text || agentmsg.querySelector('.ai-options-row')) {
        appendcopyactions(agentmsg, text)
        aimessages.appendChild(agentmsg)
      }
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

  const draft = rec?.draft && typeof rec.draft === 'object' ? rec.draft : { text: '', attachments: [] }
  currentattachments = clonedraftattachments(draft.attachments)
  renderattachmentspreview()
  if (aiinput) {
    aiinput.value = typeof draft.text === 'string' ? draft.text : ''
    resizeaiinput()
  }
}

// update ai context menu items state --------------------
function updatecontextmenuui() {
  if (ctxitemcopychat) {
    ctxitemcopychat.classList.remove('hidden')
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
    aiinput.addEventListener('input', () => {
      resizeaiinput()
      scheduledraftsave()
    })
    aiinput.addEventListener('keydown', (e) => {
      // on mobile, enter creates a newline and sending is handled by the send button --------------------
      if (e.key === 'Enter' && !e.shiftKey) {
        if (ismobilemode()) {
          return
        }
        e.preventDefault()
        const prompt = aiinput.value?.trim() || ''
        if (prompt || currentattachments.length > 0) {
          senduserprompt(prompt)
        }
      }
    })
    resizeaiinput()

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
    const vaultitems = getdraggeditems(e)
    if (vaultitems.length) {
      e.preventDefault()
      e.stopPropagation()
      state.activefiledrag = null
      clearalldraghighlights()
      for (const vaultitem of vaultitems) {
        if (vaultitem.type !== 'file' && vaultitem.type !== 'folder') continue
        const label = vaultitem.name || vaultitem.title || vaultitem.path?.split('/').pop() || vaultitem.path
        addreferenceattachment({
          refKind: vaultitem.type === 'folder' ? 'folder' : 'file',
          name: label,
          path: vaultitem.path
        })
      }
      ensureaidraweropen()
      return true
    }
    if (e.dataTransfer?.files?.length) {
      e.preventDefault()
      e.stopPropagation()
      clearalldraghighlights()
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
      clearalldraghighlights()
      handledropontochat(e)
    })
  }

  // compose box only -- not the whole chat drawer --------------------
  bindchatdropzone(aiform)

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
      const exportlog = conversationlog.map((entry) => ({ ...entry }))
      if (exportlog.length > 0 && exportlog[exportlog.length - 1].role === 'user') {
        const lastbubble = aimessages?.querySelector('.ai-msg.agent:last-child .msg-bubble')
        const currentreply = (lastbubble ? lastbubble.textContent : '').trim()
        if (currentreply) {
          exportlog.push({
            role: 'assistant',
            reply: currentreply,
            timestamp: new Date().toISOString()
          })
        }
      }
      const payload = {
        export_version: 2,
        model: lastagentmodel || null,
        system_prompt: lastsystemprompt || null,
        system_prompt_meta: lastsystempromptmeta || null,
        notes: {
          tool_outputs: 'tool_calls outputs are folded like gemini history (youtube transcripts omitted)',
        },
        conversation: exportlog
      }
      const json = JSON.stringify(payload, null, 2)
      try {
        await navigator.clipboard.writeText(json)
        ctxitemcopychat.innerHTML = '<span style="color:#10b981">copied</span>'
        setTimeout(() => {
          ctxitemcopychat.innerHTML = '<img class="btn-icon-img" src="/resources/icons/general/copy.png" alt="copy"> copy conversation'
          closeaicontextmenu()
        }, 900)
      } catch (err) {
        console.error('failed to copy conversation to clipboard', err)
        closeaicontextmenu()
      }
    })
  }
}
