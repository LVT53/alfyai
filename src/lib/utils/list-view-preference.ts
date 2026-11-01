/**
 * A list's List / Grid choice, kept per viewer in this browser's localStorage
 * (plan 2b Task 22 / 22b). Each list names its own key: the Knowledge Base's
 * library (`knowledgeDocumentsView`) and the chat panel's "What this chat
 * made" (`artifactPanelListView`) are remembered apart. A blocked or missing
 * storage (a private window, the server) reads as the list and never throws.
 */
export type ListView = "list" | "grid";

type ViewStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): ViewStorage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

export function readListView(
	key: string,
	storage: ViewStorage | null = defaultStorage(),
): ListView {
	try {
		return storage?.getItem(key) === "grid" ? "grid" : "list";
	} catch {
		return "list";
	}
}

export function writeListView(
	key: string,
	view: ListView,
	storage: ViewStorage | null = defaultStorage(),
): void {
	try {
		storage?.setItem(key, view);
	} catch {
		// The view still changes; it is only not remembered.
	}
}
