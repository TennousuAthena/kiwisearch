importScripts('shared.js');

// What a Manifest V3 service worker offers for WebRTC (expected: nothing) and for the crypto layer.
self.swProbe = async () => ({
  RTCPeerConnection: typeof self.RTCPeerConnection,
  RTCDataChannel: typeof self.RTCDataChannel,
  RTCCertificate: typeof self.RTCCertificate,
  offscreen: typeof chrome.offscreen?.createDocument,
  offscreenReasons: chrome.offscreen?.Reason ? Object.keys(chrome.offscreen.Reason) : null,
  crypto: await cryptoProbe(),
});

self.openOffscreen = async (url = 'offscreen.html') => {
  if (await chrome.offscreen.hasDocument?.()) return 'already';
  await chrome.offscreen.createDocument({ url, reasons: ['WEB_RTC'], justification: 'Device sync feasibility probe' });
  return 'created';
};
self.closeOffscreen = async () => { await chrome.offscreen.closeDocument(); return 'closed'; };

// Lets the offscreen document wake a stopped service worker (the check needs one to reopen the document).
chrome.runtime.onMessage.addListener((message, _sender, reply) => { if (message === 'wake') reply('awake'); });
