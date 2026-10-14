# Sync Roadmap for Public Distribution

Recorded: 2026-10-14. Status: product direction saved; Google Drive sync is not
implemented. The owner intends to distribute this extension publicly later.
The GitHub repository remains private; this decision does not authorize making
it public, submitting to a store, selecting a license, or uploading personal
packages and credentials.

## Decision and Priority

- Keep local-first use available without an account or a network connection.
- Retain configurable WebDAV. Existing users must not be forced to use Google.
- Plan Google Drive as an optional sync provider for a wider audience. Google
  authorization can remove the need for users to operate a WebDAV server.
- Personal use already has a sync solution, so Drive is not needed to finish
  the current Windows/Mac WebDAV acceptance. For public distribution, its
  onboarding benefit makes it a worthwhile planned feature.
- Evaluate Chrome built-in sync separately as a lighter configuration-only
  alternative. Do not implement every provider just because it was discussed.
- Whether Drive ships in the first public version or a later version remains
  a release-scope decision. Never advertise it before implementation and
  acceptance are complete.

This records a product recommendation, not measured adoption or user demand.
No runtime code, permissions, OAuth project, extension identity or release
archive is changed by this document.

## Options Considered

| Option | Best Fit | Trade-Off |
| --- | --- | --- |
| Existing WebDAV | Users with their own server; settings and optional completed records | Server setup, credentials and reliable HTTPS access remain the user's responsibility |
| Chrome `storage.sync` | Small settings for users with Chrome sync enabled | Approximately 100 KiB total and 8 KiB per item; assess actual serialized bytes and write quotas, not a guessed record count |
| Google Drive API | Optional Google-account-based configuration files and potentially larger history | Separate OAuth setup, stable extension identity, authorization lifecycle, API failures and network availability |

The earlier 8 KiB discussion concerned Chrome's per-item sync quota, not a
Google Drive file limit. Drive also has its own limits; it is not unlimited
storage. Recheck current limits when implementing.

Chrome sync is not the same service as the Drive API. Drive support does not
require converting this extension into a userscript. The intended experience
is explicit Google authorization on Windows and Mac, using the same account
and application identity to exchange compatible configuration snapshots.

## Proposed First Drive Version

1. Offer one active provider per device: off, WebDAV, or Google Drive.
   Do not automatically mirror or bridge between providers.
2. Default Drive sync to configuration only: selected sites, custom domains,
   exceptions and user preferences. Exclude connection settings and secrets.
3. Treat completed-record sync as a separately consented expansion. Preserve
   the existing WebDAV record option; do not silently upload existing history
   to Google on first authorization or provider switching.
4. Keep self-reviews local and separately exported, as currently documented.
   Drive is not permission to broaden research or self-review collection.
5. Do not sync active grants, tabs, timers, page state, device permissions,
   cookies, OAuth tokens, WebDAV passwords or the personal installation preset.
6. Preserve local operation during outages. Provide explicit sync status,
   retry, disconnect and export/recovery paths; avoid a mandatory sign-in gate.

Configuration is not necessarily non-personal: purpose text and precise page
exceptions can contain private information. Explain what will be uploaded
before consent, even in a configuration-only release.

## Drive Storage and Authorization

Preferred storage is Drive's hidden `appDataFolder`, with the narrow
`https://www.googleapis.com/auth/drive.appdata` scope. It suits app-owned
configuration, but users cannot directly browse it as an ordinary Drive file.
Keep a local export path rather than promising a visible JSON document.

If visible, user-managed Drive files become a requirement, evaluate the
per-file `drive.file` scope instead. Do not request whole-Drive access merely
to store this extension's configuration. Non-sensitive scope classification
is not a blanket exemption from OAuth branding, publishing or store review;
confirm the requirements for the actual release.

Implementation needs a Google Cloud project, the Drive API, a suitable OAuth
client and a deliberate authorization UI. Review `chrome.identity` integration,
token lifecycle and account identity before choosing the final flow. Never
embed a client secret, user password or reusable user token in the extension,
repository, logs or packages.

