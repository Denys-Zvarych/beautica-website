// Funnel events (README § 10). Umami is added by phase 007; until its script is on the page this is a no-op.
// Props are counts and codes only: never a name, phone, token or booking id.
type Props = Record<string, string | number>;

// Channel of the booking link the visitor came from (phase 013): `kind` from the path, `source` from the 1-char `?s=` flag.
// Set once by booking/channel.ts; merged into every event so the Umami funnel splits by copy / share (README § 10).
export type LinkContext = { kind: "master" | "salon"; source: "copy" | "share" | "none" };
let linkContext: LinkContext | null = null;
export const setLinkContext = (c: LinkContext): void => void (linkContext = c);
export const getLinkContext = (): LinkContext | null => linkContext;

export function track(event: string, props?: Props): void {
  const u = (window as unknown as { umami?: { track?: (e: string, p?: Props) => void } }).umami;
  try {
    u?.track?.(event, linkContext ? { ...props, kind: linkContext.kind, source: linkContext.source } : props);
  } catch {
    /* analytics must never break the flow */
  }
}
