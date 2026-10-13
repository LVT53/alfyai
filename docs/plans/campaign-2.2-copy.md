# AlfyAI 2.2 release campaign: draft copy

**Status: a draft for the owner's review. Nothing is published, and nothing was run against any server.** The deck below
was checked by `scripts/create-release-campaign.ts` (a dry run, then a real draft in a scratch database on this machine)
and rendered in the app's own campaign card, in Hungarian and English, on a phone and on a desktop.

Ruling 78 makes 2.2 the next production release. Production is on the 2.0 line; this campaign is for everything since:
Workspaces, Artifacts (Document, App, Canvas, File), followable versions, the friction build and the privacy hardening.
Slides is shelved and is not mentioned.

The version is set in two places that must move together (`app-version.ts`: the sidebar badge is the higher of
`package.json` and the newest published release campaign): `package.json` is **2.2.0** (its own commit, with the test that pins the comparator) and the
campaign's release version is **2.2.0**. The comparator reads "2.2" and "2.2.0" as one version
(`app-version.test.ts` pins it), so the badge reads **v2.2.0** either way; the campaign uses `2.2.0` because 2.0's did.

## Where everything is

| What | Where |
|---|---|
| This copy | `docs/plans/campaign-2.2-copy.md` |
| The deck the campaign is created from (Hungarian-interface pictures) | `docs/plans/campaign-2.2/deck/` (`slides.json`, `slides/*.png`) |
| The same words with English-interface pictures (an alternate) | `docs/plans/campaign-2.2/deck-en/` |
| The campaign card as it renders, Hungarian and English, desktop and phone | `docs/plans/campaign-2.2/preview/cards-*.png` |
| The admin Campaigns pane with the draft, Hungarian and English | `docs/plans/campaign-2.2/preview/admin-*.png` |
| The sample content and the picture scripts | `scripts/seed-campaign-2-2.ts`, `scripts/campaign-shots-2-2.ts` |

## The five slides

Hungarian first. Titles and bodies are the exact strings in `slides.json`. Every Hungarian label quoted is the app's own
(checked against `src/lib/i18n/`).

### Slide 1: Projektek, amik tudják, min dolgozol

- **titleHu**: Projektek, amik tudják, min dolgozol
- **bodyHu**: Adj egy projektnek utasításokat és fájlokat, és minden beszélgetése tudni fogja, miről van szó. Alfy az utasításokat minden válaszánál követi, a fájlokat pedig akkor olvassa el, amikor szüksége van rájuk. A projekt azt is megmutatja, amit a beszélgetései készítettek.
- **titleEn**: Projects that know what you’re working on
- **bodyEn**: Give a project instructions and files, and every chat in it knows what it is about. Alfy follows the instructions in every reply and reads the files when it needs them. The project also shows what its chats made.
- **altTextHu**: A Balatoni nyaralás projekt Fájlok ablaka: három feltöltött fájl és négy elem, amit a beszélgetései készítettek
- **altTextEn**: The Files window of the Balatoni nyaralás project: three uploaded files and four items its chats made
- **Button**: none
- **Pictures**: `slides/01-projects-desktop.png` (1600x1000) and `slides/01-projects-mobile.png` (1080x1920)

### Slide 2: Alfy dokumentumot, alkalmazást és táblát is készít

- **titleHu**: Alfy dokumentumot, alkalmazást és táblát is készít
- **bodyHu**: Kérhetsz tőle dokumentumot, alkalmazást, táblát vagy fájlt. Mind a beszélgetés mellett nyílik meg, ott szerkesztheted és letöltheted, a fejlécben pedig látod, hány elem készült benne.
- **titleEn**: Alfy makes documents, apps and canvases too
- **bodyEn**: Ask for a document, an app, a canvas or a file. Each one opens beside the chat, where you can edit and download it, and the header shows how many the chat has made.
- **altTextHu**: Egy beszélgetés a háromnapos programról, mellette megnyitva egy napokra bontott tábla
- **altTextEn**: A chat about a three-day plan with a day-by-day canvas open beside it
- **Button**: Új beszélgetés / Start a chat, goes to `/`
- **Pictures**: `slides/02-artifacts-desktop.png` (1600x1000) and `slides/02-artifacts-mobile.png` (1080x1920)

