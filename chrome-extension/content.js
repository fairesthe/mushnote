// mushnote extension content script bridge --------------------

const EXT_VERSION = chrome.runtime.getManifest().version

function announce() {
  window.postMessage({
    type: 'MUSHNOTE_EXT_READY',
    version: EXT_VERSION
  }, '*')
}

// announce immediately on load --------------------
announce()

// respond to page pings and forward fetch requests --------------------
window.addEventListener('message', (event) => {
  if (event.source !== window) return
  const msg = event.data
  if (!msg || typeof msg !== 'object') return

  if (msg.type === 'MUSHNOTE_EXT_PING') {
    chrome.runtime.sendMessage({ type: 'MUSHNOTE_REGISTER_ORIGIN', origin: window.location.origin }).catch(() => {})
    announce()
    return
  }

  if (msg.type === 'MUSHNOTE_FETCH_PAGE' && msg.url) {
    chrome.runtime.sendMessage(
      { type: 'MUSHNOTE_FETCH_PAGE', url: msg.url, keepOpen: msg.keepOpen, active: msg.active },
      (res) => {
        window.postMessage({
          type: 'MUSHNOTE_FETCH_PAGE_RESULT',
          requestId: msg.requestId,
          ...(res || { ok: false, error: 'no response from extension' })
        }, '*')
      }
    )
    return
  }

  if (msg.type === 'MUSHNOTE_LIST_TABS') {
    chrome.runtime.sendMessage({ type: 'MUSHNOTE_LIST_TABS' }, (res) => {
      window.postMessage({
        type: 'MUSHNOTE_LIST_TABS_RESULT',
        requestId: msg.requestId,
        ...(res || { ok: false, error: 'no response from extension' })
      }, '*')
    })
    return
  }

  if (msg.type === 'MUSHNOTE_OPEN_TAB') {
    chrome.runtime.sendMessage({ type: 'MUSHNOTE_OPEN_TAB', tabId: msg.tabId, url: msg.url, active: msg.active }, (res) => {
      window.postMessage({
        type: 'MUSHNOTE_OPEN_TAB_RESULT',
        requestId: msg.requestId,
        ...(res || { ok: false, error: 'no response from extension' })
      }, '*')
    })
    return
  }

  if (msg.type === 'MUSHNOTE_CLOSE_TAB') {
    chrome.runtime.sendMessage({ type: 'MUSHNOTE_CLOSE_TAB', tabId: msg.tabId }, (res) => {
      window.postMessage({
        type: 'MUSHNOTE_CLOSE_TAB_RESULT',
        requestId: msg.requestId,
        ...(res || { ok: false, error: 'no response from extension' })
      }, '*')
    })
  }
})
