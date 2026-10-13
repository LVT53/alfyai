# AlfyAI 2.2 release campaign: copy (version 2)

**Status: a draft for the owner's review. Nothing is published, and nothing was run against any server.** The deck below
was checked by `scripts/create-release-campaign.ts` (a dry run, then a real draft in a scratch database on this machine),
by `scripts/create-release-campaign.test.ts` (which creates and publishes this very deck into an in-memory database on
every test run), and rendered in the app's own campaign card, in Hungarian and English, on a phone and on a desktop.

This is the second version. The owner's verdict on the first: "they are cool if you already know what changed, but it
doesn't tell new users particularly about ALL the new features from dev, or where to find them. Let's do a new version.
And are you sure you included everything?" The honest answer was no. The first draft came from a five-theme summary; this
one comes from [`campaign-2.2-inventory.md`](./campaign-2.2-inventory.md), a 120-row list of everything user-facing that
changed between production (`origin/main`) and `origin/dev`, each row with where a person finds it and its Hungarian UI
name, built from the i18n diff, the routes and components, the settings, the merges and ADRs and the Feature 1 and 2 plans.

What changed in the campaign because of that:

- **Ten slides instead of five**, one idea each, in the order a person who knows nothing would want them: the three things
  Alfy now makes (Document, App, Canvas), how you work on them together, how you go back, projects, instructions, where
  everything is found, what Alfy will not do, and the smaller changes.
- **Every slide ends with a "where to find it" line** ("Hol találod: …" / "Where to find it: …"), in the app's own labels,
  checked against the dictionaries by a test.
- **Present tense, no "new" and no "from now on".** A person who signs up after 2.2 is published meets the onboarding
  first and, on a later load, this card as well (`getEligibleCampaignForUser` has no date check), so it has to read as a
  description of what Alfy can do, not as a diff. The one place that says something is gone is the last slide, in one
  clause.
- **What the first draft missed** is listed under "What the first draft missed" below.

Ruling 78 makes 2.2 the next production release. Production is on the 2.0 line. Slides is shelved and is not mentioned.

The version is set in two places that must move together (`app-version.ts`: the sidebar badge is the higher of
`package.json` and the newest published release campaign): `package.json` is **2.2.0** and the campaign's release version
is **2.2.0**. The comparator reads "2.2" and "2.2.0" as one version (`app-version.test.ts` pins it), so the badge reads
**v2.2.0** either way; the campaign uses `2.2.0` because 2.0's did.

## Where everything is

| What | Where |
|---|---|
| This copy | `docs/plans/campaign-2.2-copy.md` |
| The inventory it comes from, and the first-run onboarding finding | `docs/plans/campaign-2.2-inventory.md` |
| The deck the campaign is created from (Hungarian-interface pictures) | `docs/plans/campaign-2.2/deck/` (`slides.json`, `slides/*.png`) |
| The same words with English-interface pictures (an alternate) | `docs/plans/campaign-2.2/deck-en/` |
| The reader's card as it renders: Hungarian and English, desktop and phone | `docs/plans/campaign-2.2/preview/cards-*.png` |
| The admin Campaigns pane with the draft open, Hungarian and English | `docs/plans/campaign-2.2/preview/admin-*.png` |
| The sample content and the scripts that take the pictures and the previews | `scripts/seed-campaign-2-2.ts`, `scripts/campaign-shots-2-2.ts`, `scripts/campaign-deck-pictures-2-2.ts`, `scripts/campaign-previews-2-2.ts` |

## What the campaign editor lets a deck be

The editor and the service set **no maximum** on the number of slides of a release campaign (the service wants at least
one; `create-release-campaign.ts` wants at least four). What bounds a deck is the card, and these were measured:

- **A title and a body in both languages on every slide, alt text in both when a slide has pictures, and a button needs
  both labels and an allow-listed destination** (the publish checklist reads 12 / 12 for this deck, `preview/admin-hu.png`).
- **A body past about 400 characters (a little over 300 when the slide has a button) makes a 390x844 phone card scroll**;
  every body here fits whole (`preview/cards-*-phone.png`). The test pins 360, so a longer edit fails before it is seen.
- **The pictures are 16:10 (1600x1000) and 9:16 (1080x1920)**, and the card draws them at most 520 and 190 pixels wide, so
  a full window is unreadable in it: these are tight crops (see "The pictures").
- **A button goes only where the allow-list says**: `/`, `/chat`, `/knowledge`, `/settings`, `/settings/profile`,
  `/settings/admin` and `internal:chatgpt-import`. (`/settings/profile` and `/settings/admin` have no route files; the
  settings page is `/settings`, so that is the one used.) A button navigates behind the card and the card stays open, so
  the reader can carry on (tried in a browser).
- **A body is plain text with its line breaks kept**; there is no bold, so the "where to find it" line is a paragraph of
  its own, introduced by the same two words on every slide.

## The ten slides

Hungarian first. Titles and bodies are the exact strings in `slides.json`. Every Hungarian label quoted is the app's own
(checked against `src/lib/i18n/`, see "Fact checks").

