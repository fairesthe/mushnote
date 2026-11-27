// frontend bridge for the mushnote browser extension --------------------

let extready = false
let extversion = null
let reqcounter = 0
const pending = new Map()

window.addEventListener('message', (event) => {
  if (event.source !== window) return
  const msg = event.data
  if (!msg || typeof msg !== 'object') return

  if (msg.type === 'MUSHNOTE_EXT_READY') {
    extready = true
    extversion = msg.version || null
    return
  }

  if (
    (msg.type === 'MUSHNOTE_FETCH_PAGE_RESULT' ||
      msg.type === 'MUSHNOTE_LIST_TABS_RESULT' ||
      msg.type === 'MUSHNOTE_OPEN_TAB_RESULT' ||
      msg.type === 'MUSHNOTE_CLOSE_TAB_RESULT') &&
    msg.requestId
  ) {
    const entry = pending.get(msg.requestId)
    if (!entry) return
    pending.delete(msg.requestId)
    clearTimeout(entry.timer)
    if (msg.ok) {
      entry.resolve(msg.data)
    } else {
      entry.reject(new Error(msg.error || 'extension request failed'))
    }
  }
})

// ping extension on load --------------------
window.postMessage({ type: 'MUSHNOTE_EXT_PING' }, '*')

export function isextensionconnected() {
  return extready
}

export function getextensionversion() {
  return extversion
}

// fetch a page via the extension background tab runner --------------------
export function fetchpageviaextension(url, { keepOpen = false, active = false, timeoutms = 20000 } = {}) {
  if (!extready) {
    return Promise.reject(new Error('mushnote extension is not connected'))
  }

  const requestId = `req_${++reqcounter}_${Date.now()}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error('extension fetch timed out'))
    }, timeoutms)

    pending.set(requestId, { resolve, reject, timer })
    window.postMessage({ type: 'MUSHNOTE_FETCH_PAGE', requestId, url, keepOpen, active }, '*')
  })
}

// list all tabs currently in the mushnote tab group --------------------
export function listmushnotetabs(timeoutms = 5000) {
  if (!extready) {
    return Promise.reject(new Error('mushnote extension is not connected'))
  }

  const requestId = `req_${++reqcounter}_${Date.now()}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error('extension list tabs timed out'))
    }, timeoutms)

    pending.set(requestId, { resolve, reject, timer })
    window.postMessage({ type: 'MUSHNOTE_LIST_TABS', requestId }, '*')
  })
}

// open or focus a tab in the mushnote tab group --------------------
export function openmushnotetab({ tabId, url, active = true } = {}, timeoutms = 5000) {
  if (!extready) {
    return Promise.reject(new Error('mushnote extension is not connected'))
  }

  const requestId = `req_${++reqcounter}_${Date.now()}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error('extension open tab timed out'))
    }, timeoutms)

    pending.set(requestId, { resolve, reject, timer })
    window.postMessage({ type: 'MUSHNOTE_OPEN_TAB', requestId, tabId, url, active }, '*')
  })
}

// close a tab by id --------------------
export function closemushnotetab(tabId, timeoutms = 5000) {
  if (!extready) {
    return Promise.reject(new Error('mushnote extension is not connected'))
  }

  const requestId = `req_${++reqcounter}_${Date.now()}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error('extension close tab timed out'))
    }, timeoutms)

    pending.set(requestId, { resolve, reject, timer })
    window.postMessage({ type: 'MUSHNOTE_CLOSE_TAB', requestId, tabId }, '*')
  })
}
