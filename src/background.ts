// The service worker does one thing: make the toolbar icon open the side panel.
// The pipeline deliberately does NOT live here — it runs in the side panel page,
// which stays alive as long as the user is looking at it, so MV3's idle
// service-worker shutdown can never kill a long Gemini call mid-flight.
chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
})

// Also on every worker start: onInstalled does not fire on browser restart in
// all Chrome versions, and setPanelBehavior is idempotent.
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})

export {}
