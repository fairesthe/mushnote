import { state } from '../core/state.js'
import { notemarkdownfromeditor, cleanmarkdown } from './rich/tiptap.bundle.js'

export function isauthorai(author) {
  return author === 'ai' || Boolean(state.aiuserid && author === state.aiuserid)
}

// check if file is markdown based on extension or mushnote default --------------------
export function ismarkdownfile(noteid) {
  if (!noteid) return false
  const clean = noteid.split('?')[0].split('#')[0].toLowerCase()
  const parts = clean.split('/')
  const filename = parts[parts.length - 1]
  const dotidx = filename.lastIndexOf('.')
  if (dotidx > 0) {
    const ext = filename.slice(dotidx + 1)
    return ext === 'md' || ext === 'markdown'
  }
  if (filename.startsWith('.')) {
    return false
  }
  return true
}

// markdown from editor with line break and paragraph spacing fixes --------------------
export function geteditormarkdown(editor) {
  return cleanmarkdown(notemarkdownfromeditor(editor))
}

// helper to match note ids with or without md extension or folder prefix --------------------
export function isnoteidmatch(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  const norma = a.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const normb = b.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (norma === normb) return true
  const stripmda = norma.replace(/\.md$/, '')
  const stripmdb = normb.replace(/\.md$/, '')
  if (stripmda === stripmdb) return true
  const basea = stripmda.split('/').pop()
  const baseb = stripmdb.split('/').pop()
  if (!stripmda.includes('/') && baseb === stripmda) return true
  if (!stripmdb.includes('/') && basea === stripmdb) return true
  return false
}

// check if url is external web or protocol link --------------------
export function isexternalurl(url) {
  if (!url || typeof url !== 'string') return false
  const trimmed = url.trim()
  if (trimmed.startsWith(window.location.origin)) {
    return false
  }
  return /^(https?:|\/\/|mailto:|tel:)/i.test(trimmed)
}

// resolve target path or title to actual note id and optional anchor --------------------
export function resolvenoteid(rawtarget) {
  if (!rawtarget || typeof rawtarget !== 'string') return { noteid: '', anchor: null }

  let target = decodeURIComponent(rawtarget.trim())

  // strip origin if full url on same host --------------------
  if (target.startsWith(window.location.origin)) {
    target = target.slice(window.location.origin.length)
  }

  let anchor = null
  const hashidx = target.indexOf('#')
  if (hashidx >= 0) {
    anchor = target.slice(hashidx + 1).trim()
    target = target.slice(0, hashidx).trim()
  }

  const queryidx = target.indexOf('?')
  if (queryidx >= 0) {
    target = target.slice(0, queryidx).trim()
  }

  // if only anchor was provided stay in active note --------------------
  if (!target && anchor) {
    return { noteid: state.activenoteid, anchor }
  }

  // normalize slashes and strip leading prefixes --------------------
  target = target.replace(/\\/g, '/')
  target = target.replace(/^(\.\/)+/, '')
  target = target.replace(/^\/+/, '')

  // match against cached vault notes list --------------------
  if (state.allnotes && state.allnotes.length > 0) {
    const exact = state.allnotes.find(n => n.note_id === target)
    if (exact) return { noteid: exact.note_id, anchor }

    if (!target.includes('.')) {
      const withmd = state.allnotes.find(n => n.note_id === `${target}.md`)
      if (withmd) return { noteid: withmd.note_id, anchor }
    }

    const matched = state.allnotes.find(n => isnoteidmatch(n.note_id, target))
    if (matched) return { noteid: matched.note_id, anchor }

    if (!target.includes('/')) {
      const bybase = state.allnotes.find(n => {
        const base = n.note_id.split('/').pop()
        return base === target || base === `${target}.md`
      })
      if (bybase) return { noteid: bybase.note_id, anchor }
    }
  }

  // fallback formatting when not found in memory --------------------
  let finalid = target
  if (!finalid.includes('.')) {
    finalid = `${finalid}.md`
  }
  return { noteid: finalid, anchor }
}

