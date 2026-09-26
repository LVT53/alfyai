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
		"artifacts.document.toolbar.download": "Download",
		"artifacts.document.toolbar.history": "History",
		"artifacts.document.save.offline":
			"Not saved yet — you are offline. Your text is safe here.",
		"artifacts.document.save.tooLarge": "This document is too long to save.",
		"artifacts.document.deleted":
			"This document was deleted while it was open. Your text is still here.",
		"artifacts.document.deleted.saveCopy": "Save it as a new document",
		"artifacts.document.notFound": "This document is not available.",
		// The inline change mark's bar (Slice 1, T8): "Alfy · Keep · Undo".
		"artifacts.document.change.alfy": "Alfy",
		"artifacts.document.change.keep": "Keep",
		"artifacts.document.change.undo": "Undo",
		"artifacts.document.change.keptNotice": "Kept.",
		"artifacts.document.change.undoneNotice": "Undone — your text is back.",
		"artifacts.document.change.commentCountA11y":
			"{count} {count, plural, one {comment} other {comments}} on this change",
		// The visible refusal (Slice 1, T8) — "your words win" is only a
		// feature if the user can see it happened.
		"artifacts.document.refused.notice":
			"{count, plural, one {Alfy left one part alone because you had changed it.} other {Alfy left some parts alone because you had changed them.}}",
		"artifacts.document.refused.changed":
			"you changed this after Alfy last read it",
		"artifacts.document.refused.unseen": "Alfy has not read this part yet",
		"artifacts.document.refused.missing": "this part no longer exists",
		"artifacts.document.refused.ambiguous":
			"the text Alfy wanted to replace is not unique here",
		"artifacts.document.refused.other": "Alfy could not apply this change",
		"artifacts.document.refused.seeChange": "See what Alfy did",
		// The planned-section shimmer while a tool call is in flight (Slice 1, T8).
		"artifacts.document.planned.writing": "Alfy is writing: {label}",
		// Tabs (Slice 1, T9).
		"artifacts.document.cardSubtitle": "Document · {count} tabs",
		"artifacts.document.tab.add": "Add a tab",
		"artifacts.document.tab.rename": "Rename",
		"artifacts.document.tab.delete": "Delete tab",
		"artifacts.document.tab.deleteConfirm": "Delete “{name}” and its text?",
		"artifacts.document.tab.renamePrompt": "Rename this tab",
		"artifacts.document.tab.newTabTitle": "New section",
		// Tracker chips (Slice 1, T9) — stored values are canonical English
		// tokens; only the label is localised (Global Constraints, Review Focus 8).
		"artifacts.document.chip.status.Booked": "Booked",
		"artifacts.document.chip.status.ToBook": "To book",
		"artifacts.document.chip.status.Paid": "Paid",
		"artifacts.document.chip.status.Cancelled": "Cancelled",
		// The mobile toolbar's overflow sheet (Slice 1, T11). `toolbar.more`
		// already exists (T7) as the trigger button's own label.
		"artifacts.document.toolbar.moreSheetTitle": "More formatting",
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
		"artifacts.document.comment.alfyPartialRefusal":
			"Part of this could not be applied safely.",
		"artifacts.document.comment.postError": "Could not post this comment.",
		"artifacts.document.margin.title": "Comments",
		"artifacts.document.margin.empty": "No comments yet.",
		// The orphaned-comment group (margin placement follow-up): threads whose
		// anchored text is gone have nowhere to sit beside, so they render in
		// their own labelled section below the position-synced ones.
		"artifacts.document.margin.orphanedGroup": "No longer in the document",
		// The download sheet (Slice 1, T12).
		"artifacts.document.export.title": "Download {title}",
		"artifacts.document.export.pdf": "PDF",
		"artifacts.document.export.docx": "Word",
		"artifacts.document.export.markdown": "Markdown",
		"artifacts.document.export.preparing": "Preparing your file…",
		"artifacts.document.export.failed": "Could not create this file.",
		"artifacts.document.export.tooLarge":
			"This document is too long to export.",
		"artifacts.document.export.noConversation":
			"This document isn't in a conversation yet, so it can't be exported.",
		"artifacts.document.export.tryAgain": "Try again",
		"artifacts.document.export.close": "Close",
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
		"artifacts.document.toolbar.download": "Letöltés",
		"artifacts.document.toolbar.history": "Előzmények",
		"artifacts.document.save.offline":
			"Még nincs elmentve — nincs kapcsolat. A szöveged itt biztonságban van.",
		"artifacts.document.save.tooLarge":
			"Ez a dokumentum túl hosszú ahhoz, hogy elmentsük.",
		"artifacts.document.deleted":
			"Ezt a dokumentumot törölték, amíg nyitva volt. A szöveged még itt van.",
		"artifacts.document.deleted.saveCopy": "Mentés új dokumentumként",
		"artifacts.document.notFound": "Ez a dokumentum nem érhető el.",
		"artifacts.document.change.alfy": "Alfy",
		"artifacts.document.change.keep": "Megtartom",
		"artifacts.document.change.undo": "Visszavonom",
		"artifacts.document.change.keptNotice": "Megtartva.",
		"artifacts.document.change.undoneNotice":
			"Visszavonva — a szöveged visszaállt.",
		"artifacts.document.change.commentCountA11y":
			"{count} megjegyzés ehhez a módosításhoz",
		"artifacts.document.refused.notice":
			"{count, plural, one {Alfy egy részt nem érintett, mert megváltoztattad.} other {Alfy néhány részt nem érintett, mert megváltoztattad.}}",
		"artifacts.document.refused.changed":
			"ezt megváltoztattad, miután Alfy utoljára olvasta",
		"artifacts.document.refused.unseen": "Alfy még nem olvasta ezt a részt",
		"artifacts.document.refused.missing": "ez a rész már nincs meg",
		"artifacts.document.refused.ambiguous":
			"a szöveg, amit Alfy le akart cserélni, nem egyedi itt",
		"artifacts.document.refused.other":
			"Alfy nem tudta alkalmazni ezt a módosítást",
		"artifacts.document.refused.seeChange": "Nézd meg, mit csinált Alfy",
		"artifacts.document.planned.writing": "Alfy írja: {label}",
		"artifacts.document.cardSubtitle": "Dokumentum · {count} fül",
		"artifacts.document.tab.add": "Fül hozzáadása",
		"artifacts.document.tab.rename": "Átnevezés",
		"artifacts.document.tab.delete": "Fül törlése",
		"artifacts.document.tab.deleteConfirm":
			"Törlöd a(z) „{name}” fület és a szövegét?",
		"artifacts.document.tab.renamePrompt": "Nevezd át ezt a fület",
		"artifacts.document.tab.newTabTitle": "Új szakasz",
		"artifacts.document.chip.status.Booked": "Lefoglalva",
		"artifacts.document.chip.status.ToBook": "Lefoglalandó",
		"artifacts.document.chip.status.Paid": "Kifizetve",
		"artifacts.document.chip.status.Cancelled": "Lemondva",
		"artifacts.document.toolbar.moreSheetTitle": "További formázás",
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
		"artifacts.document.comment.alfyPartialRefusal":
			"Ennek egy részét nem tudtam biztonságosan végrehajtani.",
		"artifacts.document.comment.postError":
			"Nem sikerült elküldeni a megjegyzést.",
		"artifacts.document.margin.title": "Megjegyzések",
		"artifacts.document.margin.empty": "Még nincs megjegyzés.",
		"artifacts.document.margin.orphanedGroup": "Már nincs a dokumentumban",
		"artifacts.document.export.title": "{title} letöltése",
		"artifacts.document.export.pdf": "PDF",
		"artifacts.document.export.docx": "Word",
		"artifacts.document.export.markdown": "Markdown",
		"artifacts.document.export.preparing": "A fájl előkészítése…",
		"artifacts.document.export.failed": "Nem sikerült létrehozni ezt a fájlt.",
		"artifacts.document.export.tooLarge":
			"Ez a dokumentum túl hosszú az exportáláshoz.",
		"artifacts.document.export.noConversation":
			"Ez a dokumentum még nincs beszélgetéshez rendelve, ezért nem exportálható.",
		"artifacts.document.export.tryAgain": "Újrapróbálom",
		"artifacts.document.export.close": "Bezárás",
	},
} as const;

export default artifactsDict;
