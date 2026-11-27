chrome.runtime.sendMessage({ type: 'MUSHNOTE_GET_PANEL_CONFIG' }, (res) => {
  if (res?.origin) {
    const tokenparam = res.token ? `&token=${encodeURIComponent(res.token)}` : ''
    const convparam = res.convId ? `&conv=${encodeURIComponent(res.convId)}` : ''
    document.getElementById('frame').src = `${res.origin}/editor?panel=ai${tokenparam}${convparam}`
  }
})
