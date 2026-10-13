# AlfyAI 2.2: the inventory of what changed since production

**Status: evidence for the 2.2 release campaign (CP-2). Nothing is published, nothing was run against any server.**

This is every user-facing change between production `origin/main` (`98a34dfd1`, 2026-09-24, the 2.0 line) and
`origin/dev` (`9e64744ba`, 2026-10-13). `main` is an ancestor of `dev` (no commit exists only on `main`), so the diff is
exactly what `dev` adds: 1,726 commits (1,541 without merges), 53 first-parent merges plus 19 direct commits, 1,736
files, 8 migrations (`1777140000106` to `1777140000113`), 5 new ADRs (0064 to 0068).

The first draft (`campaign-2.2-copy.md`, five slides) was written from a five-theme summary and said so. This file is
built from evidence instead, and the sources are cross-checked in the section "How it was built" at the end.

## How to read it

Every row says what a person can now do, where they find it, the Hungarian UI name exactly as the app draws it (the
English name where it differs in sense is in the "Where" column), and a status.

- **NEW**: did not exist on production. **IMPROVED**: existed, now works better. **CHANGED**: works differently.
  **REMOVED**: gone, a returning user will notice.
- **admin** marks something only an administrator can see or change.
- The "Where" paths use the Hungarian labels the app shows (checked in a production build of `dev` with a Hungarian
  sample account), then the English label in brackets where the two differ in more than the language.
- Slides (Diasor) is shelved (ruling 69): its strings exist in the dictionaries and the code, but no screen reaches it. It
  is not in this inventory as a feature and the campaign never mentions it.

Counts: **A 14, B 12, C 8, D 12, E 4, F 8, G 8, H 6, I 8, J 10, K 10, L 6, M 7, N 7**: **120 rows** in 14 groups, plus
section O (what is deliberately not in 2.2) and appendix P (shipped in production before 2.2, never announced).

---

## A. Projects and instructions (Workspaces, Feature 1, ADR-0064)

| # | What a person can now do | Where to find it | Hungarian UI name(s) | Status |
|---|---|---|---|---|
| A1 | Open a project's own page: its chats, instructions and files in one place, with a composer that already belongs to the project. | Sidebar ▸ Projektek ▸ the button beside a project's name (hover; it opens the page, the name itself still folds the row). The row's ⋮ menu has "Új beszélgetés" too. Home ▸ a project card. | Page head: the project's name; "4 csevegés · aktív: 19 órával ezelőtt"; placeholder "Kezdj csevegést itt: {name}…"; "4 csevegés ebben a projektben"; empty: "Még nincs csevegés. Az első üzenet itt indít egyet." | NEW |
| A2 | Start a chat in a project and know it is filed there from its first message. The row's new-chat button used to create an empty chat in the background first. | Same as A1: type in the project page's composer. | "Kezdj csevegést itt: {name}…" | CHANGED |
| A3 | See the most recently active projects as cards on the home page: name, chat count, time of the last activity, and quiet chips for the instructions and the files. | Home ▸ below the composer ▸ Projektek. A project with no chats has no card. | "Projektek"; "4 csevegés · aktív: 19 órával ezelőtt"; "Utasítások"; "7 elem" | NEW |
| A4 | Give a project standing instructions that every chat in it follows (up to 2,000 characters). They rank above personal instructions, memory and the chosen style, and they work in incognito chats too. | Project page ▸ the quiet line under the composer ▸ "Utasítások" ("Utasítások hozzáadása" while empty) ▸ a dialog with a character counter, Mentés, Mégsem. | "Utasítások"; "Az AlfyAI minden csevegésben követi ezeket a projektben. Elsőbbséget élveznek a memóriáddal és a stílussal szemben."; "{count} / {max}" | NEW |
| A5 | Write personal instructions once; they apply in every chat, and a project's instructions win inside a project. | Profil és beállítások ▸ Profil ▸ "Az asszisztens viselkedése" ▸ "Személyes utasítások" ▸ "Utasítások hozzáadása" / "Szerkesztés". | "Személyes utasítások"; "Minden csevegésben érvényes. Egy projekten belül a projekt utasításai élveznek elsőbbséget."; "Nincs beállítva" | NEW |
| A6 | Add an instruction from the composer with a command: type `/instruction` and the text. The same dialog opens with the line added to the end, and nothing is saved until Mentés. Works in incognito. | Composer ▸ type "/" ▸ "Utasítás". | "Utasítás": "Állandó utasítás írása"; placeholder "Mi érvényes mindig?"; "A végéhez fűztük. Ha valami már nem illik, nyugodtan írd át az egészet." | NEW |
| A7 | Let Alfy offer to remember a standing preference: when you say "from now on…", a row under the reply offers to add it to the right instructions; Áttekintés opens the dialog, Elvetés dismisses it for good. Never offered in an incognito chat. | Under an Alfy reply ▸ "Hozzáadás az utasításokhoz: …". | "Hozzáadás az utasításokhoz"; "Áttekintés"; "Elvetés" | NEW |
| A8 | See which instructions shaped a reply without exposing the text: the reply's info popover lists the scopes as tokens. | Under a reply ▸ "Infó" ▸ "Utasítások" ▸ the tokens "Te" and the project's name. | "Infó"; "Utasítások"; "Te"; "Személyes" | NEW |
| A9 | Keep files in a project: every chat in it knows they exist and reads them when a turn needs them. Add from the library, upload straight into the project, search, open or preview a file by its name, remove (removing never deletes the library file). | Project page ▸ the quiet line ▸ "7 elem" ▸ the "Fájlok" window. | "Fájlok"; "Hozzáadás a könyvtárból"; "Feltöltés"; "Keresés a projekt fájljai között"; "az eltávolítás nem törli a könyvtárból"; "Kész" | NEW |
| A10 | See in the same window what the project's chats made (Documents, Apps, Canvases), each marked with the chat it came from, and open it in the panel. | Project page ▸ "7 elem" ▸ rows with "„Háromnapos program” beszélgetésből". Home cards and the line count "elem" once anything was made by a chat. | "„{title}” beszélgetésből"; "{count} elem"; "Alkalmazás", "Dokumentum", "Tábla" | NEW |
| A11 | See how many of the project's files a reply actually read and jump to them. | Under a reply ▸ "Infó" ▸ "Projektfájlok: 2 elolvasva · lásd a forrásokat ↓". | "Projektfájlok"; "{count} elolvasva · lásd a forrásokat ↓" | NEW |
| A12 | See which projects know a library file. | Tudásbázis ▸ Dokumentumok ▸ under a file's name: "1 projektben". | "{count} projektben" | NEW |
| A13 | Move a chat into or out of a project and have the project's instructions and files apply or stop applying from its next turn (the drag-and-drop gesture is the existing one). | Sidebar ▸ drag a chat onto a project. | (no new string) | NEW |
| A14 | Read a clearer "what clearing memory does": it deletes what Alfy learned and the uploaded or created documents; personal instructions, chats and the account stay. | Profil és beállítások ▸ Profil ▸ "Ami nem vonható vissza" ▸ "Memória és tudás törlése". | "Törli mindazt, amit az AlfyAI megtanult rólad, és minden feltöltött vagy általa létrehozott dokumentumot. A személyes utasításaid, a csevegéseid és a fiókod megmaradnak." | CHANGED |

