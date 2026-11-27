// mushnote extension background service worker --------------------

const GROUP_TITLE = 'mushnote'
let groupcolor = 'grey'

const VALID_GROUP_COLORS = new Set(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'])

function mapaccenttogroupcolor(accent) {
  if (!accent || typeof accent !== 'string') return 'grey'
  const lower = accent.trim().toLowerCase()
  if (VALID_GROUP_COLORS.has(lower)) return lower
  if (lower.startsWith('#') && lower.length === 7) {
    const r = parseInt(lower.slice(1, 3), 16)
    const g = parseInt(lower.slice(3, 5), 16)
    const b = parseInt(lower.slice(5, 7), 16)
    if (r > 200 && g < 100 && b < 100) return 'red'
    if (r > 200 && g > 120 && b < 80) return 'orange'
    if (r > 200 && g > 200 && b < 100) return 'yellow'
    if (g > r && g > b) return 'green'
    if (g > 150 && b > 150 && r < 100) return 'cyan'
    if (b > r && b > g) return 'blue'
    if (r > 150 && b > 150 && g < 100) return 'purple'
    if (r > 200 && b > 150) return 'pink'
  }
  return 'grey'
}

// find or create the mushnote tab group in a window --------------------
async function ensuremushnotegroup(tabid, windowid) {
  try {
    const groups = await chrome.tabGroups.query({ windowId: windowid, title: GROUP_TITLE })
    if (groups.length > 0) {
      await chrome.tabs.group({ tabIds: [tabid], groupId: groups[0].id })
      return groups[0].id
    }
    const groupid = await chrome.tabs.group({ tabIds: [tabid], createProperties: { windowId: windowid } })
    await chrome.tabGroups.update(groupid, { title: GROUP_TITLE, color: groupcolor })
    return groupid
  } catch {
    return null
  }
}

// toggle or focus mushnote tab on toolbar icon click --------------------
chrome.action.onClicked.addListener(async (activetab) => {
  const tabs = await chrome.tabs.query({ currentWindow: true })
  const mushnotetab = tabs.find(t => t.url && (t.url.includes('/editor') || t.url.includes('mushnote')))

  if (mushnotetab) {
    if (mushnotetab.active) {
      // switch back to another tab if already viewing mushnote --------------------
      const other = tabs.find(t => t.id !== mushnotetab.id)
      if (other) await chrome.tabs.update(other.id, { active: true })
    } else {
      await chrome.tabs.update(mushnotetab.id, { active: true })
      await ensuremushnotegroup(mushnotetab.id, mushnotetab.windowId)
    }
    return
  }

  const { mushnoteOrigin } = await chrome.storage.local.get('mushnoteOrigin')
  if (!mushnoteOrigin) {
    await chrome.action.setPopup({ popup: 'setup.html' })
    await chrome.action.openPopup().catch(() => {})
    return
  }

  // open mushnote in a new tab next to current --------------------
  const created = await chrome.tabs.create({
    url: `${mushnoteOrigin}/editor`,
    active: true,
    index: activetab ? activetab.index + 1 : undefined
  })
  await ensuremushnotegroup(created.id, created.windowId)
})

// wait for a tab to finish loading --------------------
function waitfortabload(tabid, timeoutms = 15000) {
  return new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      chrome.tabs.onUpdated.removeListener(onupdated)
      resolve()
    }, timeoutms)

    function onupdated(id, info) {
      if (id === tabid && info.status === 'complete') {
        if (done) return
        done = true
        clearTimeout(timer)
        chrome.tabs.onUpdated.removeListener(onupdated)
        resolve()
      }
    }

    chrome.tabs.onUpdated.addListener(onupdated)
  })
}

