/**
 * The project surface: the project page (Workspaces Slice D), and the entries
 * Slice E (the Files modal, the Info rows) and Slice G (the home cards) append
 * to this same file.
 *
 * Its own namespace rather than more `sidebar.` keys, because these strings
 * render on a page that has nothing to do with the sidebar — and because the
 * whole surface is then one audited prefix (`projects.`), so a line that
 * landed in EN and not in HU cannot slip through.
 */
const projectsDict = {
	en: {
		// The composer's box, which names the project it will start a chat in.
		"projects.startChatPlaceholder": "Start a chat in {name}…",
		// The greeting band's quiet record, on the same baseline as the home
		// page's weekly bars.
		"projects.stats": "{count} chats · active {relative}",
		"projects.statsOne": "1 chat · active {relative}",
		// The list's heading. Counted, so the singular has its own line; a
		// project with no chats shows `projects.emptyList` instead.
		"projects.listHeading": "{count} chats in this project",
		"projects.listHeadingOne": "1 chat in this project",
		"projects.emptyList":
			"No chats yet. The first message you send here starts one.",
		// The quiet line under the composer. Slice D ships the instructions
		// half; Slice E appends the files half after a middot.
		"projects.instructionsLabel": "Instructions",
		"projects.addInstructions": "Add instructions",
		"projects.filesLabel": "{count} files",
		"projects.filesLabelOne": "1 file",
		"projects.addFiles": "Add files",
		// The sidebar's hover button, which opens the project rather than
		// making a chat in it.
		"projects.openA11y": "Open {name}",
		// A project page whose project was deleted while it was open.
		"projects.missing": "This project no longer exists.",
	},
	hu: {
		"projects.startChatPlaceholder": "Kezdj csevegést itt: {name}…",
		"projects.stats": "{count} csevegés · aktív: {relative}",
		"projects.statsOne": "1 csevegés · aktív: {relative}",
		"projects.listHeading": "{count} csevegés ebben a projektben",
		"projects.listHeadingOne": "1 csevegés ebben a projektben",
		"projects.emptyList": "Még nincs csevegés. Az első üzenet itt indít egyet.",
		"projects.instructionsLabel": "Utasítások",
		"projects.addInstructions": "Utasítások hozzáadása",
		"projects.filesLabel": "{count} fájl",
		"projects.filesLabelOne": "1 fájl",
		"projects.addFiles": "Fájlok hozzáadása",
		"projects.openA11y": "{name} megnyitása",
		"projects.missing": "Ez a projekt már nem létezik.",
	},
} as const;

export default projectsDict;
