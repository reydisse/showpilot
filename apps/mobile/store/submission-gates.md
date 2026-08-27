# Mobile publication gates

## Owner and account controlled

- Apple Developer enrollment approved and the App Store Connect app record created for `tech.showpilot.mobile`.
- Approved Expo owner and EAS project linked; `owner`, `extra.eas.projectId`, and the matching EAS Update URL recorded in app config.
- Apple distribution certificate, provisioning profile, APNs key, and App Store Connect API access configured through approved accounts.
- Google Play app record created, production upload key/Play App Signing configured, and service-account access approved if EAS Submit will be used.
- App Review contact name, phone, and monitored email supplied outside Git.
- A dedicated production review workspace and account created. Store the password in the store dashboard or secret manager, never this repository.
- Copyright owner and legal-entity wording confirmed.
- Privacy policy founder/legal review completed.

## Build and product proof

- Run `pnpm --filter @showpilot/mobile verify:release` after EAS linkage.
- Produce signed internal iOS and Android builds from the reviewed commit.
- Prove sign-in, profile photo, workspace switching, shows, live rundown synchronization, timer controls, schedule, inbox, chat persistence, notification deep links, incidents, device access, and account deletion on physical devices.
- Prove push delivery through APNs and FCM with the signed builds.
- Capture iPhone, iPad, and Android screenshots from the approved demo workspace.
- Complete Apple privacy and accessibility declarations and Google Play Data Safety/account-deletion forms from `privacy-data-safety.md`.
- Submit manually first. Keep automatic store release disabled until review approval and final launch authorization.

## Deployment dependency

The support, privacy, and account-deletion URLs must be deployed and publicly reachable before either store submission. Migration `0033_chat_user_room_index.sql` must be applied through the protected migration workflow before enabling account deletion in production.
