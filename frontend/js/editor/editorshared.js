import { PluginKey, CMStateEffect } from './rich/tiptap.bundle.js'

// dom elements for editor --------------------
export const editorcontainer = document.getElementById('editor-container')
export const emptystate = document.getElementById('empty-state')
export const editortoolbar = document.getElementById('editor-toolbar')
export const tiptapeditorcontainer = document.getElementById('tiptap-editor')
export const plaineditorwrap = document.getElementById('plain-editor-wrap')
export const codemirroreditor = document.getElementById('codemirror-editor')
export const noteeditor = document.getElementById('note-editor')
export const editorbackdrop = document.getElementById('editor-backdrop')
export const imageviewercontainer = document.getElementById('image-viewer-container')
export const imageviewerimg = document.getElementById('image-viewer-img')
export const imageviewermeta = document.getElementById('image-viewer-meta')
export const mediavieweraudiowrap = document.getElementById('media-viewer-audio-wrap')
export const mediaviewerart = document.getElementById('media-viewer-art')
export const mediavieweraudio = document.getElementById('media-viewer-audio')
export const mediaviewervideo = document.getElementById('media-viewer-video')
export const mediaviewerpdf = document.getElementById('media-viewer-pdf')
export const mediaviewerfile = document.getElementById('media-viewer-file')
export const mediaviewerfilename = document.getElementById('media-viewer-file-name')
export const binaryfiletoolbar = document.getElementById('binary-file-toolbar')

export const btnfiledownload = document.getElementById('btn-file-download')

// plugin keys and effects --------------------
export const setflasheffect = CMStateEffect.define()
export const clearflasheffect = CMStateEffect.define()
export const remotecursormap = new Map()
export const editorcursors = document.getElementById('editor-cursors')
export const editorcursorscontent = document.getElementById('editor-cursors-content')
export const editorbodyel = () => editorcursors?.closest('.editor-body') || document.querySelector('.editor-body')
export const flashpluginkey = new PluginKey('flashhighlight')
export const pinpluginkey = new PluginKey('pinnedselection')
export const remoteselectionpluginkey = new PluginKey('remoteselection')
export const setremoteselectioneffect = CMStateEffect.define()
export const setpineffect = CMStateEffect.define()
export const clearpineffect = CMStateEffect.define()

// mutable editor state shared across modules --------------------
export const ed = {
  mediaplayernoteid: null,
  mediaplayerkind: null,
  isfiledownloadbound: false,
  tiptapinstance: null,
  cmview: null,
  cmlanguagecompartment: null,
  cmflashtimeout: null,
  collabprovider: null,
  // which editor is bound to the live yjs doc right now, rich or text or null
  collabbound: null,
  cmcollabcompartment: null,
  cmhistorycompartment: null,
  cmlockcompartment: null,
  cmundomanager: null,
  collablocktimer: null,
  fallbackedit: false,
  spotseentimer: null,
  savetimer: null,
  cursortimer: null,
  lastcursorpayload: null,
  istoolbarbound: false,
  isplainbound: false,
  flashtimeout: null,
  plainflashtimeout: null,
  isremoteapplying: false,
  draggedimagenodepos: null,
  pinnedselection: null,
  iseditorpinbound: false,
  // keep cm selection pin across right click caret move --------------------
  cmkeepselectionpin: false
}