### Slide 3: Alfy módosít, te döntesz

- **titleHu**: Alfy módosít, te döntesz
- **bodyHu**: Ha Alfy átír valamit a dokumentumodban vagy a táblán, látod, mi változott, és te döntöd el: „Megtartom” vagy „Visszavonom”. Megjegyzést is írhatsz bárhová, és ha @Alfy-t említesz, válaszol, kérésedre pedig javít is.
- **titleEn**: Alfy edits, you decide
- **bodyEn**: When Alfy changes something in your document or canvas, you see what changed and decide: “Keep” or “Undo”. Leave a comment anywhere, and mention @Alfy to get an answer, or a fix if you ask for one.
- **altTextHu**: Egy dokumentum, benne Alfy egy módosítása a Megtartom és Visszavonom gombokkal, mellette egy @Alfy-nak szóló megjegyzés és a válasza
- **altTextEn**: A document with one change by Alfy and its Keep and Undo buttons, beside a comment addressed to @Alfy and its answer
- **Button**: none
- **Pictures**: `slides/03-together-desktop.png` (1600x1000) and `slides/03-together-mobile.png` (1080x1920)

### Slide 4: Minden változatra visszatérhetsz

- **titleHu**: Minden változatra visszatérhetsz
- **bodyHu**: Az Előzmények napokra bontva mutatja, mi változott és ki változtatta. Elnevezhetsz egy változatot, megnézheted előnézetben, és visszaállíthatod. A visszaállítás sem töröl semmit: új lépésként megmarad.
- **titleEn**: Go back to any version
- **bodyEn**: History lists every change by day and says who made it. Name a version, preview it, and restore it. Restoring deletes nothing: it is kept as a new step.
- **altTextHu**: Egy dokumentum Előzmények nézete egy elnevezett változattal, annak előnézetével és a Visszaállítás gombbal
- **altTextEn**: A document’s History view with a named version, its preview and the Restore button
- **Button**: none
- **Pictures**: `slides/04-history-desktop.png` (1600x1000) and `slides/04-history-mobile.png` (1080x1920)

### Slide 5: Alfy magától nem nyit meg idegen oldalakat

- **titleHu**: Alfy magától nem nyit meg idegen oldalakat
- **bodyHu**: Alfy csak olyan oldalt és képet tölt be, amelynek a címét te adtad meg, vagy amelyet az egyik eszköze talált. Minden más cím hivatkozás marad a válaszban, amíg rá nem kattintasz. Közben sok apróságot is csiszoltunk, főleg telefonon és a panel mozgásán.
- **titleEn**: Alfy won’t open unknown pages on its own
- **bodyEn**: Alfy loads a page or a picture only if you gave its address or one of its tools found it. Any other address stays a link in the reply until you click it. Along the way we polished many small things, mostly on phones and in how the panel moves.
- **altTextHu**: Egy válasz, amelyben három kép nem töltődött be, hanem hivatkozásként jelenik meg
- **altTextEn**: A reply in which three pictures are shown as links instead of being loaded
- **Button**: none
- **Pictures**: `slides/05-privacy-desktop.png` (1600x1000) and `slides/05-privacy-mobile.png` (1080x1920)

## Fact checks

What each slide claims, and where it was checked.

