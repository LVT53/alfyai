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
	WRITE_WARNING,
	type WriteOperation,
	type WritePreview,
} from "$lib/server/services/connections/write-guard";
import type { ToolEvidenceCandidate } from "$lib/server/services/message-evidence";
import type { ToolCallFilesData } from "$lib/server/services/messages-types";
import { getEntryByMimeType, resolveEntry } from "$lib/shared/file-types";
import { isSeeableImage } from "$lib/shared/file-types/seeable-image";
import { FILE_CARD_LIMIT } from "$lib/utils/tool-calls";

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
	// Nextcloud's own numeric id, when the adapter reported one. Carried on the
	// result (not only on the internal FileEntry) so the card data built from
	// these results can address the file without a second lookup.
	fileId?: number;
	// The Files-app deep link, built once per result through webUrlForConn and
	// reused for the citation — never recomputed. Only concrete files carry
	// one: a folder is not a document to open.
	webUrl?: string;
	// The app-relative preview route URL, for a Nextcloud image the app can
	// draw. Absent for a non-image, a folder, and every non-Nextcloud provider.
	previewUrl?: string;
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
	// Set by "list" only: the folder's size before the bounded page, its file
	// extension mix, and the offset of the next page (null when this page is
	// the whole folder). Other actions leave them unset.
	total?: number;
	byType?: Array<{ ext: string; count: number }>;
	nextOffset?: number | null;
	// Only set for a successful "save" action — the write has NOT executed,
	// this is the id the user's confirm/cancel decision applies to (4.3).
	pendingWriteId?: string;
	preview?: WritePreview;
};

