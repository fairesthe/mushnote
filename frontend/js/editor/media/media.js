import { state } from '../../core/state.js'
import {
  ed,
  imageviewerimg,
  mediavieweraudiowrap,
  mediaviewerart,
  mediavieweraudio,
  mediaviewervideo,
  mediaviewerpdf,
  mediaviewerfile,
  mediaviewerfilename,
  binaryfiletoolbar,
  btnfiledownload
} from '../editorshared.js'
import { isnoteidmatch } from '../noteutils.js'

const textfileexts = new Set([
  'md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'csv', 'tsv', 'xml',
  'html', 'htm', 'php', 'css', 'js', 'ts', 'py', 'sh', 'log', 'toml', 'ini', 'conf', 'env'
])

export function mediakindfromnoteid(noteid) {
  const name = (noteid || '').split('/').pop() || ''
  const parts = name.split('.')
  const ext = parts.length > 1 ? (parts.pop() || '').toLowerCase() : ''
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'].includes(ext)) return 'image'
  if (['mp3', 'm4a', 'wav', 'ogg', 'aac', 'flac'].includes(ext)) return 'audio'
  if (['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(ext)) return 'video'
  if (ext === 'pdf') return 'pdf'
  if (textfileexts.has(ext)) return null
  // unknown or binary -- still openable in the file viewer --------------------
  return 'file'
}

export function rawurlfornote(noteid) {
  return `/api/raw?id=${encodeURIComponent(noteid)}`
}

export function stopmediaplayback() {
  ed.mediaplayernoteid = null
  ed.mediaplayerkind = null
  if (imageviewerimg) {
    imageviewerimg.classList.add('hidden')
    imageviewerimg.removeAttribute('src')
  }
  if (mediavieweraudiowrap) {
    mediavieweraudiowrap.classList.add('hidden')
  }
  if (mediaviewerart) {
    mediaviewerart.classList.add('hidden')
    mediaviewerart.removeAttribute('src')
  }
  if (mediavieweraudio) {
    mediavieweraudio.pause()
    mediavieweraudio.removeAttribute('src')
  }
  if (mediaviewervideo) {
    mediaviewervideo.classList.add('hidden')
    mediaviewervideo.pause()
    mediaviewervideo.removeAttribute('src')
  }
  if (mediaviewerpdf) {
    mediaviewerpdf.classList.add('hidden')
    mediaviewerpdf.removeAttribute('src')
  }
  if (mediaviewerfile) {
    mediaviewerfile.classList.add('hidden')
  }
  if (mediaviewerfilename) {
    mediaviewerfilename.textContent = ''
  }
}

export function resetmediaviewer() {
  stopmediaplayback()
}

export function clearmediaimagepreview() {
  if (imageviewerimg) {
    imageviewerimg.classList.add('hidden')
    imageviewerimg.removeAttribute('src')
  }
}

export function stopmediafortabclose(noteid) {
  if (ed.mediaplayernoteid && isnoteidmatch(ed.mediaplayernoteid, noteid)) {
    stopmediaplayback()
  }
}

function coverurlfornote(noteid, version = '') {
  let url = `/api/media/cover?id=${encodeURIComponent(noteid)}`
  if (version) {
    url += `&v=${encodeURIComponent(version)}`
  }
  return url
}

export function loadaudiocoverart(noteid, version = '') {
  if (!mediaviewerart) return
  mediaviewerart.classList.add('hidden')
  mediaviewerart.removeAttribute('src')
  const url = coverurlfornote(noteid, version)
  mediaviewerart.onload = () => {
    mediaviewerart.classList.remove('hidden')
  }
  mediaviewerart.onerror = () => {
    mediaviewerart.classList.add('hidden')
    mediaviewerart.removeAttribute('src')
  }
  mediaviewerart.src = url
}

export function autoplaymediaviewer(el) {
  if (!el) return
  const start = () => {
    const ret = el.play()
    if (ret && typeof ret.catch === 'function') {
      ret.catch(() => {})
    }
  }
  if (el.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
    start()
    return
  }
  el.addEventListener('canplay', start, { once: true })
}

export function setbinarytoolbarvisible(show, noteid) {
  if (!binaryfiletoolbar) return
  if (!show) {
    binaryfiletoolbar.classList.add('hidden')
    binaryfiletoolbar.dataset.noteId = ''
    return
  }
  binaryfiletoolbar.classList.remove('hidden')
  if (noteid) binaryfiletoolbar.dataset.noteId = noteid
}

function downloadactivenote() {
  const noteid = binaryfiletoolbar?.dataset.noteId || state.activenoteid
  if (!noteid || noteid.startsWith('preview:')) return
  const link = document.createElement('a')
  link.href = rawurlfornote(noteid)
  link.download = noteid.split('/').pop() || 'download'
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
}

export function bindfiledownloadonce() {
  if (ed.isfiledownloadbound || !btnfiledownload) return
  ed.isfiledownloadbound = true
  btnfiledownload.addEventListener('click', () => downloadactivenote())
}

