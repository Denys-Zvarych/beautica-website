# Claims ledger

Every factual statement about the product on a page has a row. Code wins over text.
Checked by `npm run check:claims` (`scripts/check-claims.mjs`); not-live rows are listed by `npm run list:not-live`.

Columns:

- **claim**: the statement as the page makes it.
- **page anchor**: `route#id` (needs a built `dist/client/<route>.html` containing `id="<id>"`).
- **source**: `` `path:line` ``. A path starting with `../` points into a sibling repo (checked only when that repo exists);
  any other path is relative to this repo. Line must be within the file.
- **status**: `live` or `not-live` (the page words it as «після запуску функції», or hides it behind an `add when live` marker).

| claim | page anchor | source | status |
|---|---|---|---|
| Client, independent master, salon master and salon admin can delete their account in the app (owner cannot) | delete-account#app | `../beautica-mobile/lib/features/auth/presentation/auth_selectors.dart:136` | live |
| «Акаунт» → «Видалити акаунт» is the last row of the account page | delete-account#app | `../beautica-mobile/lib/features/settings/presentation/settings_screen.dart:411` | live |
| Row label is «Видалити акаунт» | delete-account#app | `../beautica-mobile/lib/l10n/app_uk.arb:3008` | live |
| Salon owner has only «Видалити салон» on the account page | delete-account#app | `../beautica-mobile/lib/features/settings/presentation/settings_screen.dart:383` | live |
| Client path starts at the hub row «Акаунт» | delete-account#app | `../beautica-mobile/lib/features/home/presentation/client_settings_hub_screen.dart:187` | live |
| Salon admin opens settings from the profile tune button | delete-account#app | `../beautica-mobile/lib/features/salon/presentation/admin_own_profile_screen.dart:347` | live |
| Client with more than 50 future bookings must cancel some first | delete-account#app | `../beautica-backend/src/main/java/com/beautica/user/ClientAccountDeletionService.java:77` | live |
| Master with more than 500 future bookings must cancel some first | delete-account#app | `../beautica-backend/src/main/java/com/beautica/user/StaffAccountSelfDeletionService.java:73` | live |
| Reply to a deletion request within 30 calendar days (policy commitment, no code behind it) | delete-account#request | `src/content/legal/uk/privacy.md:146` | live |
