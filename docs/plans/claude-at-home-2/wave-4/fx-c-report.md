# FX-C report: M-1, M-2, M-3, M-7 (the Sources rows tell the truth; one list of shipped kinds; the card's meta line)

Model: `claude-sonnet-5-5`. Worktree `art-fxc4`, branch `fix/artifacts-w4-sources` (from `feat/artifacts` `d89ab5a4`), e2e port 5420.
Commit range: `d89ab5a4..80dd07c5` (8 commits, all with the Co-Authored-By trailer; nothing pushed, merged or rebased).

```
5d618aa5 Ask the kinds' own list which kinds a made row may name, not the tours'        (M-3)
c03a049c Make a made row of a deleted item say so instead of posing as a link             (M-1)
2dac9ed1 Say a fork's copied Sources were made in the original chat                       (M-2)
914ebd20 Keep a number with its unit in the in-chat card's meta line                      (M-7)
d044426e Let the deleted sentence in a Sources row wrap on a narrow row                   (M-1, CSS found in the 320 px screenshot)
0fc012d1 Format this fix's tests and specs the way the linter does
eeff4d28 Fork with the reader's own click in the fork Sources spec                        (M-2 spec: real "Fork from here")
80dd07c5 Give the library-delete Sources spec a title of its own                          (M-1 spec: shared e2e DB)
```

Status: **DONE_WITH_CONCERNS**. The concerns are one deviation from the brief (M-7 is not CSS-only, with measurements), the chat-route growth, and a pre-existing layout defect I found while measuring M-7. All under "Decisions" and "Concerns".

## What changed, per finding

### M-3 · one list of shipped kinds (`5d618aa5`)
- `shared/artifacts/kinds.ts`: `SHIPPED_ARTIFACT_KINDS = ["document","app","canvas"]` (`as const satisfies readonly ArtifactKind[]`), `ShippedArtifactKind`, `isShippedArtifactKind(value: unknown)` (a membership test, never a property lookup: `"toString"`/`"__proto__"` are not kinds). No imports; browser-safe.
- `shared/artifacts/tours.ts`: `SHIPPED_ARTIFACT_TOUR_TYPES` stays its own list (so a kind may ship without a tour) but is **checked** against the kinds' list at compile time: `satisfies readonly (ArtifactTourType & ShippedArtifactKind)[]`. A tour listed for a kind that does not ship fails to compile. Doc comments say "bringing Slides back is one entry in each list".
- The two guards now read `isShippedArtifactKind`: `chat-turn/finalize-steps.ts` (`turnArtifactsFromToolCalls`) and `chat/MessageEvidenceDetails.svelte` (`artifactKindOf`). Every other user of `isShippedArtifactTourType` is genuinely about tours (panel tour, routes, admin seeding, archive labels) and is unchanged.
- File is deliberately not on the list: it is the produced-file kind (ruling 18), made by `produce_file`, never named by `create_artifact` / `edit_artifact`. This keeps W4-E's pinned behaviour (a hand-written `ok:true` File/Slides call is not named) with no second condition.
- Red first: `kinds.test.ts` (5 tests, export missing); `finalize-steps.test.ts` "names a kind that ships whatever its tour does" and `MessageEvidenceDetails.test.ts` "names and opens a kind that ships whatever its tour does" each shelve the tours through a mock that is transparent by default (the group was `undefined` / the row was plain on the unfixed tree).

