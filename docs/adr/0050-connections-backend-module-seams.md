# Connections Back-end Module Seams

Behavior-preserving architecture deepenings for the Connections back-end, from the
2026-07-11 review. The review found the spine deep (write-guard, the atomic-claim
pending-writes confirm chokepoint, vault, `store.toPublic`) but the wide edges shallow:
copy-pasted HTTP clients, a CalDAV god-module, a duplicated host classifier, and a
fat-tool/thin-service inversion in the capability tools. Each section below records one
seam. All are behavior-preserving unless noted. Domain terms are defined in `CONTEXT.md`
(Connections section).

## Provider HTTP  *(slice B1)*

**Decision:** All fetch-based connection providers share one outbound-HTTP module
(`connections/provider-http.ts`) instead of each hand-rolling its own client. The module
owns `providerFetch` (AbortController + timeout + `AbortError`→timeout mapping +
`clearTimeout`, with an injectable `fetch` seam for tests), the three auth-header shapes
(`bearerAuthHeader` / `apiKeyHeader` / `basicAuthHeader`), and a shared
`ConnectionHttpError` base carrying a `code`.

**Preservation of behavior:** Each provider's named error class (`ImmichError`,
`GitHubError`, `GoogleCalendarError`, `ContactsError`, `NextcloudFilesError`,
`OneDriveError`, `AppleCalDavError`, `PlexError`, `OwnTracksError`, `GoogleOAuthError`,
`CalDavError`) now **extends** `ConnectionHttpError`, keeping its name and narrow `code`
union — so every route/test `instanceof <Provider>Error` + `.code` check is unchanged.
Per-provider timeout error type/message is preserved via a `timeoutError` factory passed
to `providerFetch` (write executors keep throwing a plain `Error` on timeout, matching
their prior contract).

**Fixed in passing:** the `plex` and `owntracks` **health** calls previously used raw
`fetch` with no timeout — they now go through `providerFetch`, so the 15s bound is
uniform.

**Out of scope:** IMAP (`imap.ts` / `imap-write.ts`) uses raw TCP sockets (ImapFlow), not
fetch — untouched. `ImapError` and the validation-only `IcalWriteError` are unchanged.

Rejected: collapsing the provider error classes into one type — it would break the route
error ladders (`instanceof <Provider>Error`), and D1 reworks route error-mapping
separately.
