import { api } from '../core/api.js'
import { state } from '../core/state.js'
import { loadnotes } from '../sidebar/files.js'
import { ed, noteeditor } from './editorshared.js'
import { ismarkdownfile } from './noteutils.js'

// compress and resize image to webp format --------------------
function compressimagetowebp(file, maxdim = 1920, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const img = new window.Image()
      img.onload = () => {
        let width = img.width
        let height = img.height

        if (width > maxdim || height > maxdim) {
          if (width > height) {
            height = Math.round((height * maxdim) / width)
            width = maxdim
          } else {
            width = Math.round((width * maxdim) / height)
            height = maxdim
          }
        }

        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, width, height)

        const dataurl = canvas.toDataURL('image/webp', quality)
        resolve({
          dataurl,
          width,
          height
        })
      }
      img.onerror = () => reject(new Error('failed to load image'))
      img.src = e.target.result
    }
    reader.onerror = () => reject(new Error('failed to read image file'))
    reader.readAsDataURL(file)
  })
}

// upload image file and insert markdown image tag into active note --------------------
export async function uploadandinsertimage(file, targetfolder = 'media') {
  if (!state.activenoteid) return

  try {
    const { dataurl } = await compressimagetowebp(file, 1920, 0.85)
    const timestamp = Date.now()
    const rawname = file.name && file.name !== 'image.png' && file.name !== 'blob'
      ? file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_\-]/g, '_').toLowerCase()
      : ''
    const filename = rawname ? `${rawname}-${timestamp}.webp` : `${timestamp}.webp`
    const uploadpath = targetfolder ? `${targetfolder}/${filename}` : `media/${filename}`
    const imageurl = `/${uploadpath}`
    const altname = rawname || 'image'
    const imagetag = `![${altname}](${imageurl})`

    await api('/api/upload', {
      method: 'POST',
      body: JSON.stringify({
        path: uploadpath,
        data: dataurl
      })
    })

    try {
      loadnotes()
    } catch {}

    if (!ismarkdownfile(state.activenoteid)) {
      if (ed.cmview) {
        const sel = ed.cmview.state.selection.main
        ed.cmview.dispatch({
          changes: { from: sel.from, to: sel.to, insert: imagetag },
          selection: { anchor: sel.from + imagetag.length }
        })
      } else if (noteeditor) {
        const start = noteeditor.selectionStart || 0
        const end = noteeditor.selectionEnd || 0
        noteeditor.setRangeText(imagetag, start, end, 'end')
        noteeditor.dispatchEvent(new Event('input'))
      }
    } else if (ed.tiptapinstance) {
      ed.tiptapinstance.chain().focus().setImage({ src: imageurl, alt: altname }).run()
    }
  } catch (err) {
    console.error('image upload failed', err)
  }
}

// upload pasted image into media and pastes folder --------------------
export async function handleimagepaste(file) {
  return uploadandinsertimage(file, 'media/pastes')
}

// open file picker to upload compressed image and insert at cursor --------------------
export function pickandinsertimage() {
  if (!state.activenoteid) return

  // record current cursor selection so focus return is exact --------------------
  let savedselection = null
  if (ed.tiptapinstance) {
    savedselection = ed.tiptapinstance.state.selection
  } else if (ed.cmview) {
    savedselection = ed.cmview.state.selection
  } else if (noteeditor) {
    savedselection = { start: noteeditor.selectionStart, end: noteeditor.selectionEnd }
  }

  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.style.display = 'none'

  input.addEventListener('change', async () => {
    const file = input.files?.[0]
    input.remove()
    if (!file) return

    // restore cursor selection before inserting --------------------
    if (ed.tiptapinstance && savedselection) {
      try {
        ed.tiptapinstance.commands.setTextSelection(savedselection)
      } catch {}
    } else if (ed.cmview && savedselection) {
      try {
        ed.cmview.dispatch({ selection: savedselection })
      } catch {}
    } else if (noteeditor && savedselection) {
      try {
        noteeditor.setSelectionRange(savedselection.start, savedselection.end)
      } catch {}
    }

    await uploadandinsertimage(file, 'media')
  })

  document.body.appendChild(input)
  input.click()
}

