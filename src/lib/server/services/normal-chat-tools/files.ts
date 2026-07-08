import { z } from "zod";
import {
	distillConnectorPayload,
	hasLocalDistillEnabled,
	isCloudModel,
} from "$lib/server/services/connections/locality";
import { createPendingWrite } from "$lib/server/services/connections/pending-writes";
import {
	NextcloudFilesError,
	nextcloudReadFile,
	nextcloudSearch,
	nextcloudStat,
} from "$lib/server/services/connections/providers/nextcloud-files";
import {
	needsDisambiguation,
	resolveConnectionsForCapability,
} from "$lib/server/services/connections/resolve";
import type { ConnectionPublic } from "$lib/server/services/connections/store";
import { getConnectionSecret } from "$lib/server/services/connections/store";
import {
	buildWritePreview,
	idempotencyKey,
	resolveWriteTarget,
	type WriteOperation,
	type WritePreview,
} from "$lib/server/services/connections/write-guard";
import type { ToolEvidenceCandidate } from "$lib/types";

import { truncateText } from "./shared";

export const filesToolInputSchema = z.object({
	action: z.enum(["search", "read", "save"]),
	query: z.string().optional(),
	path: z.string().optional(),
	content: z.string().optional(),
});

export type FilesToolInput = z.infer<typeof filesToolInputSchema>;

