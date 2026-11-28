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
async function ensuremushnotegroup(tabid, windowid, retries = 5) {
  try {
    const tab = await chrome.tabs.get(tabid).catch(() => null)
    if (!tab) return null
    const groups = await chrome.tabGroups.query({ windowId: tab.windowId, title: GROUP_TITLE })
    if (groups.length > 0) {
      if (tab.groupId === groups[0].id) return groups[0].id
      await chrome.tabs.group({ tabIds: [tabid], groupId: groups[0].id })
      return groups[0].id
    }
    const groupid = await chrome.tabs.group({ tabIds: [tabid], createProperties: { windowId: tab.windowId } })
    await chrome.tabGroups.update(groupid, { title: GROUP_TITLE, color: groupcolor })
    return groupid
  } catch {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 250))
      return ensuremushnotegroup(tabid, windowid, retries - 1)
    }
    return null
  }
}

// sync injected ai sidebar on external tabs in the mushnote group --------------------
async function updatesidepanelfortab(tabid, url) {
  const { mushnoteOrigin, aiDrawerOpen, sidebarWidth, activeConvId } = await chrome.storage.local.get([
    'mushnoteOrigin', 'aiDrawerOpen', 'sidebarWidth', 'activeConvId'
  ])
  const iseditor = Boolean(mushnoteOrigin && url && url.startsWith(`${mushnoteOrigin}/editor`))
  const tab = await chrome.tabs.get(tabid).catch(() => null)
  const groups = tab ? await chrome.tabGroups.query({ windowId: tab.windowId, title: GROUP_TITLE }).catch(() => []) : []
  const inmushnote = Boolean(tab && groups.length > 0 && tab.groupId === groups[0].id)

  if (chrome.contextMenus && tab?.active) {
    chrome.contextMenus.update('mushnote-ask-ai', { visible: inmushnote }).catch(() => {})
  }

  chrome.tabs.sendMessage(tabid, {
    type: 'MUSHNOTE_SIDEBAR_SYNC',
    enabled: Boolean(mushnoteOrigin && inmushnote && !iseditor),
    iseditor,
    open: aiDrawerOpen !== false,
    width: typeof sidebarWidth === 'number' ? sidebarWidth : 380,
    origin: mushnoteOrigin || ''
  }).catch(() => {})

  if (inmushnote && activeConvId) {
    chrome.tabs.sendMessage(tabid, { type: 'MUSHNOTE_CONV_SYNC', convId: activeConvId }).catch(() => {})
  }
}

chrome.tabs.onUpdated.addListener(async (tabid, changeinfo, tab) => {
  const url = changeinfo.url || tab?.url
  if (!url && changeinfo.groupId === undefined) return
  const { mushnoteOrigin } = await chrome.storage.local.get('mushnoteOrigin')
  if (mushnoteOrigin && url && url.startsWith(`${mushnoteOrigin}/editor`)) {
    await ensuremushnotegroup(tabid, tab.windowId)
  }
  if (changeinfo.groupId !== undefined || changeinfo.url || changeinfo.status === 'complete') {
    updatesidepanelfortab(tabid, url)
  }
})

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  if (tab) updatesidepanelfortab(tabId, tab.url)
})

