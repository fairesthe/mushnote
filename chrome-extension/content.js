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
    chrome.storage.local.get('pendingAskSelection', ({ pendingAskSelection }) => {
      if (pendingAskSelection?.text) {
        chrome.storage.local.remove('pendingAskSelection').catch(() => {})
        window.postMessage(pendingAskSelection, '*')
      }
    })
    return
  }

  if (msg.type === 'MUSHNOTE_AI_NAME' && msg.name) {
    chrome.runtime.sendMessage({ type: 'MUSHNOTE_SET_AI_NAME', name: msg.name }).catch(() => {})
    return
  }

  if (msg.type === 'MUSHNOTE_CONV_UPDATED' && msg.convId) {
    chrome.runtime.sendMessage({ type: 'MUSHNOTE_CONV_UPDATED', convId: msg.convId }).catch(() => {})
    return
  }

  if (msg.type === 'MUSHNOTE_AI_STATE') {
    chrome.runtime.sendMessage({ type: 'MUSHNOTE_SET_AI_OPEN', open: msg.open }).catch(() => {})
    return
  }

  if (msg.type === 'MUSHNOTE_AI_WIDTH' && typeof msg.width === 'number') {
    chrome.runtime.sendMessage({ type: 'MUSHNOTE_SET_AI_WIDTH', width: msg.width }).catch(() => {})
    return
  }

  if (msg.type === 'MUSHNOTE_FETCH_PAGE' && (msg.url || msg.tabId)) {
    chrome.runtime.sendMessage(
      { type: 'MUSHNOTE_FETCH_PAGE', url: msg.url, tabId: msg.tabId, keepOpen: msg.keepOpen, active: msg.active },
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

// injected ai sidebar for external tabs in the mushnote group --------------------
let sidebarwidth = 380
let sidebarhost = null
let sidebarframe = null
let sidebartoggle = null
let sidebararrow = null
let sidebaropen = true
let squishremovetimer = null
let removehosttimer = null

function applypagesquish(active, animate = true) {
  if (window.top !== window) return
  const root = document.documentElement
  const body = document.body
  if (!root) return
  if (squishremovetimer) {
    clearTimeout(squishremovetimer)
    squishremovetimer = null
  }
  if (active) {
    if (animate && !root.style.width) {
      root.style.setProperty('transition', 'none', 'important')
      root.style.setProperty('width', '100vw', 'important')
      root.style.setProperty('max-width', '100vw', 'important')
      void root.offsetWidth
    }
    root.style.setProperty('transition', animate ? 'width 0.22s ease, max-width 0.22s ease' : 'none', 'important')
    root.style.setProperty('width', `calc(100vw - ${sidebarwidth}px)`, 'important')
    root.style.setProperty('max-width', `calc(100vw - ${sidebarwidth}px)`, 'important')
    root.style.setProperty('overflow-x', 'hidden', 'important')
    if (body) {
      body.style.setProperty('width', '100%', 'important')
      body.style.setProperty('max-width', '100%', 'important')
      body.style.setProperty('box-sizing', 'border-box', 'important')
    }
  } else {
    root.style.setProperty('transition', animate ? 'width 0.22s ease, max-width 0.22s ease' : 'none', 'important')
    root.style.setProperty('width', '100vw', 'important')
    root.style.setProperty('max-width', '100vw', 'important')
    const cleanup = () => {
      root.style.removeProperty('width')
      root.style.removeProperty('max-width')
      root.style.removeProperty('overflow-x')
      root.style.removeProperty('transition')
      if (body) {
        body.style.removeProperty('width')
        body.style.removeProperty('max-width')
        body.style.removeProperty('box-sizing')
      }
    }
    if (animate) {
      squishremovetimer = setTimeout(cleanup, 230)
    } else {
      cleanup()
    }
  }
  window.dispatchEvent(new Event('resize'))
}

function ensuresidebardom(origin) {
  if (window.top !== window || sidebarhost) return

  sidebarhost = document.createElement('div')
  sidebarhost.setAttribute('data-mushnote-ignore', 'true')
  Object.assign(sidebarhost.style, {
    position: 'fixed',
    top: '0',
    right: '0',
    width: `${sidebarwidth}px`,
    height: '100vh',
    zIndex: '2147483647',
    background: '#000',
    borderLeft: '1px solid #222',
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'border-box',
    transform: 'translateX(100%)',
    transition: 'transform 0.22s ease'
  })

  // drag resizer on left edge --------------------
  const resizer = document.createElement('div')
  Object.assign(resizer.style, {
    position: 'absolute',
    top: '0',
    left: '-3px',
    width: '6px',
    height: '100%',
    cursor: 'ew-resize',
    zIndex: '2'
  })

  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault()
    sidebarhost.style.transition = 'none'
    sidebartoggle.style.transition = 'none'
    document.documentElement.style.setProperty('transition', 'none', 'important')
    sidebarframe.style.pointerEvents = 'none'

    function onmove(ev) {
      sidebarwidth = Math.max(220, Math.min(window.innerWidth - ev.clientX, 720))
      sidebarhost.style.width = `${sidebarwidth}px`
      if (sidebaropen) {
        applypagesquish(true, false)
        sidebartoggle.style.right = `${sidebarwidth}px`
      }
    }

    function onup() {
      window.removeEventListener('mousemove', onmove)
      window.removeEventListener('mouseup', onup)
      sidebarhost.style.transition = 'transform 0.22s ease'
      sidebartoggle.style.transition = 'right 0.22s ease'
      sidebarframe.style.pointerEvents = 'auto'
      chrome.storage.local.set({ sidebarWidth: sidebarwidth }).catch(() => {})
      chrome.runtime.sendMessage({ type: 'MUSHNOTE_SET_AI_WIDTH', width: sidebarwidth }).catch(() => {})
    }

    window.addEventListener('mousemove', onmove)
    window.addEventListener('mouseup', onup)
  })

  sidebarframe = document.createElement('iframe')
  sidebarframe.src = chrome.runtime.getURL('panel.html')
  Object.assign(sidebarframe.style, {
    width: '100%',
    height: '100%',
    border: '0',
    background: '#000'
  })

  // single rotating arrow toggle button --------------------
  sidebartoggle = document.createElement('button')
  sidebartoggle.setAttribute('data-mushnote-ignore', 'true')
  sidebartoggle.title = 'toggle ai sidebar'
  Object.assign(sidebartoggle.style, {
    position: 'fixed',
    top: '50%',
    right: `${sidebarwidth}px`,
    transform: 'translateY(-50%)',
    zIndex: '2147483647',
    width: '24px',
    height: '44px',
    padding: '0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#111',
    color: '#ccc',
    border: '1px solid #333',
    borderRight: '0',
    borderRadius: '8px 0 0 8px',
    cursor: 'pointer',
    transition: 'right 0.22s ease'
  })

  sidebararrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  sidebararrow.setAttribute('width', '14')
  sidebararrow.setAttribute('height', '14')
  sidebararrow.setAttribute('viewBox', '0 0 24 24')
  sidebararrow.setAttribute('fill', 'none')
  sidebararrow.setAttribute('stroke', 'currentColor')
  sidebararrow.setAttribute('stroke-width', '2.5')
  sidebararrow.setAttribute('stroke-linecap', 'round')
  sidebararrow.setAttribute('stroke-linejoin', 'round')
  sidebararrow.style.transition = 'transform 0.22s ease'
  const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline')
  poly.setAttribute('points', '9 18 15 12 9 6')
  sidebararrow.appendChild(poly)
  sidebartoggle.appendChild(sidebararrow)

  sidebartoggle.addEventListener('click', () => {
    const next = !sidebaropen
    setsidebaropen(next)
    chrome.runtime.sendMessage({ type: 'MUSHNOTE_SET_AI_OPEN', open: next }).catch(() => {})
  })

  sidebarhost.appendChild(resizer)
  sidebarhost.appendChild(sidebarframe)
  document.documentElement.appendChild(sidebarhost)
  document.documentElement.appendChild(sidebartoggle)

  chrome.storage.local.get('sidebarWidth', ({ sidebarWidth }) => {
    if (typeof sidebarWidth === 'number' && sidebarWidth >= 220 && sidebarWidth <= 720) {
      sidebarwidth = sidebarWidth
      if (sidebarhost) sidebarhost.style.width = `${sidebarwidth}px`
      if (sidebaropen) {
        applypagesquish(true)
        if (sidebartoggle) sidebartoggle.style.right = `${sidebarwidth}px`
      }
    }
  })
}

