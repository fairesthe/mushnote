import { api } from '../core/api.js'
import { state } from '../core/state.js'
import { opennote } from '../editor/editor.js'

// dom elements for page preview --------------------
const previewcontainer = document.getElementById('preview-viewer-container')
const previewiframe = document.getElementById('preview-iframe')
const previewaddressbar = document.getElementById('preview-address-bar')
const btnpreviewback = document.getElementById('btn-preview-back')
const btnpreviewforward = document.getElementById('btn-preview-forward')
const btnpreviewreload = document.getElementById('btn-preview-reload')
const btnpreviewbacktocode = document.getElementById('btn-preview-back-to-code')
const btnviewpage = document.getElementById('btn-view-page')

// cached php wasm runtime state --------------------
let phpinstance = null
let isphploading = false
let currentpreviewid = null
let currentexternalurl = null

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

export function ispreviewtabid(tabid) {
  return Boolean(tabid && tabid.startsWith('preview:'))
}

let previewreloadtimer = null

async function notematches(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  try {
    const { isnoteidmatch } = await import('../editor/editor.js')
    return isnoteidmatch(a, b)
  } catch {
    const norm = (s) => String(s).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    return norm(a) === norm(b)
  }
}

// reload iframe when the backing source file changed --------------------
export async function reloadactivepreviewifmatches(noteid) {
  if (!state.activenoteid?.startsWith('preview:')) return
  const target = getpreviewtargetid(state.activenoteid)
  if (!target || !noteid) return
  if (!(await notematches(noteid, target))) return
  await renderpreview(target)
}

// debounce rapid yjs edit events into one preview reload --------------------
export function schedulepreviewreload(noteid) {
  if (!noteid) return
  if (previewreloadtimer) clearTimeout(previewreloadtimer)
  previewreloadtimer = setTimeout(() => {
    previewreloadtimer = null
    reloadactivepreviewifmatches(noteid)
  }, 200)
}

// update visibility of view page button based on active note --------------------
export function updateviewpagebutton() {
  if (!btnviewpage) return
  if (state.activenoteid?.startsWith('preview:')) {
    btnviewpage.classList.add('hidden')
    return
  }
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

function setaddressbarvalue(value) {
  if (!previewaddressbar || document.activeElement === previewaddressbar) return
  previewaddressbar.value = value
}

function previewpathfornote(noteid) {
  return `/preview/${noteid}`
}

// escape html entities for error displays --------------------
function escapehtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function extracttitlefromhtml(html) {
  const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!match) return null
  const title = match[1].replace(/\s+/g, ' ').trim()
  return title || null
}

function titletabfallback(noteid) {
  return noteid.split('/').pop() || noteid
}

async function updatepreviewtabtitle(title, noteid = currentpreviewid) {
  if (!state.activenoteid?.startsWith('preview:')) return
  if (!state.previewtitles) state.previewtitles = {}
  const fallback = titletabfallback(noteid || getpreviewtargetid(state.activenoteid) || '')
  const finaltitle = (title && String(title).trim()) || fallback
  state.previewtitles[state.activenoteid] = finaltitle
  document.title = `web: ${finaltitle} - mushnote`
  try {
    const { rendertabs } = await import('./tabs.js')
    rendertabs()
  } catch (err) {
    console.warn('could not refresh preview tab label', err)
  }
}

function applytitlefromiframe() {
  try {
    const idoc = previewiframe?.contentDocument || previewiframe?.contentWindow?.document
    if (!idoc) return
    const t = idoc.title?.trim()
    if (t) {
      updatepreviewtabtitle(t)
    }
  } catch {}
}