chrome.tabs.onAttached.addListener(async (tabId, { newWindowId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  const { mushnoteOrigin } = await chrome.storage.local.get('mushnoteOrigin')
  if (tab?.url && mushnoteOrigin && tab.url.startsWith(`${mushnoteOrigin}/editor`)) {
    await ensuremushnotegroup(tabId, newWindowId)
  }
  if (tab) updatesidepanelfortab(tabId, tab.url)
})

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

// open background tab (or reuse existing mushnote tab), extract content, and optionally keep open --------------------
async function fetchpageinbackground(url, { keepOpen = false, active = false, tabId = null } = {}) {
  let reused = false
  let tab = null
  if (tabId) {
    tab = await chrome.tabs.get(tabId)
    reused = true
  } else {
    const existing = (await listmushnotetabs()).find((t) => {
      try {
        const a = new URL(t.url)
        const b = new URL(url)
        return a.origin === b.origin && a.pathname.replace(/\/+$/, '') === b.pathname.replace(/\/+$/, '') && a.search === b.search
      } catch {
        return t.url === url
      }
    })
    reused = Boolean(existing)
    tab = reused
      ? await chrome.tabs.get(existing.id)
      : await chrome.tabs.create({ url, active })
  }

  if (!reused) {
    await ensuremushnotegroup(tab.id, tab.windowId)
    await waitfortabload(tab.id)
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      args: [reused],
      func: async (isreused) => {
        const istop = window.top === window
        const originaltitle = document.title || ''
        if (istop && !isreused && !originaltitle.startsWith('READ: ')) {
          document.title = `READ: ${originaltitle}`
        }
        // only scroll if page looks sparse/lazy-loaded --------------------
        if ((document.body?.innerText || '').trim().length < 400) {
          const step = Math.max(500, window.innerHeight || 600)
          for (let i = 1; i <= 3; i++) {
            window.scrollTo(0, step * i)
            await new Promise(r => setTimeout(r, 40))
          }
          window.scrollTo(0, 0)
        }

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

          if (tag === 'IMG') {
            const src = node.currentSrc || node.getAttribute('src') || ''
            if (!src || src.startsWith('data:')) return ''
            const rect = node.getBoundingClientRect()
            if ((rect.width > 0 && rect.width <= 24) || (rect.height > 0 && rect.height <= 24)) return ''
            const cleaned = cleanurl(node.src || src)
            if (cleaned.length > 300) return ''
            const alt = (node.getAttribute('alt') || '').replace(/\s+/g, ' ').trim() || 'image'
            return `![${alt}](${cleaned})`
          }
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
          title: originaltitle,
          icon: iconlink?.href || `${window.location.origin}/favicon.ico`,
          truncated,
          content: markdown
        }
      }
    })
    const main = results?.find(r => r.frameId === 0)?.result || results?.[0]?.result || { url, title: '', content: '' }
    const widgets = (results || [])
      .filter(r => r.frameId !== 0 && r.result?.content && !String(r.result.url || '').startsWith('chrome-extension://'))
      .map(r => r.result)

    let combined = main.content || ''
    if (widgets.length > 0) {
      const widgetblocks = widgets.map(w => `### Widget: ${w.title || w.url}\n\n${w.content}`)
      combined = `${combined}\n\n---\n\n## Embedded Widgets\n\n${widgetblocks.join('\n\n---\n\n')}`.trim()
      if (combined.length > 25000) {
        const cut = combined.lastIndexOf('\n', 25000)
        combined = combined.slice(0, cut > 0 ? cut : 25000).trim() + '\n\n[truncated]'
        main.truncated = true
      }
    }
    return { ...main, content: combined, tabId: tab.id, keptOpen: Boolean(keepOpen || reused) }
  } finally {
    if (!keepOpen && !reused) {
      chrome.tabs.remove(tab.id).catch(() => {})
    }
  }
}

// open, navigate, or focus a tab in the mushnote group --------------------
async function openmushnotetab({ tabId, url, active = true } = {}) {
  if (tabId) {
    const updateprops = url ? { url, active } : { active }
    const tab = await chrome.tabs.update(tabId, updateprops)
    await ensuremushnotegroup(tab.id, tab.windowId)
    await updatesidepanelfortab(tab.id, tab.url || url)
    return { id: tab.id, url: tab.url || url || '', title: tab.title || '', active: Boolean(tab.active) }
  }
  if (url) {
    const tab = await chrome.tabs.create({ url, active })
    await ensuremushnotegroup(tab.id, tab.windowId)
    await updatesidepanelfortab(tab.id, tab.url || url)
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

// context menu: ask <ai name> on highlighted text --------------------
function ensurecontextmenu(ainame = 'AI') {
  if (!chrome.contextMenus) return
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'mushnote-ask-ai',
      title: `Ask ${ainame}`,
      contexts: ['selection']
    })
  })
}

