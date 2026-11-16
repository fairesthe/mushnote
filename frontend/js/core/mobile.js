// mobile mode is frozen from the url path for the whole session --------------------
const MOBILE_BREAKPOINT = 768

export function ismobilepath(pathname = window.location.pathname) {
  const path = String(pathname || '').replace(/\/+$/, '') || '/'
  return path === '/mobile' || path.endsWith('/mobile')
}

export function ismobilemode() {
  return document.body?.classList.contains('is-mobile') || ismobilepath()
}

export function workspacepathformobile(mobile) {
  return mobile ? '/mobile' : '/editor'
}

export function pickworkspacepath(width = window.innerWidth) {
  return workspacepathformobile(width <= MOBILE_BREAKPOINT)
}

export function currentworkspacepath() {
  return ismobilemode() ? '/mobile' : '/editor'
}

// call once at boot so layout and tabs stay put --------------------
export function applymobileboot() {
  const mobile = ismobilepath()
  document.body.classList.toggle('is-mobile', mobile)
  document.documentElement.classList.toggle('is-mobile', mobile)
  if (mobile) {
    document.body.dataset.mobilePanel = document.body.dataset.mobilePanel || 'ai'
    initmobilekeyboard()
  } else {
    delete document.body.dataset.mobilePanel
  }
  return mobile
}

// standard mobile keyboard fix:
// leave layout viewport alone, export inset, lift chrome with bottom
// focus with preventScroll so safari does not pan the page --------------------
export function initmobilekeyboard() {
  const root = document.documentElement
  let frame = 0
  let focused = false

    const sync = () => {
      // zero window scroll immediately before and inside rAF to kill the browser bounce --------------------
      if (window.scrollY > 0 || window.scrollX > 0) window.scrollTo(0, 0)
      if (document.body.scrollTop > 0) document.body.scrollTop = 0
      if (root.scrollTop > 0) root.scrollTop = 0

          cancelAnimationFrame(frame)
          frame = requestAnimationFrame(() => {
            const vv = window.visualViewport
            const layoutH = window.innerHeight || root.clientHeight
            let iskeyboard = false

            if (vv) {
              if (vv.height < (window.screen?.height ? window.screen.height * 0.75 : layoutH * 0.85)) {
                iskeyboard = true
              }
              // on ios safari, offsetTop can become non-zero during auto-pan
              // bound inset to layoutH - vv.height so the panel bottom aligns with keyboard top --------------------
              const keyboardHeight = Math.max(0, layoutH - vv.height)
              const offsetTop = vv.offsetTop || 0
              root.style.setProperty('--keyboard-inset', `${keyboardHeight}px`)
              root.style.setProperty('--keyboard-offset-top', `${offsetTop}px`)
            } else {
              root.style.setProperty('--keyboard-inset', '0px')
              root.style.setProperty('--keyboard-offset-top', '0px')
            }

            if (focused && window.innerHeight < window.outerHeight * 0.75) {
              iskeyboard = true
            }

          document.body.classList.toggle('keyboard-open', iskeyboard)
          if (!iskeyboard) {
            root.style.setProperty('--keyboard-inset', '0px')
            root.style.setProperty('--keyboard-offset-top', '0px')
          }

          // keep window from ever scrolling the outer page --------------------
          if (window.scrollY > 0 || window.scrollX > 0) {
            window.scrollTo(0, 0)
          }
          if (document.body.scrollTop > 0) document.body.scrollTop = 0
          if (root.scrollTop > 0) root.scrollTop = 0
        })
      }

      const onfocusin = (e) => {
        const t = e.target
        if (!(t instanceof HTMLElement)) return
        if (t.matches('textarea, input, [contenteditable="true"]')) {
          focused = true

          // ensure page starts at true zero so safari does not calculate negative offset --------------------
          window.scrollTo(0, 0)
          if (document.body.scrollTop > 0) document.body.scrollTop = 0
          if (root.scrollTop > 0) root.scrollTop = 0
          sync()

          // continuous lock during the 350ms keyboard opening animation --------------------
          const start = Date.now()
          const lockframe = () => {
            if (window.scrollY > 0 || window.scrollX > 0) window.scrollTo(0, 0)
            if (document.body.scrollTop > 0) document.body.scrollTop = 0
            if (root.scrollTop > 0) root.scrollTop = 0
              sync()
              if (Date.now() - start < 350) {
                requestAnimationFrame(lockframe)
              }
            }
            requestAnimationFrame(lockframe)
          }
        }

        const onfocusout = () => {
          focused = false
          sync()
          // force synchronous webkit layout reflow and scroll zero on dismiss --------------------
          window.scrollTo(0, 0)
          void document.body.offsetHeight
          if (document.body.scrollTop > 0) document.body.scrollTop = 0
          if (root.scrollTop > 0) root.scrollTop = 0

          // reset leftover scroll and visualviewport offset ghosting on keyboard dismiss --------------------
          setTimeout(() => {
            window.scrollTo(0, 0)
            void document.body.offsetHeight
            if (document.body.scrollTop > 0) document.body.scrollTop = 0
            if (root.scrollTop > 0) root.scrollTop = 0
            sync()
          }, 80)
          setTimeout(() => {
            window.scrollTo(0, 0)
            void document.body.offsetHeight
            sync()
          }, 280)
        }

        document.addEventListener('focusin', onfocusin)
        document.addEventListener('focusout', onfocusout)

        if (window.visualViewport) {
          window.visualViewport.addEventListener('resize', sync)
          window.visualViewport.addEventListener('scroll', sync)
        }
        window.addEventListener('resize', sync)

        sync()
      }

      export function getmobilepanel() {
        return document.body?.dataset?.mobilePanel || 'ai'
      }

      export function setmobilepanel(panel) {
        if (!ismobilemode()) return
        const next = panel === 'files' || panel === 'note' || panel === 'ai' ? panel : 'ai'
        document.body.dataset.mobilePanel = next
        document.querySelectorAll('.mobile-nav-btn').forEach((btn) => {
          btn.classList.toggle('is-active', btn.dataset.panel === next)
        })

        // keep desktop collapse classes in sync so shared code keeps working --------------------
        const sidebar = document.getElementById('sidebar-pane')
        const aidrawer = document.getElementById('ai-drawer')
        if (sidebar) sidebar.classList.toggle('is-collapsed', next !== 'files')
        if (aidrawer) aidrawer.classList.toggle('is-collapsed', next !== 'ai')

        if (next === 'ai') {
          const aiinput = document.getElementById('ai-input')
          import('../chat/assistant.js').then((m) => m.resizeaiinput?.()).catch(() => { })
          if (aiinput) {
            try {
              aiinput.focus()
            } catch { }
          }
        }
      }
