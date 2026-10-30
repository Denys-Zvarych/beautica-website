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
| Salon owner has only «Видалити салон» on the account page | delete-account#app | `../beautica-mobile/lib/features/settings/presentation/settings_screen.dart:304` | live |
| Client path starts at the hub row «Акаунт» | delete-account#app | `../beautica-mobile/lib/features/home/presentation/client_settings_hub_screen.dart:187` | live |
| Salon admin opens settings from the profile tune button | delete-account#app | `../beautica-mobile/lib/features/salon/presentation/admin_own_profile_screen.dart:347` | live |
| Client with more than 50 future bookings must cancel some first | delete-account#app | `../beautica-backend/src/main/java/com/beautica/user/ClientAccountDeletionService.java:77` | live |
| Master with more than 500 future bookings must cancel some first | delete-account#app | `../beautica-backend/src/main/java/com/beautica/user/StaffAccountSelfDeletionService.java:73` | live |
| Reply to a deletion request within 30 calendar days (policy commitment, no code behind it) | delete-account#request | `src/content/legal/uk/privacy.md:208` | live |
| Guest can cancel a booking until 2 hours before it starts | l/cancel#st-closed | `../beautica-backend/src/main/java/com/beautica/config/BookingSmsProperties.java:29` | live |
| After that window the cancel is refused (422) and the guest is told to contact the master | l/cancel#st-closed | `../beautica-backend/src/main/java/com/beautica/booking/service/BookingCancellationService.java:128` | live |
| A used or unknown cancel link answers 404 («вже використано або недійсне») | l/cancel#st-notfound | `../beautica-backend/src/main/java/com/beautica/booking/controller/PublicBookingController.java:234` | live |
| Invite email links to /invite/accept?token= (opens in the app) | l/invite#main | `../beautica-backend/src/main/java/com/beautica/auth/InviteService.java:426` | live |
| Booking email links to /bookings/{id} (details in the app) | l/booking#main | `../beautica-backend/src/main/java/com/beautica/notification/service/NotificationService.java:512` | live |
| Review email links to /bookings/{id}/review (review left in the app) | l/review#main | `../beautica-backend/src/main/java/com/beautica/notification/service/NotificationService.java:499` | live |
| Guest cancel SMS/email links to /book/cancel/{token} | l/cancel#main | `../beautica-backend/src/main/java/com/beautica/booking/service/GuestBookingService.java:678` | live |
| Guest booking: consent + policy version are stored with the booking | privacy#guest | `../beautica-backend/src/main/java/com/beautica/booking/domain/GuestConsent.java:13` | live |
| Guest booking: Turnstile bot check before the SMS code is sent | privacy#guest | `../beautica-backend/src/main/java/com/beautica/auth/turnstile/TurnstileVerifier.java:66` | live |
| Guest booking: up to 10 services in one visit | privacy#guest | `../beautica-backend/src/main/java/com/beautica/booking/service/SlotCalculationService.java:90` | live |
| Guest booking: the booked master / salon sees the guest's name, surname AND phone (USER DECISION 2026-10-22; the backend DTO still omits the phone, see BookingDetailResponse:89 — backend change owed) | privacy#guest | `../beautica-backend/src/main/java/com/beautica/booking/dto/BookingDetailResponse.java:89` | not-live |
| Guest booking confirmation: the booking can be cancelled free until 2 hours before the visit | src:src/i18n/uk.json#"cancelRule" | `../beautica-backend/src/main/java/com/beautica/config/BookingSmsProperties.java:29` | live |
| Guest booking: the calendar offers today up to 60 days ahead (the API refuses later dates) | src:src/scripts/booking/calendar.ts#WINDOW_DAYS = 60 | `../beautica-backend/src/main/java/com/beautica/config/BookingSmsProperties.java:22` | live |
| Guest booking: at most 10 services can be ticked for one visit (the 11th tap is ignored) | src:src/scripts/booking/app.ts#st.picked.size >= 10 | `../beautica-backend/src/main/java/com/beautica/booking/service/SlotCalculationService.java:90` | live |
| Guest booking: the optional comment for the master holds at most 500 characters (the app's limit; the API accepts 1000) | src:src/components/book/BookingFlow.astro#maxlength="500" | `../beautica-mobile/lib/features/booking/presentation/booking_confirm_screen.dart:145` | live |
| Guest booking: privacy page states the same 2-hour cancel rule | privacy#guest | `../beautica-backend/src/main/java/com/beautica/config/BookingSmsProperties.java:29` | live |
| Analytics (privacy § 4): the site sets no cookie, also after interactions (guarded by tests/analytics.test.mjs «no cookies, ever») | privacy#analytics | `tests/analytics.test.mjs:182` | live |
| Analytics (privacy § 4): page addresses are sent without parameters after «?» and without the fragment (Umami `data-exclude-search` / `-hash`; guarded by tests/analytics.test.mjs «loader timing and attributes») | privacy#analytics | `src/scripts/analytics.ts:27` | live |
| Analytics (privacy § 4): on personal-link pages (invite, booking, cancel) no analytics script is loaded (guarded by tests/analytics.test.mjs «token routes and malformed token paths» and tests/headers-seo.test.mjs «deeper token paths») | privacy#analytics | `tests/analytics.test.mjs:62` | live |
| Analytics (privacy § 4): events carry no name, phone, SMS code, e-mail or booking number, only the README § 10 props (guarded by tests/track-allowlist.test.mjs) | privacy#analytics | `tests/track-allowlist.test.mjs:68` | live |
| Analytics (privacy § 4): a booking attempt blocked by the provider is counted as `booking_error` with the code «blocked» (a fixed word, no phone, name or slug; generic failures stay «other»; guarded by tests/book-blocked.test.mjs) | privacy#analytics | `src/scripts/booking/app.ts:770` | live |
| Analytics (privacy § 4): «link opened» records only the referrer's host name (no path or query), empty for own site or direct visits | privacy#analytics | `src/scripts/booking/channel.ts:27` | live |
| Guest review: the comment holds at most 2000 characters (same limit as the API's review comment) | src:src/components/book/ReviewFlow.astro#const MAX = 2000 | `../beautica-backend/src/main/java/com/beautica/review/dto/CreateReviewRequest.java:27` | live |
| Guest review: other clients see the review under a short name like «Олена К.» (the public review shows a display name) | src:src/i18n/uk.json#"publishedPre" | `../beautica-backend/src/main/java/com/beautica/review/dto/SalonReviewResponse.java:40` | not-live |
| Guest review: the phone is not shown to other clients (the public review DTO has no phone field) | src:src/i18n/uk.json#"publishedPost" | `../beautica-backend/src/main/java/com/beautica/review/dto/SalonReviewResponse.java:40` | not-live |
| Guest review: the opt-out stops only the review-request SMS, bookings and reminders stay (backend 402 not built yet) | src:src/i18n/uk.json#"optoutText" | `../docs/website-phases/phase-019-guest-review-page.md:22` | not-live |
| Guest review: a used, unknown or expired link gets one neutral page, a used one is told apart only by «Відгук уже надіслано» | src:src/i18n/uk.json#"invalidH" | `../beautica-backend/src/main/java/com/beautica/review/invite/service/GuestReviewService.java:76` | live |
| Booking blocked by the provider: the guest sees only «Запис до цього майстра/салону зараз недоступний», no hint of a block (409 `data.code` BOOKING_UNAVAILABLE, master + salon wording; backend 398) | src:src/i18n/uk.json#"blockedSalon": "Запис до цього салону зараз недоступний" | `../beautica-backend/src/main/java/com/beautica/common/exception/BookingUnavailableException.java:23` | live |
| Reports (terms §7, privacy §2): the report comment holds at most 500 characters | privacy#data | `../beautica-backend/src/main/java/com/beautica/moderation/dto/CreateReportRequest.java:39` | live |
| Reports (terms §7): reportable content = review, client review, portfolio photo, master/salon profile, client profile; reporting your own content is refused | terms#prohibited | `../docs/backend-phases/phase-395-ugc-content-reports.md:22` | live |
| Reports (terms §7): every signed-in role may report; guests without an account write to support | terms#prohibited | `../docs/backend-phases/phase-395-ugc-content-reports.md:38` | live |
| Reports (terms §7): reasons are spam, offensive, harassment, false info, sexual content, other (app labels «Спам або реклама», «Образливий зміст», «Переслідування або погрози», «Неправдива інформація», «Відвертий або сексуальний зміст», «Інше») | terms#prohibited | `../beautica-mobile/lib/l10n/app_uk.arb:7198` | live |
| Reports (terms §7): the button in the app is «Поскаржитися» (on a photo «Поскаржитися на фото», on a client «Поскаржитися на клієнта») | terms#prohibited | `../beautica-mobile/lib/l10n/app_uk.arb:7190` | live |
| Reports (terms §7): the report is anonymous, the author is not told who reported | terms#prohibited | `../beautica-mobile/lib/l10n/app_uk.arb:7234` | live |
| Reports (privacy §2): the team e-mail carries only report number, target type and id, reason and reporter id, never the comment or the review text | privacy#data | `../docs/backend-phases/phase-395-ugc-content-reports.md:35` | live |
| Moderation (terms §4): 3 different clients with a completed visit at that master or salon hide a review automatically (staff do not count) | terms#reviews | `../beautica-backend/src/main/resources/application.yml:543` | live |
| Moderation (terms §4): a hidden or removed review leaves public lists and the rating; the author still sees it in their own list; support can restore or remove | terms#reviews | `../docs/backend-phases/phase-396-ugc-moderation-takedown.md:28` | live |
| Moderation (terms §7): support can hide/remove, leave unchanged or restore; the author and the reporter are not told the outcome | terms#prohibited | `../docs/backend-phases/phase-396-ugc-moderation-takedown.md:40` | live |
| Moderation (privacy §8): resolved reports are kept while the target exists, then 1 year after it is gone | privacy#retention | `../beautica-backend/src/main/java/com/beautica/moderation/service/ContentReportRetentionService.java:39` | live |
| Moderation (privacy §8): when the reporter deletes the account the report loses the identifier and the comment | privacy#retention | `../docs/backend-phases/phase-396-ugc-moderation-takedown.md:95` | live |
| Blocks (terms §6): only independent master, salon owner and salon admin block (a salon block covers the whole salon); salon master and client cannot | terms#providers | `../docs/backend-phases/phase-397-user-blocks-api.md:32` | live |
| Blocks (terms §6, privacy §2): registered client = blocked by account only; link guest = by keyed phone hash + last 4 digits; no raw phone stored | privacy#data | `../docs/backend-phases/phase-397-user-blocks-api.md:37` | live |
| Blocks (privacy §2): the block keeps a short label «Ім'я П.» (first name + surname initial) | privacy#data | `../beautica-backend/src/main/java/com/beautica/moderation/dto/BlockDisplayNames.java:28` | live |
| Blocks (terms §6): the blocked client is not told; the booking attempt answers «Запис до цього майстра/салону зараз недоступний» (409 BOOKING_UNAVAILABLE) | terms#providers | `../beautica-backend/src/main/java/com/beautica/common/exception/BookingUnavailableException.java:17` | live |
| Blocks (terms §3, §6): a new block declines every future confirmed visit of that client in scope (status «Скасовано»), neutral notice, no reason; past visits and reviews stay | terms#bookings | `../beautica-backend/src/main/java/com/beautica/booking/service/BookingService.java:2252` | live |
| Blocks (privacy §3, §8): a guest erase request renames the block to «Гість» and keeps the hash; the 12-month anonymisation does not touch blocks | privacy#retention | `../beautica-backend/src/main/java/com/beautica/booking/retention/GuestPiiAnonymisationService.java:234` | live |
| Blocks (privacy §8): a block disappears on unblock, on deletion of the blocking master/salon or of the blocked account (cascade) | privacy#retention | `../beautica-backend/src/main/resources/db/migration/V210__client_blocks.sql:17` | live |
| Guest review (terms §4, privacy §2): published name is first name + surname initial, «Гість» when nothing usable is left | privacy#data | `../beautica-backend/src/main/java/com/beautica/booking/retention/GuestPii.java:13` | live |
| Guest review invite (privacy §3): one SMS per visit, 2 hours after «Виконано», never 21:00-09:00 Kyiv (then 10:00), dropped 72 hours after its planned time (backend 400 not built yet) | privacy#guest | `../docs/backend-phases/phase-400-guest-review-invite-send.md:25` | not-live |
| Guest review invite (privacy §3): only link guests who accepted this policy version and did not opt out; walk-ins and app bookings never (backend 400 not built yet) | privacy#guest | `../docs/backend-phases/phase-400-guest-review-invite-send.md:20` | not-live |
| Guest review invite (privacy §3): link valid 14 days from sending, review can be sent once (backend 400/401 not built yet) | privacy#guest | `../docs/backend-phases/phase-400-guest-review-invite-send.md:28` | not-live |
| Guest review (privacy §3): comment up to 2000 characters, Turnstile on the review page | privacy#guest | `../beautica-backend/src/main/java/com/beautica/review/invite/dto/GuestReviewItemRequest.java:30` | live |
| Guest review opt-out (privacy §3, §8): only the keyed hash of the phone is kept, indefinitely; the page button works 30 days after sending (hash kept: backend 401; erase rules: backend 402 not built yet) | privacy#guest | `../beautica-backend/src/main/java/com/beautica/review/invite/service/GuestReviewService.java:122` | live |
| Guest review opt-out (privacy §3): the button text on the review page is «Не надсилати мені такі СМС» (uk.json review.optOut) | privacy#guest | `src/i18n/uk.json:138` | live |
| Guest review (privacy §4): the review page /r/{token} loads no analytics script | privacy#analytics | `src/components/Layout.astro:42` | live |
| Guest review erase (privacy §3, §8): names in guest reviews become «Гість» on anonymisation or erase; the opt-out hash stays unless support is asked to lift it (backend 402 not built yet) | privacy#retention | `../docs/backend-phases/phase-402-guest-review-retention.md:17` | not-live |
| Guest review invite rows (privacy §8): deleted 30 days after expiry, consumption or another final status (backend 402 not built yet) | privacy#retention | `../docs/backend-phases/phase-402-guest-review-retention.md:22` | not-live |
| Telegram (opt-in, guests): the 24 h reminder can go to Telegram | privacy#guest | `../beautica-backend/src/main/java/com/beautica/notification/channel/GuestMessageKind.java:10` | live |
| Telegram (opt-in, guests): the 2 h reminder can go to Telegram | privacy#guest | `../beautica-backend/src/main/java/com/beautica/notification/channel/GuestMessageKind.java:11` | live |
| Telegram (opt-in, guests): a cancellation by the master / salon can go to Telegram | privacy#guest | `../beautica-backend/src/main/java/com/beautica/notification/channel/GuestMessageKind.java:12` | live |
| Telegram (opt-in, guests): the review invitation can go to Telegram; these four are the ONLY kinds, so the code, the booking confirmation with the cancel link, the guest's own cancellation and the reschedule notice are SMS-only | privacy#guest | `../beautica-backend/src/main/java/com/beautica/notification/channel/GuestMessageKind.java:13` | live |
| Telegram link is keyed by an HMAC-SHA-256 of the phone | privacy#guest | `../beautica-backend/src/main/java/com/beautica/common/security/PhoneHasher.java:29` | live |
| Telegram link row holds the phone hash and no raw phone (the number shared in the bot is compared once and discarded) | privacy#guest | `../beautica-backend/src/main/java/com/beautica/notification/telegram/link/TelegramLink.java:42` | live |
| Telegram link is deleted with the guest data 12 months after the last visit | privacy#retention | `../beautica-backend/src/main/resources/application.yml:612` | live |
| Telegram link is deleted 12 months after the bot was blocked (phase 409 D2, NOT SHIPPED: release gate) | privacy#retention | `../docs/backend-phases/phase-409-telegram-retention-erasure.md:20` | not-live |
| Telegram link codes are deleted at most 2 days after they expire: 1 day past expiry, daily job (phase 409 D4, NOT SHIPPED: release gate) | privacy#retention | `../docs/backend-phases/phase-409-telegram-retention-erasure.md:25` | not-live |
