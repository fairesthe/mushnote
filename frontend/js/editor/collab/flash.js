import { hextorgba } from '../../core/api.js'
import { state } from '../../core/state.js'
import { Decoration, DecorationSet, CMDecoration } from '../rich/tiptap.bundle.js'
import {
  ed,
  noteeditor,
  editorbackdrop,
  setflasheffect,
  clearflasheffect,
  flashpluginkey
} from '../editorshared.js'
import { ismarkdownfile } from '../noteutils.js'
import { docchangespan, liveflashpluginkey, flashstyle } from '../rich/tiptapplugins.js'
import { CMAvatarWidget, CMDeleteMarkerWidget, prunecmliveflasheffect } from '../plain/cmplugins.js'

// resolve user highlight color with external gray fallback --------------------
export function resolveauthorcolor(author) {
  if (!author || author === 'external') return '#737373'
  if (state.usercolormap && state.usercolormap[author]) {
    return state.usercolormap[author]
  }
  if (author === 'ai' || author === state.aiuserid) {
    return state.usercolormap?.[author] || state.usercolormap?.[state.aiuserid] || '#737373'
  }
  return '#737373'
}

// create user avatar badge for flash highlights --------------------
export function createavatarbadge(author, usercolor, opts = {}) {
  const isexternal = !author || author === 'external'
  const isbot = author === 'ai' || author === state.aiuserid
  const known = state.useravatarmap?.[author]
    || (isbot ? state.aiavatar : null)
  const useravatar = known
    || (isexternal ? '/resources/icons/general/external.png' : null)
    || (isbot ? '/resources/icons/general/bot.png' : null)
    || '/resources/icons/general/unknown-user.png'

  const anchor = document.createElement('span')
  anchor.className = 'edit-user-anchor'

  const badge = document.createElement('span')
  badge.className = opts.live ? 'edit-user-badge is-live' : 'edit-user-badge'
  badge.title = isexternal ? 'external edit' : author
  badge.style.setProperty('--flash-user-border', usercolor)
  badge.style.setProperty('--flash-user-glow', hextorgba(usercolor, 0.45))

  const img = document.createElement('img')
  img.src = useravatar
  img.alt = isexternal ? 'external' : author
  img.className = 'edit-user-img'

  const fallback = document.createElement('span')
  fallback.className = 'edit-user-fallback'
  fallback.textContent = isexternal ? 'E' : (author.charAt(0) || '?').toUpperCase()
  fallback.style.display = 'none'

  img.onerror = () => {
    img.style.display = 'none'
    fallback.style.display = 'block'
  }

  badge.appendChild(img)
  badge.appendChild(fallback)
  anchor.appendChild(badge)
  return anchor
}

// create deletion marker for removed text in place --------------------
export function createdeletemarker(author, usercolor, deletedtext = '') {
  const marker = document.createElement('span')
  marker.className = 'edit-delete-marker'
  marker.style.setProperty('--flash-user-border', hextorgba(usercolor, 0.75))
  marker.style.setProperty('--flash-user-glow', hextorgba(usercolor, 0.35))
  marker.style.setProperty('--flash-user-bg', hextorgba(usercolor, 0.28))

  // collapse any newlines so deletion never creates vertical ghost lines --------------------
  const cleantext = (deletedtext || '').replace(/\r?\n+/g, ' ').trim()
  if (cleantext.length > 0) {
    const textspan = document.createElement('span')
    textspan.className = 'edit-delete-text'
    textspan.textContent = cleantext.length > 30 ? `${cleantext.slice(0, 30)}...` : cleantext
    marker.appendChild(textspan)
  } else {
    marker.classList.add('is-empty')
  }

  if (author) {
    const badge = createavatarbadge(author, usercolor)
    marker.appendChild(badge)
  }

  return marker
}

