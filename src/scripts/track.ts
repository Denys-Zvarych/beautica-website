// Funnel events (README § 10). Umami is added by phase 007; until its script is on the page this is a no-op.
// Props are counts and codes only: never a name, phone, token or booking id.
type Props = Record<string, string | number>;
export function track(event: string, props?: Props): void {
  const u = (window as unknown as { umami?: { track?: (e: string, p?: Props) => void } }).umami;
  try {
    u?.track?.(event, props);
  } catch {
    /* analytics must never break the flow */
  }
}
