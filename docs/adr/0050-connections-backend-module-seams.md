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

## Capability-Read Seam  *(slice C1)*

**Decision:** One seam (`connections/capability-read.ts`,
`withCapabilityConnection(userId, capability, {account, forWrite}, fn)`) owns the
resolve → disambiguation → default-pick dance the connection tools each copied. It
returns a discriminated result (`not-connected` | `no-match` | `ok`) so each tool maps
the outcome onto its own verbatim per-capability message — the exact "not connected" and
`noMatchingConnectionMessage(...)` strings stay at the call sites, unchanged. The 9
re-declared `applyLocalDistillGate` wrappers collapse into one shared helper in
`connector-distill.ts` (each tool keeps only its payload-shaping `distill<Tool>ReadOutcome`
adapter).

**Migrated:** calendar, files, email, photos, media, location (full), and repos
(single-provider). **Not migrated:** tasks and contacts — they aggregate across multiple
sources rather than selecting one connection, which the single-connection seam would
distort; their distill wrappers were still folded into the shared helper. A companion
aggregate seam for those two is possible follow-up, not part of this slice.

**Why a separate module (not `resolve.ts`):** tool tests mock `resolve.ts`'s primitives;
housing the seam in its own module keeps its cross-module imports interceptable by those
mocks.

## Split-Pair Merge  *(slice C2)*

**Decision:** Each provider's read and write live in ONE module (the `nextcloud-files.ts`
model). `google-calendar-write` → `google-calendar`, `immich-write` → `immich`,
`apple-caldav-write` → `apple-caldav`. Base-URL / auth / origin / event-id knowledge is
derived once: a single `CALENDAR_API_BASE`; the immich write path uses the read module's
`immichConfig(conn)` instead of a hand-rolled `conn.config.origin` read; Apple ID auth
identity comes from one `appleIdOf(conn)` helper. `imap.ts`/`imap-write.ts` stay split
(raw-socket, not flagged).

**Registration side-effects:** the write executor `registerWriteExecutor({...})` calls
moved into the merged modules unchanged; `pending-writes.ts` (and the `*-write.test.ts`
suites) now trigger registration by side-effect-importing the merged read modules. Write
behavior stays fully covered — the `*-write.test.ts` files were kept and repointed, not
deleted.

## Route Seams  *(slice D1)*

**Decision:** The connection route handlers share four seams (in `src/lib/server/api/`):
`requireApiUser(event)` (throws SvelteKit `error(401)` → 401 JSON), `mapConnectError(err)`
(the one provider-error→status ladder), `handleCredentialConnect(...)` /
`handleOAuthConnectStart(...)` (the credential and OAuth start families — the
google/onedrive byte-for-byte twins collapse here), and `requireOwnedConnection(userId,
id, {guard})` (user-scoped fetch + 404 + optional provider-guard). Error responses
standardize on the single `createJsonErrorResponse` `{error}` helper; `isCapability` is
declared once.

**Deliberate behavior change (partial in practice):** `requireApiUser` returns **401 JSON**
for unauthenticated requests at the handler level (pinned by tests), replacing the old
`requireAuth` 302. HOWEVER, the global `handle` hook in `src/hooks.server.ts` already
`throw redirect(303, "/login")` for any non-`PUBLIC_PATHS` request without a user, BEFORE
any route handler runs — so in the live request pipeline an unauthenticated
`/api/connections/**` call is a **303 redirect from the hook**, and `requireApiUser`'s 401
only fires for paths/callers that get past the hook. This is NOT a regression (the hook
shadowed the old 302 identically), but the intended API-clean 401 is not observable in
prod. Making `/api/**` genuinely return 401 is a global hook change (affects every API
route) and is intentionally left as a separate follow-up, not slipped into this slice.
Verified live post-deploy: unauth `/api/connections` → 303; authenticated → 200 JSON.

**Note:** `mapConnectError` duck-types on `.code` rather than assuming every provider error
extends `ConnectionHttpError` — `ImapError` extends `Error` (IMAP was out of B1's scope).

## Registry Read Dispatch — CONSIDERED AND DEFERRED  *(slice C3)*

**Decision:** Do NOT route capability reads through the adapter registry keyed by
`(capability, provider)`. Keep the per-tool provider dispatch (the localized
`if (conn.provider)` branches and the per-provider read wrappers). Recorded here so future
architecture reviews don't re-suggest it.

**Why (design-it-twice outcome):** the appeal was symmetry with the write path
(`getWriteExecutor(provider)`), but that symmetry doesn't hold. **Writes are uniform** —
every write is `execute(userId, connId, op, content)`, so one registry with one interface
serves all providers. **Reads are not** — each capability's read surface is a different
shape (calendar list-events vs files list/read/search/stat vs tasks list), with
provider-specific extras (google-only `getEvent`/`freeBusy`; onedrive-only read-token).
A read registry is therefore N bespoke registries sharing only `provider: string` — more
surface, less uniform than what it mirrors. It also doesn't fit the aggregate tools
(contacts dispatches inside its resolver; tasks is caldav-only after A1), and it would
force rewriting ~130 test assertions that `vi.mock` whole provider modules (which would
erase a module-load registration side-effect). The if-chains it removes are already
small, well-commented, and well-abstracted, so the payoff doesn't justify the churn.

**If revisited:** the one self-contained candidate is a `FilesReader` registry alone
(files is the only capability with a uniform, already-abstracted 2-provider read surface);
scope it as its own task with the test-mock rework budgeted in.





