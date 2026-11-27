import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { getConnection } from "../store";
import type { WriteExecutor } from "../write-executors";
import {
	buildWritePreview,
	resolveWriteTarget,
	WRITE_WARNING,
	type WriteOperation,
} from "../write-guard";
import {
	googleDriveCanModify,
	googleDriveGetAccessToken,
} from "./google-drive-auth";
import {
	DriveFilesError,
	type DriveItem,
	type DriveOptions,
	driveEntry,
	driveFolderMime,
	driveJson,
	drivePath,
	driveRequest,
	driveResolve,
} from "./google-drive-files";

type Input = {
	action: string;
	path?: string;
	destinationPath?: string;
	content?: string;
};
const actions: Record<string, string> = {
	save: "files.put",
	delete: "files.delete",
	move: "files.move",
	create_folder: "files.create_folder",
	share_link: "files.share_link",
};
const verbs: Record<string, string> = {
	save: "Save",
	delete: "Move to trash",
	move: "Move",
	create_folder: "Create folder",
	share_link: "Create public viewer link for",
};
function invalid(s: string): never {
	throw new DriveFilesError(s, "invalid_path");
}
const enclosing = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const handle = (p: string) => p.startsWith("/@drive/");
function writablePath(raw?: string) {
	const p = drivePath(raw ?? "");
	if (p === "/") invalid("Choose an item below the Drive root.");
	return p;
}
function mayChange(action: string, file: DriveItem) {
	if (!file.parents.length && file.mimeType === driveFolderMime)
		invalid("This Drive root cannot be changed.");
	if (
		action === "save" &&
		(file.mimeType.startsWith("application/vnd.google-apps.") ||
			file.capabilities?.canEdit === false)
	)
		invalid(
			"Choose an editable ordinary file. Workspace documents cannot be replaced.",
		);
	if (action === "delete" && file.capabilities?.canTrash === false)
		invalid("Drive does not permit moving this item to trash.");
	if (action === "share_link" && file.capabilities?.canShare === false)
		invalid("Drive does not permit sharing this item.");
}
const revision = z.object({
	id: z.string(),
	version: z.string(),
	etag: z.string().regex(/^"[^"\r\n]+"$/),
});
async function guardVersion(
	token: string,
	item: DriveItem,
	opts: DriveOptions,
) {
	// v2 exposes the item's actual HTTP entity tag. A numeric Drive version alone
	// is unsuitable as an If-Match header for replacing bytes or metadata.
	const r = revision.parse(
		await driveJson(
			await driveRequest(
				token,
				`drive/v2/files/${item.id}`,
				{ fields: "id,etag,version", supportsAllDrives: "true" },
				opts,
			),
		),
	);
	if (r.id !== item.id || r.version !== item.version)
		throw new DriveFilesError("The item changed.", "item_changed");
	return r.etag;
}
export async function prepareDriveFileWrite(
	connectionId: string,
	allowlist: string[],
	token: string,
	input: Input,
	opts: DriveOptions = {},
) {
	if (!Object.hasOwn(actions, input.action))
		invalid("Unsupported Drive operation.");
	const path = writablePath(input.path);
	const moving = input.action === "move";
	const destination = moving ? writablePath(input.destinationPath) : path;
	const source = await driveResolve(token, path, opts);
	const create =
		input.action === "create_folder" || (input.action === "save" && !source);
	if (source && input.action === "create_folder")
		invalid("An item already exists at this location.");
	if (!source && !create)
		throw new DriveFilesError("Drive item not found.", "not_found");
	if (source) {
		mayChange(input.action, source);
		if (!source.version) invalid("Drive did not report the current version.");
	}
	if (
		input.action === "save" &&
		(!input.content || Buffer.byteLength(input.content) > 4_500_000)
	)
		invalid("Provide text within Drive's inline upload limit.");
	let parentId: string | undefined;
	let generatedId: string | undefined;
	if (create || moving) {
		if (/^\/@drive\/[^/]+$/.test(destination))
			invalid("Choose a destination folder and a new file name.");
		if (moving && (await driveResolve(token, destination, opts)))
			invalid("The Drive destination already exists.");
		const parent = await driveResolve(token, enclosing(destination), opts);
		if (
			!parent ||
			parent.mimeType !== driveFolderMime ||
			parent.capabilities?.canAddChildren === false
		)
			invalid("Choose an existing writable folder.");
		parentId = parent.id;
		if (create) {
			const response = z
				.object({ ids: z.array(z.string().regex(/^[\w-]+$/)).length(1) })
				.parse(
					await driveJson(
						await driveRequest(
							token,
							"drive/v3/files/generateIds",
							{ count: "1", space: "drive" },
							opts,
						),
					),
				);
			generatedId = response.ids[0];
		}
	}
	const text = input.content ?? "";
	const content = moving
		? JSON.stringify({
				fromPath: path,
				toPath: destination,
				fromName: source?.name,
				toName: basename(destination),
				fromFolder: handle(path)
					? source?.parents[0]
						? `/@drive/${source.parents[0]}`
						: undefined
					: enclosing(path),
				toFolder: enclosing(destination),
				isMove: source?.parents[0] !== parentId,
			})
		: text;
	const safe = (p: string) =>
		!handle(p) &&
		!p.includes("%") &&
		resolveWriteTarget({ allowlist, requestedPath: p }).withinAllowlist;
	const label =
		moving || create
			? basename(destination)
			: (source?.name ?? basename(destination));
	const op: WriteOperation = {
		provider: "google",
		connectionId,
		action: actions[input.action],
		summary: moving
			? `Move ${source?.name} to ${destination}`
			: `${verbs[input.action]} ${label}`,
		target: {
			path: destination,
			id: source?.id,
			etag: source?.version,
			parentId,
			generatedId,
			isFolder: source?.mimeType === driveFolderMime,
			label,
			withinAllowlist: safe(path) && safe(destination),
		},
		reversible:
			input.action !== "share_link" && !(source && input.action === "save"),
		destructive:
			input.action === "delete" || Boolean(source && input.action === "save"),
		payloadFingerprint: createHash("sha256")
			.update(JSON.stringify([content, parentId, source?.version]))
			.digest("hex"),
	};
	const preview = buildWritePreview(op);
	if (input.action === "share_link")
		preview.warnings.unshift(WRITE_WARNING.publicFileLink);
	return { op, content, preview };
}
const jsonHeaders = { "Content-Type": "application/json" };
export const executeGoogleDriveWrite: WriteExecutor["execute"] = async (
	userId,
	connectionId,
	op,
	content,
	opts = {},
) => {
	const conn = await getConnection(userId, connectionId);
	if (
		conn?.provider !== "google" ||
		conn.status !== "connected" ||
		op.provider !== "google" ||
		op.connectionId !== connectionId ||
		!googleDriveCanModify(conn)
	)
		return { ok: false, reason: "writes_disabled" };
	try {
		const target = op.target;
		if (!target?.path) return { ok: false, reason: "invalid_path" };
		const path = writablePath(target.path);
		const token = await googleDriveGetAccessToken(conn, opts, "modify");
		const move = op.action === "files.move";
		const original = move
			? z
					.object({ fromPath: z.string(), toPath: z.literal(path) })
					.parse(JSON.parse(content)).fromPath
			: path;
		const source = await driveResolve(token, original, opts);
		if (source?.id !== target.id || source?.version !== target.etag)
			return { ok: false, reason: "item_changed" };
		const saving = op.action === "files.put";
		const folder = op.action === "files.create_folder";
		const act = Object.keys(actions).find((a) => actions[a] === op.action);
		if (!act) return { ok: false, reason: "unsupported_operation" };
		if (source) {
			mayChange(act, source);
		}
		if (move || !source) {
			if (move && (await driveResolve(token, path, opts)))
				return { ok: false, reason: "destination_exists" };
			const parent = await driveResolve(token, enclosing(path), opts);
			if (
				!parent ||
				parent.mimeType !== driveFolderMime ||
				parent.id !== target.parentId ||
				parent.capabilities?.canAddChildren === false
			)
				return { ok: false, reason: "destination_changed" };
		}
		if (!source) {
			if (
				(!saving && !folder) ||
				!target.generatedId ||
				!/^[\w-]+$/.test(target.generatedId) ||
				op.destructive
			)
				return { ok: false, reason: "item_changed" };
			const info = {
				id: target.generatedId,
				name: basename(path),
				parents: [target.parentId],
				mimeType: folder ? driveFolderMime : "text/plain",
			};
			const boundary = `alfyai_${randomUUID()}`;
			const body = folder
				? JSON.stringify(info)
				: [
						`--${boundary}`,
						"Content-Type: application/json; charset=UTF-8",
						"",
						JSON.stringify(info),
						`--${boundary}`,
						"Content-Type: text/plain; charset=UTF-8",
						"",
						content,
						`--${boundary}--`,
						"",
					].join("\r\n");
			await driveRequest(
				token,
				`${folder ? "" : "upload/"}drive/v3/files`,
				{
					supportsAllDrives: "true",
					fields: "id",
					...(folder ? {} : { uploadType: "multipart" }),
				},
				opts,
				{
					method: "POST",
					headers: folder
						? jsonHeaders
						: { "Content-Type": `multipart/related; boundary=${boundary}` },
					body,
				},
			);
		} else if (op.action === "files.share_link") {
			const permissions = z.object({
				permissions: z.array(
					z.object({
						type: z.string(),
						role: z.string(),
						allowFileDiscovery: z.boolean().optional(),
					}),
				),
				nextPageToken: z.string().optional(),
			});
			const acl = permissions.parse(
				await driveJson(
					await driveRequest(
						token,
						`drive/v3/files/${source.id}/permissions`,
						{
							fields: "nextPageToken,permissions(type,role,allowFileDiscovery)",
							pageSize: "100",
							supportsAllDrives: "true",
						},
						opts,
					),
				),
			);
			if (acl.nextPageToken) return { ok: false, reason: "request_failed" };
			const existing = acl.permissions.filter((p) => p.type === "anyone");
			if (existing.some((p) => p.role !== "reader" || p.allowFileDiscovery))
				return { ok: false, reason: "sharing_scope_conflict" };
			if (!existing.length) {
				const grant = {
					type: "anyone",
					role: "reader",
					allowFileDiscovery: false,
				};
				const r = z.object({
					type: z.literal("anyone"),
					role: z.literal("reader"),
					allowFileDiscovery: z.literal(false).optional(),
				});
				r.parse(
					await driveJson(
						await driveRequest(
							token,
							`drive/v3/files/${source.id}/permissions`,
							{
								supportsAllDrives: "true",
								fields: "id,type,role,allowFileDiscovery",
							},
							opts,
							{
								method: "POST",
								headers: jsonHeaders,
								body: JSON.stringify(grant),
							},
						),
					),
				);
			}
			return { ok: true, resultUrl: driveEntry(source).webUrl };
		} else {
			const etag = await guardVersion(token, source, opts);
			const headers = { "If-Match": etag, ...jsonHeaders };
			const params = { fields: "id", supportsAllDrives: "true" };
			if (saving && op.destructive) {
				await driveRequest(
					token,
					`upload/drive/v2/files/${source.id}`,
					{ ...params, uploadType: "media" },
					opts,
					{
						method: "PUT",
						headers: { "If-Match": etag, "Content-Type": source.mimeType },
						body: content,
					},
				);
			} else if (move) {
				const currentParent = source.parents[0];
				if (source.parents.length !== 1 || !target.parentId)
					return { ok: false, reason: "destination_changed" };
				const relocate: Record<string, string> =
					currentParent === target.parentId
						? {}
						: { addParents: target.parentId, removeParents: currentParent };
				await driveRequest(
					token,
					`drive/v2/files/${source.id}`,
					{ ...params, ...relocate },
					opts,
					{
						method: "PATCH",
						headers,
						body: JSON.stringify({ title: basename(path) }),
					},
				);
			} else if (op.action === "files.delete") {
				await driveRequest(token, `drive/v2/files/${source.id}`, params, opts, {
					method: "PATCH",
					headers,
					body: JSON.stringify({ labels: { trashed: true } }),
				});
			} else return { ok: false, reason: "unsupported_operation" };
		}
		return { ok: true };
	} catch (e) {
		return {
			ok: false,
			reason: e instanceof DriveFilesError ? e.code : "request_failed",
		};
	}
};
