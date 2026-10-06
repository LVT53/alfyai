# TR-D2 report: the admin's tour editor says what each field does; one live copy per kind; the badge

Agent TR-D2, model `claude-sonnet-5-5`. Worktree `.claude/worktrees/art-trd2`, branch `fix/tours-admin` (from `feat/artifacts-tours` `c66d80c1`), e2e port 5420.
Commits `92b3c93f..fe81a978` (13). Nothing pushed, merged or rebased; no other branch or worktree touched (one throwaway detached worktree of the
base commit under the scratchpad, to measure the chat route on the same machine, removed again); no subagent.

**Status: DONE_WITH_CONCERNS.** Every item of the brief is built and every gate is green. The concerns (the chat-route baseline moved by +159 B, the preview is
narrow, the unit tests of the preview followed its component) are at the end.

## Step 1: what the editor shows for a tour (I-2, Minors 2, 3, 4)

**I-2, the summary slide's body.** The server rule (`announcement-campaigns.ts` `validatePublishInput`) asks a tour's summary slide for its title in both languages
and no body (message "Localized EN/HU title is required."); every other slide, and a release note's own summary-layout slide, still needs its body. The client
mirror (`campaign-checklist.ts`, `isTourSummary`) says the same. The seed (`artifact-tours.ts` `seedArtifactTourDrafts`) leaves the summary body empty: the false
"shown under the artwork" placeholder is gone. `SlideEditor.svelte` takes a new `tour` prop: on the summary slide it shows the heading "Empty-state line" /
"Üres állapot sora", the title field and one hint, and no body field; the hint is `admin.campaigns.tour.summaryHint` ("The title is the line an empty Document, App or
Canvas shows. Nothing else on this slide is shown." / "A cím az a sor, amit egy üres dokumentum, alkalmazás vagy tábla mutat. Ezen a dián más nem jelenik meg.").

**Minor 2, the details dialog.** `CampaignDialog.svelte`: for a tour the type is a read-only pill ("Tour · Canvas" / "Bemutató · Tábla", `tourLead`), no First-run/Release
pills and no Release field; the name stays editable; saving keeps `artifact_tour` and the kind. The pill takes no pointer (`pointer-events: none`), so it takes none of
the pill hover either (the hover-affordance guard refused my first, overriding rule).

**Minor 3, the layout picker.** `SlideOptionsDialog.svelte` offers Summary to a tour only (a slide that already has it keeps it visible, so a state that cannot be
published is never hidden). Beyond the brief: a tour is not offered Setup either, and its Purpose and Setup-controls sections (and the same two items in the slide ⋯ menu,
`SettingsAdminCampaignsPane.svelte` `slideMenuItems`) are out, since only first-run onboarding uses them.

**Minor 4, the rest.** A tour's slides have words only: no desktop/mobile screenshot, alt text or button fields (`SlideEditor` `{#if !tour}`). The performance card is not
drawn for a tour (`showPerformance`). The rail and the header count "3 steps + empty-state line" / "3 lépés + üres állapot sora" (`tourCountLabel` in `campaign-labels.ts`,
one string with the house plural; used by `CampaignRail` and the pane's `metaLine`). The slide rail reads the way a reader meets the tour: the summary slide has no number and
an "Empty state" / "Üres állapot" tag under its title, the steps are 1, 2, 3 (`tourStepNumbers`), and no empty picture slot is kept (`SlideRailItem` gained `label`, `tag`,
`picture`). A tour slide's editor region is named by its heading ("Step 1"), not "Slide 2 editor".

**The preview (done, not hidden).** `campaigns/TourPreview.svelte`: the reader's own card (`artifacts/tour/ArtifactTour.svelte`), loaded lazily with `import()` on mount, so the
settings route does not carry it until a tour is open, drawn with the draft's words in the language being edited (each text is handed over in both fields, so the card, which
reads the interface language for its text, shows the edit locale; its chrome stays in the admin's interface language), for the slide open in the rail (`{#key stepIndex}`);
it follows typing. The summary slide previews as the shared `EmptyState` (the line and "Show it again") in a dashed page-like box. The wrapper is `inert`: the card's
focus-taking on mount, its Escape-is-Skip and its buttons never reach the admin, and nothing is recorded (an e2e asserts no `/api/artifact-tours` POST and that the title field
keeps the keyboard). A tour whose release text names no shipped kind shows the existing tour-kind sentence instead of a card. The device toggle is hidden for a tour (no
desktop and mobile screenshots to switch between). `ArtifactTour.svelte` is untouched (TR-D1's).

**Also needed:** publishing a tour archives the revision it replaces (Step 2), so the pane refreshes the rail after a tour publish (`refreshCampaignList`: the list only, the open
campaign and slide stay).

**Tests (red first unless said).** Server: 4 publish-rule tests (bare summary publishes; summary title still required; a step's body still required; a release note's summary slide
keeps its body) and the seed tests (body empty; drafts publish as seeded); the checklist mirror (4); pane tests (hint and no body field, Hungarian hint, step heading and region,
no screenshot/alt/button on any slide, rail labels and no picture slots, slide menu, layout choices for tour / release / first-run / existing summary, details dialog,
rename keeps type and kind, no performance card for a published tour and still one for a release note, rail refresh after a tour publish, no extra list call after a release);
`campaign-labels.test.ts` (9). **Playwright, real pointer and keyboard** (`tests/e2e/artifact-tours-admin.spec.ts`, 5 tests): publishes a tour whose summary slide has no body
(hint visible, no body field, none of the unused fields on any of the four slides, checklist ready, Publish clicked, "Campaign published.", the reader is served the admin's line,
no performance card, Duplicate then Publish leaves one Published and one Archived row, Archive through the confirm dialog gives the code copy back), the details dialog, the
layout picker (tour vs release note), the count in Hungarian (a Hungarian admin), the preview (summary line, step card, step 3 with the last-slide hint, typing, HU pill, no POST,
focus stays in the field). Red: with the server rule fixed and the UI not, all four then-existing flows failed on the right assertion (hint missing, pills present, Summary offered,
"4 dia"); the publish rule itself was red at the unit level before any change. The preview's unit and e2e tests were written after its component (they pass on the first run; they
cannot have been red because the testids did not exist before).

## Step 2: one live copy per kind (Minor 1) and the badge (Minor 9)

**One live tour per kind.** `publishCampaign` (in its transaction) archives any older published `artifact_tour` of the same kind, campaign row and snapshot, through one
shared `archivePublishedRow` that `archiveCampaign` also uses. A release note keeps its older published revisions (the latest wins, as before). Tests: unit (revision 2 retires 1,
snapshot included; three revisions leave one published; another kind's tour, a draft, an archived revision and a release note named "canvas" are untouched; two published release
notes stay published) and **through the real path** in `artifact-tours.test.ts`: seed, publish revision 1, Duplicate > publish revision 2, Duplicate > publish revision 3 (the
reader is served revision 3, 1 and 2 are archived), archive revision 3, the reader gets the default copy and its key. I proved that test red against the unfixed service
(the status list it asserts failed: the older revisions stayed published) and green with it. (The brief's "publish rev 2, rev 3": the seeded draft is rev 1, so the chain is one longer.)

**The badge.** `getLatestPublishedCampaign(type)` is replaced by `getLatestPublishedAnnouncement(options)` (no type argument): newest published first-run onboarding or release
update by `publishedAt` then revision, never a tour; `/api/campaigns/latest` calls it. Tests: a newer first-run is what the badge replays; a release note published after it wins;
a first-run alone is replayed even with a newer tour; the existing "a tour never" and "only a tour gives nothing"; the route test asserts the argument-free call. ADR-0012's two
badge lines say it is the latest announcement campaign (first-run or release), never a tour. AGENTS.md's Tours section now says the same, plus one live tour per kind, the bare summary
slide and the admin editor's facts. The e2e that opens the badge with a tour published asserts "never a tour" and only expects no dialog when nothing is announced.

## Step 3: words and small moves

- **8(a)** The Hungarian Document tour now says „Megtartom” és „Visszavonom” gomb; a test holds both languages' copy to `artifacts.document.change.keep/undo` (the English already named
  Keep and Undo). The content version is not bumped (nobody has seen the default yet).
- **8(c)** The Hungarian seed button is "Bemutató-piszkozatok létrehozása" (the English "Seed tour drafts" already said drafts), and the Hungarian first-run help no longer says
  "bemutatókampány" ("Létrehozza a szokásos első indítási kampányt szerkeszthető piszkozatként."), so "bemutató" means a tour only.
- **8(d)** Seeded drafts are named in the seeding admin's interface language: the route passes `locals.user.uiLanguage`, the service takes `{ language }`. English admin: "Document tour",
  "App tour", "Canvas tour" (unchanged). **Hungarian admin: "Dokumentum bemutatója", "Alkalmazás bemutatója", "Tábla bemutatója"** (the kind is the interface's ratified word, held by a test
  against `artifacts.type.*`; no "artifact" in either language).
- **8(e)** The seed toast has two messages instead of "{created} created, {skipped} existed": "Created 3 tour drafts." / "Created 1 tour draft." (EN plural) and "The tour drafts already exist."
  when none were made; Hungarian "3 bemutató-piszkozat létrejött." (no plural after a numeral, as the language has it) and "A bemutató-piszkozatok már léteznek."
- **Minor 10** The account archive lists "Feature introductions seen" on the **Profile page** (an account fact), no longer on the Memory page; the section itself is unchanged (kind and
  outcome, no content key, no id). Tests moved with it.
- **Minor 13** `seedArtifactTours` and its two tests moved from `client/api/artifact-tours.ts` to `client/api/campaigns.ts`, beside `seedFirstRunCampaign`; the pane imports it from there.
  **This does not take bytes off the chat route:** `campaigns.ts` is imported by the app layout, so it is in the chat's closure too (the built `ChnWDski.js` holds both seeds). It only keeps
  the tours module to what the panel uses. See the concern below for what would.

New strings (EN and HU, same commit): `admin.campaigns.tour.{emptyStateTag,stepCount,stepNumber,summaryHint,summarySlide}`, `admin.campaigns.messages.artifactToursExist`; changed:
`messages.artifactToursSeeded`, and in Hungarian `seedArtifactTours`, `errors.seedArtifactTours`, `seedFirstRunHelp`. I wrote three more helper strings (a type note, a layout help, a "preview needs a kind"
line) and removed them again before the end: every settings string rides in the chat's dictionary, and the existing tour-kind sentence covers the last.

## Gates (once, at the end, on the finished tree)

| Gate | Result |
|---|---|
| `npm run check` | 0 errors, 17 warnings (the baseline: ToolActivityRow 10, ThinkingBlock 6, RouteItinerary 1) |
| `npx biome check src scripts tests` | clean, 2,475 files |
| `npm test` | 1,011 files passed + 1 skipped; **16,260 tests passed**, 2 skipped (+65 on 16,195). The first full run caught one real regression of mine (the hover-affordance guard refused `.type-fixed:hover`); fixed and rerun clean |
| `npm run build` | exit 0; 32 `Unused CSS selector` + 2 `must have an ARIA role` (the baseline, nothing new) |
| `npm run check:artifact-chunks` (own step, on that build) | **exit 0.** Editor first paint 69.7 KiB gzip (ceiling 70). **Chat route 541,158 B gzip = +2,016 against the moved baseline 539,142 (2,048 allowed): 32 B of headroom.** See the baseline note |
| Playwright, port 5420 | admin-users-campaigns, every artifact suite (incl. `artifact-tours*.spec.ts`), chat, conversation, knowledge: **490 passed, 23 skipped, 0 failed** (39.9 min; 513 tests = the baseline's 508 + my 5 new) |
| Playwright, tours-admin spec once more after the cleanup edit | 5 passed (plus the throwaway screenshot spec) |
| Fallow | 124 issues, 4 circular: identical to the baseline (unused files 13, exports 87, types 9, deps 3+1); no finding on a file of mine |
| `npm run check:migrations` | clean (no migration of mine) |

### The chat-route baseline (ruling 68 note), numbers
Measured on one machine, built the same way: the base `c66d80c1` (a throwaway detached worktree) **540,999 B**; this tree **541,158 B**; so my growth is **+159 B gzip**, which is the new
dictionary strings the admin tour editor adds (every route's `i18n` chunk carries the settings dictionary). `--chat-baseline` in `package.json` moved by exactly that, **538,983 to 539,142**,
so the route sits where the base sat (+2,016 of 2,048). **TR-D1 will move it by its own growth too: the two deltas add** (539,142 plus theirs), or the orchestrator re-baselines the merged tree.

## Screenshots (HU, 1440x900 light, each looked at)

`/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/shots/trd2/` (the throwaway spec that took them is `../../zz-trd2-shots.spec.ts.txt`, not committed):

- `editor-summary-hu-1440-light.png`: the summary slide: heading "Üres állapot sora", the Cím field, the hint under it, no Szöveg field; the rail with the "ÜRES ÁLLAPOT" tag under the title and steps 1 to 3 (the title there is the English one: the rail has always shown the
  English title first); the header "Bemutató · Tábla · 3 lépés + üres állapot sora"; the preview is the empty state: the Hungarian line and "Újra megnézem" in a dashed box. Two archived "E2E bare line tour" rows in the campaign rail are what my own e2e left (archived by its cleanup).
- `details-dialog-hu-1440-light.png`: "Kampány adatai": Név (editable) and Típus as the read-only pill "Bemutató · Tábla"; no Első indítás/Kiadás pills, no Kiadás field.
- `editor-step-hu-1440-light.png`: step 1: "1. lépés" with Cím and Szöveg only (no screenshots, alt text or button), and the preview is the reader's card (illustration, dots, "1. lépés, összesen 3", the title in the serif face, the body, Kihagyás and Tovább).

## Deviations from the brief, with reasons
1. **Beyond the brief, in the same spirit:** Setup and the Purpose/Setup-controls items are not offered to a tour; the tour's rail has no picture slots; the device toggle is hidden for a tour; the region name. Each is a field or choice no tour uses.
2. **The badge reader is renamed**, not given a list parameter (`getLatestPublishedAnnouncement`), so no caller has an argument to get wrong; the old function had no other caller.
3. **Minor 10 went to the Profile page**, not a new top-level page: a new page needs an entry-page link, a count and its tests for a cosmetic finding.
4. **The seed toast says nothing about how many already existed** (the old second number); an admin cares whether anything was made.
5. **The tours-admin e2e is a new file** (`artifact-tours-admin.spec.ts`, inside the `artifact-tours*` glob the gate runs), rather than more tests in `admin-users-campaigns.spec.ts`, whose seed and refusal tests I only updated for the new toast and counts.

## Open questions / concerns
1. **The chat-route baseline moved by +159 B (above); TR-D1's growth will add to it.** What would actually take bytes off every route: `client/api/campaigns.ts` holds ten admin-only calls (`fetchAdminCampaigns`... `seedArtifactTours`, about 140 lines) that only the pane uses and
   that ride in the layout's chunk; an admin-only module for them would take roughly 300 to 400 B gzip off the chat route (my estimate from the chunk's size, not measured), more than this task adds. I did not do it: the brief names the seed alone, and it changes a module the app layout
   imports. Worth a small follow-up if the orchestrator wants the headroom back.
2. **The preview card is narrow.** The admin's preview column is about 360 px, so the real card (built for the panel's width, responsive by the viewport, not by its container) wraps its text more than a reader sees ("1. lépés, / összesen 3" on two lines). It is the real card with the real words, not a scaled picture.
3. **The preview's tests followed its component** (the rest of the work was red first, see Step 1).
4. **Already-seeded drafts keep the old placeholder body** in their summary slide's data (dev and e2e databases only; nothing shows it any more and a publish does not need it). Reseeding does not overwrite a kind that has a campaign.
5. **One-per-kind is enforced at publish.** A database that already holds two published revisions of a kind (none can arise through the pane or the routes now) keeps resolving to the newest, as before; no migration was written.
6. **Slide structure is still the admin's to break:** "Add slide", Delete slide and Move on a tour are offered; the shape rule and the checklist catch a tour that is not one summary slide and three steps.
7. **Method note:** two `artifact-tours.spec.ts` tests failed once in a combined run in which I was editing the source (hot reload under a running browser); the spec alone, with nothing in flight, passed 15 of 15, and the full gate run was made with no edits in flight.
8. The details dialog's generic description ("... choose what it is for ...") still shows for a tour (it is the create flow's line, used in edit mode for every type; not mine).

## HAND-OFF
- **Server:** `announcement-campaigns.ts`: `getLatestPublishedAnnouncement(options)` (replaces `getLatestPublishedCampaign`), `publishCampaign` retires the replaced tour (`archivePublishedRow`), `validatePublishInput` `isTourSummary`. `artifact-tours.ts`: `seedArtifactTourDrafts(userId, { db?, ids?, language? })`, `TOUR_DRAFT_NAMES` per language. `api/admin/campaigns/seed-artifact-tours` passes `locals.user.uiLanguage`.
- **Client API:** `seedArtifactTours` is in `client/api/campaigns.ts` now; `client/api/artifact-tours.ts` is the panel's reads and the seen write only.
- **Admin components** (`src/routes/(app)/settings/_components/campaigns/`): `SlideEditor` prop `tour?: { summary: boolean; step: number | null } | null`; `SlideRail` item fields `label?`, `tag?`, `picture?`; `campaign-labels.ts` `tourCountLabel(slideCount, t)`, `tourStepNumbers(slides)`; `TourPreview.svelte` props `{ releaseVersion, slides, locale, slideIndex }`; `CampaignDialog` shows a tour's type read-only from its `type` and `releaseVersion` props; `SlideOptionsDialog` reads `campaignType`.
- **Tests and helpers:** `tests/e2e/artifact-tours-admin.spec.ts` (its `removeDrafts(request, ids, names)` archives what it published and deletes its drafts); `admin-users-campaigns.spec.ts` follows the new toast ("Created N tour drafts." or "The tour drafts already exist.") and counts.
- **Gate setting:** `package.json` `check:artifact-chunks` `--chat-baseline 539142` (was 538983), with the numbers in its commit `505ef9d3`.

## Commits (`c66d80c1..fe81a978`)
```
92b3c93f A tour's summary slide is one bare line: its body is no longer asked for or seeded
ac7b2b6e Keep the admin's tour seeding out of the module the chat loads for the tours
a3203aab A kind has one live tour: publishing a revision retires the one it replaces
9b574ac9 The version badge opens the latest announcement, a first-run onboarding as well as a release note
8134babb The admin's tour editor asks a tour for what a tour is, and previews it as the card
b33ea203 The Hungarian Document tour names the change pill's buttons as they read
0ae1ead3 Seeded tour drafts are named in the language of the admin who seeds them
b20e986c The account archive files the introductions a user has seen with the profile, not with Memory
f3bcbeb2 Say in AGENTS.md what the admin's tour editor, one live tour per kind and the badge now do
3671fa3f Keep the admin tour strings to the ones that say something new, and name a tour slide by what it is
3d8ec4a7 A tour's fixed type takes no pointer, so it takes none of the pill's hover either
505ef9d3 Move the chat-route baseline by the 159 B the admin tour editor's strings add
fe81a978 Have the admin tour spec leave the shared database as it found it, even when it fails
```
