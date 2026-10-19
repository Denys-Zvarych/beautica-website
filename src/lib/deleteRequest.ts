// Account-deletion request: field rules shared by the endpoint, and the raw MIME builder.
// No MIME dependency on purpose: one fixed plain-text message (headers + base64 UTF-8 body) is ~40 lines and
// adds nothing to the Worker bundle. Header values never come from raw user input except Reply-To, which is
// validated against a strict address pattern that cannot contain CR/LF/space.
import { t } from "../i18n/t";

export const ROLES = ["client", "master", "owner", "staff", "unknown"] as const;
export type Role = (typeof ROLES)[number];

export const EMAIL_MAX = 254;
export const PHONE_MAX = 32;
export const COMMENT_MAX = 1000;

export const MAIL_FROM = "noreply@beautica.app";
export const MAIL_TO = "beautica.ua@gmail.com";

export interface DeleteRequest {
  email: string;
  phone: string;
  role: Role;
  comment: string;
}
export type Field = "email" | "phone" | "role" | "comment" | "consent";

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const PHONE_RE = /^[0-9+()\-\s.]*$/;
// C0/C1 controls and DEL, except \n and \t which are kept in the comment.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/g;

export function clean(value: FormDataEntryValue | null, multiline = false): string {
  const s = typeof value === "string" ? value.normalize("NFC") : "";
  return s.replace(CONTROL_RE, "").replace(multiline ? /\r\n?/g : /[\n\t]/g, multiline ? "\n" : " ").trim();
}

/** Returns the clean request, or the list of invalid fields. */
export function validate(form: FormData): { ok: true; value: DeleteRequest } | { ok: false; fields: Field[] } {
  const email = clean(form.get("email"));
  const phone = clean(form.get("phone"));
  const role = clean(form.get("role"));
  const comment = clean(form.get("comment"), true);
  const consent = clean(form.get("consent"));
  const fields: Field[] = [];
  if (!email || email.length > EMAIL_MAX || !EMAIL_RE.test(email)) fields.push("email");
  if (phone.length > PHONE_MAX || !PHONE_RE.test(phone)) fields.push("phone");
  if (!(ROLES as readonly string[]).includes(role)) fields.push("role");
  if (comment.length > COMMENT_MAX) fields.push("comment");
  if (!["on", "true", "1"].includes(consent)) fields.push("consent");
  if (fields.length) return { ok: false, fields };
  return { ok: true, value: { email, phone, role: role as Role, comment } };
}

const enc = new TextEncoder();

function b64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** RFC 2047 encoded-words, each <= 75 chars, split on code-point boundaries and folded with CRLF+space. */
function encodeSubject(text: string): string {
  const words: string[] = [];
  let chunk = "";
  for (const ch of text) {
    if (enc.encode(chunk + ch).length > 42) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${b64(enc.encode(w))}?=`).join("\r\n ");
}

export function buildBody(r: DeleteRequest, now: Date): string {
  const none = t("deleteRequest.mailEmpty");
  return [
    t("deleteRequest.mailIntro"),
    "",
    `${t("deleteRequest.mailEmail")}: ${r.email}`,
    `${t("deleteRequest.mailPhone")}: ${r.phone || none}`,
    `${t("deleteRequest.mailRole")}: ${t(`deleteRequest.roles.${r.role}`)}`,
    `${t("deleteRequest.mailTime")}: ${now.toISOString()}`,
    "",
    `${t("deleteRequest.mailComment")}:`,
    r.comment || none,
    "",
  ].join("\r\n");
}

/** Raw RFC 5322 message for `new EmailMessage(MAIL_FROM, MAIL_TO, raw)`. */
export function buildMime(r: DeleteRequest, now: Date = new Date(), id: string = crypto.randomUUID()): string {
  const body = b64(enc.encode(buildBody(r, now))).replace(/.{1,76}/g, "$&\r\n");
  return [
    `From: Beautica <${MAIL_FROM}>`,
    `To: ${MAIL_TO}`,
    `Reply-To: ${r.email}`,
    `Subject: ${encodeSubject(t("deleteRequest.mailSubject"))}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${id}@beautica.app>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join("\r\n");
}
