# Agent TR-A · the tours' server side: the badge fix, the two routes, seen-tracking, three tours

Slice 6's groundwork (T1 the table, T2 types/defaults/resolver, T5 admin seeding) was built long ago from `c7c7587f`
on `feat/artifacts-s6`; the orchestrator has merged it, cleanly, onto today's `feat/artifacts` as `cf97b891`. You build
the server half of what remains. The panel card, trigger, replay and empty states (T3's client half, T6) are the next
agent's (TR-B), built on your routes and your browser module.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-tra`, branch
  `feat/artifacts-tours`, e2e port **5410**, label `tra`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/tra-report.md`.
- Read first: `docs/plans/claude-at-home-2/wave-4/common.md` (+ the Wave 3 rules it points to); rulings 4, 8, 29, 31,
  32, 33, 49, 69 in `decisions.md` (**ruling 69 wins over slice 6: three tours ship — Document, App, Canvas**); in
  `slice-6.md`, by range: 125–177 (the machinery, with line numbers that predate Canvas — re-anchor by symbol),
  355–494 (the routes, literally, and the client API), 557–611 (the seen table), 636–690 (where it is triggered and
  the badge), 919–936 (failure modes), T3 step 0 (1078–1110), T4 (1182–1242), T7 (1376–1418).

## Steps

1. **The merged groundwork is green, then the badge fix.** Run the groundwork's own tests
   (`artifact-tours.test.ts`, `artifact-tour-defaults.test.ts`, `announcement-campaigns.test.ts`,
   `campaign-checklist.test.ts`, `seed-artifact-tours.test.ts`, the archive and lifecycle tests), `npm run check` and
   `npm run check:migrations`; fix whatever the Canvas-era tree broke and say what. Then T3.0 exactly as specified:
   `getLatestPublishedCampaign` takes a required type, `/api/campaigns/latest` passes `"release_update"`, a test proves a
   published tour newer than the release note never becomes the badge's campaign — on its own commit.
2. **The two routes and the browser module.** `GET /api/artifact-tours/[type]` (the resolved tour + this user's seen
   state) and `POST /api/artifact-tours/[type]/seen` (validates the type, 409 on a `contentKey` that is not the current
   one, insert-if-absent, keeps `lastSlide` on a dismissal), both `requireApiUser` (401) and ruling 49's shapes; an
   unknown type, `file` **and `slides`** are a 404 like any unknown segment. `src/lib/client/api/artifact-tours.ts`
   (`getArtifactTour`, `markArtifactTourSeen`, `seedArtifactTours`) + its test, following `client/api/campaigns.ts`.
   **Ruling 69 in code:** one list of the kinds whose tour ships (`document`, `app`, `canvas`), declared once in
   `src/lib/shared/artifacts/tours.ts`; the routes, the resolver, the admin seeding and the admin pane read it, so no
   Slides tour is served, seeded or listed (the Slides default copy may stay in the defaults table for Slides' later
   merge; a test pins that it is unreachable).
3. **T4's invariants and the archive.** Seen-tracking and resumption per T4's test list (idempotent completion, a
   dismissal that is not auto-shown again but keeps its slide, a new published snapshot re-shows, the same one does not,
   no conversation or artifact id in the row, no content in telemetry); the containment suite gets **one new
   `describe`** asserting the row's columns and that no tour code path reads an artifact table — and **no**
   `ALLOWED_WITHOUT_SCOPE` entry (T4 explains why one would be a bug). The client-side half of "an incognito chat shows no
   tour" is TR-B's trigger; you pin the server side. Finish T7's server half: the account archive includes the tour
   states and erasure removes them (check what T1 already covers; add only what is missing).

Then the full gates once (Wave 3 rules' list; add `tests/e2e/admin-users-campaigns.spec.ts` to the Playwright run).
Your report's **hand-off** names the routes' exact response shapes, the client functions' signatures and error
mapping, and the shipped-kinds list — TR-B builds the panel on exactly those.

**Runs beside you:** agent SMP on `fix/internal-call-sampling` (from `dev`: internal model calls' sampling) — no shared
files.
