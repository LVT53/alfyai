import { z } from "zod";
import { withCapabilityConnection } from "$lib/server/services/connections/capability-read";
import { createPendingWrite } from "$lib/server/services/connections/pending-writes";
import {
	NextcloudFilesError,
	nextcloudCheckVersioningEnabled,
	nextcloudListFolder,
	nextcloudReadFile,
	nextcloudSearch,
	nextcloudStat,
} from "$lib/server/services/connections/providers/nextcloud-files";
import {
	OneDriveError,
	onedriveGetAccessTokenForRead,
	onedriveListFolder,
	onedriveReadFile,
	onedriveSearch,
	onedriveStat,
	onedriveWebUrl,
} from "$lib/server/services/connections/providers/onedrive";
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

import { applyLocalDistillGate } from "./connector-distill";
import { noMatchingConnectionMessage, truncateText } from "./shared";

export const filesToolInputSchema = z.object({
	action: z.enum([
		"list",
		"search",
		"read",
		"save",
		"move",
		"delete",
		"create_folder",
		"share_link",
	]),
	query: z.string().optional(),
	path: z.string().optional(),
	// Destination for "move" (also serves rename — a move where only the final
	// path segment changes). Ignored by every other action.
	destinationPath: z.string().optional(),
	content: z.string().optional(),
	// Multi-connection disambiguation — target ONE specific Files connection
	// when the user has more than one (e.g. both Nextcloud and OneDrive). A
	// provider name ("nextcloud"), a connection label, or the account
	// identifier all work — see selectConnection in resolve.ts. Omitted -> the
	// usual default (see pickDefaultConnection): a read uses the first
	// connection alphabetically; a write prefers a writes-enabled connection.
	account: z.string().optional(),
});

export type FilesToolInput = z.infer<typeof filesToolInputSchema>;

export function sanitizeFilesToolInput(input: FilesToolInput): FilesToolInput {
	return {
		action: input.action,
		...(input.query ? { query: input.query.trim() } : {}),
		...(input.path ? { path: input.path.trim() } : {}),
		...(input.destinationPath
			? { destinationPath: input.destinationPath.trim() }
			: {}),
		...(input.content !== undefined ? { content: input.content } : {}),
		...(input.account ? { account: input.account.trim() } : {}),
	};
}

export type FilesCitation = { label: string; path: string; url: string };