// render flash highlight in codemirror --------------------
export function rendercmflashhighlight(oldtext = '', newtext = '', edits = [], usercolor = '#3b82f6', author = '', opts = {}) {
  const persistent = opts.persistent === true
  if (!ed.cmview) return
  if (ed.cmflashtimeout) {
    clearTimeout(ed.cmflashtimeout)
    ed.cmflashtimeout = null
  }

  // calculate diff range if not provided --------------------
  let diffstart = 0
  while (diffstart < oldtext.length && diffstart < newtext.length && oldtext[diffstart] === newtext[diffstart]) {
    diffstart++
  }

  let oldend = oldtext.length
  let newend = newtext.length
  while (oldend > diffstart && newend > diffstart && oldtext[oldend - 1] === newtext[newend - 1]) {
    oldend--
    newend--
  }

  const isdeletion = oldend > diffstart && newend <= diffstart
  const deletedtext = isdeletion ? oldtext.slice(diffstart, oldend) : ''

  let minstart = diffstart
  let maxend = newend

  if (Array.isArray(edits) && edits.length > 0) {
    for (const edit of edits) {
      const from = Math.max(0, Math.min(edit.from || 0, newtext.length))
      const to = Math.max(from, Math.min(edit.to || (edit.from + 1), newtext.length))
      if (from < minstart) minstart = from
      if (to > maxend) maxend = to
    }
  }

  const doc = ed.cmview.state.doc
  const safe_from = Math.max(0, Math.min(minstart, doc.length))
  const safe_to = Math.max(safe_from, Math.min(maxend, doc.length))

  const decos = []
  if (isdeletion) {
    decos.push(CMDecoration.widget({
      widget: new CMDeleteMarkerWidget(author, usercolor, deletedtext),
      side: 1
    }).range(safe_from))
  } else if (safe_to > safe_from) {
    const style = `--flash-user-bg: ${hextorgba(usercolor, 0.28)}; --flash-user-border: ${hextorgba(usercolor, 0.75)}; --flash-user-glow: ${hextorgba(usercolor, 0.35)};`
    decos.push(CMDecoration.mark({
      class: 'edit-flash',
      attributes: { style }
    }).range(safe_from, safe_to))

    if (author) {
      decos.push(CMDecoration.widget({
        widget: new CMAvatarWidget(author, usercolor),
        side: 1
      }).range(safe_to))
    }
  }

  if (decos.length === 0) return

  ed.cmview.dispatch({
    effects: setflasheffect.of(CMDecoration.set(decos, true))
  })

  if (!persistent) {
    ed.cmflashtimeout = setTimeout(() => {
      if (ed.cmview) {
        ed.cmview.dispatch({ effects: clearflasheffect.of(null) })
      }
      ed.cmflashtimeout = null
    }, 2250)
  }
}

// flash whole code file for brand new file creation --------------------
export function flashwholecmnote(author, usercolor, opts = {}) {
  const persistent = opts.persistent === true
  if (!ed.cmview) return
  const doc = ed.cmview.state.doc
  if (doc.length === 0) return

  const style = `--flash-user-bg: ${hextorgba(usercolor, 0.28)}; --flash-user-border: ${hextorgba(usercolor, 0.75)}; --flash-user-glow: ${hextorgba(usercolor, 0.35)};`
  const decos = [
    CMDecoration.mark({
      class: 'edit-flash',
      attributes: { style }
    }).range(0, doc.length)
  ]

  if (author) {
    decos.push(CMDecoration.widget({
      widget: new CMAvatarWidget(author, usercolor),
      side: 1
    }).range(doc.length))
  }

  ed.cmview.dispatch({
    effects: setflasheffect.of(CMDecoration.set(decos, true))
  })

  if (!persistent) {
    if (ed.cmflashtimeout) clearTimeout(ed.cmflashtimeout)
    ed.cmflashtimeout = setTimeout(() => {
      if (ed.cmview) {
        ed.cmview.dispatch({ effects: clearflasheffect.of(null) })
      }
      ed.cmflashtimeout = null
    }, 2250)
  }
}

