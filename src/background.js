// Injects the scanner into the active tab only when the user clicks the icon
// (or presses Alt+Shift+S). No host permissions: activeTab grants access to
// the clicked tab for this one action.
const FILES = ['src/rules.js', 'src/scanner.js', 'src/export.js', 'src/ui.js'];

async function run(tab) {
  if (!tab || !tab.id) return;
  const target = { tabId: tab.id };
  try {
    const [probe] = await chrome.scripting.executeScript({
      target,
      func: () => Boolean(globalThis.__slopTeller),
    });
    if (probe && probe.result) {
      await chrome.scripting.executeScript({ target, func: () => globalThis.__slopTeller.toggle() });
    } else {
      await chrome.scripting.executeScript({ target, files: FILES });
    }
  } catch (err) {
    // Chrome blocks extensions on chrome:// pages, the Web Store, and file://
    // pages unless "Allow access to file URLs" is on for this extension.
    console.warn('Slop Teller could not run on this page:', err && err.message);
  }
}

chrome.action.onClicked.addListener(run);