- **Projects.** The instructions apply on every turn of every chat in the project, and the files are read only when a turn needs them: `docs/plans/claude-at-home-1-workspaces-spec.md` decisions 2 and 4. "What its chats made" is the Files window's own line (`A projekt minden csevegése tud a fájlokról…`). Instructions and Files are the real labels of the project page.
- **Artifacts.** Document, App, Canvas and File are `artifacts.type.*` (Dokumentum, Alkalmazás, Tábla, Fájl). The panel opens beside the chat (a sheet on a phone); the header count button is `artifact-count-button`; Download is on every item's header.
- **Working together.** „Megtartom" / „Visszavonom" are `artifacts.document.review.keepShort` / `undoShort` (the pill and the phone bar); a board's change is one pending change with the same two choices (ruling 63). `@Alfy` in a margin comment answers, and edits when asked (`artifacts.document.comment.*`, ruling 11).
- **History.** Day groups, named versions, the preview, Restore: `artifacts.history.*` and ruling 76. Restore writes a new version (`Restored v3`) and no row is ever deleted (ruling 76, Q5).
- **Privacy and polish.** ADR-0068, decisions 3 and 5: a reply shows only pictures its own tools returned (any other becomes a link chip, `messageBubble.imageNotLoaded`), and `fetch_url` takes an address only from the user's own messages or a tool's result. What the slide does not say: ADR-0068 names the leaks that remain (a hostname used from inside an App, WebRTC from inside an App) and the owner has not judged the WebRTC one yet (ruling 78). The slide promises pages and pictures only, never "nothing leaves". The polish line is ruling 77's friction build (the panel and the chat move together, phone rows and review bar).

The other 2.2 changes (the sampling route, the first-open tours, the exfil-channels work beyond what slide 5 says, the
Computers record) are not in this campaign. The unpublished 2.1 draft (`campaign/2-1-deck`: session expiry, incognito,
73 file types, page citations) is about features that are already in production, so it is not carried over.

## The pictures

- **What they show.** One invented sample: Anna Kovács, a project "Balatoni nyaralás" with instructions and three files,
  chats that made a Document, a Canvas, an App and a File, a Document with a named version, a change Alfy made that
  the reader kept, a change still waiting for Keep or Undo, and a margin comment that asks @Alfy. No real person, address,
  file or conversation; every web address is on `.example`.
- **How they were made.** `scripts/seed-campaign-2-2.ts` writes the sample through the app's own services (the artifacts
  facade, projects, the knowledge upload intake), never as hand-built rows. `scripts/campaign-shots-2-2.ts` drives a
  local production build with Playwright: light theme, a 1440x900 window for the desktop pictures (a 16:10 region drawn at
  the scale that makes it 1600 pixels wide, so nothing is resized afterwards) and a 360x640 window at scale 3 for the
  phone pictures (1080x1920). Nothing is drawn on top of them. The PNGs were then reduced to 256 colours with ImageMagick
  (`magick in.png -strip -colors 256 -dither None -define png:compression-level=9 out.png`), which halves them and is not
  visible; the whole Hungarian deck is about 1 MB.
- **One set for both languages.** A campaign slide has one desktop and one phone picture for both languages (the schema
  has no per-language image), so the deck holds the Hungarian-interface pictures and an English reader sees them with
  English words beside them. `deck-en/` is the same five slides with the English interface around the same Hungarian
  sample, for the case that the owner prefers it. The English pictures still carry the Hungarian sample content (the
  project, the chats and the document are Hungarian in both).
- **Time.** The sample's days are told in a fixed-offset zone chosen so that "today" is mid-afternoon whenever the seed
  runs, and nothing lies in the future ("in 7 hours" appears otherwise); the screenshot browser uses the same zone.

## Previews for the owner

`docs/plans/campaign-2.2/preview/`:

- `cards-hu-desktop.png`, `cards-en-desktop.png`: the five cards as a reader's modal draws them on a desktop.
- `cards-hu-phone.png`, `cards-en-phone.png`: the same on a phone.
- `admin-hu.png`, `admin-en.png`: the admin Campaigns pane with the draft open (the checklist reads "12 / 12 checks pass",
  ready to publish).

