import { api } from '../core/api.js'
import { state } from '../core/state.js'
import { rendertabs, pushtabhistory, ensureslothistory, removeslothistory } from '../workspace/tabs.js'
import { renderfolderview, updateactivefilerow, closecontextmenu } from '../workspace/files.js'
import { renderpreview, hidepreview, updateviewpagebutton } from '../workspace/preview.js'
import { cleanmarkdown } from './rich/tiptap.bundle.js'
import {
  ed,
  editorcontainer,
  emptystate,
  editortoolbar,
  tiptapeditorcontainer,
  plaineditorwrap,
  noteeditor,
  editorbackdrop,
  imageviewercontainer,
  imageviewerimg,
  imageviewermeta,
  mediavieweraudiowrap,
  mediavieweraudio,
  mediaviewervideo,
  mediaviewerpdf,
  mediaviewerfile,
  mediaviewerfilename
} from './editorshared.js'
import {
  mediakindfromnoteid,
  rawurlfornote,
  stopmediaplayback,
  resetmediaviewer,
  clearmediaimagepreview,
  loadaudiocoverart,
  autoplaymediaviewer,
  setbinarytoolbarvisible,
  bindfiledownloadonce
} from './media/media.js'
import { ismarkdownfile, isnoteidmatch } from './noteutils.js'
import { ismobilemode, setmobilepanel } from '../core/mobile.js'
import { clearpinnededitorselection, closeeditorcontextmenu, initeditoraskaimenu, initeditorselectionpin } from './selection.js'
import {
  resolveauthorcolor,
  rendercmflashhighlight,
  flashwholecmnote,
  cleareditorflashhighlights,
  flashwholenote,
  renderflashhighlight
} from './collab/flash.js'
import { setcmcontent } from './plain/codemirror.js'
import { sethistorypreviewactive } from './history/historypreview.js'
import { inittiptapeditor, updatetoolbarstate } from './rich/tiptap.js'
import { inittoolbartips } from './toolbartip.js'
import { stopnotecollab, connectnotesocket } from './collab/collab.js'
import {
  iscreatedduringsession,
  writespotseen,
  getspotseen,
  saveworkspacestate
} from './session.js'
import { initplaineditor } from './plain/plaineditor.js'
import { initeditorlinkevents, closenotelinkmenu } from './rich/links.js'
import { bindeditorcursorscroll } from './collab/cursors.js'

// public editor api lives in the split modules --------------------
export { saveworkspacestate, loadworkspacestate, marksessioncreated } from './session.js'
export { isnoteidmatch, isexternalurl } from './noteutils.js'
export {
  formatdraginsert,
  getdraggeditem,
  getdraggeditems,
  insertdraggeditemsintoactivenote,
  insertcontentintoactivenote
} from './dragdrop.js'
export { stopmediafortabclose } from './media/media.js'
export { opennotelink } from './rich/links.js'
export { captureeditorselectionforai } from './selection.js'
export { refreshreadingscale } from './collab/cursors.js'
export { showhistoryrevisionpreview, sethistorypreviewactive } from './history/historypreview.js'
export { cleanmarkdown, expandmarkdownblanklines, preparemarkdownforload, patchnotemarkdownparser } from './rich/tiptap.bundle.js'

// swap the center pane over to the rich or plain text editor --------------------
function showtexteditor(ismd) {
  if (imageviewercontainer) imageviewercontainer.classList.add('hidden')
  stopmediaplayback()
  setbinarytoolbarvisible(false)
  if (emptystate) emptystate.classList.add('hidden')
  if (editorcontainer) {
    editorcontainer.classList.remove('hidden')
    editorcontainer.classList.toggle('plain-mode', !ismd)
  }
  editortoolbar?.classList.toggle('hidden', !ismd)
  tiptapeditorcontainer?.classList.toggle('hidden', !ismd)
  plaineditorwrap?.classList.toggle('hidden', ismd)
}

// deleted notes have no file to open so just set up an empty read only editor --------------------
export function showdeletednoteshell(noteid) {
  window.dispatchEvent(new CustomEvent('mushnote-history-close'))
  stopnotecollab()
  cleareditorflashhighlights()
  if (ed.savetimer) {
    clearTimeout(ed.savetimer)
    ed.savetimer = null
  }
  hidepreview()
  const ismd = ismarkdownfile(noteid)
  showtexteditor(ismd)
  if (ismd) inittiptapeditor()
  state.activenoteid = noteid
  document.title = `${noteid.split('/').pop()} (deleted) - mushnote`
  rendertabs()
  updateactivefilerow()
  updateviewpagebutton()
}

