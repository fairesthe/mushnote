import { state } from '../../core/state.js'
import {
  ed,
  codemirroreditor,
  remotecursormap,
  editorcursors,
  editorcursorscontent,
  editorbodyel
} from '../editorshared.js'
import { ismarkdownfile } from '../noteutils.js'
import { liveflashitems, buildliveflashmark } from '../rich/tiptapplugins.js'
import { resolveauthorcolor } from './flash.js'
import { refreshremoteselections, collabpeerslive } from './collab.js'

function buildlivecursorelement(author, coords) {
  const color = resolveauthorcolor(author)
  const wrap = document.createElement('div')
  wrap.className = 'live-cursor'
  wrap.style.left = `${coords.left}px`
  wrap.style.top = `${coords.top}px`
  wrap.style.setProperty('--cursor-color', color)
  // caret follows the line it sits on so headings get a big one --------------------
  if (coords.height > 0) wrap.style.setProperty('--cursor-height', `${coords.height}px`)

  const caret = document.createElement('div')
  caret.className = 'live-cursor-caret'
  wrap.appendChild(caret)

  const badge = document.createElement('div')
  badge.className = 'live-cursor-badge'
  const img = document.createElement('img')
  img.className = 'live-cursor-avatar'
  const isbot = author === 'ai' || author === state.aiuserid
  const avatar = state.useravatarmap?.[author]
    || (isbot ? state.aiavatar : null)
    || (isbot ? '/resources/icons/general/bot.png' : '/resources/icons/general/unknown-user.png')
  img.src = avatar
  img.alt = author
  img.onerror = () => {
    const fallbacksrc = isbot ? '/resources/icons/general/bot.png' : '/resources/icons/general/unknown-user.png'
    if (img.getAttribute('src') === fallbacksrc) {
      img.remove()
      const fallback = document.createElement('span')
      fallback.className = 'live-cursor-initial'
      fallback.textContent = (author || '?').charAt(0).toUpperCase()
      badge.appendChild(fallback)
      return
    }
    img.src = fallbacksrc
  }
  badge.appendChild(img)
  wrap.appendChild(badge)
  return wrap
}

export function cursorcoordsatpos(pos, side = 1) {
  const scrollroot = editorbodyel()
  if (!scrollroot) return null

  let c = null
  if (ed.tiptapinstance && ismarkdownfile(state.activenoteid)) {
    const view = ed.tiptapinstance.view
    c = view.coordsAtPos(Math.max(1, Math.min(pos, view.state.doc.content.size)), side)
  } else if (ed.cmview && codemirroreditor) {
    c = ed.cmview.coordsAtPos(Math.max(0, Math.min(pos, ed.cmview.state.doc.length)), side)
  }
  if (!c) return null
  const rootrect = scrollroot.getBoundingClientRect()
  // content coords so marks sit correctly inside the scrollable editor body --------------------
  return {
    left: c.left - rootrect.left + scrollroot.scrollLeft,
    top: c.top - rootrect.top + scrollroot.scrollTop,
    height: c.bottom - c.top
  }
}

// last flash end per author so their cursor badge crossfades back in as the flash avatar fades out --------------------
const flashendmap = new Map()
// the flash avatar eases out early so the cursor one has to start coming back well before the flash ends --------------------
const badgereturnlead = 1100

export function refreshallremotecursors() {
  if (!editorcursors || !editorcursorscontent) return
  const flashes = liveflashitems()
  const body = editorbodyel()
  if (body) {
    // stretch overlay to full scroll height so content-space coords stay on screen --------------------
    editorcursors.style.height = `${Math.max(body.scrollHeight, body.clientHeight)}px`
  }
  editorcursors.classList.toggle('hidden', remotecursormap.size === 0 && flashes.length === 0)
  editorcursorscontent.innerHTML = ''

  for (const item of flashes) {
    flashendmap.set(item.author, Math.max(flashendmap.get(item.author) || 0, item.expire))
    const mark = buildliveflashmark(item)
    if (mark) editorcursorscontent.appendChild(mark)
  }

  const now = Date.now()
  for (const [author, data] of remotecursormap.entries()) {
    const pos = data.head ?? data.to ?? data.from ?? 0
    const coords = cursorcoordsatpos(pos)
    if (!coords) continue
    const el = buildlivecursorelement(author, coords)
    // flash mark already has their avatar, hide the cursor badge until the flash ends --------------------
    const flashend = flashendmap.get(author) || 0
    if (flashend > now) {
      el.classList.add('is-flashing')
      const returndelay = flashend - badgereturnlead - now
      if (returndelay <= 0) el.classList.add('is-badge-returning')
      else el.style.setProperty('--badge-return-delay', `${returndelay}ms`)
    }
    editorcursorscontent.appendChild(el)
  }
  refreshremoteselections()
}

export function clearallremotecursors() {
  remotecursormap.clear()
  if (editorcursors) editorcursors.classList.add('hidden')
  if (editorcursorscontent) editorcursorscontent.innerHTML = ''
  refreshremoteselections()
}

export function broadcastcursorposition(head, anchor) {
  if (!collabpeerslive()) return
  ed.collabprovider.sendcursor({
    head,
    anchor,
    from: Math.min(head, anchor),
    to: Math.max(head, anchor)
  })
}

// remeasure editor for reading scale updates --------------------
export function refreshreadingscale() {
  if (ed.cmview) {
    ed.cmview.requestMeasure()
  }
}


// initialize editor note link click and contextmenu listeners on load --------------------
export function bindeditorcursorscroll() {
  const body = editorbodyel()
  if (!body || body.dataset.cursorscrollbound) return
  body.dataset.cursorscrollbound = '1'
  body.addEventListener('scroll', () => refreshallremotecursors(), { passive: true })
}