Plan stable extension IDs for unpacked Windows/Mac builds and eventual store
installation. Chrome's documented `key` mechanism can help keep development
IDs stable, but do not add or change it blindly: first inventory current IDs
and provide a verified data migration/recovery path. Google OAuth client
configuration and the eventual store identity must agree.

Handle denied consent, expired authorization, revoked access, account switching
and any testing-versus-production OAuth restrictions explicitly. Google
authorization and API access must be reliable on the user's network; WebDAV
and local-only mode remain alternatives.

## Reuse and Data Safety

Current code already separates document validation and deterministic merging
from the WebDAV network function in `sync.js`. Preserve those semantics while
introducing a small provider boundary only when Drive implementation begins.
The current document limit is 4 MB; adding a provider must not silently remove
validation or imply that existing history can grow without bounds.

- Reuse settings revision ordering, record-ID deduplication and deletion
  precedence. Settings currently merge as a whole, not field by field.
- Preserve the pre-sync settings backup and any protected local active records.
- Preserve per-device ownership of remote snapshots. Do not replace this with
  unguarded last-upload-wins writes to a shared JSON file.
- Keep network work outside the background navigation queue. A slow provider
  must not delay interception, timers or expiry handling.
- Cancel old work when the provider or account changes. Scope device/file
  bookkeeping to the provider and account, and reject late results.
- Require an explicit transfer decision and backup before moving existing data
  to a different provider or account. Signing in alone must not merge unrelated
  accounts or overwrite their data.
- Switching off or disconnecting is not remote deletion. Explain the difference
  and require separate confirmation for destructive cloud actions.
- Hidden app storage and HTTPS do not establish end-to-end encryption. Update
  privacy documentation to match actual storage and authorization behavior.

## Acceptance Before Advertising Drive Support

- Windows and real macOS Chrome: initial install, first consent, cancellation,
  permissions, upgrade, and consistent application identity.
- Two real devices on the same Google account: initial download, local edits,
  concurrent edits, offline edits, reconnection and deterministic convergence.
- Empty remote state, corrupt or incompatible documents, API errors, quota
  failures and interrupted writes: preserve local data and recovery options.
- Revocation, reauthorization, account switching and provider switching: no
  credential leaks, cross-account merges or late stale-result application.
- Worker restarts and slow requests: no interference with navigation, expiry
  handling or local use; browser authorization stays per-device.
- Settings-only scope: no history, self-reviews or connection secrets uploaded.
  Any later history option needs its own consent and deletion-propagation tests.
- Review real authorization screens and extension UI visually, including
  keyboard navigation and narrow layouts. Synthetic API fixtures supplement,
  but never replace, real Google authorization and Mac acceptance.
- Inspect final public packages, Git history, requested scopes and network
  traffic. Update hosted privacy disclosures and the store listing before
  enabling or advertising the new provider.

No Drive acceptance above has been performed. Existing WebDAV and Chromium
test results are not evidence that Google Drive or macOS works.

## Public Release Sequence

1. Complete current real-Chrome and Mac installation, update and WebDAV
   acceptance; preserve the known limitations in `LIVE_TEST.md`.
2. Settle the public extension identity, publisher/contact, license decision,
   hosted privacy notice and security review tracked in `STORE.md`.
3. Confirm the Drive release scope, implement the optional provider, then
   complete the acceptance matrix before claiming support.
4. Review the exact public artifacts and remaining risks with the owner.
   Private Git hosting is not open-source publication or store submission.

## Research References

These are the official references used for the saved analysis. API behavior,
quotas and publication requirements must be checked again during implementation;
this document is not a claim of Google approval.

- [Chrome storage and sync quotas](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [Chrome extension OAuth integration](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth)
- [Chrome manifest key](https://developer.chrome.com/docs/extensions/reference/manifest/key)
- [Drive application data folder](https://developers.google.com/workspace/drive/api/guides/appdata)
- [Drive OAuth scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
