import { GoogleGenAI } from '@google/genai'
import { loadconfig } from '../../core/config.js'

const titlemodel = 'gemini-3.5-flash-lite'

export async function generateconversationtitle(firstmessage) {
  const text = String(firstmessage || '').trim()
  if (!text) return 'new chat'

  const conf = loadconfig()
  const key = conf.gemini?.api_key
  if (!key) {
    return fallbacktitle(text)
  }

  try {
    const ai = new GoogleGenAI({ apiKey: key })
    const chat = ai.chats.create({
      model: titlemodel,
      config: {
        maxOutputTokens: 32,
        temperature: 0.3,
      },
    })
    const response = await chat.sendMessage({
      message: `write a short chat title (3 to 8 words, lowercase, no quotes) summarizing this user message:\n\n${text.slice(0, 500)}`,
    })

    let title = String(response?.text || '').trim()
    if (!title) {
      const parts = response?.candidates?.[0]?.content?.parts || []
      for (const part of parts) {
        if (typeof part.text === 'string') title += part.text
      }
      title = title.trim()
    }
    title = title.replace(/["'`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
    if (!title) return fallbacktitle(text)
    if (title.length > 80) title = title.slice(0, 77) + '...'
    return title
  } catch {
    return fallbacktitle(text)
  }
}

function fallbacktitle(text) {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return 'new chat'
  if (flat.length <= 48) return flat.toLowerCase()
  return `${flat.slice(0, 45).trim()}...`
}