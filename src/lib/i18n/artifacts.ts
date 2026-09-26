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
		// The Document's version history sheet (Slice 1, T6).
		"artifacts.document.versions.title": "Versions",
		"artifacts.document.versions.current": "Current",
		"artifacts.document.versions.restore": "Restore",
		"artifacts.document.versions.restoreConfirm":
			"Restore this version? The current one is kept as a version.",
		"artifacts.document.versions.byUser": "You",
		"artifacts.document.versions.byAlfy": "Alfy",
		"artifacts.document.versions.conflict":
			"This document changed elsewhere. Reload to see the current text.",
		"artifacts.document.versions.loadError":
			"Could not load the version history.",
		"artifacts.document.versions.restoreError":
			"Could not restore this version.",
		"artifacts.document.versions.empty": "No earlier versions yet.",
		// The lazy editor's shell and toolbar (Slice 1, T7).
		"artifacts.document.editor.placeholder": "Write anything, or ask Alfy to.",
		"artifacts.document.editor.failedToLoad": "The editor could not be loaded.",
		"artifacts.document.toolbar.bold": "Bold",
		"artifacts.document.toolbar.italic": "Italic",
		"artifacts.document.toolbar.strike": "Strikethrough",
		"artifacts.document.toolbar.heading": "Heading {n}",
		"artifacts.document.toolbar.bullets": "Bulleted list",
		"artifacts.document.toolbar.numbers": "Numbered list",
		"artifacts.document.toolbar.tasks": "Checklist",
		"artifacts.document.toolbar.quote": "Quote",
		"artifacts.document.toolbar.code": "Code",
		"artifacts.document.toolbar.table": "Table",
		"artifacts.document.toolbar.link": "Link",
		"artifacts.document.toolbar.undo": "Undo",
		"artifacts.document.toolbar.redo": "Redo",
		"artifacts.document.toolbar.more": "More",
		"artifacts.document.save.offline":
			"Not saved yet — you are offline. Your text is safe here.",
		"artifacts.document.save.tooLarge": "This document is too long to save.",
		"artifacts.document.deleted":
			"This document was deleted while it was open. Your text is still here.",
		"artifacts.document.deleted.saveCopy": "Save it as a new document",
		"artifacts.document.notFound": "This document is not available.",
		// Comments and @Alfy (Slice 1, T10). CommentCard reuses
		// artifacts.document.versions.byUser/byAlfy for the author name rather
		// than a second pair of the same two words.
		"artifacts.document.anchor.exact": "Exact",
		"artifacts.document.anchor.moved": "Moved",
		"artifacts.document.anchor.orphaned": "Orphaned",
		"artifacts.document.comment.ask": "Ask Alfy",
		"artifacts.document.comment.add": "Comment",
		"artifacts.document.comment.placeholder": "Write a comment…",
		"artifacts.document.comment.submit": "Post",
		"artifacts.document.comment.cancel": "Cancel",
		"artifacts.document.comment.reply": "Reply",
		"artifacts.document.comment.resolve": "Resolve",
		"artifacts.document.comment.reopen": "Reopen",
		"artifacts.document.comment.resolved": "Resolved",
		"artifacts.document.comment.askingAlfy": "Asking Alfy…",
		"artifacts.document.comment.alfyRefused":
			"I left the text as it is — this comment didn't lead to a change I could make safely.",
		"artifacts.document.comment.alfyDone": "Done.",
		"artifacts.document.comment.postError": "Could not post this comment.",
		"artifacts.document.margin.title": "Comments",
		"artifacts.document.margin.empty": "No comments yet.",
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
		"artifacts.document.versions.title": "Változatok",
		"artifacts.document.versions.current": "Jelenlegi",
		"artifacts.document.versions.restore": "Visszaállítás",
		"artifacts.document.versions.restoreConfirm":
			"Visszaállítod ezt a változatot? A jelenlegi is megmarad változatként.",
		"artifacts.document.versions.byUser": "Te",
		"artifacts.document.versions.byAlfy": "Alfy",
		"artifacts.document.versions.conflict":
			"Ez a dokumentum máshol megváltozott. Töltsd újra a jelenlegi szövegért.",
		"artifacts.document.versions.loadError":
			"Nem sikerült betölteni az előzményeket.",
		"artifacts.document.versions.restoreError":
			"Nem sikerült visszaállítani ezt a változatot.",
		"artifacts.document.versions.empty": "Még nincs korábbi változat.",
		"artifacts.document.editor.placeholder": "Írj bármit, vagy kérd meg Alfyt.",
		"artifacts.document.editor.failedToLoad":
			"A szerkesztőt nem sikerült betölteni.",
		"artifacts.document.toolbar.bold": "Félkövér",
		"artifacts.document.toolbar.italic": "Dőlt",
		"artifacts.document.toolbar.strike": "Áthúzott",
		"artifacts.document.toolbar.heading": "Címsor {n}",
		"artifacts.document.toolbar.bullets": "Felsorolás",
		"artifacts.document.toolbar.numbers": "Számozott lista",
		"artifacts.document.toolbar.tasks": "Feladatlista",
		"artifacts.document.toolbar.quote": "Idézet",
		"artifacts.document.toolbar.code": "Kód",
		"artifacts.document.toolbar.table": "Táblázat",
		"artifacts.document.toolbar.link": "Hivatkozás",
		"artifacts.document.toolbar.undo": "Visszavonás",
		"artifacts.document.toolbar.redo": "Újra",
		"artifacts.document.toolbar.more": "Több",
		"artifacts.document.save.offline":
			"Még nincs elmentve — nincs kapcsolat. A szöveged itt biztonságban van.",
		"artifacts.document.save.tooLarge":
			"Ez a dokumentum túl hosszú ahhoz, hogy elmentsük.",
		"artifacts.document.deleted":
			"Ezt a dokumentumot törölték, amíg nyitva volt. A szöveged még itt van.",
		"artifacts.document.deleted.saveCopy": "Mentés új dokumentumként",
		"artifacts.document.notFound": "Ez a dokumentum nem érhető el.",
		"artifacts.document.anchor.exact": "Pontos",
		"artifacts.document.anchor.moved": "Elmozdult",
		"artifacts.document.anchor.orphaned": "Elárvult",
		"artifacts.document.comment.ask": "Alfy megkérdezése",
		"artifacts.document.comment.add": "Megjegyzés",
		"artifacts.document.comment.placeholder": "Írj egy megjegyzést…",
		"artifacts.document.comment.submit": "Küldés",
		"artifacts.document.comment.cancel": "Mégse",
		"artifacts.document.comment.reply": "Válasz",
		"artifacts.document.comment.resolve": "Lezárás",
		"artifacts.document.comment.reopen": "Újranyitás",
		"artifacts.document.comment.resolved": "Lezárva",
		"artifacts.document.comment.askingAlfy": "Alfy válaszol…",
		"artifacts.document.comment.alfyRefused":
			"A szöveget változatlanul hagytam — ez a megjegyzés nem vezetett biztonságosan végrehajtható módosításhoz.",
		"artifacts.document.comment.alfyDone": "Kész.",
		"artifacts.document.comment.postError": "Nem sikerült elküldeni a megjegyzést.",
		"artifacts.document.margin.title": "Megjegyzések",
		"artifacts.document.margin.empty": "Még nincs megjegyzés.",
	},
} as const;

export default artifactsDict;
