# TR-A report: the tours' server side

Agent TR-A, model `claude-sonnet-5-5`. Worktree `.claude/worktrees/art-tra`, branch `feat/artifacts-tours`, e2e port 5410.
Commits `cf97b891..39649e44` (nine commits, listed at the end). Nothing pushed, merged or rebased; no other branch or worktree touched
(one detached scratch worktree under the scratchpad was created to measure the chunk gate at `cf97b891` and removed again).

**Status: DONE_WITH_CONCERNS.** Every step of the brief is built and every gate is green; the concerns (the chat-route chunk ceiling,
and one admin footgun the groundwork left open) are at the end and neither blocks TR-B.

## Step 1 — the groundwork is green; the badge fix

- **Groundwork on the Canvas-era tree: nothing needed fixing.** The nine test files (`artifact-tours`, `artifact-tour-defaults`,
  `announcement-campaigns` service, `campaign-checklist`, `seed-artifact-tours` route, client `campaigns`, route `campaigns`,
  `account-data-archive`, `account-lifecycle`) passed unchanged (121 tests); `npm run check` 0 errors / 17 warnings (the baseline);
  `npm run check:migrations` clean, no warning line.
- **T3.0, on its own commit `30681251`, before any tour route existed.** `getLatestPublishedCampaign(campaignType, options)` now takes a
  **required** type and is `latestPublishedByType` (the query `getEligibleCampaignForUser` already used); `/api/campaigns/latest` passes
  `"release_update"`. Tests: a published `artifact_tour` newer than a published release note is never the badge's campaign; a tour
  alone gives the badge nothing; the newest release note still wins when a tour is newer than it; the eligible path is still
  onboarding, then release, and never queues a tour; the route asks for `"release_update"`. Red first: with the old call shape the
  unfixed query returned `artifact_tour` (checked on a throwaway copy of the test, not committed); the one existing call site now says
  `"first_run_onboarding"`. `npm run check` was the compiler pass the spec asks for: no other caller exists.

## Step 2 — ruling 69 in code, the two routes, the browser module

- **One list.** `src/lib/shared/artifacts/tours.ts` declares `SHIPPED_ARTIFACT_TOUR_TYPES = ["document", "app", "canvas"]`,
  `ShippedArtifactTourType`, `isShippedArtifactTourType(value: unknown)` (a membership test on the array, so `toString` and `__proto__`
  are not kinds) and `ARTIFACT_TOUR_SLIDE_COUNT = 3`, plus the wire types of the two routes. The routes, the resolver
  (`getArtifactTour`), the seen write, the admin seeding (`seedArtifactTourDrafts` walks the list, not the defaults table's keys) and the
  account archive's labels all read it. The second list the groundwork had (`isArtifactTourType` and its `Set` in
  `artifact-tour-defaults.ts`) is gone. `ArtifactTourType` (every kind that can have copy) stays, so the **Slides default copy stays in
  `ARTIFACT_TOUR_DEFAULTS`** and nothing reaches it: a test pins that (`artifact-tour-defaults.test.ts`), and so do the service tests
  (a published Slides campaign is never served; `markArtifactTourSeen` refuses it), the route tests, the seed tests (3 drafts, no
  `slides`) and the e2e (the seed lists Document, App and Canvas drafts and no Slides one).
- **Service** (`services/artifact-tours.ts`): `resolveCurrentTour` (the one place the current tour and its key are decided, used by
  both the read and the write), `getArtifactTour`, `parseArtifactTourSeenBody` (hand-validated; keeps only the three fields, so a
  `conversationId` or `artifactId` in a body is dropped before it can reach a row), `markArtifactTourSeen`.
  Insert-if-absent is `onConflictDoNothing()` on the unique `(user, kind, content)` index, `alreadyRecorded = changes === 0`: race-safe
  and the first answer stands (a dismissal is not turned into a completion by a second tab). `slide_count` comes from the resolved tour,
  never from the client.
- **Routes** (`src/routes/api/artifact-tours/[type]/+server.ts`, `.../seen/+server.ts`): thin adapters, `requireApiUser`, ruling 49
  shapes, order of checks 401, 404, 400, 409, write. Exact shapes are in the hand-off below.