### M-1 · a deleted item's "Made in this chat" row says so (`c03a049c`, `d044426e`)
- `chat/MessageBubble.svelte` hands `MessageEvidenceDetails` the `DeletedArtifacts` value it already holds (2 lines; the chat page itself needed no change, the prop already travels page → pane → area → bubble).
- `MessageEvidenceDetails.svelte`: new prop `deletedArtifacts`; `madeStateOf(item)` is `"unreachable"` (wins, as on the card), `"deleted"` or `null` for a made row with a known kind. A row that is not live is **not a button**: plain text, muted title (token `--text-muted`), and in place of the kind word it says the card's own sentence (`artifacts.deleted.<kind>`: "Ez a dokumentum törölve lett" / "This document was deleted"); an unreachable row stays plain with its kind word. No new i18n string. Because it reads the page's own state: a stale row flips when its click finds the item gone (the existing open path already updates `deletedIds`), and it is a link again when Regenerate makes the item back under the same id.
- CSS: `.evidence-row-plain--gone .evidence-kind { max-width: 45%; white-space: normal; text-align: right }`, because the sentence is longer than a kind word and pushed past the row's edge on a 320 px screen with a long title (screenshot 07, looked at before and after).
- Red first, the reader's own clicks (`tests/e2e/artifact-delete.spec.ts`, describe "A Sources row of an item that was deleted"): (a) the existing "deleted elsewhere, click the row" test, extended: after the card flips, the row says the sentence and no button remains; (b) NEW "says so when it was deleted from the library": Knowledge → Documents → the row's Delete → confirm, back in the chat the card is deleted and the row says so and a click on it opens no panel; (c) NEW "goes back to a live row when Regenerate makes the item again". All three failed on the unfixed tree with the group reading `" Weekend plan Document "`.
- Unit (`MessageEvidenceDetails.test.ts`, 5 tests): plain text with the card's words, no way to open; per kind in EN and HU; unreachable plain and never "deleted" (both lists naming the id: out-of-reach wins); live again on rerender; nothing marked without state. A mutation check (making `madeStateOf` always `null`) fails 4 of them.

### M-2 · a fork's copied Sources say "made in the original chat" (`2dac9ed1`)
- `MessageBubble` passes `madeInOriginalChat={Boolean(message.forkEvidenceSnapshot)}` (the copied message carries the snapshot the server already projects; nothing new is stored or read). `MessageEvidenceDetails` heads the group with `artifacts.madeInOriginalChat` ("Made in the original chat" / "Az eredeti beszélgetésben készült", the card's own wording, already in both languages) instead of `artifacts.evidence.madeInThisChat`. The `role="group"` label follows.
- Rows are unchanged: a normal fork's row still opens the parent's Document; an incognito fork's row is plain (its Document is out of reach, M-1's `unreachableIds`). What the fork itself makes keeps "Made in this chat" (a turn's own Sources are not a copy).
- Red first (`artifact-delete.spec.ts`, describe "A fork's copied Sources", 3 tests): normal fork made with the real **Fork from here** click on the message that made the Document (hover, click, `waitForURL`, expand Sources: heading, row opens the parent's Document with a real click); incognito fork (service, as the existing incognito-fork test: its parent is made incognito behind the page's back): heading, plain row, nothing called deleted; a fork's own later turn keeps "Made in this chat" next to the copied "original chat" group. All three failed on the unfixed tree (no group named "Made in the original chat"). Unit: 2 tests (EN, HU).

### M-7 · "1 fül" never wraps apart (`914ebd20`) — **not CSS-only, see Decisions**
- `components/artifacts/ArtifactCard.svelte`: `keepFactsWhole(text)` = `text.replace(/([\d·]) (?=[\p{L}\d])/gu, "$1 ")`, applied to the full head's second line only. The separator and a number each stay with the word after them: each fact ("· 1 fül") wraps whole and is led by its dot, like the "· v1" beside it. To a reader the line says what it said; accessible names, rows and every other surface keep plain spaces.
- Result at 1440 with the panel docked (screenshot 09), Hungarian: `Dokumentum` / `· 1 fül` / `· v1  ✓ Átnézve`. Before: `Dokumentum · 1` / `fül` / `· v1`.
- Red first (`artifact-chat-card.spec.ts`, describe "the in-chat artifact card's meta line"), panel opened by a real click on the card, Hungarian, measuring where the browser broke the line (a `Range` over "· 1 fül" must sit on one line, and the line must not run under the open label's words): the 1440 case failed on the unfixed tree (2 lines); the 1280 case is a guard (it passed before, by luck of where the words fell) that fails a `nowrap`-style fix. Unit: `ArtifactCard.test.ts` "keeps each fact of the second line whole" (HU/EN/Canvas/plain).

## Decisions to look at

1. **M-7 deviates from "CSS only".** The pair "1 fül" is not an element, it sits inside one text node ("Dokumentum · 1 fül"), so CSS can only hold the whole line. I measured what that does: with the panel docked the card's text column (`.artifact-card-headtext`) is **114 px at 1440, 63 px at 1280, 31 px at 1180, 5 px at 1100**, and the whole line is 115 px wide. `white-space: nowrap` on the line (the review's suggestion) would keep the pair at 1440 (a 115 px line in a 114 px column) but a nowrap line cannot shrink below 115 px, so at 1280 it would run ~50 px under the "Megnyitva a panelen" label (63 px column). I did not ship it to watch it; the widths above are measured. A no-break space keeps the pair together and still lets the line wrap between facts at any width. If you would rather have no markup-level change, the alternative is `text-wrap: balance` (no guarantee).
2. **`SHIPPED_ARTIFACT_KINDS` excludes File** (reason above), and the tours' list is *checked against* it, not derived (derivation would make "ships without a tour" inexpressible, which is the review's own worry).
3. **No Regenerate on a Sources row.** The card above it has it, and the row follows the same state, so it flips back by itself. Adding it would put a second Regenerate (and its busy/unavailable states) in the chat route.
4. **Touched `MessageBubble.svelte` instead of the chat page** for the prop threading: the page already provides `deletedArtifacts` all the way to the bubble; the bubble is where `MessageEvidenceDetails` is rendered.
5. **`i18n/artifacts.ts` untouched**: the deleted sentence is `artifacts.deleted.<kind>` and the fork heading is `artifacts.madeInOriginalChat`, both already EN+HU.

