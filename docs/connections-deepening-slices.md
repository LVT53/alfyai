# Connections back-end deepening — slice backlog

Local tracker for the 2026-07-11 Connections architecture review follow-through.
Source plan: architecture review report + approved plan. Execution: one integration
branch `connections-deepening`, one commit per slice, subagent-driven TDD, orchestrator
review + gate + commit. Gate = `npm run check` (0/0) · `npm run lint` · `npm run test`
(no regression from baseline) · `npm run build` (0 warnings).

Status legend: ⬜ todo · 🟨 in progress · ✅ done

---

## A1 — Fully retire Todoist  ✅
**Blocked by:** None — start immediately (do first; shrinks surface).

**What to build:** Todoist ceases to exist in the product. The tasks capability is served
by CalDAV only. Existing Todoist connections (rows + encrypted secrets) are deleted from
the database. No `todoist` reference survives anywhere in `src`.

**Acceptance criteria:**
- [ ] Idempotent Drizzle migration deletes `user_connections` rows (and their pending
      writes) where `provider='todoist'`, then removes `'todoist'` from the provider enum.
- [ ] Provider module, connect route, registry + client-catalog entries, the
      `tasks`-capability provider arm, and the tasks-tool dispatch branch are removed.
- [ ] `todoist` removed from the `ConnectionProvider` union (server schema + client mirror).
- [ ] `grep -ri todoist src` returns nothing; tasks capability still resolves/reads via
      a CalDAV connection.
- [ ] ADR-0051 records the removal; CONTEXT.md tasks note is CalDAV-only.

---

## B1 — `provider-http` module (Candidate 01)  ✅
**Blocked by:** None. (Prefactor for C2.)

**What to build:** One outbound-HTTP module every provider uses for fetch + timeout +
error typing + auth headers, replacing the 14 hand-rolled copies. The timeout guarantee
becomes uniform (closes the plex/owntracks health-call gap).

**Acceptance criteria:**
- [ ] `providerFetch` owns AbortController+timeout, status→code mapping, and the three
      auth-header shapes (Bearer / x-api-key / Basic).
- [ ] Single `ConnectionHttpError` replaces the 14 per-provider error classes.
- [ ] All providers migrated off private `fetchWithTimeout` / `REQUEST_TIMEOUT_MS`;
      plex + owntracks health calls now timeout-bounded.
- [ ] New unit test covers timeout/abort + each auth shape; every provider suite green.
- [ ] ADR-0050 §Provider HTTP; CONTEXT.md term added.

---

## B2 — `host-locality` module (Candidate 03)  ✅
**Blocked by:** None.

**What to build:** One host classifier behind both the SSRF guard and the cloud-connector
warning. The duplicate classifier in `net.ts` is deleted; the SSRF guard no longer lives
inside a provider module.

**Acceptance criteria:**
- [ ] `host-locality` owns the ipv4/ipv6/hostname classifier; `net.ts` duplicate removed.
- [ ] `assertPublicHttpsUrl` moved out of `providers/nextcloud-files.ts`; the 4 importers
      + nextcloud updated. `isPrivateHostname` + `assertPublicHttpsUrl` become thin uses.
- [ ] One classifier test suite (not two); SSRF + cloud-warning suites green.
- [ ] ADR-0050 §Host Locality; CONTEXT.md term added.

---

## B3 — `dav` module (Candidate 02)  ✅
**Blocked by:** None (smoother after B1).

**What to build:** The WebDAV/CalDAV/CardDAV + iCal/vCard toolkit becomes its own module
that Apple, CalDAV-tasks, contacts, and Nextcloud-files all depend on — instead of the
toolkit living inside the 1545-line Apple provider with a parallel copy in Nextcloud.

**Acceptance criteria:**
- [ ] `dav` module exports the XML/multistatus/PROPFIND-REPORT/request primitives + iCal/
      vCard parsers, incl. a write-capable request variant (the non-207 case).
- [ ] Apple, caldav-tasks, contacts, apple-caldav-write, and nextcloud-files migrated;
      nextcloud-files drops its parallel XML impl.
- [ ] dav-module unit tests for multistatus + iCal/vCard edge cases; all DAV suites green.
- [ ] ADR-0050 §DAV Toolkit; CONTEXT.md term added.

---

## C1 — `withCapabilityConnection` seam (Candidate 04)  ✅
**Blocked by:** A1.

**What to build:** One seam owns the resolve → disambiguation → distill-gate dance that 9
tools each copy today. Tools shrink to their own logic plus a call into the seam.

**Acceptance criteria:**
- [ ] `withCapabilityConnection(userId, capability, {account, forWrite}, fn)` resolves,
      disambiguates (no-match message + default pick), and provides the distill wrapper.
