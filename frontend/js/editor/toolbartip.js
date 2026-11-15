// floating tip under the editor toolbar
// follows the pointer on x, stays locked just below the bar on y --------------------

import { editortoolbar } from './editorshared.js'

const tipgap = 6
let tipel = null
let activetoolbar = null
let tiptext = ''
let tipvisible = false
let docbound = false

function ensuretip() {
  if (tipel) return tipel
  tipel = document.getElementById('toolbar-tip')
  if (!tipel) {
    tipel = document.createElement('div')
    tipel.id = 'toolbar-tip'
    tipel.className = 'toolbar-tip'
    tipel.setAttribute('aria-hidden', 'true')
    document.body.appendChild(tipel)
  }
  return tipel
}

function hidetip() {
  const tip = ensuretip()
  tip.classList.remove('is-visible')
  tipvisible = false
  tiptext = ''
  activetoolbar = null
}

function placetip(clientx, toolbar) {
  const tip = ensuretip()
  if (!toolbar) return
  const bar = toolbar.getBoundingClientRect()
  const pad = 8
  const half = tip.offsetWidth / 2 || 0
  const x = Math.min(Math.max(clientx, pad + half), window.innerWidth - pad - half)
  tip.style.left = `${x}px`
  tip.style.top = `${bar.bottom + tipgap}px`
}

function pointintoolbar(toolbar, clientx, clienty) {
  if (!toolbar || toolbar.classList.contains('hidden')) return false
  const bar = toolbar.getBoundingClientRect()
  return clientx >= bar.left && clientx <= bar.right && clienty >= bar.top && clienty <= bar.bottom
}

function showtip(btn, toolbar, clientx) {
  const text = (btn?.dataset?.tip || '').trim()
  if (!text || !toolbar) return

  const tip = ensuretip()
  activetoolbar = toolbar
  // swap label instantly while staying visible so moving across buttons does not fade --------------------
  if (tiptext !== text) {
    tiptext = text
    tip.textContent = text
  }
  placetip(clientx, toolbar)
  if (!tipvisible) {
    tipvisible = true
    tip.classList.add('is-visible')
  }
}

function ondocpointermove(e) {
  if (!tipvisible || !activetoolbar) return

  // whole toolbar rect counts (buttons, gaps, spacer, blank padding) --------------------
  if (!pointintoolbar(activetoolbar, e.clientX, e.clientY)) {
    hidetip()
    return
  }

  const btn = e.target.closest?.('.toolbar-btn')
  if (btn && activetoolbar.contains(btn)) {
    showtip(btn, activetoolbar, e.clientX)
    return
  }
  placetip(e.clientX, activetoolbar)
}

function bindtoolbar(toolbar) {
  if (!toolbar || toolbar.dataset.tipBound === '1') return
  toolbar.dataset.tipBound = '1'

  // migrate any leftover native titles --------------------
  toolbar.querySelectorAll('.toolbar-btn[title]').forEach((btn) => {
    if (!btn.dataset.tip) btn.dataset.tip = btn.getAttribute('title')
    btn.removeAttribute('title')
  })

  toolbar.addEventListener('pointerover', (e) => {
    const btn = e.target.closest('.toolbar-btn')
    if (!btn || !toolbar.contains(btn)) return
    showtip(btn, toolbar, e.clientX)
  })
}

export function inittoolbartips() {
  ensuretip()
  bindtoolbar(editortoolbar)
  if (!docbound) {
    docbound = true
    // track by bar geometry so flex gaps and blank space do not drop the tip --------------------
    document.addEventListener('pointermove', ondocpointermove)
  }
}
