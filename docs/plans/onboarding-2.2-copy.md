# AlfyAI 2.2 welcome (the first-run onboarding): copy

**Status: a draft for the owner's review. Nothing is published, and nothing was run against any server.** The owner's
verdict on the welcome slides: "they need to be completely redone." This is the redo: ten slides for a person who has
never used AlfyAI, in Hungarian first with English beside it, each ending in a "Hol találod: …" line in the app's own
labels. It replaces the two slides that [`campaign-2.2-copy.md`](./campaign-2.2-copy.md) ("Onboarding update") only
proposed. The deck was checked by `scripts/create-release-campaign.ts --type onboarding` (a dry run, then a real draft in
a scratch database on this machine), by `scripts/create-release-campaign.test.ts` (which creates and publishes this very
deck into an in-memory database on every test run), and rendered in the app's own campaign card, in Hungarian and
English, on a phone and on a desktop.

What it is, in one paragraph: the 2.2 release card (ten slides, [`campaign-2.2-copy.md`](./campaign-2.2-copy.md)) says
what each new feature is. The welcome is the other half: what AlfyAI is, the first things to try, and a map of where
everything lives (the chat, the sidebar, what Alfy makes beside the chat with History, projects and instructions, the
Knowledge base, search, settings and memory, privacy). A person who signs up after 2.2 meets the welcome first and the
release card on a later load, so none of the welcome's words repeat the card's (a test holds that).

## Where everything is

| What | Where |
|---|---|
| This copy | `docs/plans/onboarding-2.2-copy.md` |
| The deck the campaign is created from (Hungarian-interface pictures) | `docs/plans/onboarding-2.2/deck/` (`slides.json`, `slides/*.png`) |
| The same words with English-interface pictures (an alternate) | `docs/plans/onboarding-2.2/deck-en/` |
| The reader's card as it renders: Hungarian and English, desktop and phone | `docs/plans/onboarding-2.2/preview/cards-*.png` |
| The admin Campaigns pane with the draft open, Hungarian and English | `docs/plans/onboarding-2.2/preview/admin-*.png` |
| The command that makes it | `scripts/create-release-campaign.ts --type onboarding` ([`deploy/README.md`](../../deploy/README.md), "A first-run onboarding") |
| The sample and the scripts that take the pictures and the previews | `scripts/seed-campaign-2-2.ts` then `scripts/seed-onboarding-2-2.ts`; `scripts/campaign-shots-onboarding-2-2.ts`; `scripts/campaign-previews-2-2.ts` |

## How a person meets it (checked in the code, and in a test)

`getEligibleCampaignForUser` (`announcement-campaigns.ts`) answers in this order: the latest published **first-run
onboarding** if the user has not finished that snapshot, else the latest published **release update** if the user has not
finished that one. There is no date check, and "finished" is per published snapshot. That has four consequences, and the
last test of the deck's describe in `create-release-campaign.test.ts` ("is shown once more to an account that finished the
last onboarding, before the release card") is the proof of the first two:

1. **A new onboarding revision reaches everybody who has not finished that revision, existing accounts included.** Each
   account sees the new welcome once, on its next load, before any release card. The owner will see it too. (ADR-0012
   says so on purpose: "including existing accounts".)
2. **A release card comes after it**, on the load after the welcome is finished or skipped, never in the same load.
3. **The sidebar badge replays the newest published announcement** (onboarding or release, never a tour). So publish the
   welcome **before** the release campaign if the badge should open the release.
4. **A first-open tour comes later still**, in the panel, the first time the person opens a Document, an App or a Canvas
   (never in an incognito chat). The welcome does not explain the tours and does not need to.

What production has now is not in the repository: the onboarding that is published there lives in the production
database, was written by the owner, and was **not read** (nothing was run against any server). The repository holds only
the template (`seedFirstRunOnboardingTemplate`: setup, "Bring your ChatGPT history", a placeholder feature slide, the
data disclosure). Whatever production says, it was published before 2.2 and cannot mention a single 2.2 feature. The new
deck is the next revision (`first_run_onboarding:v1:r<n>`); the old one stays "published" until it is archived, but the
newest published one is what a person is shown. The ChatGPT import, the template's own second slide, is slide 9 here.

## What the editor lets an onboarding be

Read from the code (`announcement-campaigns.ts`, `campaign-checklist.ts`, `CampaignModal.svelte`) and measured in the
reader's card:

- **No maximum number of slides.** What the publish validation wants of a first-run onboarding: exactly one setup slide
  (the one with the preference controls: interface language, theme, default model, AI style) and at least one standard
  slide that is the data disclosure; a title and a body in both languages on every slide; alt text in both when a slide
  has pictures; a button needs both labels and an allow-listed destination. The checklist in the admin pane reads
  13 / 13 for this deck (`preview/admin-hu.png`).
- **The body counter says 600 characters; the card is what bounds it.** Measured on a 390x844 phone
  (`scripts/campaign-previews-2-2.ts` reports every card that scrolls): slides 2 to 10 fit whole in both languages, with
  bodies up to 375 characters; a slide with a button needs a shorter body (slide 9 scrolled at 320 characters and fits at
  297). The test pins 380, 310 with a button, and 270 for the setup slide.
- **The setup slide scrolls whatever it says.** Its four controls stand under the words, so on a phone only the first
  (the language) is visible without scrolling, and on a 1440x900 window the card scrolls by a few lines (a laptop
  window is shorter still). The setup words are therefore kept to 266 characters.
- **The pictures are 16:10 (1600x1000) and 9:16 (1080x1920).** The card draws a desktop picture as wide as itself (up to
  640 CSS pixels) and a phone picture 190 pixels wide, so they are tight crops (see "The pictures").