## B. Documents

| # | What a person can now do | Where to find it | Hungarian UI name(s) | Status |
|---|---|---|---|---|
| B1 | Ask Alfy for a plan, a letter or a list and get a Document that opens beside the chat (a sheet on a phone), kept as a real item, not a message that scrolls away. A card in the reply shows the title, "Dokumentum · 1 fül", when it was edited and a way in. | In a chat: describe what you need. The reply carries a "Létrehozva" card with "Megnyitás". | "Dokumentum"; "Létrehozva"; "Megnyitás"; "Dokumentum · {count} fül"; "Alfy éppen ír…" while it writes | NEW |
| B2 | Write in it yourself: a toolbar for bold, italic, strikethrough, headings, bullet and numbered lists, checklists, quote, code, table and link, with undo and redo; saved as you type. On a phone the less common formats are under "Több". | The open Document ▸ the toolbar under the title. | "Félkövér", "Dőlt", "Áthúzott", "Címsor 1/2", "Felsorolás", "Számozott lista", "Feladatlista", "Idézet", "Kód", "Táblázat", "Hivatkozás"; "Mentés…", "Mentve", "Nincs kapcsolat" | NEW |
| B3 | Split a Document into tabs (sections), rename and delete them. | The open Document ▸ "Fül hozzáadása" under the title. | "Fül hozzáadása"; "Átnevezés"; "Fül törlése"; "Új szakasz" | NEW |
| B4 | Tick checklist items in place, in the Document and on its card in the chat. | The open Document, or the card. | "Feladatlista" | NEW |
| B5 | See status and date chips in a plan Alfy wrote and change a status from the chip's dropdown (a Document written for a trip or a budget). | The open Document ▸ a chip in the text. | "Állapot"; "Dátum"; "Lefoglalva", "Lefoglalandó", "Kifizetve", "Lemondva" | NEW |
| B6 | Keep any Alfy reply as a Document and keep working on it. A second press opens the same Document, titled by the reply's first sentence. | Hover a reply ▸ its action row ▸ "Megnyitás dokumentumként". | "Megnyitás dokumentumként"; "Megnyitás…"; "Dokumentum megnyitása" | NEW |
| B7 | Download a Document as PDF, Word or Markdown; the file actually reaches the browser (it did not in the first build) and is named after the item's title, accents kept. | The open Document ▸ the download icon "Letöltés"; also Tudásbázis ▸ Dokumentumok ▸ a row's actions. | "Letöltés"; "PDF"; "Word"; "Markdown"; "A fájl előkészítése…" | NEW |
| B8 | Ask for "a document" and get the in-app Document; ask for a PDF, DOCX or XLSX (or say you want a download) and get a downloadable file. Alfy does not make two files for one request. | A chat request. | (behaviour: ruling 77, F10) | CHANGED |
| B9 | Delete a Document; the chat card then says it was deleted and offers "Újragenerálás", which makes it again under the same id from the original request. | The open Document ▸ the trash icon "Dokumentum törlése"; a list row's ⋮ ▸ delete; a deleted card ▸ "Újragenerálás". | "Törlöd ezt a dokumentumot?"; "Ez a dokumentum törölve lett"; "Újragenerálás"; "Dokumentum törölve" | NEW |
| B10 | Trust the editor: your typing survives going offline, a conflict is named, the text you wrote while the Document was deleted can be saved as a new Document. | The open Document. | "Ütközés"; "Mentés új dokumentumként"; "Még nincs elmentve — nincs kapcsolat. A szöveged itt biztonságban van." | NEW |
| B11 | See that Alfy is working: a status line while it edits ("Alfy átnézi a dokumentumot…"), text appearing in place. | The open Document while Alfy edits. | "Alfy átnézi a dokumentumot…"; "Alfy írja…" | NEW |
| B12 | Ask Alfy about the open item without naming it: the composer says what it is about (for an App: "Kérj módosítást: {title}"). | Chat composer while an item is open. | "Kérdezz erről: {title}"; "Kérj módosítást: {title}" | NEW |

