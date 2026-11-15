// Pin digests of the legal documents (tests/booking-config.test.mjs, fixtures in tests/fixtures/*-versions.json).
import { createHash } from "node:crypto";
import { applyLegalVars } from "../../src/config/legal.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const split = (md) => {
  const m = md.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error("legal: file has no front matter");
  return { front: m[1], body: m[2] };
};
const key = (front, k) => {
  const raw = new RegExp(`^${k}:\\s*(.*)$`, "m").exec(front)?.[1]?.trim();
  if (raw === undefined) throw new Error(`legal: front matter has no ${k}`);
  return raw.startsWith('"') ? JSON.parse(raw) : raw;
};

/** PRIVACY pin (historic pins depend on it, never change): sha256 of the raw body, front matter stripped, CRLF -> LF. */
export const privacyDigest = (md) => sha(split(md).body);

/**
 * TERMS pin: sha256 of what /terms renders: H1 (title), <title> (metaTitle), meta description, then the body after {{token}} substitution
 * (applyLegalVars, the function content.config.ts renders with). `vars` = the legal.mjs values of the version being pinned (default: current).
 */
export const termsDigest = (md, vars) => {
  const { front, body } = split(md);
  return sha([key(front, "title"), key(front, "metaTitle"), key(front, "description"), applyLegalVars(body, vars)].join("\n---\n"));
};