// open background tab, extract content, and optionally keep open --------------------
async function fetchpageinbackground(url, { keepOpen = false, active = false } = {}) {
  const tab = await chrome.tabs.create({ url, active })
  await ensuremushnotegroup(tab.id, tab.windowId)
  await waitfortabload(tab.id)

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        // stepped scroll to trigger intersectionobserver lazy-loading --------------------
        const step = Math.max(300, window.innerHeight || 600)
        const maxh = Math.min(document.body?.scrollHeight || 0, 8000)
        for (let y = 0; y < maxh; y += step) {
          window.scrollTo(0, y)
          await new Promise(r => setTimeout(r, 80))
        }
        window.scrollTo(0, 0)

        const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'NAV', 'FOOTER', 'HEADER', 'ASIDE', 'BUTTON', 'FORM', 'DIALOG'])
        const TRACKING_PARAMS = [
          'sca_esv', 'sxsrf', 'ved', 'fbs', 'ei', 'uact', 'oq', 'gs_lp', 'sclient',
          'sa', 'sstk', 'iflsig', 'source', 'aep', 'ntc', 'cs', 'vsint', 'peek_pws',
          'fbclid', 'gclid'
        ]

        function cleanurl(raw) {
          try {
            const u = new URL(raw)
            for (const p of TRACKING_PARAMS) u.searchParams.delete(p)
            for (const key of Array.from(u.searchParams.keys())) {
              if (key.startsWith('utm_')) u.searchParams.delete(key)
            }
            return u.toString()
          } catch {
            return raw
          }
        }

        function isvisible(el) {
          const style = window.getComputedStyle(el)
          return style.display !== 'none' && style.visibility !== 'hidden'
        }

        const seenlinks = new Set()

        function walk(node) {
          if (node.nodeType === Node.TEXT_NODE) {
            return node.textContent.replace(/\s+/g, ' ')
          }
          if (node.nodeType !== Node.ELEMENT_NODE) return ''
          if (node.hasAttribute('data-mushnote-ignore')) return ''
          if (node.getAttribute('aria-hidden') === 'true' || node.getAttribute('role') === 'navigation') return ''
          if (SKIP_TAGS.has(node.tagName) || !isvisible(node)) return ''

          const tag = node.tagName
          const children = () => Array.from(node.childNodes).map(walk).join('')

          if (/^H[1-6]$/.test(tag)) {
            const level = '#'.repeat(Number(tag[1]))
            const text = children().replace(/\s+/g, ' ').trim()
            return text ? `\n\n${level} ${text}\n\n` : ''
          }
          if (tag === 'A') {
            const text = children().replace(/\s+/g, ' ').trim()
            const href = node.getAttribute('href')
            if (!text) return ''
            if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('data:')) return text
            const cleaned = cleanurl(node.href)
            if (cleaned.length > 300) return text
            const key = `${cleaned}|${text}`
            if (seenlinks.has(key)) return text
            seenlinks.add(key)
            return `[${text}](${cleaned})`
          }
          if (tag === 'LI') {
            const text = children().trim()
            return text ? `\n- ${text}` : ''
          }
          if (tag === 'PRE') {
            const text = (node.innerText || node.textContent || '').trim()
            return text ? `\n\n\`\`\`\n${text}\n\`\`\`\n\n` : ''
          }
          if (tag === 'CODE') {
            const text = (node.textContent || '').trim()
            return text ? `\`${text}\`` : ''
          }
          if (tag === 'P' || tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE' || tag === 'TR') {
            const text = children().trim()
            return text ? `\n\n${text}\n\n` : ''
          }
          if (tag === 'BR') return '\n'

          return children()
        }

        const root = (window.location.hostname.includes('google.') && window.location.pathname === '/search')
          ? (document.querySelector('#search') || document.querySelector('#center_col') || document.body)
          : document.body

        let markdown = walk(root).replace(/\n{3,}/g, '\n\n').trim()
        let truncated = false
        const maxchars = 25000
        if (markdown.length > maxchars) {
          const cut = markdown.lastIndexOf('\n', maxchars)
          markdown = markdown.slice(0, cut > 0 ? cut : maxchars).trim() + '\n\n[truncated]'
          truncated = true
        }

        const iconlink = document.querySelector('link[rel~="icon"]')
        return {
          url: cleanurl(window.location.href),
          title: document.title || '',
          icon: iconlink?.href || `${window.location.origin}/favicon.ico`,
          truncated,
          content: markdown
        }
      }
    })
    const result = results?.[0]?.result || { url, title: '', content: '' }
    return { ...result, tabId: tab.id, keptOpen: Boolean(keepOpen) }
  } finally {
    if (!keepOpen) {
      chrome.tabs.remove(tab.id).catch(() => {})
    }
  }
}

