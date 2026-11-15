import fs from 'node:fs'
import path from 'node:path'
import { isinternalwrite, isinternaldelete, textfilepattern } from './vault.js'
import { applyexternalchange, handleexternaldelete, migratedocentry, evictnotedoc } from '../sync/sync.js'
import { getlatestrevision, gethistoryidsunder, migratehistoryids, recordevent } from './history.js'
import { log } from '../core/logger.js'

// os renames show up as a delete and a create so deletes wait a bit for their partner --------------------
const renamewindow = 1500
const recheckdelay = 400

// start watching vault directory recursively for external edits --------------------
export function initvaultwatcher(vaultdir, historydir, wss) {
  if (!fs.existsSync(vaultdir)) {
    fs.mkdirSync(vaultdir, { recursive: true })
  }

  const debouncetimers = new Map()
  const pendingdeletes = new Map()

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

  // real delete once nobody claimed it as a rename --------------------
  function finishdelete(relpath) {
    pendingdeletes.delete(relpath)
    log.watcher('delete', relpath, 'external file removed')
    handleexternaldelete(vaultdir, historydir, relpath)
    broadcastvaultchange({ type: 'vault_changed', action: 'delete', note_id: relpath })
  }

  function queuedelete(relpath) {
    const latest = getlatestrevision(historydir, relpath)
    const children = latest ? [] : gethistoryidsunder(historydir, relpath)
    if (!latest && children.length === 0) {
      finishdelete(relpath)
      return
    }
    const timer = setTimeout(() => finishdelete(relpath), renamewindow)
    pendingdeletes.set(relpath, {
      timer,
      isfolder: !latest,
      content: latest ? latest.content : null,
      children: children.map(id => id.slice(relpath.length + 1))
    })
  }

  function claimmove(oldpath, newpath, isfolder) {
    const pending = pendingdeletes.get(oldpath)
    if (pending) clearTimeout(pending.timer)
    pendingdeletes.delete(oldpath)
    if (isfolder) {
      for (const [childpath, child] of pendingdeletes) {
        if (!childpath.startsWith(`${oldpath}/`)) continue
        clearTimeout(child.timer)
        pendingdeletes.delete(childpath)
      }
    }

    migratehistoryids(historydir, oldpath, newpath, isfolder)
    migratedocentry(oldpath, newpath, isfolder)
    recordevent(historydir, {
      file_id: newpath,
      event_type: isfolder ? 'move_folder' : 'move',
      author: 'external',
      old_path: oldpath,
      new_path: newpath,
      details: `moved outside the app from ${oldpath} to ${newpath}`
    })
    log.watcher('move', `${oldpath} --> ${newpath}`, 'external rename tracked')
    broadcastvaultchange({ type: 'vault_changed', action: 'move', old_id: oldpath, note_id: newpath, is_folder: isfolder })
  }

  // a fresh file matching a pending delete is the same note wearing a new name --------------------
  // best guess order: same content, then same name, then the only sibling with the same extension
  function findfilemove(relpath, content) {
    const basename = relpath.split('/').pop()
    const parent = path.posix.dirname(relpath)
    const ext = path.posix.extname(relpath)
    let byname = null
    const siblings = []
    for (const [oldpath, pending] of pendingdeletes) {
      if (pending.isfolder) continue
      if (pending.content === content) return oldpath
      if (!byname && oldpath.split('/').pop() === basename) byname = oldpath
      if (path.posix.dirname(oldpath) === parent && path.posix.extname(oldpath) === ext) siblings.push(oldpath)
    }
    return byname || (siblings.length === 1 ? siblings[0] : null)
  }

  // a fresh folder holding the same note names as a pending folder delete --------------------
  function findfoldermove(relpath) {
    for (const [oldpath, pending] of pendingdeletes) {
      if (!pending.isfolder) continue
      const hit = pending.children.some(child => fs.existsSync(path.join(vaultdir, relpath, ...child.split('/'))))
      if (hit) return oldpath
    }
    return null
  }

  // child file events can beat the folder event so check its parents too --------------------
  function claimparentfolder(relpath) {
    const parts = relpath.split('/')
    for (let i = parts.length - 1; i > 0; i--) {
      const folder = parts.slice(0, i).join('/')
      const oldpath = findfoldermove(folder)
      if (oldpath) {
        claimmove(oldpath, folder, true)
        return true
      }
    }
    return false
  }

  function handlefilechange(relpath, isretry = false) {
    const fullpath = path.join(vaultdir, ...relpath.split('/'))

    // handle file deletion --------------------
    if (!fs.existsSync(fullpath)) {
      if (isinternaldelete(fullpath)) {
        // api already deleted the file; still evict live docs so a flush cannot resurrect it
        evictnotedoc(historydir, relpath)
        broadcastvaultchange({ type: 'vault_changed', action: 'delete', note_id: relpath })
        return
      }
      queuedelete(relpath)
      return
    }

    // handle directories --------------------
    try {
      const stats = fs.statSync(fullpath)
      if (stats.isDirectory()) {
        const oldfolder = pendingdeletes.size ? findfoldermove(relpath) : null
        if (oldfolder) claimmove(oldfolder, relpath, true)
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

    // brand new path might just be a rename we are waiting on --------------------
    if (!getlatestrevision(historydir, relpath)) {
      const claimed = claimparentfolder(relpath) || (() => {
        const oldpath = findfilemove(relpath, content)
        if (oldpath) claimmove(oldpath, relpath, false)
        return Boolean(oldpath)
      })()
      // windows sometimes reports the new name before the old one vanishes so give it one more look --------------------
      if (!claimed && !isretry) {
        setTimeout(() => handlefilechange(relpath, true), recheckdelay)
        return
      }
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
