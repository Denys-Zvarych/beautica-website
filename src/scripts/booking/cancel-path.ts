// The cancel link's two accepted shapes (`/c/{16}`, legacy `/book/cancel/{uuid}`) and the token <-> path helpers. Own module: the calendar chooser (which the cancel page loads
// lazily) needs them without pulling the whole booking API (api.ts re-exports these).
const CANCEL_SHORT = /^\/c\/[0-9A-Za-z]{16}$/;
const CANCEL_LEGACY = /^\/book\/cancel\/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** The cancel page lives on this site: keep only the `/c/{16}` (or legacy `/book/cancel/{uuid}`) path of whatever origin the backend put in the URL. */
export function cancelPath(cancelUrl: string | null): string | null {
  if (!cancelUrl) return null;
  try {
    const p = new URL(cancelUrl, "https://beautica.app").pathname;
    return CANCEL_SHORT.test(p) || CANCEL_LEGACY.test(p) ? p : null;
  } catch {
    return null;
  }
}

/** The cancel token = the last segment of an already-validated `/c/{16}` or `/book/cancel/{uuid}` path (`cancelPath`). */
export function cancelToken(path: string | null): string | null {
  return path && (CANCEL_SHORT.test(path) || CANCEL_LEGACY.test(path)) ? path.slice(path.lastIndexOf("/") + 1) : null;
}

/** The reverse of `cancelToken`: a bare token (`/api/ics?c=`) back to its cancel path, only for the two accepted shapes; anything else is `null`. */
export function cancelPathFromToken(token: string | null): string | null {
  if (!token) return null;
  for (const path of [`/c/${token}`, `/book/cancel/${token}`]) if (CANCEL_SHORT.test(path) || CANCEL_LEGACY.test(path)) return path;
  return null;
}
