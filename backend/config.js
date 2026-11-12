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

// resolve active config file location in vault or root --------------------
export function getconfigfile() {
  const vaultsystempath = path.join(rootdir, 'vault', 'system', 'config.yaml')
  if (fs.existsSync(vaultsystempath)) {
    return vaultsystempath
  }
  const notessystempath = path.join(rootdir, 'notes', 'system', 'config.yaml')
  if (fs.existsSync(notessystempath)) {
    return notessystempath
  }
  const rootconfigpath = path.join(rootdir, 'config.yaml')
  if (fs.existsSync(rootconfigpath)) {
    return rootconfigpath
  }
  return vaultsystempath
}

// config loader and auto generator --------------------
export function loadconfig(filename = null) {
  const targetpath = (filename && filename !== 'config.yaml')
    ? path.resolve(rootdir, filename)
    : getconfigfile()
  const templatepath = path.join(rootdir, 'resources', 'config.example.yaml')

  if (!fs.existsSync(targetpath)) {
    const parentdir = path.dirname(targetpath)
    if (!fs.existsSync(parentdir)) {
      fs.mkdirSync(parentdir, { recursive: true })
    }
    if (fs.existsSync(templatepath)) {
      fs.copyFileSync(templatepath, targetpath)
    } else {
      const fallback = 'server:\n  port: 3000\n  host: localhost\nvault:\n  path: vault\nhistory:\n  path: history\n'
      fs.writeFileSync(targetpath, fallback, 'utf8')
    }
  }

  const raw = fs.readFileSync(targetpath, 'utf8')
  return parse(raw)
}

// save updated config back to yaml file --------------------
export function saveconfig(conf, filename = null) {
  const targetpath = (filename && filename !== 'config.yaml')
    ? path.resolve(rootdir, filename)
    : getconfigfile()
  const parentdir = path.dirname(targetpath)
  if (!fs.existsSync(parentdir)) {
    fs.mkdirSync(parentdir, { recursive: true })
  }
  const yamlcontent = stringify(conf)
  fs.writeFileSync(targetpath, yamlcontent, 'utf8')
}

// resolve absolute vault directory path --------------------
export function getvaultpath(config) {
  const conf = config || loadconfig()
  const rawpath = conf.vault?.path || 'vault'
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
