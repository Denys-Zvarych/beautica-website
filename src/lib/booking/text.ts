// Guest-entered text, cleaned to what the backend accepts (GuestBookingRequest): name / surname `^[^\p{Cntrl}]*$` (no control character, even
// a pasted tab), comment: no control character except \n and \t. Without this a pasted tab would only fail AFTER the SMS code was spent.
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001F\u007F]/g;
// eslint-disable-next-line no-control-regex
const COMMENT_CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** While typing: control characters become a space, runs of whitespace collapse to one (the trailing space is kept so typing a second word works). */
export function typingName(raw: string): string {
  return raw.replace(CTRL, " ").replace(/\s{2,}/g, " ").replace(/^\s+/, "");
}
/** What is sent / shown: also trimmed. */
export function cleanName(raw: string): string {
  return raw.replace(CTRL, " ").replace(/\s+/g, " ").trim();
}
/** Comment: disallowed control characters removed, \r\n -> \n, trimmed. Line breaks and tabs stay (the backend allows them). */
export function cleanComment(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").replace(COMMENT_CTRL, "").trim();
}