- **Browser module** (`src/lib/client/api/artifact-tours.ts` + test): `getArtifactTour`, `markArtifactTourSeen`, `seedArtifactTours`.
  `seedArtifactTours` **moved** here from `client/api/campaigns.ts` (the spec says this module is the only browser entry point), with
  its test; the admin pane's import was re-pointed (the only change to the pane).
- Commits `f8fb0caf` (list, service, seed), `95b7d1b0` (routes), `8b41f1cd` (browser module).

## Step 3 — T4's invariants, the containment suite, the archive and erasure

- **T4's list at the service level** (`artifact-tours.test.ts`): completed once and idempotent; dismissed is seen; a dismissal keeps its
  slide; the first answer stands; a new snapshot re-shows and the same one does not; a stale key is `content_changed` naming the
  current key (`null` when the kind's tour was retired); a kind that does not ship is refused; one user's tours never touch another's;
  the row holds no conversation id and no artifact id (by the table's columns and by every string it stores); **a write changes
  exactly one row in exactly one table and logs nothing** (row counts of every table before and after, console spied: this is the
  "no telemetry with any content" test); a user erased with their rows sees the tours again.
- **Containment suite: one new `describe`, seven tests, appended, and no `ALLOWED_WITHOUT_SCOPE` entry** (the existing "has not grown its
  exemption list" and "keeps the allow-list honest" tests pass untouched, and a new test says no entry may mention a tour). The tests:
  the row's exact column list (the only `_id` columns are `id` and `user_id`); a reader who names an incognito chat and its artifact in the
  query string and in the body still gets a row that names neither, and the artifact family is left exactly as found; the two routes run
  **without one SQL statement against an artifact, chat or file table** (a spy on `sqlite.prepare`); no tour module imports an artifact
  table or an artifact-side service (allow-list of two tables: the campaigns and its own); the check's own self-test; the "no exemption,
  and why it would be dead weight" assertion. Mutation-checked: making the service read `artifacts` fails three of the seven.
  **The client half of "an incognito chat shows no tour" is TR-B's trigger**; the server half is that the routes have no conversation
  parameter at all, so there is nothing for an incognito open to write or trace.
- **T7's server half.** T1 had already put the table in the archive and in the erasure registry; what was added is proof from the
  reader's side: three archive tests (kind and outcome listed for this user only, no row id, no content key, no word "artifact"; the
  section is absent with none; a stray `slides` row reads as the stored word, because the archive's labels are now keyed by the shipped
  list) and one lifecycle test that reads the erasure back **through the resolver the panel uses** (the erased user is shown the tours
  again, the other user's stay seen).
- Commits `8e7a47fb` (containment), `adb347da` (archive and erasure).

## Beyond the list (three small additions, all green)

- `tests/e2e/artifact-tours-api.spec.ts` (7 tests): the HTTP layer's own 401 for both routes (hooks answer `{ code: "session_expired" }`
  with `x-session-expired: 1` before the route runs; ruling 19: the route-level test asserts the handler's throw, this one the HTTP layer),
  a signed-in read of all three tours, the 404s (Slides, File, bogus, on both routes), a malformed write (400), a stale-key write (409),
  and the badge's endpoint never answering with a tour. **Read-only or refused writes only: the e2e user is shared by every spec of a
  run, so a spec that marked a tour seen would change what a later one sees.**
- `tests/e2e/admin-users-campaigns.spec.ts`: the seed clicked through the campaign menu (real input); red when Slides is seeded again
  (mutation-checked).
- Three route tests that run the whole path an admin's words travel (seed, edit, publish, serve, seen, 409 on the replaced copy, re-publish
  shows once more): they found nothing wrong, which is the point (`39649e44`).

## Gates (once, at the end)

The full vitest, build, chunk and Playwright runs were made before the last, test-only commit (`39649e44`: three route tests, no production
code); that file was run alone afterwards (19 passed) and `npm run check` and biome were rerun on the final tree.

| Gate | Result |
|---|---|
| `npm run check` | 0 errors, 17 warnings (the baseline: ToolActivityRow 10, ThinkingBlock 6, RouteItinerary 1) |
| `npx biome check src scripts tests` | clean, 2,456 files |
| `npm test` | 1,005 files passed + 1 skipped; **16,094 tests passed**, 2 skipped (74 `it` added, 4 removed or moved) |
| `npm run build` | exit 0; 32 `Unused CSS selector` + 2 `must have an ARIA role` (the baseline, nothing new) |
| `npm run check:artifact-chunks` | exit 0. Editor first-paint closure 69.6 kB gzip (the script's kB is KiB: ~71,270 B of the 71,680 B ceiling, unchanged from the baseline's ~71,267). **Chat route 538,929 B, +2,046 against the baseline of 536,883 (2,048 allowed)** (see concern 1) |
| Playwright, port 5410 | chat, conversation, knowledge, every artifact suite, plus `admin-users-campaigns`: **459 passed, 23 skipped, 0 failed** (39.2 min). 443 + 10 + 7 would be 460; the skip count equals the baseline's and nothing failed, so I read the one-off as the baseline's count, not a lost test |
| Fallow | 124 issues, 4 circular: identical to the baseline; no finding on a file of mine |
| `npm run check:migrations` | clean, no warning line (no migration of mine; `1777140000112` is the groundwork's) |

## Deviations from the spec, with reasons

1. **GET answers `{ ok: true, tour, seen, lastSlide }`.** The spec's literal body has no `ok`; ruling 49 (later) says every artifact route
   answers `{ ok: true, … }`, and the brief says to follow it. The browser module strips `ok`, as `fetchArtifact` does.
2. **The browser function is `getArtifactTour`** (the brief), not the spec's `fetchArtifactTour`. The server service also has a
   `getArtifactTour` (different module, different signature).
3. **`seedArtifactTours` moved out of `campaigns.ts`** into `artifact-tours.ts`, and keeps the groundwork's fallback message
   "Failed to seed the tour drafts" (the spec's says "artifact tours": the word must not reach a surface, ADR-0066).
4. **A 409 for a retired kind carries `contentKey: null`.** The spec defines the 409 only for "a key other than the current one"; a
   retired kind has no current key. Same reason (`content_changed`), same panel reaction (re-fetch, which then answers `tour: null`).
5. **`ResolvedArtifactTour.artifactType` is `ShippedArtifactTourType`**; `ArtifactTourType` (the four kinds that can have copy) is kept for
   the defaults table.
6. **The admin pane reads the list through the seed only: it has no per-kind enumeration to change.** I looked (`SettingsAdminCampaignsPane`,
   `CampaignRail`, `CampaignDialog`, `campaign-checklist.ts`, the settings strings): nothing there names a kind or says "four". The pane's
   seed button calls the seed, which now walks the list, and the e2e proves it through the UI.

## Open questions / concerns

1. **The chat route is at its chunk ceiling, and it was not me.** At `cf97b891` (the merged groundwork, before my commits) the gate
   already read **+2,048 of 2,048**; my commits make it 2 B smaller (+2,046): `artifact-tours.ts` is imported only by the admin pane, and
   `campaigns.ts` shrank. The headroom went to the merged groundwork (the settings i18n and campaign types are my guess; I did not bisect).
   Any growth in the chat route's closure by TR-B's panel work fails `check:artifact-chunks`. Orchestrator: decide the new
   `--chat-baseline` (in `package.json`, `check:artifact-chunks`) with a recorded reason, or tell TR-B to keep the tour card behind a lazy
   `import()`.
2. **An admin can orphan a tour by editing its "Release" field** (T5's groundwork, not the brief). The kind of a tour campaign lives in
   `releaseVersion`, and `CampaignDialog` lets an admin edit that text for any type. Change it from `canvas` to `2.1.0` and publish, and
   the resolver never finds the campaign: the code default keeps showing, silently. Slides cannot be served this way (the resolver
   answers only shipped kinds), so ruling 69 holds; but a typo detaches a real tour. Suggested fix, about an hour: refuse to publish an
   `artifact_tour` whose `releaseVersion` is not a shipped kind (a `validatePublishInput` rule, its mirror in `campaign-checklist.ts`, one
   message in each language in `settings.ts`). Not built: not in the brief, and it adds an admin-visible rule.
3. **A cosmetic wart in the same pane:** the campaign header (`SettingsAdminCampaignsPane` `metaLine`) labels a tour "Release · canvas ·
   4 slides" (it only knows first-run and release). Left alone.
4. **AGENTS.md has no tours paragraph.** I left it for TR-B (who completes the feature, and would otherwise conflict with me on the
   file). Suggested text, for them to paste and extend:

   > ### Tours (Feature 2, Slice 6; rulings 4, 8, 32, 33, 69)
   > `src/lib/server/services/artifact-tours.ts` resolves the first-open tour for a kind (a published `artifact_tour` campaign snapshot,
   > else the code-owned copy in `src/lib/server/artifact-tour-defaults.ts`), records "seen" (`markArtifactTourSeen`, insert-if-absent on
   > `(user, kind, content key)`) and seeds the admin drafts. `src/routes/api/artifact-tours/[type]` (GET) and `.../seen` (POST) are thin
   > (`requireApiUser`); the browser reaches them only through `src/lib/client/api/artifact-tours.ts`.
   > `SHIPPED_ARTIFACT_TOUR_TYPES` in `src/lib/shared/artifacts/tours.ts` is the one list of kinds whose tour ships (Document, App,
   > Canvas; Slides is shelved, File never): routes, resolver, seeding and the archive read it, so never walk `ARTIFACT_TOUR_DEFAULTS`'
   > keys to serve or list a kind. The seen row (`artifact_tour_states`) holds a user, a kind, a content key, a status and slide counters,
   > no conversation and no artifact; no tour code path reads an artifact table, and there is deliberately no `ALLOWED_WITHOUT_SCOPE`
   > entry for any of it. An incognito chat never shows a tour. `getLatestPublishedCampaign(type)` takes a required type: the sidebar
   > version badge asks for `"release_update"`, so a published tour never becomes the badge's campaign.

## HAND-OFF for TR-B

### The shipped kinds (`src/lib/shared/artifacts/tours.ts`, browser-safe, no imports but a type)

```ts
SHIPPED_ARTIFACT_TOUR_TYPES = ["document", "app", "canvas"] as const
type ShippedArtifactTourType = "document" | "app" | "canvas"
isShippedArtifactTourType(value: unknown): value is ShippedArtifactTourType   // use it on an open item's kind before anything else
ARTIFACT_TOUR_SLIDE_COUNT = 3
type ArtifactTourType = Exclude<ArtifactKind, "file">                          // kinds that can have COPY (incl. slides); do not use it to decide who gets a tour
type ResolvedArtifactTour = { artifactType: ShippedArtifactTourType; contentKey: string; source: "published" | "default";
                              slides: { title: {en,hu}; body: {en,hu} }[] /* always 3 */; summary: {en,hu} }
type ArtifactTourState = { seen: boolean; lastSlide: number }
type ArtifactTourResponse = ArtifactTourState & { tour: ResolvedArtifactTour | null }
type ArtifactTourSeenStatus = "completed" | "dismissed"
type ArtifactTourSeenRequest = { contentKey: string; status: ArtifactTourSeenStatus; lastSlide: number /* 0..2 */ }
type ArtifactTourSeenResponse = { ok: true; alreadyRecorded: boolean }
```

### `GET /api/artifact-tours/[type]`

- **200** `{ ok: true, tour: ResolvedArtifactTour | null, seen: boolean, lastSlide: number }`.
  `tour.contentKey` is `"default:<n>"` or `"snapshot:<campaign snapshot id>"`. `tour.summary` is the kind's empty-state line (the summary
  slide's title) and is the **same text** the empty state should show. `seen` means a row exists for this user, this kind and **this exact
  contentKey**, whether the user completed or dismissed; `lastSlide` is the stored slide (0 when unseen). `tour: null` means an admin
  retired the kind's tour (archived campaign): **still a 200**, `seen: false`, `lastSlide: 0`; show the i18n fallback line, no card, no error.
  A new published snapshot has a new key, so `seen` is false again until the user finishes it.
- **404** `{ ok: false, reason: "unknown_type" }` for any `[type]` not in the shipped list (`slides`, `file`, anything).
- **401**: no session. Over HTTP it is the hooks' JSON (`{ code: "session_expired" }`, header `x-session-expired: 1`), which `http.ts`
  already reports; nothing for the tour code to add.
- The route reads and writes nothing about a conversation or an artifact; the user is the session's.

### `POST /api/artifact-tours/[type]/seen`

Body `{ contentKey, status: "completed" | "dismissed", lastSlide: 0 | 1 | 2 }`. Extra fields are ignored (never stored). Checks run in the
order 401, 404, 400, 409, then the write.

- **200** `{ ok: true, alreadyRecorded: boolean }`: idempotent, insert-if-absent; the **first answer stands** (a later `completed` after
  a `dismissed` for the same content returns `alreadyRecorded: true` and changes nothing). Fire and forget is safe.
- **400** `{ ok: false, reason: "invalid_state", fieldErrors: { contentKey?, status?, lastSlide?: "invalid" } }`.
- **404** `{ ok: false, reason: "unknown_type" }`.
- **409** `{ ok: false, reason: "content_changed", contentKey: string | null }`: the key you sent is not the tour that resolves now
  (an admin published while the user read), or the tour was retired (`null`). Nothing was written. **Re-fetch with `getArtifactTour` and
  show the new copy from slide 0** (the failure table in the spec).
- Replaying from the panel's menu writes **nothing**: do not POST for a replay.

### The browser module (`src/lib/client/api/artifact-tours.ts`)

```ts
getArtifactTour(artifactType: ShippedArtifactTourType, fetchImpl: FetchLike = fetch): Promise<ArtifactTourResponse>
//   -> { tour, seen, lastSlide }   (`ok` is read and left behind)
markArtifactTourSeen(artifactType: ShippedArtifactTourType, payload: ArtifactTourSeenRequest, fetchImpl: FetchLike = fetch): Promise<ArtifactTourSeenResponse>
//   -> { ok: true, alreadyRecorded }
seedArtifactTours(fetchImpl: FetchLike = fetch): Promise<{ created: number; existing: number }>   // admin pane only
```

**Error mapping.** Every non-2xx throws `ApiError` (`./http`) and nothing special-cases a status: read **`error.status`**. Fallback messages:
`"Failed to load the introduction"`, `"Failed to record the introduction"`, `"Failed to seed the tour drafts"`. The family's
`{ ok: false, reason, … }` bodies carry no `error`/`message` field, so for a **404 or 409 `error.message` is the raw JSON text and there is no
`error.reason`**: never display it, and read the current key from a fresh `getArtifactTour` rather than from the error. The 400 carries
`error.fieldErrors`. A 401 is already handled by `http.ts`'s session-expiry path.

### What the panel should do (all of it is TR-B's)

Open of an item whose kind passes `isShippedArtifactTourType`, **not in an incognito chat** (do not call GET there either): `getArtifactTour(kind)`;
`tour && !seen` shows the card from slide 0; finishing posts `{ contentKey: tour.contentKey, status: "completed", lastSlide: 2 }`, dismissing at
slide `i` posts `status: "dismissed", lastSlide: i`; a 409 re-fetches and restarts at slide 0; `seen` with `lastSlide > 0` is what a resume would
start from; a failed GET or POST is a console warning and no dialog. `tour.summary` feeds the Document's and App's empty states.

### Facts that will bite in e2e

- Seen state is per user and persists for the whole run (`global-setup` wipes every table once, at the start). The e2e user is shared, and
  once the trigger exists **every artifact spec that opens a Document, App or Canvas will meet a tour on its first open of each kind** and mark
  it seen. TR-B needs one deliberate answer (for example a `login()`-side helper that GETs each shipped kind and POSTs `completed` with the
  returned key, or a runner-side `DELETE FROM artifact_tour_states` for the tests that need an unseen state). My API spec only reads, for this reason.
- There is no reset route, by design (replay writes nothing). The runner can reach the e2e database through `E2E_DATABASE_PATH`.
- A `Not implemented`/`MINERU status probe failed` line in the web-server output is noise.

## Commits (`cf97b891..39649e44`)

```
30681251 A version badge has one job, and a kind tour is not it
f8fb0caf Three tours ship, and one list says which; the seen write is insert-if-absent
95b7d1b0 Serve a kind's tour and take its seen state over two routes that know no chat
8b41f1cd Give the tours one browser module, and let the panel read a 409 off the error
8e7a47fb Say out loud that a tour's seen state is a user, a kind and a key, and reads no chat
adb347da Archive and erase the introductions a user has seen, and name only kinds that ship
69fb9ca4 Prove the tour routes and the three-draft seed over real HTTP and a real click
8f01b192 Say which layer answers an unauthenticated tour call
39649e44 Follow an admin's published words all the way to the panel and back
```
