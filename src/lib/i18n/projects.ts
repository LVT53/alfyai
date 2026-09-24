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
		// ── The Files modal (§M5) ──────────────────────────────────────────
		// The dialog's heading, paired with the project's own token. The line
		// under it is the one sentence that says what a project file IS: the
		// project knows it exists; it is read when a chat needs it.
		"projects.filesTitle": "Files",
		"projects.filesDescription":
			"Every chat in this project knows these exist and reads them when they're needed.",
		"projects.filesSearch": "Search files in this project",
		"projects.filesAddFromLibrary": "Add from library",
		"projects.filesUpload": "Upload",
		"projects.filesColumnName": "Name",
		"projects.filesColumnType": "Type",
		"projects.filesColumnSize": "Size",
		"projects.filesColumnAdded": "Added",
		"projects.filesPreviewA11y": "Preview {name}",
		// Unlink, never delete — and the label says both ends of it.
		"projects.filesUnlinkA11y": "Remove {name} from this project",
		"projects.filesFooter":
			"{count} files · removing one here keeps it in your library",
		"projects.filesFooterOne":
			"1 file · removing it here keeps it in your library",
		"projects.filesEmpty": "No files yet.",
		"projects.filesDone": "Done",
		"projects.filesAlreadyAdded": "already added",
		"projects.filesAddCount": "Add {count} documents",
		"projects.filesAddCountOne": "Add 1 document",
		"projects.filesUnlinkFailed":
			"Could not remove the file from this project.",
		"projects.filesLinkFailed": "Could not add the files to this project.",
		"projects.filesUploadFailed": "Could not upload the file.",
		"projects.filesLoadFailed": "Could not load your library.",
		// The packet section's tail. A count, never a truncated name (Slice E,
		// review focus 3): a clipped file name in the prompt reads as a real one.
		"projects.filesMore": "+{count} more",
		// The Info popover's two project rows (§M8): what the project carried in,
		// and how much of it the reply actually read.
		"projects.infoProjectFiles": "Project files",
		"projects.infoProjectFilesValue": "{count} read · see Sources ↓",
		"projects.infoProjectFilesValueOne": "1 read · see Sources ↓",
		// The library's token on a document a project knows about.
		"projects.linkedInLibrary": "In {count} projects",
		"projects.linkedInLibraryOne": "In 1 project",
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
		"projects.filesTitle": "Fájlok",
		"projects.filesDescription":
			"A projekt minden csevegése tud róluk, és akkor olvassa el őket, amikor szükség van rájuk.",
		"projects.filesSearch": "Keresés a projekt fájljai között",
		"projects.filesAddFromLibrary": "Hozzáadás a könyvtárból",
		"projects.filesUpload": "Feltöltés",
		"projects.filesColumnName": "Név",
		"projects.filesColumnType": "Típus",
		"projects.filesColumnSize": "Méret",
		"projects.filesColumnAdded": "Hozzáadva",
		"projects.filesPreviewA11y": "{name} előnézete",
		"projects.filesUnlinkA11y": "{name} eltávolítása a projektből",
		"projects.filesFooter":
			"{count} fájl · az eltávolítás nem törli a könyvtárból",
		"projects.filesFooterOne":
			"1 fájl · az eltávolítás nem törli a könyvtárból",
		"projects.filesEmpty": "Még nincs fájl.",
		"projects.filesDone": "Kész",
		"projects.filesAlreadyAdded": "már hozzáadva",
		"projects.filesAddCount": "{count} dokumentum hozzáadása",
		"projects.filesAddCountOne": "1 dokumentum hozzáadása",
		"projects.filesUnlinkFailed":
			"Nem sikerült eltávolítani a fájlt a projektből.",
		"projects.filesLinkFailed":
			"Nem sikerült hozzáadni a fájlokat a projekthez.",
		"projects.filesUploadFailed": "Nem sikerült feltölteni a fájlt.",
		"projects.filesLoadFailed": "Nem sikerült betölteni a könyvtárat.",
		"projects.filesMore": "+{count} további",
		"projects.infoProjectFiles": "Projektfájlok",
		"projects.infoProjectFilesValue": "{count} elolvasva · lásd a forrásokat ↓",
		"projects.infoProjectFilesValueOne": "1 elolvasva · lásd a forrásokat ↓",
		"projects.linkedInLibrary": "{count} projektben",
		"projects.linkedInLibraryOne": "1 projektben",
	},
} as const;

export default projectsDict;