function applytitlefromexternalurl(url) {
  try {
    const parsed = new URL(url)
    updatepreviewtabtitle(parsed.hostname || url)
  } catch {
    updatepreviewtabtitle(url)
  }
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

// build a php preamble so $_GET / $_POST work under cli-like php-wasm --------------------
function phprequestbootstrap(filename, request = {}) {
  const method = String(request.method || 'GET').toUpperCase()
  const query = String(request.query || '')
  const body = String(request.body || '')
  const script = `/${filename}`.replace(/\/+/g, '/')
  const setpost = method === 'POST' || method === 'PUT' || method === 'PATCH'
  return `<?php
$_SERVER['REQUEST_METHOD'] = ${JSON.stringify(method)};
$_SERVER['SCRIPT_NAME'] = ${JSON.stringify(script)};
$_SERVER['PHP_SELF'] = ${JSON.stringify(script)};
$_SERVER['QUERY_STRING'] = ${JSON.stringify(query)};
$_GET = [];
$_POST = [];
$_REQUEST = [];
parse_str(${JSON.stringify(query)}, $_GET);
${setpost ? `parse_str(${JSON.stringify(body)}, $_POST);` : ''}
$_REQUEST = array_merge($_GET, $_POST);
?>`
}

// execute php code inside client side wasm sandbox --------------------
async function runphpcode(phpcode, filename, request = {}) {
  const php = await getphpinstance()

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

    const wrapped = `${phprequestbootstrap(filename, request)}\n${phpcode}`

    if (typeof php.writeFile === 'function') {
      try {
        await php.writeFile(`/app/${filename}`, wrapped)
      } catch {}
    }

    await php.run(wrapped)
  } finally {
    php.removeEventListener('output', outhandler)
    php.removeEventListener('error', errhandler)
  }

  if (!stdout && stderr) {
    return `<pre style="color:#ef4444;background:#0a0a0a;padding:16px;font-family:monospace;white-space:pre-wrap;">${escapehtml(stderr)}</pre>`
  }

  return stdout
}

function formdatatoquery(formdata) {
  const params = new URLSearchParams()
  for (const [key, value] of formdata.entries()) {
    if (typeof value === 'string') params.append(key, value)
  }
  return params.toString()
}

// resolve form or link target relative to the active preview note --------------------
function resolvepreviewtarget(rawhref, currentid) {
  const href = String(rawhref || '').trim()
  if (!href || href === '#' || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) {
    return { noteid: currentid, query: '', external: false }
  }
  if (/^https?:\/\//i.test(href) || href.startsWith('//')) {
    return { noteid: null, query: '', external: true, url: href.startsWith('//') ? `https:${href}` : href }
  }

  const hashidx = href.indexOf('#')
  const qidx = href.indexOf('?')
  let pathpart = href
  let query = ''
  if (qidx !== -1 && (hashidx === -1 || qidx < hashidx)) {
    pathpart = href.slice(0, qidx)
    query = href.slice(qidx + 1, hashidx === -1 ? undefined : hashidx)
  } else if (hashidx !== -1) {
    pathpart = href.slice(0, hashidx)
  }

  if (!pathpart || pathpart === '.' || pathpart === './') {
    return { noteid: currentid, query, external: false }
  }

  const previewmarker = '/preview/'
  if (pathpart.startsWith(previewmarker)) {
    return {
      noteid: decodeURIComponent(pathpart.slice(previewmarker.length)),
      query,
      external: false,
    }
  }

  // base href makes absolute paths look like /preview/... --------------------
  if (pathpart.startsWith('/')) {
    const stripped = pathpart.replace(/^\/+/, '')
    if (stripped.startsWith('preview/')) {
      return {
        noteid: decodeURIComponent(stripped.slice('preview/'.length)),
        query,
        external: false,
      }
    }
    return { noteid: decodeURIComponent(stripped), query, external: false }
  }

  const baseparts = String(currentid || '').split('/').filter(Boolean)
  baseparts.pop()
  const segs = [...baseparts, ...pathpart.split('/')].filter(Boolean)
  const resolved = []
  for (const seg of segs) {
    if (seg === '.') continue
    if (seg === '..') {
      resolved.pop()
      continue
    }
    resolved.push(seg)
  }
  return { noteid: resolved.join('/'), query, external: false }
}

function loaddocintosandbox(html) {
  if (!previewiframe) return
  currentexternalurl = null
  try {
    previewiframe.removeAttribute('src')
  } catch {}
  previewiframe.srcdoc = html
}

function loadexternalurl(url) {
  if (!previewiframe) return
  currentpreviewid = null
  currentexternalurl = url
  previewiframe.srcdoc = ''
  previewiframe.src = url
  setaddressbarvalue(url)
  applytitlefromexternalurl(url)
}

