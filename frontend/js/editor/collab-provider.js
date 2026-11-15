import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

// bundled for editor import map compatibility --------------------
export { Y, syncProtocol, encoding, decoding }

// must match backend/sync/sync.js --------------------
const messagesync = 0
const messageauthoredupdate = 10

function tomessagebytes(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  try {
    return new Uint8Array(data)
  } catch {
    return null
  }
}

// live yjs websocket sync for a single note --------------------
// the ydoc survives reconnects so offline typing merges back in once the server is reachable again
export class notecollabprovider {
  constructor({ noteid, author, onsynced, onepochchange, onstatus, oncursor, oncursorleave, onvaultevent, onpeerready }) {
    this.noteid = noteid
    this.author = author
    this.onsynced = onsynced
    this.onepochchange = onepochchange
    this.onstatus = onstatus
    this.oncursor = oncursor
    this.oncursorleave = oncursorleave
    this.onvaultevent = onvaultevent
    this.onpeerready = onpeerready
    this.ydoc = new Y.Doc()
    this.ws = null
    this.epoch = null
    this.kind = null
    this.synced = false
    this.joined = false
    this.destroyed = false
    this.retries = 0
    this.retrytimer = null
    // author of the remote update being applied right now so editors can flash it --------------------
    this.currentauthor = null

    this._onupdate = (update, origin) => {
      if (origin === this) return
      this.sendupdate(update)
    }
    this.ydoc.on('update', this._onupdate)
  }

  get peerslive() {
    return Boolean(this.joined && this.ws?.readyState === 1)
  }

  connect() {
    if (this.destroyed) return
    if (this.ws) {
      this.ws.onclose = null
      try { this.ws.close() } catch {}
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${protocol}//${window.location.host}/ws/${encodeURIComponent(this.noteid)}?author=${encodeURIComponent(this.author)}`
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.joined = false
    this.onstatus?.('connecting')

    ws.onmessage = (event) => {
      if (this.ws !== ws) return
      if (typeof event.data === 'string') {
        this.handlejson(event.data)
        return
      }
      this.handlebinary(event.data)
    }

    ws.onclose = () => {
      if (this.ws !== ws) return
      this.joined = false
      this.ws = null
      if (this.destroyed) return
      this.onstatus?.('offline')
      this.schedulereconnect()
    }

    ws.onerror = () => {}
  }

  schedulereconnect() {
    if (this.retrytimer || this.destroyed) return
    const delay = Math.min(5000, 300 * Math.pow(2, this.retries))
    this.retries += 1
    this.retrytimer = setTimeout(() => {
      this.retrytimer = null
      this.connect()
    }, delay)
  }

  handlejson(raw) {
    let data = null
    try {
      data = JSON.parse(raw)
    } catch {
      return
    }
    if (!data) return

    if (data.type === 'hello') {
      // server rebuilt this note from disk, merging our old doc would duplicate everything --------------------
      if (this.epoch && data.epoch !== this.epoch) {
        this.onepochchange?.()
        return
      }
      this.epoch = data.epoch
      this.kind = data.kind
      this.retries = 0
      this.ws.send(JSON.stringify({ type: 'join', epoch: this.epoch }))
      this.joined = true
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messagesync)
      syncProtocol.writeSyncStep1(encoder, this.ydoc)
      this.ws.send(encoding.toUint8Array(encoder))
      this.onstatus?.('online')
      this.onpeerready?.()
      return
    }

    if (data.type === 'cursor_event' && data.author !== this.author) {
      this.oncursor?.(data)
    } else if (data.type === 'cursor_leave' && data.author !== this.author) {
      this.oncursorleave?.(data)
    } else {
      this.onvaultevent?.(data)
    }
  }

  handlebinary(raw) {
    const bytes = tomessagebytes(raw)
    if (!bytes) return
    try {
      const decoder = decoding.createDecoder(bytes)
      const msgtype = decoding.readVarUint(decoder)

      if (msgtype === messageauthoredupdate) {
        const author = decoding.readVarString(decoder)
        const update = decoding.readVarUint8Array(decoder)
        this.currentauthor = author
        try {
          Y.applyUpdate(this.ydoc, update, this)
        } finally {
          this.currentauthor = null
        }
        return
      }

      if (msgtype !== messagesync) return
      const reply = encoding.createEncoder()
      encoding.writeVarUint(reply, messagesync)
      const synctype = syncProtocol.readSyncMessage(decoder, reply, this.ydoc, this)
      if (encoding.length(reply) > 1 && this.ws?.readyState === 1) {
        this.ws.send(encoding.toUint8Array(reply))
      }
      if (synctype === syncProtocol.messageYjsSyncStep2 && !this.synced) {
        this.synced = true
        this.onsynced?.()
      }
    } catch (err) {
      console.warn('collab sync message failed', err)
    }
  }

  sendupdate(update) {
    if (!this.peerslive) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messagesync)
    syncProtocol.writeUpdate(encoder, update)
    this.ws.send(encoding.toUint8Array(encoder))
  }

  sendcursor(payload) {
    if (!this.peerslive) return
    this.ws.send(JSON.stringify({
      type: 'cursor_event',
      note_id: this.noteid,
      author: this.author,
      ...payload
    }))
  }

  sendcursorleave() {
    if (!this.peerslive) return
    this.ws.send(JSON.stringify({
      type: 'cursor_leave',
      note_id: this.noteid,
      author: this.author
    }))
  }

  disconnect() {
    this.destroyed = true
    if (this.retrytimer) {
      clearTimeout(this.retrytimer)
      this.retrytimer = null
    }
    try {
      this.sendcursorleave()
    } catch {}
    if (this.ws) {
      this.ws.onclose = null
      try { this.ws.close() } catch {}
      this.ws = null
    }
    this.joined = false
    this.ydoc.off('update', this._onupdate)
    try {
      this.ydoc.destroy()
    } catch {}
  }
}