export type FilesToolResultItem = {
	name: string;
	path: string;
	isDir: boolean;
	size: number;
	contentType: string | null;
	// Last-modified time, in whatever timestamp format the connected provider
	// reports (Nextcloud: an RFC 1123 date string; OneDrive: an ISO 8601
	// string), or null when the provider didn't report one. Surfaced so the
	// model can answer "my most recent invoice" / "the newest file" —
	// impossible without it.
	mtime: string | null;
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

// Write actions stay Nextcloud-only for v1 (see the onedrive guard in
// runFilesTool) — module-scope so the Set literal isn't rebuilt per call.
const WRITE_ACTIONS = new Set<FilesToolInput["action"]>([
	"save",
	"move",
	"delete",
	"create_folder",
	"share_link",
]);

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

// True when two paths share the same parent directory (so a move between them
// is really a rename). Compares the path minus its final segment; leading
// slashes and repeated separators are ignored via the filter(Boolean) split.
function sameParent(a: string, b: string): boolean {
	const parent = (p: string) =>
		p.split("/").filter(Boolean).slice(0, -1).join("/");
	return parent(a) === parent(b);
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

// ---------------------------------------------------------------------------
// Provider dispatch (Task 8) — the files tool now serves two "files"-capability
// providers: Nextcloud (WebDAV, unchanged behavior) and OneDrive (Microsoft
// Graph, read-only). READ actions (list/search/read + the stat/metadata used
// internally for the folder-guard) dispatch on `conn.provider` through the
// small wrapper functions below rather than each call site branching itself
// — every existing Nextcloud call keeps calling nextcloudXxx(conn, secret,
// ...) with the exact same arguments it always has (see files.test.ts, which
// asserts on those exact calls), so Nextcloud behavior is byte-for-byte
// unchanged. WRITE actions (save/move/delete/create_folder/share_link) are
// NOT part of this dispatch — they stay Nextcloud-only for v1; a write
// against a onedrive connection is refused up front in runFilesTool, before
// any of the Nextcloud write-outcome functions ever run (see the
// `onedrive` guard near the top of runFilesTool below).
//
// FileEntry is a superset of nextcloud-files.ts's NcFile shape (adds an
// optional `webUrl`, populated only by OneDrive) — NcFile is structurally
// assignable to it since the extra field is optional, so nothing in
// nextcloud-files.ts needs to change.
export type FileEntry = {
	name: string;
	path: string;
	isDir: boolean;
	size: number;
	mtime: string | null;
	contentType: string | null;
	etag: string | null;
	webUrl?: string | null;
};

export type FileContent = {
	bytes: Uint8Array;
	etag: string | null;
	contentType: string | null;
	mtime: string | null;
	webUrl?: string | null;
};

function listFolderForConn(
	conn: ConnectionPublic,
	secret: string,
	path: string,
): Promise<FileEntry[]> {
	if (conn.provider === "onedrive") {
		return onedriveListFolder(conn, secret, path);
	}
	return nextcloudListFolder(conn, secret, path);
}

function searchFilesForConn(
	conn: ConnectionPublic,
	secret: string,
	query: string,
): Promise<FileEntry[]> {
	if (conn.provider === "onedrive") {
		return onedriveSearch(conn, secret, query);
	}
	return nextcloudSearch(conn, secret, query);
}

// `accessToken` is an already-resolved OneDrive access token (ignored for
// Nextcloud, which doesn't do this per-call refresh dance) — see the `read`
// action in runFilesTool below, which resolves ONE token up front and passes
// it to both statForConn (the isDirectory guard) and readFileForConn so a
// single logical read never triggers two OAuth refreshes. Microsoft ROTATES
// refresh tokens on every use, so two refreshes per read would otherwise
// double vault writes and race two concurrent reads into invalidating each
// other's stored refresh token (see onedrive.ts's
// onedriveGetAccessTokenForRead doc comment).
function readFileForConn(
	conn: ConnectionPublic,
	secret: string,
	path: string,
	accessToken?: string,
): Promise<FileContent> {
	if (conn.provider === "onedrive") {
		return onedriveReadFile(conn, secret, path, { accessToken });
	}
	return nextcloudReadFile(conn, secret, path);
}

function statForConn(
	conn: ConnectionPublic,
	secret: string,
	path: string,
	accessToken?: string,
): Promise<FileEntry | null> {
	if (conn.provider === "onedrive") {
		return onedriveStat(conn, secret, path, { accessToken });
	}
	return nextcloudStat(conn, secret, path);
}

// Citation web URL for a file entry/read result. OneDrive items carry their
// own `webUrl` (from Microsoft Graph, see onedriveWebUrl's doc comment);
// Nextcloud has no such field in its WebDAV PROPFIND/GET response, so it
// keeps building one from the connection's serverUrl + path exactly as
// before.
function webUrlForConn(
	conn: ConnectionPublic,
	path: string,
	webUrl?: string | null,
): string {
	if (conn.provider === "onedrive") {
		return onedriveWebUrl({ webUrl: webUrl ?? null });
	}
	return nextcloudWebUiUrl(conn, path);
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
	const other = connections.find((c) => c.id !== conn.id);
	return `You have ${connections.length} Files connections (${labels}); using "${conn.label}" for this request.${other ? ` Pass account:"${other.label}" to use ${other.label} instead.` : ""}`;
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
	if (err instanceof OneDriveError) {
		switch (err.code) {
			case "needs_reauth":
			// A read-time refresh that fails with Microsoft's invalid_grant
			// (the stored refresh token was rejected — expired/revoked) means
			// the same thing to the user as needs_reauth: reconnect. See
			// onedriveRefreshAccessToken's doc comment — it throws this code
			// specifically for that case.
			case "invalid_grant":
				return "Your OneDrive connection needs to be reconnected before I can access your files. Please reconnect it in Settings.";
			case "not_found":
				return "That file or folder couldn't be found in your OneDrive.";
			case "too_large":
				return "That file is too large for me to read right now.";
			case "invalid_path":
				return "That file path isn't valid.";
			case "invalid_config":
			case "not_configured":
				return "Your OneDrive connection is missing required configuration. Please reconnect it in Settings.";
			default:
				return "I couldn't reach your files right now. Please try again in a moment.";
		}
	}
	return "I couldn't reach your files right now. Please try again in a moment.";
}

function searchOutcome(
	conn: ConnectionPublic,
	files: FileEntry[],
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
		mtime: file.mtime,
	}));
	const citations: FilesCitation[] = limited
		.filter((file) => !file.isDir)
		.map((file) => ({
			label: file.name,
			path: file.path,
			url: webUrlForConn(conn, file.path, file.webUrl),
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

function listOutcome(
	conn: ConnectionPublic,
	path: string | undefined,
	files: FileEntry[],
	ambiguous: boolean,
	connections: ConnectionPublic[],
): FilesToolOutcome {
	const results: FilesToolResultItem[] = files.map((file) => ({
		name: file.name,
		path: file.path,
		isDir: file.isDir,
		size: file.size,
		contentType: file.contentType,
		mtime: file.mtime,
	}));
	// Only concrete files get a clickable citation — folders aren't documents.
	const citations: FilesCitation[] = files
		.filter((file) => !file.isDir)
		.map((file) => ({
			label: file.name,
			path: file.path,
			url: webUrlForConn(conn, file.path, file.webUrl),
		}));
	const folderLabel = path?.trim() ? path.trim() : "your Files root";
	const dirCount = files.filter((file) => file.isDir).length;
	const fileCount = files.length - dirCount;
	const baseMessage =
		files.length === 0
			? `${folderLabel} is empty.`
			: `${folderLabel} contains ${files.length} ${files.length === 1 ? "item" : "items"} (${fileCount} ${fileCount === 1 ? "file" : "files"}, ${dirCount} ${dirCount === 1 ? "folder" : "folders"}).`;
	return buildPayload({
		success: true,
		action: "list",
		message: withAmbiguityPrefix(baseMessage, ambiguous, conn, connections),
		results,
		citations,
	});
}

// Best-effort check for whether `path` is a folder. A GET on a folder
// (WebDAV collection for Nextcloud; a driveItem with a `folder` facet for
// OneDrive) returns a misleading 2xx (the read path would report a bogus
// "Read X." success for a folder), so the read action uses this to redirect
// the model to the `list` action instead. Never throws and never *blocks* a
// read: an inconclusive stat (null / thrown) falls through to
// readFileForConn, which has its own not_found handling — only a POSITIVE
// "this is a directory" short-circuits.
async function isDirectory(
	conn: ConnectionPublic,
	secret: string,
	path: string,
	accessToken?: string,
): Promise<boolean> {
	try {
		const existing = await statForConn(conn, secret, path, accessToken);
		return existing?.isDir ?? false;
	} catch {
		return false;
	}
}

function readOutcome(
	conn: ConnectionPublic,
	path: string,
	file: FileContent,
	ambiguous: boolean,
	connections: ConnectionPublic[],
): FilesToolOutcome {
	const label = fileLabel(path);
	const citation: FilesCitation = {
		label,
		path,
		url: webUrlForConn(conn, path, file.webUrl),
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
			mtime: file.mtime ?? null,
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
			mtime: file.mtime ?? null,
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
	conversationId: string | undefined,
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

	// Fix 2 (write-safety hardening) — `reversible` must be TRUTHFUL: an
	// overwrite is only actually recoverable if the connected Nextcloud
	// server has its Versions app enabled. `null` (probe failed/inconclusive)
	// is treated the same as "off" — conservative, never assumed safe.
	const versioningStatus = await nextcloudCheckVersioningEnabled(conn, secret);
	const reversible = versioningStatus === true;

	const op: WriteOperation = {
		provider: conn.provider,
		connectionId: conn.id,
		action: "files.put",
		summary: `Save ${label} to ${target.path}`,
		reversible,
		destructive,
		target: { path: target.path, withinAllowlist: target.withinAllowlist },
	};
	const preview = buildWritePreview(op);
	// buildWritePreview already adds a generic "may not be recoverable"
	// warning for any destructive && !reversible op — this appends the
	// specific reason so the user knows WHY: no version history on the
	// server (confirmed off) vs. simply couldn't confirm either way.
	if (destructive && !reversible) {
		preview.warnings.push(
			versioningStatus === false
				? "Nextcloud version history is off on this server, so this overwrite cannot be recovered."
				: "Could not confirm whether this overwrite is recoverable (Nextcloud version history status unknown).",
		);
	}

	const { id } = await createPendingWrite(userId, {
		connectionId: conn.id,
		provider: conn.provider,
		op,
		content: input.content,
		idempotencyKey: idempotencyKey(op),
		preview,
		conversationId,
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

// GAP A1 — the tool's move action (also serves rename: a move where only the
// final path segment changes). Same explicit-confirm posture as saveOutcome:
// the allowWrites gate is checked BEFORE the secret is decrypted, a
// WriteOperation + preview is built via the write-guard, and a PENDING row is
// created. This function NEVER calls executeNextcloudWrite — the only path to
// an actual MOVE is a later explicit user confirm. The source + destination
// are stored in the pending row's `content` as JSON so the executor can MOVE
// from -> to on confirm; the DESTINATION is the write target that
// resolveWriteTarget checks against the allowlist (where the file lands),
// exactly like a save.
async function moveOutcome(
	userId: string,
	conversationId: string | undefined,
	conn: ConnectionPublic,
	input: FilesToolInput,
	ambiguous: boolean,
	connections: ConnectionPublic[],
): Promise<FilesToolOutcome> {
	if (conn.allowWrites !== true) {
		return buildPayload({
			success: false,
			action: "move",
			message: `Writing to ${conn.label} is turned off; enable it in settings.`,
		});
	}

	if (!input.path) {
		return buildPayload({
			success: false,
			action: "move",
			message: "A source path is required to move or rename a file.",
		});
	}
	if (!input.destinationPath) {
		return buildPayload({
			success: false,
			action: "move",
			message: "A destination path is required to move or rename a file.",
		});
	}

	const secret = await getConnectionSecret(userId, conn.id);
	if (!secret) {
		return buildPayload({
			success: false,
			action: "move",
			message:
				"Your Nextcloud connection is missing its stored credentials. Please reconnect it in Settings.",
		});
	}

	const target = resolveWriteTarget({
		allowlist: conn.writeAllowlist,
		requestedPath: input.destinationPath,
		defaultArea: conn.writeAllowlist[0],
	});
	const fromLabel = fileLabel(input.path);
	const toLabel = fileLabel(target.path);
	// A rename keeps the same parent directory and only changes the final
	// segment; a move relocates the file. Purely cosmetic (for the summary) —
	// both are the same MOVE under the hood.
	const isRename =
		fileLabel(input.path) !== toLabel && sameParent(input.path, target.path);

	const op: WriteOperation = {
		provider: conn.provider,
		connectionId: conn.id,
		action: "files.move",
		summary: isRename
			? `Rename ${fromLabel} to ${toLabel}`
			: `Move ${fromLabel} to ${target.path}`,
		// A MOVE here always uses Overwrite:F (nextcloudMoveFile default), so it
		// can never clobber an existing destination — it's non-destructive, and
		// reversible via Nextcloud's own trash/versions if undone.
		reversible: true,
		destructive: false,
		target: { path: target.path, withinAllowlist: target.withinAllowlist },
		// Disambiguate the idempotency key per (source, destination) pair — the
		// destination alone lives in target.path.
		payloadFingerprint: input.path,
	};
	const preview = buildWritePreview(op);

	const { id } = await createPendingWrite(userId, {
		connectionId: conn.id,
		provider: conn.provider,
		op,
		content: JSON.stringify({ fromPath: input.path, toPath: target.path }),
		idempotencyKey: idempotencyKey(op),
		preview,
		conversationId,
	});

	const verb = isRename ? "rename" : "move";
	const message = withAmbiguityPrefix(
		`I've prepared a ${verb} of "${fromLabel}" to ${target.path}, but it has NOT been moved yet — it is PENDING and awaiting your explicit confirmation. ${preview.detail}${preview.warnings.length > 0 ? ` Warnings: ${preview.warnings.join("; ")}.` : ""}`,
		ambiguous,
		conn,
		connections,
	);

	return buildPayload({
		success: true,
		action: "move",
		message,
		pendingWriteId: id,
		preview,
	});
}

// GAP A1 — the tool's delete action. Delete-to-trash: the underlying adapter
// issues a plain WebDAV DELETE (Nextcloud moves the item to the user's
// trashbin), so the op is destructive but reversible. Same explicit-confirm
// posture as saveOutcome/moveOutcome: allowWrites is checked BEFORE the secret
// is decrypted, a PENDING row is created, and executeNextcloudWrite is NEVER
// called here. A path is REQUIRED — unlike save/move there is no sensible
// default target for a delete, so an unspecified path is refused rather than
// falling back to the allowlist root.
async function deleteOutcome(
	userId: string,
	conversationId: string | undefined,
	conn: ConnectionPublic,
	input: FilesToolInput,
	ambiguous: boolean,
	connections: ConnectionPublic[],
): Promise<FilesToolOutcome> {
	if (conn.allowWrites !== true) {
		return buildPayload({
			success: false,
			action: "delete",
			message: `Writing to ${conn.label} is turned off; enable it in settings.`,
		});
	}

	if (!input.path) {
		return buildPayload({
			success: false,
			action: "delete",
			message: "A file path is required to delete a file.",
		});
	}

	const secret = await getConnectionSecret(userId, conn.id);
	if (!secret) {
		return buildPayload({
			success: false,
			action: "delete",
			message:
				"Your Nextcloud connection is missing its stored credentials. Please reconnect it in Settings.",
		});
	}

	const target = resolveWriteTarget({
		allowlist: conn.writeAllowlist,
		requestedPath: input.path,
		defaultArea: conn.writeAllowlist[0],
	});
	const label = fileLabel(target.path);

	const op: WriteOperation = {
		provider: conn.provider,
		connectionId: conn.id,
		action: "files.delete",
		summary: `Move ${label} to trash (${target.path})`,
		// Nextcloud's server-side trashbin keeps the deleted item, so this is
		// recoverable from the Nextcloud UI — reversible, but still destructive.
		reversible: true,
		destructive: true,
		target: { path: target.path, withinAllowlist: target.withinAllowlist },
	};
	const preview = buildWritePreview(op);

	const { id } = await createPendingWrite(userId, {
		connectionId: conn.id,
		provider: conn.provider,
		op,
		content: "",
		idempotencyKey: idempotencyKey(op),
		preview,
		conversationId,
	});

	const message = withAmbiguityPrefix(
		`I've prepared a delete of "${label}" (${target.path}), but it has NOT been deleted yet — it is PENDING and awaiting your explicit confirmation. It will go to your Nextcloud trash (recoverable), not be permanently removed. ${preview.detail}${preview.warnings.length > 0 ? ` Warnings: ${preview.warnings.join("; ")}.` : ""}`,
		ambiguous,
		conn,
		connections,
	);

	return buildPayload({
		success: true,
		action: "delete",
		message,
		pendingWriteId: id,
		preview,
	});
}

// GAP B9a — the tool's create_folder action (WebDAV MKCOL). Same explicit-
// confirm posture as save/move/delete: the allowWrites gate is checked BEFORE
// the secret is decrypted, a WriteOperation + preview is built via the write-
// guard, and a PENDING row is created. This function NEVER calls
// executeNextcloudWrite — the only path to an actual MKCOL is a later explicit
// user confirm. Non-destructive (a folder that already exists is refused as a
// conflict at execute time, never a clobber) and reversible (deleting the
// created folder undoes it). A path is REQUIRED — like delete there is no
// sensible default target for "create a folder".
async function createFolderOutcome(
	userId: string,
	conversationId: string | undefined,
	conn: ConnectionPublic,
	input: FilesToolInput,
	ambiguous: boolean,
	connections: ConnectionPublic[],
): Promise<FilesToolOutcome> {
	if (conn.allowWrites !== true) {
		return buildPayload({
			success: false,
			action: "create_folder",
			message: `Writing to ${conn.label} is turned off; enable it in settings.`,
		});
	}

	if (!input.path) {
		return buildPayload({
			success: false,
			action: "create_folder",
			message: "A folder path is required to create a folder.",
		});
	}

	const secret = await getConnectionSecret(userId, conn.id);
	if (!secret) {
		return buildPayload({
			success: false,
			action: "create_folder",
			message:
				"Your Nextcloud connection is missing its stored credentials. Please reconnect it in Settings.",
		});
	}

	const target = resolveWriteTarget({
		allowlist: conn.writeAllowlist,
		requestedPath: input.path,
		defaultArea: conn.writeAllowlist[0],
	});
	const label = fileLabel(target.path);

	const op: WriteOperation = {
		provider: conn.provider,
		connectionId: conn.id,
		action: "files.create_folder",
		summary: `Create folder ${label} at ${target.path}`,
		// Reversible (deleting the folder undoes it) and non-destructive (MKCOL
		// never overwrites — an existing folder is refused as a conflict).
		reversible: true,
		destructive: false,
		target: { path: target.path, withinAllowlist: target.withinAllowlist },
	};
	const preview = buildWritePreview(op);

	const { id } = await createPendingWrite(userId, {
		connectionId: conn.id,
		provider: conn.provider,
		op,
		content: "",
		idempotencyKey: idempotencyKey(op),
		preview,
		conversationId,
	});

	const message = withAmbiguityPrefix(
		`I've prepared creating a new folder "${label}" at ${target.path}, but it has NOT been created yet — it is PENDING and awaiting your explicit confirmation. ${preview.detail}${preview.warnings.length > 0 ? ` Warnings: ${preview.warnings.join("; ")}.` : ""}`,
		ambiguous,
		conn,
		connections,
	);

	return buildPayload({
		success: true,
		action: "create_folder",
		message,
		pendingWriteId: id,
		preview,
	});
}

// The public-exposure warning surfaced in a share_link confirm preview. This
// is the load-bearing invariant for this SENSITIVE write: it must be the FIRST
// warning the user sees, so a public link is never created without an explicit,
// prominent heads-up.
const PUBLIC_SHARE_WARNING =
	"This creates a PUBLIC link that anyone with the URL can open — no Nextcloud login required.";

// GAP B9b — the tool's share_link action (OCS Shares API, public link). This
// is a SENSITIVE write: it creates PUBLIC exposure of a file, so the confirm
// preview prominently carries PUBLIC_SHARE_WARNING. Same explicit-confirm
// posture as the other writes: the allowWrites gate is checked BEFORE the
// secret is decrypted, a PENDING row is created, and executeNextcloudWrite is
// NEVER called here — the only path to an actual share is a later explicit user
// confirm, on which the public URL is returned. Treated as reversible (the
// share can be removed) and non-destructive (the file itself is untouched), but
// high-sensitivity. Optional password/expiry the OCS API supports are future
// work. A path is REQUIRED.
async function shareLinkOutcome(
	userId: string,
	conversationId: string | undefined,
	conn: ConnectionPublic,
	input: FilesToolInput,
	ambiguous: boolean,
	connections: ConnectionPublic[],
): Promise<FilesToolOutcome> {
	if (conn.allowWrites !== true) {
		return buildPayload({
			success: false,
			action: "share_link",
			message: `Writing to ${conn.label} is turned off; enable it in settings.`,
		});
	}

	if (!input.path) {
		return buildPayload({
			success: false,
			action: "share_link",
			message: "A file path is required to create a public share link.",
		});
	}

	const secret = await getConnectionSecret(userId, conn.id);
	if (!secret) {
		return buildPayload({
			success: false,
			action: "share_link",
			message:
				"Your Nextcloud connection is missing its stored credentials. Please reconnect it in Settings.",
		});
	}

	const target = resolveWriteTarget({
		allowlist: conn.writeAllowlist,
		requestedPath: input.path,
		defaultArea: conn.writeAllowlist[0],
	});
	const label = fileLabel(target.path);

	const op: WriteOperation = {
		provider: conn.provider,
		connectionId: conn.id,
		action: "files.share_link",
		summary: `Create a public link for ${label}`,
		// The share can be revoked from the Nextcloud UI (reversible) and the
		// file itself is not modified (non-destructive) — but see
		// PUBLIC_SHARE_WARNING for why this is still a high-sensitivity write.
		reversible: true,
		destructive: false,
		target: { path: target.path, withinAllowlist: target.withinAllowlist },
	};
	const preview = buildWritePreview(op);
	// Prepend the public-exposure warning so it is the FIRST warning shown —
	// buildWritePreview has no notion of "public exposure", so it is added here.
	preview.warnings = [PUBLIC_SHARE_WARNING, ...preview.warnings];

	const { id } = await createPendingWrite(userId, {
		connectionId: conn.id,
		provider: conn.provider,
		op,
		content: "",
		idempotencyKey: idempotencyKey(op),
		preview,
		conversationId,
	});

	const message = withAmbiguityPrefix(
		`I've prepared a PUBLIC share link for "${label}" (${target.path}), but it has NOT been created yet — it is PENDING and awaiting your explicit confirmation. WARNING: ${PUBLIC_SHARE_WARNING} ${preview.detail}${preview.warnings.length > 0 ? ` Warnings: ${preview.warnings.join("; ")}.` : ""}`,
		ambiguous,
		conn,
		connections,
	);

	return buildPayload({
		success: true,
		action: "share_link",
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
// Assembles this tool's raw file content + field-level stripping and delegates
// the identical gating control flow to the shared applyLocalDistillGate (see
// connector-distill.ts). The per-tool part — that `results[].content` is the
// raw field, and how it's stripped — stays here.
function distillFilesReadOutcome(params: {
	userId: string;
	modelId: string;
	input: FilesToolInput;
	outcome: FilesToolOutcome;
}): Promise<FilesToolOutcome> {
	const { userId, modelId, input, outcome } = params;

	const rawText = outcome.modelPayload.results
		.map((result) => result.content)
		.filter((content): content is string => Boolean(content))
		.join("\n\n");

	const strippedResults = () =>
		outcome.modelPayload.results.map((result) => {
			const { content: _content, ...rest } = result;
			return rest;
		});

	return applyLocalDistillGate({
		outcome,
		userId,
		modelId,
		capability: "files",
		userQuestion: input.query ?? input.path ?? "",
		rawText,
		onDistilled: (o, distilled) => ({
			...o,
			modelPayload: {
				...o.modelPayload,
				message: `${o.modelPayload.message} Privately summarized for a cloud model. Summary: ${distilled}`,
				results: strippedResults(),
			},
		}),
		onUnavailable: (o) => ({
			...o,
			modelPayload: {
				...o.modelPayload,
				message:
					"This file's content couldn't be privately summarized for a cloud model, so it was withheld. Switch to a local model to view it, or try again.",
				results: strippedResults(),
			},
		}),
	});
}

// Resolves the user's Files connection(s) and executes a search/read against
// Nextcloud, degrading gracefully (never throwing) so a connection problem
// never aborts the chat turn: no connection, ambiguity, and adapter failures
// all resolve to a `{ success: false, message }`-shaped payload instead.
export async function runFilesTool(
	userId: string,
	input: FilesToolInput,
	modelId: string,
	conversationId?: string,
): Promise<FilesToolOutcome> {
	const notConnectedMessage =
		"You don't have a Files connection set up yet. Connect your Nextcloud or OneDrive account in Settings to search or read files.";

	const result = await withCapabilityConnection(
		userId,
		"files",
		{ account: input.account, forWrite: WRITE_ACTIONS.has(input.action) },
		async (conn, { ambiguous, connections }): Promise<FilesToolOutcome> => {
			// Task 8 — writes stay Nextcloud-only for v1. OneDrive is a read-only
			// connector (see providers/onedrive.ts's module doc): a write action
			// against a onedrive connection is refused here, before ANY of the
			// write-outcome functions below run (so no pending row is ever created
			// and no Nextcloud-shaped write assumption — resolveWriteTarget,
			// wouldOverwrite's nextcloudStat call, etc. — is ever exercised against a
			// non-Nextcloud connection).
			if (WRITE_ACTIONS.has(input.action) && conn.provider !== "nextcloud") {
				return buildPayload({
					success: false,
					action: input.action,
					message: `Writing to ${conn.label} isn't supported yet — OneDrive connections are currently read-only. I can list, search, and read files, but not save, move, delete, create folders, or share links.`,
				});
			}

			// The write actions ("save", "move", "delete", "create_folder",
			// "share_link") are write proposals, not
			// reads: each must check the allowWrites gate BEFORE any secret is
			// decrypted, so they branch here — before the shared getConnectionSecret
			// call below — and manage their own secret fetch internally once the gate
			// has passed. None of them ever executes inline; each only ever creates a
			// PENDING row awaiting explicit confirmation.
			if (input.action === "save") {
				return saveOutcome(
					userId,
					conversationId,
					conn,
					input,
					ambiguous,
					connections,
				);
			}

			if (input.action === "move") {
				return moveOutcome(
					userId,
					conversationId,
					conn,
					input,
					ambiguous,
					connections,
				);
			}

			if (input.action === "delete") {
				return deleteOutcome(
					userId,
					conversationId,
					conn,
					input,
					ambiguous,
					connections,
				);
			}

			if (input.action === "create_folder") {
				return createFolderOutcome(
					userId,
					conversationId,
					conn,
					input,
					ambiguous,
					connections,
				);
			}

			if (input.action === "share_link") {
				return shareLinkOutcome(
					userId,
					conversationId,
					conn,
					input,
					ambiguous,
					connections,
				);
			}

			const secret = await getConnectionSecret(userId, conn.id);
			if (!secret) {
				return buildPayload({
					success: false,
					action: input.action,
					message: `Your ${conn.label} connection is missing its stored credentials. Please reconnect it in Settings.`,
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
					const files = await searchFilesForConn(conn, secret, input.query);
					const outcome = searchOutcome(conn, files, ambiguous, connections);
					return distillFilesReadOutcome({ userId, modelId, input, outcome });
				}

				// "list" enumerates a folder's immediate children (files + subfolders) so
				// the model can navigate the tree and count items — an omitted/empty path
				// lists the Files root. This is what "how many files are in <folder>" and
				// "what's in my <folder>" need; `search` only finds by name and can't
				// enumerate a folder's contents.
				if (input.action === "list") {
					const files = await listFolderForConn(conn, secret, input.path ?? "");
					const outcome = listOutcome(
						conn,
						input.path,
						files,
						ambiguous,
						connections,
					);
					return distillFilesReadOutcome({ userId, modelId, input, outcome });
				}

				if (!input.path) {
					return buildPayload({
						success: false,
						action: "read",
						message: "A file path is required to read a file.",
					});
				}
				// A `read` fans out into a stat (the isDirectory guard just below) and
				// then the actual download — for OneDrive that's two Graph calls, each
				// of which would otherwise mint its own fresh access token. Resolve ONE
				// token here and thread it through both so Microsoft's refresh-token
				// rotation only fires once per read (see readFileForConn's doc comment).
				// Left undefined for Nextcloud, which ignores it.
				const accessToken =
					conn.provider === "onedrive"
						? await onedriveGetAccessTokenForRead(conn)
						: undefined;
				// A folder path can't be read as a file — a raw GET on a folder
				// otherwise returns a misleading success. Redirect the model to `list`.
				if (await isDirectory(conn, secret, input.path, accessToken)) {
					return buildPayload({
						success: false,
						action: "read",
						message: `"${fileLabel(input.path)}" is a folder, not a file. Use the "list" action to see what's inside it.`,
					});
				}
				const file = await readFileForConn(
					conn,
					secret,
					input.path,
					accessToken,
				);
				const outcome = readOutcome(
					conn,
					input.path,
					file,
					ambiguous,
					connections,
				);
				return distillFilesReadOutcome({ userId, modelId, input, outcome });
			} catch (err) {
				return buildPayload({
					success: false,
					action: input.action,
					message: mapAdapterError(err),
				});
			}
		},
	);

	if (result.kind === "not-connected") {
		return buildPayload({
			success: false,
			action: input.action,
			message: notConnectedMessage,
		});
	}
	if (result.kind === "no-match") {
		return buildPayload({
			success: false,
			action: input.action,
			message: noMatchingConnectionMessage(
				"Files",
				result.selector,
				result.connections,
			),
		});
	}
	return result.value;
}
