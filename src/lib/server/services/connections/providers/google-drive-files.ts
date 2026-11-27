import { z } from "zod";
import { getCanonicalMimeForExtension } from "$lib/shared/file-types";
import { googleDriveDocumentUrl } from "$lib/shared/google-drive-links";

export type DriveOptions = { fetch?: typeof fetch };
type DriveCode =
	| "invalid_path"
	| "needs_reauth"
	| "not_found"
	| "request_failed"
	| "too_large"
	| "not_supported"
	| "item_changed"
	| "destination_exists";
export class DriveFilesError extends Error {
	constructor(
		message: string,
		readonly code: DriveCode,
	) {
		super(message);
	}
}
const id = z.string().regex(/^[\w-]{1,200}$/);
const googleMime = "application/vnd.google-apps.";
export const driveFolderMime = `${googleMime}folder`;
const meta = z.object({
	id,
	name: z.string(),
	mimeType: z.string(),
	version: z.string().optional(),
	parents: z.array(id).default([]),
	modifiedTime: z.string().optional(),
	size: z.string().regex(/^\d+$/).optional(),
	webViewLink: z.string().optional(),
	trashed: z.boolean().optional(),
	capabilities: z
		.object({
			canDownload: z.boolean().optional(),
			canShare: z.boolean().optional(),
			canEdit: z.boolean().optional(),
			canTrash: z.boolean().optional(),
			canAddChildren: z.boolean().optional(),
		})
		.optional(),
});
export type DriveItem = z.infer<typeof meta>;
const fields =
	"id,name,mimeType,parents,modifiedTime,size,webViewLink,version,trashed,capabilities(canEdit,canShare,canDownload,canTrash,canAddChildren)";