// clear live and pinned revision flash marks --------------------
export function cleareditorflashhighlights() {
  if (ed.flashtimeout) {
    clearTimeout(ed.flashtimeout)
    ed.flashtimeout = null
  }
  if (ed.cmflashtimeout) {
    clearTimeout(ed.cmflashtimeout)
    ed.cmflashtimeout = null
  }
  if (ed.tiptapinstance) {
    try {
      const cleartr = ed.tiptapinstance.state.tr
        .setMeta(flashpluginkey, { action: 'clear' })
        .setMeta(liveflashpluginkey, { action: 'clear' })
      ed.tiptapinstance.view.dispatch(cleartr)
    } catch {}
  }
  if (ed.cmview) {
    try {
      ed.cmview.dispatch({ effects: [clearflasheffect.of(null), prunecmliveflasheffect.of('all')] })
    } catch {}
  }
}

// highlight entire markdown note when viewed for first time if created by someone else --------------------
export function flashwholenote(author = 'ai', usercolor = '#3b82f6', opts = {}) {
  const persistent = opts.persistent === true
  if (!ed.tiptapinstance) return
  const doc = ed.tiptapinstance.state.doc
  if (!doc || doc.content.size <= 0) return

  const style = `--flash-user-bg: ${hextorgba(usercolor, 0.28)}; --flash-user-border: ${hextorgba(usercolor, 0.75)}; --flash-user-glow: ${hextorgba(usercolor, 0.35)};`
  const decos = []

  let textfound = false
  doc.nodesBetween(0, doc.content.size, (node, pos) => {
    if (node.isText) {
      textfound = true
      decos.push(Decoration.inline(pos, pos + node.nodeSize, { class: 'edit-flash', style }))
    }
  })

  if (!textfound) {
    doc.nodesBetween(0, doc.content.size, (node, pos) => {
      if (node.isBlock) {
        decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'edit-flash', style }))
      }
    })
  }

  // attach creator avatar badge at the bottom right end of note --------------------
  if (author) {
    const badgepos = Math.max(0, doc.content.size)
    decos.push(Decoration.widget(badgepos, () => createavatarbadge(author, usercolor), { side: 1 }))
  }

  if (decos.length > 0) {
    try {
      const decoset = DecorationSet.create(doc, decos)
      const tr = ed.tiptapinstance.state.tr.setMeta(flashpluginkey, { action: 'set', decorations: decoset })
      ed.tiptapinstance.view.dispatch(tr)

      if (!persistent) {
        if (ed.flashtimeout) clearTimeout(ed.flashtimeout)
        ed.flashtimeout = setTimeout(() => {
          if (!ed.tiptapinstance) return
          try {
            const cleartr = ed.tiptapinstance.state.tr.setMeta(flashpluginkey, { action: 'clear' })
            ed.tiptapinstance.view.dispatch(cleartr)
          } catch {}
          ed.flashtimeout = null
        }, 2500)
      }
    } catch (err) {
      console.warn('failed to apply whole note flash', err)
    }
  }
}

// highlight entire plain text note for someone elses note --------------------
export function flashwholeplainnote(text, author = 'ai', usercolor = '#3b82f6') {
  if (!editorbackdrop || !noteeditor || !text) return
  renderplainflashhighlight('', text, [{ from: 0, to: text.length }], usercolor, author)
}