function setsidebaropen(open) {
  sidebaropen = open
  if (!sidebarhost || !sidebartoggle) return
  if (open) {
    sidebarhost.style.pointerEvents = 'auto'
    requestAnimationFrame(() => {
      if (sidebarhost) sidebarhost.style.transform = 'translateX(0)'
    })
    sidebartoggle.style.right = `${sidebarwidth}px`
    if (sidebararrow) sidebararrow.style.transform = 'rotate(0deg)'
  } else {
    sidebarhost.style.transform = 'translateX(100%)'
    sidebarhost.style.pointerEvents = 'none'
    sidebartoggle.style.right = '0px'
    if (sidebararrow) sidebararrow.style.transform = 'rotate(180deg)'
  }
  applypagesquish(open)
}

function removesidebar() {
  if (!sidebarhost) return
  setsidebaropen(false)
  if (sidebartoggle) sidebartoggle.style.display = 'none'
  if (removehosttimer) clearTimeout(removehosttimer)
  removehosttimer = setTimeout(() => {
    sidebarhost?.remove()
    sidebartoggle?.remove()
    sidebarhost = null
    sidebarframe = null
    sidebartoggle = null
    removehosttimer = null
  }, 230)
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'MUSHNOTE_CONV_SYNC' && msg.convId) {
    window.postMessage(msg, '*')
    return
  }
  if (msg?.type === 'MUSHNOTE_ASK_SELECTION' && msg.text) {
    chrome.storage.local.remove('pendingAskSelection').catch(() => {})
    window.postMessage(msg, '*')
    return
  }
  if (window.top !== window || msg?.type !== 'MUSHNOTE_SIDEBAR_SYNC') return
  if (msg.iseditor) {
    window.postMessage({ type: 'MUSHNOTE_AI_STATE_SYNC', open: msg.open, width: msg.width }, '*')
    return
  }
  if (!msg.enabled || !msg.origin) {
    removesidebar()
    return
  }
  if (removehosttimer) {
    clearTimeout(removehosttimer)
    removehosttimer = null
  }
  if (typeof msg.width === 'number' && msg.width >= 220 && msg.width <= 720) {
    sidebarwidth = msg.width
    if (sidebarhost) sidebarhost.style.width = `${sidebarwidth}px`
  }
  ensuresidebardom(msg.origin)
  setsidebaropen(msg.open !== false)
})

if (window.top === window) {
  window.addEventListener('DOMContentLoaded', () => {
    chrome.runtime.sendMessage({ type: 'MUSHNOTE_CHECK_SIDEBAR' }).catch(() => {})
  })
}
