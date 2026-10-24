// Ukrainian phone numbers: parse any pasted form to +380XXXXXXXXX, and format as the user types.
// Shared by the dialog script (client) and the endpoint validation (server). No imports: stays tiny in the bundle.

const NATIONAL_LEN = 9;

/** Returns "" for an empty value, "+380XXXXXXXXX" for a complete number, or null when invalid/incomplete. */
export function normalizePhone(raw: string): string | null {
  const s = raw.trim();
  if (s === "") return "";
  const body = s.replace(/[\s().-]/g, "");
  if (!/^\+?\d+$/.test(body)) return null;
  const digits = body.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("380")) return `+${digits}`;
  if (digits.length === 10 && digits.startsWith("0") && !body.startsWith("+")) return `+38${digits}`;
  return null;
}

/** National part (up to 9 digits after +380) of whatever the user typed or pasted. */
export function nationalDigits(raw: string): string {
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("380")) d = d.slice(3);
  else if (d.startsWith("0")) d = d.slice(1);
  else if (d.length < 3 && "380".startsWith(d)) d = "";
  return d.slice(0, NATIONAL_LEN);
}

/** `+380 (XX) XXX-XX-XX`, built without trailing separators so Backspace always removes a digit. */
export function formatPhone(raw: string, deleting = false): string {
  const n = nationalDigits(raw);
  if (!n) return deleting || !/\d/.test(raw) ? "" : "+380";
  let out = `+380 (${n.slice(0, 2)}`;
  if (n.length > 2) out += `) ${n.slice(2, 5)}`;
  if (n.length > 5) out += `-${n.slice(5, 7)}`;
  if (n.length > 7) out += `-${n.slice(7, 9)}`;
  return out;
}

/** `+380 50 123 45 67` (the booking form's mask, as the app's field shows it). Empty input stays empty. */
export function formatPhoneGrouped(raw: string, deleting = false): string {
  const n = nationalDigits(raw);
  if (!n) return deleting || !/\d/.test(raw) ? "" : "+380";
  const parts = [n.slice(0, 2), n.slice(2, 5), n.slice(5, 7), n.slice(7, 9)].filter(Boolean);
  return `+380 ${parts.join(" ")}`;
}