export async function reloadactivenoteafterhistory() {
  const noteid = state.activenoteid
  if (!noteid) return

  sethistorypreviewactive(false)
  cleareditorflashhighlights()
  if (noteeditor) noteeditor.readOnly = false

  try {
    await opennote(noteid, { replacecurrent: false, switchfolder: false })
  } catch (err) {
    console.warn('reload after history failed', err)
  }
}

// close current note editor --------------------
export function closenote() {
  window.dispatchEvent(new CustomEvent('mushnote-history-close'))
  clearpinnededitorselection()
  stopnotecollab()
  cleareditorflashhighlights()
  if (ed.plainflashtimeout) {
    clearTimeout(ed.plainflashtimeout)
    ed.plainflashtimeout = null
  }
  if (ed.cmflashtimeout) {
    clearTimeout(ed.cmflashtimeout)
    ed.cmflashtimeout = null
  }
  if (editorbackdrop) {
    editorbackdrop.innerHTML = ''
  }
  if (noteeditor) {
    noteeditor.value = ''
  }
  if (state.activenoteid) {
    const closedid = state.activenoteid
    state.opentabs = state.opentabs.filter(t => !isnoteidmatch(t, closedid))
  }
  state.activenoteid = null
  document.title = 'mushnote'
  if (editorcontainer) {
    editorcontainer.classList.add('hidden')
    editorcontainer.classList.remove('plain-mode')
  }
  if (imageviewercontainer) imageviewercontainer.classList.add('hidden')
  resetmediaviewer()
  setbinarytoolbarvisible(false)
  hidepreview()
  updateviewpagebutton()
  if (emptystate) emptystate.classList.remove('hidden')
  updateactivefilerow()

  if (ed.tiptapinstance) {
    ed.tiptapinstance.commands.setContent('', false)
  }
  if (ed.cmview) {
    ed.cmview.dispatch({
      changes: { from: 0, to: ed.cmview.state.doc.length, insert: '' }
    })
  }

  // update tabs bar and persist workspace --------------------
  rendertabs()
  saveworkspacestate()

  // clear last open note preference on server --------------------
  if (state.currentuser) {
    if (!state.currentuser.preferences) state.currentuser.preferences = {}
    state.currentuser.preferences['last-open-note'] = null
    api('/api/user/preferences', {
      method: 'POST',
      body: JSON.stringify({
        preferences: { 'last-open-note': null }
      })
    }).catch(() => {})
  }
}

