import { z } from "zod";
import {
	NextcloudFilesError,
	nextcloudReadFile,
	nextcloudSearch,
} from "$lib/server/services/connections/providers/nextcloud-files";
import {
	needsDisambiguation,
	resolveConnectionsForCapability,
} from "$lib/server/services/connections/resolve";
import type { ConnectionPublic } from "$lib/server/services/connections/store";
import { getConnectionSecret } from "$lib/server/services/connections/store";
import type { ToolEvidenceCandidate } from "$lib/types";

import { truncateText } from "./shared";

export const filesToolInputSchema = z.object({
	action: z.enum(["search", "read"]),
	query: z.string().optional(),
	path: z.string().optional(),
});

export type FilesToolInput = z.infer<typeof filesToolInputSchema>;

export function sanitizeFilesToolInput(input: FilesToolInput): FilesToolInput {
	return {
		action: input.action,
		...(input.query ? { query: input.query.trim() } : {}),
		...(input.path ? { path: input.path.trim() } : {}),
	};
}

export type FilesCitation = { label: string; path: string; url: string };

export type FilesToolResultItem = {
	name: string;
	path: string;
	isDir: boolean;
	size: number;
	contentType: string | null;
	content?: string;
	truncated?: boolean;
	binary?: boolean;
};

export type FilesToolModelPayload = {
	success: boolean;
	name: "files";
	sourceType: "document";
	action: FilesToolInput["action"];
	message: string;
	results: FilesToolResultItem[];
	citations: FilesCitation[];
};

export type FilesToolOutcome = {
	modelPayload: FilesToolModelPayload;
	candidates: ToolEvidenceCandidate[];
};

const MAX_SEARCH_RESULTS = 20;
// The Nextcloud read adapter already caps raw bytes at 25MB (chat-context
// reads only); this is a second, much tighter cap on the *text* we inline
// into the model's context so one large text file can't blow the prompt
// budget the way research_web's per-source char budgets do.
const MAX_INLINE_TEXT_CHARS = 100_000;

const TEXT_LIKE_MIME_TYPES = new Set([
	"application/json",
	"application/xml",
	"application/javascript",
	"application/x-yaml",
	"application/yaml",
]);

function isTextLike(contentType: string | null): boolean {
	if (!contentType) return false;
	const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
	if (type.startsWith("text/")) return true;
	return TEXT_LIKE_MIME_TYPES.has(type);
}

function fileLabel(path: string): string {
	const segments = path.split("/").filter(Boolean);
	return segments[segments.length - 1] ?? path;
}

// Best-effort deep link into the Nextcloud Files web UI so citations are
// clickable. Nextcloud's Files-app URL scheme has varied across versions;
// this targets the long-standing `?dir=...&scrollto=...` form. If a given
// server doesn't honor it, the link still lands the user in their files app.
function nextcloudWebUiUrl(conn: ConnectionPublic, path: string): string {
	const serverUrl =
		typeof conn.config.serverUrl === "string" ? conn.config.serverUrl : "";
	const lastSlash = path.lastIndexOf("/");
	const dir = lastSlash === -1 ? "" : path.slice(0, lastSlash);
	const name = lastSlash === -1 ? path : path.slice(lastSlash + 1);
	const dirParam = encodeURIComponent(`/${dir}`);
	return `${serverUrl}/index.php/apps/files/?dir=${dirParam}&scrollto=${encodeURIComponent(name)}`;
}

function toCandidate(citation: FilesCitation): ToolEvidenceCandidate {
	return {
		id: `files:${citation.path}`,
		title: citation.label,
		url: citation.url,
		snippet: citation.path,
		sourceType: "document",
	};
}

function buildPayload(params: {
	success: boolean;
	action: FilesToolInput["action"];
	message: string;
	results?: FilesToolResultItem[];
	citations?: FilesCitation[];
}): FilesToolOutcome {
	const citations = params.citations ?? [];
	return {
		modelPayload: {
			success: params.success,
			name: "files",
			sourceType: "document",
			action: params.action,
			message: params.message,
			results: params.results ?? [],
			citations,
		},
		candidates: citations.map(toCandidate),
	};
}

function ambiguityNote(
	conn: ConnectionPublic,
	connections: ConnectionPublic[],
): string {
	const labels = connections.map((c) => c.label).join(", ");
	return `You have ${connections.length} Files connections (${labels}); using "${conn.label}" for this request.`;
}

function withAmbiguityPrefix(
	message: string,
	ambiguous: boolean,
	conn: ConnectionPublic,
	connections: ConnectionPublic[],
): string {
	return ambiguous ? `${ambiguityNote(conn, connections)} ${message}` : message;
}

