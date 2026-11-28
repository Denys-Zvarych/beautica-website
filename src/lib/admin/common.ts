// Helpers shared by the /admin pages (W040 requests, W041 catalog): page number, form fields, input caps, flash-cookie size. Pure.
export const NAME_CAP = 300; // server-side cap on a typed name (code points); the backend (100 / 255) stays the authority below it
export const KEEP_MAX = 120; // typed name kept for the re-render after a failed edit (code points)

/** `?p=` / hidden `p` -> a page number >= 1 (garbage = 1). */
export const parsePage = (raw: unknown): number => {
  const n = typeof raw === "string" && /^\d{1,4}$/.test(raw) ? Number(raw) : 1;
  return n >= 1 ? n : 1;
};
/** Length in code points (what the backend counts). */
export const cp = (s: string): number => [...s].length;
/** A form field as a string ("" when absent or a File). */
export const field = (f: FormData, k: string): string => (typeof f.get(k) === "string" ? (f.get(k) as string) : "");

/** W049: flash codes of an icon upload (`?err=` / `?done=` on both /admin pages); copy lives in uk.json `admin.icons.err.*` / `admin.icons.done.*`. */
export const ICON_ERR_CODES = ["ICON_NO_FILE", "ICON_NOT_SVG", "ICON_TOO_LARGE", "ICON_BROKEN", "ICON_BAD_VIEWBOX", "ICON_FORBIDDEN", "ICON_COLOUR"] as const;
export const ICON_DONE_CODES = ["icon_added", "icon_replaced", "icon_added_approve"] as const;
export const isIconCode = (c: string | null): boolean => c !== null && (c.startsWith("ICON_") || c.startsWith("icon_"));
/** Wire name of a platform category (`chk_platform_categories_name`). */
export const WIRE = /^[A-Z][A-Z0-9_]{0,99}$/;