// open note in center wysiwyg editor --------------------
export async function opennote(noteid, options = {}) {
  const opts = typeof options === 'boolean' ? { force: options } : (options || {})
  if (!ismobilemode() && opts.newtab && !noteid.startsWith('preview:')) {
    window.open(`/editor/${encodeURI(noteid)}`, '_blank')
    return
  }

  window.dispatchEvent(new CustomEvent('mushnote-history-close'))
  // drop any open context menus when switching tabs or notes --------------------
  closecontextmenu()
  closeeditorcontextmenu()
  closenotelinkmenu()
  document.getElementById('ai-context-menu')?.classList.add('hidden')
  document.getElementById('ai-bubble-context-menu')?.classList.add('hidden')
  clearpinnededitorselection()
  // unbind before any setcontent or the new note gets written into the old doc --------------------
  stopnotecollab()
  cleareditorflashhighlights()
  if (ed.plainflashtimeout) {
    clearTimeout(ed.plainflashtimeout)
    ed.plainflashtimeout = null
  }
  if (ed.cmflashtimeout) {
    clearTimeout(ed.cmflashtimeout)
    ed.cmflashtimeout = null
  }
  if (ed.savetimer) {
    clearTimeout(ed.savetimer)
    ed.savetimer = null
  }
  const ispreview = noteid.startsWith('preview:')
  const rawtargetid = ispreview ? noteid.slice('preview:'.length) : noteid
  let tabname = rawtargetid.split('/').pop() || rawtargetid
  if (!ispreview && !tabname.includes('.')) {
    tabname = `${tabname}.md`
  }
  if (ispreview) {
    const stored = state.previewtitles?.[noteid]
    document.title = stored ? `web: ${stored} - mushnote` : `web: ${tabname} - mushnote`
  } else {
    document.title = `${tabname} - mushnote`
  }
  let {
    newtab = false,
    replacecurrent = true,
    switchfolder = true,
    fromhistory = false,
  } = opts

  // mobile keeps a single tab -- any open becomes a switch or replace --------------------
  const mobile = ismobilemode()
  if (mobile) {
    newtab = false
    replacecurrent = true
  } else if (!ispreview) {
    window.history.replaceState({}, '', `/editor/${encodeURI(noteid)}`)
  }

  const prevactive = state.activenoteid
  let prevslot = prevactive
    ? state.opentabs.findIndex((t) => isnoteidmatch(t, prevactive))
    : -1
  const alreadyopen = state.opentabs.some((t) => isnoteidmatch(t, noteid))

  // manage open tabs list --------------------
  if (mobile) {
    if (alreadyopen) {
      // switch to existing
    } else if (state.opentabs.length === 0) {
      state.opentabs = [noteid]
    } else {
      const slot = prevslot >= 0 ? prevslot : 0
      if (prevactive && !isnoteidmatch(prevactive, noteid)) {
        pushtabhistory(slot, prevactive)
      }
      state.opentabs = [noteid]
      // drop extra slot histories from a desktop session --------------------
      while (state.tabslothistories.length > 1) state.tabslothistories.pop()
    }
  } else if (fromhistory && prevslot >= 0) {
    // restore prior note into this same tab slot --------------------
    state.opentabs[prevslot] = noteid
    for (let i = state.opentabs.length - 1; i >= 0; i--) {
      if (i !== prevslot && isnoteidmatch(state.opentabs[i], noteid)) {
        removeslothistory(i)
        state.opentabs.splice(i, 1)
        if (i < prevslot) prevslot -= 1
      }
    }
  } else if (newtab) {
    if (!alreadyopen) state.opentabs.push(noteid)
  } else if (replacecurrent) {
    if (state.opentabs.length === 0) {
      state.opentabs = [noteid]
    } else if (alreadyopen) {
      // note already in tabs so just switch to it
    } else if (prevslot >= 0) {
      // in-place navigation: keep this tab slot and remember where we came from --------------------
      if (prevactive && !isnoteidmatch(prevactive, noteid)) {
        pushtabhistory(prevslot, prevactive)
      }
      state.opentabs[prevslot] = noteid
    } else {
      state.opentabs.push(noteid)
    }
  } else if (!alreadyopen) {
    state.opentabs.push(noteid)
  }

  ensureslothistory()

  state.activenoteid = noteid
  rendertabs()
  if (mobile) setmobilepanel('note')

  if (ispreview) {
    if (emptystate) emptystate.classList.add('hidden')
    if (editorcontainer) editorcontainer.classList.add('hidden')
    if (imageviewercontainer) imageviewercontainer.classList.add('hidden')
    resetmediaviewer()
    setbinarytoolbarvisible(false)
    updateactivefilerow()
    updateviewpagebutton()
    await renderpreview(rawtargetid)
    connectnotesocket(rawtargetid)
    updateviewpagebutton()
    saveworkspacestate()
    return
  }

  hidepreview()

  // switch folder view only if requested --------------------
  if (switchfolder) {
    const notefolder = noteid.includes('/')
      ? noteid.split('/').slice(0, -1).join('/')
      : ''

    if (state.currentfolder !== notefolder) {
      state.currentfolder = notefolder
    }
    renderfolderview()
  } else {
    updateactivefilerow()
  }

  try {
    const data = await api(`/api/note?id=${encodeURIComponent(noteid)}`)
    if (emptystate) emptystate.classList.add('hidden')
    document.title = `${tabname} - mushnote`

    const mediakind = data.note.media_kind || (data.note.is_image ? 'image' : mediakindfromnoteid(noteid))
    if (mediakind === 'image' || mediakind === 'audio' || mediakind === 'video' || mediakind === 'pdf' || mediakind === 'file') {
      if (editorcontainer) editorcontainer.classList.add('hidden')
      if (imageviewercontainer) {
        imageviewercontainer.classList.remove('hidden')
        const mediaurl = data.note.media_url || data.note.image_url || rawurlfornote(noteid)
        stopmediaplayback()
        if (mediakind === 'image') {
          clearmediaimagepreview()
          if (imageviewerimg) {
            imageviewerimg.classList.remove('hidden')
            imageviewerimg.src = mediaurl
          }
        } else if (mediakind === 'audio' && mediavieweraudio) {
          ed.mediaplayernoteid = noteid
          ed.mediaplayerkind = 'audio'
          if (mediavieweraudiowrap) mediavieweraudiowrap.classList.remove('hidden')
          mediavieweraudio.src = mediaurl
          loadaudiocoverart(noteid, data.note.updated_at || '')
          autoplaymediaviewer(mediavieweraudio)
        } else if (mediakind === 'video' && mediaviewervideo) {
          ed.mediaplayernoteid = noteid
          ed.mediaplayerkind = 'video'
          mediaviewervideo.classList.remove('hidden')
          mediaviewervideo.src = mediaurl
          autoplaymediaviewer(mediaviewervideo)
        } else if (mediakind === 'pdf' && mediaviewerpdf) {
          mediaviewerpdf.classList.remove('hidden')
          mediaviewerpdf.src = mediaurl
        } else if (mediakind === 'file' && mediaviewerfile) {
          mediaviewerfile.classList.remove('hidden')
          if (mediaviewerfilename) {
            mediaviewerfilename.textContent = data.note.title || noteid.split('/').pop() || noteid
          }
        }
        if (imageviewermeta) {
          const sizestr = data.note.size ? ` - ${Math.round(data.note.size / 1024)} kb` : ''
          imageviewermeta.textContent = `${data.note.title}${sizestr}`
        }
      }
      setbinarytoolbarvisible(true, noteid)
      bindfiledownloadonce()
      connectnotesocket(noteid)
    } else {
      const ismd = ismarkdownfile(noteid)
      showtexteditor(ismd)
      const currentcontent = data.note.content || ''
      const seendata = getspotseen(noteid)
      const myid = state.currentuser?.id || state.currentuser?.user_id || ''
      const createdby = data.note.created_by || 'external'
      const lastauthor = data.note.last_author || createdby || 'external'

      // case 1: brand new note created during this session by someone else --------------------
      const isbrandnew = !seendata
      const isduringsession = iscreatedduringsession(noteid, data.note)
      const isothercreator = isbrandnew && isduringsession && createdby && createdby !== myid && currentcontent.trim().length > 0

      // case 2: note was modified since local user last saw it --------------------
      const hasunseenchanges = seendata && seendata.content !== currentcontent

      if (ismd) {
        const editor = inittiptapeditor()
        if (editor) {
          try {
            ed.isremoteapplying = true
            if (isothercreator) {
              editor.commands.setContent(cleanmarkdown(currentcontent), { emitUpdate: false })
              const creatorcolor = resolveauthorcolor(createdby)
              flashwholenote(createdby, creatorcolor)
            } else if (hasunseenchanges) {
              editor.commands.setContent(cleanmarkdown(seendata.content), { emitUpdate: false })
              const olddoc = editor.state.doc
              editor.commands.setContent(cleanmarkdown(currentcontent), { emitUpdate: false })
              const authorcolor = resolveauthorcolor(lastauthor)
              renderflashhighlight(olddoc, editor.state.doc, [], authorcolor, lastauthor)
            } else {
              editor.commands.setContent(cleanmarkdown(currentcontent), { emitUpdate: false })
            }
          } finally {
            setTimeout(() => {
              ed.isremoteapplying = false
            }, 50)
          }
          updatetoolbarstate()
        }
      } else {
        setcmcontent(currentcontent, noteid)

        if (isothercreator) {
          const creatorcolor = resolveauthorcolor(createdby)
          flashwholecmnote(createdby, creatorcolor)
        } else if (hasunseenchanges) {
          const authorcolor = resolveauthorcolor(lastauthor)
          rendercmflashhighlight(seendata.content, currentcontent, [], authorcolor, lastauthor)
        }
      }

      writespotseen(noteid, currentcontent)
      connectnotesocket(noteid)
    }

    // persist last open note into user preferences on server --------------------
    if (state.currentuser) {
      if (!state.currentuser.preferences) state.currentuser.preferences = {}
      if (state.currentuser.preferences['last-open-note'] !== noteid) {
        state.currentuser.preferences['last-open-note'] = noteid
        api('/api/user/preferences', {
          method: 'POST',
          body: JSON.stringify({
            preferences: { 'last-open-note': noteid }
          })
        }).catch(() => {})
      }
    }

    updateviewpagebutton()
    saveworkspacestate()
  } catch (err) {
    console.error('failed to read note', err)
  }
}


// boot --------------------
initplaineditor()
initeditoraskaimenu()
initeditorselectionpin()
initeditorlinkevents()
inittoolbartips()
bindeditorcursorscroll()
bindfiledownloadonce()
import('./history/history-viewer.js').then((m) => m.inithistoryviewer()).catch(() => {})
