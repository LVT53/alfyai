import { createHash } from "node:crypto";
import { z } from "zod";
import { createOutboundFetch, type OutboundFetch } from "$lib/server/outbound";
import { microsoftCanWrite } from "$lib/shared/microsoft-permissions";
import { oneDriveDocumentUrl } from "$lib/shared/onedrive-links";
import { type ConnectionPublic, getConnection } from "../store";
import type { WriteExecutor } from "../write-executors";
import {
	buildWritePreview,
	resolveWriteTarget,
	WRITE_WARNING,
	type WriteOperation,
} from "../write-guard";
import { OneDriveError, onedriveGetAccessTokenForRead } from "./onedrive";
import { teamsChannelFilesFolder } from "./teams-graph";
import { teamsUploadSource } from "./teams-upload-source";

type ChannelRef = { teamId: string; channelId: string };
type Options = { fetch?: typeof fetch; download?: OutboundFetch };
const graphId = z.string().regex(/^[a-zA-Z0-9!_-]{1,512}$/);
const itemSchema = z.object({
	id: graphId,
	name: z.string().min(1),
	eTag: z.string().optional(),
	folder: z.object({}).optional(),
	file: z.object({ mimeType: z.string().optional() }).optional(),
	remoteItem: z.unknown().optional(),
	package: z.unknown().optional(),
	size: z.number().nonnegative().optional(),
	lastModifiedDateTime: z.string().optional(),
	webUrl: z.string(),
	parentReference: z.object({ driveId: graphId, id: graphId.optional() }),
});
type Item = z.infer<typeof itemSchema>;
const select =
	"id,name,eTag,file,folder,remoteItem,package,size,lastModifiedDateTime,webUrl,parentReference";
