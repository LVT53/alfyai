/**
 * The Feature Guide (the `/guide` page): the page's own words, each section's
 * name and intro, and each entry's name, line and (for Try it) example.
 *
 * Its own namespace, so the whole page is one audited prefix (`guide.`): an
 * entry that landed in EN and not in HU would show a Hungarian reader the raw
 * key on the page that exists to name every feature.
 *
 * The entry names are the features' names. The Hungarian uses one word per
 * thing across the page and the words the real controls already wear
 * (Tudásbázis, Könyvtár, Gondolkodás, Tábla, Kép, Előzmények), not the
 * drifted ones. Which entries exist, and what each one does, is
 * `src/lib/components/guide/guide-content.ts`; a drawing's words are not here,
 * they reuse the real controls' own keys.
 */
const guideDict = {
	en: {
		// ── The page ───────────────────────────────────────────────────────
		"guide.title": "What AlfyAI can do",
		"guide.subtitle":
			"A map of everything here. Try it starts a chat with an example you can change before sending.",
		// The name of the row of chips that jump to the six sections.
		"guide.sectionsLabel": "Sections",
		"guide.tryIt": "Try it",
		"guide.tryItA11y": "Try it: {name}",
		"guide.showMe": "Show me",
		"guide.showMeA11y": "Show me: {name}",
		"guide.new": "NEW",
		// Said when Try it finds an unsent message in Home's box and leaves it be.
		"guide.tryItDraftKept":
			"Your unsent message is still in the box, so the example was not added.",

		// ── The six sections ───────────────────────────────────────────────
		"guide.section.ask.name": "Ask",
		"guide.section.ask.intro":
			"Ask anything, in English or Hungarian. Alfy decides when to search, calculate or look something up.",
		"guide.section.make.name": "Make",
		"guide.section.make.intro":
			"Ask for something you will keep. It opens beside the chat and you change it together.",
		"guide.section.knowsYou.name": "It knows you",
		"guide.section.knowsYou.intro":
			"Alfy learns what matters to you. You can see, correct or switch off all of it.",
		"guide.section.yourThings.name": "Your things",
		"guide.section.yourThings.intro":
			"Bring in what you already have: documents and accounts.",
		"guide.section.organized.name": "Stay organized",
		"guide.section.organized.intro":
			"Find anything, and keep your chats where you want them.",
		"guide.section.account.name": "Your account",
		"guide.section.account.intro": "Language, sign-in and your data.",

		// ── Ask ────────────────────────────────────────────────────────────
		"guide.entry.askAnything.name": "Ask anything",
		"guide.entry.askAnything.line":
			"Pick a model and a style; switch Thinking on for harder questions.",
		"guide.entry.webAndLinks.name": "Web and links",
		"guide.entry.webAndLinks.line":
			"Alfy can find current information, cite its sources and show photos that help you tell things apart.",
		"guide.entry.webAndLinks.example":
			"How can I tell a USB-C plug from a Micro-USB plug at a glance?",
		"guide.entry.pictureOrFile.name": "Show it a picture or a file",
		"guide.entry.pictureOrFile.line":
			"Drop in a photo, a PDF or a screenshot and ask about it.",
		"guide.entry.mapsAndTravel.name": "Maps and travel",
		"guide.entry.mapsAndTravel.line":
			"Routes, travel times and public transport, on a map.",
		"guide.entry.mapsAndTravel.example":
			"How do I get from Keleti station to the airport by public transport?",
		"guide.entry.atlasResearch.name": "Atlas research",
		"guide.entry.atlasResearch.line":
			"A deep report with sources; a bell tells you when it is ready.",
		"guide.entry.steerAReply.name": "Steer a reply",
		"guide.entry.steerAReply.line":
			"Edit, regenerate, fork, or add a follow-up while it is still answering.",
		"guide.entry.asksFirst.name": "Alfy asks first",
		"guide.entry.asksFirst.line":
			"When a request could go two ways, Alfy asks with answers to click.",
		"guide.entry.asksFirst.example": "Help me choose a laptop.",
		"guide.entry.listenToAReply.name": "Listen to a reply or a document",
		"guide.entry.listenToAReply.line":
			"Press the speaker under a reply, or at the top of a document or a report, to hear it, and follow the words as they are read.",
		"guide.entry.listenToAReply.example":
			"Tell me a short story about a lighthouse keeper.",

		// ── Make ───────────────────────────────────────────────────────────
		"guide.entry.documents.name": "Documents",
		"guide.entry.documents.line":
			"Write and edit together; Alfy's changes wait for your Keep or Undo.",
		"guide.entry.documents.example":
			"Draft a polite letter to my landlord about the broken heating.",
		"guide.entry.apps.name": "Apps",
		"guide.entry.apps.line":
			"Small working tools: a quiz, a calculator, a tracker.",
		"guide.entry.apps.example": "Make a times-table quiz for a nine-year-old.",
		"guide.entry.canvases.name": "Canvases",
		"guide.entry.canvases.line": "A board of notes, charts, maps and photos.",
		"guide.entry.canvases.example": "Plan a weekend in Vienna on a board.",
		"guide.entry.pictures.name": "Pictures",
		"guide.entry.pictures.line": "Make a picture from words, or change one.",
		"guide.entry.pictures.example":
			"Draw a birthday card with a fox in a party hat.",
		"guide.entry.videos.name": "Videos",
		"guide.entry.videos.line":
			"Turn a still picture into a 5 or 10 second clip.",
		"guide.entry.videos.example":
			"Animate this photo: the waves roll in slowly.",
		"guide.entry.files.name": "Files",
		"guide.entry.files.line":
			"PDF, Word, Excel or PowerPoint, ready to download.",
		"guide.entry.files.example":
			"Make an Excel sheet for our monthly household budget.",
		"guide.entry.history.name": "History",
		"guide.entry.history.line": "Every version is kept. Compare and restore.",

		// ── It knows you ───────────────────────────────────────────────────
		"guide.entry.memory.name": "Memory",
		"guide.entry.memory.line":
			"See what Alfy remembers, grouped by subject, and edit or remove any detail. What is no longer current folds away under Earlier. Open the overview for a short summary, written when you open it and never sent to chats. Project memories stay in their project. Eligible earlier chats can contribute while Memory is on. Earlier opt-outs and exclusions still apply. Ask directly to look up a past chat. If offered, review suggestions from earlier chats and choose which to keep.",
		"guide.entry.instructions.name": "Instructions",
		"guide.entry.instructions.line":
			"Rules Alfy follows in every chat, or in one project.",
		"guide.entry.styleAndModel.name": "Style and model",
		"guide.entry.styleAndModel.line":
			"How Alfy sounds, and which model answers by default.",
		"guide.entry.skills.name": "Skills",
		"guide.entry.skills.line":
			"Ready-made helpers like Study Coach, and your own.",
		"guide.entry.picturesAndVideos.name": "Pictures and videos",
		"guide.entry.picturesAndVideos.line":
			"Alfy makes them only when you ask, and you can switch them off.",
		"guide.entry.yourVoices.name": "Voices that read to you",
		"guide.entry.yourVoices.line":
			"Choose a voice for each language and the speed it starts at, or make a voice of your own.",

		// ── Your things ────────────────────────────────────────────────────
		"guide.entry.knowledgeBase.name": "Knowledge Base",
		"guide.entry.knowledgeBase.line":
			"Your documents in one place, with everything your chats made.",
		"guide.entry.useADocument.name": "Use a document in a chat",
		"guide.entry.useADocument.line":
			"Pick a file from your Library and ask about it.",
		"guide.entry.connectedAccounts.name": "Connected accounts",
		"guide.entry.connectedAccounts.line":
			"Connect email, files, photos or calendars, including Outlook. Ask when you are free across your connected calendars. Found Nextcloud files come back under the reply: pictures open in the app, and every file opens in Nextcloud.",
		"guide.entry.yourOk.name": "Nothing changes without your OK",
		"guide.entry.yourOk.line":
			"Alfy asks before it changes anything in your accounts.",

		// ── Stay organized ─────────────────────────────────────────────────
		"guide.entry.projects.name": "Projects",
		"guide.entry.projects.line":
			"Folders with their own instructions and files.",
		"guide.entry.search.name": "Search",
		"guide.entry.search.line":
			"Find any chat, memory, document, picture, video or app; Ctrl/⌘+K on a keyboard.",
		"guide.entry.tidySidebar.name": "Tidy the sidebar",
		"guide.entry.tidySidebar.line":
			"Pin, drag into folders, or select many at once.",
		"guide.entry.incognito.name": "Incognito",
		"guide.entry.incognito.line": "A chat Alfy learns nothing from.",
		"guide.entry.home.name": "Home",
		"guide.entry.home.line":
			"Recent chats, what's running, your projects and your week.",

		// ── Your account ───────────────────────────────────────────────────
		"guide.entry.languageAndLook.name": "Language and look",
		"guide.entry.languageAndLook.line":
			"Interface and title language, time zone, light or dark.",
		"guide.entry.sendWithEnter.name": "Send with Enter",
		"guide.entry.sendWithEnter.line":
			"Enter sends your message and Shift+Enter starts a new line.",
		"guide.entry.twoStep.name": "Two-step sign-in",
		"guide.entry.twoStep.line":
			"A code from your phone as well as your password.",
		"guide.entry.yourData.name": "Your data",
		"guide.entry.yourData.line":
			"Download everything, bring in your ChatGPT history, or delete your account.",
		"guide.entry.yourActivity.name": "Your activity",
		"guide.entry.yourActivity.line":
			"Messages, tokens and estimated cost over time.",

		// ── Shortcuts and commands (the box at the end) ────────────────────
		"guide.shortcuts.title": "Shortcuts and commands",
		"guide.shortcuts.search": "Open Search",
		"guide.shortcuts.focus": "Go to the message box",
		"guide.shortcuts.send": "Send",
		"guide.shortcuts.newLine": "New line",
		"guide.shortcuts.close": "Close a menu or dialog",
		"guide.shortcuts.commandsLead": "Type / in the message box for these:",
	},
	hu: {
		// ── The page ───────────────────────────────────────────────────────
		"guide.title": "Amit az AlfyAI tud",
		"guide.subtitle":
			"Itt mindent megtalálsz egy helyen. A Kipróbálom gomb egy példával indít beszélgetést, amit elküldés előtt átírhatsz.",
		"guide.sectionsLabel": "Szakaszok",
		"guide.tryIt": "Kipróbálom",
		"guide.tryItA11y": "Kipróbálom: {name}",
		"guide.showMe": "Megnézem",
		"guide.showMeA11y": "Megnézem: {name}",
		"guide.new": "ÚJ",
		"guide.tryItDraftKept":
			"Az üzenetmezőben még ott van az el nem küldött üzeneted, ezért a példa nem került bele.",

		// ── The six sections ───────────────────────────────────────────────
		"guide.section.ask.name": "Kérdezz",
		"guide.section.ask.intro":
			"Kérdezz bármit, magyarul vagy angolul. Alfy eldönti, mikor keressen, számoljon vagy nézzen utána valaminek.",
		"guide.section.make.name": "Készíts",
		"guide.section.make.intro":
			"Kérj valamit, amit megtartasz. A beszélgetés mellett nyílik meg, és együtt alakíthatjátok.",
		"guide.section.knowsYou.name": "Ismer téged",
		"guide.section.knowsYou.intro":
			"Alfy megtanulja, mi fontos neked. Mindent megnézhetsz, kijavíthatsz vagy kikapcsolhatsz.",
		"guide.section.yourThings.name": "A dolgaid",
		"guide.section.yourThings.intro":
			"Hozd át, amid már van: dokumentumokat és fiókokat.",
		"guide.section.organized.name": "Tartsd rendben",
		"guide.section.organized.intro":
			"Találj meg mindent, és tartsd a beszélgetéseidet ott, ahol szeretnéd.",
		"guide.section.account.name": "A fiókod",
		"guide.section.account.intro": "Nyelv, bejelentkezés és az adataid.",

		// ── Ask ────────────────────────────────────────────────────────────
		"guide.entry.askAnything.name": "Kérdezz bármit",
		"guide.entry.askAnything.line":
			"Válassz modellt és stílust; nehezebb kérdéshez kapcsold be a Gondolkodást.",
		"guide.entry.webAndLinks.name": "Web és linkek",
		"guide.entry.webAndLinks.line":
			"Alfy friss információkat keres a weben, megadja a forrásait, és fotókon is megmutathatja a különbségeket.",
		"guide.entry.webAndLinks.example":
			"Honnan ismerem fel ránézésre, hogy egy csatlakozó USB-C vagy Micro-USB?",
		"guide.entry.pictureOrFile.name": "Mutass képet vagy fájlt",
		"guide.entry.pictureOrFile.line":
			"Csatolj egy fotót, PDF-et vagy képernyőképet, és kérdezz róla.",
		"guide.entry.mapsAndTravel.name": "Térkép és utazás",
		"guide.entry.mapsAndTravel.line":
			"Útvonalak, utazási idők és tömegközlekedés, térképen.",
		"guide.entry.mapsAndTravel.example":
			"Hogyan jutok el tömegközlekedéssel a Keleti pályaudvarról a reptérre?",
		"guide.entry.atlasResearch.name": "Atlas-kutatás",
		"guide.entry.atlasResearch.line":
			"Mélyreható jelentés forrásokkal; csengő jelzi, ha elkészült.",
		"guide.entry.steerAReply.name": "Irányítsd a választ",
		"guide.entry.steerAReply.line":
			"Szerkesztés, újragenerálás, elágazás és következő üzenet még válasz közben.",
		"guide.entry.asksFirst.name": "Alfy előbb kérdez",
		"guide.entry.asksFirst.line":
			"Ha egy kérés félreérthető, Alfy kattintható válaszokkal kérdez vissza.",
		"guide.entry.asksFirst.example": "Segíts laptopot választani.",
		"guide.entry.listenToAReply.name":
			"Hallgasd meg a választ vagy a dokumentumot",
		"guide.entry.listenToAReply.line":
			"Nyomd meg a hangszórót a válasz alatt, vagy egy dokumentum vagy jelentés tetején, és kövesd a szavakat, ahogy elhangzanak.",
		"guide.entry.listenToAReply.example":
			"Mesélj egy rövid történetet egy világítótorony-őrről.",

		// ── Make ───────────────────────────────────────────────────────────
		"guide.entry.documents.name": "Dokumentumok",
		"guide.entry.documents.line":
			"Közös szerkesztés; Alfy módosításairól te döntesz: Megtartom vagy Visszavonom.",
		"guide.entry.documents.example":
			"Fogalmazz meg egy udvarias levelet a bérbeadómnak az elromlott fűtésről.",
		"guide.entry.apps.name": "Alkalmazások",
		"guide.entry.apps.line":
			"Apró, működő eszközök: kvíz, számológép, nyilvántartó.",
		"guide.entry.apps.example":
			"Készíts kvízt a szorzótáblából egy kilencévesnek.",
		"guide.entry.canvases.name": "Táblák",
		"guide.entry.canvases.line":
			"Jegyzetek, diagramok, térképek és fotók egyetlen táblán.",
		"guide.entry.canvases.example":
			"Tervezz meg egy bécsi hétvégét egy táblán.",
		"guide.entry.pictures.name": "Képek",
		"guide.entry.pictures.line":
			"Készíts képet szavakból, vagy alakíts át egyet.",
		"guide.entry.pictures.example":
			"Rajzolj születésnapi képeslapot egy partisapkás rókával.",
		"guide.entry.videos.name": "Videók",
		"guide.entry.videos.line":
			"Készíts 5 vagy 10 másodperces klipet egy állóképből.",
		"guide.entry.videos.example":
			"Keltesd életre ezt a fotót: lassan begördülnek a hullámok.",
		"guide.entry.files.name": "Fájlok",
		"guide.entry.files.line":
			"PDF, Word, Excel vagy PowerPoint, letöltésre készen.",
		"guide.entry.files.example":
			"Készíts Excel-táblázatot a havi háztartási költségvetésünkhöz.",
		"guide.entry.history.name": "Előzmények",
		"guide.entry.history.line":
			"Minden változat megmarad. Vesd össze, vagy állítsd vissza.",

		// ── It knows you ───────────────────────────────────────────────────
		"guide.entry.memory.name": "Memória",
		"guide.entry.memory.line":
			"Nézd meg témák szerint, mire emlékszik Alfy, és szerkeszd vagy távolítsd el bármelyik részletet. Ami már nem aktuális, a Korábbiak közé kerül. Az áttekintés rövid összefoglalót ad: megnyitáskor készül, és sosem kerül a beszélgetésekbe. A projektek emlékei a projektben maradnak. Ha a Memória be van kapcsolva, a bevonható korábbi beszélgetésekből is megjegyezhet részleteket. A korábban kizárt beszélgetések és részletek továbbra is kimaradnak. Kérd meg Alfy-t, ha egy korábbi beszélgetésben szeretnél keresni. Ha elérhető, nézd át a korábbi beszélgetésekből származó javaslatokat, és válaszd ki, melyeket tartod meg.",
		"guide.entry.instructions.name": "Utasítások",
		"guide.entry.instructions.line":
			"Amit Alfy minden beszélgetésben betart, vagy csak egy projektben.",
		"guide.entry.styleAndModel.name": "Stílus és modell",
		"guide.entry.styleAndModel.line":
			"Hogyan beszél Alfy, és melyik modell válaszol alapból.",
		"guide.entry.skills.name": "Készségek",
		"guide.entry.skills.line":
			"Beépített segítők, például a Tanulási coach, és a sajátjaid.",
		"guide.entry.picturesAndVideos.name": "Képek és videók",
		"guide.entry.picturesAndVideos.line":
			"Alfy csak kérésre készít ilyet, és ki is kapcsolhatod.",
		"guide.entry.yourVoices.name": "Felolvasó hangok",
		"guide.entry.yourVoices.line":
			"Válassz hangot minden nyelvhez és kezdősebességet, vagy készíts saját hangot.",

		// ── Your things ────────────────────────────────────────────────────
		"guide.entry.knowledgeBase.name": "Tudásbázis",
		"guide.entry.knowledgeBase.line":
			"A dokumentumaid egy helyen, és minden, amit a beszélgetéseid készítettek.",
		"guide.entry.useADocument.name": "Dokumentum a beszélgetésben",
		"guide.entry.useADocument.line":
			"Válassz egy fájlt a Könyvtáradból, és kérdezz róla.",
		"guide.entry.connectedAccounts.name": "Csatlakoztatott fiókok",
		"guide.entry.connectedAccounts.line":
			"Csatlakoztasd a levelezésedet, fájljaidat, fotóidat vagy naptáraidat, köztük az Outlook-naptáradat. Kérdezd meg, mikor érsz rá az összes csatlakoztatott naptárad szerint. A megtalált Nextcloud-fájlok a válasz alatt jelennek meg: a képek az alkalmazásban nyílnak meg, és minden fájl a Nextcloudban nyílik meg.",
		"guide.entry.yourOk.name": "Jóváhagyásod nélkül semmi sem változik",
		"guide.entry.yourOk.line":
			"Alfy megkérdezi, mielőtt bármit módosít a fiókjaidban.",

		// ── Stay organized ─────────────────────────────────────────────────
		"guide.entry.projects.name": "Projektek",
		"guide.entry.projects.line": "Mappák saját utasításokkal és fájlokkal.",
		"guide.entry.search.name": "Keresés",
		"guide.entry.search.line":
			"Bármelyik beszélgetést, emléket, dokumentumot, képet, videót vagy alkalmazást megtalálod; billentyűzeten Ctrl/⌘+K.",
		"guide.entry.tidySidebar.name": "Rendezd az oldalsávot",
		"guide.entry.tidySidebar.line":
			"Rögzíts, húzz mappákba, vagy jelölj ki egyszerre többet.",
		"guide.entry.incognito.name": "Inkognitó",
		"guide.entry.incognito.line":
			"Olyan beszélgetés, amiből Alfy semmit sem tanul.",
		"guide.entry.home.name": "Kezdőlap",
		"guide.entry.home.line":
			"Legutóbbi beszélgetések, ami most fut, a projektjeid és a heted.",

		// ── Your account ───────────────────────────────────────────────────
		"guide.entry.languageAndLook.name": "Nyelv és megjelenés",
		"guide.entry.languageAndLook.line":
			"A felület és a címek nyelve, időzóna, világos vagy sötét.",
		"guide.entry.sendWithEnter.name": "Küldés Enterrel",
		"guide.entry.sendWithEnter.line":
			"Az Enter elküldi az üzenetet, a Shift+Enter új sort kezd.",
		"guide.entry.twoStep.name": "Kétlépcsős bejelentkezés",
		"guide.entry.twoStep.line":
			"A jelszó mellett egy kód is kell a telefonodról.",
		"guide.entry.yourData.name": "Az adataid",
		"guide.entry.yourData.line":
			"Tölts le mindent, importáld a ChatGPT-beszélgetéseidet, vagy töröld a fiókodat.",
		"guide.entry.yourActivity.name": "A tevékenységed",
		"guide.entry.yourActivity.line":
			"Üzenetek, tokenek és becsült költség az idő során.",

		// ── Shortcuts and commands (the box at the end) ────────────────────
		"guide.shortcuts.title": "Gyorsbillentyűk és parancsok",
		"guide.shortcuts.search": "Keresés megnyitása",
		"guide.shortcuts.focus": "Ugrás az üzenetmezőre",
		"guide.shortcuts.send": "Küldés",
		"guide.shortcuts.newLine": "Új sor",
		"guide.shortcuts.close": "Menü vagy ablak bezárása",
		"guide.shortcuts.commandsLead":
			"Az üzenetmezőben a / jel után ezek közül választhatsz:",
	},
} as const;

export default guideDict;
