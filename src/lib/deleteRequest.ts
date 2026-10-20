// Account-deletion request: field rules shared by the endpoint, and the outgoing message builder.
import { t } from "../i18n/t";
import { normalizePhone } from "./phone";

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
  const phoneRaw = clean(form.get("phone"));
  const phone = phoneRaw.length > PHONE_MAX ? null : normalizePhone(phoneRaw);
  const role = clean(form.get("role"));
  const comment = clean(form.get("comment"), true);
  const consent = clean(form.get("consent"));
  const fields: Field[] = [];
  if (!email || email.length > EMAIL_MAX || !EMAIL_RE.test(email)) fields.push("email");
  if (phone === null) fields.push("phone");
  if (!(ROLES as readonly string[]).includes(role)) fields.push("role");
  if (comment.length > COMMENT_MAX) fields.push("comment");
  if (!["on", "true", "1"].includes(consent)) fields.push("consent");
  if (fields.length) return { ok: false, fields };
  return { ok: true, value: { email, phone: phone ?? "", role: role as Role, comment } };
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
  ].join("\n");
}

/**
 * Structured message for `env.DELETION_MAIL.send(...)` (Cloudflare Email Service Workers API, the documented way:
 * Cloudflare builds the MIME and sets Date, Message-ID, encoding and DKIM). Reply-To is validated by EMAIL_RE.
 */
export function buildMessage(r: DeleteRequest, now: Date = new Date()) {
  return {
    from: { email: MAIL_FROM, name: "Beautica" },
    to: MAIL_TO,
    replyTo: r.email,
    subject: t("deleteRequest.mailSubject"),
    text: buildBody(r, now),
  };
}
