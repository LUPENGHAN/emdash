/**
 * Browser access (Settings → Remote access) loads this renderer over plain HTTP from
 * another computer, with no Electron preload. Imported first by the entry, so the
 * stand-ins exist before any module reads them.
 */
export const isBrowserHost = typeof window !== 'undefined' && !('electronAPI' in window);

if (isBrowserHost) {
  window.electronAPI = {
    // Browsers hide local paths; drops fall back to the renderer's upload paths.
    getPathForFile: () => '',
    requestWirePort: () => Promise.reject(new Error('No Electron preload in the browser')),
    onBootStuck: () => () => {},
    requestBootEscape: async () => window.location.reload(),
    reportBootUsable: () => {},
  };

  // randomUUID only exists in secure contexts (HTTPS or localhost); a ZeroTier address
  // over HTTP is not one, and ids are minted with it throughout the app.
  if (typeof crypto.randomUUID !== 'function') {
    Object.defineProperty(crypto, 'randomUUID', {
      configurable: true,
      value: (): `${string}-${string}-${string}-${string}-${string}` => {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6]! & 0x0f) | 0x40;
        bytes[8] = (bytes[8]! & 0x3f) | 0x80;
        const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      },
    });
  }
}
