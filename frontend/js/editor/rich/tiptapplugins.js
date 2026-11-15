import { hextorgba } from '../../core/api.js'
import { state } from '../../core/state.js'
import {
  Extension,
  Decoration,
  DecorationSet,
  Plugin,
  PluginKey,
  StepMap,
  Mapping,
  ySyncPluginKey,
  yUndoPluginKey,
  yundo,
  yredo
} from './tiptap.bundle.js'
import {
  ed,
  remotecursormap,
  editorcursorscontent,
  flashpluginkey,
  pinpluginkey,
  remoteselectionpluginkey
} from '../editorshared.js'
import { ismarkdownfile } from '../noteutils.js'
import { resolveauthorcolor, createavatarbadge } from '../collab/flash.js'
import { cmliveflashfield } from '../plain/cmplugins.js'
import { cursorcoordsatpos, refreshallremotecursors } from '../collab/cursors.js'

// tiptap extension to display edit flash highlights --------------------
export const remoteselectionextension = Extension.create({
  name: 'remoteselection',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: remoteselectionpluginkey,
        state: {
          init() {
            return DecorationSet.empty
          },
          apply(tr, oldset) {
            let set = tr.docChanged ? oldset.map(collabmapping(tr).mapping, tr.doc) : oldset
            const meta = tr.getMeta(remoteselectionpluginkey)
            if (meta) {
              if (meta.action === 'set') return meta.decorations
              if (meta.action === 'clear') return DecorationSet.empty
            }
            return set
          }
        },
        props: {
          decorations(state) {
            return remoteselectionpluginkey.getState(state)
          }
        }
      })
    ]
  }
})

export const pinselectionextension = Extension.create({
  name: 'pinnedselection',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: pinpluginkey,
        state: {
          init() {
            return DecorationSet.empty
          },
          apply(tr, oldset) {
            let set = tr.docChanged ? oldset.map(collabmapping(tr).mapping, tr.doc) : oldset
            const meta = tr.getMeta(pinpluginkey)
            if (meta) {
              if (meta.action === 'set') return meta.decorations
              if (meta.action === 'clear') return DecorationSet.empty
            }
            return set
          }
        },
        props: {
          decorations(state) {
            return pinpluginkey.getState(state)
          }
        }
      })
    ]
  }
})

// y-prosemirror applies remote edits as one whole doc replace --------------------
// so mapping through tr.mapping would wipe every decoration, use the real changed span instead
const collabmappingcache = new WeakMap()

// the trailing node plugin keeps a local empty paragraph at the end that yjs never has --------------------
// leaving it in made the end match fail so a deleted line lit up the whole bottom of the note
function withouttrailingempty(fragment) {
  const last = fragment.lastChild
  if (!last || last.type.name !== 'paragraph' || last.content.size > 0) return fragment
  return fragment.cut(0, fragment.size - last.nodeSize)
}

export function docchangespan(before, after) {
  const a = withouttrailingempty(before.content)
  const b = withouttrailingempty(after.content)
  let start = a.findDiffStart(b)
  if (start === null || start === undefined) return null
  const end = a.findDiffEnd(b)
  if (!end) return null
  let enda = end.a
  let endb = end.b
  // repeated characters can make the end land before the start, slide it forward --------------------
  const overlap = start - Math.min(enda, endb)
  if (overlap > 0) {
    enda += overlap
    endb += overlap
  }

  // a pure insert or delete can sit anywhere along matching text, so "t|ool ... t" becomes "|tool ..." --------------------
  const pure = endb === start ? { doc: before, end: enda } : enda === start ? { doc: after, end: endb } : null
  if (pure) {
    const shift = slidespanleft(pure.doc, start, pure.end)
    start -= shift
    enda -= shift
    endb -= shift
  }
  return { start, enda, endb }
}

function slidespanleft(doc, from, to) {
  let shift = 0
  while (shift < 400) {
    const s = from - shift
    const e = to - shift
    if (s <= 0 || e <= s) break
    const $s = doc.resolve(s)
    if ($s.parent.isTextblock && $s.parentOffset === 0) break
    try {
      if (!doc.slice(s - 1, s).eq(doc.slice(e - 1, e))) break
    } catch {
      break
    }
    shift++
  }
  return shift
}

function collabmapping(tr) {
  if (collabmappingcache.has(tr)) return collabmappingcache.get(tr)
  let result = { mapping: tr.mapping, span: null, remote: false }
  const sync = tr.getMeta(ySyncPluginKey)
  if (sync?.isChangeOrigin && tr.docChanged) {
    // decoration sets want a real mapping with maps, a bare stepmap blew up and ate the whole remote update --------------------
    const span = docchangespan(tr.before, tr.doc)
    result = span
      ? { mapping: new Mapping([new StepMap([span.start, span.enda - span.start, span.endb - span.start])]), span, remote: true }
      : { mapping: new Mapping(), span: null, remote: true }
  }
  collabmappingcache.set(tr, result)
  return result
}

