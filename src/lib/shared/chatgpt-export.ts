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
