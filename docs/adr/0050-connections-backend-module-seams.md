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

## Host Locality  *(slice B2)*

**Decision:** One module (`connections/host-locality.ts`) owns the
private/loopback/link-local host classifier, used behind BOTH the SSRF guard
(`assertPublicHttpsUrl`, for user-pasted server URLs) and the cloud-connector warning
(`isPrivateHostname`, in `locality.ts`). The prior duplicate classifier in `net.ts` is
deleted (the module became empty and was removed); the SSRF guard moved OUT of
`providers/nextcloud-files.ts` — the 4 providers that reached across to import it
(github, immich, plex, caldav-tasks) plus the two nextcloud routes now import it from
host-locality.

**Intentional hardening (behavior change, noted):** the two original classifiers were
identical except `net.ts` treated `*.local` mDNS names as private and the Nextcloud SSRF
inline checks did not. The reconciled classifier keeps the `.local` check, so
`assertPublicHttpsUrl` now also rejects `https://*.local` URLs (previously they passed).
This is the correct SSRF direction — `.local` is a LAN host, and RFC1918/loopback IPs
were already rejected — but it is a user-visible change: a connection whose server URL is
an mDNS `.local` name will now fail the guard. On-box connectors that legitimately need a
LAN host (OwnTracks) are already exempt from the guard by design.

## DAV Toolkit  *(slice B3)*

**Decision:** The provider-agnostic WebDAV/CalDAV/CardDAV + iCal/vCard toolkit lives in
its own module (`connections/dav/`: `xml.ts`, `transport.ts`, `ical.ts`) instead of
inside the 1545-line Apple provider. `apple-caldav.ts` becomes a pure consumer (Apple
principal/home-set discovery + adapter/health only) and no longer re-exports the toolkit.
`caldav-tasks.ts`, `contacts.ts`, `apple-caldav-write.ts`, and `nextcloud-files.ts` all
depend on `dav/`; nextcloud-files drops its parallel XML implementation (its own
`DAV_NS`/`textOf`/`firstNs`/propstat-walk/inline jsdom).

**Two transport forms:** `caldavRequest` (PROPFIND/REPORT, redirect-following,
expect-207) for reads, and `caldavWriteRequest` (PUT/DELETE, redirect-following, does NOT
assume 207 — returns the raw Response) for writes, folding in what
apple-caldav-write's local fork previously needed. Both built on `providerFetch` (B1).

**Preservation of behavior:** provider-specific error branding (Apple's exact messages +
`AppleCalDavError`, the generic connector's `CalDavError`/"CalDAV" wording) is injected
into the shared transport via `makeError`/label/`timeoutError` options, so every
`instanceof`/`.code` check and user-facing message is byte-identical. The `{ fetch? }`
injection seam, redirect-following, expect-207 for reads, and namespace URIs are
unchanged (nextcloud's `DAV_NS = "DAV:"` matched Apple's).


