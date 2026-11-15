import { state } from '../core/state.js'
import { compressimagetowebp, imageuploadbasename } from '../editor/media/imageupload.js'

const mindurationms = 700
const deletedtrackerid = ':deleted'

let overlayel = null
let labelel = null
let fillel = null
let cancelel = null
let activecontroller = null
let hideat = 0

function ensureoverlay() {
  if (overlayel) return
  overlayel = document.createElement('div')
  overlayel.id = 'upload-progress-overlay'
  overlayel.className = 'upload-progress-overlay hidden'
  overlayel.innerHTML = `
    <div class="upload-progress-card" role="dialog" aria-live="polite">
      <div class="upload-progress-label" id="upload-progress-label">uploading file...</div>
      <div class="upload-progress-track">
        <div class="upload-progress-fill" id="upload-progress-fill"></div>
      </div>
      <button type="button" class="upload-progress-cancel" id="upload-progress-cancel">cancel</button>
    </div>
  `
  document.body.appendChild(overlayel)
  labelel = overlayel.querySelector('#upload-progress-label')
  fillel = overlayel.querySelector('#upload-progress-fill')
  cancelel = overlayel.querySelector('#upload-progress-cancel')
  cancelel.addEventListener('click', () => {
    activecontroller?.abort()
  })
}

function setprogress(pct) {
  if (!fillel) return
  const n = Math.max(0, Math.min(100, Number(pct) || 0))
  fillel.style.width = `${n}%`
}

function setlabel(text) {
  if (labelel) labelel.textContent = text || 'uploading file...'
}

function showoverlay(label) {
  ensureoverlay()
  setlabel(label)
  setprogress(0)
  overlayel.classList.remove('hidden')
  document.body.classList.add('is-uploading')
  hideat = Date.now() + mindurationms
}

async function hideoverlay() {
  const wait = Math.max(0, hideat - Date.now())
  if (wait) await new Promise((r) => setTimeout(r, wait))
  if (overlayel) overlayel.classList.add('hidden')
  document.body.classList.remove('is-uploading')
  setprogress(0)
  activecontroller = null
}

export function sanitizeuploadname(name) {
  const cleaned = String(name || 'file').replace(/[^a-zA-Z0-9_\-. ]/g, '').trim()
  return cleaned || 'file'
}

export function isimagefile(file) {
  return Boolean(file && (file.type?.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name || '')))
}

export function workingfolderfromstate() {
  if (state.currentfolder === deletedtrackerid) return ''
  return state.currentfolder || ''
}

// post a data url to /api/upload with progress and cancel --------------------
export function uploaddataurl(path, dataurl, { signal, onprogress } = {}) {
  return new Promise((resolve, reject) => {
    const token = localStorage.getItem('mushnote_token')
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/upload')
    xhr.setRequestHeader('Content-Type', 'application/json')
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.withCredentials = true

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return
      onprogress?.(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      let data = {}
      try { data = JSON.parse(xhr.responseText || '{}') } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data)
      else reject(new Error(data.error || 'upload failed'))
    }
    xhr.onerror = () => reject(new Error('upload failed'))
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'))

    if (signal) {
      if (signal.aborted) {
        xhr.abort()
        reject(new DOMException('aborted', 'AbortError'))
        return
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true })
    }

    xhr.send(JSON.stringify({ path, data: dataurl }))
  })
}

export function readfileasdataurl(file, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'))
      return
    }
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('failed to read file'))
    const onabort = () => {
      try { reader.abort() } catch {}
      reject(new DOMException('aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onabort, { once: true })
    reader.readAsDataURL(file)
  })
}

// run an upload job with the dark overlay progress card --------------------
export async function withuploadui(label, work) {
  const controller = new AbortController()
  activecontroller = controller
  showoverlay(label)
  try {
    const result = await work({
      signal: controller.signal,
      setlabel,
      setprogress
    })
    setprogress(100)
    return result
  } finally {
    await hideoverlay()
  }
}

export async function uploadfiletovault(file, folder = '') {
  const normfolder = String(folder || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const safe = sanitizeuploadname(file.name)
  const uploadpath = normfolder ? `${normfolder}/${Date.now()}-${safe}` : `${Date.now()}-${safe}`

  // images (except svg) get compressed to webp --------------------
  if (isimagefile(file) && !/\.svg$/i.test(file.name || '')) {
    return uploadimagefiletovault(file, normfolder || 'media')
  }

  return withuploadui(`uploading ${safe}...`, async ({ signal, setlabel, setprogress }) => {
    setlabel(`uploading ${safe}...`)
    setprogress(5)
    const dataurl = await readfileasdataurl(file, { signal })
    if (!dataurl || typeof dataurl !== 'string' || !dataurl.includes(',')) {
      throw new Error('could not read file data')
    }
    setprogress(20)
    const res = await uploaddataurl(uploadpath, dataurl, {
      signal,
      onprogress: (pct) => setprogress(20 + Math.round(pct * 0.8))
    })
    if (!res?.path && !res?.status) {
      throw new Error('upload failed')
    }
    return {
      path: res.path || uploadpath,
      name: safe,
      size: file.size,
      mimeType: file.type || '',
      url: `/${res.path || uploadpath}`
    }
  })
}

export async function uploadimagefiletovault(file, folder = 'media') {
  const normfolder = String(folder ?? 'media').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const rawname = imageuploadbasename(file)
  const filename = rawname ? `${rawname}-${Date.now()}.webp` : `${Date.now()}.webp`
  const uploadpath = normfolder ? `${normfolder}/${filename}` : filename

  return withuploadui('compressing image...', async ({ signal, setlabel, setprogress }) => {
    setprogress(12)
    const { dataurl } = await compressimagetowebp(file, 1920, 0.85)
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
    setlabel('uploading image...')
    setprogress(35)
    const res = await uploaddataurl(uploadpath, dataurl, {
      signal,
      onprogress: (pct) => setprogress(35 + Math.round(pct * 0.65))
    })
    return {
      path: res.path || uploadpath,
      url: `/${res.path || uploadpath}`,
      alt: rawname || 'image',
      name: filename,
      mimeType: 'image/webp'
    }
  })
}