### Slide 1: Dokumentum, amit ketten írtok

- **titleHu**: Dokumentum, amit ketten írtok
- **titleEn**: A document you write together
- **bodyHu**:

  > Kérd meg Alfyt, hogy írjon meg egy tervet vagy levelet. A beszélgetés mellett nyílik meg: szerkesztheted, füleket és táblázatot adhatsz hozzá, és letöltheted PDF-ként, Wordként vagy Markdownként.
  >
  > Hol találod: a válasz alatti kártyán, vagy a fejléc jobb oldali gombján. Bármelyik válaszból lehet dokumentum: „Megnyitás dokumentumként”.

- **bodyEn**:

  > Ask Alfy to write a plan or a letter. It opens beside the chat: edit it, add tabs and tables, and download it as PDF, Word or Markdown.
  >
  > Where to find it: the card under the reply, or the button at the right of the chat header. Any reply can become one: “Open as document”.

- **altTextHu**: Egy dokumentum a beszélgetés mellett: fülek, formázó eszköztár és egy összehasonlító táblázat; fent a megjegyzések, a letöltés, a törlés és a kibontás gombja. Telefonon a Teendők fül jelölőnégyzetes listája.
- **altTextEn**: A document open beside the chat: tabs, a formatting toolbar and a comparison table; at the top the buttons for comments, download, delete and expand. On a phone, the Teendők tab with its checklist.
- **Button**: none
- **Pictures**: `slides/01-document-desktop.png` (1600x1000) and `slides/01-document-mobile.png` (1080x1920)
- **Covers** (inventory rows): B1 to B4, B6, B7 (the Document, its editing, tabs, checklists, PDF/Word/Markdown, Open as document), F1 (the header button)

### Slide 2: Alkalmazás: kis eszköz, ami itt fut

- **titleHu**: Alkalmazás: kis eszköz, ami itt fut
- **titleEn**: An app: a small tool that runs here
- **bodyHu**:

  > Mondd el, mire van szükséged: költségkövetőre, kalkulátorra, kvízre. Alfy megépíti, ellenőrzi benne az adatokat, és a panelben azonnal használhatod. Megjegyzi, amit beírtál; a „Módosítás…” gombbal átépítheted.
  >
  > Hol találod: a válasz alatti „Alkalmazás” kártyán; a panel fejlécében le is töltheted.

- **bodyEn**:

  > Say what you need: a cost tracker, a calculator, a quiz. Alfy builds it, checks its facts, and you use it in the panel at once. It remembers what you type; “Change this app…” rebuilds it.
  >
  > Where to find it: the “App” card under the reply; download it from the panel header.

- **altTextHu**: Egy költségkövető alkalmazás a panelben: az Előnézet és a Kód fül, a Módosítás… gomb, a homokozó sávja és a felvett kiadások
- **altTextEn**: A cost-tracker app in the panel: the Preview and Code tabs, the Change this app… button, the sandbox bar and the expenses entered
- **Button**: none
- **Pictures**: `slides/02-app-desktop.png` (1600x1000) and `slides/02-app-mobile.png` (1080x1920)
- **Covers** (inventory rows): C1 to C5 (the App: runs in the panel, fact-checked, remembers, Change this app, .html), F1

### Slide 3: Tábla: szabad felület az ötleteidnek

- **titleHu**: Tábla: szabad felület az ötleteidnek
- **titleEn**: A canvas: a free surface for your ideas
- **bodyHu**:

  > Jegyzetek, keretek, diagramok, listák, térkép, fájlok: úgy rendezed el őket, ahogy gondolkodsz. Rajzolhatsz is rá, Alfy pedig rendet rak, ha kéred. Több blokkot együtt mozgathatsz, a kész táblát PNG-képként letöltheted.
  >
  > Hol találod: kérj táblát („tedd a táblára az útiterveket”); lent az eszköztárban a „Beszúrás” és az „Alfy megkérdezése”.

- **bodyEn**:

  > Notes, frames, charts, lists, a map, files: arrange them the way you think. Draw on it, and Alfy tidies up when you ask. Move several blocks together, and download the finished board as a PNG.
  >
  > Where to find it: ask for a board (“put the trip options on a board”); “Insert” and “Ask Alfy” are in the toolbar at the bottom.

- **altTextHu**: Egy tábla napokra bontott keretekkel és jegyzetekkel, egy ellenőrzőlistával, egy diagrammal és kézzel rajzolt jelekkel; alul az eszköztár a Beszúrás gombbal
- **altTextEn**: A canvas with day frames and notes, a checklist, a chart and marks drawn by hand; at the bottom the toolbar with the Insert button
- **Button**: none
- **Pictures**: `slides/03-canvas-desktop.png` (1600x1000) and `slides/03-canvas-mobile.png` (1080x1920)
- **Covers** (inventory rows): D1 to D5, D10 (the Canvas: blocks, drawing, Alfy arranges, several blocks together, PNG), C8

### Slide 4: Alfy módosít, te döntesz