## C. Apps

| # | What a person can now do | Where to find it | Hungarian UI name(s) | Status |
|---|---|---|---|---|
| C1 | Ask for a small tool (a tip calculator, a quiz, a cost tracker) and use it in the panel beside the chat. | In a chat: describe the tool. Card "Alkalmazás" ▸ "Megnyitás". Tabs "Előnézet" and "Kód". | "Alkalmazás"; "Előnézet"; "Kód"; "Alfy írja az alkalmazást…" | NEW |
| C2 | Rely on it staying put: it runs sandboxed, with no internet, and keeps what you typed into it between visits. | The open App ▸ the bar above it. | "Homokozóban fut · nincs internet · megőrzi az adataidat" | NEW |
| C3 | See that Alfy checked the app's facts (numbers, dates) before showing it, and read its note when it was unsure. | The open App ▸ the status row. | "Alfy ellenőrizte az alkalmazás adatait."; "Alfy megjegyzése" | NEW |
| C4 | Change an app by asking, in the panel or in the chat; it is rebuilt in place as a new version, your saved data stays, and an Undo toast takes it back. | The open App ▸ "Módosítás…" ▸ "Min változtasson?" ▸ "Újraépítés"; or write the change in the chat. | "Módosítás…"; "Újraépítés"; "Alfy újraépítette"; "Visszavonás" | NEW |
| C5 | Download an App as one .html file. | The open App ▸ the download icon; Tudásbázis ▸ Dokumentumok ▸ the row. | "Letöltés .html-ként" | NEW |
| C6 | Browse an App's earlier versions in History; an old version runs with today's saved data, read-only. | The open App ▸ the moment pill in the header ▸ "Előzmények". | "A mostani mentett adatokkal fut; a változtatások nem mentődnek." | NEW |
| C7 | Be safe from a bad app: it cannot leave its sandbox (frames, navigation, WebRTC are blocked), and one that tries is stopped with a message. | The open App. | "Ez az alkalmazás megpróbálta elhagyni a homokozóját, ezért Alfy leállította." | NEW |
| C8 | Put an App on a Canvas as a block. | Canvas ▸ "Beszúrás" ▸ "Alkalmazás". | "Alkalmazás" | NEW |

## D. Canvas (Tábla)

| # | What a person can now do | Where to find it | Hungarian UI name(s) | Status |
|---|---|---|---|---|
| D1 | Ask for a board (the shape of a problem rather than prose) and work on it beside the chat. The card says "Tábla · 14 blokk". | In a chat: "tedd a táblára az útiterveket". Card ▸ "Megnyitás". | "Tábla"; "{count} blokk" | NEW |
| D2 | Place blocks: text, sticky notes in four colours, frames that group, charts, checklists, diagrams (flowchart, sequence, class, state, ER, Gantt), maps, files, apps, photos and a live web block. Blocks inserted one after another land where there is room instead of piling up. | The board's toolbar ▸ "Beszúrás". | "Szöveg", "Jegyzet" (sárga, menta, kék, sima), "Keret", "Diagram", "Ellenőrzőlista", "Ábra", "Térkép", "Fájl", "Alkalmazás", "Fényképek", "Élő web" | NEW |
| D3 | Insert what the chat already made: charts, Mermaid diagrams, maps, files, apps, photos, or a fresh web search, from a list "from this chat". | "Beszúrás" ▸ the "Ebből a beszélgetésből" list; "Keresés a weben…". | "Ebből a beszélgetésből"; "Fájlok", "Alkalmazások", "Térképek", "Diagramok", "Ábrák", "Fényképek", "Webes keresések" | NEW |
| D4 | Draw on the board: pen, highlighter, line, arrow, rectangle, ellipse, text and an eraser, in four inks. | The board's toolbar ▸ "Rajzolás". | "Toll", "Szövegkiemelő", "Vonal", "Nyíl", "Téglalap", "Ellipszis", "Szöveg", "Radír"; "Kék tinta", "Piros tinta", "Zöld tinta", "Grafitszürke tinta" | NEW |
| D5 | Select several blocks (Shift, Cmd or Ctrl click, a marquee, or a long press on a phone) and move, resize or delete them together; drag a frame with its notes. | The board. | "{count} blokk kijelölve"; "{count} blokk törlése" | NEW |
| D6 | Move around: pan, zoom, fit everything, see an overview; a touchpad's two-finger scroll pans and a pinch zooms. | The board's corners. | "Nagyítás", "Kicsinyítés", "Illesztés a nézetbe", "Tábla áttekintése" | NEW |
| D7 | Undo and redo your own steps on a board; the board saves itself. | The board's toolbar. | "Saját lépés visszavonása"; "Saját lépés ismét"; "Mentve" | NEW |
| D8 | Edit a block after inserting it: a chart's data, a diagram's source, a checklist, a title. | Select the block ▸ its toolbar ▸ edit (or double-click). | "Cím"; "Diagram adatai (JSON)"; "Ábra forrása (Mermaid)" | NEW |
| D9 | Let Alfy build and rearrange a board: it adds notes, frames, charts and diagrams, places them where there is room, and says "Alfy dolgozik a táblán…" while it works. | Ask in the chat, or comment with @Alfy on the board. | "Alfy dolgozik a táblán…"; "Alfy megkérdezése" | NEW |
| D10 | Download the whole board as one PNG picture. | The open board ▸ "Letöltés" ▸ "PNG-kép". | "PNG-kép"; "A teljes tábla egyetlen képként." | NEW |
| D11 | Keep a live-web block current: refresh it, and see when it is out of date. | The block ▸ "Frissítés"; the badge "Elavult". | "Frissítés"; "Elavult"; "Frissítve: {when}" | NEW |
| D12 | Open a file block in the panel: double-click, Enter, or the Open button in its toolbar. | The block. | "{name} megnyitása"; "Dupla kattintással megnyílik" | NEW |