- **A button goes only where the allow-list says**: `/`, `/chat`, `/knowledge`, `/settings`, `/settings/profile`,
  `/settings/admin` and `internal:chatgpt-import` (the last opens the import window over the card). This deck has one,
  on slide 9.
- **A body is plain text with its line breaks kept**; the "where to find it" line is a paragraph of its own, introduced
  by the same two words on every slide.
- **No keyboard chords.** The owner's copy rule (short, natural Hungarian that fits the row at 390 px, no chord on a touch
  screen): there is no "Ctrl K" or "⌘K" in the copy; the search is "Keresés" at the top of the sidebar, and the phone's
  way in is the menu button.

## The ten slides

Hungarian first. The titles and bodies are the exact strings in `slides.json`; every Hungarian label quoted is the app's
own (see "Fact checks"). "Covers" is the owner's list ("chat, projects and instructions, Documents/Apps/boards beside the
chat with History, Knowledge, search, settings and memory, privacy") and, where one exists, the rows of
[`campaign-2.2-inventory.md`](./campaign-2.2-inventory.md).

### Slide 1: Üdv az AlfyAI-ban

- **titleHu**: Üdv az AlfyAI-ban
- **titleEn**: Welcome to AlfyAI
- **bodyHu**:

  > Az AlfyAI a személyes AI-asszisztensed, a neve Alfy: kérdezhetsz tőle, és együtt készíthettek dokumentumot, alkalmazást vagy táblát. Állítsd be az alapokat (bármikor átállíthatod), a többit pár dia mutatja.
  >
  > Hol találod: Profil és beállítások › Profil › Beállítások.

- **bodyEn**:

  > AlfyAI is your personal AI assistant, called Alfy: ask it things, and make documents, apps or canvases together. Set the basics (you can change them any time); the next few screens show the rest.
  >
  > Where to find it: Profile & Settings › Profile › Preferences.