// open or focus a tab in the mushnote group --------------------
async function openmushnotetab({ tabId, url, active = true } = {}) {
  if (tabId) {
    const tab = await chrome.tabs.update(tabId, { active })
    await ensuremushnotegroup(tab.id, tab.windowId)
    return { id: tab.id, url: tab.url || '', title: tab.title || '', active: Boolean(tab.active) }
  }
  if (url) {
    const tab = await chrome.tabs.create({ url, active })
    await ensuremushnotegroup(tab.id, tab.windowId)
    return { id: tab.id, url: tab.url || url, title: tab.title || '', active: Boolean(tab.active) }
  }
  throw new Error('tabId or url required')
}

// close a tab by id --------------------
async function closemushnotetab(tabId) {
  if (!tabId) throw new Error('tabId required')
  await chrome.tabs.remove(tabId)
  return { closed: true, tabId }
}

// list all tabs currently in the mushnote tab group --------------------
async function listmushnotetabs() {
  const groups = await chrome.tabGroups.query({ title: GROUP_TITLE })
  if (groups.length === 0) return []
  const all = []
  for (const g of groups) {
    const tabs = await chrome.tabs.query({ groupId: g.id })
    for (const t of tabs) {
      all.push({
        id: t.id,
        url: t.url || '',
        title: t.title || '',
        active: Boolean(t.active)
      })
    }
  }
  return all
}

// handle messages from content script --------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendresponse) => {
  if (msg?.type === 'MUSHNOTE_FETCH_PAGE' && msg.url) {
    fetchpageinbackground(msg.url, { keepOpen: msg.keepOpen, active: msg.active })
      .then(data => sendresponse({ ok: true, data }))
      .catch(err => sendresponse({ ok: false, error: err?.message || 'fetch failed' }))
    return true
  }

  if (msg?.type === 'MUSHNOTE_LIST_TABS') {
    listmushnotetabs()
      .then(data => sendresponse({ ok: true, data }))
      .catch(err => sendresponse({ ok: false, error: err?.message || 'list tabs failed' }))
    return true
  }

  if (msg?.type === 'MUSHNOTE_OPEN_TAB') {
    openmushnotetab({ tabId: msg.tabId, url: msg.url, active: msg.active })
      .then(data => sendresponse({ ok: true, data }))
      .catch(err => sendresponse({ ok: false, error: err?.message || 'open tab failed' }))
    return true
  }

  if (msg?.type === 'MUSHNOTE_CLOSE_TAB') {
    closemushnotetab(msg.tabId)
      .then(data => sendresponse({ ok: true, data }))
      .catch(err => sendresponse({ ok: false, error: err?.message || 'close tab failed' }))
    return true
  }

  if (msg?.type === 'MUSHNOTE_REGISTER_ORIGIN' && msg.origin) {
    chrome.storage.local.set({ mushnoteOrigin: msg.origin }).catch(() => {})
    chrome.action.setPopup({ popup: '' }).catch(() => {})
    return false
  }

  if (msg?.type === 'MUSHNOTE_SET_GROUP_COLOR') {
    groupcolor = mapaccenttogroupcolor(msg.color)
    chrome.tabGroups.query({ title: GROUP_TITLE }).then((groups) => {
      for (const g of groups) {
        chrome.tabGroups.update(g.id, { color: groupcolor }).catch(() => {})
      }
      sendresponse({ ok: true, color: groupcolor })
    }).catch(() => sendresponse({ ok: false }))
    return true
  }
})