chrome.runtime.onInstalled.addListener(async () => {
  const { aiName } = await chrome.storage.local.get('aiName')
  ensurecontextmenu(aiName || 'AI')
})

if (chrome.contextMenus) {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== 'mushnote-ask-ai' || !info.selectionText || !tab?.id) return
    const payload = {
      type: 'MUSHNOTE_ASK_SELECTION',
      text: info.selectionText,
      url: tab.url || '',
      title: tab.title || ''
    }
    await chrome.storage.local.set({ aiDrawerOpen: true, pendingAskSelection: payload }).catch(() => {})
    await ensuremushnotegroup(tab.id, tab.windowId)
    await updatesidepanelfortab(tab.id, tab.url)
    chrome.tabs.sendMessage(tab.id, payload).catch(() => {})
  })
}

// handle messages from content script --------------------
chrome.runtime.onMessage.addListener((msg, sender, sendresponse) => {
  if (msg?.type === 'MUSHNOTE_FETCH_PAGE' && (msg.url || msg.tabId)) {
    fetchpageinbackground(msg.url, { keepOpen: msg.keepOpen, active: msg.active, tabId: msg.tabId })
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
    if (sender?.tab?.id && sender.tab.url?.startsWith(`${msg.origin}/editor`)) {
      ensuremushnotegroup(sender.tab.id, sender.tab.windowId)
    } else if (sender?.tab?.id) {
      updatesidepanelfortab(sender.tab.id, sender.tab.url)
    }
    return false
  }

  if (msg?.type === 'MUSHNOTE_SET_AI_OPEN') {
    const open = Boolean(msg.open)
    chrome.storage.local.set({ aiDrawerOpen: open }).catch(() => {})
    listmushnotetabs().then((tabs) => {
      for (const t of tabs) updatesidepanelfortab(t.id, t.url)
    }).catch(() => {})
    return false
  }

  if (msg?.type === 'MUSHNOTE_SET_AI_WIDTH' && typeof msg.width === 'number') {
    chrome.storage.local.set({ sidebarWidth: msg.width }).catch(() => {})
    listmushnotetabs().then((tabs) => {
      for (const t of tabs) {
        if (t.id !== sender?.tab?.id) updatesidepanelfortab(t.id, t.url)
      }
    }).catch(() => {})
    return false
  }

  if (msg?.type === 'MUSHNOTE_CONV_UPDATED' && msg.convId) {
    chrome.storage.local.set({ activeConvId: msg.convId }).catch(() => {})
    listmushnotetabs().then((tabs) => {
      for (const t of tabs) {
        if (t.id !== sender?.tab?.id) {
          chrome.tabs.sendMessage(t.id, { type: 'MUSHNOTE_CONV_SYNC', convId: msg.convId, force: true }).catch(() => {})
        }
      }
    }).catch(() => {})
    return false
  }

  if (msg?.type === 'MUSHNOTE_SET_AI_NAME' && msg.name) {
    chrome.storage.local.set({ aiName: msg.name }).catch(() => {})
    ensurecontextmenu(msg.name)
    return false
  }

  if (msg?.type === 'MUSHNOTE_GET_PANEL_CONFIG') {
    chrome.storage.local.get(['mushnoteOrigin', 'activeConvId']).then(async ({ mushnoteOrigin, activeConvId }) => {
      if (!mushnoteOrigin) return sendresponse({ origin: '', token: '', convId: '' })
      const cookie = chrome.cookies
        ? await chrome.cookies.get({ url: mushnoteOrigin, name: 'mushnote_session' }).catch(() => null)
        : null
      sendresponse({ origin: mushnoteOrigin, token: cookie?.value || '', convId: activeConvId || '' })
    }).catch(() => sendresponse({ origin: '', token: '', convId: '' }))
    return true
  }

  if (msg?.type === 'MUSHNOTE_CHECK_SIDEBAR' && sender?.tab?.id) {
    updatesidepanelfortab(sender.tab.id, sender.tab.url)
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