export function sanitizeFilesToolInput(input: FilesToolInput): FilesToolInput {
	return {
		action: input.action,
		...(input.query ? { query: input.query.trim() } : {}),
		...(input.path ? { path: input.path.trim() } : {}),
		...(input.content !== undefined ? { content: input.content } : {}),
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
	// Only set for a successful "save" action — the write has NOT executed,
	// this is the id the user's confirm/cancel decision applies to (4.3).
	pendingWriteId?: string;
	preview?: WritePreview;
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
// clickable. Verified against Nextcloud server source/issue history: the
// long-standing, documented form is `/index.php/apps/files/?dir=<dir>&scrollto=<name>`
// (see e.g. nextcloud/server#7874, #27100). A newer `openfile=<fileId>` form
// exists (nextcloud/server, NC19+) and is preferred by current versions, but
// it requires the file's *numeric* internal fileId, which our WebDAV
// PROPFIND (list/search) does not currently request or expose (see
// `NcFile` — no `fileid` field) — adding it is an adapter change (2.2),
// out of scope here. `scrollto` is reported to no-op (no highlight/scroll)
// on some newer server versions per nextcloud/server#46113, but it never
// produces an invalid URL: worst case the link still opens the Files app at
// the file's parent directory, which satisfies the "safe, correct link"
// bar for a v1 citation.
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
	pendingWriteId?: string;
	preview?: WritePreview;
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
			...(params.pendingWriteId
				? { pendingWriteId: params.pendingWriteId }
				: {}),
			...(params.preview ? { preview: params.preview } : {}),
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

// Best-effort check for whether `path` already has a file at it, used only to
// set the WriteOperation's `destructive` flag for the confirm preview (4.1).
// Never throws and never blocks the proposal on failure — an inconclusive
// stat degrades to "not known to be destructive" rather than aborting the
// save action, since the write itself still cannot happen without a
// subsequent explicit user confirm regardless of this flag's value.
async function wouldOverwrite(
	conn: ConnectionPublic,
	secret: string,
	path: string,
): Promise<boolean> {
	try {
		const existing = await nextcloudStat(conn, secret, path);
		return existing !== null && !existing.isDir;
	} catch {
		return false;
	}
}

// Issue 4.3 — the tool's write action. Builds a WriteOperation + preview via
// the write-guard (4.1) and creates a PENDING row (pending-writes.ts) that
// records the assistant-authored text content. This function NEVER calls
// executeNextcloudWrite (4.2): the only path from here to an actual Nextcloud
// mutation is the user explicitly confirming via the confirm API, which is a
// separate request entirely.
async function saveOutcome(
	userId: string,
	conn: ConnectionPublic,
	input: FilesToolInput,
	ambiguous: boolean,
	connections: ConnectionPublic[],
): Promise<FilesToolOutcome> {
	// Hard gate, checked BEFORE the connection's secret is ever decrypted —
	// same posture as executeNextcloudWrite's allowWrites check (4.2). No
	// pending row is created when writes are disabled.
	if (conn.allowWrites !== true) {
		return buildPayload({
			success: false,
			action: "save",
			message: `Writing to ${conn.label} is turned off; enable it in settings.`,
		});
	}

	if (!input.content) {
		return buildPayload({
			success: false,
			action: "save",
			message: "Content is required to save a file.",
		});
	}

	const secret = await getConnectionSecret(userId, conn.id);
	if (!secret) {
		return buildPayload({
			success: false,
			action: "save",
			message:
				"Your Nextcloud connection is missing its stored credentials. Please reconnect it in Settings.",
		});
	}

	const target = resolveWriteTarget({
		allowlist: conn.writeAllowlist,
		requestedPath: input.path,
		defaultArea: conn.writeAllowlist[0],
	});
	const destructive = await wouldOverwrite(conn, secret, target.path);
	const label = fileLabel(target.path);

	const op: WriteOperation = {
		provider: conn.provider,
		connectionId: conn.id,
		action: "files.put",
		summary: `Save ${label} to ${target.path}`,
		reversible: true, // Nextcloud keeps versions/trash for overwritten files.
		destructive,
		target: { path: target.path, withinAllowlist: target.withinAllowlist },
	};
	const preview = buildWritePreview(op);

	const { id } = await createPendingWrite(userId, {
		connectionId: conn.id,
		provider: conn.provider,
		op,
		content: input.content,
		idempotencyKey: idempotencyKey(op),
		preview,
	});

	const message = withAmbiguityPrefix(
		`I've prepared a write of "${label}" to ${target.path}, but it has NOT been saved yet — it is PENDING and awaiting your explicit confirmation. ${preview.detail}${preview.warnings.length > 0 ? ` Warnings: ${preview.warnings.join("; ")}.` : ""}`,
		ambiguous,
		conn,
		connections,
	);

	return buildPayload({
		success: true,
		action: "save",
		message,
		pendingWriteId: id,
		preview,
	});
}

// Locality Option A: when the user has opted in to local distillation and the
// selected chat model is cloud, replace raw connector content with a summary
// produced by a local model before it reaches the (cloud) model — raw file
// content must never reach the cloud model in that case. Citations (names/
// paths, used for Sources-tab candidates) are metadata, not sensitive
// content, and are left untouched by this gate.
async function applyLocalDistillGate(params: {
	userId: string;
	modelId: string;
	input: FilesToolInput;
	outcome: FilesToolOutcome;
}): Promise<FilesToolOutcome> {
	const { userId, modelId, input, outcome } = params;
	if (!outcome.modelPayload.success) return outcome;

	const rawTextParts = outcome.modelPayload.results
		.map((result) => result.content)
		.filter((content): content is string => Boolean(content));
	// Nothing raw to protect (e.g. a search listing, or a binary file with no
	// inlined text) — the gate is a no-op.
	if (rawTextParts.length === 0) return outcome;

	const shouldDistill =
		(await hasLocalDistillEnabled(userId)) && (await isCloudModel(modelId));
	if (!shouldDistill) return outcome;

	const strippedResults = outcome.modelPayload.results.map((result) => {
		const { content: _content, ...rest } = result;
		return rest;
	});

	const distillResult = await distillConnectorPayload({
		userId,
		capability: "files",
		userQuestion: input.query ?? input.path ?? "",
		rawText: rawTextParts.join("\n\n"),
	});

	if ("distilled" in distillResult) {
		return {
			...outcome,
			modelPayload: {
				...outcome.modelPayload,
				message: `${outcome.modelPayload.message} Privately summarized for a cloud model. Summary: ${distillResult.distilled}`,
				results: strippedResults,
			},
		};
	}

	return {
		...outcome,
		modelPayload: {
			...outcome.modelPayload,
			message:
				"This file's content couldn't be privately summarized for a cloud model, so it was withheld. Switch to a local model to view it, or try again.",
			results: strippedResults,
		},
	};
}

// Resolves the user's Files connection(s) and executes a search/read against
// Nextcloud, degrading gracefully (never throwing) so a connection problem
// never aborts the chat turn: no connection, ambiguity, and adapter failures
// all resolve to a `{ success: false, message }`-shaped payload instead.
export async function runFilesTool(
	userId: string,
	input: FilesToolInput,
	modelId: string,
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

	// "save" (4.3) is a write proposal, not a read: it must check the
	// allowWrites gate BEFORE any secret is decrypted, so it branches here —
	// before the shared getConnectionSecret call below — and manages its own
	// secret fetch internally once the gate has passed.
	if (input.action === "save") {
		return saveOutcome(userId, conn, input, ambiguous, connections);
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
			const outcome = searchOutcome(conn, files, ambiguous, connections);
			return applyLocalDistillGate({ userId, modelId, input, outcome });
		}

		if (!input.path) {
			return buildPayload({
				success: false,
				action: "read",
				message: "A file path is required to read a file.",
			});
		}
		const file = await nextcloudReadFile(conn, secret, input.path);
		const outcome = readOutcome(conn, input.path, file, ambiguous, connections);
		return applyLocalDistillGate({ userId, modelId, input, outcome });
	} catch (err) {
		return buildPayload({
			success: false,
			action: input.action,
			message: mapAdapterError(err),
		});
	}
}
