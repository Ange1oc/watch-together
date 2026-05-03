// background.js — minimal service worker
// Acts as a message relay between popup and content scripts when needed.

chrome.runtime.onInstalled.addListener(() => {
  console.log('Rezka Sync installed');
});