- **titleHu**: Alfy módosít, te döntesz
- **titleEn**: Alfy edits, you decide
- **bodyHu**:

  > Ha Alfy átír valamit a dokumentumodban vagy a táblán, látod, mi változott: „Megtartom” vagy „Visszavonom”. Megjegyzést írhatsz bárhová; ha @Alfyt említed, válaszol, kérésre javít is. Amit közben te írtál át, ahhoz nem nyúl.
  >
  > Hol találod: jelölj ki szöveget, és válaszd a „Megjegyzés” vagy az „Alfy megkérdezése” gombot.

- **bodyEn**:

  > When Alfy changes your document or canvas, you see what changed and decide: “Keep” or “Undo”. Comment anywhere; mention @Alfy to get an answer, or a fix if you ask for one. What you changed meanwhile, Alfy leaves alone.
  >
  > Where to find it: select some text and choose “Comment” or “Ask Alfy”.

- **altTextHu**: Egy dokumentum Alfy egy módosításával és a Megtartom, Visszavonom gombokkal, mellette egy @Alfyt kérdező megjegyzés és a válasza, alul a Mindet megtartom sáv
- **altTextEn**: A document with one change by Alfy and its Keep and Undo buttons, beside a comment that asks @Alfy and its answer, with the Keep all bar at the bottom
- **Button**: none
- **Pictures**: `slides/04-together-desktop.png` (1600x1000) and `slides/04-together-mobile.png` (1080x1920)
- **Covers** (inventory rows): G1 to G7 (Keep and Undo, Alfy leaves your changes alone, comments, Ask Alfy, @Alfy), on Documents and boards

### Slide 5: Minden változatra visszatérhetsz

- **titleHu**: Minden változatra visszatérhetsz
- **titleEn**: Go back to any version
- **bodyHu**:

  > Az Előzmények napokra bontva mutatja, ki mit változtatott. Elnevezhetsz egy változatot, megnézheted, és visszaállíthatod; a mostani is megmarad. Dokumentumnál, alkalmazásnál és táblánál is működik.
  >
  > Hol találod: a panel fejlécében a legutóbbi változást mutató gomb („Alfy módosította · 19 órája”).

- **bodyEn**:

  > History lists every change by day and says who made it. Name a version, preview it, restore it; what you have now stays. It works for documents, apps and canvases.
  >
  > Where to find it: the button in the panel header that shows the latest change (“Changed by Alfy · 19 h ago”).

- **altTextHu**: Egy dokumentum Előzmények nézete: napokra bontott változatlista, egy elnevezett változat és az előnézete a Visszaállítás gombbal
- **altTextEn**: A document's History view: a version list grouped by day, a named version and its preview with the Restore button
- **Button**: none
- **Pictures**: `slides/05-history-desktop.png` (1600x1000) and `slides/05-history-mobile.png` (1080x1920)
- **Covers** (inventory rows): H1 to H6 (History for Documents, Apps and Canvases: days, naming, preview, Restore), C6

### Slide 6: Minden projektnek saját oldala van

- **titleHu**: Minden projektnek saját oldala van
- **titleEn**: Every project has its own page
- **bodyHu**:

  > A projekt oldalán egy helyen vannak a csevegései, az utasításai és a fájljai. Az itt indított csevegés már tudja, miről szól a projekt. A Fájlok ablakban feltölthetsz vagy a könyvtárból adhatsz hozzá, és ott látod azt is, amit a csevegések készítettek.
  >
  > Hol találod: a kezdőlapon a Projektek kártyái, vagy az oldalsávban a projekt sora melletti gomb.

- **bodyEn**:

  > A project's page keeps its chats, instructions and files in one place. A chat started there already knows the project. In the Files window you upload or add from your library, and you see what the chats made.
  >
  > Where to find it: the Projects cards on the home page, or the button beside a project in the sidebar.

- **altTextHu**: A Balatoni nyaralás projekt Fájlok ablaka: feltöltött fájlok és a csevegések készítette alkalmazás, dokumentum és tábla; fent a Hozzáadás a könyvtárból és a Feltöltés gomb. Telefonon a projekt oldala.
- **altTextEn**: The Files window of the Balatoni nyaralás project: uploaded files and the app, document and canvas its chats made; at the top the Add from library and Upload buttons. On a phone, the project's page.
- **Button**: none
- **Pictures**: `slides/06-projects-desktop.png` (1600x1000) and `slides/06-projects-mobile.png` (1080x1920)
- **Covers** (inventory rows): A1 to A3, A9, A10 (the project page, the home cards, Files, what the chats made), M3

### Slide 7: Utasítások, amiket nem kell ismételned

- **titleHu**: Utasítások, amiket nem kell ismételned
- **titleEn**: Instructions you never have to repeat
- **bodyHu**:

  > Írd le egyszer, hogyan válaszoljon Alfy: minden csevegésben, vagy egy projekt csevegéseiben. Az /instruction paranccsal is felvehetsz egyet, és Alfy felajánlja, ha észreveszi, hogy valami nálad mindig érvényes.
  >
  > Hol találod: Profil és beállítások › Profil › Az asszisztens viselkedése.