const pageSchema = z.object({
	files: z.array(meta),
	nextPageToken: z.string().min(1).optional(),
	incompleteSearch: z.boolean().optional(),
});
export function drivePath(raw: string) {
	if (
		!raw.startsWith("/") ||
		raw.length > 4096 ||
		raw.includes("\\") ||
		Array.from(raw).some((c) => c.charCodeAt(0) < 32) ||
		raw.split("/").some((p) => p === "." || p === "..")
	)
		throw new DriveFilesError("Invalid Google Drive path.", "invalid_path");
	const segments = raw.split("/").filter(Boolean);
	if (
		segments.length > 32 ||
		(segments[0] === "@drive" && !id.safeParse(segments[1]).success)
	)
		throw new DriveFilesError(
			"Invalid Google Drive path or file identifier.",
			"invalid_path",
		);
	return segments.length ? `/${segments.join("/")}` : "/";
}
export async function driveRequest(
	token: string,
	path: string,
	params: Record<string, string>,
	opts: DriveOptions = {},
	init: RequestInit = {},
) {
	if (!/^(upload\/)?drive\/v[23]\/files(?:\/[A-Za-z0-9_-]+){0,2}$/.test(path))
		throw new DriveFilesError("Invalid Drive API resource.", "invalid_path");
	const url = new URL(`https://www.googleapis.com/${path}`);
	url.search = new URLSearchParams(params).toString();
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${token}`);
	const r = await (opts.fetch ?? fetch)(url, {
		...init,
		headers,
		redirect: "error",
		signal: AbortSignal.timeout(15000),
	});
	if (!r.ok)
		throw new DriveFilesError(
			"Google Drive declined the request.",
			r.status === 401
				? "needs_reauth"
				: r.status === 404
					? "not_found"
					: r.status === 412
						? "item_changed"
						: r.status === 409
							? "destination_exists"
							: "request_failed",
		);
	return r;
}
async function bounded(r: Response, limit: number) {
	if (Number(r.headers.get("content-length")) > limit) {
		await r.body?.cancel();
		throw new DriveFilesError(
			"Drive response exceeded the size limit.",
			"too_large",
		);
	}
	const reader = r.body?.getReader();
	if (!reader) return Buffer.alloc(0);
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const n = await reader.read();
			if (n.done) break;
			bytes += n.value.byteLength;
			if (bytes > limit) {
				await reader.cancel();
				throw new DriveFilesError(
					"Drive response exceeded the size limit.",
					"too_large",
				);
			}
			chunks.push(n.value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks);
}
export async function driveJson(r: Response): Promise<unknown> {
	return JSON.parse((await bounded(r, 4_000_000)).toString("utf8"));
}
function literal(s: string) {
	return `'${s.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}
async function find(
	token: string,
	q: string,
	opts: DriveOptions,
	matches = 10000,
) {
	const items: DriveItem[] = [];
	const seen = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = pageSchema.parse(
			await driveJson(
				await driveRequest(
					token,
					"drive/v3/files",
					{
						q: `trashed = false and (${q})`,
						spaces: "drive",
						corpora: "allDrives",
						pageSize: String(Math.min(matches, 100)),
						fields: `nextPageToken,incompleteSearch,files(${fields})`,
						supportsAllDrives: "true",
						includeItemsFromAllDrives: "true",
						...(cursor ? { pageToken: cursor } : {}),
					},
					opts,
				),
			),
		);
		if (page.incompleteSearch)
			throw new DriveFilesError(
				"Drive returned an incomplete search.",
				"request_failed",
			);
		items.push(...page.files.filter((f) => !f.trashed));
		if (matches === 2 && items.length >= 2) break;
		cursor = page.nextPageToken;
		if (
			cursor &&
			(seen.has(cursor) || seen.size >= 100 || items.length >= 10000)
		)
			throw new DriveFilesError(
				"Narrow this Drive search or select a smaller folder.",
				"too_large",
			);
		if (cursor) seen.add(cursor);
	} while (cursor);
	return items;
}
async function byId(token: string, itemId: string, opts: DriveOptions) {
	try {
		const r = meta.parse(
			await driveJson(
				await driveRequest(
					token,
					`drive/v3/files/${id.parse(itemId)}`,
					{ fields, supportsAllDrives: "true" },
					opts,
				),
			),
		);
		if (itemId !== "root" && r.id !== itemId)
			throw new DriveFilesError(
				"Drive returned a different item.",
				"request_failed",
			);
		return r.trashed ? null : r;
	} catch (e) {
		if (e instanceof DriveFilesError && e.code === "not_found") return null;
		throw e;
	}
}
export async function driveResolve(
	token: string,
	path: string,
	opts: DriveOptions = {},
): Promise<DriveItem | null> {
	const segments = drivePath(path).split("/").filter(Boolean);
	let parent = "root";
	let item: DriveItem | null = null;
	if (segments[0] === "@drive") {
		segments.shift();
		const start = id.parse(segments.shift());
		item = await byId(token, start, opts);
		if (!item) return null;
		parent = item.id;
	}
	if (!segments.length) return item ?? byId(token, parent, opts);
	for (const name of segments) {
		if (item && item.mimeType !== driveFolderMime) return null;
		const found = await find(
			token,
			`${literal(parent)} in parents and name = ${literal(name)}`,
			opts,
			2,
		);
		if (found.length > 1)
			throw new DriveFilesError(
				"More than one Drive item has this name. Use list or search and choose the returned /@drive/ identifier.",
				"invalid_path",
			);
		if (!found.length) return null;
		item = found[0];
		parent = item.id;
	}
	return item;
}
export function driveEntry(f: DriveItem) {
	const isDir = f.mimeType === driveFolderMime;
	const fallback =
		"https://drive.google.com/" +
		(isDir ? "drive/folders/" : "file/d/") +
		f.id +
		(isDir ? "" : "/view");
	return {
		name: f.name,
		path: `/@drive/${f.id}`,
		isDir,
		size: Number(f.size ?? 0),
		mtime: f.modifiedTime ?? null,
		contentType: f.mimeType,
		etag: f.version ?? null,
		webUrl: googleDriveDocumentUrl(f.webViewLink ?? "") ?? fallback,
	};
}
export async function driveList(
	token: string,
	path: string,
	opts: DriveOptions = {},
) {
	let parent = "root";
	if (drivePath(path) !== "/") {
		const folder = await driveResolve(token, path, opts);
		if (!folder || folder.mimeType !== driveFolderMime)
			throw new DriveFilesError(
				"Choose an existing Drive folder.",
				"invalid_path",
			);
		parent = folder.id;
	}
	return (await find(token, `${literal(parent)} in parents`, opts)).map(
		driveEntry,
	);
}
export async function driveSearch(
	token: string,
	query: string,
	opts: DriveOptions = {},
) {
	return (await find(token, `fullText contains ${literal(query)}`, opts)).map(
		driveEntry,
	);
}
export async function driveRead(
	token: string,
	path: string,
	opts: DriveOptions = {},
	known?: DriveItem,
) {
	const f = known ?? (await driveResolve(token, path, opts));
	if (!f) throw new DriveFilesError("Drive file not found.", "not_found");
	if (f.capabilities?.canDownload === false || f.mimeType === driveFolderMime)
		throw new DriveFilesError(
			"This item cannot be downloaded.",
			"not_supported",
		);
	const kind = f.mimeType.startsWith(googleMime)
		? f.mimeType.slice(googleMime.length)
		: null;
	const sheet = kind === "spreadsheet";
	const exportExt = sheet
		? "csv"
		: kind === "document" || kind === "presentation"
			? "txt"
			: null;
	if (kind && !exportExt)
		throw new DriveFilesError(
			"This Google Workspace file type has no supported text export.",
			"not_supported",
		);
	const contentType = exportExt
		? getCanonicalMimeForExtension(exportExt)
		: f.mimeType;
	if (!contentType)
		throw new DriveFilesError("Unsupported export format.", "not_supported");
	const max = 25 * 1024 * 1024;
	if (!kind && Number(f.size) > max)
		throw new DriveFilesError("File exceeds the read limit.", "too_large");
	const r = await driveRequest(
		token,
		`drive/v3/files/${f.id}${kind ? "/export" : ""}`,
		kind
			? { mimeType: contentType }
			: { alt: "media", supportsAllDrives: "true" },
		opts,
	);
	return {
		bytes: await bounded(r, max),
		name: f.name,
		contentType,
		mtime: f.modifiedTime ?? null,
		etag: f.version ?? null,
		webUrl: driveEntry(f).webUrl,
		...(sheet
			? { note: "This CSV export covers the first spreadsheet tab only." }
			: {}),
	};
}