## E. Files that Alfy produces

| # | What a person can now do | Where to find it | Hungarian UI name(s) | Status |
|---|---|---|---|---|
| E1 | Treat a produced file (PDF, Word, Excel, CSV, a report) as the fifth kind, "Fájl", in the same list, card and panel: preview it, download it, delete it, regenerate it from the original request. | In the chat card ▸ "Megnyitás"; the count button's list; "Fájl törlése"; "Újragenerálás". | "Fájl"; "A fájl törölve lett"; "Fájl törölve" | IMPROVED |
| E2 | Have the downloads work: the PDF, Word, Markdown and .html a person asks for now reach the browser (they were made and then nowhere to be found). | Any Letöltés. | "A fájl előkészítése…"; "Ez a vártnál tovább tart. Próbáld újra egy kicsit később." | IMPROVED |
| E3 | Read file sizes correctly in the library (every file read "0 B"). | Tudásbázis ▸ Dokumentumok ▸ MÉRET. | "355 B" | IMPROVED |
| E4 | Open a generated HTML report offline-safe: its pictures are fetched when it is made and stored inside the file. | A generated report. | (no string) | IMPROVED |

## F. The panel, the cards and the chat header

| # | What a person can now do | Where to find it | Hungarian UI name(s) | Status |
|---|---|---|---|---|
| F1 | Open a list of everything the chat made with one button; it carries the item count and a dot when a change waits for you. | The chat's header, top right: the grid icon with a number. | "Nyisd meg, amit ez a beszélgetés készített (4)" (the button's label); panel head "Amit ez a beszélgetés készített"; "4 elem · legújabb elöl" | NEW |
| F2 | Read each row: kind, title, last change, and "1 módosítás vár rád" or "Átnézve"; use a row's ⋮ for more. | The panel's list. | "Dokumentum · 1 fül"; "1 módosítás vár rád"; "Átnézve"; "További műveletek: {title}" | NEW |
| F3 | Work with the panel docked beside the chat, expanded, or closed; the chat and the panel move together on one curve, the sidebar folds to its rail when the chat would get too narrow, and everything is instant under reduced motion. | The panel's header: expand and close. | "Dokumentum-munkaterület kibontása"; "Vissza a dokkolt munkaterületre" | NEW |
| F4 | Press Back and close the top layer first (the item, then the list, then the panel) before leaving the chat, on a phone and on a desktop. | Browser or phone Back. | "Vissza" | IMPROVED |
| F5 | Come back to a chat and find its panel as you left it; an incognito chat's panel never travels. | Reopen a chat. | (behaviour) | NEW |
| F6 | See a card appear as Alfy writes ("Alfy éppen ír…"), a clear failure line when it could not ("Alfynak ezt nem sikerült elkészítenie."), "1 módosítás vár rád" with "Átnézés", and "Megnyitva a panelen" on the open one. | In the chat. | "Átnézés"; "Megnyitva a panelen"; "Alfy készítette: {when}" | NEW |
| F7 | See what a turn made in that reply's Sources, under its own heading. | Under a reply ▸ "Források" ▸ "Ebben a beszélgetésben készült". | "Források"; "Ebben a beszélgetésben készült"; "Az eredeti beszélgetésben készült" | NEW |
| F8 | Read a tool row for an edit or a read properly: "Szerkesztés", "Szerkesztve", "Elolvasva" with the item's title (no longer an opaque id), and on failure "Nem sikerült szerkeszteni" with "Részletek". | In the thinking block's tool rows. | "Szerkesztés"; "Szerkesztve"; "Nem sikerült szerkeszteni"; "Nem sikerült létrehozni"; "Részletek" | NEW |

## G. Working together

| # | What a person can now do | Where to find it | Hungarian UI name(s) | Status |
|---|---|---|---|---|
| G1 | See exactly what Alfy changed in a Document (highlighted, with a pill) and decide: keep or undo each change, or all of them from a review bar with a stepper. A pending change survives a reload. | The open Document, where Alfy's mark is; the bar at the bottom. | "Megtartom"; "Visszavonom"; "Mindet megtartom"; "Mindet visszavonom"; "Alfy 1 részt módosított." | NEW |
| G2 | Rely on Alfy not overwriting what you changed after it last read: it leaves that part alone and says so. | The open Document ▸ the note on the change. | "Alfy egy részt nem érintett, mert megváltoztattad."; "Nézd meg, mit csinált Alfy" | NEW |
| G3 | Review a board the same way: Alfy's work on a board is one pending change with the same two choices; once you have changed the board, Visszavonom sends you to History. | The open board ▸ the review bar below it. | "Alfy 3 blokkot módosított."; "Előzmények megnyitása" | NEW |
| G4 | Comment on a selection: a margin thread with replies, resolve, reopen, a count on the header button, and "Csak a nyitottak". | Select text ▸ "Megjegyzés"; header ▸ the comments icon. | "Megjegyzés"; "Megjegyzések"; "Lezárás"; "Újranyitás"; "Csak a nyitottak" | NEW |
| G5 | Ask Alfy about a selection in place; quick chips make it shorter, friendlier, less list-like or Hungarian. Alfy answers in the margin and marks its change for you. | Select text ▸ "Alfy megkérdezése". | "Alfy megkérdezése"; "Rövidebben"; "Barátságosabban"; "Kevésbé listaszerűen"; "Magyarul" | NEW |
| G6 | Mention @Alfy in any comment or reply to get an answer and an edit; the thread shows "Alfy válaszol…" at once, so it never feels stuck. | A comment's text field. | "Válasz, vagy kérdezd: @Alfy…" | NEW |
| G7 | Comment on a board with pins on a block or a spot, and ask @Alfy to change the board. | The board's toolbar ▸ "Megjegyzés". | "Írj megjegyzést. Az @Alfy megszólításával változtatást kérhetsz." | NEW |
| G8 | Hide or show the comment column, and have the choice remembered on that device. | The header's comments icon. | "Megjegyzések elrejtése"; "Megjegyzések megjelenítése" | NEW |

