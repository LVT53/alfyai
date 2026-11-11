# Session response authority

The session store owns an in-memory auth generation. Each transport captures it
synchronously immediately before its fetch. A response may change session state
only while its original generation remains current. Auth transitions and explicit
reset/reauthentication invalidate older authority; response arrival time and text
are not authority heuristics.

## Evidence and limits

Gate 5 at `11a72a046` showed two identical session-expired announcements. A
controlled reproduction using the unmodified HTTP/store modules demonstrated:

- A successful response begun before expiry, delivered between two refusals,
  cleared the banner, reset the throttle and produced a second announcement.
- An older refusal delivered after fresh healing incorrectly expired the new
  session state again.

These are reproduced defects matching the symptom. Gate 5 retained no network
trace, so its exact historical request interleaving remains unproven. The layout
watcher records the monotonic announcement count before showing a toast and has
no demonstrated need for a change.

## Approved behavior

1. A healthy-to-expired or expired-to-healthy transition retires older requests.
   Explicit reset also retires in-flight authority when already healthy.
2. An old success cannot clear newer expiry. A new request begun after expiry can
   legitimately heal it on success. An older refusal cannot undo that healing.
3. An ordinary healthy response does not retire healthy sibling requests. A
   download probe's admitted response heals only an expired session; it is not
   an explicit reset while healthy.
4. Fresh refusals still raise the banner and announce after recovery. Sustained
   fresh refusals preserve the existing 30-second throttle. The announcement
   counter stays monotonic across healing and reset.
5. Original authority survives both header observation and delayed error-body
   parsing. Re-reading a header-observed refusal after healing cannot re-expire
   the session. Known-stale responses cannot fall through as untracked/current.
6. Preserve existing session-header, Unauthorized fallback and credential-error
   distinctions, raw Response identity, fetch arguments, abort signals, helper
   scheduling, streaming markers and completion behavior. Do not add a Promise,
   then or await stage around performRequest.

## Existing owners and covered transports

- `src/lib/stores/session.ts` owns expiry, announcement throttling and generation.
- `src/lib/client/api/http.ts` captures before each helper fetch and associates
  responses with their generation through a WeakMap for later body readers and
  auth reports.
- `src/lib/services/streaming.ts` captures before status, buffer and POST requests;
  POST header observation and body fallback use the same original authority.
- `src/lib/client/downloads.ts` guards both its delayed 401 report and existing
  admitted-below-500 healing rule with probe authority. Non-401 admitted responses
  retain their existing download result semantics.
- `src/lib/components/document-workspace/preview-runtime/index.ts` retains
  pre-fetch authority through response-body reading and the lazy HTTP import.
- `src/routes/(app)/knowledge/_components/DocumentsList.svelte` retains authority
  through the AI-version content request and error-body read, preserving abort.

Optional untracked compatibility remains for legacy public/test calls only; no
identified production auth mutation path is exempt. These are auth-observation
changes at existing seams, with no new state owner or networking framework.

## Acceptance evidence

Deferred unit tests exercise old successes between refusals, old header/body
refusals after recovery, explicit reset, fresh healing/reannouncement, throttle,
healthy siblings, raw Response identity and helper scheduling. They cover the
HTTP helpers, all three streaming observers, download probes, preview and
AI-version requests through their actual boundaries.

The controlled browser regression holds a real authenticated background response
begun before expiry, causes a real search refusal, releases the old success and
causes another refusal. It requires the banner and exactly one announcement;
existing strict toast assertions remain. No first-match workaround, retries or
timeout extension is part of the fix. Controller-owned build, targeted browser
and full gate establish release acceptance separately from focused unit results.