const limit = 25 * 1024 * 1024;
const downloadPublic = createOutboundFetch(
	{},
	{ timeoutMs: 15000, maxBytes: limit },
);
function invalid(message: string): never {
	throw new OneDriveError(message, "invalid_path");
}
function pathParts(path: string) {
	if (path === "") return [];
	if (
		!path.startsWith("/") ||
		path.length > 4096 ||
		/[\\:?*"<>|]/.test(path) ||
		/%(?:2e|2f|5c|25)/i.test(path)
	)
		invalid("Choose a path inside this Teams channel.");
	const parts = path.split("/").filter(Boolean);
	if (
		parts.length > 32 ||
		parts.some(
			(p) =>
				p === "." ||
				p === ".." ||
				Array.from(p).some((c) => c.charCodeAt(0) < 32),
		)
	)
		invalid("Invalid Teams channel path.");
	return parts;
}
const canonical = (p: string) => `/${pathParts(p).join("/")}`;
const parentPath = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const join = (p: string, name: string) =>
	p === "/" ? `/${name}` : `${p}/${name}`;
function maybeDownload(raw: string | null, host: string) {
	const url = raw ? URL.parse(raw) : null;
	if (
		url?.protocol !== "https:" ||
		url.hostname !== host ||
		url.port ||
		url.username ||
		url.password ||
		url.hash
	)
		invalid("This file has no supported SharePoint download address.");
	return url.href;
}
function check(r: Response) {
	if (!r.ok)
		throw new OneDriveError(
			"Microsoft could not complete this Teams file request.",
			r.status === 404
				? "not_found"
				: r.status === 401
					? "needs_reauth"
					: "request_failed",
		);
	return r;
}
async function boundedJson(r: Response) {
	const reader = r.body?.getReader();
	if (!reader)
		throw new OneDriveError("Missing Teams response.", "request_failed");
	const chunks: Uint8Array[] = [];
	let n = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			n += part.value.byteLength;
			if (n > 4_000_000) {
				await reader.cancel();
				throw new OneDriveError(
					"Channel folder response is too large.",
					"too_large",
				);
			}
			chunks.push(part.value);
		}
	} finally {
		reader.releaseLock();
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
export async function openChannelFiles(
	conn: ConnectionPublic,
	ref: ChannelRef,
	opts: Options = {},
) {
	const token = await onedriveGetAccessTokenForRead(conn, opts, "teams_files");
	const root = itemSchema.parse(
		await boundedJson(
			check(
				await teamsChannelFilesFolder(token, ref.teamId, ref.channelId, opts),
			),
		),
	);
	const rootUrl = URL.parse(oneDriveDocumentUrl(root.webUrl) ?? "");
	if (
		!rootUrl?.hostname.endsWith(".sharepoint.com") ||
		!root.folder ||
		root.remoteItem ||
		root.package
	)
		invalid("This channel has no supported SharePoint folder.");
	const host = rootUrl.hostname;
	const driveId = root.parentReference.driveId;
	const folderId = root.id;
	const identity = { ...ref, driveId, folderId };
	const base = `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(folderId)}`;
	function address(path: string, operation?: string) {
		const parts = pathParts(path);
		const route = parts.length
			? `${base}:/${parts.map(encodeURIComponent).join("/")}`
			: base;
		return operation
			? `${parts.length ? `${route}:` : route}/${operation}`
			: route;
	}
	function request(url: URL, init: RequestInit = {}) {
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Bearer ${token}`);
		return (opts.fetch ?? fetch)(url, {
			...init,
			headers,
			signal: AbortSignal.timeout(15000),
			redirect: init.redirect ?? "error",
		});
	}
	function checkedItem(raw: unknown, parent: Item): Item {
		const f = itemSchema.parse(raw);
		const webUrl = URL.parse(oneDriveDocumentUrl(f.webUrl) ?? "");
		if (
			f.remoteItem ||
			f.package ||
			f.id === folderId ||
			(!f.file && !f.folder) ||
			f.parentReference.id !== parent.id ||
			f.parentReference.driveId !== driveId ||
			!webUrl ||
			webUrl.hostname !== host ||
			f.name.includes("/") ||
			pathParts(`/${f.name}`).length !== 1
		)
			invalid(
				"This entry is outside the selected Teams folder or is a shortcut.",
			);
		return f;
	}
	async function locate(path: string): Promise<Item | null> {
		const parts = pathParts(path);
		let current = root;
		let prefix = "/";
		for (const name of parts) {
			if (!current.folder) return null;
			prefix = join(prefix, name);
			const url = new URL(address(prefix));
			url.searchParams.set("$select", select);
			const r = await request(url);
			if (r.status === 404) return null;
			const item = checkedItem(await boundedJson(check(r)), current);
			if (item.name.toLowerCase() !== name.toLowerCase())
				invalid("The requested Teams path has changed.");
			current = item;
		}
		return current;
	}
	const downloadUrl = (item: Item, path: string) =>
		item.file && item.eTag
			? "/api/connections/teams/files/download?" +
				new URLSearchParams({
					connectionId: conn.id,
					teamId: ref.teamId,
					channelId: ref.channelId,
					path,
					itemId: item.id,
					revision: item.eTag,
				}).toString()
			: undefined;
	const entry = (item: Item, path: string) => ({
		downloadUrl: downloadUrl(item, path),
		name: item.name,
		path,
		isDir: !!item.folder,
		size: item.size ?? 0,
		mtime: item.lastModifiedDateTime ?? null,
		contentType: item.file?.mimeType ?? null,
		etag: item.eTag ?? null,
		webUrl: item.webUrl,
	});
	async function children(folder: Item, path: string) {
		if (!folder.folder) invalid("Choose a Teams channel folder.");
		const start = new URL(address(path, "children"));
		start.searchParams.set("$select", select);
		start.searchParams.set("$top", "200");
		const result: Item[] = [];
		const seen = new Set<string>();
		let url: URL | null = start;
		while (url) {
			const page = z
				.object({
					value: z.array(z.unknown()),
					"@odata.nextLink": z.string().optional(),
				})
				.parse(await boundedJson(check(await request(url))));
			for (const row of page.value) {
				const item = itemSchema.parse(row);
				if (!item.remoteItem && !item.package)
					result.push(checkedItem(item, folder));
			}
			const next = page["@odata.nextLink"];
			if (!next) break;
			const u = URL.parse(next);
			const cursor = u?.searchParams.get("$skiptoken");
			const idPath = `/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(folder.id)}/children`;
			if (
				!u ||
				u.origin !== start.origin ||
				(u.pathname !== start.pathname && u.pathname !== idPath) ||
				!cursor ||
				cursor.length > 20000 ||
				u.hash ||
				u.username ||
				u.password ||
				seen.has(cursor) ||
				seen.size >= 50 ||
				result.length >= 10000
			)
				throw new OneDriveError(
					"Incomplete Teams folder listing.",
					"request_failed",
				);
			seen.add(cursor);
			url = new URL(start);
			url.searchParams.set("$skiptoken", cursor);
		}
		return result;
	}
	async function list(path: string) {
		path = canonical(path);
		const folder = await locate(path);
		if (!folder)
			throw new OneDriveError("Teams folder not found.", "not_found");
		return (await children(folder, path)).map((i) =>
			entry(i, join(path, i.name)),
		);
	}
	async function search(query: string) {
		const result: ReturnType<typeof entry>[] = [];
		const pending = [{ item: root, path: "/" }];
		const visited = new Set<string>();
		let count = 0;
		for (let n = 0; n < pending.length; n++) {
			const { item, path } = pending[n];
			if (n >= 100 || visited.has(item.id))
				throw new OneDriveError(
					"Narrow this Teams channel search to a folder listing.",
					"too_large",
				);
			visited.add(item.id);
			for (const f of await children(item, path)) {
				if (++count > 5000)
					throw new OneDriveError(
						"Channel search exceeds its size limit.",
						"too_large",
					);
				const child = join(path, f.name);
				if (f.name.toLowerCase().includes(query.toLowerCase()))
					result.push(entry(f, child));
				if (f.folder) pending.push({ item: f, path: child });
			}
		}
		return result;
	}
	async function read(path: string, pinned?: { id: string; revision: string }) {
		const file = await locate(path);
		if (!file?.file) invalid("Choose a file inside the Teams channel.");
		if (pinned && (file.id !== pinned.id || file.eTag !== pinned.revision))
			invalid("The channel file changed after this card was shown.");
		if ((file.size ?? 0) > limit)
			throw new OneDriveError("This Teams file is too large.", "too_large");
		const response = await request(new URL(address(path, "content")), {
			redirect: "manual",
			headers: file.eTag ? { "If-Match": file.eTag } : {},
		});
		if (response.status !== 302)
			throw new OneDriveError(
				"No verified download location from Teams.",
				"request_failed",
			);
		const bytes = await (opts.download ?? downloadPublic)(
			maybeDownload(response.headers.get("Location"), host),
			{ redirect: "manual" },
		);
		check(bytes);
		const buffer = new Uint8Array(await bytes.arrayBuffer());
		if (buffer.byteLength > limit)
			throw new OneDriveError("Teams file is too large.", "too_large");
		return {
			bytes: buffer,
			downloadUrl: downloadUrl(file, path),
			name: file.name,
			contentType: file.file.mimeType ?? null,
			etag: file.eTag ?? null,
			mtime: file.lastModifiedDateTime ?? null,
			webUrl: file.webUrl,
		};
	}
	// Only locally generated, root-relative endpoints are accepted. The caller cannot supply a Graph URL or item/drive ID.
	async function mutate(
		path: string,
		method: "POST" | "PUT" | "DELETE" | "PATCH",
		operation: "content" | "children" | "createLink" | undefined,
		body?: BodyInit,
		headers?: Record<string, string>,
		failOnConflict = false,
	) {
		const u = new URL(address(path, operation));
		if (failOnConflict)
			u.searchParams.set("@microsoft.graph.conflictBehavior", "fail");
		return request(u, { method, body, headers });
	}
	return {
		identity,
		host,
		rootName: root.name,
		list,
		search,
		read,
		locate,
		stat: async (path: string) => {
			const f = await locate(path);
			return f ? entry(f, canonical(path)) : null;
		},
		mutate,
	};
}
type OpenChannel = Awaited<ReturnType<typeof openChannelFiles>>;
type Input = {
	action: string;
	path?: string;
	destinationPath?: string;
	content?: string;
	sourceId?: string;
};
const ops: Record<string, string> = {
	save: "files.put",
	create_folder: "files.create_folder",
	move: "files.move",
	delete: "files.delete",
	share_link: "files.share_link",
};
export async function prepareTeamsFileWrite(
	conn: ConnectionPublic,
	channel: OpenChannel,
	input: Input,
	selectedIds: readonly string[] = [],
) {
	if (!microsoftCanWrite(conn, "teams_files"))
		invalid("Channel file changes are disabled.");
	if (!Object.hasOwn(ops, input.action))
		invalid("Unsupported Teams write operation.");
	if (
		input.sourceId &&
		(input.action !== "save" || input.content !== undefined)
	)
		invalid(
			"To upload an attached file, choose save and provide only its sourceId and destination.",
		);
	const upload = input.sourceId
		? await teamsUploadSource(conn.userId, input.sourceId, selectedIds)
		: null;
	const path = canonical(input.path ?? "");
	const move = input.action === "move",
		saving = input.action === "save",
		mkdir = input.action === "create_folder";
	const destination = move ? canonical(input.destinationPath ?? "") : path;
	if (
		path === "/" ||
		destination === "/" ||
		(move && (path === destination || destination.startsWith(`${path}/`)))
	)
		invalid(
			"Choose a file or folder below the channel root and a different destination.",
		);
	const source = await channel.locate(path);
	if (mkdir && source) invalid("The destination already exists.");
	if (!source && !mkdir && !saving)
		throw new OneDriveError("Channel item not found.", "not_found");
	if (source && !source.eTag) invalid("The item revision is unavailable.");
	if (
		saving &&
		(source?.folder ||
			(!upload &&
				(!input.content || Buffer.byteLength(input.content) > 4_500_000)))
	)
		invalid("Provide text for an ordinary file within the upload limit.");
	let parentId: string | undefined;
	if (!source || move) {
		if (move && (await channel.locate(destination)))
			invalid("The destination already exists.");
		const parent = await channel.locate(parentPath(destination));
		if (!parent?.folder) invalid("Choose an existing channel folder.");
		parentId = parent.id;
	}
	const safe = (p: string) =>
		resolveWriteTarget({ allowlist: conn.writeAllowlist, requestedPath: p })
			.withinAllowlist;
	const content = move
		? JSON.stringify({ fromPath: path, toPath: destination })
		: (input.content ?? "");
	const op: WriteOperation = {
		provider: "onedrive",
		connectionId: conn.id,
		action: ops[input.action],
		summary: `${input.action.replaceAll("_", " ")} ${destination} in ${channel.rootName}`,
		target: {
			path: destination,
			id: source?.id,
			etag: source?.eTag,
			parentId,
			isFolder: !!source?.folder,
			teamsChannel: channel.identity,
			...(upload ? { uploadSource: upload.source } : {}),
			label: channel.rootName,
			withinAllowlist: safe(path) && safe(destination),
		},
		reversible: !(saving && source),
		destructive: input.action === "delete" || Boolean(saving && source),
		payloadFingerprint: createHash("sha256")
			.update(
				JSON.stringify([
					channel.identity,
					content,
					upload?.source,
					parentId,
					source?.eTag,
				]),
			)
			.digest("hex"),
	};
	const preview = buildWritePreview(op);
	if (input.action === "share_link")
		preview.warnings.unshift(WRITE_WARNING.organizationTeamsLink);
	return { op, content, preview };
}
export const executeTeamsChannelFileWrite: WriteExecutor["execute"] = async (
	userId,
	connectionId,
	op,
	content,
	opts = {},
) => {
	const conn = await getConnection(userId, connectionId);
	if (
		conn?.provider !== "onedrive" ||
		conn.status !== "connected" ||
		op.connectionId !== connectionId ||
		op.provider !== "onedrive" ||
		!microsoftCanWrite(conn, "teams_files")
	)
		return { ok: false, reason: "writes_disabled" };
	const target = op.target;
	if (
		!target?.teamsChannel ||
		!target.path ||
		!Object.values(ops).includes(op.action)
	)
		return { ok: false, reason: "invalid_target" };
	try {
		const path = canonical(target.path);
		const move = op.action === "files.move";
		const sourcePath = move
			? canonical(
					z
						.object({ fromPath: z.string(), toPath: z.literal(path) })
						.parse(JSON.parse(content)).fromPath,
				)
			: path;
		if (path === "/" || sourcePath === "/")
			return { ok: false, reason: "invalid_target" };
		const channel = await openChannelFiles(conn, target.teamsChannel, opts);
		const recorded = target.teamsChannel;
		if (
			channel.identity.folderId !== recorded.folderId ||
			channel.identity.driveId !== recorded.driveId
		)
			return { ok: false, reason: "destination_changed" };
		const file = await channel.locate(sourcePath);
		if (
			file?.id !== target.id ||
			file?.eTag !== target.etag ||
			(file && !file.eTag)
		)
			return { ok: false, reason: "item_changed" };
		if (!file || move) {
			if (move && (await channel.locate(path)))
				return { ok: false, reason: "destination_exists" };
			const parent = await channel.locate(parentPath(path));
			if (!parent?.folder || parent.id !== target.parentId)
				return { ok: false, reason: "destination_changed" };
		}
		const condition: Record<string, string> = file?.eTag
			? { "If-Match": file.eTag }
			: { "If-None-Match": "*" };
		const json = { "Content-Type": "application/json", ...condition };
		let r: Response;
		if (
			op.action === "files.put" &&
			Boolean(file) === op.destructive &&
			!file?.folder
		) {
			const pinned = target.uploadSource;
			const upload = pinned
				? await teamsUploadSource(userId, pinned.id, [pinned.id])
				: null;
			if (
				pinned &&
				(!upload ||
					upload.source.id !== pinned.id ||
					upload.source.sha256 !== pinned.sha256 ||
					upload.source.name !== pinned.name ||
					upload.source.size !== pinned.size ||
					upload.source.contentType !== pinned.contentType)
			)
				return { ok: false, reason: "item_changed" };
			r = await channel.mutate(
				path,
				"PUT",
				"content",
				upload ? Uint8Array.from(upload.bytes).buffer : content,
				{
					...condition,
					"Content-Type":
						upload?.source.contentType ?? "text/plain; charset=utf-8",
				},
				!file,
			);
		} else if (op.action === "files.create_folder" && !file) {
			r = await channel.mutate(
				parentPath(path),
				"POST",
				"children",
				JSON.stringify({
					name: nameOf(path),
					folder: {},
					"@microsoft.graph.conflictBehavior": "fail",
				}),
				{ "Content-Type": "application/json" },
			);
		} else if (op.action === "files.move" && file) {
			r = await channel.mutate(
				sourcePath,
				"PATCH",
				undefined,
				JSON.stringify({
					name: nameOf(path),
					parentReference: { id: target.parentId },
				}),
				json,
				true,
			);
		} else if (op.action === "files.delete" && file) {
			r = await channel.mutate(path, "DELETE", undefined, undefined, condition);
		} else if (op.action === "files.share_link" && file) {
			r = await channel.mutate(
				path,
				"POST",
				"createLink",
				JSON.stringify({ type: "view", scope: "organization" }),
				json,
			);
			if (r.ok) {
				const link = z
					.object({
						link: z.object({
							scope: z.literal("organization"),
							type: z.literal("view"),
							webUrl: z.string(),
						}),
					})
					.parse(await boundedJson(r)).link;
				const url = URL.parse(oneDriveDocumentUrl(link.webUrl) ?? "");
				if (!url || url.hostname !== channel.host)
					return { ok: false, reason: "invalid_share_link" };
				return { ok: true, resultUrl: url.href };
			}
		} else return { ok: false, reason: "unsupported_operation" };
		if (!r.ok)
			return {
				ok: false,
				reason:
					r.status === 412
						? "item_changed"
						: r.status === 409
							? "destination_exists"
							: "request_failed",
			};
		return { ok: true, etag: r.headers.get("etag") };
	} catch {
		return { ok: false, reason: "request_failed" };
	}
};