The cards were rendered by loading the app with the draft in place of the reader's campaign (the browser's answer to
`/api/campaigns/eligible` was replaced by the draft's admin payload), so they are the real modal at its real size and
nothing was published or written.

## The commands

Run from the release directory, where `data` is the symlink to `shared/data`; the script refuses to run anywhere else.
The deck ships inside the release (`scripts/deploy.sh` is a `git archive`), so there is no copy step. `<admin-email>` is an
existing admin account; it becomes the author.

Staging first (a dry run writes nothing):

```bash
cd /home/alfydesign/apps/langflow-chat-dev/current
set -a; . .env; set +a
npx tsx scripts/create-release-campaign.ts \
  --deck docs/plans/campaign-2.2/deck \
  --name "AlfyAI 2.2" --version 2.2.0 \
  --admin-email <admin-email> --dry-run
```

Drop `--dry-run` to create the draft, and review it at Settings, Administration, Campaigns. Production, once staging
looks right:

```bash
cd /home/alfydesign/apps/langflow-chat/current
set -a; . .env; set +a
npx tsx scripts/create-release-campaign.ts \
  --deck docs/plans/campaign-2.2/deck \
  --name "AlfyAI 2.2" --version 2.2.0 \
  --admin-email <admin-email>
```

That creates a **draft**. Publish it from the Campaigns pane, or add `--publish` to run the same validation from the
command line. There is no undo for a publish (a published campaign can only be archived), so publish after the 2.2 build is
live and on the owner's word. To change a draft, edit `slides.json` or the pictures and run it again with `--replace-draft`
(it replaces a draft only, never a published campaign). For English-interface pictures use
`--deck docs/plans/campaign-2.2/deck-en`. `deploy/README.md` has the general notes (what it will and will not do, exit
codes, the badge caveat when `APP_VERSION_OVERRIDE` is set).

`scripts/create-release-campaign.test.ts` creates and publishes this very deck into an in-memory database on every test
run, so a broken picture size, a missing translation or a bad button destination fails CI before it fails on a server.

## Taking the pictures again

After a UI change, from the repository root, with Node 22:

```bash
rm -f data/campaign-2-2.db data/campaign-2-2.db-shm data/campaign-2-2.db-wal
export DATABASE_PATH=$PWD/data/campaign-2-2.db
npm run db:prepare && npx tsx scripts/seed-campaign-2-2.ts      # also writes data/campaign-2-2-manifest.json
npm run build
PORT=5568 HOST=127.0.0.1 ORIGIN=http://127.0.0.1:5568 SESSION_SECRET=<32 or more characters> \
  HOME_SUMMARY_CACHE_TTL_MS=0 PLAYWRIGHT_TEST=1 node -r dotenv/config build/index.js &
CAMPAIGN_OUT_DIR=./data/campaign-2-2-shots npx tsx scripts/campaign-shots-2-2.ts    # hu and en; add hu or en, --only 3
```

The sample user is a scratch account on that scratch database; its sign-in is in the seed script.

## For the owner to decide

1. **Pictures.** Hungarian interface for everyone (the deck as it is), or the English one (`deck-en`)? Or English sample
   content too, which would be a second seed.
2. **Slide 2's button** ("Új beszélgetés" / "Start a chat", to `/`). Delete the three `action*` keys in `slides.json` to drop it.
3. **Slide 5's reach.** It promises pages and pictures only. Wording like "nothing leaves" would need the open WebRTC leak
   closed first (ADR-0068, ruling 78).
4. **The CHANGELOG** holds only the incognito items under `[Unreleased]`; 2.2 has no entry yet. That is not part of this brief.
5. **Two things seen while taking the pictures, not fixed here.** On a phone, the artifact list cuts a long Document title
   to "Háromn…" when the row also carries the "1 módosítás vár rád" badge (the sample's title is the one that shows it);
   and in the admin Campaigns preview the Hungarian "Következő" button is clipped at the card's edge at 1440 px
   (`preview/admin-hu.png`). The reader's own card is not affected.
