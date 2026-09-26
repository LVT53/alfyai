/**
 * The artifact family's surface (Feature 2 · Artifacts): the chat header's
 * count button, the panel's "what this chat made" list, the shared card, and
 * the five type labels.
 *
 * "Artifact" is the engineering word and NEVER appears in a value, in either
 * language (ADR-0066) — `artifacts.test.ts` fails the build if it does, across
 * every merged dictionary. The UI names each kind: Document / Dokumentum,
 * App / Alkalmazás, Canvas / Tábla, Slides / Diasor, File / Fájl.
 *
 * `artifacts.type.canvas` is **Canvas** in English and **Tábla** in Hungarian
 * on purpose (ruling 20): the English word is the product's own term, and
 * "Tábla" reads as the thing you draw on. Do not "fix" it to a literal
 * translation. `artifacts.type.*` is the feature's ONLY type-label family
 * (ruling 22); no later slice adds a second set of these five words.
 *
 * Slices 1–6 append their own blocks below; the audited prefix `artifacts.`
 * (src/lib/i18n.test-helpers.ts) makes the parity test watch every one of them.
 */
const artifactsDict = {
	en: {
		// The chat header's quiet count button (surface 1). Not drawn at all at
		// zero, so there is no "0" wording.
		"artifacts.header.buttonA11y": "Open what this chat made ({count})",
		// The panel's list state (surface 2).
		"artifacts.panel.eyebrow": "This chat",
		"artifacts.panel.title": "What this chat made",
		"artifacts.panel.count":
			"{count} {count, plural, one {item} other {items}} · newest first",
		"artifacts.panel.list": "Show list",
		"artifacts.panel.back": "Back to the item",
		"artifacts.panel.empty": "Nothing made here yet.",
		"artifacts.panel.history": "History",
		// The shared card.
		"artifacts.card.open": "Open",
		"artifacts.card.openA11y": "Open {title}",
		"artifacts.card.madeBy": "made by Alfy {when}",
		"artifacts.card.version": "v{n}",
		"artifacts.card.versionA11y": "Version {n}",
		// A checklist card's tickable body (slice 0 ships the seam; slice 1 is
		// the first caller) shows the first five items and this for the rest.
		"artifacts.card.moreItems": "+{count} more",
		// The five kinds.
		"artifacts.type.file": "File",
		"artifacts.type.document": "Document",
		"artifacts.type.app": "App",
		"artifacts.type.canvas": "Canvas",
		"artifacts.type.slides": "Slides",
		// Failure states the panel and the later slices' writers report.
		"artifacts.error.load": "Could not open this item.",
		"artifacts.error.list": "Could not load what this chat made.",
		"artifacts.error.gone": "This item was deleted.",
		"artifacts.error.tooLarge": "This item is too large to save.",
		"artifacts.action.retry": "Try again",
		"artifacts.action.dismiss": "Dismiss",
		// The history button's title until the first kind with history lands.
		"artifacts.history.comingWithDocument": "History arrives with documents.",

		// The App kind (Slice 2). "Alkalmazás"/"App" name the kind through
		// artifacts.type.app above; everything below is the App body's own
		// surface (AppFrame.svelte, AppBody.svelte).
		"artifacts.app.cardSubtitle": "App",
		"artifacts.app.tab.preview": "Preview",
		"artifacts.app.tab.code": "Code",
		"artifacts.app.action.regenerate": "Ask Alfy for a new version",
		"artifacts.app.action.download": "Download as .html",
		"artifacts.app.regenerate.prompt": "What should change?",
		"artifacts.app.generating": "Alfy is writing the app…",
		"artifacts.app.generating.hint": "This takes a few seconds.",
		"artifacts.app.failed.emptyContent":
			"Alfy did not manage to write the app this time.",
		"artifacts.app.failed.noFence":
			"Alfy answered, but not with a runnable app.",
		"artifacts.app.failed.toolCall":
			"Alfy tried to look around instead of writing the app. Try again.",
		"artifacts.app.failed.tooLong":
			"The app grew past what can run here. Ask for something smaller.",
		"artifacts.app.failed.contractViolation":
			"Alfy's answer tried to leave the app's sandbox, so it was not shown. Try again, or ask for something simpler.",
		"artifacts.app.verify.checking": "Alfy is checking the facts in this app…",
		"artifacts.app.verify.clean": "Alfy checked the facts in this app.",
		"artifacts.app.verify.repaired":
			"Alfy checked the facts and fixed one thing.",
		"artifacts.app.verify.uncertain":
			"Alfy was not sure about one detail — see the note.",
		"artifacts.app.verify.unavailable":
			"Alfy could not check the facts in this app.",
		"artifacts.app.verify.noteTitle": "Alfy's note",
		"artifacts.app.glitch.network":
			"This app tried to reach the network. Everything still works offline.",
		"artifacts.app.glitch.storage":
			"This app used browser storage instead of Alfy's. Your data may not be kept.",
		"artifacts.app.glitch.external":
			"This app was built to load something from outside. It runs, but parts may be missing.",
		"artifacts.app.storage.timedOut": "The app could not reach its saved data.",
		"artifacts.app.storage.tooLarge":
			"This app tried to save more than it can.",
		"artifacts.app.storage.tooManyKeys":
			"This app tried to save too many separate things.",
		"artifacts.app.storage.notSerialisable":
			"This app tried to save something that cannot be saved.",
		"artifacts.app.frame.title": "{title} — running app",
		"artifacts.app.frame.loading": "Loading the app…",
		"artifacts.app.frame.blocked": "Apps are not run in this context.",
		"artifacts.app.serve.failed": "This app could not be opened.",
		// Ruling 58's tripwire: the parent tears the frame down when it fires a
		// load the parent did not cause (the app navigated itself).
		"artifacts.app.frame.tripwire":
			"This app tried to leave its sandbox, so Alfy stopped it.",
		"artifacts.app.frame.reload": "Reload the app",
		// Ruling 58: served instead of a dead /login form when this route loads
		// with no session left inside the App's own sandboxed iframe
		// (hooks.server.ts, sandbox-response.ts's renderAppSessionExpiredResponse).
		"artifacts.app.session.expiredTitle": "Session ended",
		"artifacts.app.session.expiredMessage":
			"Your session ended. Reload AlfyAI to sign in again.",
		"artifacts.app.tabs.a11y": "Preview and code",
		"artifacts.app.code.copy": "Copy code",
		"artifacts.app.code.copied": "Copied",
		"artifacts.app.regenerate.confirm":
			"Ask Alfy for a new version? Your saved data stays.",
		"artifacts.app.download.unavailable":
			"This app is not in a chat, so it cannot be saved as a file.",
		// Ruling 58: every OTHER download refusal (a request that throws, a
		// missing/foreign artifact, any file-production intake error code)
		// shows this instead of the raw reason/code. conversation_required
		// reuses download.unavailable above, since that is the same case the
		// disabled button already explains proactively.
		"artifacts.app.download.failed": "Could not prepare this app for download.",
		"artifacts.app.open.cta": "Make an app",
	},
	hu: {
		"artifacts.header.buttonA11y":
			"Nyisd meg, amit ez a beszélgetés készített ({count})",
		"artifacts.panel.eyebrow": "Ez a beszélgetés",
		"artifacts.panel.title": "Amit ez a beszélgetés készített",
		"artifacts.panel.count": "{count} elem · legújabb elöl",
		"artifacts.panel.list": "Lista megjelenítése",
		"artifacts.panel.back": "Vissza az elemhez",
		"artifacts.panel.empty": "Itt még nem készült semmi.",
		"artifacts.panel.history": "Előzmények",
		"artifacts.card.open": "Megnyitás",
		"artifacts.card.openA11y": "{title} megnyitása",
		"artifacts.card.madeBy": "Alfy készítette: {when}",
		"artifacts.card.version": "v{n}",
		"artifacts.card.versionA11y": "{n}. verzió",
		"artifacts.card.moreItems": "+{count} további",
		"artifacts.type.file": "Fájl",
		"artifacts.type.document": "Dokumentum",
		"artifacts.type.app": "Alkalmazás",
		"artifacts.type.canvas": "Tábla",
		"artifacts.type.slides": "Diasor",
		"artifacts.error.load": "Nem sikerült megnyitni ezt az elemet.",
		"artifacts.error.list":
			"Nem sikerült betölteni, amit ez a beszélgetés készített.",
		"artifacts.error.gone": "Ezt az elemet törölték.",
		"artifacts.error.tooLarge": "Ez az elem túl nagy ahhoz, hogy elmentsük.",
		"artifacts.action.retry": "Újrapróbálom",
		"artifacts.action.dismiss": "Elvetés",
		"artifacts.history.comingWithDocument":
			"Az előzmények a dokumentumokkal érkeznek.",

		"artifacts.app.cardSubtitle": "Alkalmazás",
		"artifacts.app.tab.preview": "Előnézet",
		"artifacts.app.tab.code": "Kód",
		"artifacts.app.action.regenerate": "Kérj új változatot Alfytól",
		"artifacts.app.action.download": "Letöltés .html-ként",
		"artifacts.app.regenerate.prompt": "Min változtasson?",
		"artifacts.app.generating": "Alfy írja az alkalmazást…",
		"artifacts.app.generating.hint": "Ez néhány másodpercet vesz igénybe.",
		"artifacts.app.failed.emptyContent":
			"Alfynak most nem sikerült megírnia az alkalmazást.",
		"artifacts.app.failed.noFence":
			"Alfy válaszolt, de nem futtatható alkalmazással.",
		"artifacts.app.failed.toolCall":
			"Alfy írás helyett körülnézni próbált. Próbáld újra.",
		"artifacts.app.failed.tooLong":
			"Az alkalmazás nagyobb lett, mint ami itt futtatható. Kérj valami kisebbet.",
		"artifacts.app.failed.contractViolation":
			"Alfy válasza megpróbálta elhagyni az alkalmazás védett területét, ezért nem jelent meg. Próbáld újra, vagy kérj valami egyszerűbbet.",
		"artifacts.app.verify.checking": "Alfy ellenőrzi az alkalmazás adatait…",
		"artifacts.app.verify.clean": "Alfy ellenőrizte az alkalmazás adatait.",
		"artifacts.app.verify.repaired":
			"Alfy ellenőrizte az adatokat, és kijavított egy dolgot.",
		"artifacts.app.verify.uncertain":
			"Alfy egy részletben nem volt biztos — lásd a megjegyzést.",
		"artifacts.app.verify.unavailable":
			"Alfy nem tudta ellenőrizni az alkalmazás adatait.",
		"artifacts.app.verify.noteTitle": "Alfy megjegyzése",
		"artifacts.app.glitch.network":
			"Ez az alkalmazás hálózatot próbált elérni. Így is működik, offline.",
		"artifacts.app.glitch.storage":
			"Ez az alkalmazás a böngésző tárolóját használta Alfyé helyett. Lehet, hogy az adatok nem maradnak meg.",
		"artifacts.app.glitch.external":
			"Ez az alkalmazás kívülről töltene be valamit. Fut, de egyes részei hiányozhatnak.",
		"artifacts.app.storage.timedOut":
			"Az alkalmazás nem érte el a mentett adatait.",
		"artifacts.app.storage.tooLarge":
			"Ez az alkalmazás többet próbált elmenteni, mint amennyi lehet.",
		"artifacts.app.storage.tooManyKeys":
			"Ez az alkalmazás túl sok külön dolgot próbált elmenteni.",
		"artifacts.app.storage.notSerialisable":
			"Ez az alkalmazás olyat próbált elmenteni, ami nem menthető.",
		"artifacts.app.frame.title": "{title} — futó alkalmazás",
		"artifacts.app.frame.loading": "Az alkalmazás betöltése…",
		"artifacts.app.frame.blocked":
			"Ebben a környezetben az alkalmazások nem futnak.",
		"artifacts.app.serve.failed": "Ezt az alkalmazást nem sikerült megnyitni.",
		"artifacts.app.frame.tripwire":
			"Ez az alkalmazás megpróbálta elhagyni a homokozóját, ezért Alfy leállította.",
		"artifacts.app.frame.reload": "Alkalmazás újratöltése",
		"artifacts.app.session.expiredTitle": "Lejárt a munkamenet",
		"artifacts.app.session.expiredMessage":
			"Lejárt a munkameneted. Töltsd újra az AlfyAI-t, hogy újra bejelentkezhess.",
		"artifacts.app.tabs.a11y": "Előnézet és kód",
		"artifacts.app.code.copy": "Kód másolása",
		"artifacts.app.code.copied": "Másolva",
		"artifacts.app.regenerate.confirm":
			"Új változatot kérsz Alfytól? A mentett adataid megmaradnak.",
		"artifacts.app.download.unavailable":
			"Ez az alkalmazás nincs beszélgetésben, ezért nem menthető fájlként.",
		"artifacts.app.download.failed":
			"Nem sikerült előkészíteni ezt az alkalmazást letöltésre.",
		"artifacts.app.open.cta": "Készíts alkalmazást",
	},
} as const;

export default artifactsDict;
