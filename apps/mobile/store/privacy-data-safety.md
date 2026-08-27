# Store privacy and data-safety worksheet

This is a submission worksheet, not legal advice. Confirm it against the production build, production analytics configuration, and the final privacy policy before answering either store.

## Data used by the app

| Store data group | ShowPilot examples | Required | Linked to account | Purpose |
| --- | --- | --- | --- | --- |
| Contact info | Name and email | Yes | Yes | Account, authentication, invitations, support |
| User identifiers | ShowPilot user ID and organization membership | Yes | Yes | Authentication, authorization, synchronization |
| User content | Rundowns, schedules, assignments, incidents, comments, chat, reactions, and files | Depends on role/use | Yes | App functionality and team collaboration |
| Photos | Optional profile photo and optional chat attachments | No | Yes | Profile and collaboration |
| App activity | Feature-use events if production analytics is enabled | No | Yes when enabled | Product analytics and improvement |
| Device identifiers | Web Push endpoint or Expo push token | No | Yes | Assignment, mention, and operational notifications |
| Purchase information | Workspace plan and subscription status; Stripe handles card details | No | Organization-linked | Entitlements, billing support, fraud prevention |

## Current handling statements

- Data is encrypted in transit with HTTPS/WSS.
- ShowPilot does not sell personal information and does not use it for advertising.
- Payment card details are entered with Stripe and are not stored by ShowPilot.
- Users can start permanent account deletion at https://showpilot.tech/delete-account.
- Organization owners can permanently delete an organization and its organization-owned data.
- Optional system permissions are limited to notifications and photo-library selection. The Android manifest blocks camera, microphone, broad storage, and overlay permissions.

## Answers that need final confirmation

- Whether PostHog analytics is enabled in the submitted production environment.
- The final retention periods and legal-entity details in the privacy policy.
- Whether store dashboards treat workspace subscription status as purchase history for this build.
- Apple accessibility nutrition labels after task-level testing on a signed iPhone and iPad build.
- Google Play’s exact account-deletion URL field and Data Safety answers after the production deletion route is deployed.

Do not claim that data is unlinked, ephemeral, optional, or not collected unless the production behavior and every enabled third-party SDK support that answer.
