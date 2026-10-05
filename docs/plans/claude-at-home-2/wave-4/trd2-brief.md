# Fix agent TR-D2 · the admin's tour editor says what each field does; one live copy per kind; the badge (RC-T, admin side)

RC-T re-checked the tours (`wave-4/rct-report.md`: verdict ready, 2 Important, 14 Minor). You fix the admin side before
they go to ai.dev; TR-D1 fixes the reader side beside you. **Read RC-T's report first**: I-2 and Minors 1, 2, 3, 4,
8(a, c, d, e), 9, 10, 13.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-trd2`, branch
  `fix/tours-admin` (from `feat/artifacts-tours` `c66d80c1`), e2e port **5420**, label `trd2`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/trd2-report.md`;
  screenshots `…/scratchpad/w4/shots/trd2/`.
- Read first: `wave-4/common.md` (+ the Wave 3 rules); rulings 4, 32, 33, 69, 71; the TR-A and TR-C reports
  (`wave-4/tra-report.md`, `trc-report.md`); AGENTS.md's Tours section; ADR-0012 (`docs/adr/`, the badge lines RC-T cites).

## Steps

1. **I-2 and what the editor shows for a tour.** The summary slide's body is no longer required to publish a tour (server
   rule and its checklist mirror) and is not seeded with a false placeholder; the summary slide says in the editor that its
   title is the line an empty Document/App/Canvas shows (one hint, EN and HU). For a tour draft (Minors 2–4): the details
   dialog shows the type as a tour, read-only (no First-run/Release pills); the "Összegzés / Summary" layout is offered
   only for tours; a tour's slides do not offer the screenshot upload, alt text or button fields no tour uses; the
   performance card is not shown for a tour (tours record nothing by design); the rail and header count a tour's steps
   honestly (three steps plus the empty-state line, not "4 dia"). The preview: render the tour the way the reader sees it
   (the real card from `artifacts/tour/`, loaded lazily, with the draft's words) if that fits this step; otherwise hide the
   announcement preview for tours and say so in your report. Real clicks in Playwright for the publish of a tour whose
   summary has no body, red first.
2. **One live copy per kind (Minor 1), and the badge (Minor 9).** Publishing a tour revision archives any older published
   tour of the same kind, so there is at most one published tour per kind and archiving it brings the code copy back
   (ruling 71), with a test through the real path (seed → publish rev 2 → publish rev 3 → archive rev 3 → the reader gets the
   default copy). The sidebar badge resolves the newest published **announcement** campaign — first-run onboarding or
   release update, never a tour (ruling 32's words) — rather than release updates only; a test for "a newer first-run is what
   the badge replays" and the existing "a tour never" one; align ADR-0012's text if it needs a line.
3. **Words and small moves.** Minor 8(a): the Document tour's default copy names the pill's real buttons ("Megtartom" /
   "Visszavonom"; check the English against its buttons too); 8(c): the seed button says it makes drafts, and the help text
   no longer uses "bemutató" for two things; 8(d): seeded drafts are named in the seeding admin's language
   ("Dokumentum – bemutató" or better Hungarian; say what you chose); 8(e): the seed toast handles plurals in both
   languages. Minor 10: the account archive lists the seen tours under their own heading, not "Memory", if that is a small
   move. Minor 13: `seedArtifactTours` moves out of the module the chat loads into the admin's client module (and its
   strings, if any, follow).

Then the full gates once (Wave 3 rules' list; Playwright with `admin-users-campaigns.spec.ts`, `artifact-tours*.spec.ts`
and every artifact suite). Screenshots you look at yourself (HU, 1440 light): the tour editor's summary slide with its
hint, the details dialog of a tour draft, the preview.

**Runs beside you:** TR-D1 on `fix/tours-reader` (the panel's card timing, the Canvas re-fit, the card's strings in
`i18n/artifacts.ts`). You touch the campaigns service and routes, `artifact-tours.ts` (service), `artifact-tour-defaults.ts`,
the settings campaign components, `i18n/settings.ts`, the account archive, ADR-0012, and in `client/api/artifact-tours.ts`
only the `seedArtifactTours` move.
