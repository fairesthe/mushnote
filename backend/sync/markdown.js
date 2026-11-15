import { Window } from 'happy-dom'

// tiptap markdown parsing goes through html so the server needs a fake dom --------------------
const fakewindow = new Window({ url: 'http://localhost/' })
const domglobals = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'DOMParser', 'navigator', 'getComputedStyle']
for (const key of domglobals) {
  if (globalThis[key] !== undefined) continue
  const val = key === 'window' ? fakewindow : fakewindow[key]
  try {
    Object.defineProperty(globalThis, key, {
      value: typeof val === 'function' && key === 'getComputedStyle' ? val.bind(fakewindow) : val,
      configurable: true,
      writable: true
    })
  } catch {}
}

const { Editor, createDocument } = await import('@tiptap/core')
const { notecontentextensions, patchnotemarkdown, notemarkdownforsave, cleanmarkdown } = await import('./noteschema.js')

// one headless editor is enough since parse and serialize are synchronous --------------------
const holder = fakewindow.document.createElement('div')
const editor = new Editor({
  element: holder,
  extensions: notecontentextensions({ headless: true }),
  content: ''
})
patchnotemarkdown(editor)

export const noteschema = editor.schema

// markdown string to prosemirror doc node --------------------
export function markdowntodoc(markdown) {
  const html = editor.storage.markdown.parser.parse(cleanmarkdown(markdown || ''))
  return createDocument(html, editor.schema)
}

// prosemirror doc node to the markdown we save --------------------
export function doctomarkdown(doc) {
  return notemarkdownforsave(editor, doc)
}
