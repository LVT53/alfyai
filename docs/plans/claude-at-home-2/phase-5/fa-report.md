# FA — friction audit of Feature 2 (report only, nothing fixed)

Model: Claude Sonnet 5.5 (`claude-sonnet-5-5`). Tree: worktree `art-fa`, detached at `e952a38b` (= `feat/artifacts` head). Versioning/History skipped as instructed.

**How it was walked.** Production build (`npm run build`, 32 `Unused CSS selector` as baseline) served with `node build` on port 5480 against a scratch DB, no `PLAYWRIGHT_TEST`, the control/title/chips models and the chat model all through the tunnel on 30407 (`qwen3-6-27b`). A fresh Hungarian user who had seen no tour (so the first open of each kind showed its tour), later finished. English only as a cross-check (one fresh EN user, the three kinds and their tours: no "Artifact" leak, same behaviour). Widths 1440, 1280 (numbers only), 1100 docked, 390 phone emulation with touch (CDP touch for drags); light and one dark pass. Real input only (`page.mouse`, `keyboard`, `locator.click/tap`, wheel and Ctrl+wheel); the only non-input code was observation: a `PerformanceObserver` for layout shifts, CDP screencast frames with wall-clock times (first frame after an input = first visible feedback), and DB reads to explain what I saw.
**Real model use:** 16 chat turns + 4 panel-driven model calls (`@Alfy` ×2, App "Módosítás…", Regenerate) = 20, under the ~25 cap. Other items (a plain board, empty items, a project) were seeded straight into the scratch DB as setup.
**Load.** `uptime` 1-minute load is printed next to every measurement in the kit logs: 2.5–10 for nearly all of them (two early runs at 15–18). Every UI wait below is ≤ 250 ms, so load does not change a conclusion; the 11–31 s waits are the remote model.
Kit and logs: `p5/fa-kit/` (copy of the RC-F kit + `walk/fa.ts`, `w1…w28.walk.ts`, logs `w*-log.txt`); screenshots and frame sheets in `p5/fa-shots/` (37, each looked at; a "sheet" is a contact sheet of CDP frames with the time after the input in ms under each frame).

---

## 1. Ranked table (score = how often × how bad; ★ = top 15)

Frequency: every time / often / sometimes / rarely. Bad: 1 = noticed, 2 = annoying, 3 = blocks or misleads. Flow numbers are the brief's.