## H. History

| # | What a person can now do | Where to find it | Hungarian UI name(s) | Status |
|---|---|---|---|---|
| H1 | Open a History of a Document, App or board: moments grouped by day, each saying who did what; a read-only preview beside the list; "Ugyanaz, mint most" where a version equals the present. | The open item ▸ the header's moment pill ("Alfy módosította · 19 órája") ▸ "Előzmények". | "Előzmények"; "Ma"; "Tegnap"; "Most"; "Mind"; "Elnevezettek" | NEW |
| H2 | Name a version ("Az ügyfélhívás előtt"), rename it, remove the name, filter to the named ones. | History ▸ a moment ▸ "Elnevezés". | "Változat elnevezése"; "pl. Az ügyfélhívás előtt"; "Elnevezés"; "Név törlése" | NEW |
| H3 | Restore a version; what you had stays in History, and a restore can be undone. | History ▸ a moment ▸ "Visszaállítás". | "Visszaállítás"; "A mostani megmarad az előzményekben." | NEW |
| H4 | See what changed in a version, compared with the one before or with now, and step through the changes; a board shows new, moved and removed blocks. | History ▸ "Ebben a változatban" / "A mostanihoz képest". | "Ebben a változatban"; "A mostanihoz képest"; "Új"; "Áthelyezve"; "Törölve" | NEW |
| H5 | See the review status of Alfy's changes in History (waiting, kept, undone, partly kept). | History rows. | "Rád vár"; "Megtartva"; "Visszavonva"; "Részben megtartva" | NEW |
| H6 | Read the header of any item as the latest moment, not a version number: the same words on the row, the card and the header. | The header, the list row, the chat card. | "Alfy módosította"; "Szerkesztetted"; "Alfy írta"; "Alfy készítette" | NEW |

## I. Finding, opening and learning

| # | What a person can now do | Where to find it | Hungarian UI name(s) | Status |
|---|---|---|---|---|
| I1 | See all your files and everything Alfy made in one table, filter by kind with counts, and for files by type (PDF, Word, spreadsheets, presentations, images, text, other). The page opens on this tab now. | Tudásbázis ▸ Dokumentumok. | "Összes 7"; "Dokumentumok"; "Táblák"; "Alkalmazások"; "Fájlok"; "Minden fájl"; "PDF"; "Word"; "Táblázatok"; "Prezentációk"; "Képek"; "Szöveg és Markdown"; "Egyéb" | NEW |
| I2 | Read what Alfy did last on each item (a column "VERZIÓ": "Alfy készítette", "Alfy módosította"), open it in the panel, download it, delete it. | Tudásbázis ▸ Dokumentumok ▸ the row. | "VERZIÓ"; "MŰVELETEK" | NEW |
| I3 | Search your workspace: conversations, projects, messages, documents, apps and boards (with kind icons); an item opens in the panel. | Sidebar ▸ "Keresés" (or the search shortcut). | "Keresés a munkaterületen" | IMPROVED |
| I4 | Get a three-step introduction the first time you open a Document, an App or a Canvas; Next, Back, Skip, Got it; it shows once and never in an incognito chat. | The panel, above the item. | "Így működik ez a típus"; "Tovább"; "Vissza"; "Kihagyás"; "Értem"; "Egyszer látod. Bármikor újranézheted." | NEW |
| I5 | Replay an introduction. | A list row's ⋮ menu ▸ "Így működik ez a típus"; an empty item's "Újra megnézem". | "Újra megnézem"; "Újranézés" | NEW |
| I6 | See an empty Document, App or board say what to do next in one line. | The empty item. | "Üres dokumentum. Kezdj el írni, vagy kérd meg Alfyt, hogy megírja."; "Itt még nincs semmi. Kérd meg Alfyt, hogy építsen egy kis eszközt."; "Üres tábla. Szúrj be egy blokkot, vagy rajzolj rá." | NEW |
| I7 | Read a name for every conversation: an untitled chat is "Új beszélgetés" in the sidebar, search and home, in your language. | Sidebar, search, home. | "Új beszélgetés" | IMPROVED |
| I8 | Know the version: the sidebar badge reads v2.2.0 and opens the latest announcement. | Sidebar head. | "Alkalmazásverzió: v2.2.0" | CHANGED |

## J. Privacy and safety (ADR-0068, the exfil channels)

