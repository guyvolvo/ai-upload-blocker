// reads ai-sites.json, generates match patterns, registers content.js in MAIN world
// re-runs on install and startup so domain list changes take effect without manual reload

const api = typeof browser !== 'undefined' ? browser : chrome;

let initPromise = null;

function safeInit() {
  // onInstalled and onStartup fire concurrently after an update - coalesce to avoid duplicate script ID
  if (!initPromise) initPromise = init().finally(() => { initPromise = null; });
  return initPromise;
}

async function init() {
  const domains = await fetch(chrome.runtime.getURL('ai-sites.json')).then(r => r.json());

  const matches = [];
  for (const domain of domains) {
    matches.push(`*://${domain}/*`);
    matches.push(`*://*.${domain}/*`);
  }

  // unregister first so updates to ai-sites.json are picked up cleanly
  try {
    await api.scripting.unregisterContentScripts({ ids: ['ai-upload-blocker'] });
  } catch (_) {}

  const descriptor = {
    id: 'ai-upload-blocker',
    matches,
    js: ['content.js'],
    runAt: 'document_start',
    allFrames: true,
  };

  try {
    // world: MAIN required for fetch/XHR overrides (Chrome 111+, Firefox 128+, Edge 111+)
    await api.scripting.registerContentScripts([{ ...descriptor, world: 'MAIN' }]);
  } catch (_) {
    // fallback for older Firefox: DOM-level blocking only, no fetch/XHR intercept
    await api.scripting.registerContentScripts([descriptor]);
  }
}

// onInstalled fires on install AND extension update, so new ai-sites.json is picked up immediately
// onStartup is a safety net in case the registration was cleared by a browser or profile reset
chrome.runtime.onInstalled.addListener(safeInit);
chrome.runtime.onStartup.addListener(safeInit);