| ID | Finding | Flow | Width / theme / input | Kind | Often | Bad | Screenshot |
|---|---|---|---|---|---|---|---|
| ★**F1** | Document ▸ Letöltés ▸ PDF/Word/Markdown: the popover closes and nothing else happens (no file, no card, no list row); the files exist but are unreachable until a later reply shows them as ghost cards. The App's Letöltés is the same pattern (a job that failed silently here) | 2 | 1440 light mouse | dead end (bug) | every time | 3 | F01, F01b |
| ★**F2** | Asking in the chat to change an App makes a second App with the same name; the open panel keeps showing the old one; the composer promised "Kérd meg Alfyt, hogy módosítsa ezt" | 3 | 1440 light mouse | surprise | every time | 3 | F02, F02b |
| ★**F3** | Sidebar open + panel docked squeezes the chat: composer 319 / 268 / 134 px at 1440 / 1280 / 1100; at 1100 the header breadcrumb runs into the count chip | 6 | 1440, 1280, 1100 light mouse | overlap | often (sidebar open) | 3 | F03 |
| ★**F4** | Every panel state change re-flows the chat in one frame while the panel fades in 100–250 ms later: open (layout shift 0.26), reload with panel open (0.18), expand (1.0), delete (2.35) | 6 | 1440 light mouse | jump | every time | 2 | F04, F04b, F19, F26 |
| ★**F5** | First message: a blank English interstitial ("Starting conversation…", "Type a message…") for ~50–100 ms, then "New Conversation" in the header until the generated title arrives (still there at 2.3 s; set by 3.5 s on a one-line question) | 1 | 1440 and 390 light | surprise / jump | every time | 2 | F05, F05b |
| ★**F6** | Alfy editing the open Document: the panel shows nothing for 11–15 s; the pill and bar land 3–10 s before the chat turn ends | 2 | 1440 light | wait | every time | 2 | F06 |
| ★**F7** | Phone: Back (gesture) with the panel list or an item open leaves the chat for the landing; the panel adds no history entry | 11 | 390 touch | surprise | often | 2 | — |
| ★**F8** | Insert drops Frame, Chart and Note at one spot, stacked, partly under the bottom toolbar or above the pane; Chart/Checklist take no focus while Note/Text/Frame do | 4 | 1440 light mouse | overlap / inconsistency | often | 2 | F08 |
| ★**F9** | Same name, several kinds: 2× "Borravaló-kalkulátor", 2 identical DOCX + the Document, a board and its PNG; rows (and the Insert menu, truncated) show title and kind only | 6, 10 | 1440 and 390 | dead end / inconsistency | often | 2 | F09, F09b |
| ★**F10** | "Írj nekem egy dokumentumot…" gives a DOCX file card, twice (two jobs 11 s apart), not the in-app Document | 2 | 1440 real model | surprise | often | 2 | F10 |
| ★**F11** | A horizontal flowchart block draws text at ~5 px (480×83 block); on open its raw Mermaid source shows for ~100 ms first | 4 | 1440 light | surprise / jump | often | 2 | F11, F15b |
| ★**F12** | Alfy's board change reads bigger than asked: one new note = "4 módosítás vár rád"; a rewrite arrives as "removed 1 + modified 1"; the camera zooms to the change and glides back | 4 | 1440 light | surprise | often | 2 | F12, F24 |
| ★**F13** | Phone: a pending Alfy change keeps a two-row review bar (~150 px) plus header and toolbar: about 45% of the screen is chrome | 11 | 390 touch | extra step / overlap | often | 2 | F13 |
| ★**F14** | `@Alfy` in a Document comment: the composer stays open over the text ≥1.3 s after "Alfy megkérdezése"; no "answering" state in the thread; reply at ~2.5 s | 2 | 1440 light | wait / surprise | often | 2 | F14 |
| ★**F15** | First open of each kind: the tour card is inserted above the content ~230 ms after it painted (Document moves 120–190 px; the Canvas re-fits 100% → 87% and back when the card leaves) | 7 | 1440 light | jump | sometimes (once per kind) | 2 | F15, F15b, F15c |
| **F16** | The artifact card arrives 3–5 s before the end of the turn and pushes the streamed text / the A mark down by its height (115–215 px) | 2–5 | 1440 light | jump | every time | 1 | F16 |
| **F17** | Follow-up chips are invisible at rest on desktop (inside the hover-only action row); visible on the phone | 1 | 1440 mouse | surprise | every time | 1 | F17 |
| **F18** | Keep/Undo moves things: on a board the toolbar, minimap and zoom slide 48 px down; in a Document the text jumps 28 px | 2, 4 | 1440 light | jump | every time | 1 | — |
| **F19** | Deleting the open item: the panel closes for a frame (chat to full width) and reopens on the list (layout shift 2.35 in 150 ms) | 10 | 1440 light | jump | sometimes | 2 | F19 |
| **F20** | "Megnyitás dokumentumként" titles the Document with the first 120 characters cut mid-word ("…kiváló k") and repeats it in the composer placeholder | 2 | 1440 light | surprise | sometimes | 2 | F20 |
| **F21** | A File opens with two different panel headers: from the chat card "AKTÍV DOKUMENTUM" + AI chip, from the list the standard breadcrumb header | 5, 6 | 1440 light | inconsistency | sometimes | 2 | F21 |
| **F22** | Alfy-edit turns show raw ids: the read row is "Eszköz e4d471c7-b5de-…", a status line says "frame-sat", others carry English ("(downloadable file)") | 2–4 | 1440 light | surprise | often | 1 | F22, F22b |
| **F23** | Knowledge ▸ Dokumentumok: opens on Memóriaprofil; every size reads "0 B" (the PDF is 364 KB); Document/Canvas/App rows have no download | 8 | 1440 light | inconsistency / bug | often | 1 | F23 |
| **F24** | The open comments rail (300 px) crops the Canvas with no re-fit; the Document's rail is always there and narrows the text (440 px at 1440 with the sidebar open) | 2, 4 | 1440 light | overlap | often | 1 | F24 |
| **F25** | PDF preview paints a 316×166 box then jumps to 888×719 (shift 0.38 on top of the dock's 0.26) | 5 | 1440 light | jump | often | 1 | F25 |
| **F26** | Expand cuts to full screen in one frame (shift 1.0); X in the expanded view docks the panel instead of closing it | 6 | 1440 light | surprise | sometimes | 1 | F26, F26b |
| **F27** | Project Files dialog: the row name looks like a link and does nothing; only a small icon at the right opens the item | 9 | 1440 light | extra step | sometimes | 1 | F27 |
| **F28** | Small things: 8×8 px resize handles; "Svelte Flow" text on every board; an unlabeled "+" (add tab) floating in the Document header; phone breadcrumb wraps "EZ A / BESZÉLGETÉS"; project card meta "aktív: …" truncated | 4, 11 | various | polish | sometimes | 1 | F28 |
| **F29** | Regenerate (deleted App) takes 15.7 s; only the card button says "Újragenerálás…" (nothing in the list) | 10 | 1440 real model | wait | rarely | 1 | — |
| **F30** | Every download starts with a bare `/api/chat/stream/status` that answers 400 on purpose; DevTools shows a red error each time | all | any | bug (noise, invisible) | every download | 0 | — |

---

## 2. Findings

Fixes are one-liners only. File:line are from this tree.

**F1 — Downloads go nowhere.** Steps: open the Document in the panel ▸ header "Letöltés" ▸ "PDF" (or Word, Markdown). The popover closes about 150 ms later; for the next 15 s nothing changes on screen (frames: F01); `POST /api/artifacts/:id/export` answers 202, the job succeeds in under a second (files of 3.7, 10.7 and 374 KB are in `chat_generated_files`), but there is no `download` event, no new card in the chat, no new "Fájl" row in "Ez a beszélgetés", and the count button stays at 6 after a reload. The result surfaces only (a) in Knowledge ▸ Dokumentumok as "GENERÁLT … 0 B" rows, (b) in global search under "Jelentések", and (c) as four ghost cards (one per earlier export) inside the next assistant reply (F01b: my PDF request answered with `.md` cards from earlier exports above its own), gone after a reload. The App's Letöltés is the same pattern: `POST …/app/download` creates a `program` job; here it failed (no Docker on this Mac) and the user saw nothing. Where: `src/lib/components/artifacts/document/DownloadSheet.svelte:53-70` (closes on `ok`, "the File card is what the user watches next"), `src/lib/components/chat/MessageArea.svelte:726-743` (a job with no `assistantMessageId` shows only on the message currently streaming), `src/routes/api/artifacts/[id]/export/+server.ts:109-114`, `src/lib/client/api/artifacts.ts:134` (`announceChatFilesChanged`, only the PNG export calls it: `canvas/_lib/export-png.ts:228`), `AppBody.svelte:231-243`. Fix: attach the export job to a visible card (or start the download when the job succeeds).

**F2 — "Change it" copies an App.** Steps: ask for an App, open it, type "Legyen sötét a háttere, és tegyél bele egy gombot…" in the chat (the composer says "Kérd meg Alfyt, hogy módosítsa ezt: Borravaló-kalkulátor"). The model's thinking quotes the tool rule ("Az Alkalmazásokat itt nem szerkesztjük — készíts helyette egy új Alkalmazást"), calls `create_artifact`, and answers "Frissült a Borravaló-kalkulátor — nyisd meg újra a panelen". Result: a second App of the same name (the list, the Insert menu and the project Files dialog all show two); the open panel still shows the old one (F02: identical before/after, header still "Alfy készítette · 1 perce"). The panel's own "Módosítás…" does the right thing (in place, "Mostantól a v2 látszik · Visszavonás", 11.1 s with a veil and "Alfy ellenőrzi az alkalmazás adatait…"), but it is a different path from the chat, and in my run the model rebuilt it into an unrelated "Értesítés" list app (F02b, model quality). Where: `src/lib/server/services/normal-chat-tools/artifact-tools/kind-prose.ts:164-167`, placeholder `src/lib/i18n/artifacts.ts:37, 1070`. Fix: route a chat change request on an open App through the same in-place regenerate (or stop promising it in the placeholder).

**F3 — Sidebar open squeezes the chat.** Steps: expand the sidebar (300 px), open any item. At 1440 the chat column is 319 px and the Document's text column 440 px (the comments rail takes 292); at 1280 the composer is 268 px; at 1100 the composer is 134 px in a ~180 px column, the placeholder wraps to six lines, the header's project crumb overlaps the count chip (F03). With the sidebar collapsed (the default I got) 1440 gives 413 px and 1100 gives ~340 px: fine. Nothing collapses the sidebar or sets a minimum for the chat when the panel docks. Where: sidebar default width `src/lib/stores/ui.ts:199-218`, dock `src/routes/(app)/chat/[conversationId]/+page.svelte:3870` + `DocumentWorkspace.svelte:2904`. Fix: auto-collapse the sidebar (or give the chat a floor) while the panel is docked below ~1300 px.

**F4 — The dock is a cut, the panel a fade.** Steps: click any card's head. First frame after the press 10 ms; by the next frame (~35–60 ms) the chat column has gone from 746 to 413 px, the messages re-wrapped, the card grew from 221 to 393 px, and the right two-thirds are blank or a ghost; the panel is fully drawn at 160–250 ms (panel visible 150–187 ms, editor text 41–91 ms). Layout shift 0.2542 (Document), 0.2575 (App, Canvas), 0.2611 (PDF). Reload with the panel open: shift 0.18, the chat first paints as a 130 px column then docks (F04b). Expand: shift 1.0 in one frame; delete: 2.35 (F19); the same cut closes the panel. The motion is two languages at once (instant reflow vs a 32 px fade-slide). Where: `DocumentWorkspace.svelte:2904-2912`, `+page.svelte:3870`. Fix: animate the chat column's width with the same curve as the panel (or mask the reflow with the fade).

**F5 — First message flashes English.** Steps: landing ▸ type ▸ Send. Frames (desktop F05, phone F05b): landing at t ≤ 20 ms; at ~60 ms a blank page with a centred spinner, "Starting conversation…" and an empty composer reading "Type a message…" (English, in a Hungarian UI); at ~100 ms the chat with the header "New Conversation" (English), still there at 2.3 s; the generated title was in place by 3.5 s for a one-line question (for a long answer I only know it is set when the turn ends). The Hungarian strings exist (`chat.startingConversation` "Beszélgetés indítása..."), so the bootstrap page is rendered before the locale is applied. Where: `+page.svelte:3766`, `src/lib/i18n/chat.ts:172, 267`, default title `src/lib/server/services/conversations.ts:80`, `ConversationTitleText.svelte:6`. Fix: localize the bootstrap view and the untitled placeholder ("Új beszélgetés").

**F6 — The Document is silent while Alfy works.** Steps: Document open ▸ type "Rövidítsd le a szombat reggeli szakaszt…" in the chat. Frames at 0.5–12 s (F06): the panel is unchanged; the change bar lands at 11.6 s (turn 15.1 s) and 15.0 s (turn 25.3 s). The chat column shows the thought lines, the panel shows nothing; the Canvas shows an "Alfy dolgozik a táblán: …" strip only around the landing (seen in the last 0.3 s before it, earlier not captured). Where: `DocumentBody.svelte` (the `alfy-writing` state is only used by comment replies), `i18n/artifacts.ts:1587` for the Canvas wording. Fix: show a quiet "Alfy dolgozik a dokumentumon…" state in the panel from the first edit tool call.

**F7 — Back leaves the chat.** Steps (390, touch): landing ▸ open a chat ▸ count button (list sheet) or an item ▸ browser Back. `history.length` is 4 before and after opening the panel and an item; Back goes to `/`. Same on desktop. Where: no `pushState` or `popstate` in `DocumentWorkspace.svelte`. Fix: push a history entry when the panel opens and close it on Back.

**F8 — Insert piles blocks up.** Steps: on a populated board press "Beszúrás" ▸ Jegyzet, Szöveg, Keret, Diagram, Ellenőrzőlista one after another. Placed at (916,620), (776,444), (932,718) 360×260, (932,723) 360×228, (798,106) 340×98 in a pane that spans y 123–901: the Frame and the Chart sit on the same coordinates (the chart lands inside the frame) and run 77 and 50 px past the pane bottom (under the toolbar), the Checklist starts 17 px above the pane top (F08, with its toolbar and the "Alfy megkérdezése | Megjegyzés" pill drawn over the neighbouring notes). Focus after Insert: Note, Text, Frame go straight into typing, Chart and Checklist leave it on "Beszúrás". Where: `canvas/CanvasBoard.svelte:659` (`insertBlock`). Fix: place new blocks in free ground inside the visible pane, then reveal them.

**F9 — Three things with one name.** Steps: ask for an App, "change" it (F2), ask for a "dokumentum" (F10), export a board picture. The list ("Ez a beszélgetés", F09 on the phone) shows "Borravaló-kalkulátor" ×2, "Bécsi hétvégi útiterv – szombat és vasárnap" as Dokumentum + Fájl ×2, "Bevásárlás és teendők" Tábla next to its PNG; rows carry title, kind and age but no extension or size; the Insert menu truncates the two DOCX to "becsi-hetvegi-utiterv-s…" with the same size (F09b); Knowledge and search repeat it. Where: row markup `DocumentWorkspace.svelte:~1858`, `services/artifacts/chat-blocks.ts`. Fix: show the extension/size on file rows and "v2" or time on same-name items.

**F10 — "Dokumentum" means a file.** Steps: new reply to "Írj nekem egy dokumentumot a bécsi hétvégi útitervünkről…". The model calls `produce_file` twice (jobs 11 s apart, files of 10,637 and 10,626 bytes): two DOCX cards, thought row "Eszköz ×2" (F10). The in-app Document came only from "Csináld meg ugyanezt szerkeszthető Dokumentumként is itt az appban". The card then reads "Dokumentum · 1 fül · szerkesztve épp most" with the whole packing checklist as a 219–393 px preview. Where: tool wording `kind-prose.ts:136-143` vs `produce_file`. Fix: bias "dokumentum" to the in-app Document when no file format is named; dedupe repeated `produce_file` in one turn.

**F11 — The flowchart is unreadable.** Steps: ask for a board "…és egy folyamatábra a reptérről a szállodába", open it. The `LR` chart is squeezed to the block width: text ~5 px at 100% zoom in a 480×83 block (F11). On open the block first shows its raw source ("flowchart LR A[Bécs-Schwechat reptér] --> …") at t = 100 ms, the drawn chart at 200 ms (F15b, frame 100 ms). Where: `canvas/nodes/MermaidNode.svelte`, `shared/artifacts/mermaid-size.ts`. Fix: size a wide chart by its width (or top-down) and hide the source until drawn.

**F12 — Board changes read bigger than asked.** (a) "Adj hozzá egy új jegyzetet … mellé": the card and list say "4 módosítás vár rád", the bar "Alfy 4 blokkot módosított" (the Saturday frame grew to 460, the Sunday frame moved, the note and a connecting arrow were added); the chat reply explains it, the card does not (F12). (b) `@Alfy` "írd át úgy, hogy legyen benne a tej mennyisége is" on a note: the stored diff removes `note-1` and adds `note-1-new`; the bar says "1 blokkot módosított és 1 blokkot eltávolított" (F24). (c) On landing the camera zooms in on the change (frames 14.6–15.3 s, F12) and glides back over ~1.5 s while the pill, ring and bar arrive. Where: `services/artifacts/review.ts`, `shared/artifacts/board-ops.ts`, `canvas/CanvasReviewBar.svelte`. Fix: count and word the change as the reader sees it (one note changed) and keep the camera still unless the change is off-screen.

**F13 — Phone: the review bar eats the screen.** Steps (390): open the Document with an Alfy change pending (F13, right). Header (breadcrumb + 4 icons), title (two lines), kind/pill row, toolbar, then the text; at the bottom the bar has two rows ("Alfy 1 részt módosított. ⌃ 1/1 ⌄" and the two buttons), ~150 px, so ~45% of the 844 px is chrome. Where: `components/artifacts/ReviewBar.svelte`. Fix: one-row bar on phones.

**F14 — `@Alfy` in a comment feels stuck.** Steps: select text ▸ "Megjegyzés" ▸ type "… @Alfy bővítsd ki …" ▸ "Alfy megkérdezése". Frames (F14): the margin shows your comment at ~0.5 s, but the composer card is still drawn over the text at 0.7 s and 1.3 s (with your text in it), the thread has no "Alfy válaszol…" state, and the reply plus the tracked change arrive at ~2.0–3.1 s. A second press would double-send. Where: `components/artifacts/CommentComposer.svelte` + the document comment surface. Fix: close the composer on send and show a pending reply row.

**F15 — The tour moves what you just saw.** Steps: fresh user ▸ open a Document, App or Canvas. Panel at 150–187 ms, tour card at 225–234 ms, pushing the editor/preview down ~120 px (Document `document-body` y 133 → 250 over ~150 ms, v ≈ 0.08 on top of the dock's 0.25); on a Canvas the board is fitted at 100%, re-fitted to 87% when the card arrives and is back at 100% after "Értem" (F15b); in a Document, "Értem" slides the text back up 190 px (shift 0.062 over 250 ms, 18 entries). On the phone the card is 214 px tall and slides in at ~200 ms, so the text starts at y 453 of 844 until the tour is done (shift 0.23 in total, F15c). Replay from the row menu ("Így működik ez a típus") and the empty state's "Újra megnézem" work, but the empty state still shows its link while the replay card is up. Where: `components/artifacts/tour/ArtifactTour.svelte`, `DocumentWorkspace.svelte` (`presentTour`). Fix: reserve the card's height before the body paints (or overlay it).

**F16 — The card drops in late.** Steps: any artifact request. Tool row at 3 ms, card at 8.2 s of an 11.6 s turn (Document, F16); the card is inserted above the streamed text, which moves down by its height (Canvas turn: text 266 → 381 px, the A mark 618 → 732; Document turn: the A mark 618 → 737). Where: `ArtifactCard.svelte` placement in the message. Fix: reserve a placeholder row when the tool call starts.

**F17 — Chips hide.** After every desktop reply the two follow-up chips have opacity 0 (y inside the viewport) until the pointer is over the message; on touch they are at opacity 1 (F17: no chip visible after the reply). Documented as intended ("visibility follows the row's own opacity rule"). Where: `MessageBubble.svelte:2068-2094`. Fix: none needed if intended; flagged because the owner may not know they exist.

**F18 — Keep moves the chrome.** Board: "Mindet megtartom" removes the bar and the toolbar (769 → 817), minimap (708 → 756) and zoom (806 → 854) slide 48 px down; Document: the text moves up 28 px when the struck-through text goes. Where: `canvas/CanvasBoard.svelte` bottom layers, `ReviewBar.svelte`.

**F19 — Delete flickers the panel.** Steps: open an App ▸ trash ▸ confirm. Frame 60 ms: the chat is full width with no panel and a toast "Alkalmazás törölve"; frame 150 ms: the panel is back on the list, the chat narrow again; shifts 0.72 + 0.11 + 0.04 + 0.06 (F19). Where: the delete handler in `DocumentWorkspace.svelte`. Fix: switch to the list without closing the panel.

**F20 — "Open as document" title.** Steps: hover a plain reply ▸ "Megnyitás dokumentumként". Panel at 142 ms; the title is the first 120 characters of the reply, ending "…neogótikus terem, kiváló k", in a two-line header, and the composer placeholder repeats it in three lines (F20). Where: `src/lib/server/services/artifacts/keep-message.ts:27-33`. Fix: cut at a word/sentence and cap near 60.

**F21 — Two headers for one File.** Steps: chat card ▸ "előnézete" opens the PDF with "AKTÍV DOKUMENTUM", the title with ↗, an "AI" chip and an icon-only back (F21); the same file from the list shows "‹ EZ A BESZÉLGETÉS 11 / Bevásárlás és teendők.png / Fájl". Where: `i18n/chat.ts:1781` (the older header branch in `DocumentWorkspace.svelte`). Fix: one header for every item.

**F22 — Ids and English in Hungarian turns.** In every Alfy edit turn the read step reads "Eszköz e4d471c7-b5de-488d-b7fb-a4f… 2 ms" next to a good "Szerkesztve Bécsi hétvége – tábla" row; a model-written status line said "A frame-sat szélességének növelése szükséges…" (F22); others: "Kérés értelmezése… (downloadable file)" (F22b) and, in small print in the frames, "Az itinerary Document artifactnek…". Where: `components/chat/ToolActivityRow.svelte` (label for `read_artifact`), status-line prompt. Fix: label the read row with the item's title.

**F23 — Knowledge.** `/knowledge` opens on Memóriaprofil (one more click to Dokumentumok); every size reads "0 B" (F23) including the 364 KB PDF; Dokumentum/Tábla/Alkalmazás rows have only a trash can while generated files have eye, download, trash. Dates follow the browser locale (my headless browser was en-US, so not counted). Where: `routes/(app)/knowledge/_components/DocumentsList.svelte:1743, 1784`.

**F24 — Rails take space.** Canvas: opening comments (300 px) shrinks the pane and cuts the right column (F24, "Zöldségek a piacról" and "Hí…" cut); the camera is not re-fitted. Document: the "Megjegyzések" rail is on even when empty ("Még nincs megjegyzés…"). Where: `canvas/CanvasEditor.svelte`, `DocumentBody.svelte`.

**F25 — PDF page jump.** PDF from the chat card: panel 187 ms, canvas 129 ms; the page is first a 316×166 box at x 851, then 888×719 at x 552 (shift 0.3825), spinner between (F25). Where: `document-workspace/DocumentPreviewRenderer.svelte`.

**F26 — Expand and X.** Expand: one-frame cut (F26). Then X: the frames show the panel going to the docked layout, not closing; a second X closes (F26b). After a close, the header count button brings back the list, not the item you closed (one more click). Where: `DocumentWorkspace.svelte` (`workspace-shell-expanded`).

**F27 — Project Files dialog.** Table rows read like links; clicking the name does nothing (focus stays in the dialog); only the right-hand icon "… megnyitása" opens the panel, which hides the dialog and brings it back on Escape (F27). Where: `routes/(app)/projects/[projectId]/_components/ProjectFilesDialog.svelte`.

**F28 — Polish.** Resize handles are 8×8 px (F28); "Svelte Flow" text bottom-left of every board; a bare "+" (aria "Fül hozzáadása") floats top-right in every Document; the phone breadcrumb wraps "EZ A / BESZÉLGETÉS"; the project card on the landing truncates "1 csevegés · aktív: …".

**F29 — Regenerate.** Card button "Újragenerálás…" (disabled) for 15.7 s, then the card returns and the list rows shift (0.016); no row or progress in the list.

**F30 — Noise.** `client/downloads.ts:31-42` probes the session with a request that answers 400 on purpose; harmless, red in DevTools.

---

## 3. Patterns

1. **Two motion languages.** Layout changes are instant (dock, expand, delete, board bottom chrome, the first-message handoff) while the new content fades or slides in 100–250 ms later. F4, F18, F19, F26, F5. Everything that "feels clanky" on opening is this.
2. **Work with no home.** Results that finish in the background have no visible place: Document/App downloads (F1), Regenerate (F29), Alfy's edits in the panel (F6), a chat change to an App (F2). The question every time is "where did it go?".
3. **The same thing done in several places.** File headers (F21), Keep/Undo (pill, bar, card), download (a job for Documents/Apps, an instant PNG for boards, a link for files, an icon in Knowledge), close (X, expanded X, count toggle, Back), focus after Insert (F8). Items with one name in three kinds (F9).
4. **Language leaks at the seams.** SSR bootstrap and the untitled title (F5), model-written status lines and tool rows (F22).
5. **Floating layers use different rules at the edges.** The Insert menu, selection toolbar + pill, change pill, review bar, zoom and comment composer are each placed well in the middle and collide at the top and bottom of the pane or in a narrow column (F3, F8, F24, F13).
6. **The phone treats the panel as a screen but not as history** (F7), and its chrome stacks up (F13).

What held up: panel open ≤ 190 ms everywhere; Insert menu 13 ms; list sheet 9 ms; search 148 ms; Canvas PNG export 326 ms; typing latency ≤ 24 ms in the Document and ≤ 16 ms in the composer (Event Timing); the chat does not yank you back when you scroll up during streaming (a "jump to latest" button shows); Escape and outside presses close only the top layer (popovers, replay card); dark mode has no defect I could find (`dark-pass-…`); the English UI matches and never shows the word "Artifact".

## 4. Measured waits (load = 1-min `uptime`)

| Action | First visible feedback | Done | Load |
|---|---|---|---|
| Landing send ▸ chat | 4 ms (button), interstitial ~60 ms | chat 100–160 ms; user bubble and status line 118 ms | 2.5–3 |
| Card head ▸ panel | 10 ms | panel 150–187 ms, editor text 41–91 ms, tour 225–234 ms | 6–14 |
| Reload with panel open | chat shell 26 ms | editor 91 ms, panel 217, tour 286 | 6 |
| Header count ▸ list (desktop / phone) | — | 230 ms / 9 ms | 8.6 / 3.9 |
| Alfy edits Document | thought line at once | change at 11.6 s (turn 15.1 s) and 15.0 s (turn 25.3 s); panel silent | 6.5 / 3.6 |
| Alfy adds a board note | — | ring + bar 14.6–14.8 s (turn 23.3 s) | 8 |
| `@Alfy` comment (Document / board) | comment in thread 0.5 s / 0.42 s | reply 2–3 s / 2.8 s | 11 / 4 |
| App "Módosítás…" | veil + "Alfy ellenőrzi…" 7–32 ms | 11.1 s | 11.7 |
| Regenerate | "Újragenerálás…" 30 ms | 15.7 s | 10.7 |
| Canvas PNG export | veil 23 ms | 326 ms | 4.6 |
| Document PDF/Word/Markdown | popover closes ~150 ms | never visible (job done < 1 s) | 3.2 |
| Phone first message | 2 ms | chat 160 ms; chips with the end (11.6 s) | 2.4 |

## 5. Could not walk

- **Spreadsheet (XLSX) production and the App download**: the program sandbox needs Docker, absent on this Mac (the job failed silently, F1); PDF, DOCX and Markdown were walked.
- **Native text selection on a phone** (long-press handles, selection bubble by touch) and the **real on-screen keyboard** over a low note; Playwright cannot raise either. Safari and Firefox; a real touchpad's inertia; a screen reader and keyboard-only pass.
- **Big data**: my chat had ~25 messages and one 10-block board; a long chat or a 100-block board was not walked.
- **Slow or failing networks and server errors** (offline strip, refusals other than the stale-block one, quota).
- **Slides** (shelved) and **versioning/History** (skipped as instructed); frame drag-in with touch and multi-select by long press on a phone.
- **Hungarian dates**: my browser locale was en-US, so Knowledge's date format was not judged.
- 1280 was measured (widths, no screenshots), not looked at.
