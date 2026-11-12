import fs from 'node:fs'
import path from 'node:path'
import { isinternalwrite, isinternaldelete, textfilepattern } from './vault.js'
import { applyexternalchange, handleexternaldelete } from './sync.js'
import { log } from './logger.js'

// start watching vault directory recursively for external edits --------------------
export function initvaultwatcher(vaultdir, historydir, wss) {
  if (!fs.existsSync(vaultdir)) {
    fs.mkdirSync(vaultdir, { recursive: true })
  }

  const debouncetimers = new Map()

  function broadcastvaultchange(payload) {
    if (!wss || !wss.clients) return
    const msg = JSON.stringify(payload)
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        client.send(msg)
      }
    }
  }

  let watcher = null
  try {
    watcher = fs.watch(vaultdir, { recursive: true }, (eventtype, filename) => {
      if (!filename) return

      // normalize windows backslashes --------------------
      const relpath = filename.replace(/\\/g, '/')

      // ignore hidden files, temporary files, and git metadata --------------------
      const parts = relpath.split('/')
      if (parts.some(p => p.startsWith('.') || p.endsWith('~') || p.endsWith('.tmp'))) {
        return
      }

      // debounce rapid fs events for the same file path --------------------
      if (debouncetimers.has(relpath)) {
        clearTimeout(debouncetimers.get(relpath))
      }

      const timer = setTimeout(() => {
        debouncetimers.delete(relpath)
        handlefilechange(relpath)
      }, 80)

      debouncetimers.set(relpath, timer)
    })
  } catch (err) {
    console.error('failed to initialize vault watcher', err)
    return null
  }

  function handlefilechange(relpath) {
    const fullpath = path.join(vaultdir, ...relpath.split('/'))

    // handle file deletion --------------------
    if (!fs.existsSync(fullpath)) {
      const internal = isinternaldelete(fullpath)
      if (!internal) {
        log.watcher('delete', relpath, 'external file removed')
        handleexternaldelete(vaultdir, historydir, relpath)
      }
      broadcastvaultchange({
        type: 'vault_changed',
        action: 'delete',
        note_id: relpath
      })
      return
    }

    // handle directories --------------------
    try {
      const stats = fs.statSync(fullpath)
      if (stats.isDirectory()) {
        broadcastvaultchange({
          type: 'vault_changed',
          action: 'directory_change',
          path: relpath
        })
        return
      }
    } catch {
      return
    }

    // verify it is a supported text file --------------------
    if (!textfilepattern.test(relpath)) {
      return
    }

    // read content from disk --------------------
    let content = ''
    try {
      content = fs.readFileSync(fullpath, 'utf8')
    } catch {
      return
    }

    // ignore internal writes saved by mushnote itself --------------------
    if (isinternalwrite(fullpath, content)) {
      return
    }

    // apply change into memory yjs document and sqlite history --------------------
    const changed = applyexternalchange(vaultdir, historydir, relpath, content)
    if (changed) {
      log.watcher('sync', relpath, 'external edit detected and synced')
      broadcastvaultchange({
        type: 'vault_changed',
        action: 'edit',
        note_id: relpath
      })
    }
  }

  return watcher
}