- **bodyEn**:

  > Write down once how Alfy should answer: in every chat, or in the chats of one project. You can add one with /instruction too, and Alfy offers to when it notices something that always applies to you.
  >
  > Where to find it: Profile & Settings › Profile › Assistant behaviour.

- **altTextHu**: A projekt Utasítások ablaka a szöveggel, a 310 / 2000 karakterszámlálóval, a Mégsem és a Mentés gombbal
- **altTextEn**: The project's Instructions window with its text, the 310 / 2000 character counter, and the Cancel and Save buttons
- **Button**: Beállítások megnyitása / Open settings, goes to `/settings`
- **Pictures**: `slides/07-instructions-desktop.png` (1600x1000) and `slides/07-instructions-mobile.png` (1080x1920)
- **Covers** (inventory rows): A4 to A8 (personal and project instructions, /instruction, Alfy's offer, the info popover)

### Slide 8: Amit Alfy készített, egy helyen találod

- **titleHu**: Amit Alfy készített, egy helyen találod
- **titleEn**: Everything Alfy made, in one place
- **bodyHu**:

  > A Tudásbázis Dokumentumok lapján egy listában látod a feltöltött fájlokat és Alfy dokumentumait, alkalmazásait és tábláit; típus szerint szűrhetsz, és a keresés is megtalálja őket. Egy törölt dokumentumot vagy alkalmazást a beszélgetésből újra létrehozhatsz.
  >
  > Hol találod: oldalsáv › Tudásbázis › Dokumentumok.

- **bodyEn**:

  > The Knowledge base's Documents tab lists your uploaded files and Alfy's documents, apps and canvases in one place; filter by type, and search finds them too. A deleted document or app can be made again from its chat.
  >
  > Where to find it: sidebar › Knowledge base › Documents.

- **altTextHu**: A Tudásbázis Dokumentumok lapja: típus szerinti szűrők számlálóval, és egy lista Alfy alkalmazásáról, dokumentumairól és tábláiról
- **altTextEn**: The Knowledge base's Documents tab: filters by type with counts, and a list of Alfy's app, documents and canvas
- **Button**: Tudásbázis megnyitása / Open Knowledge base, goes to `/knowledge`
- **Pictures**: `slides/08-knowledge-desktop.png` (1600x1000) and `slides/08-knowledge-mobile.png` (1080x1920)
- **Covers** (inventory rows): I1 to I3 (the Knowledge base's Documents tab, filters, search), B9 and E1 (delete and regenerate), M4

### Slide 9: Alfy magától nem nyit meg idegen oldalakat

- **titleHu**: Alfy magától nem nyit meg idegen oldalakat
- **titleEn**: Alfy won’t open unknown pages on its own
- **bodyHu**:

  > Alfy csak olyan oldalt és képet tölt be, amelynek a címét te adtad meg, vagy amelyet az egyik eszköze talált. Minden más cím hivatkozás marad a válaszban, amíg rá nem kattintasz. Az alkalmazások internet nélkül, védett környezetben futnak.
  >
  > Hol találod: nem kell beállítanod semmit; ha kép helyett hivatkozást látsz, ez az oka.

- **bodyEn**:

  > Alfy loads a page or a picture only if you gave its address or one of its tools found it. Any other address stays a link in the reply until you click it. Apps run in a sandbox with no internet.
  >
  > Where to find it: nothing to set up; if you see a link instead of a picture, this is why.

- **altTextHu**: Egy válasz, amelyben három kép nem töltődött be, hanem hivatkozásként jelenik meg
- **altTextEn**: A reply in which three pictures are shown as links instead of being loaded
- **Button**: none
- **Pictures**: `slides/09-privacy-desktop.png` (1600x1000) and `slides/09-privacy-mobile.png` (1080x1920)
- **Covers** (inventory rows): J1, J2, J6, J7 (no address fetched without a click, the App sandbox)

### Slide 10: A kisebb változások

- **titleHu**: A kisebb változások
- **titleEn**: The smaller changes
- **bodyHu**:

  > Alfy a te nyelveden válaszol, a javasolt folytatások egy koppintással elmennek, az első dokumentum, alkalmazás vagy tábla megnyitásakor pedig rövid bemutató segít. Eltűnt a „Kontextusforrások kezelése” panel és a kezdőlapi ötletsor: a helyén a projektek kártyái állnak.
  >
  > Hol találod: a bemutatót a panel listájában egy sor ⋮ menüje indítja újra.

- **bodyEn**:

  > Alfy answers in the language you write, the suggested follow-ups send with one tap, and a short tour helps the first time you open a document, app or canvas. The “Manage context sources” panel and the home page’s suggestion row are gone: project cards stand there now.
  >
  > Where to find it: the ⋮ menu of a row in the panel list replays a tour.

- **altTextHu**: A kezdőlap szövegmezővel, a projektek kártyáival és a legutóbbi beszélgetésekkel. Telefonon egy beszélgetés, amelyben a válasz alatt két javasolt folytatás látszik.
- **altTextEn**: The home page with the composer, the project cards and the recent chats. On a phone, a chat in which two suggested follow-ups show under the reply.
- **Button**: none
- **Pictures**: `slides/10-small-desktop.png` (1600x1000) and `slides/10-small-mobile.png` (1080x1920)
- **Covers** (inventory rows): K1, K2 (reply language, follow-ups), I4, I5 (the first-open tours and their replay), M1, M2 (what was removed)


## What the first draft missed

The first draft's five slides (Projects, Artifacts, Keep/Undo, History, Privacy) named the right themes and missed most of
what a person would do with them. Against the inventory:

| Missed | Inventory rows | Now |
|---|---|---|
| The project page, the home project cards, how to reach them | A1 to A3, M3 | slide 6 |
| Personal instructions, `/instruction`, Alfy's offer to remember a preference, the info popover | A5 to A8 | slide 7 |
| The project Files window (add from the library, upload) and what the chats made | A9, A10 | slide 6 |
| What a Document is: tabs, tables, checklists, PDF/Word/Markdown, "Megnyitás dokumentumként" | B1 to B8 | slide 1 |
| What an App is: sandbox, fact check, "Módosítás…", .html | C1 to C7 | slide 2 |
| What a Canvas is: block kinds, drawing, Alfy arranging, several blocks, PNG | D1 to D12 | slide 3 |
| The Knowledge base's Documents tab, kind filters, search, delete and regenerate | I1 to I3, B9, E1 | slide 8 |
| The first-open tours and their replay | I4, I5 | slide 10 |
| Reply language, follow-ups at rest, the two removals (Kontextusforrások kezelése, the home suggestions) | K1, K2, M1, M2 | slide 10 |
| **Where to find anything** | every row's "Where" column | the last line of every slide |

Left out of the deck on purpose, and where they live instead (the inventory has the rows):

- **Admin-only** (group N): the Parallel allowance and its meter, the tour editor in Kampányok, the decimal admin fields,
  the `ORIGIN` setting. A user card is the wrong place for them; they belong in the release notes and the CHANGELOG
  (which has no 2.2 entry yet; the inventory is the source for one).
- **Polish a person feels without reading about** (groups L, F3 to F8, K3 to K10, E2 to E4, J3 to J5, J8 to J10): the
  panel's one motion language, Back closing the top layer, phone sizes and no keyboard chords on touch, focus traps,
  downloads that arrive, the chat opening at the latest message, cleaner titles, a data export that holds the new data.
- **Detail inside a kind** (B5 to B12, D6 to D9, D11 to D13, G8, A11 to A14): the status chips, the offline-safe editor,
  the minimap, the live-web block, the info popover's file count, what clearing memory keeps. They sit under the headline
  of their slide and are in the inventory with their paths.
- **Shipped before 2.2 and never announced** (inventory appendix P): session expiry, incognito chosen once, 73 file types,
  page citations. The unpublished 2.1 draft is about them.

## Fact checks

What each slide claims, and where it was checked. Every quoted label is a dictionary value, and
`scripts/create-release-campaign.test.ts` fails when a quoted label stops matching its dictionary key (so a copy edit of
the UI sends someone here).

| Slide | Labels quoted (key) | Behaviour behind the claim |
|---|---|---|
| 1 | „Megnyitás dokumentumként" (`chat.artifacts.keepAsDocument`) | Panel beside the chat, a sheet on a phone (`AGENTS.md`, Artifacts); tabs `artifacts.document.tab.*`; PDF/Word/Markdown `artifacts.document.export.*`; the count button is `artifact-count-button` (its label `artifacts.header.buttonA11y`); any finished reply may be kept as a Document (`MessageBubble.svelte`, `canKeepAsDocument`) |
| 2 | „Módosítás…" (`artifacts.app.action.regenerate`), „Alkalmazás" (`artifacts.type.app`) | The fact check and its verdict row (`artifacts.app.verify.*`); the sandbox bar says no internet and that it keeps your data (`artifacts.app.sandboxBar`); a download as .html (`artifacts.app.action.download`) |
| 3 | „Beszúrás" (`artifacts.canvas.insert`), „Alfy megkérdezése" (`artifacts.canvas.ask`) | Eleven block kinds (`block-meta.ts`); drawing tools `artifacts.canvas.tool.*`; Alfy builds and arranges boards through `create_artifact`/`edit_artifact` (rulings 62 to 67); several blocks together (OW-2); PNG export `artifacts.canvas.export.png` |
| 4 | „Megtartom" / „Visszavonom" (`artifacts.document.change.keep`/`undo`), „Megjegyzés" (`artifacts.document.comment.add`), „Alfy megkérdezése" (`artifacts.document.comment.ask`) | A board's change is one pending change with the same two choices (ruling 63); Alfy never overwrites what the reader changed after it read (ruling 67, `artifacts.document.refused.*`); `@Alfy` in a comment answers and edits (ruling 11) |
| 5 | (the header pill's own text, `artifacts.history.phrase.*`) | History is a mode of the panel (ruling 76): day groups, naming, the preview, Restore; it exists for Documents, Apps and Canvases (`artifacts.history.app.*`, `artifacts.history.canvas.*`) |
| 6 | „Fájlok" (`projects.filesTitle`), „Projektek" (`home.projectsHeading`) | The project page is `/projects/[projectId]`; the sidebar row's button now opens it (`ProjectItem.svelte`); the Files window lists the bundle, `listProjectBundle` (ruling 73) |
| 7 | „Profil és beállítások" (`sidebar.settings`), „Profil" (`settingsProfile`), „Az asszisztens viselkedése" (`profileTab.assistantTitle`) | Personal instructions are the first row of that card (`SettingsProfileTab.svelte`); `/instruction` is a composer command (`composerCommands.instruction.*`); Alfy's offer is the `suggest_instruction` tool, never in an incognito chat; the project outranks the person (Feature 1 spec, decision 1) |
| 8 | „Tudásbázis" (`sidebar.knowledgeBase`), „Dokumentumok" (`knowledge.documents`) | The Documents tab is the default now (friction audit F23); kind chips `knowledge.documents.filter.*`; search finds documents, apps and boards (`SearchModal.svelte`); Regenerate re-creates a deleted Document or App from the chat (`artifacts.deleted.*`, `recreate.ts`) |
| 9 | (no label) | ADR-0068, decisions 3 and 5: a reply shows only pictures its own tools returned (any other becomes a link chip, `messageBubble.imageNotLoaded`), and `fetch_url` takes an address only from the user's own messages or a tool's result. The slide promises pages and pictures only, and the App sandbox line is the app's own (`artifacts.app.sandboxBar`). ADR-0068 names the leaks that remain (which address, DNS from inside an App, files opened outside the app); the slide never says "nothing leaves". |
| 10 | (the removed labels exist only in production) | Follow-up chips are the person's next message and show at rest (`follow-up-chip.ts`, ruling 77 F17); the reply follows the person's language (ruling 75); the three tours and their replay `artifacts.tour.*`; `contextSources.manage` and `home.suggest*` were deleted (Feature 1, slices A and G) |

## Onboarding update (a proposal; nothing is published)

What a brand-new user sees, and what they would miss, is in the inventory ("Step 2"). The finding in one line: the
repository holds only the first-run onboarding *template* (setup, "Bring your ChatGPT history", a placeholder feature
slide, the data disclosure); the onboarding on production lives in the production database, was published before 2.2, and so
cannot mention a single 2.2 feature. A new user then meets this release card on a later load, and the first-open tours the
first time they open a Document, an App or a Canvas.

Proposal: keep the onboarding short, replace the placeholder feature slide ("Introduce a released feature") with the first
of these two standard slides and add the second before the data-disclosure slide. They are written to be edited in
Kampányok (Settings, Administration) on the draft the "Első indítás magkampány" button makes; the pictures are the deck's:
`deck/slides/01-document-*.png` for the first and `deck/slides/06-projects-*.png` for the second (16:10 and 9:16 already).

1. **Alfy nemcsak válaszol, készít is** / *Alfy answers, and makes things too*
   - HU: Kérd meg Alfyt, hogy írjon dokumentumot, építsen kis alkalmazást, vagy tegyen ötleteket egy táblára. A beszélgetés mellett nyílnak meg, ott szerkesztheted őket, és Alfy minden módosítását te hagyod jóvá.
     / Hol találod: a fejléc jobb oldali gombja mutatja, mi készült a beszélgetésben.
   - EN: Ask Alfy to write a document, build a small app, or put ideas on a board. They open beside the chat, where you can edit them, and you approve every change Alfy makes.
     / Where to find it: the button at the right of the chat header shows what the chat made.
2. **Projektek és utasítások** / *Projects and instructions*
   - HU: Egy projekt egyben tartja a csevegéseidet, a fájljaidat és az utasításaidat. Amit Alfynak mindig tudnia kell, azt egyszer írd le, és minden csevegésben érvényes lesz.
     / Hol találod: oldalsáv › Projektek, és Profil és beállítások › Profil › Az asszisztens viselkedése.
   - EN: A project keeps your chats, files and instructions together. What Alfy should always know, write once, and it applies in every chat.
     / Where to find it: sidebar › Projects, and Profile & Settings › Profile › Assistant behaviour.

If the owner would rather leave the onboarding alone, nothing is lost but one page load: the 2.2 card is the new user's tour,
shown the load after the onboarding. Making a new user skip a release card that describes things they never lacked is a code
change (a creation-date check in `getEligibleCampaignForUser`), not a content one, and is outside this brief.

## The pictures

- **What they show.** One invented sample, the same family trip as in the first draft but larger: Anna Kovács, a project
  "Balatoni nyaralás" with instructions (310 of 2000 characters) and three files, personal instructions, a chat that made a
  Document with two tabs (a comparison table and a checklist), a plan Document with a followable history (a named version, a
  change Alfy made that the reader kept, a change still waiting for Keep or Undo, a margin comment that asks @Alfy), a board
  (three day frames with notes, a checklist, a chart, and a ring, an arrow and a word drawn by hand), an App that Alfy
  checked, a produced CSV file, a reply whose pictures were not loaded, and a reply with two follow-ups. No real person,
  address, file or conversation; every web address is on `.example`.
- **How they were made.** `scripts/seed-campaign-2-2.ts` writes the sample through the app's own services (the artifacts
  facade, projects, the knowledge upload intake), never as hand-built rows, on a scratch database.
  `scripts/campaign-shots-2-2.ts` drives a local **production build** with Playwright: light theme, nothing drawn on top.
  A desktop picture is a 16:10 region of a 1440-wide window, drawn at the device scale that makes it 1600 pixels wide
  (so nothing is resized afterwards); a phone picture is a 432x768 window at scale 2.5 (1080x1920).
  `scripts/campaign-deck-pictures-2-2.ts` reduces them to 256 colours (`magick in.png -strip -colors 256 -dither None
  -define png:compression-level=9 out.png`, which halves them and is not visible; a deck is 1.3 MB).
- **Tight crops, on purpose.** The card draws a desktop picture at most 520 pixels wide, so a whole 1440 window is a
  thumbnail. Each picture is the part of the screen the slide is about, drawn 1.4 to 2.5 times larger than on screen: the
  panel of a Document with its header icons, the App's status row, the board with its toolbar, the pill and the comment
  thread, the History list, the Files window, the Instructions window, the Knowledge table, the reply with its link chips,
  the home page. The crop of every slide is in `SCENES` in `campaign-shots-2-2.ts`.
  | Slide | Desktop window | Region (CSS px) | Scale |
  |---|---|---|---|
  | 1 Document | 1440x900 | x 496, y 0, 944x590 | 1.70 |
  | 2 App | 1440x900 | x 496, y 0, 944x590 | 1.70 |
  | 3 Canvas | 1440x592 (so the toolbar is in) | x 496, y 0, 944x590 | 1.70 |
  | 4 Together | 1440x830 | x 504, y 245, 936x585 | 1.71 |
  | 5 History | 1440x900 | x 494, y 50, 944x590 | 1.70 |
  | 6 Projects | 1440x900 | x 355, y 88, 720x450 | 2.22 |
  | 7 Instructions | 1440x900 | x 380, y 235, 688x430 | 2.33 |
  | 8 Knowledge | 1440x900 | x 180, y 12, 1120x700 | 1.43 |
  | 9 Privacy | 1440x640 | x 390, y 50, 640x400 | 2.50 |
  | 10 Small changes | 1440x900 | x 340, y 200, 800x500 | 2.00 |
- **A phone is a large one** (432 CSS pixels wide, as a Pixel Pro or an iPhone Pro Max is), because 9:16 at exactly 2.5x
  needs it and because on the home page a 360-wide phone shows a defect (see "For the owner"). The phone pictures are the
  same scenes as the desktop ones except slide 1 (the Teendők tab, a checklist, fits a phone better than a four-column
  table), slide 3 (the board zoomed in twice) and slide 10 (a chat with two follow-ups under its reply: on a phone that is
  the small thing that can be seen).
- **One set for both languages.** A campaign slide has one desktop and one phone picture for both languages (the schema has
  no per-language image), so `deck/` holds the Hungarian-interface pictures and an English reader sees them with English
  words beside them. `deck-en/` is the same ten slides with the English interface around the same Hungarian sample, for the
  case that the owner prefers it. The sample content (the project, the chats, the Document) is Hungarian in both.
- **Time.** The sample's days are told in a fixed-offset zone chosen so that "today" is mid-afternoon whenever the seed
  runs, and nothing lies in the future; the screenshot browser uses the same zone. The relative times in the pictures
  ("19 órája") are those of the day they were taken.

## Previews for the owner

`docs/plans/campaign-2.2/preview/`:

- `cards-hu-desktop.png`, `cards-en-desktop.png`: the ten cards as a reader's modal draws them on a desktop, four to a row.
- `cards-hu-phone.png`, `cards-en-phone.png`: the same on a 390x844 phone, five to a row (every body fits whole).
- `admin-hu.png`, `admin-en.png`: the admin Campaigns pane with the draft open in the language shown (the checklist reads
  "12 / 12 ellenőrzés rendben · Publikálásra kész", ready to publish).

The cards were rendered by loading the app with the draft in place of the reader's campaign (the browser's answer to
`/api/campaigns/eligible` was replaced by the draft's admin payload), so they are the real modal at its real size and
nothing was published or written. They were made by `scripts/campaign-previews-2-2.ts`.

## The commands

Run from the release directory, where `data` is the symlink to `shared/data`; the script refuses to run anywhere else.
The deck ships inside the release (`scripts/deploy.sh` is a `git archive`), so there is no copy step. `<admin-email>` is an
existing admin account; it becomes the author. **None of these was run.**

Staging first (a dry run writes nothing):

```bash
cd /home/alfydesign/apps/langflow-chat-dev/current
set -a; . .env; set +a
npx tsx scripts/create-release-campaign.ts \
  --deck docs/plans/campaign-2.2/deck \
  --name "AlfyAI 2.2" --version 2.2.0 \
  --admin-email <admin-email> --dry-run
```

Drop `--dry-run` to create the draft, and review it at Settings, Administration, Campaigns. If the first draft's campaign
("AlfyAI 2.2", 2.2.0) is already a draft on that server, the script refuses and says so; add `--replace-draft` (it replaces a
draft only, never a published campaign). Production, once staging looks right:

```bash
cd /home/alfydesign/apps/langflow-chat/current
set -a; . .env; set +a
npx tsx scripts/create-release-campaign.ts \
  --deck docs/plans/campaign-2.2/deck \
  --name "AlfyAI 2.2" --version 2.2.0 \
  --admin-email <admin-email>
```

That creates a **draft**. Publish it from the Campaigns pane, or add `--publish` to run the same validation from the command
line. There is no undo for a publish (a published campaign can only be archived), so publish after the 2.2 build is live and
on the owner's word. To change a draft, edit `slides.json` or the pictures and run it again with `--replace-draft`. For
English-interface pictures use `--deck docs/plans/campaign-2.2/deck-en`. `deploy/README.md` has the general notes (what it
will and will not do, exit codes, the badge caveat when `APP_VERSION_OVERRIDE` is set).

## Taking the pictures again

After a UI change, from the repository root, with Node 22:

```bash
rm -f data/campaign-2-2.db data/campaign-2-2.db-shm data/campaign-2-2.db-wal
export DATABASE_PATH=$PWD/data/campaign-2-2.db
npm run db:prepare && npx tsx scripts/seed-campaign-2-2.ts      # also writes data/campaign-2-2-manifest.json
npm run build
PORT=5581 HOST=127.0.0.1 ORIGIN=http://127.0.0.1:5581 SESSION_SECRET=<32 or more characters> \
  HOME_SUMMARY_CACHE_TTL_MS=0 PLAYWRIGHT_TEST=1 node -r dotenv/config build/index.js &
CAMPAIGN_OUT_DIR=./data/campaign-2-2-shots npx tsx scripts/campaign-shots-2-2.ts      # hu and en; add hu or en, --only 3
CAMPAIGN_OUT_DIR=./data/campaign-2-2-shots npx tsx scripts/campaign-deck-pictures-2-2.ts   # into deck/ and deck-en/
# the previews, from a draft made on the same scratch database
npx tsx scripts/create-release-campaign.ts --deck docs/plans/campaign-2.2/deck --name "AlfyAI 2.2" --version 2.2.0 \
  --admin-email anna@campaign.local --replace-draft
CAMPAIGN_OUT_DIR=./data/campaign-2-2-previews npx tsx scripts/campaign-previews-2-2.ts   # then copy into preview/
```

`CAMPAIGN_PROBE=1` also saves each desktop scene as a whole window, for choosing a crop by eye. The sample user is a scratch
account on that scratch database; its sign-in is in the seed script.

## For the owner to decide

1. **Ten slides, or fewer?** Each slide is one idea and a card is read in about fifteen seconds, so the deck is two and a half
   minutes. The cut that costs least: merge 6 and 7 (Projects and Instructions) and drop 10 (the smaller changes), which
   leaves eight. Nothing else shares a picture.
2. **Pictures.** The Hungarian interface for everyone (the deck as it is), or the English one (`deck-en`)? Or English sample
   content too, which would be a second seed.
3. **The two buttons** (slide 7 "Beállítások megnyitása" to `/settings`, slide 8 "Tudásbázis megnyitása" to `/knowledge`).
   Delete the three `action*` keys of a slide in `slides.json` to drop its button.
4. **The first-run onboarding.** Add the two proposed slides to the onboarding draft, or leave it? (Nothing was read from
   production, so the wording of the existing onboarding is the owner's to check.)
5. **Slide 9's reach.** It promises pages and pictures only. Wording like "nothing leaves" is not true (ADR-0068 lists what
   remains), and the WebRTC guard is now in 2.2 but only measured in Chromium.
6. **The CHANGELOG** holds only the incognito items under `[Unreleased]`; 2.2 has no entry yet. That is not part of this
   brief, and the inventory is its source.
7. **Three things seen while taking the pictures, not fixed here** (all in the product, none in the campaign):
   - On a phone (360 to 432 px), the home project card's chips "Utasítások · 7 elem" run over the card's right border and the
     name is cut ("Balatoni nyar…") (`HomeProjects.svelte`). The campaign's phone picture for slide 10 is therefore not the
     home page.
   - On a 360 px phone, the artifact list cuts a long Document title to "Háromn…" when the row also carries the
     "1 módosítás vár rád" badge (the first draft saw it too; still there).
   - In the admin Campaigns preview the Hungarian "Következő" button is clipped at the card's right edge at 1440 px
     (`preview/admin-hu.png`); the reader's own card is not affected.
8. **Shipped but never announced** (inventory appendix P): session expiry, incognito chosen once, 73 file types, page
   citations. A slide, or a line on slide 10, if the owner wants them said.
