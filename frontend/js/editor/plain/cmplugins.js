import {
  CMEditorView,
  CMStateField,
  CMStateEffect,
  CMDecoration,
  CMWidgetType
} from '../rich/tiptap.bundle.js'
import {
  ed,
  setflasheffect,
  clearflasheffect,
  setremoteselectioneffect,
  setpineffect,
  clearpineffect
} from '../editorshared.js'
import { liveflashlife, liveflashauthor, liveflashanimstyle } from '../rich/tiptapplugins.js'
import { resolveauthorcolor, createavatarbadge, createdeletemarker } from '../collab/flash.js'

// codemirror avatar badge widget for flash highlights --------------------
export class CMAvatarWidget extends CMWidgetType {
  constructor(author, usercolor) {
    super()
    this.author = author
    this.usercolor = usercolor
  }

  toDOM() {
    return createavatarbadge(this.author, this.usercolor)
  }

  eq(other) {
    return other.author === this.author && other.usercolor === this.usercolor
  }

  ignoreEvent() {
    return true
  }
}

// codemirror delete marker widget for removed text --------------------
export class CMDeleteMarkerWidget extends CMWidgetType {
  constructor(author, usercolor, text) {
    super()
    this.author = author
    this.usercolor = usercolor
    this.text = text
  }

  toDOM() {
    return createdeletemarker(this.author, this.usercolor, this.text)
  }

  eq(other) {
    return other.author === this.author && other.usercolor === this.usercolor && other.text === this.text
  }

  ignoreEvent() {
    return true
  }
}

// codemirror state field tracking active flash decorations --------------------
export const cmflashfield = CMStateField.define({
  create() {
    return CMDecoration.none
  },
  update(decos, tr) {
    decos = decos.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(setflasheffect)) {
        decos = effect.value
      } else if (effect.is(clearflasheffect)) {
        decos = CMDecoration.none
      }
    }
    return decos
  },
  provide: f => CMEditorView.decorations.from(f)
})

export const cmpinfield = CMStateField.define({
  create() {
    return CMDecoration.none
  },
  update(decos, tr) {
    decos = decos.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(setpineffect)) {
        decos = effect.value
      } else if (effect.is(clearpineffect)) {
        decos = CMDecoration.none
      }
    }
    return decos
  },
  provide: f => CMEditorView.decorations.from(f)
})

export const cmremoteselectionfield = CMStateField.define({
  create() {
    return CMDecoration.none
  },
  update(decos, tr) {
    decos = decos.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(setremoteselectioneffect)) {
        decos = effect.value
      }
    }
    return decos
  },
  provide: f => CMEditorView.decorations.from(f)
})

// live remote typing in code files, codemirror changes are exact so this just maps --------------------
const addcmliveflasheffect = CMStateEffect.define()
export const prunecmliveflasheffect = CMStateEffect.define()
let cmliveflashtimer = null

function buildcmliveflashdecos(doc, items) {
  const decos = []
  for (const item of items) {
    if (item.type === 'insert') {
      const from = Math.max(0, Math.min(item.from, doc.length))
      const to = Math.max(from, Math.min(item.to, doc.length))
      if (to > from) {
        decos.push(CMDecoration.mark({
          class: 'edit-flash',
          attributes: {
            style: liveflashanimstyle(item.usercolor, item.fadetick || 0),
            'data-flash': `${item.expire}-${item.fadetick || 0}`
          }
        }).range(from, to))
      }
    }
  }
  return CMDecoration.set(decos, true)
}

export const cmliveflashfield = CMStateField.define({
  create() {
    return { items: [], decos: CMDecoration.none }
  },
  update(value, tr) {
    let items = value.items
    let changed = false
    if (tr.docChanged && items.length) {
      items = items.map(item => item.type === 'insert'
        ? { ...item, from: tr.changes.mapPos(item.from, 1), to: tr.changes.mapPos(item.to, -1) }
        : { ...item, pos: tr.changes.mapPos(item.pos, -1) }
      ).filter(item => item.type !== 'insert' || item.to >= item.from)
      changed = true
    }
    for (const effect of tr.effects) {
      if (effect.is(addcmliveflasheffect)) {
        items = effect.value.reduce((list, change) => mergecmliveflash(list, change), [...items])
        changed = true
      } else if (effect.is(prunecmliveflasheffect)) {
        const now = Date.now()
        items = effect.value === 'all' ? [] : items.filter(item => item.expire > now)
        changed = true
      }
    }
    if (!changed) return value
    return { items, decos: buildcmliveflashdecos(tr.state.doc, items) }
  },
  provide: f => CMEditorView.decorations.from(f, value => value.decos)
})

function mergecmliveflash(items, change) {
  const expire = Date.now() + liveflashlife
  if (change.type === 'insert') {
    const existing = items.find(item => item.type === 'insert' && item.author === change.author && item.to >= change.from && item.from <= change.to)
    if (existing) {
      existing.from = Math.min(existing.from, change.from)
      existing.to = Math.max(existing.to, change.to)
      existing.expire = expire
      existing.fadetick = (existing.fadetick || 0) + 1
    } else {
      items.push({ ...change, expire, fadetick: 0 })
    }
    return items
  }
  const existing = items.find(item => item.type === 'delete' && item.author === change.author && item.pos === change.pos)
  if (existing) {
    existing.text = `${change.text}${existing.text}`
    existing.expire = expire
    existing.fadetick = (existing.fadetick || 0) + 1
  } else if (change.text.trim()) {
    items.push({ ...change, expire, fadetick: 0 })
  }
  return items
}

export function flashcmremotechanges(update) {
  const author = liveflashauthor()
  if (!author || !ed.cmview) return
  const usercolor = resolveauthorcolor(author)
  const changes = []
  update.changes.iterChanges((froma, toa, fromb, tob) => {
    if (tob > fromb) {
      changes.push({ type: 'insert', from: fromb, to: tob, author, usercolor })
    } else if (toa > froma) {
      changes.push({ type: 'delete', pos: fromb, text: update.startState.doc.sliceString(froma, toa), author, usercolor })
    }
  })
  if (!changes.length) return
  // dispatching inside an update listener is not allowed so hop a microtask --------------------
  queueMicrotask(() => {
    if (!ed.cmview) return
    ed.cmview.dispatch({ effects: addcmliveflasheffect.of(changes) })
    if (cmliveflashtimer) clearTimeout(cmliveflashtimer)
    cmliveflashtimer = setTimeout(() => {
      cmliveflashtimer = null
      if (ed.cmview) ed.cmview.dispatch({ effects: prunecmliveflasheffect.of('expired') })
    }, liveflashlife + 40)
  })
}

