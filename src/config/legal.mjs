// Single source for the legal facts rendered into /privacy and /terms (and the footer).
// Fill the operator name ONCE here; the Markdown bodies use the {{operator}} token (substituted in src/content.config.ts).
// Release gate: scripts/check-no-todo-owner.mjs fails CI on PRs into main while any TODO(owner) remains.

/** Developer name on the Play listing is «Beautica»; the account is personal (individual): Денис Зварич (DENYS ZVARYCH). */
export const OPERATOR_NAME = "Beautica (фізична особа Денис Зварич)";

/** Deliberately no home address or account ids: only the privacy contact is published. */
export const OPERATOR_DETAILS = "Контакт з питань персональних даних: privacy@beautica.app";

/** Privacy-rights contact (README decision log: Q1). */
export const PRIVACY_EMAIL = "privacy@beautica.app";

/** General support contact (same value as `site.supportEmail` in uk.json). */
export const SUPPORT_EMAIL = "support@beautica.app";

/** Tokens usable in the legal Markdown bodies as {{key}}. */
export const LEGAL_VARS = {
  operator: OPERATOR_NAME,
  operatorDetails: OPERATOR_DETAILS,
  privacyEmail: PRIVACY_EMAIL,
  supportEmail: SUPPORT_EMAIL,
};