## Gates (final tree `80dd07c5`; src unchanged since `d044426e`)

| Gate | Result |
| --- | --- |
| `npm run check` | 8,392 files, **0 errors, 17 warnings** (ToolActivityRow 10, ThinkingBlock 6, RouteItinerary 1) |
| `npx biome check src scripts tests` | clean (2,502 files) |
| `npm test` | 1,027 files passed (+1 skipped); **16,845 tests passed**, 2 skipped (15 new: `kinds.test` 5, finalize-steps 1, MessageEvidenceDetails 8, ArtifactCard 1) |
| `npm run build` | exit 0; 32 `Unused CSS selector` + 2 `must have an ARIA role` (baseline) |
| `npm run check:artifact-chunks` (own line) | **exit 1, only the chat-route clause** (see below). Editor first paint identical on base and head: 207.2 kB raw / 61.8 kB gzip target, 226.7 kB raw / **69.9 kB gzip** exclusive closure (ceiling 71,680); Chart.js, MapLibre, Mermaid out of it. `--chat-baseline` not moved. |
| Fallow | **124 issues, 4 circular**, summary identical to FX-A's run (13 unused files, 87 unused exports, 9 unused types); none of the new names is flagged |
| `npm run check:migrations` | passes unchanged |
| Playwright, port 5420: every `artifact*.spec.ts`, `knowledge`, `chat`, `conversation`, `conversation-forks`, `live-evidence-metadata` | 542 tests: **518 passed, 23 skipped, 1 failed** in 41.6 min. The failure was my own new library-delete test: the shared e2e DB lists eight Documents titled "Weekend plan", so the row was not unique (passed alone). Fixed with a stamped title (`80dd07c5`); `artifact-delete` + `artifact-chat-card` rerun: **18/18 passed** |

### Chat-route size (not moved by me; the orchestrator records it)

- **Base** `d89ab5a4`, built in this worktree before any change: **542,904 B gzip** (+1,990 over the 540,914 baseline; 58 B of headroom).
- **Head** `80dd07c5`: **543,141 B gzip** (+2,227 over the baseline; 2,048 allowed, so the clause fails by 179 B).
- **My growth: +237 B gzip.** It is the guard, the made-row state and branches and the two CSS rules in `MessageEvidenceDetails`, the two props in `MessageBubble`, and `keepFactsWhole` (I did not split the number further). No string was added.

## Screenshots (looked at each; Hungarian)

