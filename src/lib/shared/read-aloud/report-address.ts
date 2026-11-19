/**
 * Which standard report read aloud reads (spec §4.13): the one the panel's preview
 * showed, named by that preview's own address. A report opened from a chat is shown
 * by its chat file (`/api/chat/files/[id]/preview`); one opened from the Knowledge
 * library by its library item (`/api/knowledge/[id]/preview`). The session route
 * reads it back through the same preview's own rules (`read-aloud/report-html.ts`).
 */
export type ReportAddress = { fileId: string } | { artifactId: string };

const CHAT_FILE = /^\/api\/chat\/files\/([^/?#]+)\/preview$/u;
const LIBRARY_ITEM = /^\/api\/knowledge\/([^/?#]+)\/preview$/u;

/** The report a preview address names; null for any other address. */
export function reportAddressOf(
	previewAddress: string | null,
): ReportAddress | null {
	const address = previewAddress ?? "";
	const chatFile = CHAT_FILE.exec(address)?.[1];
	const libraryItem = LIBRARY_ITEM.exec(address)?.[1];
	try {
		if (chatFile) return { fileId: decodeURIComponent(chatFile) };
		if (libraryItem) return { artifactId: decodeURIComponent(libraryItem) };
	} catch {
		// An escape that is not one names nothing.
	}
	return null;
}
