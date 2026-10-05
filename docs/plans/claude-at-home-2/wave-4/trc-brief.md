# Agent TR-C · the empty states say what the tour says; the admin side's two gaps; the last tour strings; no Slides chip

TR-A (server) and TR-B (the card, the trigger, the list's replay row) are on `feat/artifacts-tours` (`e20be6e6`). You
finish the tours. **Read TR-B's hand-off first** (`docs/plans/claude-at-home-2/wave-4/trb-report.md`, `HAND-OFF for TR-C`):
`ArtifactBodyProps.onReplayTour`, where the strings live, the e2e user answer (`global-setup.ts` + `artifact-tours-helpers.ts`)
and the chunk rule (the card and the panel never import each other statically). New rulings 71 (tours) and 68's latest
note (the chat-route baseline) bind you.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-tra`, branch
  `feat/artifacts-tours`, e2e port **5410**, label `trc`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/trc-report.md`;
  screenshots `…/scratchpad/w4/shots/trc/`.
- Read first: `wave-4/common.md` (+ the Wave 3 rules it points to); rulings 4, 22, 32, 33, 60, 68, 69, 71; in `slice-6.md`,
  by range: 714–752 (the empty state), 752–832 (i18n), 919–936 (failure modes), T6 (1331–1376), T7 (1376–1418); TR-A's
  concerns 2–3 (`wave-4/tra-report.md`, "Open questions / concerns").

## Steps

1. **The empty state says what the tour says (T6).** `emptyStateLine` (the resolved tour's `summary` in the reader's
   language, else the i18n fallback), pointed at by the empty states of the Document, the App and the Canvas, each with a
   quiet `artifacts.tour.replay` link beneath it that calls `onReplayTour` (absent in an incognito chat and for kinds with
   no tour — then no link). The drift test reads both sources, so a shipped default's summary and its fallback string
   cannot disagree. Unit tests from T6's list; e2e with real clicks, red first: a new empty Canvas shows the summary line;
   after an admin edits and publishes the tour, the empty state shows the edited line; the empty state's link replays the
   tour and writes nothing. Find each kind's real empty state first (what a person sees in a new, empty one) and say what
   you found; if a kind has none today, add the line where its body shows "nothing here yet", without a new layout.
2. **The admin side's two gaps.** (a) Ruling 71: archiving a published tour **falls back to the code-owned copy** (correct
   TR-A's resolver and its tests; simplify TR-B's e2e helper if it no longer needs to delete); (b) an admin cannot publish
   an `artifact_tour` whose `releaseVersion` is not a shipped kind (a `validatePublishInput` rule, its mirror in
   `campaign-checklist.ts`, one message in each language) — test it through the admin UI with real clicks; (c) the campaign
   pane's meta line names a tour as a tour and its kind by the kind's word (`artifacts.type.*`), not "Release · canvas".
3. **The last strings, and no Slides chip.** T7's tests (every `artifacts.tour.*` key in both languages; no "artifact" /
   "artefaktum" in either locale, chrome or default content; the ratified Hungarian kind names in every default string
   that names a kind; illustration alt text built from `artifacts.type.*`), and **hide the Knowledge tab's "Slides" chip**
   (ruling 60's top row) while no Slides can exist (ruling 69), with a unit test and the Knowledge e2e still green. Add the
   empty states and the publish rule to AGENTS.md's Tours section.

If the chat route's chunk gate fails, move `--chat-baseline` by exactly your measured growth (ruling 68's note says how)
and give the numbers. Then the full gates once (Wave 3 rules' list, Playwright with `artifact-tours*.spec.ts` and
`admin-users-campaigns.spec.ts`). Screenshots you look at yourself (HU): a new empty Canvas with the line and link, at
1440×900 light and dark and 390×844; the Knowledge tab's chips; the admin refusal.

**Runs beside you:** agent CHP on `fix/follow-up-chips` (from `dev`: the follow-up chips and the language rule) — no shared files.
