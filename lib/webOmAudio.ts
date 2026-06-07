/**
 * Web-only Om completion-sound source.
 *
 * On web the Om was loaded from a network URL ('/om_complete.mp3'), so it could NOT play once the
 * browser went offline (no service worker to serve it). This fetches the mp3 into an in-memory
 * `blob:` object URL ONCE while online, so completion playback works offline after the app has been
 * loaded online at least once. Falls back to the network URL if the fetch fails. No service worker.
 *
 * Native callers don't use this — they require() the bundled asset.
 */

const OM_URL = '/om_complete.mp3';

let blobUrl: string | null = null;
let inflight: Promise<string | null> | null = null;

/** Resolve a usable URI for Audio.Sound.createAsync on web (cached blob:, else the network URL). */
export async function getWebOmAudioUri(): Promise<string> {
  if (
    typeof fetch === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return OM_URL;
  }
  if (blobUrl) return blobUrl;
  if (!inflight) {
    inflight = (async () => {
      try {
        const resp = await fetch(OM_URL, { cache: 'force-cache' });
        if (!resp.ok) return null;
        const blob = await resp.blob();
        blobUrl = URL.createObjectURL(blob);
        return blobUrl;
      } catch {
        return null;
      } finally {
        inflight = null;
      }
    })();
  }
  const resolved = await inflight;
  return resolved || OM_URL;
}

/** Release the cached blob URL (e.g. on full unload). Safe to call when nothing is cached. */
export function releaseWebOmAudio(): void {
  if (blobUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    try {
      URL.revokeObjectURL(blobUrl);
    } catch {}
  }
  blobUrl = null;
}
