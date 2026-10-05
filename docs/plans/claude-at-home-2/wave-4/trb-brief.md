# Agent TR-B · the tour card, its trigger in the panel, and the replay from the list's menu

TR-A built the tours' server side on `feat/artifacts-tours` (`39649e44`): the routes, the browser module
`src/lib/client/api/artifact-tours.ts`, and `SHIPPED_ARTIFACT_TOUR_TYPES` (document, app, canvas — ruling 69: no Slides
tour, no `TourArtSlides`). **Read its hand-off first** (`docs/plans/claude-at-home-2/wave-4/tra-report.md`, the section
`HAND-OFF for TR-B` and `Facts that will bite in e2e`): it gives the exact response shapes, the error mapping and what to
do on a 409. You build what a person sees. The empty states (T6), the empty-state replay link and the admin polish are
the next agent's (TR-C).

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-tra` (TR-A's, finished),
  branch `feat/artifacts-tours`, e2e port **5410**, label `trb`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/trb-report.md`;
  screenshots `…/scratchpad/w4/shots/trb/`.
- Read first: `wave-4/common.md` (+ the Wave 3 rules it points to); rulings 4, 8, 22, 32, 33, 68, 69; in `slice-6.md`, by
  range: 611–714 (the panel's contract, where it is triggered and where not, the replay entry point), 752–846 (i18n,
  illustrations), 892–936 (UI states, failure modes), 953–971 (the design reference: section 7 of
  `docs/plans/claude-at-home-2-artifact-surfaces-mockups.html`), T3 (1078–1182), T7 (1376–1418), and the tour lines of
  the verification checklist (1454–1512). AGENTS.md's Artifacts section (the panel, the body registry, one body per open
  item, the list rows). The spec's line numbers in `DocumentWorkspace.svelte` predate the redesign: re-anchor by symbol.

## Steps

1. **The card.** `src/lib/components/artifacts/tour/ArtifactTour.svelte` + `TourArtDocument`, `TourArtApp`,
   `TourArtCanvas` (drawn, tokens only, `aria-hidden`, the AGENTS.md-exception comment the spec gives), the `artifacts.tour.*`
   strings in EN and HU (Dokumentum, Alkalmazás, Tábla), and T3's component tests (three slides with dots, Next/Back
   bounds, `onSeen` once with the last slide on finish, `onDismiss` with the current slide on Skip, Escape = Skip, one
   region that traps no focus with Skip first in tab order, the step announced, replay calls neither callback, live
   language switch with an `en` fallback, instant under reduced motion). **The card and its illustrations are one lazy
   entry** loaded with `import()` only when a tour is about to show, never statically imported by the panel: the chat
   route is at +2,046 of its 2,048 B budget. If the strings and the trigger still push it over, move `--chat-baseline` in
   `package.json` by exactly the measured growth and put the before/after numbers in your report (ruling 68 note).
2. **The trigger and the replay row.** In `DocumentWorkspace.svelte`: on open of an item whose kind passes
   `isShippedArtifactTourType`, and **not in an incognito chat (no request at all there)**, one `getArtifactTour(kind)`;
   `tour && !seen` shows the card in the panel's content area above the body; the seen write fires on finish or Skip,
   never on render (closing the panel mid-tour writes nothing); a 409 re-fetches and restarts at slide 0; a failed GET or
   POST is a console warning and the panel works as before; File and Slides never ask. The replay: one "How this kind
   works" row in the panel list's per-item menu (ruling 32; quiet row; replay writes nothing); if the list has no such
   menu, say so and leave the replay to TR-C's empty-state link. Expose the replay to bodies as one callback (named in
   your hand-off) for TR-C's empty-state link. **The shared e2e user:** once the trigger exists every artifact spec would
   meet a tour on its first open; choose one deliberate answer (TR-A's report suggests two) that leaves every existing
   spec's behaviour unchanged and adds no test-only route to the app, and say which.
3. **Proof with real input.** `tests/e2e/artifact-tours.spec.ts`, red first, driven by real clicks and keys: first open
   of each kind shows its tour; the second open does not; a different kind shows its own; a File never; Skip at slide 2
   then reopen → not shown; finish with the keyboard alone (Tab/Enter/Escape); the sidebar version badge never opens a
   tour even with one published; replay from the list's menu shows it and writes nothing; a failed tour request leaves
   the panel working; an incognito chat shows none; a second user still sees it; 390×844 without overflow. Screenshots
   you look at yourself (HU): the Canvas tour at 1440×900 light and dark and at 390×844, the Document tour's last slide,
   the replay row in its menu.

Then the full gates once (Wave 3 rules' list, Playwright with `tests/e2e/artifact-tours*.spec.ts` and
`admin-users-campaigns.spec.ts` added). Hand-off for TR-C: the replay callback's name and where bodies get it, where the
card's strings live, the e2e user answer.

**Runs beside you (maybe, started later):** agent W4-B on `feat/artifacts-s5b-bundle` (the project bundle and doc fixes).
You share only `src/lib/i18n/artifacts.ts`: append your keys in your own block.