- [ ] 8 connection tools migrated off inline selection copies; the 9 `applyLocalDistillGate`
      wrappers folded into `connector-distill.ts`.
- [ ] Disambiguation has ONE focused test suite; redundant per-tool copies removed; all
      tool suites green.
- [ ] ADR-0050 §Capability-Read Seam; CONTEXT.md term added.

---

## C2 — Merge split read/write provider pairs (Candidate 06)  ✅
**Blocked by:** B1, B3.

**What to build:** Each provider's read and write live in one module (the nextcloud-files
model), so base-URL / auth / event-id / origin are derived once, not re-derived across a
file split.

**Acceptance criteria:**
- [ ] google-calendar-write → google-calendar; immich-write → immich; apple-caldav-write
      → apple-caldav. Write executors still register into the registry.
- [ ] No re-declared `CALENDAR_API_BASE` / hand-rolled `conn.config.origin` reads (grep).
- [ ] Write-executor dispatch + confirm-flow tests green.
- [ ] ADR-0050 §Split-Pair Merge.

---

## C3 — Read dispatch through the registry (Candidate 05)  ⬜ DEFERRED — see [ADR-0050](docs/adr/0050-connections-backend-module-seams.md) §Registry Read Dispatch
**Blocked by:** C1, C2.

**What to build:** Reads dispatch through the adapter registry keyed by (capability,
provider), symmetric with the write-executor registry — replacing the per-tool
`if (conn.provider)` chains. Design-it-twice first (typed union of reader interfaces).

**Acceptance criteria:**
- [ ] Adapter registry widened with typed per-capability readers; tools dispatch via
      lookup, not provider if-chains.
- [ ] In-memory adapter fixtures let tool tests run without live providers; all green.
- [ ] ADR-0050 §Registry Read Dispatch.
- [ ] (Deferrable — tail of graph — if it proves too invasive, record and skip.)

---

## D1 — Thin the route layer (Candidate 07)  ✅
**Blocked by:** None (can run parallel to B/C).

**What to build:** One connect-start handler, one error mapper, one ownership guard, one
`{error}` helper across the 25 route handlers. API auth returns 401, not a 302 redirect.

**Acceptance criteria:**
- [ ] `handleCredentialConnect`, `mapConnectError`, `requireOwnedConnection` seams; single
      error helper; `isCapability` de-duplicated.
- [ ] `/api/connections/**` returns 401 (not 302) when unauthenticated.
- [ ] New tests for the 401 path + shared connect handler; all route suites green.
- [ ] ADR-0050 §Route Seams.

---

## E1 — Catalog grouping + OwnTracks UX  ✅
**Blocked by:** A1.

**What to build:** The "Add a connection" list visually separates solid products from
custom integrations (e.g. Google Calendar vs CalDAV) with a divider. OwnTracks'
admin-not-configured case reads as a clear message, not a generic failure.

**Acceptance criteria:**
- [ ] `group: "product" | "custom"` on `PROVIDER_META` + client `PROVIDER_CATALOG` mirror.
- [ ] Add-connection list renders a divider between the two groups; Todoist absent.
- [ ] OwnTracks `not_configured` (409) surfaces "OwnTracks isn't configured on this server".
- [ ] Verified in a running dev server (preview tools).
- [ ] ADR-0051 (grouping) extends ADR-0044.

---

## F1 — Doc/ADR/CONTEXT reconciliation + prior-loop audit  🟨
**Blocked by:** all code slices (A1, B1–B3, C1–C3, D1, E1).

**What to build:** Consolidate ADR-0050/0051, finalize the CONTEXT.md Connections
domain-language section, and confirm the prior deepening #4/#8 loop's docs (ADR-0036,
deepening-4-8-audit) are current.

**Acceptance criteria:**
- [ ] ADR-0050 + ADR-0051 complete and internally consistent.
- [ ] CONTEXT.md has a full Connections domain section (was absent).
- [ ] Prior-loop docs verified current; terms added only where a baseline was missing.

---

## F2 — Independent judge audit  ⬜
**Blocked by:** F1.

**What to build:** A separate judge subagent (fresh context) audits the whole integration
branch — behavioral equivalence, gates, dead refs, secret-firewall posture, docs↔code.

**Acceptance criteria:**
- [ ] Judge audit run at least once; findings looped back and fixed.
- [ ] All gates green post-fix.

---

## F3 — Deploy + live verification  ⬜
**Blocked by:** F2.

**What to build:** Merge, deploy to prod (per `memory/alfydesign-deploy-ops.md`), verify
Connections live.

**Acceptance criteria:**
- [ ] Prod deploy succeeds.
- [ ] Live checks pass: a connect flow, a capability read, a write-propose→confirm, and
      the OwnTracks config message.
