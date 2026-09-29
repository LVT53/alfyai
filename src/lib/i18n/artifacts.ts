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
		// The dot state (redesign §5.2/§5.3): a change is waiting while the
		// panel is closed. The dot itself is decorative (aria-hidden) — this is
		// how a screen reader user gets the same information.
		"artifacts.header.buttonA11yPending":
			"Open what this chat made ({count}) — a change is waiting",
		// Wave 2.5 review (F2): the panel header's meta line (redesign §5.2/§8
		// "kind · version · edited") was missing the mockup's own authorship —
		// index.html's `editedWhen` ("You and Alfy · edited {when}"). `when` is
		// already-localised relative time (formatRelativeTime), so this string
		// only wraps it, matching ArtifactPanelHeader.svelte's own `meta` prop
		// doc comment example.
		"artifacts.header.editedBy": "You and Alfy · edited {when}",
		// Redesign §9.2, Wave 2.5 Step 12: "composer placeholder names the open
		// item" — the chat page's own composer, while a document/app/etc. is
		// open in the panel. `src/routes/(app)/chat/[conversationId]/+page.svelte`.
		"artifacts.chat.composerPlaceholder": "Ask about {title}",
		// Wave 2.5 Step 13: the App's own phrasing — "ask Alfy to CHANGE it",
		// matching the panel's own "Change this app…" button, rather than the
		// generic "ask about" every other kind uses.
		"artifacts.chat.composerPlaceholderApp": "Ask Alfy to change {title}…",
		// The panel's list state (surface 2).
		"artifacts.panel.eyebrow": "This chat",
		"artifacts.panel.title": "What this chat made",
		"artifacts.panel.count":
			"{count} {count, plural, one {item} other {items}} · newest first",
		"artifacts.panel.list": "Show list",
		"artifacts.panel.back": "Back to the item",
		"artifacts.panel.empty": "Nothing made here yet.",
		"artifacts.panel.history": "History",
		// The panel landmark's own name while an item is open: what it shows, not
		// one generic name for every item (rd/review-2-5.md:276-279).
		"artifacts.panel.landmark": "{title}, {kind}",
		// The list row's / chat card's pending-review pill (redesign §5.2),
		// fed by the PERSISTED `pendingReviewCount` (Wave 2.5 review, F1).
		"artifacts.panel.pendingReview":
			"{count} {count, plural, one {change} other {changes}} to review",
		// The mockup's own `reviewed` string (§4.2 "the card reads ✓
		// Reviewed"): shown instead of `pendingReview` once
		// `pendingReviewCount` reads exactly 0 — a marker exists (this
		// artifact WAS edited by Alfy) and nothing is pending right now,
		// distinct from a document that was never touched at all (which
		// shows neither pill).
		"artifacts.panel.reviewed": "Reviewed",
		// The in-chat card's second pill (redesign §4.2 "The chat side", Wave 2.5
		// Step 11): the count of undismissed refusal notes, independent from
		// pendingReview above — `ToolActivityRow.svelte`'s own `artifactCardView`
		// feeds both from the SAME `alfyActivity`. Mirrors the mockup's own
		// `oneLeft`/`revLeft` copy family.
		"artifacts.panel.leftAlone":
			"{count} {count, plural, one {part} other {parts}} left alone",
		"artifacts.panel.backA11y":
			"Back to This chat ({count} {count, plural, one {item} other {items}})",
		// The shared card.
		"artifacts.card.open": "Open",
		"artifacts.card.openA11y": "Open {title}",
		// chrome="full"'s standalone in-chat card (Wave 2.5 Step 12): the head's
		// trailing affordance when the item is the one already open in the panel,
		// or when an Alfy edit is waiting for review — see ArtifactCardView's
		// `current`/`pendingReviewCount` doc comments.
		"artifacts.card.openInPanel": "Open in panel",
		"artifacts.card.review": "Review",
		"artifacts.card.madeBy": "made by Alfy {when}",
		"artifacts.card.version": "v{n}",
		"artifacts.card.versionA11y": "Version {n}",
		// A checklist card's tickable body (slice 0 ships the seam; slice 1 is
		// the first caller) shows the first five items and this for the rest.
		"artifacts.card.moreItems": "+{count} more",
		// chrome="full" (Wave 2.5 Step 12/13): the create_artifact "creating"
		// skeleton state's subtitle, and the "failed" state's title — the
		// card's own reason text (`ArtifactCardView.failedReason`) is caller-
		// supplied already-resolved plain text and needs no key of its own.
		"artifacts.card.creatingSubtitle": "Alfy is writing…",
		"artifacts.card.failedTitle": "Alfy couldn't make this.",
		// The five kinds.
		// Delete (polish G2-A): the panel header's and the list row's Delete, and
		// its confirm. Every string names the KIND (ADR-0066) — never the
		// engineering word — and each kind is its own key because Hungarian
		// takes a different article and ending per noun.
		"artifacts.delete.button.document": "Delete document",
		"artifacts.delete.button.app": "Delete app",
		"artifacts.delete.button.canvas": "Delete canvas",
		"artifacts.delete.button.slides": "Delete slides",
		"artifacts.delete.button.file": "Delete file",
		"artifacts.delete.title.document": "Delete this document?",
		"artifacts.delete.title.app": "Delete this app?",
		"artifacts.delete.title.canvas": "Delete this canvas?",
		"artifacts.delete.title.slides": "Delete these slides?",
		"artifacts.delete.title.file": "Delete this file?",
		"artifacts.delete.body.document":
			"“{title}” and its versions and comments will be deleted. This can't be undone.",
		"artifacts.delete.body.app":
			"“{title}” and its saved data will be deleted. This can't be undone.",
		"artifacts.delete.body.canvas":
			"“{title}” and its versions and comments will be deleted. This can't be undone.",
		"artifacts.delete.body.slides":
			"“{title}” and its versions and comments will be deleted. This can't be undone.",
		"artifacts.delete.body.file":
			"“{title}” will be deleted. This can't be undone.",
		// The same confirm for an item the chat can make again (the security
		// review's L2): "can't be undone" is not true of it, so it says the way back.
		"artifacts.delete.bodyRegenerable.document":
			"“{title}” and its versions and comments will be deleted. You can regenerate it from the chat.",
		"artifacts.delete.bodyRegenerable.app":
			"“{title}” and its saved data will be deleted. You can regenerate it from the chat.",
		"artifacts.delete.bodyRegenerable.canvas":
			"“{title}” and its versions and comments will be deleted. You can regenerate it from the chat.",
		"artifacts.delete.bodyRegenerable.slides":
			"“{title}” and its versions and comments will be deleted. You can regenerate it from the chat.",
		"artifacts.delete.bodyRegenerable.file":
			"“{title}” will be deleted. You can regenerate it from the chat.",
		"artifacts.delete.busy": "Deleting…",
		"artifacts.delete.failed": "Couldn't delete this. Try again.",
		"artifacts.delete.done.document": "Document deleted",
		"artifacts.delete.done.app": "App deleted",
		"artifacts.delete.done.canvas": "Canvas deleted",
		"artifacts.delete.done.slides": "Slides deleted",
		"artifacts.delete.done.file": "File deleted",
		"artifacts.delete.rowMenu": "More actions for {title}",
		// What a chat card or file row says once its item is gone (polish G2-A),
		// per kind, and its Regenerate.
		"artifacts.deleted.document": "This document was deleted",
		"artifacts.deleted.app": "This app was deleted",
		"artifacts.deleted.canvas": "This canvas was deleted",
		"artifacts.deleted.slides": "These slides were deleted",
		"artifacts.deleted.file": "The file has been deleted",
		"artifacts.deleted.regenerate": "Regenerate",
		"artifacts.deleted.regenerateA11y": "Regenerate {title}",
		"artifacts.deleted.regenerating": "Regenerating…",
		"artifacts.deleted.unavailable":
			"It can't be regenerated: the original request wasn't kept.",
		"artifacts.deleted.regenerateFailed":
			"Couldn't regenerate this. Try again.",
		"artifacts.deleted.regenerated": "Regenerated “{title}”",
		// An item that exists but sits out of this chat's reach — the parent of a
		// forked incognito chat (the security review's M1): not deleted, so it is
		// never called that, and nothing offers to make it again.
		"artifacts.madeInOriginalChat": "Made in the original chat",
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
		// Wave 2.5 Step 13: the trigger button beside the segmented control —
		// was "Ask Alfy for a new version" (the old modal's own title); the
		// popover it now opens carries that fuller meaning instead (see
		// `regenerate.prompt`/`regenerate.effect` below).
		"artifacts.app.action.regenerate": "Change this app…",
		"artifacts.app.action.download": "Download as .html",
		"artifacts.app.regenerate.prompt": "What should change?",
		"artifacts.app.regenerate.cancel": "Cancel",
		"artifacts.app.regenerate.makeV2": "Make v2",
		"artifacts.app.regenerate.effect":
			"Alfy writes a new version and checks its facts. v1 stays in History.",
		"artifacts.app.regenerate.building":
			"Alfy is building v2 · v1 stays until v2 is ready. Your saved data is kept.",
		"artifacts.app.regenerate.failed":
			"Alfy couldn't make v2. v1 is unchanged.",
		"artifacts.app.toast.v2Ready": "Now showing v2",
		"artifacts.app.toast.undo": "Undo",
		"artifacts.app.sandboxBar":
			"Runs sandboxed · no internet · keeps your data",
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
		"artifacts.app.verify.readNote": "Read Alfy's note",
		"artifacts.app.toast.undoFailed": "Couldn't undo this.",
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
		// Wave 2.5 Step 8: the inline confirm (redesign §3.2 — never a modal),
		// named by version number so it reads as a real question about a real
		// row, not the old generic "this version".
		"artifacts.document.versions.restoreConfirm":
			"Restore v{v}? Your current text stays as a version.",
		"artifacts.document.versions.restoreToast": "Restored v{from} as v{to}",
		"artifacts.document.versions.undo": "Undo",
		"artifacts.document.versions.byUser": "You",
		"artifacts.document.versions.byAlfy": "Alfy",
		"artifacts.document.versions.conflict":
			"This document changed elsewhere. Reload to see the current text.",
		"artifacts.document.versions.loadError":
			"Could not load the version history.",
		"artifacts.document.versions.restoreError":
			"Could not restore this version.",
		"artifacts.document.versions.empty": "No earlier versions yet.",
		// A version's own summary line (rd/review-2-5.md:256-260): the save
		// route's literal "Edited" and the restore handler's "restored …"
		// wrapper are the only two server-written tokens localized here — an
		// Alfy-authored summary is free-form content and is shown as-is.
		"artifacts.document.versions.summaryEdited": "Edited",
		"artifacts.document.versions.summaryRestored": "restored {summary}",
		"artifacts.document.versions.summaryRestoredFrom": "Restored v{n}",
		"artifacts.document.versions.summaryUndidAlfyChange": "Undid Alfy's change",
		"artifacts.document.versions.summaryFirstDraft":
			"Alfy wrote the first draft",
		"artifacts.document.versions.summarySavedAsCopy": "Saved as a new document",
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
		// The tooltip and accessible name of those two buttons: the label and the
		// keys that do the same ({shortcut} is ⌘Z, Ctrl+Y, … for the reader's platform).
		"artifacts.document.toolbar.undoWithShortcut": "Undo ({shortcut})",
		"artifacts.document.toolbar.redoWithShortcut": "Redo ({shortcut})",
		"artifacts.document.toolbar.more": "More",
		"artifacts.document.toolbar.download": "Download",
		"artifacts.document.toolbar.history": "History",
		"artifacts.document.toolbar.saveState.saving": "Saving…",
		"artifacts.document.toolbar.saveState.saved": "Saved",
		"artifacts.document.toolbar.saveState.offline": "Offline",
		"artifacts.document.toolbar.saveState.conflict": "Conflict",
		"artifacts.document.save.offline":
			"Not saved yet — you are offline. Your text is safe here.",
		"artifacts.document.save.tooLarge": "This document is too long to save.",
		"artifacts.document.deleted":
			"This document was deleted while it was open. Your text is still here.",
		"artifacts.document.deleted.saveCopy": "Save it as a new document",
		"artifacts.document.notFound": "This document is not available.",
		// The inline change pill (Slice 1, T8; redesigned Wave 2.5 Step 10 as a
		// ProseMirror widget decoration): "✦ Alfy · Keep · Undo", "Redo" after
		// Undo (redesign §7.2 #13/#14: "Kept"/"Undone · Redo").
		"artifacts.document.change.alfy": "Alfy",
		"artifacts.document.change.keep": "Keep",
		"artifacts.document.change.undo": "Undo",
		"artifacts.document.change.redo": "Redo",
		"artifacts.document.change.keptNotice": "Kept",
		"artifacts.document.change.undoneNotice": "Undone",
		"artifacts.document.change.commentCountA11y":
			"{count} {count, plural, one {comment} other {comments}} on this change",
		// §4.4: the pill is `role="group"` named "Alfy's change: '…'"; its own
		// buttons keep short VISIBLE text (above) but a fuller accessible name.
		"artifacts.document.change.groupLabel": "Alfy's change: {quote}",
		"artifacts.document.change.keepA11y": "Keep Alfy's change",
		"artifacts.document.change.undoA11y": "Undo Alfy's change",
		"artifacts.document.change.redoA11y": "Redo Alfy's change",
		// The tooltips of the pill's Undo and Redo: the same wording and the chord
		// that does it from the keyboard ({shortcut}: ⌥⌘Z, Ctrl+Alt+Z, …).
		"artifacts.document.change.undoWithShortcut":
			"Undo Alfy's change ({shortcut})",
		"artifacts.document.change.redoWithShortcut":
			"Redo Alfy's change ({shortcut})",
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
		// The pinned refusal card's own dismiss action (redesign §4.2's
		// "your words win" card, Wave 2.5 Step 11) — `askAgain` reuses the
		// comment family's existing key below rather than a second translation
		// of the same action, so the two "Ask again"s read as one family.
		"artifacts.document.refused.dismiss": "Dismiss",
		// The review bar's own "Left N alone." link (redesign §4.2 item 5, §8's
		// RefusalNotice row: "the one-line summary for ReviewBar") — exported for
		// a later Wave 2.5 agent's ReviewBar.svelte to read, so its own count
		// never drifts from this card's. Mirrors the mockup's `revLeft`.
		"artifacts.document.refused.reviewBarLeft": "Left {count} alone.",
		// The shared review bar (redesign §4.2 item 5/6, §8's `ReviewBar` row,
		// Wave 2.5 Step 10) — "Alfy changed N part(s).", the stepper, Keep all /
		// Undo all. `regionLabel` and `summary` together are also this
		// component's own polite landing announcement (§4.4: "Alfy changed 1
		// part and left 1 alone. Review it below the text.") — the region is
		// already populated with both sentences when it enters the DOM.
		"artifacts.document.review.regionLabel": "Changes from Alfy",
		// A `{count}` nested INSIDE a plural branch (the form this key used
		// before) never resolves: `index.ts`'s own plural regex captures each
		// branch as `[^{}]*` (no braces allowed inside), so a branch
		// containing its own `{count}` fails to match the plural pattern at
		// all, leaving the raw `{count, plural, ...}` template in the
		// rendered text (masked in this file's own tests, since
		// `toHaveTextContent`'s substring match still finds "Alfy changed 3
		// parts." INSIDE that unresolved template). `{count}` now sits
		// OUTSIDE the plural block instead, the same shape `panel.count`/
		// `panel.pendingReview` above already use correctly.
		"artifacts.document.review.summary":
			"Alfy changed {count} {count, plural, one {part} other {parts}}.",
		"artifacts.document.review.prev": "Previous change",
		"artifacts.document.review.next": "Next change",
		"artifacts.document.review.keepAll": "Keep all",
		"artifacts.document.review.undoAll": "Undo all",
		// The planned-section shimmer while a tool call is in flight (Slice 1, T8).
		"artifacts.document.planned.writing": "Alfy is writing: {label}",
		// Tabs (Slice 1, T9).
		"artifacts.document.cardSubtitle":
			"Document · {count} {count, plural, one {tab} other {tabs}}",
		"artifacts.document.tab.add": "Add a tab",
		"artifacts.document.tab.menu": "Tab options",
		"artifacts.document.tab.rename": "Rename",
		"artifacts.document.tab.delete": "Delete tab",
		"artifacts.document.tab.deleteConfirm": "Delete “{name}” and its text?",
		"artifacts.document.tab.renamePrompt": "Rename this tab",
		"artifacts.document.tab.newTabTitle": "New section",
		// The tab strip's own open-comment badge (rd/review-2-5.md:223-228):
		// the visible number is `aria-hidden`, this sr-only phrase is what a
		// screen reader hears instead of a bare "3". `{count}` sits OUTSIDE
		// the plural block on purpose — see `review.summary`'s own comment
		// above for why a `{count}` nested INSIDE a branch never resolves.
		"artifacts.document.tab.openCommentsA11y":
			"{count} {count, plural, one {open comment} other {open comments}}",
		// Tracker chips (Slice 1, T9) — stored values are canonical English
		// tokens; only the label is localised (Global Constraints, Review Focus 8).
		"artifacts.document.chip.status.Booked": "Booked",
		"artifacts.document.chip.status.ToBook": "To book",
		"artifacts.document.chip.status.Paid": "Paid",
		"artifacts.document.chip.status.Cancelled": "Cancelled",
		// The chip dropdown's own accessible name (rd/review-2-5.md:256-260):
		// the FIELD's name ("Status"), distinct from the value labels above.
		"artifacts.document.chip.statusFieldLabel": "Status",
		"artifacts.document.chip.dateFieldLabel": "Date",
		// The task checklist checkbox's own accessible name
		// (rd/review-2-5.md:256-260) — Tiptap's own default is English-only
		// ("Task item checkbox for …"); localized here via TaskItem's `a11y`
		// option.
		"artifacts.document.taskItem.checkboxLabel":
			"Task item checkbox for {text}",
		"artifacts.document.taskItem.emptyTaskItem": "empty task item",
		// The mobile toolbar's overflow sheet (Slice 1, T11). `toolbar.more`
		// already exists (T7) as the trigger button's own label.
		"artifacts.document.toolbar.moreSheetTitle": "More formatting",
		// Comments and @Alfy (Slice 1, T10). CommentCard reuses
		// artifacts.document.versions.byUser/byAlfy for the author name rather
		// than a second pair of the same two words.
		"artifacts.document.anchor.moved": "Moved",
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
		// Comment card anatomy (redesign §3.2/§8, Wave 2.5 Step 6): the Guess
		// tag on Alfy's own judgement-call threads, the change chip embedded in
		// a reply that edited the text, and the refused-reply quick action.
		"artifacts.document.comment.guessTag": "Guess",
		"artifacts.document.comment.askAgain": "Ask again",
		"artifacts.document.comment.changeEdited": "Edited · waiting for you",
		"artifacts.document.comment.changeKept": "Kept",
		"artifacts.document.comment.changeUndone": "Undone",
		"artifacts.document.comment.seeChange": "See change",
		"artifacts.document.comment.alfyTyping": "Alfy is writing…",
		"artifacts.document.comment.replyPlaceholder": "Reply, or ask @Alfy…",
		"artifacts.document.comment.askAlfyHint":
			"Alfy answers here and can edit the text. You keep or undo the change.",
		"artifacts.document.comment.peekThread": "Show the full thread",
		"artifacts.document.comment.quoteA11y": "Show “{quote}” in the text",
		// Fed into DocumentBody.svelte's one shared announcer
		// (rd/review-2-5.md:217-222) — Keep/Undo reuse the existing
		// change.keptNotice/undoneNotice keys above rather than duplicating
		// them here.
		"artifacts.document.announce.commentAdded": "Comment added.",
		"artifacts.document.announce.commentResolved": "Comment resolved.",
		"artifacts.document.announce.commentReopened": "Comment reopened.",
		"artifacts.document.announce.alfyReplied": "Alfy replied.",
		// The selection pill and composer (redesign §4.2 items 1–2, §9.2's
		// SelectionBubble.svelte row, Wave 2.5 Step 9). `comment.ask`/`comment.add`
		// above are reused for both the pill's own buttons AND the composer's
		// send button (Ask mode) — the mockup's own `askSend` is the identical
		// string as its `askAlfy` pill label, so this file does not duplicate it.
		"artifacts.document.comment.selectionToolbar": "Selection",
		"artifacts.document.comment.askHeader": "Ask Alfy about “{quote}”",
		"artifacts.document.comment.commentHeader": "Comment on “{quote}”",
		"artifacts.document.comment.askPlaceholder":
			"What should Alfy do with this text?",
		"artifacts.document.comment.askEffect":
			"Alfy replies in the margin and marks its change here, for you to keep or undo.",
		"artifacts.document.comment.mentionHint":
			"Mention @Alfy to get an answer and an edit.",
		"artifacts.document.comment.chipLessList": "Less like a list",
		"artifacts.document.comment.chipShorter": "Shorter",
		"artifacts.document.comment.chipFriendlier": "Friendlier",
		"artifacts.document.comment.chipHungarian": "In Hungarian",
		// "Alfy is writing" in place on the target block (redesign §4.2 item 4,
		// Wave 2.5 Step 11) — the inline tag a ProseMirror widget decoration
		// renders at the end of the block; distinct from `planned.writing`
		// above, which names a block by its label for the T8-live case where no
		// specific block is known yet (see `alfy-writing-decoration.ts`).
		"artifacts.document.writing.tag": "Alfy is writing…",
		"artifacts.document.margin.title": "Comments",
		// Wave 2.5 Step 8: the header's Comments button, only while it has an
		// open count to report — the button falls back to the plain title
		// above at zero (`DocumentWorkspace.svelte`), matching
		// `artifacts.header.buttonA11y`'s own "never draw a bare 0" rule.
		"artifacts.document.margin.buttonA11y": "Comments ({count})",
		// Redesign §3.3: the rail is per-tab now, so the empty state also
		// carries "select text to start one" and coexists with the "in other
		// tabs" list rather than replacing it.
		"artifacts.document.margin.empty":
			"No comments on this tab. Select text to start one.",
		// The orphaned-comment group (margin placement follow-up): threads whose
		// anchored text is gone have nowhere to sit beside, so they render in
		// their own labelled, foldable section below the position-synced ones.
		"artifacts.document.margin.orphanedGroup":
			"{count} {count, plural, one {comment} other {comments}} on text that was removed",
		// Ruling 61: Open by default, with a quiet toggle to All — never the
		// mockup's own two-button "Open 4 | All 6" segmented filter.
		"artifacts.document.margin.resolvedToggle": "{count} resolved",
		"artifacts.document.margin.showOpenOnly": "Show open only",
		// "In other tabs" (redesign §3.2): one row per other tab, its own
		// title plus this counts suffix — never interpolated into one string,
		// since a tab's title is arbitrary user text.
		"artifacts.document.margin.otherTabs": "In other tabs",
		// One row's counts are joined from these two so a zero never shows
		// ("1 open", never "1 open · 0 resolved"); a tab's title is arbitrary
		// user text and is never interpolated into either.
		"artifacts.document.margin.otherTabOpen": "{count} open",
		"artifacts.document.margin.otherTabResolved": "{count} resolved",
		// The rail header's count (open threads on this tab) and its empty
		// states. A document with one section has no "tab" to name.
		"artifacts.document.margin.countA11y":
			"{count} {count, plural, one {open comment} other {open comments}}",
		"artifacts.document.margin.emptyDocument":
			"No comments yet. Select text to start one.",
		"artifacts.document.margin.emptyAllResolved":
			"Every comment here is resolved.",
		// The header's Comments button is a toggle for the comment column
		// (the button's pressed state says which); its tooltip names the
		// action rather than the noun.
		"artifacts.document.margin.hide": "Hide comments",
		"artifacts.document.margin.show": "Show comments",
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
		// Slice 3 (Canvas), the ops protocol's own strings: why a change to the
		// board was skipped (`board-ops.ts`'s `refusalLabelKey`), and the one line
		// for a change that could not be read at all. The board's own strings
		// (toolbar, blocks, pins) are the board agent's block.
		"artifacts.canvas.invalidDiff":
			"That change could not be read, so nothing moved.",
		"artifacts.canvas.refusal.unknown_id":
			"nothing is at that position any more",
		"artifacts.canvas.refusal.duplicate_id": "that id already exists",
		"artifacts.canvas.refusal.unknown_kind": "unknown block type",
		"artifacts.canvas.refusal.kind_mismatch":
			"a block cannot change type in place",
		"artifacts.canvas.refusal.missing_parent":
			"the frame it belongs to is missing",
		"artifacts.canvas.refusal.self_parent": "a frame cannot contain itself",
		"artifacts.canvas.refusal.cycle": "a frame cannot sit inside its own frame",
		"artifacts.canvas.refusal.invalid_data":
			"the block's content was not valid",
		"artifacts.canvas.refusal.limit_exceeded": "the board is at its limit",
		// Slice 3 (Canvas), the board's own strings: toolbar, insert menu,
		// blocks, the states of the panel's content area, the save line.
		"artifacts.canvas.toolbar": "Canvas tools",
		"artifacts.canvas.tool.select": "Select",
		"artifacts.canvas.tool.pan": "Pan",
		// Ruling 16: these undo the reader's OWN steps; Alfy's changes and an
		// earlier session's are restored through History, and are named differently.
		"artifacts.canvas.undo": "Undo your last step",
		"artifacts.canvas.redo": "Redo your step",
		"artifacts.canvas.insert": "Insert",
		"artifacts.canvas.insert.block": "Insert block",
		"artifacts.canvas.insert.text": "Text",
		"artifacts.canvas.insert.sticky": "Sticky note",
		"artifacts.canvas.insert.frame": "Frame",
		"artifacts.canvas.insert.chart": "Chart",
		"artifacts.canvas.insert.checklist": "Checklist",
		"artifacts.canvas.blockCount":
			"{count} {count, plural, one {block} other {blocks}}",
		"artifacts.canvas.blockMissingKind":
			"This block's type is not supported any more.",
		"artifacts.canvas.blockDropped":
			"{count} block(s) could not be read and were left out.",
		"artifacts.canvas.dismiss": "Dismiss",
		"artifacts.canvas.deleteBlock": "Delete block",
		"artifacts.canvas.nodeDeleted": "Deleted from the board.",
		"artifacts.canvas.tone": "Note colour",
		"artifacts.canvas.tone.yellow": "Yellow",
		"artifacts.canvas.tone.mint": "Mint",
		"artifacts.canvas.tone.blue": "Blue",
		"artifacts.canvas.tone.plain": "Plain",
		"artifacts.canvas.stickyPlaceholder": "Write a note…",
		"artifacts.canvas.textPlaceholder": "Write something…",
		"artifacts.canvas.frameName": "Frame name",
		"artifacts.canvas.checklistReadOnlyNote":
			"Ticks here are saved with the board.",
		"artifacts.canvas.checklistPlaceholder": "New item",
		"artifacts.canvas.checklistAdd": "Add item",
		"artifacts.canvas.checklistRemove": "Remove item",
		"artifacts.canvas.checklistToggle": "{name}: toggle done",
		"artifacts.canvas.zoom": "Zoom",
		"artifacts.canvas.zoomIn": "Zoom in",
		"artifacts.canvas.zoomOut": "Zoom out",
		"artifacts.canvas.fitView": "Fit to view",
		"artifacts.canvas.minimap": "Board overview",
		"artifacts.canvas.emptyBoard": "Empty board. Insert a block or draw on it.",
		"artifacts.canvas.loading": "Opening the board…",
		"artifacts.canvas.loadFailed": "Could not open the board.",
		"artifacts.canvas.retry": "Retry",
		"artifacts.canvas.reload": "Reload",
		"artifacts.canvas.saved": "Saved",
		"artifacts.canvas.saving": "Saving…",
		"artifacts.canvas.saveFailed": "Could not save the board.",
		"artifacts.canvas.saveConflict":
			"Someone changed the board while you were drawing. Reload to see the newest version.",
		"artifacts.canvas.offline":
			"You are offline. Your drawing is kept and will be saved when the connection is back.",
		"artifacts.canvas.tooLarge": "This board is too big to save.",
		"artifacts.canvas.deletedWhileOpen": "This board was deleted.",
		"artifacts.canvas.noAccess": "You do not have access to this board.",
		// What the flow library reads out for its own elements, in the reader's language.
		"artifacts.canvas.a11y.node":
			"Press Enter or Space to select a block. Press Delete to remove it and Escape to let go.",
		"artifacts.canvas.a11y.nodeKeyboard":
			"Press Enter or Space to select a block. You can then use the arrow keys to move it. Press Delete to remove it and Escape to let go.",
		"artifacts.canvas.a11y.moved":
			"Moved the selected block. New position, x: {x}, y: {y}",
		"artifacts.canvas.a11y.edge":
			"Press Enter or Space to select a connection. You can then press Delete to remove it or Escape to let go.",
		"artifacts.canvas.a11y.handle": "Connection point",
		// Frames and reparenting (S3-F): what a screen reader hears when a block
		// joins or leaves a frame by a drag.
		"artifacts.canvas.movedIntoFrame": "Moved into the frame {frame}.",
		"artifacts.canvas.movedOutOfFrame": "Moved out of the frame {frame}.",
		// The drawing layer (S3-F): tools, inks, and what the layer says about itself.
		"artifacts.canvas.tool.draw": "Draw",
		"artifacts.canvas.tool.pen": "Pen",
		"artifacts.canvas.tool.highlighter": "Highlighter",
		"artifacts.canvas.tool.line": "Line",
		"artifacts.canvas.tool.arrow": "Arrow",
		"artifacts.canvas.tool.rect": "Rectangle",
		"artifacts.canvas.tool.ellipse": "Ellipse",
		"artifacts.canvas.tool.text": "Text",
		"artifacts.canvas.tool.eraser": "Eraser",
		"artifacts.canvas.drawTools": "Drawing tools",
		"artifacts.canvas.ink.blue": "Blue ink",
		"artifacts.canvas.ink.red": "Red ink",
		"artifacts.canvas.ink.green": "Green ink",
		"artifacts.canvas.ink.graphite": "Graphite ink",
		"artifacts.canvas.drawingLayer": "Drawing layer",
		"artifacts.canvas.drawingLayer.marks":
			"{count} {count, plural, one {mark} other {marks}} drawn on the board.",
		"artifacts.canvas.textMark": "Text on the board",
		"artifacts.canvas.markDeleted": "Mark removed.",
		"artifacts.canvas.markErased": "Marks erased.",
		"artifacts.canvas.drawingLimit":
			"The board holds at most {count} marks. Erase one to draw more.",
	},
	hu: {
		"artifacts.header.buttonA11y":
			"Nyisd meg, amit ez a beszélgetés készített ({count})",
		"artifacts.header.buttonA11yPending":
			"Nyisd meg, amit ez a beszélgetés készített ({count}) — egy módosítás vár rád",
		"artifacts.header.editedBy": "Te és Alfy · szerkesztve {when}",
		// A kettőspont a "-ról/-ről" rag nélkül old meg egy tetszőleges,
		// felhasználó/AI adta címet — a magyar toldalék a cím végződésétől
		// függne, ami egy dinamikus értéknél nem garantálható.
		"artifacts.chat.composerPlaceholder": "Kérdezz erről: {title}",
		// Same colon trick as above, for the same reason.
		"artifacts.chat.composerPlaceholderApp":
			"Kérd meg Alfyt, hogy módosítsa ezt: {title}",
		"artifacts.panel.eyebrow": "Ez a beszélgetés",
		"artifacts.panel.title": "Amit ez a beszélgetés készített",
		"artifacts.panel.count": "{count} elem · legújabb elöl",
		"artifacts.panel.list": "Lista megjelenítése",
		"artifacts.panel.back": "Vissza az elemhez",
		"artifacts.panel.empty": "Itt még nem készült semmi.",
		"artifacts.panel.history": "Előzmények",
		"artifacts.panel.landmark": "{title}, {kind}",
		"artifacts.panel.pendingReview": "{count} módosítás vár rád",
		"artifacts.panel.reviewed": "Átnézve",
		// No ICU plural here on purpose, matching cardSubtitle above: Hungarian
		// nouns after a numeral stay singular.
		"artifacts.panel.leftAlone": "{count} részt nem érintett",
		"artifacts.panel.backA11y": "Vissza: Ez a beszélgetés ({count} elem)",
		"artifacts.card.open": "Megnyitás",
		"artifacts.card.openA11y": "{title} megnyitása",
		"artifacts.card.openInPanel": "Megnyitva a panelen",
		"artifacts.card.review": "Átnézés",
		"artifacts.card.madeBy": "Alfy készítette: {when}",
		"artifacts.card.version": "v{n}",
		"artifacts.card.versionA11y": "{n}. verzió",
		"artifacts.card.moreItems": "+{count} további",
		"artifacts.card.creatingSubtitle": "Alfy éppen ír…",
		"artifacts.card.failedTitle": "Alfynak ezt nem sikerült elkészítenie.",
		"artifacts.delete.button.document": "Dokumentum törlése",
		"artifacts.delete.button.app": "Alkalmazás törlése",
		"artifacts.delete.button.canvas": "Tábla törlése",
		"artifacts.delete.button.slides": "Diasor törlése",
		"artifacts.delete.button.file": "Fájl törlése",
		"artifacts.delete.title.document": "Törlöd ezt a dokumentumot?",
		"artifacts.delete.title.app": "Törlöd ezt az alkalmazást?",
		"artifacts.delete.title.canvas": "Törlöd ezt a táblát?",
		"artifacts.delete.title.slides": "Törlöd ezt a diasort?",
		"artifacts.delete.title.file": "Törlöd ezt a fájlt?",
		"artifacts.delete.body.document":
			"„{title}” és az összes verziója és megjegyzése törlődik. Ez nem vonható vissza.",
		"artifacts.delete.body.app":
			"„{title}” és a mentett adatai törlődnek. Ez nem vonható vissza.",
		"artifacts.delete.body.canvas":
			"„{title}” és az összes verziója és megjegyzése törlődik. Ez nem vonható vissza.",
		"artifacts.delete.body.slides":
			"„{title}” és az összes verziója és megjegyzése törlődik. Ez nem vonható vissza.",
		"artifacts.delete.body.file": "„{title}” törlődik. Ez nem vonható vissza.",
		"artifacts.delete.bodyRegenerable.document":
			"„{title}” és az összes verziója és megjegyzése törlődik. A beszélgetésből újra létrehozhatod.",
		"artifacts.delete.bodyRegenerable.app":
			"„{title}” és a mentett adatai törlődnek. A beszélgetésből újra létrehozhatod.",
		"artifacts.delete.bodyRegenerable.canvas":
			"„{title}” és az összes verziója és megjegyzése törlődik. A beszélgetésből újra létrehozhatod.",
		"artifacts.delete.bodyRegenerable.slides":
			"„{title}” és az összes verziója és megjegyzése törlődik. A beszélgetésből újra létrehozhatod.",
		"artifacts.delete.bodyRegenerable.file":
			"„{title}” törlődik. A beszélgetésből újra létrehozhatod.",
		"artifacts.delete.busy": "Törlés…",
		"artifacts.delete.failed": "Nem sikerült törölni. Próbáld újra.",
		"artifacts.delete.done.document": "Dokumentum törölve",
		"artifacts.delete.done.app": "Alkalmazás törölve",
		"artifacts.delete.done.canvas": "Tábla törölve",
		"artifacts.delete.done.slides": "Diasor törölve",
		"artifacts.delete.done.file": "Fájl törölve",
		"artifacts.delete.rowMenu": "További műveletek: {title}",
		"artifacts.deleted.document": "Ez a dokumentum törölve lett",
		"artifacts.deleted.app": "Ez az alkalmazás törölve lett",
		"artifacts.deleted.canvas": "Ez a tábla törölve lett",
		"artifacts.deleted.slides": "Ez a diasor törölve lett",
		"artifacts.deleted.file": "A fájl törölve lett",
		"artifacts.deleted.regenerate": "Újragenerálás",
		"artifacts.deleted.regenerateA11y": "{title} újragenerálása",
		"artifacts.deleted.regenerating": "Újragenerálás…",
		"artifacts.deleted.unavailable":
			"Nem generálható újra: az eredeti kérés nem maradt meg.",
		"artifacts.deleted.regenerateFailed":
			"Nem sikerült újragenerálni. Próbáld újra.",
		"artifacts.deleted.regenerated": "„{title}” újragenerálva",
		"artifacts.madeInOriginalChat": "Az eredeti beszélgetésben készült",
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
		// Ruling: "shortened on purpose so the row fits 390 px; the popover's
		// title carries the full meaning" (redesign §6.5's own HU allowance).
		"artifacts.app.action.regenerate": "Módosítás…",
		"artifacts.app.action.download": "Letöltés .html-ként",
		"artifacts.app.regenerate.prompt": "Min változtasson?",
		"artifacts.app.regenerate.cancel": "Mégse",
		"artifacts.app.regenerate.makeV2": "v2 elkészítése",
		"artifacts.app.regenerate.effect":
			"Alfy megírja az új változatot, és ellenőrzi az adatait. A v1 megmarad az Előzményekben.",
		"artifacts.app.regenerate.building":
			"Alfy készíti a v2-t · A v1 megmarad, amíg a v2 el nem készül. A mentett adataid megmaradnak.",
		"artifacts.app.regenerate.failed":
			"Alfynak nem sikerült elkészítenie a v2-t. A v1 változatlan.",
		"artifacts.app.toast.v2Ready": "Mostantól a v2 látszik",
		"artifacts.app.toast.undo": "Visszavonás",
		"artifacts.app.sandboxBar":
			"Homokozóban fut · nincs internet · megőrzi az adataidat",
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
		"artifacts.app.verify.readNote": "Alfy megjegyzésének elolvasása",
		"artifacts.app.toast.undoFailed": "Ezt nem sikerült visszavonni.",
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
		"artifacts.app.download.unavailable":
			"Ez az alkalmazás nincs beszélgetésben, ezért nem menthető fájlként.",
		"artifacts.app.download.failed":
			"Nem sikerült előkészíteni ezt az alkalmazást letöltésre.",
		"artifacts.app.open.cta": "Készíts alkalmazást",
		"artifacts.document.versions.title": "Változatok",
		"artifacts.document.versions.current": "Jelenlegi",
		"artifacts.document.versions.restore": "Visszaállítás",
		"artifacts.document.versions.restoreConfirm":
			"Visszaállítod a v{v} változatot? A jelenlegi szöveged megmarad változatként.",
		"artifacts.document.versions.restoreToast":
			"Visszaállítva: v{from} mint v{to}",
		"artifacts.document.versions.undo": "Visszavonás",
		"artifacts.document.versions.byUser": "Te",
		"artifacts.document.versions.byAlfy": "Alfy",
		"artifacts.document.versions.conflict":
			"Ez a dokumentum máshol megváltozott. Töltsd újra a jelenlegi szövegért.",
		"artifacts.document.versions.loadError":
			"Nem sikerült betölteni az előzményeket.",
		"artifacts.document.versions.restoreError":
			"Nem sikerült visszaállítani ezt a változatot.",
		"artifacts.document.versions.empty": "Még nincs korábbi változat.",
		"artifacts.document.versions.summaryEdited": "Szerkesztve",
		"artifacts.document.versions.summaryRestored": "visszaállítva: {summary}",
		"artifacts.document.versions.summaryRestoredFrom": "Visszaállítva: v{n}",
		"artifacts.document.versions.summaryUndidAlfyChange":
			"Alfy módosításának visszavonása",
		"artifacts.document.versions.summaryFirstDraft":
			"Alfy megírta az első vázlatot",
		"artifacts.document.versions.summarySavedAsCopy":
			"Mentve új dokumentumként",
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
		"artifacts.document.toolbar.undoWithShortcut": "Visszavonás ({shortcut})",
		"artifacts.document.toolbar.redoWithShortcut": "Újra ({shortcut})",
		"artifacts.document.toolbar.more": "Több",
		"artifacts.document.toolbar.download": "Letöltés",
		"artifacts.document.toolbar.history": "Előzmények",
		"artifacts.document.toolbar.saveState.saving": "Mentés…",
		"artifacts.document.toolbar.saveState.saved": "Mentve",
		"artifacts.document.toolbar.saveState.offline": "Nincs kapcsolat",
		"artifacts.document.toolbar.saveState.conflict": "Ütközés",
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
		"artifacts.document.change.redo": "Újra",
		"artifacts.document.change.keptNotice": "Megtartva",
		"artifacts.document.change.undoneNotice": "Visszavonva",
		"artifacts.document.change.commentCountA11y":
			"{count} megjegyzés ehhez a módosításhoz",
		"artifacts.document.change.groupLabel": "Alfy módosítása: {quote}",
		// WCAG 2.5.3 Label in Name (rd/review-2-5.md:210-216): each accessible
		// name must literally CONTAIN its button's own visible text
		// ("Megtartom"/"Visszavonom"/"Újra" above) — the previous possessive
		// phrasing ("...megtartása"/"...visszavonása"/"...megismétlése") used a
		// different word form and did not.
		"artifacts.document.change.keepA11y": "Megtartom — Alfy módosítása",
		"artifacts.document.change.undoA11y": "Visszavonom — Alfy módosítása",
		"artifacts.document.change.redoA11y": "Újra — Alfy módosítása",
		"artifacts.document.change.undoWithShortcut":
			"Visszavonom — Alfy módosítása ({shortcut})",
		"artifacts.document.change.redoWithShortcut":
			"Újra — Alfy módosítása ({shortcut})",
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
		"artifacts.document.refused.dismiss": "Elvetés",
		"artifacts.document.refused.reviewBarLeft": "{count} részt nem érintett.",
		"artifacts.document.review.regionLabel": "Alfy módosításai",
		// No ICU plural here either, for `cardSubtitle`'s own reason: Hungarian
		// nouns after a numeral stay singular ("1 részt", "3 részt").
		"artifacts.document.review.summary": "Alfy {count} részt módosított.",
		"artifacts.document.review.prev": "Előző módosítás",
		"artifacts.document.review.next": "Következő módosítás",
		"artifacts.document.review.keepAll": "Mindet megtartom",
		"artifacts.document.review.undoAll": "Mindet visszavonom",
		"artifacts.document.planned.writing": "Alfy írja: {label}",
		// No ICU plural here on purpose: Hungarian nouns after a numeral stay
		// singular ("1 fül", "3 fül"), unlike the English "tab"/"tabs" split.
		"artifacts.document.cardSubtitle": "Dokumentum · {count} fül",
		"artifacts.document.tab.add": "Fül hozzáadása",
		"artifacts.document.tab.menu": "Fül beállításai",
		"artifacts.document.tab.rename": "Átnevezés",
		"artifacts.document.tab.delete": "Fül törlése",
		"artifacts.document.tab.deleteConfirm":
			"Törlöd a(z) „{name}” fület és a szövegét?",
		"artifacts.document.tab.renamePrompt": "Nevezd át ezt a fület",
		"artifacts.document.tab.newTabTitle": "Új szakasz",
		// No ICU plural here either, same reasoning as cardSubtitle above.
		"artifacts.document.tab.openCommentsA11y": "{count} nyitott megjegyzés",
		"artifacts.document.chip.status.Booked": "Lefoglalva",
		"artifacts.document.chip.status.ToBook": "Lefoglalandó",
		"artifacts.document.chip.status.Paid": "Kifizetve",
		"artifacts.document.chip.status.Cancelled": "Lemondva",
		"artifacts.document.chip.statusFieldLabel": "Állapot",
		"artifacts.document.chip.dateFieldLabel": "Dátum",
		"artifacts.document.taskItem.checkboxLabel":
			"Feladat jelölőnégyzete: {text}",
		"artifacts.document.taskItem.emptyTaskItem": "üres feladat",
		"artifacts.document.toolbar.moreSheetTitle": "További formázás",
		"artifacts.document.anchor.moved": "Elmozdult",
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
		"artifacts.document.comment.guessTag": "Tipp",
		"artifacts.document.comment.askAgain": "Újrakérdezés",
		"artifacts.document.comment.changeEdited": "Módosítva · rád vár",
		"artifacts.document.comment.changeKept": "Megtartva",
		"artifacts.document.comment.changeUndone": "Visszavonva",
		"artifacts.document.comment.seeChange": "Módosítás mutatása",
		"artifacts.document.comment.alfyTyping": "Alfy ír…",
		"artifacts.document.comment.replyPlaceholder":
			"Válasz, vagy kérdezd: @Alfy…",
		"artifacts.document.comment.askAlfyHint":
			"Alfy itt válaszol, és szerkesztheti is a szöveget. A módosítást megtarthatod vagy visszavonhatod.",
		"artifacts.document.comment.peekThread": "Szál megnyitása",
		"artifacts.document.comment.quoteA11y": "„{quote}” megmutatása a szövegben",
		"artifacts.document.announce.commentAdded": "Megjegyzés hozzáadva.",
		"artifacts.document.announce.commentResolved": "Megjegyzés lezárva.",
		"artifacts.document.announce.commentReopened": "Megjegyzés újranyitva.",
		"artifacts.document.announce.alfyReplied": "Alfy válaszolt.",
		"artifacts.document.comment.selectionToolbar": "Kijelölés",
		"artifacts.document.comment.askHeader":
			"Alfy megkérdezése erről: „{quote}”",
		"artifacts.document.comment.commentHeader": "Megjegyzés ehhez: „{quote}”",
		"artifacts.document.comment.askPlaceholder":
			"Mit tegyen Alfy ezzel a szöveggel?",
		"artifacts.document.comment.askEffect":
			"Alfy a margón válaszol, és itt jelöli a módosítását, amit megtarthatsz vagy visszavonhatsz.",
		"artifacts.document.comment.mentionHint":
			"Írd be, hogy @Alfy — választ és szerkesztést is kapsz.",
		"artifacts.document.comment.chipLessList": "Kevésbé listaszerűen",
		"artifacts.document.comment.chipShorter": "Rövidebben",
		"artifacts.document.comment.chipFriendlier": "Barátságosabban",
		"artifacts.document.comment.chipHungarian": "Magyarul",
		"artifacts.document.writing.tag": "Alfy írja…",
		"artifacts.document.margin.title": "Megjegyzések",
		"artifacts.document.margin.buttonA11y": "Megjegyzések ({count})",
		"artifacts.document.margin.empty":
			"Nincs megjegyzés ezen a fülön. Jelölj ki szöveget egy új megjegyzéshez.",
		// No ICU plural here on purpose, matching commentCountA11y above:
		// Hungarian nouns after a numeral stay singular.
		"artifacts.document.margin.orphanedGroup":
			"{count} megjegyzés törölt szövegen",
		"artifacts.document.margin.resolvedToggle": "{count} lezárva",
		"artifacts.document.margin.showOpenOnly": "Csak a nyitottak",
		"artifacts.document.margin.otherTabs": "Más füleken",
		"artifacts.document.margin.otherTabOpen": "{count} nyitott",
		"artifacts.document.margin.otherTabResolved": "{count} lezárva",
		"artifacts.document.margin.countA11y": "{count} nyitott megjegyzés",
		"artifacts.document.margin.emptyDocument":
			"Még nincs megjegyzés. Jelölj ki szöveget egy új megjegyzéshez.",
		"artifacts.document.margin.emptyAllResolved":
			"Itt minden megjegyzés le van zárva.",
		"artifacts.document.margin.hide": "Megjegyzések elrejtése",
		"artifacts.document.margin.show": "Megjegyzések megjelenítése",
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
		// Slice 3 (Canvas), a protokoll saját szövegei: miért maradt ki egy
		// módosítás a táblából, és az egy sor arra az esetre, ha egy módosítást
		// egyáltalán nem sikerült értelmezni.
		"artifacts.canvas.invalidDiff":
			"Ezt a módosítást nem sikerült értelmezni, ezért semmi sem mozdult el.",
		"artifacts.canvas.refusal.unknown_id": "már nincs ott semmi",
		"artifacts.canvas.refusal.duplicate_id": "ez az azonosító már létezik",
		"artifacts.canvas.refusal.unknown_kind": "ismeretlen blokktípus",
		"artifacts.canvas.refusal.kind_mismatch":
			"a blokk típusa nem változhat meg helyben",
		"artifacts.canvas.refusal.missing_parent":
			"hiányzik a keret, amihez tartozna",
		"artifacts.canvas.refusal.self_parent":
			"a keret nem tartalmazhatja önmagát",
		"artifacts.canvas.refusal.cycle": "a keret nem kerülhet a saját keretébe",
		"artifacts.canvas.refusal.invalid_data":
			"a blokk tartalma nem volt érvényes",
		"artifacts.canvas.refusal.limit_exceeded": "a tábla elérte a korlátját",
		// Slice 3 (Canvas), a tábla saját szövegei: eszköztár, beszúrás menü,
		// blokkok, a panel tartalmi területének állapotai, a mentés sora.
		"artifacts.canvas.toolbar": "Tábla eszközök",
		"artifacts.canvas.tool.select": "Kijelölés",
		"artifacts.canvas.tool.pan": "Mozgatás",
		"artifacts.canvas.undo": "Saját lépés visszavonása",
		"artifacts.canvas.redo": "Saját lépés újra",
		"artifacts.canvas.insert": "Beszúrás",
		"artifacts.canvas.insert.block": "Blokk beszúrása",
		"artifacts.canvas.insert.text": "Szöveg",
		"artifacts.canvas.insert.sticky": "Jegyzet",
		"artifacts.canvas.insert.frame": "Keret",
		"artifacts.canvas.insert.chart": "Diagram",
		"artifacts.canvas.insert.checklist": "Ellenőrzőlista",
		// Nincs ICU többesszám, a cardSubtitle okán: a magyar főnév számnév
		// után egyes számban marad.
		"artifacts.canvas.blockCount": "{count} blokk",
		"artifacts.canvas.blockMissingKind": "Ez a blokktípus már nem támogatott.",
		"artifacts.canvas.blockDropped":
			"{count} blokkot nem sikerült beolvasni, kimaradtak.",
		"artifacts.canvas.dismiss": "Elrejtés",
		"artifacts.canvas.deleteBlock": "Blokk törlése",
		"artifacts.canvas.nodeDeleted": "Törölve a tábláról.",
		"artifacts.canvas.tone": "Jegyzet színe",
		"artifacts.canvas.tone.yellow": "Sárga",
		"artifacts.canvas.tone.mint": "Menta",
		"artifacts.canvas.tone.blue": "Kék",
		"artifacts.canvas.tone.plain": "Sima",
		"artifacts.canvas.stickyPlaceholder": "Írj egy jegyzetet…",
		"artifacts.canvas.textPlaceholder": "Írj valamit…",
		"artifacts.canvas.frameName": "Keret neve",
		"artifacts.canvas.checklistReadOnlyNote":
			"Az itt bejelölt pipák a táblával együtt mentődnek.",
		"artifacts.canvas.checklistPlaceholder": "Új elem",
		"artifacts.canvas.checklistAdd": "Elem hozzáadása",
		"artifacts.canvas.checklistRemove": "Elem törlése",
		"artifacts.canvas.checklistToggle": "{name}: kész állapot váltása",
		"artifacts.canvas.zoom": "Nagyítás",
		"artifacts.canvas.zoomIn": "Nagyítás",
		"artifacts.canvas.zoomOut": "Kicsinyítés",
		"artifacts.canvas.fitView": "Illesztés a nézetbe",
		"artifacts.canvas.minimap": "Tábla áttekintése",
		"artifacts.canvas.emptyBoard":
			"Üres tábla. Szúrj be egy blokkot, vagy rajzolj rá.",
		"artifacts.canvas.loading": "Tábla megnyitása…",
		"artifacts.canvas.loadFailed": "Nem sikerült megnyitni a táblát.",
		"artifacts.canvas.retry": "Újra",
		"artifacts.canvas.reload": "Újratöltés",
		"artifacts.canvas.saved": "Mentve",
		"artifacts.canvas.saving": "Mentés…",
		"artifacts.canvas.saveFailed": "Nem sikerült menteni a táblát.",
		"artifacts.canvas.saveConflict":
			"Valaki módosította a táblát, amíg rajzoltál. Töltsd újra, hogy a legfrissebbet lásd.",
		"artifacts.canvas.offline":
			"Nincs kapcsolat. A rajzod megmarad, és visszatér a mentés, amint újra van hálózat.",
		"artifacts.canvas.tooLarge": "Ez a tábla túl nagy a mentéshez.",
		"artifacts.canvas.deletedWhileOpen": "Ezt a táblát törölték.",
		"artifacts.canvas.noAccess": "Nincs hozzáférésed ehhez a táblához.",
		// Amit a folyamatkezelő könyvtár felolvas a saját elemeiről, az olvasó nyelvén.
		"artifacts.canvas.a11y.node":
			"Az Enter vagy a szóköz kijelöli a blokkot. A Delete törli, az Escape elengedi.",
		"artifacts.canvas.a11y.nodeKeyboard":
			"Az Enter vagy a szóköz kijelöli a blokkot. Utána a nyílbillentyűkkel mozgathatod. A Delete törli, az Escape elengedi.",
		"artifacts.canvas.a11y.moved":
			"A kijelölt blokk elmozdult. Új helye: x: {x}, y: {y}",
		"artifacts.canvas.a11y.edge":
			"Az Enter vagy a szóköz kijelöli a kapcsolatot. Utána a Delete törli, az Escape elengedi.",
		"artifacts.canvas.a11y.handle": "Kapcsolódási pont",
		// A kettőspont a magyar rag nélkül old meg egy tetszőleges keretnevet.
		"artifacts.canvas.movedIntoFrame": "Átkerült a keretbe: {frame}.",
		"artifacts.canvas.movedOutOfFrame": "Kikerült a keretből: {frame}.",
		"artifacts.canvas.tool.draw": "Rajzolás",
		"artifacts.canvas.tool.pen": "Toll",
		"artifacts.canvas.tool.highlighter": "Szövegkiemelő",
		"artifacts.canvas.tool.line": "Vonal",
		"artifacts.canvas.tool.arrow": "Nyíl",
		"artifacts.canvas.tool.rect": "Téglalap",
		"artifacts.canvas.tool.ellipse": "Ellipszis",
		"artifacts.canvas.tool.text": "Szöveg",
		"artifacts.canvas.tool.eraser": "Radír",
		"artifacts.canvas.drawTools": "Rajzeszközök",
		"artifacts.canvas.ink.blue": "Kék tinta",
		"artifacts.canvas.ink.red": "Piros tinta",
		"artifacts.canvas.ink.green": "Zöld tinta",
		"artifacts.canvas.ink.graphite": "Grafitszürke tinta",
		"artifacts.canvas.drawingLayer": "Rajzréteg",
		// Nincs többes szám: a számnév után a főnév egyes számban marad.
		"artifacts.canvas.drawingLayer.marks": "{count} rajzolt jel a táblán.",
		"artifacts.canvas.textMark": "Szöveg a táblán",
		"artifacts.canvas.markDeleted": "Jel törölve.",
		"artifacts.canvas.markErased": "Jelek radírozva.",
		"artifacts.canvas.drawingLimit":
			"A táblán legfeljebb {count} jel lehet. Radírozz le egyet, hogy továbbrajzolhass.",
	},
} as const;

export default artifactsDict;