export type FilesToolOutcome = {
	modelPayload: FilesToolModelPayload;
	candidates: ToolEvidenceCandidate[];
	// What the reply's file cards need (messages-types.ts's ToolCallFilesData),
	// or null when this connection cannot serve previews (OneDrive) or the
	// outcome has no results to show. Built inside runFilesTool, where the
	// resolved connection is known. Deliberately NOT part of modelPayload: the
	// model keeps seeing `results`, never the card data.
	cards: ToolCallFilesData | null;
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
// A folder of any size must not turn into a tool result that can eat the
// model's whole context window (a 4,312-entry folder once produced a
// 237k-token result and a provider 400). "list" returns the newest
// MAX_LIST_RESULTS entries plus a summary of the folder instead.
const MAX_LIST_RESULTS = 50;
// The card cap itself (`FILE_CARD_LIMIT`) is imported from `$lib/utils/tool-calls`:
// it is six per REPLY, applied where the reply's cards are assembled
// (`capFileCards`), because two calls that each found four must draw six cards
// in all, not eight. `buildFilesCards` uses it only to bound ONE call's stored
// JSON, so the two concerns share one number instead of drifting apart.
// The preview route accepts three sizes: 96, which no surface asks for, 192 for
// the strip's card picture, its tiles and its list rows, and 1600 for the
// viewer the strip opens. The card data names the two it carries so the browser
// never guesses which size to draw or open.
export const FILE_PREVIEW_SIZE = 192;
// The viewer's copy of the same picture. 1600 is the route's largest size: the
// whole image fitted in a 1600 box, since the adapter asks Nextcloud to keep
// the aspect ratio rather than crop.
export const FILE_VIEW_SIZE = 1600;
// The Nextcloud read adapter already caps raw bytes at 25MB (chat-context
// reads only); this is a second, much tighter cap on the *text* we inline
// into the model's context so one large text file can't blow the prompt
// budget the way research_web's per-source char budgets do.
// Exported so other tools reuse this ONE inline-text budget rather than
// inventing a second number for the same concern (e.g. read_artifact's
// "full" body / blocks bound — see artifact-tools/read.ts).
export const MAX_INLINE_TEXT_CHARS = 100_000;

// The old TEXT_LIKE_MIME_TYPES set (json, xml, javascript, x-yaml, yaml) is
// exactly the set of non-"text/" MIMEs the registry marks text-like, so the
// members survive without a local table (spec row 56).
function isTextLike(contentType: string | null): boolean {
	if (!contentType) return false;
	const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
	if (type.startsWith("text/")) return true;
	return getEntryByMimeType(type)?.textLike === true;
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
// (see e.g. nextcloud/server#7874, #27100), and it stays the fallback for a
// result whose server did not report an id. The newer `openfile=<fileId>` form
// (nextcloud/server, NC19+) opens the file itself and is what current versions
// prefer, so it is used whenever the adapter reported the file's *numeric*
// internal id (`NcFile.fileId`, read from the `oc:fileid` PROPFIND property by
// nextcloud-files.ts). `scrollto` is reported to no-op (no highlight/scroll)
// on some newer server versions per nextcloud/server#46113, but it never
// produces an invalid URL: worst case the link still opens the Files app at
// the file's parent directory, which satisfies the "safe, correct link" bar.
export function nextcloudWebUiUrl(
	conn: ConnectionPublic,
	path: string,
	fileId?: number,
): string {
	const serverUrl =
		typeof conn.config.serverUrl === "string" ? conn.config.serverUrl : "";
	// Paths the adapter reports have no leading slash; trimming one keeps the
	// `dir` parameter well-formed if a caller passes one anyway.
	const normalizedPath = path.replace(/^\/+/, "");
	const lastSlash = normalizedPath.lastIndexOf("/");
	const dir = lastSlash === -1 ? "" : normalizedPath.slice(0, lastSlash);
	const name =
		lastSlash === -1 ? normalizedPath : normalizedPath.slice(lastSlash + 1);
	const dirParam = encodeURIComponent(`/${dir}`);
	if (fileId !== undefined && fileId > 0) {
		return `${serverUrl}/index.php/apps/files/?dir=${dirParam}&openfile=${fileId}`;
	}
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
// FileEntry is a superset of nextcloud-files.ts's NcFile shape (it adds an
// optional `webUrl`, populated only by OneDrive) — NcFile is structurally
// assignable to it since the extra field is optional, so nothing in
// nextcloud-files.ts needs to change. `fileId` is Nextcloud's own numeric id
// and stays optional because an older/misbehaving server may not report one;
// OneDrive leaves it absent.
export type FileEntry = {
	name: string;
	path: string;
	isDir: boolean;
	size: number;
	mtime: string | null;
	contentType: string | null;
	etag: string | null;
	fileId?: number;
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
// it to both statForConn (the read's stat guard) and readFileForConn so a
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
// Nextcloud's WebDAV GET response carries no URL, so it keeps building one
// from the connection's serverUrl + path, using Nextcloud's own file id (when
// the adapter reported it) so the link opens the file itself.
function webUrlForConn(
	conn: ConnectionPublic,
	path: string,
	fileId: number | undefined,
	webUrl?: string | null,
): string {
	if (conn.provider === "onedrive") {
		return onedriveWebUrl({ webUrl: webUrl ?? null });
	}
	return nextcloudWebUiUrl(conn, path, fileId);
}

// The app-relative URL the file card's <img> loads, at one of the preview
// route's sizes. Only a Nextcloud connection can serve one (the preview route
// reads that user's app password server-side), and only for an image the app
// can draw: asking Nextcloud to render a PDF preview would spend an upstream
// render on bytes the card can never show. The decision is shared, not a
// second extension list — see isSeeableImage — but it is one answer narrower
// than the model's, because the preview route serves only raster images and
// refuses `image/svg+xml` (an SVG is a document, not a thumbnail). Advertising
// an SVG preview would store a URL that is guaranteed to 404. The route takes
// a file id or, when the server reported no id, the path, so a result whose
// server has no `oc:fileid` still gets a preview instead of silently losing
// it.
function previewUrlForConn(
	conn: ConnectionPublic,
	name: string,
	path: string,
	fileId: number | undefined,
	contentType: string | null,
	isDir: boolean,
	size: number,
): string | undefined {
	if (conn.provider !== "nextcloud" || isDir) return undefined;
	if (!isSeeableImage(name, contentType)) return undefined;
	if (resolveEntry(name, contentType)?.id === "svg") return undefined;
	const target =
		fileId !== undefined
			? `fileId=${fileId}`
			: `path=${encodeURIComponent(path)}`;
	return `/api/connections/nextcloud/preview?connectionId=${encodeURIComponent(conn.id)}&${target}&size=${size}`;
}

// The result items and their citations for one page of entries, built in one
// pass so the Files-app link is computed ONCE per entry and shared by both
// (a citation is not a reason to call webUrlForConn a second time). A folder
// is neither a citable document nor a card, so it carries no webUrl.
function toResultItems(
	conn: ConnectionPublic,
	files: FileEntry[],
): { results: FilesToolResultItem[]; citations: FilesCitation[] } {
	const entries = files.map((file) => {
		const webUrl = file.isDir
			? undefined
			: webUrlForConn(conn, file.path, file.fileId, file.webUrl);
		const previewUrl = previewUrlForConn(
			conn,
			file.name,
			file.path,
			file.fileId,
			file.contentType,
			file.isDir,
			FILE_PREVIEW_SIZE,
		);
		const result: FilesToolResultItem = {
			name: file.name,
			path: file.path,
			isDir: file.isDir,
			size: file.size,
			contentType: file.contentType,
			mtime: file.mtime,
			...(file.fileId !== undefined ? { fileId: file.fileId } : {}),
			...(webUrl !== undefined ? { webUrl } : {}),
			...(previewUrl !== undefined ? { previewUrl } : {}),
		};
		return { file, webUrl, result };
	});
	return {
		results: entries.map((entry) => entry.result),
		citations: entries.flatMap(({ file, webUrl }) =>
			webUrl === undefined
				? []
				: [{ label: file.name, path: file.path, url: webUrl }],
		),
	};
}

// The reply's file cards, from the results the model was also given. Null is
// the OneDrive gate in one place: only Nextcloud can serve a preview, so a
// OneDrive result never grows a card. Directories are not files to open, and
// the list is bounded so a broad search stays a card strip, not a wall.
export function buildFilesCards(
	conn: ConnectionPublic,
	results: FilesToolResultItem[],
): ToolCallFilesData | null {
	if (conn.provider !== "nextcloud") return null;
	const files = results.filter((result) => !result.isDir);
	return {
		connectionId: conn.id,
		cards: files.slice(0, FILE_CARD_LIMIT).map((result) => {
			// The preview URL is the card's answer to "can this be drawn"; the
			// viewer copy exists exactly when that answer is a URL, so the two
			// can never disagree. It is the same builder, at the route's
			// largest size.
			const previewUrl = result.previewUrl ?? null;
			const viewUrl =
				previewUrl === null
					? null
					: (previewUrlForConn(
							conn,
							result.name,
							result.path,
							result.fileId,
							result.contentType,
							result.isDir,
							FILE_VIEW_SIZE,
						) ?? null);
			return {
				name: result.name,
				path: result.path,
				size: result.size,
				mtime: result.mtime,
				contentType: result.contentType,
				previewUrl,
				viewUrl,
				webUrl:
					result.webUrl ?? webUrlForConn(conn, result.path, result.fileId),
			};
		}),
		total: files.length,
	};
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
		// Every outcome starts with no cards; the read outcomes attach them
		// through withFileCards once the connection (and thus preview support)
		// is known, and write/error outcomes correctly stay null.
		cards: null,
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
	const { results, citations } = toResultItems(conn, limited);
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

// mtime arrives in whatever format the provider reports (Nextcloud: RFC 1123,
// OneDrive: ISO 8601), so ordering parses it rather than comparing strings. A
// missing or unparseable timestamp means "unknown age": such entries sort
// after every dated entry instead of pretending to be newest or oldest.
function mtimeMs(mtime: string | null): number | null {
	if (!mtime) return null;
	const parsed = Date.parse(mtime);
	return Number.isFinite(parsed) ? parsed : null;
}

// Locale-independent name order, so the page is deterministic everywhere.
function compareNames(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function compareListEntries(a: FileEntry, b: FileEntry): number {
	const aTime = mtimeMs(a.mtime);
	const bTime = mtimeMs(b.mtime);
	if (aTime !== null && bTime !== null) {
		if (aTime !== bTime) return bTime - aTime;
		return compareNames(a.name, b.name);
	}
	if (aTime !== null) return -1;
	if (bTime !== null) return 1;
	return compareNames(a.name, b.name);
}

// The extension shown in the list summary: lowercased, without the dot, and
// "" when the name has none (including a leading-dot name such as ".env").
function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	if (dot <= 0 || dot === name.length - 1) return "";
	return name.slice(dot + 1).toLowerCase();
}

// The summary's file-extension mix, over the whole folder rather than the
// returned page: it is what tells the model what the unseen rest contains.
// Folders are not files and have no type, so they are not counted here.
function summarizeTypes(
	files: FileEntry[],
): Array<{ ext: string; count: number }> {
	const counts = new Map<string, number>();
	for (const file of files) {
		if (file.isDir) continue;
		const ext = extensionOf(file.name);
		counts.set(ext, (counts.get(ext) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([ext, count]) => ({ ext, count }))
		.sort((a, b) => b.count - a.count || compareNames(a.ext, b.ext))
		.slice(0, 5);
}

function listOutcome(
	conn: ConnectionPublic,
	path: string | undefined,
	files: FileEntry[],
	ambiguous: boolean,
	connections: ConnectionPublic[],
): FilesToolOutcome {
	// Newest first, then a stable name order, so the bounded page is both
	// deterministic and the part of the folder most likely to matter.
	const ordered = [...files].sort(compareListEntries);
	const page = ordered.slice(0, MAX_LIST_RESULTS);
	// Only concrete files get a clickable citation (and a card) — folders
	// aren't documents. Citations describe the returned page, never the
	// entries the page left out, so evidence candidates stay
	// one-per-visible-entry.
	const { results, citations } = toResultItems(conn, page);
	const folderLabel = path?.trim() ? path.trim() : "your Files root";
	const total = files.length;
	const dirCount = files.filter((file) => file.isDir).length;
	const fileCount = total - dirCount;
	const byType = summarizeTypes(files);
	const nextOffset = results.length < total ? results.length : null;
	const baseMessage =
		total === 0
			? `${folderLabel} is empty.`
			: total > results.length
				? `${folderLabel} contains ${total} items (${fileCount} ${fileCount === 1 ? "file" : "files"}, ${dirCount} ${dirCount === 1 ? "folder" : "folders"}), newest first — showing 1–${results.length}. Narrow the path or use \`search\` for a specific name.`
				: `${folderLabel} contains ${total} ${total === 1 ? "item" : "items"} (${fileCount} ${fileCount === 1 ? "file" : "files"}, ${dirCount} ${dirCount === 1 ? "folder" : "folders"}).`;
	const outcome = buildPayload({
		success: true,
		action: "list",
		message: withAmbiguityPrefix(baseMessage, ambiguous, conn, connections),
		results,
		citations,
	});
	return {
		...outcome,
		modelPayload: {
			...outcome.modelPayload,
			total,
			byType,
			nextOffset,
		},
	};
}

// Attaches the reply's card data to an outcome whose results are final (after
// the local-distillation gate, which only strips `content`). The model payload
// is untouched — the model keeps seeing `results`, never the cards.
function withFileCards(
	conn: ConnectionPublic,
	outcome: FilesToolOutcome,
): FilesToolOutcome {
	return {
		...outcome,
		cards: buildFilesCards(conn, outcome.modelPayload.results),
	};
}

// Best-effort stat of the entry a `read` targets. It answers two questions at
// once: whether `path` is a folder (a GET on a folder — WebDAV collection for
// Nextcloud; a driveItem with a `folder` facet for OneDrive — returns a
// misleading 2xx, and the read path would report a bogus "Read X." success),
// and what Nextcloud's own file id is, since the citation links with it and
// the GET response does not carry it. Never throws and never *blocks* a read:
// an inconclusive stat (null / thrown) falls through to readFileForConn, which
// has its own not_found handling — only a POSITIVE "this is a directory"
// short-circuits.
async function statForRead(
	conn: ConnectionPublic,
	secret: string,
	path: string,
	accessToken?: string,
): Promise<FileEntry | null> {
	try {
		return await statForConn(conn, secret, path, accessToken);
	} catch {
		return null;
	}
}

function readOutcome(
	conn: ConnectionPublic,
	path: string,
	file: FileContent,
	fileId: number | undefined,
	ambiguous: boolean,
	connections: ConnectionPublic[],
): FilesToolOutcome {
	const label = fileLabel(path);
	const webUrl = webUrlForConn(conn, path, fileId, file.webUrl);
	const previewUrl = previewUrlForConn(
		conn,
		label,
		path,
		fileId,
		file.contentType,
		false,
		FILE_PREVIEW_SIZE,
	);
	const citation: FilesCitation = {
		label,
		path,
		url: webUrl,
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
			...(fileId !== undefined ? { fileId } : {}),
			webUrl,
			...(previewUrl !== undefined ? { previewUrl } : {}),
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
			...(fileId !== undefined ? { fileId } : {}),
			webUrl,
			...(previewUrl !== undefined ? { previewUrl } : {}),
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
				? WRITE_WARNING.noVersionHistory
				: WRITE_WARNING.versionHistoryUnknown,
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
const PUBLIC_SHARE_WARNING = WRITE_WARNING.publicLink;

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
					return withFileCards(
						conn,
						await distillFilesReadOutcome({ userId, modelId, input, outcome }),
					);
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
					return withFileCards(
						conn,
						await distillFilesReadOutcome({ userId, modelId, input, outcome }),
					);
				}

				if (!input.path) {
					return buildPayload({
						success: false,
						action: "read",
						message: "A file path is required to read a file.",
					});
				}
				// A `read` fans out into a stat (the folder guard just below) and
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
				// This one stat also reports the id the citation links with, so
				// opening the file needs no second request.
				const stat = await statForRead(conn, secret, input.path, accessToken);
				if (stat?.isDir) {
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
					stat?.fileId,
					ambiguous,
					connections,
				);
				return withFileCards(
					conn,
					await distillFilesReadOutcome({ userId, modelId, input, outcome }),
				);
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
