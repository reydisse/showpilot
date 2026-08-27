# ShowPilot mobile store package

This directory is the reviewed source for App Store Connect and Google Play Console. `store.config.json` contains the Apple fields that EAS Metadata can sync. Google Play metadata remains in `listing/en-US.md` because EAS Metadata currently supports Apple only.

Before submission:

1. Complete every item in `submission-gates.md`.
2. Capture the required signed-build screenshots in `screenshots.md`.
3. Review the declarations in `privacy-data-safety.md` against the production build and enabled vendors.
4. Copy the Android listing from `listing/en-US.md` into Play Console.
5. Sync Apple metadata only after the approved Expo and App Store Connect accounts are linked.

Do not commit App Review passwords, API keys, signing files, or service-account JSON.