`/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/shots/fx-c/`
- `01-sources-deleted-desktop-light-hu.png`, `02-sources-deleted-desktop-dark-hu.png` (1440×900): a made group with a live row ("Hétvégi terv · Dokumentum ↗") and a deleted one ("Csomagolási lista", muted, "Ez a dokumentum törölve lett", no arrow); the card above says the same words.
- `03-sources-deleted-phone-light-hu.png` (390×844): the same on one line each.
- `05-fork-sources-desktop-light-hu.png`: a normal fork's copied Sources, heading "AZ EREDETI BESZÉLGETÉSBEN KÉSZÜLT", rows still open.
- `06-fork-incognito-sources-phone-light-hu.png`: an incognito fork: same heading, rows plain (no arrow), cards say "Az eredeti beszélgetésben készült".
- `07-sources-deleted-long-title-320-hu.png` (320×640): a long title wraps in three lines and the sentence wraps in its own column inside the row (before `d044426e` it ran off the right edge).
- `09-card-meta-desktop-docked-light-hu.png` (1440×900, panel docked, a real click): the meta line reads `Dokumentum` / `· 1 fül` / `· v1 ✓ Átnézve`.
- `08-concern-docked-card-1100-light-hu.png` (1100×800): the pre-existing squeeze (see Concerns).

## Concerns

1. **Chat route: +237 B, the clause fails (543,141 vs 542,962 allowed).** Needs the recorded baseline move (and the base was already at +1,990, so M-4's split is still the real fix).
2. **A pre-existing layout defect, outside M-7's wording:** with the panel docked, the in-chat card is crushed below ~1280 px. The text column is 63 px at 1280, 31 px at 1180, **5 px at 1100** (screenshot 08: the title column is gone and the "Megnyitva a panelen" label is drawn over the meta lines "· 1 fül" and "·"). The base was identical (measured before my change). `ArtifactCard`'s head is `grid 36px minmax(0,1fr) auto` and its open label is ~145 px in a 257 px card. A fix is a design call (drop the label to its chevron, or stack it under the text, below a container width), so I left it; M-7's no-break spaces keep the facts whole at those widths.
3. **Not re-verified live:** a real model turn that makes an item, then a fork of it (the fork path is covered with seeded messages carrying the exact shapes the evidence step writes, as W4-E's own delete spec does; the real-turn row is W4-E's `artifact-chat-card` test, which passed in the full run).

## Hand-off

- New exports: `SHIPPED_ARTIFACT_KINDS`, `ShippedArtifactKind`, `isShippedArtifactKind` (`shared/artifacts/kinds.ts`). `MessageEvidenceDetails` props: `deletedArtifacts?: DeletedArtifacts`, `madeInOriginalChat?: boolean`. Private: `madeStateOf`, `keepFactsWhole`.
- Suggested AGENTS.md lines (the file is the orchestrator's; I did not touch it), under Artifacts next to W4-E's evidence line:
  - "**Which kinds ship is `SHIPPED_ARTIFACT_KINDS` (`shared/artifacts/kinds.ts`)**, never a list that happens to match (RV-F M-3). The evidence group's writer (`finalize-steps.ts`) and its row (`MessageEvidenceDetails.svelte`) read `isShippedArtifactKind`. The tours' list (`SHIPPED_ARTIFACT_TOUR_TYPES`) is its own and is checked against it at compile time: a kind may ship without a tour, and a tour cannot exist for a kind that does not ship. File is not on the kinds' list (the produced-file kind, ruling 18). Bringing Slides back is one entry in each list."
  - "**A made row says what its card says** (RV-F M-1, M-2): `MessageBubble` hands the Sources panel the page's `DeletedArtifacts` and, for a message that carries a fork snapshot, `madeInOriginalChat`. A made row of a deleted item is plain text with the card's sentence (`artifacts.deleted.<kind>`), one out of the chat's reach is plain with its kind word, and a fork's copied group is headed `artifacts.madeInOriginalChat`. Rows follow the page's state, so Regenerate on the card makes them links again."
  - "**The card's second line keeps facts whole** (RV-F M-7): `keepFactsWhole` in `ArtifactCard.svelte` puts no-break spaces after the separator and between a number and its unit; CSS cannot, since the pair is one text node, and `nowrap` on the line spills into the open label in the docked panel's narrow column."