// live highlights for whoever is typing right now --------------------
export const liveflashpluginkey = new PluginKey('liveflash')
export const liveflashlife = 2200
let liveflashtimer = null

export function liveflashauthor() {
  const author = ed.collabprovider?.currentauthor
  if (!author) return null
  const myid = state.currentuser?.id || state.currentuser?.user_id
  if (myid && author === myid) return null
  return author
}

export function flashstyle(usercolor) {
  return `--flash-user-bg: ${hextorgba(usercolor, 0.28)}; --flash-user-strong: ${hextorgba(usercolor, 0.55)}; --flash-user-border: ${hextorgba(usercolor, 0.75)}; --flash-user-glow: ${hextorgba(usercolor, 0.35)};`
}

// flip animation name on each edit so reused spans restart their fade --------------------
export function liveflashanimstyle(usercolor, fadetick = 0) {
  const anim = (fadetick % 2 === 0) ? 'textflashfade' : 'textflashfade-b'
  return `${flashstyle(usercolor)}; animation: ${anim} 2.2s cubic-bezier(0.2, 0.8, 0.3, 1) forwards`
}

// fold one remote change into the live list, growing the authors current span as they type --------------------
function addliveflash(items, span, author, before, after) {
  const now = Date.now()
  const expire = now + liveflashlife
  const usercolor = resolveauthorcolor(author)
  const { start, enda, endb } = span

  if (endb > start) {
    const existing = items.find(item => item.type === 'insert' && item.author === author && item.to >= start && item.from <= endb)
    if (existing) {
      existing.from = Math.min(existing.from, start)
      existing.to = Math.max(existing.to, endb)
      existing.expire = expire
      existing.fadetick = (existing.fadetick || 0) + 1
    } else {
      items.push({ type: 'insert', from: start, to: endb, author, usercolor, expire, fadetick: 0 })
    }
    return items
  }

  if (enda > start) {
    let deletedtext = ''
    try {
      deletedtext = before.textBetween(start, enda, ' ')
    } catch {}
    // repeated letters slide the span left so a held backspace can land a char away from the last marker --------------------
    const existing = items.find(item => item.type === 'delete' && item.author === author && item.pos >= start && item.pos <= enda)
    if (existing) {
      existing.pos = start
      existing.text = `${deletedtext}${existing.text}`
      existing.expire = expire
      existing.fadetick = (existing.fadetick || 0) + 1
    } else if (deletedtext.trim()) {
      items.push({ type: 'delete', pos: start, text: deletedtext, author, usercolor, expire, fadetick: 0 })
    }
  }
  return items
}

// tint in the text only - avatars and delete bars float in the cursor layer --------------------
function buildliveflashdecos(doc, items) {
  const decos = []
  const size = doc.content.size
  for (const item of items) {
    if (item.type !== 'insert') continue
    const from = Math.max(0, Math.min(item.from, size))
    const to = Math.max(from, Math.min(item.to, size))
    if (to <= from) continue
    const style = liveflashanimstyle(item.usercolor, item.fadetick || 0)
    doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isText) return
      const nfrom = Math.max(from, pos)
      const nto = Math.min(to, pos + node.nodeSize)
      if (nfrom < nto) {
        decos.push(Decoration.inline(nfrom, nto, {
          class: 'edit-flash',
          style,
          'data-flash': `${item.expire}-${item.fadetick || 0}`
        }))
      }
    })
  }
  return decos.length ? DecorationSet.create(doc, decos) : DecorationSet.empty
}

export function liveflashitems() {
  const now = Date.now()
  let items = []
  if (ed.tiptapinstance && ismarkdownfile(state.activenoteid)) {
    items = liveflashpluginkey.getState(ed.tiptapinstance.state)?.items || []
  } else if (ed.cmview) {
    items = ed.cmview.state.field(cmliveflashfield, false)?.items || []
  }
  return items.filter(item => item.expire > now)
}

// negative delay picks the fade up where it left off since this layer gets rebuilt all the time --------------------
function liveflashdelay(item) {
  const elapsed = liveflashlife - Math.max(0, item.expire - Date.now())
  return `${-Math.max(0, elapsed)}ms`
}

export function buildliveflashmark(item) {
  const coords = cursorcoordsatpos(item.type === 'insert' ? item.to : item.pos, -1)
  if (!coords) return null
  const wrap = document.createElement('div')
  wrap.className = `live-flash-mark is-${item.type}`
  wrap.style.left = `${coords.left}px`
  wrap.style.top = `${coords.top}px`
  if (coords.height > 0) wrap.style.setProperty('--cursor-height', `${coords.height}px`)
  wrap.style.setProperty('--flash-user-border', hextorgba(item.usercolor, 0.85))
  wrap.style.setProperty('--flash-user-glow', hextorgba(item.usercolor, 0.45))
  wrap.style.setProperty('--flash-delay', liveflashdelay(item))
  if (item.type === 'delete') {
    const bar = document.createElement('div')
    bar.className = 'live-flash-bar'
    wrap.appendChild(bar)
  }
  wrap.appendChild(createavatarbadge(item.author, item.usercolor))
  return wrap
}

