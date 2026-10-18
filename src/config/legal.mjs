// Single source for the legal facts rendered into /privacy and /terms (and the footer).
// Fill the operator name ONCE here; the Markdown bodies use the {{operator}} token (see plugins/remark-legal-vars.mjs).

/** TODO(owner): replace with the exact developer name shown on the Google Play listing / Play Console. */
export const OPERATOR_NAME = "TODO(owner): точна назва розробника з Play Console";

/** TODO(owner): registered address and registration number (ЄДРПОУ / РНОКПП) of the operator, if it is to be published. */
export const OPERATOR_DETAILS = "TODO(owner): адреса та реєстраційні дані оператора";

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
