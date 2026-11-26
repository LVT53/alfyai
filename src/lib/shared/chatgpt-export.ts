/**
 * How a ChatGPT export names one of its conversations.
 *
 * The browser reads the export's ZIP to draw the list the person ticks from,
 * and the server reads the same file again to import what was ticked, so both
 * must name a conversation the same way or a tick would point at nothing: by the
 * `conversation_id` the entry carries, else by its `id`. An entry that carries
 * neither has no name, and a selection cannot refer to it.
 */
export function exportedConversationId(entry: unknown): string | null {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
		return null;
	}
	const { conversation_id: conversationId, id } = entry as Record<
		string,
		unknown
	>;
	for (const candidate of [conversationId, id]) {
		if (typeof candidate === "string" && candidate.length > 0) {
			return candidate;
		}
	}
	return null;
}

const PROJECT_ID_PREFIX = "g-p-";

/**
 * The ChatGPT project (a folder in ChatGPT's sidebar) a conversation of the
 * export is in, or null when it is in none. A late-2026 export records only the
 * project's id, "g-p-" and 32 hex digits, in `conversation_template_id`; older
 * exports also put it in `gizmo_id`. A custom GPT's id ("g-" without the "p-")
 * is not a folder. No export names its projects, so the import window numbers
 * them.
 */
export function exportedConversationProjectId(entry: unknown): string | null {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
		return null;
	}
	const { conversation_template_id: templateId, gizmo_id: gizmoId } =
		entry as Record<string, unknown>;
	for (const candidate of [templateId, gizmoId]) {
		if (
			typeof candidate === "string" &&
			candidate.length > PROJECT_ID_PREFIX.length &&
			candidate.startsWith(PROJECT_ID_PREFIX)
		) {
			return candidate;
		}
	}
	return null;
}

/** The part of a JSZip archive the reader below needs. */
export interface ExportArchive {
	file(path: string): { async(type: "text"): Promise<string> } | null;
}

export type ExportedConversations =
	| { ok: true; entries: unknown[] }
	| {
			ok: false;
			problem: "missing" | "unreadable" | "not_a_list";
			/** The file the problem is in, as the archive names it. */
			file: string;
			detail?: string;
	  };

const CONVERSATIONS = "conversations.json";

/**
 * The files a newer export's manifest lists for its conversations. Exports
 * from late 2026 carry `export_manifest.json`, which may split the
 * conversations across several files (`sharded`, `shard_count`, `files`).
 * Anything that is not a usable list of plain relative paths names nothing.
 */
function manifestConversationFiles(manifest: unknown): string[] | null {
	if (typeof manifest !== "object" || manifest === null) return null;
	const logical = (manifest as Record<string, unknown>).logical_files;
	if (typeof logical !== "object" || logical === null) return null;
	const entry = (logical as Record<string, unknown>)[CONVERSATIONS];
	if (typeof entry !== "object" || entry === null) return null;
	const files = (entry as Record<string, unknown>).files;
	if (!Array.isArray(files) || files.length === 0) return null;
	const plain = (path: unknown): path is string =>
		typeof path === "string" &&
		path.length > 0 &&
		!path.startsWith("/") &&
		!path.split("/").includes("..");
	return files.every(plain) ? files : null;
}

/**
 * Every conversation entry of a ChatGPT export, read the same way by the
 * browser (to draw the list the person ticks from) and by the server (to
 * import what was ticked): the files the export's manifest lists for its
 * conversations, in order, else the one `conversations.json` at the root that
 * older exports have, keeping the first entry of a conversation listed twice.
 * A listed file the archive does not hold refuses the whole export rather
 * than import part of it.
 */
export async function readExportedConversations(
	zip: ExportArchive,
): Promise<ExportedConversations> {
	let files = [CONVERSATIONS];
	const manifest = zip.file("export_manifest.json");
	if (manifest) {
		try {
			files =
				manifestConversationFiles(JSON.parse(await manifest.async("text"))) ??
				files;
		} catch {
			// A manifest that cannot be read leaves the older layout's one file.
		}
	}
	const entries: unknown[] = [];
	// One entry per conversation, the first: a conversation listed twice would
	// otherwise be offered twice and imported twice.
	const seen = new Set<string>();
	for (const name of files) {
		const file = zip.file(name);
		if (!file) return { ok: false, problem: "missing", file: name };
		let parsed: unknown;
		try {
			parsed = JSON.parse(await file.async("text"));
		} catch (err) {
			return {
				ok: false,
				problem: "unreadable",
				file: name,
				detail: err instanceof Error ? err.message : undefined,
			};
		}
		if (!Array.isArray(parsed))
			return { ok: false, problem: "not_a_list", file: name };
		// A large export can hold more entries than a spread may pass at once.
		for (const entry of parsed) {
			const id = exportedConversationId(entry);
			if (id !== null) {
				if (seen.has(id)) continue;
				seen.add(id);
			}
			entries.push(entry);
		}
	}
	return { ok: true, entries };
}

/** The part of a JSZip archive the writer below needs. */
export interface ExportArchiveWriter {
	file(path: string, data: string): unknown;
}

/** How many conversations one written file holds, as in ChatGPT's own exports. */
export const CONVERSATIONS_PER_FILE = 100;

/**
 * Write conversation entries as a ChatGPT export in the newer layout, which
 * `readExportedConversations` reads back in the same order: a manifest listing
 * the conversation files, each holding at most `CONVERSATIONS_PER_FILE`
 * entries, so no one file's text grows past what a browser can hold in one
 * string. The browser uploads this instead of the export it was given: a real
 * export also carries every attachment and its viewer page, which the import
 * never reads (one of 342 MB held 8 MB of chats).
 */
export function writeExportedConversations(
	entries: readonly unknown[],
	zip: ExportArchiveWriter,
): void {
	const files: string[] = [];
	let start = 0;
	do {
		const name = `conversations-${String(files.length).padStart(3, "0")}.json`;
		zip.file(
			name,
			JSON.stringify(entries.slice(start, start + CONVERSATIONS_PER_FILE)),
		);
		files.push(name);
		start += CONVERSATIONS_PER_FILE;
	} while (start < entries.length);
	zip.file(
		"export_manifest.json",
		JSON.stringify({
			version: 1,
			logical_files: {
				[CONVERSATIONS]: { files, sharded: true, shard_count: files.length },
			},
		}),
	);
}