function parseaddressinput(raw) {
  const target = String(raw || '').trim()
  if (!target) return { kind: 'empty' }

  if (/^https?:\/\//i.test(target)) {
    return { kind: 'external', url: target }
  }

  let noteid = target
  const previewmarker = '/preview/'
  const markeridx = target.indexOf(previewmarker)
  if (markeridx !== -1) {
    noteid = target.slice(markeridx + previewmarker.length)
  } else if (target.startsWith('/')) {
    noteid = target.replace(/^\//, '')
  }

  noteid = decodeURIComponent(noteid.split('?')[0].split('#')[0])
  return { kind: 'vault', noteid }
}

// navigate from address bar input --------------------
export async function navigatetoaddress(raw) {
  const parsed = parseaddressinput(raw)
  if (parsed.kind === 'empty') return

  if (parsed.kind === 'external') {
    loadexternalurl(parsed.url)
    return
  }

  if (parsed.kind === 'vault' && parsed.noteid) {
    await renderpreview(parsed.noteid)
  }
}

// render page preview for given note id --------------------
export async function renderpreview(noteid, request = {}) {
  if (!previewcontainer || !previewiframe) return
  currentpreviewid = noteid
  currentexternalurl = null

  const ext = (noteid.split('.').pop() || '').toLowerCase()
  const isphp = ext === 'php'
  const folderpath = noteid.includes('/') ? noteid.split('/').slice(0, -1).join('/') : ''
  const filename = noteid.split('/').pop() || noteid
  const method = String(request.method || 'GET').toUpperCase()
  const query = String(request.query || '')
  const body = String(request.body || '')

  const address = query && method === 'GET'
    ? `${previewpathfornote(noteid)}?${query}`
    : previewpathfornote(noteid)
  setaddressbarvalue(address)
  updatepreviewtabtitle(titletabfallback(noteid), noteid)

  previewcontainer.classList.remove('hidden')

  try {
    const data = await api(`/api/note?id=${encodeURIComponent(noteid)}`)
    const rawcode = data?.note?.content || ''

    let finalhtml
    if (isphp) {
      const htmloutput = await runphpcode(rawcode, filename, { method, query, body })
      finalhtml = injectbasehref(htmloutput, folderpath)
    } else {
      finalhtml = injectbasehref(rawcode, folderpath)
    }

    const parsedtitle = extracttitlefromhtml(finalhtml)
    if (parsedtitle) {
      updatepreviewtabtitle(parsedtitle, noteid)
    }

    loaddocintosandbox(finalhtml)
  } catch (err) {
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
    try {
      previewiframe.removeAttribute('src')
    } catch {}
  }
  currentpreviewid = null
  currentexternalurl = null
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

  if (previewaddressbar) {
    previewaddressbar.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        navigatetoaddress(previewaddressbar.value)
        previewaddressbar.blur()
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
      } else if (currentexternalurl) {
        const url = currentexternalurl
        previewiframe.src = url
        setaddressbarvalue(url)
      }
    })
  }

  if (btnpreviewbacktocode) {
    btnpreviewbacktocode.addEventListener('click', () => {
      const source = getpreviewtargetid(state.activenoteid) || currentpreviewid
      if (!source) return
      opennote(source, {
        newtab: false,
        replacecurrent: true,
        switchfolder: false,
        force: true
      })
    })
  }

  // intercept relative links and forms inside iframe to stay in preview --------------------
  if (previewiframe) {
    previewiframe.addEventListener('load', () => {
      if (currentexternalurl) {
        applytitlefromiframe()
        if (!state.previewtitles?.[state.activenoteid]) {
          applytitlefromexternalurl(currentexternalurl)
        }
        return
      }

      try {
        applytitlefromiframe()

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
            if (!currentpreviewid) return
            const target = resolvepreviewtarget(href, currentpreviewid)
            if (target.external) return
            await renderpreview(target.noteid, {
              method: 'GET',
              query: target.query || '',
            })
          })
        })

        // forms must not navigate srcdoc or firefox shows a blank neterror page --------------------
        idoc.addEventListener('submit', async (e) => {
          const form = e.target
          if (!form || form.tagName !== 'FORM') return
          if (!currentpreviewid) return

          const action = form.getAttribute('action') || ''
          const target = resolvepreviewtarget(action, currentpreviewid)
          if (target.external) return

          e.preventDefault()
          e.stopPropagation()

          const method = String(form.getAttribute('method') || 'GET').toUpperCase()
          const encoded = formdatatoquery(new FormData(form))

          if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
            await renderpreview(target.noteid || currentpreviewid, {
              method,
              query: target.query || '',
              body: encoded,
            })
            return
          }

          // GET: merge action query with form fields --------------------
          const merged = new URLSearchParams(target.query || '')
          for (const [key, value] of new URLSearchParams(encoded)) {
            merged.append(key, value)
          }
          await renderpreview(target.noteid || currentpreviewid, {
            method: 'GET',
            query: merged.toString(),
          })
        }, true)
      } catch {}
    })
  }
}
