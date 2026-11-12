import { api } from './api.js'
import { state } from './state.js'
import { opennote } from './editor.js'

// dom elements for page preview --------------------
const previewcontainer = document.getElementById('preview-viewer-container')
const previewiframe = document.getElementById('preview-iframe')
const previewaddressbar = document.getElementById('preview-address-bar')
const previewstatus = document.getElementById('preview-status')
const btnpreviewback = document.getElementById('btn-preview-back')
const btnpreviewforward = document.getElementById('btn-preview-forward')
const btnpreviewreload = document.getElementById('btn-preview-reload')
const btnpreviewexternal = document.getElementById('btn-preview-external')
const btnviewpage = document.getElementById('btn-view-page')
const ctxitemviewpage = document.getElementById('ctx-item-view-page')

// cached php wasm runtime state --------------------
let phpinstance = null
let isphploading = false
let currentpreviewid = null

// check if a note is previewable as a web page --------------------
export function ispreviewable(noteid) {
  if (!noteid || noteid.startsWith('preview:')) return false
  const ext = (noteid.split('.').pop() || '').toLowerCase()
  return ext === 'html' || ext === 'htm' || ext === 'php'
}

// extract raw note id from preview tab identifier --------------------
export function getpreviewtargetid(tabid) {
  if (!tabid || !tabid.startsWith('preview:')) return null
  return tabid.slice('preview:'.length)
}

// update visibility of view page button based on active note --------------------
export function updateviewpagebutton() {
  if (!btnviewpage) return
  if (state.activenoteid && ispreviewable(state.activenoteid)) {
    btnviewpage.classList.remove('hidden')
  } else {
    btnviewpage.classList.add('hidden')
  }
}

// open preview in a new tab --------------------
export function openpreviewtab(noteid) {
  if (!noteid) return
  const cleanid = noteid.startsWith('preview:') ? noteid.slice('preview:'.length) : noteid
  const previewtabid = `preview:${cleanid}`
  opennote(previewtabid, { newtab: true, switchfolder: false })
}

// set status message in preview toolbar --------------------
function setstatus(msg = '') {
  if (!previewstatus) return
  previewstatus.textContent = msg
}

// escape html entities for error displays --------------------
function escapehtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// inject base href so relative assets load via express preview route --------------------
function injectbasehref(html, folderpath) {
  const baseurl = folderpath ? `/preview/${folderpath}/` : '/preview/'
  const basetag = `<base href="${baseurl}">`
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, `$&${basetag}`)
  }
  return `<head>${basetag}</head>${html}`
}

// initialize or retrieve php wasm instance --------------------
async function getphpinstance() {
  if (phpinstance) return phpinstance
  if (isphploading) {
    while (isphploading) {
      await new Promise(r => setTimeout(r, 80))
    }
    if (phpinstance) return phpinstance
  }

  isphploading = true
  setstatus('booting php wasm...')

  try {
    const { PhpWeb } = await import('https://cdn.jsdelivr.net/npm/php-wasm/PhpWeb.mjs')
    const php = new PhpWeb()

    await new Promise((resolve) => {
      let done = false
      const timer = setTimeout(() => {
        if (!done) {
          done = true
          resolve()
        }
      }, 3000)

      php.addEventListener('ready', () => {
        if (!done) {
          done = true
          clearTimeout(timer)
          resolve()
        }
      }, { once: true })
    })

    phpinstance = php
    return phpinstance
  } catch (err) {
    console.error('failed to initialize php wasm', err)
    throw new Error(`php wasm load failed: ${err.message}`)
  } finally {
    isphploading = false
  }
}

// execute php code inside client side wasm sandbox --------------------
async function runphpcode(phpcode, filename) {
  const php = await getphpinstance()
  setstatus('running php...')

  let stdout = ''
  let stderr = ''
  const outhandler = (e) => { stdout += e.detail || '' }
  const errhandler = (e) => { stderr += e.detail || '' }

  php.addEventListener('output', outhandler)
  php.addEventListener('error', errhandler)

  try {
    if (typeof php.refresh === 'function') {
      try {
        await php.refresh()
      } catch {}
    }

    if (typeof php.writeFile === 'function') {
      try {
        await php.writeFile(`/app/${filename}`, phpcode)
      } catch {}
    }

    await php.run(phpcode)
  } finally {
    php.removeEventListener('output', outhandler)
    php.removeEventListener('error', errhandler)
  }

  if (!stdout && stderr) {
    return `<pre style="color:#ef4444;background:#0a0a0a;padding:16px;font-family:monospace;white-space:pre-wrap;">${escapehtml(stderr)}</pre>`
  }

  return stdout
}