// render flash highlight behind text in editor backdrop for plain text files --------------------
export function renderplainflashhighlight(oldtext, newtext, edits = [], usercolor = '#3b82f6', author = '') {
  if (!editorbackdrop || !noteeditor) return

  let minstart = newtext.length
  let maxend = 0

  let diffstart = 0
  while (diffstart < oldtext.length && diffstart < newtext.length && oldtext[diffstart] === newtext[diffstart]) {
    diffstart++
  }

  let oldend = oldtext.length
  let newend = newtext.length
  while (oldend > diffstart && newend > diffstart && oldtext[oldend - 1] === newtext[newend - 1]) {
    oldend--
    newend--
  }

  const isdeletion = oldend > diffstart && newend <= diffstart
  const deletedtext = isdeletion ? oldtext.slice(diffstart, oldend) : ''

  if (newend > diffstart) {
    minstart = diffstart
    maxend = newend
  } else if (Array.isArray(edits) && edits.length > 0) {
    for (const edit of edits) {
      const from = Math.max(0, Math.min(edit.from || 0, newtext.length))
      const to = Math.max(from, Math.min(edit.to || edit.from + 1, newtext.length))
      if (from < minstart) minstart = from
      if (to > maxend) maxend = to
    }
  }

  const bgcolor = hextorgba(usercolor, 0.28)
  const bordercolor = hextorgba(usercolor, 0.75)
  const glowcolor = hextorgba(usercolor, 0.35)

  editorbackdrop.style.setProperty('--flash-user-bg', bgcolor)
  editorbackdrop.style.setProperty('--flash-user-border', bordercolor)
  editorbackdrop.style.setProperty('--flash-user-glow', glowcolor)

  editorbackdrop.innerHTML = ''

  if (isdeletion) {
    const before = newtext.slice(0, diffstart)
    const after = newtext.slice(diffstart)
    if (before) {
      const beforespan = document.createElement('span')
      beforespan.textContent = before
      editorbackdrop.appendChild(beforespan)
    }
    const marker = createdeletemarker(author, usercolor, deletedtext)
    editorbackdrop.appendChild(marker)
    if (after) {
      const afterspan = document.createElement('span')
      afterspan.textContent = after
      editorbackdrop.appendChild(afterspan)
    }
  } else if (minstart < maxend && maxend <= newtext.length) {
    const before = newtext.slice(0, minstart)
    const highlighted = newtext.slice(minstart, maxend)
    const after = newtext.slice(maxend)

    if (before) {
      const beforespan = document.createElement('span')
      beforespan.textContent = before
      editorbackdrop.appendChild(beforespan)
    }

    let lastflashspan = null
    const lines = highlighted.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.length > 0) {
        const flashspan = document.createElement('span')
        flashspan.className = 'edit-flash'
        flashspan.textContent = line
        editorbackdrop.appendChild(flashspan)
        lastflashspan = flashspan
      }
      if (i < lines.length - 1) {
        editorbackdrop.appendChild(document.createTextNode('\n'))
      }
    }

    if (lastflashspan && author) {
      const badge = createavatarbadge(author, usercolor)
      lastflashspan.appendChild(badge)
    }

    if (after) {
      const afterspan = document.createElement('span')
      afterspan.textContent = after
      editorbackdrop.appendChild(afterspan)
    }
  }

  editorbackdrop.scrollTop = noteeditor.scrollTop
  editorbackdrop.scrollLeft = noteeditor.scrollLeft

  if (ed.plainflashtimeout) clearTimeout(ed.plainflashtimeout)
  ed.plainflashtimeout = setTimeout(() => {
    if (editorbackdrop) editorbackdrop.innerHTML = ''
    ed.plainflashtimeout = null
  }, 2250)
}