function scheduleliveflashprune(items) {
  if (liveflashtimer) {
    clearTimeout(liveflashtimer)
    liveflashtimer = null
  }
  if (!items.length) return
  const soonest = Math.min(...items.map(item => item.expire))
  liveflashtimer = setTimeout(() => {
    liveflashtimer = null
    if (!ed.tiptapinstance) return
    try {
      ed.tiptapinstance.view.dispatch(ed.tiptapinstance.state.tr.setMeta(liveflashpluginkey, { action: 'prune' }))
    } catch {}
  }, Math.max(30, soonest - Date.now() + 30))
}

function mapremotecursors(mapping) {
  for (const data of remotecursormap.values()) {
    for (const key of ['head', 'anchor', 'from', 'to']) {
      if (typeof data[key] === 'number') data[key] = mapping.map(data[key], key === 'from' ? 1 : -1)
    }
  }
}

let cursorrefreshqueued = false
export function queueremotecursorrefresh() {
  if (cursorrefreshqueued) return
  if (remotecursormap.size === 0 && !editorcursorscontent?.childElementCount && !liveflashitems().length) return
  cursorrefreshqueued = true
  requestAnimationFrame(() => {
    cursorrefreshqueued = false
    refreshallremotecursors()
  })
}

export const liveflashextension = Extension.create({
  name: 'liveflash',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: liveflashpluginkey,
        state: {
          init() {
            return { items: [], decos: DecorationSet.empty }
          },
          apply(tr, value) {
            const meta = tr.getMeta(liveflashpluginkey)
            if (!tr.docChanged && !meta) return value
            let items = value.items

            if (meta?.action === 'clear') {
              items = []
            } else if (meta?.action === 'prune') {
              const now = Date.now()
              items = items.filter(item => item.expire > now)
            }

            if (tr.docChanged) {
              const { mapping, span, remote } = collabmapping(tr)
              items = items.map(item => item.type === 'insert'
                ? { ...item, from: mapping.map(item.from, 1), to: mapping.map(item.to, -1) }
                : { ...item, pos: mapping.map(item.pos, -1) }
              ).filter(item => item.type !== 'insert' || item.to >= item.from)
              mapremotecursors(mapping)
              const author = remote && span ? liveflashauthor() : null
              if (author) items = addliveflash(items, span, author, tr.before, tr.doc)
            }

            scheduleliveflashprune(items)
            return { items, decos: buildliveflashdecos(tr.doc, items) }
          }
        },
        props: {
          decorations(editorstate) {
            return liveflashpluginkey.getState(editorstate)?.decos
          }
        },
        view() {
          return {
            update(view, prevstate) {
              // prune changes no text but the avatars still have to go away --------------------
              const flashmoved = liveflashpluginkey.getState(view.state) !== liveflashpluginkey.getState(prevstate)
              if (view.state.doc !== prevstate.doc || flashmoved) queueremotecursorrefresh()
            }
          }
        }
      })
    ]
  }
})

// yjs undo only rewinds your own edits, never someone elses --------------------
export function collabundo() {
  if (!ed.tiptapinstance || !yUndoPluginKey.getState(ed.tiptapinstance.state)) return false
  return yundo(ed.tiptapinstance.state)
}

export function collabredo() {
  if (!ed.tiptapinstance || !yUndoPluginKey.getState(ed.tiptapinstance.state)) return false
  return yredo(ed.tiptapinstance.state)
}

export const collabundoextension = Extension.create({
  name: 'collabundo',
  addKeyboardShortcuts() {
    return {
      'Mod-z': () => collabundo(),
      'Mod-y': () => collabredo(),
      'Mod-Shift-z': () => collabredo()
    }
  }
})

export const flashextension = Extension.create({
  name: 'flashhighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: flashpluginkey,
        state: {
          init() {
            return DecorationSet.empty
          },
          apply(tr, oldset) {
            let set = tr.docChanged ? oldset.map(collabmapping(tr).mapping, tr.doc) : oldset
            const meta = tr.getMeta(flashpluginkey)
            if (meta) {
              if (meta.action === 'set') {
                return meta.decorations
              }
              if (meta.action === 'clear') {
                return DecorationSet.empty
              }
            }
            return set
          }
        },
        props: {
          decorations(state) {
            return flashpluginkey.getState(state)
          }
        },
        view() {
          return {
            update(view, prevstate) {
              if (flashpluginkey.getState(view.state) !== flashpluginkey.getState(prevstate)) queueremotecursorrefresh()
            }
          }
        }
      })
    ]
  }
})

