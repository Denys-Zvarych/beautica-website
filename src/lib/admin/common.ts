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