// render flash highlight on editor for additions and deletions --------------------
export function renderflashhighlight(olddoc, newdoc, edits = [], usercolor = '#3b82f6', author = '', opts = {}) {
  const persistent = opts.persistent === true
  if (!ismarkdownfile(state.activenoteid)) {
    const oldtext = typeof olddoc === 'string' ? olddoc : (ed.cmview ? ed.cmview.state.doc.toString() : '')
    const newtext = typeof newdoc === 'string' ? newdoc : (ed.cmview ? ed.cmview.state.doc.toString() : '')
    rendercmflashhighlight(oldtext, newtext, edits, usercolor, author)
    return
  }

  if (!ed.tiptapinstance) return
  const doc = newdoc || ed.tiptapinstance.state.doc
  if (!doc) return

  if (ed.flashtimeout) {
    clearTimeout(ed.flashtimeout)
    ed.flashtimeout = null
  }

  const decos = []
  const style = flashstyle(usercolor)

  const span = olddoc?.content && doc.content ? docchangespan(olddoc, doc) : null

  if (span) {
    const diffstart = span.start
    const endinnew = span.endb
    const endinold = span.enda

    // pure deletion without replacement --------------------
    if (endinold > diffstart && endinnew <= diffstart) {
      let deletedtext = ''
      if (olddoc && olddoc.content) {
        try {
          deletedtext = olddoc.textBetween(diffstart, Math.min(endinold, olddoc.content.size), ' ')
        } catch {}
      }
      const delpos = Math.max(0, Math.min(diffstart, doc.content.size))
      decos.push(Decoration.widget(delpos, () => createdeletemarker(author, usercolor, deletedtext), { side: 1, stopEvent: () => true }))
    }

    if (endinnew > diffstart) {
      // addition --------------------
      const from = diffstart
      const to = Math.min(endinnew, doc.content.size)

      doc.nodesBetween(from, to, (node, pos) => {
        if (node.isText) {
          const nfrom = Math.max(from, pos)
          const nto = Math.min(to, pos + node.nodeSize)
          if (nfrom < nto) {
            decos.push(Decoration.inline(nfrom, nto, {
              class: 'edit-flash',
              style
            }))
          }
        }
      })

      if (decos.length === 0) {
        doc.nodesBetween(from, to, (node, pos) => {
          if (node.isBlock) {
            decos.push(Decoration.node(pos, pos + node.nodeSize, {
              class: 'edit-flash',
              style
            }))
          }
        })
      }

      if (author) {
        const badgepos = Math.min(to, doc.content.size)
        decos.push(Decoration.widget(badgepos, () => createavatarbadge(author, usercolor), { side: 1 }))
      }
    }
  } else if (Array.isArray(edits) && edits.length > 0) {
    // fallback to delta edits if findDiff did not produce a range --------------------
    for (const edit of edits) {
      if (edit.type === 'delete') {
        const delpos = Math.max(0, Math.min(edit.from || 0, doc.content.size))
        const deltext = edit.text || ''
        decos.push(Decoration.widget(delpos, () => createdeletemarker(author, usercolor, deltext), { side: 1, stopEvent: () => true }))
      } else if (edit.type === 'insert') {
        const from = Math.max(0, Math.min(edit.from || 0, doc.content.size))
        const to = Math.max(from, Math.min(edit.to || (from + (edit.text?.length || 1)), doc.content.size))
        doc.nodesBetween(from, to, (node, pos) => {
          if (node.isText) {
            const nfrom = Math.max(from, pos)
            const nto = Math.min(to, pos + node.nodeSize)
            if (nfrom < nto) {
              decos.push(Decoration.inline(nfrom, nto, { class: 'edit-flash', style }))
            }
          }
        })
        if (author) {
          decos.push(Decoration.widget(to, () => createavatarbadge(author, usercolor), { side: 1 }))
        }
      }
    }
  }

  if (decos.length === 0) return

  try {
    const decoset = DecorationSet.create(doc, decos)
    const tr = ed.tiptapinstance.state.tr.setMeta(flashpluginkey, { action: 'set', decorations: decoset })
    ed.tiptapinstance.view.dispatch(tr)

    if (!persistent) {
      ed.flashtimeout = setTimeout(() => {
        if (!ed.tiptapinstance) return
        try {
          const cleartr = ed.tiptapinstance.state.tr.setMeta(flashpluginkey, { action: 'clear' })
          ed.tiptapinstance.view.dispatch(cleartr)
        } catch {}
        ed.flashtimeout = null
      }, 2250)
    }
  } catch (err) {
    console.warn('failed to apply flash decoration', err)
  }
}
