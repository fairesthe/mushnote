import path from 'node:path'
import { parseFile } from 'music-metadata'
import { audiofilepattern } from './vault.js'

export async function extractaudiocover(filepath) {
  const ext = path.extname(filepath).toLowerCase()
  if (!audiofilepattern.test(ext)) {
    return null
  }
  try {
    const meta = await parseFile(filepath, { duration: false })
    const pic = meta.common.picture?.[0]
    if (!pic?.data?.length) {
      return null
    }
    return {
      data: pic.data,
      mimetype: pic.format || 'image/jpeg',
    }
  } catch {
    return null
  }
}