| # | What a person can now do | Where to find it | Hungarian UI name(s) | Status |
|---|---|---|---|---|
| J1 | Rely on a reply loading only pictures its own tools returned; any other picture is a visible link instead of a request nobody clicked. | In a reply. | "A kép nem töltődött be: {name}. A megtekintéséhez nyisd meg a hivatkozást." | NEW |
| J2 | Rely on Alfy opening a page only if you gave the address or one of its tools found it; any other address stays a link in the reply until you click. | (automatic) | (no string) | NEW |
| J3 | See image-search pictures as 500 px thumbnails served by the app itself, not fetched from other hosts by the browser. Older chats show those pictures as links. | In a reply that used image search. | (no string) | CHANGED |
| J4 | Rely on source icons (favicons) being fetched only for addresses a tool returned. | Source chips. | (no string) | CHANGED |
| J5 | Rely on Mermaid diagrams being cleaned before they draw: nothing in a diagram can load an address or add a link. | A diagram in a reply or on a board. | (no string) | NEW |
| J6 | Rely on model-written markup staying inert: no forms and no overlays drawn over the chat. | In a reply. | (no string) | NEW |
| J7 | Rely on Apps being unable to open frames or peer connections, with the browser rule enforced in report-only mode too. | The open App. | (no string) | NEW |
| J8 | Rely on a connector's summarised text not becoming a source for Alfy to fetch an address from. | (automatic) | (no string) | NEW |
| J9 | Rely on generated reports carrying their pictures inside, so opening one outside the app calls no host. | A generated HTML report. | (no string) | NEW |
| J10 | Take your data with you: "Adataim letöltése" now includes your documents, apps and boards with their history, comments and saved data, your personal and project instructions, each project's file list and the introductions you have seen; erasing the account removes them. | Profil és beállítások ▸ Profil ▸ "Adatok és adatvédelem" ▸ "Adataim letöltése". | "Adataim letöltése" | IMPROVED |

## K. The chat itself