function mapAdapterError(err: unknown): string {
	if (err instanceof NextcloudFilesError) {
		switch (err.code) {
			case "needs_reauth":
				return "Your Nextcloud connection needs to be reconnected before I can access your files. Please reconnect it in Settings.";
			case "not_found":
				return "That file or folder couldn't be found in your Nextcloud.";
			case "too_large":
				return "That file is too large for me to read right now.";
			case "invalid_path":
				return "That file path isn't valid.";
			case "invalid_config":
				return "Your Nextcloud connection is missing required configuration. Please reconnect it in Settings.";
			default:
				return "I couldn't reach your files right now. Please try again in a moment.";
		}
	}
	return "I couldn't reach your files right now. Please try again in a moment.";
}

function searchOutcome(
	conn: ConnectionPublic,
	files: Awaited<ReturnType<typeof nextcloudSearch>>,
	ambiguous: boolean,
	connections: ConnectionPublic[],
): FilesToolOutcome {
	const limited = files.slice(0, MAX_SEARCH_RESULTS);
	const results: FilesToolResultItem[] = limited.map((file) => ({
		name: file.name,
		path: file.path,
		isDir: file.isDir,
		size: file.size,
		contentType: file.contentType,
	}));
	const citations: FilesCitation[] = limited
		.filter((file) => !file.isDir)
		.map((file) => ({
			label: file.name,
			path: file.path,
			url: nextcloudWebUiUrl(conn, file.path),
		}));
	const baseMessage =
		files.length === 0
			? "No files matched your search."
			: `Found ${files.length} matching ${files.length === 1 ? "file" : "files"}${
					files.length > limited.length
						? ` (showing the first ${limited.length})`
						: ""
				}.`;
	return buildPayload({
		success: true,
		action: "search",
		message: withAmbiguityPrefix(baseMessage, ambiguous, conn, connections),
		results,
		citations,
	});
}

function readOutcome(
	conn: ConnectionPublic,
	path: string,
	file: Awaited<ReturnType<typeof nextcloudReadFile>>,
	ambiguous: boolean,
	connections: ConnectionPublic[],
): FilesToolOutcome {
	const label = fileLabel(path);
	const citation: FilesCitation = {
		label,
		path,
		url: nextcloudWebUiUrl(conn, path),
	};

	let result: FilesToolResultItem;
	let message: string;
	if (isTextLike(file.contentType)) {
		const text = Buffer.from(file.bytes).toString("utf-8");
		const truncated = text.length > MAX_INLINE_TEXT_CHARS;
		result = {
			name: label,
			path,
			isDir: false,
			size: file.bytes.byteLength,
			contentType: file.contentType,
			content: truncateText(text, MAX_INLINE_TEXT_CHARS),
			...(truncated ? { truncated: true } : {}),
		};
		message = `Read ${label}${truncated ? " (truncated for length)" : ""}.`;
	} else {
		result = {
			name: label,
			path,
			isDir: false,
			size: file.bytes.byteLength,
			contentType: file.contentType,
			binary: true,
		};
		message = `${label} is a binary file (${file.contentType ?? "unknown type"}); its contents can't be shown as text.`;
	}

	return buildPayload({
		success: true,
		action: "read",
		message: withAmbiguityPrefix(message, ambiguous, conn, connections),
		results: [result],
		citations: [citation],
	});
}

// Resolves the user's Files connection(s) and executes a search/read against
// Nextcloud, degrading gracefully (never throwing) so a connection problem
// never aborts the chat turn: no connection, ambiguity, and adapter failures
// all resolve to a `{ success: false, message }`-shaped payload instead.
export async function runFilesTool(
	userId: string,
	input: FilesToolInput,
): Promise<FilesToolOutcome> {
	const connections = await resolveConnectionsForCapability(userId, "files");
	if (connections.length === 0) {
		return buildPayload({
			success: false,
			action: input.action,
			message:
				"You don't have a Files connection set up yet. Connect your Nextcloud account in Settings to search or read files.",
		});
	}

	const ambiguous = needsDisambiguation(connections);
	const conn = connections[0];
	if (!conn) {
		return buildPayload({
			success: false,
			action: input.action,
			message:
				"You don't have a Files connection set up yet. Connect your Nextcloud account in Settings to search or read files.",
		});
	}

	const secret = await getConnectionSecret(userId, conn.id);
	if (!secret) {
		return buildPayload({
			success: false,
			action: input.action,
			message:
				"Your Nextcloud connection is missing its stored credentials. Please reconnect it in Settings.",
		});
	}

	try {
		if (input.action === "search") {
			if (!input.query) {
				return buildPayload({
					success: false,
					action: "search",
					message: "A search query is required to search your files.",
				});
			}
			const files = await nextcloudSearch(conn, secret, input.query);
			return searchOutcome(conn, files, ambiguous, connections);
		}

		if (!input.path) {
			return buildPayload({
				success: false,
				action: "read",
				message: "A file path is required to read a file.",
			});
		}
		const file = await nextcloudReadFile(conn, secret, input.path);
		return readOutcome(conn, input.path, file, ambiguous, connections);
	} catch (err) {
		return buildPayload({
			success: false,
			action: input.action,
			message: mapAdapterError(err),
		});
	}
}
