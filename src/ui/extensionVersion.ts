/**
 * Version from the LOADED manifest, so the header shows what Chrome actually
 * runs (not the source tree). Guarded for jsdom/tests where `chrome` is absent.
 */
export function extensionVersion(): string {
  try {
    return globalThis.chrome?.runtime?.getManifest?.().version ?? 'dev'
  } catch {
    return 'dev'
  }
}