- **altTextHu**: Egy újonnan regisztrált felhasználó kezdőlapja: köszöntés a nevével, alatta az üres szövegmező a + és a gemkapocs gombbal. Telefonon ugyanez a kezdőlap.
- **altTextEn**: The home page of someone who has just signed up: a greeting with their name, and under it the empty message box with its plus and paperclip buttons. On a phone, the same home page.
- **Layout**: setup: the four preference controls (interface language, theme, default model, AI style) are drawn under the words
- **Button**: none
- **Pictures**: `slides/01-welcome-desktop.png` and `slides/01-welcome-mobile.png` (1600x1000 and 1080x1920). Desktop: The home page of Bence, who has just signed up: the greeting with his name and the empty message box. (Bence's account.) Phone: The same home page on a phone.
- **Covers**: Setup slide (ADR-0012); what AlfyAI is and what Alfy is called.

### Slide 2: Így igazodsz el

- **titleHu**: Így igazodsz el
- **titleEn**: Finding your way around
- **bodyHu**:

  > Az oldalsávban van a Keresés, az új beszélgetés gombja, a Tudásbázis, a projektjeid és a korábbi beszélgetéseid; alul a neved nyitja a beállításokat. A kezdőlap a legutóbbi beszélgetéseidet és projektjeidet is megmutatja.
  >
  > Hol találod: a bal szélen az oldalsáv (ha csak ikonokat látsz, kattints a logóra); telefonon a bal felső menügomb.

- **bodyEn**:

  > The sidebar holds Search, the new-chat button, the Knowledge base, your projects and your earlier chats; at the bottom, your name opens the settings. The home page also lists your latest chats and projects.
  >
  > Where to find it: the sidebar on the left (click the logo if you only see icons); on a phone, the menu button at the top left.

- **altTextHu**: Az oldalsáv: a Keresés mező, mellette az új beszélgetés és a Tudásbázis gombja, majd a Rögzítve, a Projektek és a Beszélgetések szakasz. Telefonon ugyanez az oldalsáv kicsúszó panelként.
- **altTextEn**: The sidebar: the Search box with the buttons for a new chat and the Knowledge base beside it, then the Pinned, Projects and Chats sections. On a phone, the same sidebar slides in as a drawer.
- **Layout**: standard
- **Button**: none
- **Pictures**: `slides/02-map-desktop.png` and `slides/02-map-mobile.png` (1600x1000 and 1080x1920). Desktop: The expanded sidebar: Search, the new-chat and Knowledge base buttons, Pinned, Projects, Chats. (Anna's account.) Phone: The same sidebar as the phone's drawer.
- **Covers**: The map: the sidebar, the rail, the phone's menu button, the home page's lists (A3, I3).

### Slide 3: Kezdd egy kérdéssel

- **titleHu**: Kezdd egy kérdéssel
- **titleEn**: Start with a question
- **bodyHu**:

  > Írj a szövegmezőbe bármit: kérdést, feladatot, egy félkész gondolatot. Ha friss tudás kell, Alfy utánanéz a weben, és megmutatja a forrásait. Csatolhatsz fájlt is, és kérdezhetsz róla. A válasz alatti két javaslat egy koppintással elküldhető.
  >
  > Hol találod: a kezdőlapon a szövegmező; a „+” gombbal a modellt, a stílust és a gondolkodást állítod.

- **bodyEn**:

  > Type anything in the box: a question, a task, a half-formed thought. When it needs fresh facts, Alfy looks on the web and shows its sources. Attach a file and ask about it. Tap one of the two suggestions under a reply to send it.
  >
  > Where to find it: the box on the home page; the “+” button holds the model, the style and thinking.

- **altTextHu**: A szövegmező melletti + menü: Fájl csatolása, Képességek, Atlas jelentés, a Gondolkodás kapcsolója, valamint a Modell és a Stílus választó. Telefonon alulról kicsúszó lapként.
- **altTextEn**: The plus menu beside the message box: Attach file, Skills, Atlas report, the Thinking switch, and the Model and Style pickers. On a phone it rises from the bottom as a sheet.
- **Layout**: standard
- **Button**: none
- **Pictures**: `slides/03-ask-desktop.png` and `slides/03-ask-mobile.png` (1600x1000 and 1080x1920). Desktop: The "+" menu open over the message box: attach a file, Skills, Atlas report, the Thinking switch, Model, Style. (Bence's account.) Phone: The same menu as the phone's bottom sheet.
- **Covers**: The first things to try: ask, attach, the follow-up chips (K2), the composer's own menu.

### Slide 4: Alfy nemcsak válaszol, készít is

- **titleHu**: Alfy nemcsak válaszol, készít is
- **titleEn**: Alfy answers, and makes things too
- **bodyHu**:

  > Ha leírod, mi kell, Alfy dokumentumot ír, kis alkalmazást épít, vagy táblára rendezi az ötleteidet. Ezek a beszélgetés mellett jelennek meg: ott szerkesztheted és letöltheted őket, és megmaradnak.
  >
  > Hol találod: a beszélgetés fejlécének jobb oldali gombja felsorolja, mit készített a beszélgetés.

- **bodyEn**:

  > Tell Alfy what you are after, and it writes a document, builds a small app, or lays your ideas out on a canvas. They appear beside the chat, where you can edit and download them, and they stay.
  >
  > Where to find it: the button at the right of the chat header lists everything the chat made.

- **altTextHu**: Az „Amit ez a beszélgetés készített” lista: egy dokumentum, egy fájl, egy alkalmazás és egy tábla, a fejléc gombjával megnyitva. Telefonon a beszélgetés, amelyben Alfy egy dokumentumot készített, a kártyájával.
- **altTextEn**: The “What this chat made” list: a document, a file, an app and a canvas, opened from the header button. On a phone, a chat in which Alfy made a document, with its card.
- **Layout**: standard
- **Button**: none
- **Pictures**: `slides/04-makes-desktop.png` and `slides/04-makes-mobile.png` (1600x1000 and 1080x1920). Desktop: "What this chat made": a Document, a File, an App and a Canvas, in the panel list. (Anna's trip chat.) Phone: A chat in which Alfy made a Document, with its card in the reply and the header button. (Anna's weekly-menu chat.)
- **Covers**: Owner's list: Documents, Apps and boards beside the chat. B1, C1, D1, F1, F2, F6.

### Slide 5: Semmi sem vész el

- **titleHu**: Semmi sem vész el
- **titleEn**: Nothing gets lost
- **bodyHu**:

  > Amit Alfy átír, azt jelölve látod, és te döntesz: „Megtartom” vagy „Visszavonom”. Amit közben te módosítottál, ahhoz nem nyúl. Az Előzményekben napok szerint rendezve találod a változatokat: elnevezheted, megnézheted és visszaállíthatod őket.
  >
  > Hol találod: a panel fejlécében a legutóbbi változást mutató gomb nyitja az Előzményeket.

- **bodyEn**:

  > What Alfy rewrites is marked, and you decide: “Keep” or “Undo”. What you changed yourself, Alfy leaves alone. History keeps every version, listed by day: you can name one, look at it, or bring it back.
  >
  > Where to find it: the button in the panel header that shows the latest change opens History.

- **altTextHu**: Egy dokumentum Előzményei: napokra bontott lista Alfy még rád váró javaslatával, egy megtartott módosításával, a te elnevezett szerkesztéseddel és az első vázlattal; mellette egy változat előnézete a Visszaállítás gombbal. Telefonon az Előzmények lap.
- **altTextEn**: A document’s History: a list by day with Alfy’s suggestion that still waits for you, a change you kept, your own named edit and the first draft; beside it a preview of one version with the Restore button. On a phone, the History sheet.
- **Layout**: standard
- **Button**: none
- **Pictures**: `slides/05-history-desktop.png` and `slides/05-history-mobile.png` (1600x1000 and 1080x1920). Desktop: A Document's History: Alfy's suggestion that still waits ("Rád vár"), a change Anna kept ("Megtartva"), her own named edit ("Mielőtt bevásárolok", "Szerkesztetted"), the first draft, and the older version's preview with Restore. (Anna's weekly menu.) Phone: The History sheet of the same Document.
- **Covers**: Owner's list: History. G1, G2, H1 to H3, H5, H6.

### Slide 6: Projektek és utasítások

- **titleHu**: Projektek és utasítások
- **titleEn**: Projects and instructions
- **bodyHu**:

  > A projektben egy téma csevegései, fájljai és utasításai egy helyre kerülnek, és minden új csevegés rögtön ismeri a témát. Amit Alfynak mindig tudnia kell rólad vagy a munkádról, írd le egyszer, és minden csevegésben érvényes lesz.
  >
  > Hol találod: oldalsáv › Projektek; Profil és beállítások › Profil › Az asszisztens viselkedése.

- **bodyEn**:

  > In a project, one subject’s chats, files and instructions live together, and every new chat knows the subject from its first message. What Alfy should always know about you or your work, write once, and it applies in every chat.
  >
  > Where to find it: sidebar › Projects; Profile & Settings › Profile › Assistant behaviour.

- **altTextHu**: A Balatoni nyaralás projekt oldala: a projekt neve, a szövegmező, alatta az Utasítások és a fájlok száma, majd a projekt négy csevegése. Telefonon ugyanez az oldal.
- **altTextEn**: The page of the Balatoni nyaralás project: its name, the message box, under it the Instructions and the number of files, then the project’s four chats. On a phone, the same page.
- **Layout**: standard
- **Button**: none
- **Pictures**: `slides/06-projects-desktop.png` and `slides/06-projects-mobile.png` (1600x1000 and 1080x1920). Desktop: The project page: the project's name, the message box, "Utasítások · 7 elem", the project's four chats. (Anna's Balaton project.) Phone: The same page on a phone.
- **Covers**: Owner's list: projects and instructions. A1 to A5, A9.

### Slide 7: Tudásbázis és keresés

- **titleHu**: Tudásbázis és keresés
- **titleEn**: Knowledge base and search
- **bodyHu**:

  > Amit feltöltesz, és amit Alfy készít, a Tudásbázisban találod meg: egy listában, típus szerint szűrheted. Ha nem jut eszedbe, hol volt valami, a Keresés a beszélgetéseid és a dokumentumaid szövegében is megtalálja.
  >
  > Hol találod: oldalsáv › Tudásbázis › Dokumentumok; a keresés az oldalsáv tetején.

- **bodyEn**:

  > What you upload and what Alfy makes is in the Knowledge base: one list you can filter by type. If you cannot remember where something was, Search finds it in the text of your chats and documents too.
  >
  > Where to find it: sidebar › Knowledge base › Documents; Search at the top of the sidebar.

- **altTextHu**: A Munkaterület keresése ablak a „szállás” szóra: a beszélgetések és a dokumentumok találatai kiemelt szavakkal, fent a típus szerinti szűrők. Telefonon ugyanez a keresőlap.
- **altTextEn**: The workspace search for the word “szállás”: hits in chats and in documents with the words highlighted, and the filters by type on top. On a phone, the same search sheet.
- **Layout**: standard
- **Button**: none
- **Pictures**: `slides/07-search-desktop.png` and `slides/07-search-mobile.png` (1600x1000 and 1080x1920). Desktop: The workspace search for "szállás": chats and documents, the words highlighted, the filters by type. (Anna's account.) Phone: The same search as a phone sheet.
- **Covers**: Owner's list: Knowledge and search. I1 to I3.

### Slide 8: Amit Alfy megjegyez, te irányítod

- **titleHu**: Amit Alfy megjegyez, te irányítod
- **titleEn**: What Alfy remembers is up to you
- **bodyHu**:

  > Alfy a beszélgetéseken át megjegyzi, ami fontos rólad. A Memóriaprofilban elolvashatod és javíthatod, a Beállításokban ki is kapcsolhatod. Ha egy beszélgetésből nem szeretnéd, hogy tanuljon, indítsd inkognitóban.
  >
  > Hol találod: Tudásbázis › Memóriaprofil; inkognitó: a kezdőlap jobb felső sarkában a maszk.

- **bodyEn**:

  > Across your chats Alfy remembers what matters about you. Read and correct it in the Memory Profile, or switch memory off in Settings. For a chat Alfy should not learn from, start it in incognito.
  >
  > Where to find it: Knowledge base › Memory Profile; incognito: the mask at the top right of the home page.

- **altTextHu**: A Memóriaprofil: az „Amit rólad megjegyeztem” összefoglaló, a kategóriák szerinti szűrők és a megjegyzett tények, mindegyiken Szerkesztés és Törlés gombbal. Telefonon ugyanez az oldal.
- **altTextEn**: The Memory Profile: the “What I remember about you” summary, the filters by category and the remembered facts, each with Edit and Delete buttons. On a phone, the same page.
- **Layout**: standard
- **Button**: none
- **Pictures**: `slides/08-memory-desktop.png` and `slides/08-memory-mobile.png` (1600x1000 and 1080x1920). Desktop: The Memory Profile: the summary Alfy reads, the filters by category, the first fact with Edit and Delete. (Anna's account.) Phone: The same page on a phone.
- **Covers**: Owner's list: settings and memory, and the incognito switch in the privacy part. Appendix P (incognito chosen once).

### Slide 9: Hozd át, amid van

- **titleHu**: Hozd át, amid van
- **titleEn**: Bring what you already have
- **bodyHu**:

  > Hozd át a régi ChatGPT-beszélgetéseidet, és folytasd ott, ahol abbahagytad. A naptáradat, leveleidet, fényképeidet és fájljaidat is összekötheted Alfyval: olvasni mindet tud, írni csak az engedélyeddel.
  >
  > Hol találod: Profil és beállítások › Kapcsolatok; importálás: Profil › Adatok és adatvédelem.

- **bodyEn**:

  > Bring your old ChatGPT conversations over and carry on where you left off. Connect your calendar, email, photos and files too: Alfy can read them all, and write only if you allow it.
  >
  > Where to find it: Profile & Settings › Connections; import: Profile › Data & privacy.

- **altTextHu**: A Beállítások Kapcsolatok oldala: a Kapcsolat hozzáadása lista a Nextcloud, Immich, Email, Google, Apple iCloud, Plex, OwnTracks, GitHub, OneDrive és CalDAV szolgáltatással. Telefonon ugyanez az oldal.
- **altTextEn**: The Connections page of the settings: the Add a connection list with Nextcloud, Immich, Email, Google, Apple iCloud, Plex, OwnTracks, GitHub, OneDrive and CalDAV. On a phone, the same page.
- **Layout**: standard
- **Button**: Importálás ChatGPT-ből / Import from ChatGPT, goes to `internal:chatgpt-import` (the ChatGPT import window opens over the card)
- **Pictures**: `slides/09-bring-desktop.png` and `slides/09-bring-mobile.png` (1600x1000 and 1080x1920). Desktop: Settings, Connections: "Add a connection" with the ten services. (Bence's account.) Phone: The same page on a phone, scrolled to the list.
- **Covers**: Bring-over: the ChatGPT import (the first-run template's own slide) and the connections page.

### Slide 10: Mi történik az adataiddal

- **titleHu**: Mi történik az adataiddal
- **titleEn**: What happens to your data
- **bodyHu**:

  > Az AlfyAI nem teljesen helyi: amit írsz, feltöltesz, vagy Alfy a csatlakoztatott fiókjaidból kiolvas, az a választott modellhez kerül (a felhős modellnél a szolgáltatójához, annak feltételei szerint). A webes keresés a keresőkifejezést is kiküldi. A memóriát és a használati adatokat az AlfyAI tárolja. Nem adjuk el az adataidat.
  >
  > Hol találod: Profil › Adatok és adatvédelem.

- **bodyEn**:

  > AlfyAI is not fully local: what you write, upload, or what it reads from your connected accounts goes to the model you choose (with a cloud model, to its provider, under its own terms). A web search also sends out the search phrase. AlfyAI stores your memory and usage data. We do not sell your data.
  >
  > Where to find it: Profile › Data & privacy.

- **altTextHu**: A Beállítások Adatok és adatvédelem kártyája: az Adatvédelmi irányelvek, az Importálás ChatGPT-ből és az Adataim letöltése sor, mindegyik a saját gombjával. Telefonon ugyanez a kártya.
- **altTextEn**: The Data & privacy card of the settings: the Privacy policy, Import from ChatGPT and Download my data rows, each with its own button. On a phone, the same card.
- **Layout**: standard, role data_disclosure (the slide the service's publish validation asks for)
- **Button**: none
- **Pictures**: `slides/10-data-desktop.png` and `slides/10-data-mobile.png` (1600x1000 and 1080x1920). Desktop: Settings, the Skills and Memory profile rows and the Data & privacy card: the privacy policy, the ChatGPT import, Download my data. (Bence's account.) Phone: The Data & privacy card on a phone.
- **Covers**: Owner's list: privacy. ADR-0012's disclosure. J10.


## How it differs from the release card

Both are shown to a person who has just signed up, so they are written to be different jobs, not two copies of one:

| | The welcome (this) | The 2.2 release card |
|---|---|---|
| Question it answers | What is this, what do I do first, where is everything? | What can it do, in each part? |
| Shape | A map (slides 1, 2, 6, 7, 9, 10) and the first steps (3, 4, 5, 8) | One feature per slide, in depth (Document, App, Canvas, comments, History, projects, instructions, Knowledge, privacy) |
| Pictures | A new user's empty home page, the sidebar, the "+" menu, a weekly menu (the Document), the search, the memory, the settings | The trip plan, the cost app, the board, the Files window, the Instructions window |
| Shared topics | History, projects and instructions, the Knowledge base, privacy | the same, with the words and the pictures of the feature |

`create-release-campaign.test.ts` compares the first paragraph of every welcome slide with every release slide, in both
languages, and fails at a run of five shared words. The longest run today is three words in Hungarian ("írd le egyszer",
"megtartom vagy visszavonom", "megnézheted és visszaállíthatod") and four in English ("decide: Keep or Undo", the labels). The "where to find it" lines are
left out of the comparison on purpose: they name the same labels in the same places.

## Fact checks

What each slide claims, and where it was checked. Every quoted label is a dictionary value, and the test fails when a
quoted label stops matching its dictionary key (so a copy edit of the UI sends someone here).

| Slide | Labels quoted (key) | Behaviour behind the claim |
|---|---|---|
| 1 | Profil és beállítások (`sidebar.settings`), Profil (`settingsProfile`), Beállítások / Preferences (`settings_sectionPreferences`) | The setup slide draws language, theme, default model and AI style (`CampaignModal.svelte`); the Settings Profile tab's first right-hand card is "Beállítások" with the same four; the privacy policy calls AlfyAI "a personal AI assistant" (`legal.privacy.intro`) |
| 2 | Keresés (`sidebar.search`), Tudásbázis (`sidebar.knowledgeBase`) | A new browser starts with the sidebar as a 48 px icon rail at every window size from 1280 to 2560 (checked), and the logo opens it (`sidebar-logo`, "Oldalsáv kibontása"); on a phone the header's menu button opens the drawer; the bottom row opens the settings ("Beállítások megnyitása"); the home page lists project cards and recent chats (`HomeSurface.svelte`) |
| 3 | (the "+" glyph) | The "+" menu holds Fájl csatolása (100 MB), Képességek, Atlas jelentés, the Gondolkodás switch, Modell, Stílus (`composerMenu.*`); the follow-up chips are the person's next message and show at rest (`follow-up-chip.ts`, ruling 77 F17); web research shows its sources (`research_web`, the reply's Források); files are attached with the paperclip |
| 4 | (the header button's own label) | A request for a document, an app or a canvas makes one beside the chat (`create_artifact`); the header's count button exists **only in a chat that made something** (checked: absent in a chat that made nothing), which is why slide 2 does not promise it; the list is "Amit ez a beszélgetés készített" (`artifacts.panel.*`) |
| 5 | „Megtartom" / „Visszavonom" (`artifacts.document.change.keep`/`undo`), Előzmények (`artifacts.history.title`) | A change of Alfy's is marked and waits for Keep or Undo; Alfy leaves a part the reader changed after it last read alone (ruling 67, `block_changed`); History lists versions by day, names, previews and restores (`artifacts.history.*`); the header's latest-change pill opens it |
| 6 | Projektek (`sidebar.projects`), Az asszisztens viselkedése (`profileTab.assistantTitle`) | A project page keeps chats, files and instructions (ADR-0064); a chat in a project follows its instructions and reads its files; personal instructions are the first row of the Assistant behaviour card and apply in every chat |
| 7 | Tudásbázis, Dokumentumok (`knowledge.documents`), Keresés | The Documents tab lists uploaded files and Alfy's documents, apps and boards with filters by type (`knowledge.documents.filter.*`); the workspace search finds chats and documents by title and by text (`SearchModal.svelte`, the snippets) |
| 8 | Memóriaprofil / Memory Profile (`memory.title`) | The Memory Profile page shows the summary Alfy reads and the facts, each editable and deletable; the Memória switch in Settings pauses learning and keeps what is remembered (`profileTab.*`); incognito: "Ebből a beszélgetésből semmi nem marad meg, és nem is számít bele semmibe" (`chat.incognitoPopoverBody`), chosen with the mask at the top right of the home page before the chat exists |
| 9 | Kapcsolatok (`settingsConnections`), Adatok és adatvédelem (`settings_sectionDataPrivacy`), Importálás ChatGPT-ből (`chatgptImport.settingsButton`) | The Connections tab says "Csatlakoztasd a fiókjaidat, hogy az AlfyAI olvashassa őket, és ha engedélyezed, írhasson is beléjük", and lists Nextcloud, Immich, Email, Google, Apple iCloud, Plex, OwnTracks, GitHub, OneDrive, CalDAV; the campaign button is `internal:chatgpt-import`, which opens the import window (`handleCampaignInternalAction`) |
| 10 | Adatok és adatvédelem (`settings_sectionDataPrivacy`) | Written from the privacy policy (`legal.privacy.*`) and ADR-0012's disclosure: local models run on AlfyAI's own hardware, a cloud model's provider processes content under its own terms (`aiProcessing`), connected-account data read to answer goes to the model too (`connections`), a web search sends the search phrase out (`sharing`), memory and usage data are stored by AlfyAI, and "we never sell your data" |

## The pictures

- **What they show.** The sample is invented, in Hungarian, and written through the app's own services wherever one exists
  (the artifacts facade, the projects and conversation services, the memory projection store: the release sample's, plus
  `scripts/seed-onboarding-2-2.ts`); the chat messages, the e-mail addresses and the model's name are plain rows, as in the
  release sample. Two accounts, because a welcome is for two kinds of place: **Bence Szabó**, who has
  just signed up and is not an administrator (an empty home page, the Settings page a normal user has, with no
  Administration tab), and **Anna Kovács**, whose workspace has things in it (the Balaton project and its chats, a pinned
  weekly-menu chat, a trip Document, a board, an App, a CSV, a Memory profile of eight facts). Addresses are on
  `example.com`; web addresses in the release sample are on `.example`. No real person, address, file or conversation.
- **A Document with a history of its own.** The weekly menu (Anna's pinned chat) has Alfy's first draft, Anna's edit
  (named "Mielőtt bevásárolok"), a change of Alfy's that she kept and one that waits for her, so the History picture is
  not the trip plan the release card shows.
- **How they were made.** `scripts/campaign-shots-onboarding-2-2.ts` drives a local **production build** with Playwright:
  light theme, nothing drawn on top. A desktop picture is a 16:10 region of the window, drawn at the device scale that makes
  it 1600 pixels wide (so nothing is resized afterwards); a phone picture is a 432x768 window at scale 2.5 (1080x1920).
  With `--deck` the pictures are reduced to 256 colours (`magick in.png -strip -colors 256 -dither None
  -define png:compression-level=9 out.png`, which halves them and is not visible; a deck is about 1.5 MB) and put where
  `slides.json` names them.
- **Tight crops, on purpose.**

  | Slide | Account | Desktop window | Region (CSS px) | Scale |
  |---|---|---|---|---|
  | 1 Welcome | Bence | 1440x900 | x 350, y 215, 800x500 | 2.00 |
  | 2 Map | Anna | 1800x900 (so the home greeting stands outside the region) | x 0, y 0, 600x375 | 2.67 |
  | 3 Ask | Bence | 1440x900 | x 350, y 160, 640x400 | 2.50 |
  | 4 Makes | Anna | 1100x700 | x 412, y 0, 688x430 | 2.33 |
  | 5 History | Anna | 1440x900 | x 496, y 0, 944x590 | 1.69 |
  | 6 Projects | Anna | 1440x900 | x 350, y 240, 800x500 | 2.00 |
  | 7 Search | Anna | 1440x900 | x 340, y 135, 800x500 | 2.00 |
  | 8 Memory | Anna | 1440x900 | x 222, y 180, 720x450 | 2.22 |
  | 9 Bring | Bence | 928x580 (the page's tablet layout) | the whole window | 1.72 |
  | 10 Data | Bence | 1440x900 | x 520, 896x560, starting 215 px above the card's heading | 1.79 |

- **A phone is a large one** (432 CSS pixels wide, as a Pixel Pro or an iPhone Pro Max is), the release sample's choice:
  9:16 at exactly 2.5x needs it. The phone pictures are the same scenes as the desktop ones except slide 4 (a chat with
  the card in the reply, which shows the header button a phone has, instead of the panel list).
- **One set for both languages.** A campaign slide has one desktop and one phone picture for both languages (the schema has
  no per-language image), so `deck/` holds the Hungarian-interface pictures and an English reader sees them with English
  words beside them. `deck-en/` is the same ten slides with the English interface around the same Hungarian sample, for
  the case that the owner prefers it; the test insists the two decks say the very same words.
- **Placeholders, honestly named.** The scratch instance has one model, called "Alfy 1", set as the default
  (`DEFAULT_NEW_USER_MODEL`), so the "+" menu and the setup slide print a name and not an internal id. The "+" menu's
  Atlas row is drawn the way a configured server draws it, with `PARALLEL_API_KEY` set to a placeholder and
  `PARALLEL_BASE_URL` pointing at a closed local port: nothing leaves the machine and no picture starts an Atlas run. Both
  are what the pictures need and are not claims about the production instance's model list.
- **Time.** The sample's days are told in a fixed-offset zone chosen so that "today" is mid-afternoon whenever the seed runs,
  and nothing lies in the future; the screenshot browser uses the same zone. The relative times in the pictures
  ("4 órája", "19 órája") and the greeting (it is picked from the day and the time of day) are those of the day they were
  taken (2026-10-13).

## Previews for the owner

`docs/plans/onboarding-2.2/preview/`:

- `cards-hu-desktop.png`, `cards-en-desktop.png`: the ten cards as a reader's modal draws them on a desktop (1440x900), four
  to a row. The setup card scrolls a few lines at this height.
- `cards-hu-phone.png`, `cards-en-phone.png`: the same on a 390x844 phone, five to a row. Cards 2 to 10 fit whole; the setup
  card shows the first control and scrolls to the other three.
- `admin-hu.png`, `admin-en.png`: the admin Campaigns pane with the draft open in the language shown (the checklist reads
  "13 / 13 ellenőrzés rendben · Publikálásra kész", ready to publish; the pane's type chip says "Első indítás").

The cards were rendered by loading the app with the draft in place of the reader's campaign (the browser's answer to
`/api/campaigns/eligible` was replaced by the draft's admin payload), so they are the real modal at its real size and
nothing was published or written. They were made by `scripts/campaign-previews-2-2.ts`.

## The commands

Run from the release directory, where `data` is the symlink to `shared/data`; the script refuses to run anywhere else.
The deck ships inside the release (`scripts/deploy.sh` is a `git archive`), so there is no copy step. `<admin-email>` is an
existing admin account; it becomes the author. **None of these was run.**

Staging first (a dry run writes nothing; it prints the type, the slide count and the assets):

```bash
cd /home/alfydesign/apps/langflow-chat-dev/current
set -a; . .env; set +a
npx tsx scripts/create-release-campaign.ts \
  --type onboarding \
  --deck docs/plans/onboarding-2.2/deck \
  --name "AlfyAI 2.2 üdvözlő" \
  --admin-email <admin-email> --dry-run
```

Drop `--dry-run` to create the draft, and review it at Settings, Administration, Campaigns (the type chip reads "Első
indítás", the checklist 13 / 13; "Preview in shell" shows it as a reader would see it, to an admin only). If a draft of the
same name exists on that server, the script refuses and says so; add `--replace-draft` (it replaces a draft only, never a
published campaign). Production, once staging looks right:

```bash
cd /home/alfydesign/apps/langflow-chat/current
set -a; . .env; set +a
npx tsx scripts/create-release-campaign.ts \
  --type onboarding \
  --deck docs/plans/onboarding-2.2/deck \
  --name "AlfyAI 2.2 üdvözlő" \
  --admin-email <admin-email>
```

That creates a **draft**; nobody sees it. Publish it from the Campaigns pane, or add `--publish` to run the same validation
from the command line. There is no undo for a publish (a published campaign can only be archived). The order on release
day, which the script's own note repeats when it publishes an onboarding:

1. deploy 2.2, create both drafts (the welcome above, the release from `campaign-2.2-copy.md`) and look at them;
2. publish the **welcome first**, then the release card, so the sidebar badge replays the release;
3. every account sees the welcome once on its next load (existing ones included) and the release card on the load after;
4. archive the old onboarding in the pane when it is no longer wanted in the list (it is superseded either way).

For English-interface pictures use `--deck docs/plans/onboarding-2.2/deck-en`. Both `--version` and `--type onboarding`
together are refused: an onboarding has no release version, and the system names it `first_run_onboarding:v1:r<n>`.

## Taking the pictures again

After a UI change, from the repository root, with Node 22:

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
rm -f data/onboarding-2-2.db data/onboarding-2-2.db-shm data/onboarding-2-2.db-wal
export DATABASE_PATH=$PWD/data/onboarding-2-2.db
npm run db:prepare
npx tsx scripts/seed-campaign-2-2.ts && npx tsx scripts/seed-onboarding-2-2.ts   # writes data/campaign-onboarding-manifest.json
npm run build
PORT=5597 HOST=127.0.0.1 ORIGIN=http://127.0.0.1:5597 SESSION_SECRET=<32 or more characters> \
  HOME_SUMMARY_CACHE_TTL_MS=0 PLAYWRIGHT_TEST=1 \
  DEFAULT_NEW_USER_MODEL="$(node -p "require('./data/campaign-onboarding-manifest.json').defaultModel")" \
  PARALLEL_API_KEY=sample-not-a-key PARALLEL_BASE_URL=http://127.0.0.1:9 \
  node -r dotenv/config build/index.js &
CAMPAIGN_OUT_DIR=./data/onboarding-2-2-shots npx tsx scripts/campaign-shots-onboarding-2-2.ts hu en --deck   # add hu or en, --only 3
# the previews, from a draft made on the same scratch database
npx tsx scripts/create-release-campaign.ts --type onboarding --deck docs/plans/onboarding-2.2/deck \
  --name "AlfyAI 2.2 üdvözlő" --admin-email anna.kovacs@example.com --replace-draft
CAMPAIGN_OUT_DIR=./data/onboarding-2-2-previews CAMPAIGN_MANIFEST=./data/campaign-onboarding-manifest.json \
  CAMPAIGN_NAME="AlfyAI 2.2 üdvözlő" npx tsx scripts/campaign-previews-2-2.ts   # then copy into preview/
```

`--deck` needs `docs/plans/onboarding-2.2/deck/slides.json` first (the words come before the pictures). `CAMPAIGN_PROBE=1`
also saves each desktop scene as a whole window, for choosing a crop by eye. The sample users are scratch accounts on that
scratch database; their sign-ins are in the two seed scripts. A picture that waits on the page is tried a second time in a
fresh window before the run gives up.

## Checks that were run

- **The unit tests.** `scripts/create-release-campaign.test.ts` (47 tests): the script's argument rules (`--type`, no
  `--version` for an onboarding), the deck rules (one setup slide with its controls, a data disclosure, no onboarding keys
  in a release deck), creation, replace-a-draft and dry-run for an onboarding, and the welcome deck's own tests: its shape,
  the where-line and the lengths, every quoted label against the dictionaries, no run of five words shared with the release
  card, the English alternate, publishing through the service's validation, and that a new revision is shown once more to an
  account that finished the last one, before the release card.
- **The card in the real shell, with nothing published.** With the browser's answer to `/api/campaigns/eligible` replaced by
  the draft, a fresh account's shell opens the card on the setup slide; the language control switches the card to English
  and back (and writes the preference); slide 9's button opens the ChatGPT import window and the card is still there when it
  closes; the last slide has Finish and no Skip; the progress bar has ten segments. A real publish, even into the scratch
  database, was not made: the brief says to publish nothing.
- **The agent gate, once, at `f88df0c50`, with the campaign specs** (`scripts/gates.sh agent <out-dir> --port 5590
  --workers 4 tests/e2e/admin-users-campaigns.spec.ts tests/e2e/artifact-tours-admin.spec.ts`): all gates passed in
  3m28s. `npm run check`: 0 errors and 17 warnings, all in `RouteItinerary.svelte`, `ToolActivityRow.svelte` and
  `ThinkingBlock.svelte` and all on `dev` before this branch (none in a file the branch touches); biome clean; migrations
  ok; vitest 1094 files and 19012 tests passed; build ok (unused CSS 32 and aria 2, the baseline); the chunk check ok;
  Fallow no new finding against the baseline (circular dependencies 4, unchanged); Playwright 41 passed (the two campaign
  specs in full and the smoke tests of every other file). An earlier run at `5b0300f97` found two new Fallow findings
  (two exports of `create-release-campaign.ts` that only the script reads; they are private now) and a vitest run that
  passed all 19012 tests and then reported one worker-teardown error from `chatgpt-import/index.test.ts` (that file passes
  alone, 20 tests; the error did not come back).

## For the owner to decide

1. **Ten slides, or fewer?** A first visit is about two minutes at ten seconds a slide, and every slide has Skip. The cuts
   that cost least: slide 9 (the import also lives in Settings, and the connections page is one click from the sidebar)
   and slide 5 (the release card has History in depth). That leaves eight. Nothing else shares a picture.
2. **Pictures.** The Hungarian interface for everyone (`deck`), or the English one (`deck-en`)?
3. **The button on slide 9** ("Importálás ChatGPT-ből", the first-run template's own idea). Delete the three `action*`
   keys of that slide in `slides.json` to drop it.
4. **Everybody sees it once more.** A new onboarding revision shows the welcome to existing accounts too. That is how the
   service was designed (ADR-0012), and the owner can accept it, or ask for a rule that a revision reaches only accounts
   that never finished a first-run onboarding. That is a code change in `getEligibleCampaignForUser` and an amendment of the
   ADR, not a content one, and is outside this brief.
5. **The order of publishing.** The welcome before the release card (see "The commands"), so the badge opens the release.
6. **Slide 3's promise of web sources** is true wherever web search is configured (production has it). On an instance without
   Parallel search, the sources line and the "+" menu's Atlas row are not.
7. **Left out on purpose:** the Képességek (skills), Atlas reports, the composer's "/" commands, the "A tevékenységed" page,
   the first-open tours (they introduce themselves), the admin items. Any of them is a slide, or a clause on slide 3, if the
   owner wants it said.
8. **The sidebar is an icon rail for a new browser** at every window size (checked from 1280 to 2560), so a first-time user
   sees only icons. Slide 2 says how to open it ("kattints a logóra"). Starting it open for a brand-new account would be a
   product change, not a content one.

## Seen while taking the pictures

- **Fixed, in its own commit (`ComposerToolsMenu.svelte`):** the "+" menu's first heading, "Ez az üzenet", was drawn
  "EZ AZ UZENET". The title is uppercased and clipped for its ellipsis (`overflow: hidden`), and a line box of 1.2 leaves no
  room above a capital for the dots of an Ü. A Hungarian reader saw it the first time they opened the menu; the picture on
  slide 3 shows it. The fix is a padding inside the clip and a negative margin that gives the space back (the layout does
  not move). Other uppercase headings that clip the same way would lose an Ü, Ö, Ő or Ű; the ones in these pictures do not.
- **The setup card scrolls**, on a phone and on a laptop-height window (see "What the editor lets an onboarding be"). That
  is the campaign layout (a 16:10 picture, the words, four controls), not the copy; a shorter picture or a two-column
  control row on a phone would be a product change.
- **Not fixed, seen again from the release campaign's list:** in the admin Campaigns preview the Hungarian "Következő" button
  is clipped at the card's right edge at 1440 px (`preview/admin-hu.png`; the reader's own card is not affected), and on a
  phone the panel list cuts a long Document title when the row also carries the "1 módosítás vár rád" badge (slide 4's
  desktop picture is the list on a desktop, where it does not).
- **The home greeting changes with the day and the time of day** (`greeting.ts` picks it from the user, the day, the slot
  and the language), so the pictures show the line of the day they were taken ("Ma az első, Bence. Hová tovább?").