// render page preview for given note id --------------------
export async function renderpreview(noteid) {
  if (!previewcontainer || !previewiframe) return
  currentpreviewid = noteid

  const ext = (noteid.split('.').pop() || '').toLowerCase()
  const isphp = ext === 'php'
  const folderpath = noteid.includes('/') ? noteid.split('/').slice(0, -1).join('/') : ''
  const filename = noteid.split('/').pop() || noteid

  if (previewaddressbar) {
    previewaddressbar.textContent = `http://localhost:3000/preview/${noteid}`
  }

  previewcontainer.classList.remove('hidden')

  try {
    setstatus('loading note...')
    const data = await api(`/api/note?id=${encodeURIComponent(noteid)}`)
    const rawcode = data?.note?.content || ''

    if (isphp) {
      setstatus('running in php wasm sandbox...')
      const htmloutput = await runphpcode(rawcode, filename)
      const finalhtml = injectbasehref(htmloutput, folderpath)
      previewiframe.srcdoc = finalhtml
      setstatus('ready')
    } else {
      setstatus('rendering html...')
      const finalhtml = injectbasehref(rawcode, folderpath)
      previewiframe.srcdoc = finalhtml
      setstatus('ready')
    }
  } catch (err) {
    setstatus('error')
    previewiframe.srcdoc = `<pre style="color:#ef4444;background:#0a0a0a;padding:16px;font-family:monospace;white-space:pre-wrap;">${escapehtml(err.message)}</pre>`
  }
}

// close or hide preview container --------------------
export function hidepreview() {
  if (previewcontainer) {
    previewcontainer.classList.add('hidden')
  }
  if (previewiframe) {
    previewiframe.srcdoc = ''
  }
  currentpreviewid = null
  setstatus('')
}

// initialize preview event listeners --------------------
export function initpreview() {
  if (btnviewpage) {
    btnviewpage.addEventListener('click', () => {
      if (state.activenoteid && ispreviewable(state.activenoteid)) {
        openpreviewtab(state.activenoteid)
      }
    })
  }

  if (btnpreviewback) {
    btnpreviewback.addEventListener('click', () => {
      try {
        previewiframe?.contentWindow?.history.back()
      } catch {}
    })
  }

  if (btnpreviewforward) {
    btnpreviewforward.addEventListener('click', () => {
      try {
        previewiframe?.contentWindow?.history.forward()
      } catch {}
    })
  }

  if (btnpreviewreload) {
    btnpreviewreload.addEventListener('click', () => {
      if (currentpreviewid) {
        renderpreview(currentpreviewid)
      }
    })
  }

  if (btnpreviewexternal) {
    btnpreviewexternal.addEventListener('click', () => {
      if (currentpreviewid) {
        window.open(`/preview/${encodeURI(currentpreviewid)}`, '_blank', 'noopener,noreferrer')
      }
    })
  }

  // intercept relative links inside iframe to stay in preview --------------------
  if (previewiframe) {
    previewiframe.addEventListener('load', () => {
      try {
        const idoc = previewiframe.contentDocument || previewiframe.contentWindow?.document
        if (!idoc) return

        idoc.querySelectorAll('a[href]').forEach(link => {
          link.addEventListener('click', async (e) => {
            const href = link.getAttribute('href')
            if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) {
              return
            }
            if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('//')) {
              return
            }

            e.preventDefault()
            const cleanhref = href.split('?')[0].split('#')[0]
            if (currentpreviewid) {
              const parts = currentpreviewid.split('/')
              parts.pop()
              const target = parts.length > 0 ? `${parts.join('/')}/${cleanhref}` : cleanhref
              await renderpreview(target)
            }
          })
        })
      } catch {}
    })
  }
}

