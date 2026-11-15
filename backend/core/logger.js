import fs from 'node:fs'
import path from 'node:path'

// active theme with generic semantic names for easy swapping --------------------
export const theme = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  text: '\x1b[38;2;245;247;250m',    // Crisp off-white
  accent: '\x1b[38;2;95;155;215m',   // Steel blue
  primary: '\x1b[38;2;65;115;170m',  // Deep slate blue
  regular: '\x1b[38;2;185;195;210m', // Cool light gray-blue
  good: '\x1b[38;2;115;175;125m',    // Sage green
  bad: '\x1b[38;2;215;85;85m',       // Coral red
  warn: '\x1b[38;2;215;165;90m',     // Muted amber
  muted: '\x1b[38;2;130;140;155m',   // Slate gray
  gradientstart: [185, 225, 195], // Soft sage highlight
  gradientend: [85, 140, 105],    // Deep forest green
}

// silence known noisy google genai internal sdk warning on function calls --------------------
const origwarn = console.warn.bind(console)
console.warn = (...args) => {
  const msg = typeof args[0] === 'string' ? args[0] : ''
  if (msg.includes('there are non-text parts') && msg.includes('functionCall')) {
    return
  }
  origwarn(...args)
}

// format current time string --------------------
function formattime() {
  const d = new Date()
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  return `${theme.dim}${theme.muted}${h}:${m}:${s}${theme.reset}`
}

// format tag badge with semantic theme color --------------------
function formattag(name, color) {
  return `${color}${theme.bold}[${name}]${theme.reset}`
}

// format message line with consistent spacing --------------------
function printline(tagname, tagcolor, action, target, detail = '') {
  const time = formattime()
  const badge = formattag(tagname, tagcolor)
  const act = `${theme.bold}${action.padEnd(8)}${theme.reset}`
  const tgt = target ? `${theme.regular}${target}${theme.reset}` : ''
  const extra = detail ? ` ${theme.dim}${theme.muted}${detail}${theme.reset}` : ''
  console.log(`${time} ${badge} ${act} ${tgt}${extra}`)
}

// startup banner from resources ascii file with diagonal gradient --------------------
export function printbanner(port, host, vaultdir, historydir, asciipath = '') {
  let asciilines = []
  const filepath = asciipath || path.join(process.cwd(), 'resources', 'ascii.txt')
  try {
    if (fs.existsSync(filepath)) {
      const raw = fs.readFileSync(filepath, 'utf8')
      asciilines = raw.split(/\r?\n/)
    }
  } catch { }

  console.log('')
  if (asciilines.length > 0) {
    const maxy = Math.max(1, asciilines.length - 1)
    const maxx = Math.max(1, ...asciilines.map(l => Math.max(0, l.length - 1)))
    const c1 = theme.gradientstart || [249, 115, 22]
    const c2 = theme.gradientend || [253, 230, 138]

    asciilines.forEach((line, y) => {
      let coloredline = ''
      for (let x = 0; x < line.length; x++) {
        const ch = line[x]
        if (ch === ' ') {
          coloredline += ' '
          continue
        }
        // interpolate smoothly along diagonal from top left to bottom right --------------------
        const t = (x + y) / (maxx + maxy)
        const r = Math.round(c1[0] + (c2[0] - c1[0]) * t)
        const g = Math.round(c1[1] + (c2[1] - c1[1]) * t)
        const b = Math.round(c1[2] + (c2[2] - c1[2]) * t)
        coloredline += `\x1b[38;2;${r};${g};${b}m${ch}`
      }
      console.log(`${coloredline}${theme.reset}`)
    })
    console.log('')
  }

  console.log(` ${theme.primary}*${theme.reset} ${theme.muted}server${theme.reset}   ${theme.dim}-->${theme.reset} ${theme.good}http://${host}:${port}${theme.reset}`)
  console.log(` ${theme.primary}*${theme.reset} ${theme.muted}vault${theme.reset}    ${theme.dim}-->${theme.reset} ${theme.regular}${vaultdir}${theme.reset}`)
  console.log(` ${theme.primary}*${theme.reset} ${theme.muted}history${theme.reset}  ${theme.dim}-->${theme.reset} ${theme.regular}${historydir}${theme.reset}\n`)
}

// event logger helpers with semantic colors --------------------
export const log = {
  server(action, target, detail) {
    printline('server', theme.accent, action, target, detail)
  },
  note(action, target, detail) {
    printline('note', theme.regular, action, target, detail)
  },
  vault(action, target, detail) {
    printline('vault', theme.warn, action, target, detail)
  },
  agent(action, target, detail) {
    printline('agent', theme.accent, action, target, detail)
  },
  auth(action, target, detail) {
    printline('auth', theme.primary, action, target, detail)
  },
  watcher(action, target, detail) {
    printline('watcher', theme.warn, action, target, detail)
  },
  info(action, target, detail) {
    printline('info', theme.muted, action, target, detail)
  },
  warn(action, target, detail) {
    printline('warn', theme.warn, action, target, detail)
  },
  error(action, target, detail) {
    printline('error', theme.bad, action, target, detail)
  }
}

// express request logger that only logs errors to keep terminal clean --------------------
export function requestlogger(req, res, next) {
  const start = Date.now()
  res.on('finish', () => {
    // only log actual client or server errors --------------------
    if (res.statusCode >= 400) {
      const duration = Date.now() - start
      const statusstr = `${theme.bad}${res.statusCode}${theme.reset}`
      const durationstr = `${duration}ms`
      const url = req.originalUrl || req.url
      printline('http', theme.bad, req.method, url, `${statusstr} ${durationstr}`)
    }
  })
  next()
}