| # | What a person can now do | Where to find it | Hungarian UI name(s) | Status |
|---|---|---|---|---|
| K1 | Get a reply in the language you write, not the language of a document in the context. Asking for a piece of writing in another language ("Írj egy e-mailt angolul") keeps the conversation's language; only "válaszolj angolul" switches the reply. | Any chat. | (behaviour: ruling 75) | IMPROVED |
| K2 | See two follow-up chips under a reply that are your next message (an instruction or your own question), visible at rest, not only on hover; a tap sends the text as it stands. | Under a reply. | "Küldés: {question}" (the chip's accessible name) | IMPROVED |
| K3 | Open a chat at its latest message and stay there while a reply streams; scrolling away stops the follow; a link to one message opens it once. | Any chat. | (behaviour) | IMPROVED |
| K4 | Get clean titles, status lines and rail headlines: no leaked reasoning, no restated request, in the reply's language. | Sidebar titles, the thinking rail. | (behaviour) | IMPROVED |
| K5 | Send a first message and see the page in your language from the first frame (it flashed English before). | Home ▸ first message. | (behaviour) | IMPROVED |
| K6 | See the citation audit and the project-files count arrive while the reply is new, not only after a reload. | Under a reply ▸ "Infó". | "Hivatkozás-ellenőrzés" | IMPROVED |
| K7 | Use dialogs, popovers and the image viewer from the keyboard: Tab stays inside, Escape closes only the top layer, focus returns to what opened it. | Every dialog, popover and the image viewer. | (behaviour) | IMPROVED |
| K8 | Read honest retry labels: "Újrapróbálom" instead of the long noun. | Wherever a retry is offered. | "Újrapróbálom" | CHANGED |
| K9 | Read a shorter pin label: "Rögzítés" and "Rögzítés feloldása". | A conversation's menu. | "Rögzítés"; "Rögzítés feloldása" | CHANGED |
| K10 | Meet fewer stuck states: a chat reloaded right after a first turn that failed at once no longer spins forever, and a save made while another save runs no longer fails with "database is locked". | Any chat or item. | (behaviour) | IMPROVED |

## L. Phones, motion and accessibility

| # | What a person can now do | Where to find it | Hungarian UI name(s) | Status |
|---|---|---|---|---|
| L1 | Use the panel's controls with a finger: 44 px targets, bottom sheets, a review bar that does not eat the screen, the sidebar's dots and a project's counter no longer colliding. | A phone. | (layout) | IMPROVED |
| L2 | Not see keyboard chords on a touch screen (they were plain wasted space): the shortcut hints are drawn only where there is a keyboard. | A phone or tablet. | (behaviour) | IMPROVED |
| L3 | Read short Hungarian labels that fit the row: the panel's way back is "Vissza", not "Ez a beszélgetés". | The panel header. | "Vissza"; "Megtartom"; "Visszavonom" | IMPROVED |
| L4 | See layout changes move together, in one motion language, and instantly with reduced motion on; toasts carry an Undo and an exit motion. | The panel, the board, toasts. | "Visszavonás" | IMPROVED |
| L5 | Use the Document and the board from the keyboard: undo and redo keys that do not clash with the editor, Alfy's own undo/redo keys, announcements for screen readers. | The open item. | (behaviour) | NEW |
| L6 | Use a board with a touchpad the way a design tool does, and have the board keep inside its pane when the on-screen keyboard opens. | The board. | (behaviour) | NEW |

## M. Removed or changed in a way a returning user notices

| # | What changed | Where they would have looked | Hungarian UI name(s) | Status |
|---|---|---|---|---|
| M1 | **Manage context sources** is gone: the per-source Auto, Pinned, Excluded steering and its side panel. What Alfy used is still listed, read-only, in a reply's Sources. | The context ring's popover ▸ "Kontextusforrások kezelése". | "Kontextusforrások kezelése"; "Aktív források"; "Rögzített"; "Kizárt" (all gone) | REMOVED |
| M2 | **The home suggestion chips** are gone ("Javasolt kezdések", "másikat", the per-source suggestions from calendar, mail, photos, repositories and memory). Project cards stand where they were. | Home ▸ under the composer. | "Javasolt kezdések"; "Másik három javaslat mutatása" (gone) | REMOVED |
| M3 | The project row's new-chat button opens the project's page instead of creating a chat at once. | Sidebar ▸ Projektek. | "{name} megnyitása" | CHANGED |
| M4 | The Knowledge base opens on Dokumentumok; the Memory profile is the second tab (a review link still lands on it). | Tudásbázis. | "Dokumentumok"; "Memóriaprofil" | CHANGED |
| M5 | A request for "a document" no longer produces a DOCX by default. | A chat. | (B8) | CHANGED |
| M6 | "Pin to sidebar" reads "Rögzítés" and the search box says "Keresés a munkaterületen". | Conversation menu; search. | "Rögzítés"; "Keresés a munkaterületen" | CHANGED |
| M7 | Per-source evidence preferences stored by earlier users were deleted by a migration (the rows were unreachable once the panel went). | (no screen) | (no string) | REMOVED |

## N. Administrators only

| # | What an admin can now do | Where to find it | Hungarian UI name(s) | Status |
|---|---|---|---|---|
| N1 | Set the monthly Parallel allowance that no user is charged for (default $5, 0 charges every call); only calls beyond it are billed to the user who made them. | Profil és beállítások ▸ Adminisztráció ▸ Rendszer ▸ "Integrációk és kulcsok" ▸ "Parallel ingyenes havi keret". | "Parallel ingyenes havi keret"; "Parallel hívások addig nem jelentenek költséget…" | NEW · admin |
| N2 | Read the allowance's meter in system analytics: used against the allowance, the reset date, the counted cost, calls per month. | Adminisztráció ▸ the analytics. | "Ingyenes használat"; "Költségként elszámolva"; "Elszámolt költség"; "Hívások"; "Visszaáll: {month} 1." | NEW · admin |
| N3 | Create, edit and publish first-open tours as a campaign type; seed the three tour drafts; a tour has one summary slide (the empty-state line) and three standard slides; a published tour replaces the code copy and archiving it gives the code copy back. | Adminisztráció ▸ Kampányok ▸ "Bemutató-piszkozatok létrehozása"; the type "Bemutató"; "Összegző dia hozzáadása". | "Bemutató"; "Bemutató-piszkozatok létrehozása"; "Összegző dia hozzáadása"; "Egy összegző, utána három általános dia"; "Üres állapot sora" | NEW · admin |
| N4 | Preview a tour as the reader's own card, in the language being edited. | Kampányok ▸ a tour draft ▸ the preview. | "Üres állapot" | NEW · admin |
| N5 | Know the sidebar badge opens the latest announcement (first-run onboarding or release), never a tour. | Sidebar head. | (behaviour: ADR-0012 amended) | CHANGED · admin |
| N6 | Enter decimal values in admin fields (a money field takes a `$` prefix and a fraction); a stored number is always plain decimal. | Adminisztráció ▸ Rendszer. | (control) | IMPROVED · admin |
| N7 | Run behind a proxy with the browser's origin enforced (set `ORIGIN` when uploads fail with "Cross-site POST form submissions are forbidden"), and expect `frame-src` enforced even in report-only mode. | Server configuration. | (operator note) | CHANGED · admin |

---

## O. Deliberately not in 2.2

- **Slides** (Diasor): built on a branch, shelved by ruling 69. No Slides tour, no Slides filter chip, never named in the campaign.
- **Computers** (Feature 3, ADR-0067, `alfy-remote`): status "Proposed"; there is no code in the tree (a search for `alfy-remote` finds nothing in `src/`).
- **Dictation, the image-understanding tool, file analysis in the sandbox** (ADR-0064 items 3 to 5): no change in this diff.
- **Operator-only changes** with no user-visible effect: the fast e2e gates (release gate 51 min to about 8.5 min), the sampling route for internal model calls (cleaner short answers is the visible part, K4), the migration discipline, the ORS memory-mapped regions note.

## P. In production before 2.2 and never announced

The unpublished 2.1 draft (`campaign/2-1-deck`, `docs/plans/campaign-2.1-copy.md`) is about features that are already on
`origin/main`, so they are not part of this diff: session expiry (a row that says you were signed out, with "Bejelentkezés
újra"), incognito chosen once before a chat exists, 73 accepted file types, `[p. N]` page citations. The owner may want
a line about them in the 2.2 campaign or in the onboarding; they are not in the 2.2 slides.

---

## Step 2: what a brand-new user sees (the first-run onboarding)

**How a new user meets the app.** `getEligibleCampaignForUser` (`announcement-campaigns.ts`) answers in this order:

1. the latest published **first-run onboarding**, if the user has not finished or dismissed that snapshot;
2. otherwise the latest published **release update**, if the user has not finished that snapshot (the sidebar badge
   replays the latest announcement, onboarding or release, `getLatestPublishedAnnouncement`, never a tour);
3. a **first-open tour** later, inside the panel, the first time they open a Document, an App or a Canvas (never in an
   incognito chat; once per published copy).

There is **no date check**: a user who signs up after 2.2 is published meets the onboarding first, and on a later load
the 2.2 release card as well (ADR-0012: "a brand-new user does not see a release/update campaign immediately after
onboarding in the same app-load flow"). So the release campaign is also the new user's first look at the feature set, and
it has to read as a description of what Alfy can do, not as a diff. The 2.2 copy therefore uses the present tense and
avoids "new" and "from now on".

**What the repository contains.** Only the *template*: `seedFirstRunOnboardingTemplate` (reached from Adminisztráció ▸
Kampányok ▸ "Első indítás magkampány", `/api/admin/campaigns/seed-first-run`) writes a draft of four
slides: a setup slide (interface language, theme, default model, AI style), "Bring your ChatGPT history" with a button to
`internal:chatgpt-import`, a placeholder "Introduce a released feature" ("Replace this draft copy with admin-authored
campaign content."), and the data-processing disclosure. The onboarding that is **published on production lives in the
production database**, written by the owner; it is not in the repo and I did not read it (nothing was run against any
server). Whatever it says, it was published before 2.2 existed, so **it cannot mention a single 2.2 feature**.

**What a new user would miss.** Everything in groups A to J: that a chat can make a Document, an App or a board; that
projects have a page, instructions and files; that a personal instruction exists; where Alfy's work is listed and how to
find it again; that Alfy's edits wait for Keep or Undo. The three first-open tours cover Document, App and Canvas on the
first open, but only the first-open moment and only for those three, and nothing explains projects, instructions or the
header count button. Without the 2.2 card a new user also has no "where to find it".

**Proposal (for the owner; nothing is published).** Keep the onboarding short; do not turn it into the release notes.
Add two standard slides before the data-disclosure slide, and replace the placeholder feature slide with the first:

1. **Alfy készít, te szerkeszted** / *Alfy makes it, you shape it*: "Kérd meg Alfyt, hogy írjon dokumentumot, építsen kis
   alkalmazást vagy tegyen táblára ötleteket. Beszélgetés mellett nyílnak meg, ott szerkesztheted, és a fejléc jobb szélén a
   számláló gomb mutatja, mi készült." (Where: the chat header's count button.)
2. **Projektek és utasítások** / *Projects and instructions*: "Egy projekt a csevegéseidet, a fájljaidat és az utasításaidat
   tartja egyben. Amit mindig tudnia kell, azt egyszer írd le: Profil és beállítások ▸ Személyes utasítások." (Where:
   sidebar ▸ Projektek.)

The same two slides, with pictures taken from the 2.2 build, are in `campaign-2.2-copy.md` (section "Onboarding
update"). Alternatively, leave the onboarding as it is and rely on the 2.2 card, which a new user will see on the next
load; the cost is a gap of one page load between "set up AlfyAI" and "what AlfyAI can do". If the owner wants a new
user to skip a release card that describes things they never lacked, the change is a code one (a creation-date check in
`getEligibleCampaignForUser`), not a content one, and it is outside this brief.

---

## How it was built

Five sources, cross-checked against each other; the numbers in the header are from the commands below.

| Source | What it gave | Check against the others |
|---|---|---|
| (a) `git diff origin/main origin/dev -- src/lib/i18n/` | 803 added keys (657 new `artifacts.*`: canvas 223, document 150, history 140, app 54, delete 28, panel 12, deleted 11, tour 10, card 9; `knowledge.documents.*` 28; `projects.*` 45; `instructions.*` 23; `admin.campaigns.*` 18; `analytics.parallel*` 6; `toolActivity.*` 5; `chat.artifacts.*` 4; `composerCommands.instruction.*` 4; `profileTab.personalInstructions*` 5), 64 removed (`contextSources.*` 28, `home.suggest*` 31, `contextUsageRing` 3, `sidebar.failedCreateProjectConversation`), 12 changed. | Each namespace maps to a route or component in (b), a merge in (d) and a ruling in (e). `artifacts.type.slides`, `knowledge.documents.filter.slides` and the `slides` count strings are in the dictionary but unreachable (ruling 69). |
| (b) `git diff --stat origin/main origin/dev -- src/routes/` and `src/lib/components/` | 87 added route files, 41 of them not tests (the project page and its two dialogs, 23 `/api/artifacts/*` routes, the tours routes, the project-knowledge routes, the instruction-suggestion route, the file-job routes, the image thumbnail route), 3 deleted (`task-steering`, the landing-incognito pair that moved), 75 modified; 3 deleted components (`EvidenceManager`, `EvidencePreferenceControl`, `HomeSuggestionRail`) and 184 added non-test components. | Every added route has a string or a documented behaviour in (a)/(e). |
| (c) Settings and admin | One new admin key (`PARALLEL_FREE_MONTHLY_USD`) and a `number` control; the Campaigns pane's tour type; the Profile tab's "Személyes utasítások" row; the analytics meter. | Matches Slice B and Slice C of Feature 1 and `drizzle/…106` to `…113`. |
| (d) 53 first-parent merges and 5 ADRs (0064 to 0068; 0012 amended) | The order of the work: Workspaces (7 slices, 2026-09-24/25), Artifacts waves 1 to 4 (09-25 to 10-07), the redesign (09-27/29), Canvas (09-30), owner walks (10-01), tours (10-05/06), Phase 5 versions (10-12), the friction build (10-12), the exfil channels and the WebRTC guard (10-12/13). | The merge bodies name what each wave contains; every wave's name appears in the groups above. |
| (e) `docs/plans/claude-at-home-1/*`, `claude-at-home-2/{progress,decisions}.md` and `phase-5/fa-report.md` (the 30 friction findings) | Rulings 1 to 77, the friction findings with the exact Hungarian labels the audit saw, the owner's own finds. | The friction audit's quoted labels ("Letöltés", "Megnyitás dokumentumként", "Beszúrás", "Módosítás…") match the dictionary. |

A sixth check was the running product: a production build of `dev` with a Hungarian sample account
(`scripts/seed-campaign-2-2.ts`) was opened to confirm the paths in the "Where" columns (the sidebar, the home page, the
project page, Settings, the Knowledge page, the chat header, the panel and a Document with a pending change).

Counts of the diff, for the record: 1,736 files changed, 387,906 insertions, 11,871 deletions; 1,726 commits (1,541
without merges): 222 `fix`, 77 `feat`, 57 `test`, 27 `style`, 23 `docs`, 11 `refactor`, the rest imperative-form subjects.
