import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'

// root directory resolver --------------------
const currentdir = path.dirname(fileURLToPath(import.meta.url))
const rootdir = path.resolve(currentdir, '..')

export function getrootdir() {
  return rootdir
}

// config loader and auto generator --------------------
export function loadconfig(filename = 'config.yaml') {
  const targetpath = path.join(rootdir, filename)
  const templatepath = path.join(rootdir, 'resources', 'config.example.yaml')

  if (!fs.existsSync(targetpath)) {
    if (fs.existsSync(templatepath)) {
      fs.copyFileSync(templatepath, targetpath)
    } else {
      const fallback = 'server:\n  port: 3000\n  host: localhost\nvault:\n  path: notes\nhistory:\n  path: history\n'
      fs.writeFileSync(targetpath, fallback, 'utf8')
    }
  }

  const raw = fs.readFileSync(targetpath, 'utf8')
  return parse(raw)
}

// save updated config back to yaml file --------------------
export function saveconfig(conf, filename = 'config.yaml') {
  const targetpath = path.join(rootdir, filename)
  const yamlcontent = stringify(conf)
  fs.writeFileSync(targetpath, yamlcontent, 'utf8')
}

// resolve absolute vault directory path --------------------
export function getvaultpath(config) {
  const conf = config || loadconfig()
  const rawpath = conf.vault?.path || 'notes'
  if (path.isAbsolute(rawpath)) {
    return rawpath
  }
  return path.resolve(rootdir, rawpath)
}

// resolve absolute history directory path --------------------
export function gethistorypath(config) {
  const conf = config || loadconfig()
  const rawpath = conf.history?.path || 'history'
  if (path.isAbsolute(rawpath)) {
    return rawpath
  }
  return path.resolve(rootdir, rawpath)
}
