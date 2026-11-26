import { createHash } from "node:crypto";
import { microsoftCanWrite } from "$lib/shared/microsoft-permissions";
import { oneDriveDocumentUrl } from "$lib/shared/onedrive-links";
import { getConnection } from "../store";
import type { WriteExecutor } from "../write-executors";
import {
	buildWritePreview,
	normalizeAllowlistPath,
	resolveWriteTarget,
	WRITE_WARNING,
	type WriteOperation,
} from "../write-guard";
import { microsoftGraphRequest } from "./microsoft-graph";
import { OneDriveError, onedriveGetAccessTokenForRead } from "./onedrive";

type FetchOptions = { fetch?: typeof fetch };
type WriteInput = {
	action: string;
	path?: string;
	destinationPath?: string;
	content?: string;
};

function invalid(message: string): never {
	throw new OneDriveError(message, "invalid_path");
}

function checkedPath(raw: string | undefined): string {
	if (
		!raw ||
		raw.includes("\\") ||
		raw.split("/").some((part) => part === ".." || part === ".")
	)
		invalid("Choose a file or folder inside OneDrive.");
	let path: string;
	try {
		path = normalizeAllowlistPath(raw);
	} catch {
		return invalid("Invalid OneDrive path.");
	}
	if (
		path === "/" ||
		/[\\:*?"<>|]/.test(path) ||
		[...path].some((character) => character.charCodeAt(0) < 32)
	)
		invalid("Choose a valid OneDrive file or folder name.");
	return path;
}

function graphPath(path: string): string {
	return path === "/"
		? "/me/drive/root"
		: `/me/drive/root:${path.split("/").map(encodeURIComponent).join("/")}`;
}

function parentPath(path: string): string {
	return path.slice(0, path.lastIndexOf("/")) || "/";
}

function graphId(id: string | undefined): string {
	if (!id || id === "." || id === ".." || /[/\\]/.test(id))
		invalid("Invalid OneDrive item identifier.");
	return `/me/drive/items/${encodeURIComponent(id)}`;
}

async function metadata(token: string, path: string, opts: FetchOptions) {
	const response = await microsoftGraphRequest(
		token,
		"GET",
		`${graphPath(path)}?$select=id,eTag,file,folder,remoteItem`,
		opts,
	);
	if (response.status === 404) return null;
	if (!response.ok)
		throw new OneDriveError(
			"Could not check the OneDrive item",
			response.status === 401 ? "needs_reauth" : "request_failed",
		);
	const item = (await response.json()) as {
		id?: string;
		eTag?: string;
		file?: object;
		folder?: object;
		remoteItem?: object;
	};
	if (!item.id || item.remoteItem || (!item.file && !item.folder))
		invalid("Choose a file or folder in this OneDrive.");
	graphId(item.id);
	return { id: item.id, etag: item.eTag, isDir: !!item.folder };
}

const VERBS: Record<string, string> = {
	save: "Save",
	delete: "Move to trash",
	create_folder: "Create folder",
	share_link: "Create public link for",
};

const OPERATIONS: Record<string, string> = {
	save: "files.put",
	move: "files.move",
	delete: "files.delete",
	create_folder: "files.create_folder",
	share_link: "files.share_link",
};

export async function prepareOneDriveFileWrite(
	connectionId: string,
	allowlist: string[],
	token: string,
	input: WriteInput,
	opts: FetchOptions = {},
) {
	const action = OPERATIONS[input.action];
	if (!Object.hasOwn(OPERATIONS, input.action))
		invalid("Unsupported OneDrive operation.");
	const path = checkedPath(input.path);
	const destination =
		input.action === "move" ? checkedPath(input.destinationPath) : path;
	if (input.action === "save" && !input.content)
		invalid("Provide text to save.");
	if (input.action === "move" && destination === path)
		invalid("Choose a different OneDrive destination.");
	const source = await metadata(token, path, opts);
	const create = input.action === "create_folder";
	const saving = input.action === "save";
	if (create && source) invalid("An item already exists at this location.");
	if (!create && !saving && !source)
		throw new OneDriveError("The OneDrive item was not found.", "not_found");
	if (saving && source?.isDir)
		invalid("Choose a file rather than a folder to save.");
	if (source && !source.etag)
		throw new OneDriveError(
			"OneDrive did not provide the item revision.",
			"request_failed",
		);
	let parentId: string | undefined;
	if ((saving && !source) || create || input.action === "move") {
		if (input.action === "move" && (await metadata(token, destination, opts)))
			invalid("The OneDrive destination already exists.");
		const parent = await metadata(token, parentPath(destination), opts);
		if (!parent?.isDir) invalid("Choose an existing destination folder.");
		parentId = parent.id;
	}
	const target = resolveWriteTarget({
		allowlist,
		requestedPath: input.action === "move" ? input.destinationPath : input.path,
	});
	const sourceAllowed = resolveWriteTarget({
		allowlist,
		requestedPath: input.path,
	}).withinAllowlist;
	const content = saving
		? (input.content ?? "")
		: input.action === "move"
			? JSON.stringify({ fromPath: path, toPath: destination })
			: "";
	const op: WriteOperation = {
		provider: "onedrive",
		connectionId,
		action,
		summary:
			input.action === "move"
				? `Move ${path} to ${destination}`
				: `${VERBS[input.action]} ${path}`,
		target: {
			path: destination,
			id: source?.id,
			etag: source?.etag,
			parentId,
			isFolder: source?.isDir,
			withinAllowlist: target.withinAllowlist && sourceAllowed,
		},
		reversible: !saving || !source,
		destructive: input.action === "delete" || (saving && !!source),
		payloadFingerprint: createHash("sha256")
			.update(JSON.stringify([content, parentId, source?.etag]))
			.digest("hex"),
	};
	const preview = buildWritePreview(op);
	if (input.action === "share_link")
		preview.warnings.unshift(WRITE_WARNING.publicOneDriveLink);
	if (saving && source)
		preview.warnings.push(WRITE_WARNING.oneDriveVersionHistoryUnknown);
	return { op, content, preview };
}

export const executeOneDriveFileWrite: WriteExecutor["execute"] = async (
	userId,
	connectionId,
	op,
	content,
	opts = {},
) => {
	const conn = await getConnection(userId, connectionId);
	if (
		conn?.provider !== "onedrive" ||
		op.provider !== "onedrive" ||
		op.connectionId !== connectionId ||
		!microsoftCanWrite(conn, "files")
	)
		return { ok: false, reason: "writes_disabled" };
	const target = op.target;
	if (!target?.path || !Object.values(OPERATIONS).includes(op.action))
		return { ok: false, reason: "unsupported_operation" };
	const path = target.path;
	// Saved paths are already normalized. Never decode them a second time.
	if (
		!path.startsWith("/") ||
		path === "/" ||
		path.split("/").some((segment) => segment === "." || segment === "..") ||
		path.includes("\\")
	)
		return { ok: false, reason: "invalid_path" };
	const token = await onedriveGetAccessTokenForRead(conn, opts, "files");
	const move = op.action === "files.move";
	const sourcePath = move ? JSON.parse(content).fromPath : path;
	if (typeof sourcePath !== "string")
		return { ok: false, reason: "invalid_path" };
	const source = await metadata(token, sourcePath, opts);
	if (source?.id !== target.id || source?.etag !== target.etag)
		return { ok: false, reason: "item_changed" };
	const name = path.slice(path.lastIndexOf("/") + 1);
	const headers: Record<string, string> = {};
	if (source?.etag) headers["If-Match"] = source.etag;
	const item = source ? graphId(source.id) : null;
	const createFolder = op.action === "files.create_folder";
	if (!item || createFolder || move) {
		const parent = await metadata(token, parentPath(path), opts);
		if (!parent?.isDir || !target.parentId || parent.id !== target.parentId)
			return { ok: false, reason: "destination_changed" };
	}
	let response: Response;
	if (op.action === "files.put") {
		if (!!source !== op.destructive || source?.isDir)
			return { ok: false, reason: "item_changed" };
		const endpoint = item
			? `${item}/content`
			: graphId(target.parentId) +
				":/" +
				encodeURIComponent(name) +
				":/content?@microsoft.graph.conflictBehavior=fail";
		if (!item) headers["If-None-Match"] = "*";
		response = await microsoftGraphRequest(token, "PUT", endpoint, {
			...opts,
			headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
			body: content,
		});
	} else if (createFolder && !source) {
		response = await microsoftGraphRequest(
			token,
			"POST",
			`${graphId(target.parentId)}/children`,
			{
				...opts,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name,
					folder: {},
					"@microsoft.graph.conflictBehavior": "fail",
				}),
			},
		);
	} else if (move && item) {
		if (await metadata(token, path, opts))
			return { ok: false, reason: "destination_exists" };
		response = await microsoftGraphRequest(
			token,
			"PATCH",
			`${item}?@microsoft.graph.conflictBehavior=fail`,
			{
				...opts,
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify({
					name,
					parentReference: { id: target.parentId },
				}),
			},
		);
	} else if (op.action === "files.delete" && item) {
		response = await microsoftGraphRequest(token, "DELETE", item, {
			...opts,
			headers,
		});
	} else if (op.action === "files.share_link" && item) {
		response = await microsoftGraphRequest(
			token,
			"POST",
			`${item}/createLink`,
			{
				...opts,
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify({ type: "view", scope: "anonymous" }),
			},
		);
		if (response.ok) {
			const link = (await response.json()).link;
			if (typeof link?.webUrl !== "string")
				return { ok: false, reason: "missing_share_link" };
			const url = oneDriveDocumentUrl(link.webUrl);
			if (!url) return { ok: false, reason: "invalid_share_link" };
			return { ok: true, resultUrl: url };
		}
	} else return { ok: false, reason: "unsupported_operation" };
	if (!response.ok)
		return {
			ok: false,
			reason:
				response.status === 409
					? "destination_exists"
					: response.status === 412
						? "item_changed"
						: "request_failed",
		};
	return { ok: true, etag: response.headers.get("etag") };
};
