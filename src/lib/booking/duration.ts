// The two format helpers the calendar text needs, kept apart from format.ts so the /c/ cancel page's calendar chunk does not pull in the whole of format.ts (re-exported there).

export const KYIV = "Europe/Kyiv";
export const nbsp = "\u00A0";

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (minutes < 60) return `${minutes}${nbsp}хв`;
  return m ? `${h}${nbsp}год${nbsp}${m}${nbsp}хв` : `${h}${nbsp}год`;
}
