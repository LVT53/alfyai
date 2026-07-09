// Immich WRITE executor (Issue 6.4) — the ONLY code path that ever mutates
// anything on an Immich server for the Photos connector. Registered via
// registerWriteExecutor (Issue 6.0) so confirmPendingWrite (pending-writes.ts)
// dispatches "immich" pending writes here, and only after the user has
// explicitly confirmed — the photos chat tool (normal-chat-tools/photos.ts)
// never imports this module; it only ever proposes a PENDING write via
// createPendingWrite. Nothing here executes at propose time.
//
// NON-DESTRUCTIVE BY CONSTRUCTION — this module implements exactly one
// action, "immich.add_to_album", and that action can only ever:
//   1. GET /api/albums to find an existing album named exactly "AlfyAI", or
//      POST /api/albums to create one if none exists, and
//   2. PUT /api/albums/{id}/assets to add already-known asset ids to it.
// There is no delete/remove/force code path anywhere in this file — not a
// missing case in a switch, but never written at all. Album membership is
// trivially reversible (removing an asset from an album never touches the
// asset itself), and adding an asset that's already in the album is treated
// as success (Immich reports per-asset `{success:false, error:"duplicate"}`
// for ids already present — that is idempotent success here, not a failure).
//
// Requires the SEPARATE write-scoped API key (getConnectionWriteSecret,
// Issue 6.4's enable-writes flow) — the read-only key from 5.5's connect
// flow is never used for this call. Every network call accepts an
// injectable `fetch` so this module is fully testable against mocked Immich
// endpoints — nothing here ever talks to a live Immich server in tests.
import {
	getConnection,
	getConnectionWriteSecret,
	updateConnection,
} from "../store";
import {
	registerWriteExecutor,
	type WriteExecutionResult,
} from "../write-executors";
import type { WriteOperation } from "../write-guard";
import type { ImmichConnectionConfig } from "./immich";
import { ImmichError } from "./immich";

export type ImmichWriteOpt = { fetch?: typeof fetch };

const ALBUM_NAME = "AlfyAI";

type AddToAlbumContent = { assetIds: string[]; albumName: string };

function parseAddToAlbumContent(content: string): AddToAlbumContent | null {
	try {
		const parsed = JSON.parse(content) as Partial<AddToAlbumContent>;
		if (
			!Array.isArray(parsed.assetIds) ||
			parsed.assetIds.length === 0 ||
			!parsed.assetIds.every((id): id is string => typeof id === "string") ||
			typeof parsed.albumName !== "string" ||
			!parsed.albumName
		) {
			return null;
		}
		return { assetIds: parsed.assetIds, albumName: parsed.albumName };
	} catch {
		return null;
	}
}

function immichWriteConfig(conn: {
	config: Record<string, unknown>;
}): ImmichConnectionConfig | null {
	const origin =
		typeof conn.config.origin === "string" ? conn.config.origin : "";
	if (!origin) return null;
	const immichUserId =
		typeof conn.config.immichUserId === "string"
			? conn.config.immichUserId
			: "";
	return { origin, immichUserId };
}

type ImmichAlbumSummary = { id: string; albumName: string };

function isValidAlbumListResponse(
	value: unknown,
): value is ImmichAlbumSummary[] {
	return (
		Array.isArray(value) &&
		value.every(
			(entry) =>
				entry &&
				typeof entry === "object" &&
				typeof (entry as Record<string, unknown>).id === "string" &&
				typeof (entry as Record<string, unknown>).albumName === "string",
		)
	);
}

function isValidCreatedAlbumResponse(value: unknown): value is { id: string } {
	return (
		!!value &&
		typeof value === "object" &&
		typeof (value as Record<string, unknown>).id === "string"
	);
}

// GET /api/albums, then find-or-create — the ONLY two Immich endpoints this
// function ever calls. Never calls anything under /api/albums/{id} except
// the PUT-assets call in executeAddToAlbum below; in particular it never
// issues DELETE /api/albums/{id} or any variant that would remove an album.
async function findOrCreateAlbum(
	fetchImpl: typeof fetch,
	origin: string,
	apiKey: string,
	albumName: string,
): Promise<
	{ ok: true; albumId: string } | { ok: false; reason: "request_failed" }
> {
	let listResponse: Response;
	try {
		listResponse = await fetchImpl(`${origin}/api/albums`, {
			method: "GET",
			headers: { "x-api-key": apiKey },
		});
	} catch {
		return { ok: false, reason: "request_failed" };
	}
	if (!listResponse.ok) {
		return { ok: false, reason: "request_failed" };
	}
	const listBody: unknown = await listResponse.json().catch(() => null);
	if (!isValidAlbumListResponse(listBody)) {
		return { ok: false, reason: "request_failed" };
	}
	const existing = listBody.find((album) => album.albumName === albumName);
	if (existing) {
		return { ok: true, albumId: existing.id };
	}

	let createResponse: Response;
	try {
		createResponse = await fetchImpl(`${origin}/api/albums`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": apiKey,
			},
			body: JSON.stringify({ albumName }),
		});
	} catch {
		return { ok: false, reason: "request_failed" };
	}
	if (!createResponse.ok) {
		return { ok: false, reason: "request_failed" };
	}
	const createBody: unknown = await createResponse.json().catch(() => null);
	if (!isValidCreatedAlbumResponse(createBody)) {
		return { ok: false, reason: "request_failed" };
	}
	return { ok: true, albumId: createBody.id };
}

// PUT /api/albums/{id}/assets — the ONLY mutating call this module ever
// makes against an existing album. `force` is never sent (Immich's add-
// assets endpoint has no such parameter to begin with; this comment exists
// so a future edit can't casually add one). A per-asset
// `{success:false, error:"duplicate"}` entry means the asset was already in
// the album — that is idempotent success, not a failure to surface.
async function addAssetsToAlbum(
	fetchImpl: typeof fetch,
	origin: string,
	apiKey: string,
	albumId: string,
	assetIds: string[],
): Promise<WriteExecutionResult> {
	let response: Response;
	try {
		response = await fetchImpl(`${origin}/api/albums/${albumId}/assets`, {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": apiKey,
			},
			body: JSON.stringify({ ids: assetIds }),
		});
	} catch {
		return { ok: false, reason: "request_failed" };
	}
	if (response.status === 401) {
		return { ok: false, reason: "needs_reauth" };
	}
	if (!response.ok) {
		return { ok: false, reason: "request_failed" };
	}
	// Response body (an array of per-asset {id, success, error?}) is not
	// otherwise inspected: a duplicate-asset entry is success by design (see
	// module doc comment), and there is no per-asset failure this module
	// treats as fatal to the overall add — a non-2xx status is the only
	// signal that matters here.
	return { ok: true, detail: `added to "${ALBUM_NAME}" album` };
}

async function executeAddToAlbum(
	userId: string,
	connectionId: string,
	content: string,
	opts?: ImmichWriteOpt,
): Promise<WriteExecutionResult> {
	const parsed = parseAddToAlbumContent(content);
	if (!parsed) return { ok: false, reason: "unsupported_operation" };

	const conn = await getConnection(userId, connectionId);
	if (!conn) return { ok: false, reason: "connection_not_found" };

	// Requires the SEPARATE write-scoped key (Issue 6.4) — a connection that
	// only ever completed the read-only 5.5 connect flow has no write secret
	// at all, and must be refused here rather than falling back to the
	// read-only key (which structurally cannot perform album writes anyway).
	const apiKey = await getConnectionWriteSecret(userId, connectionId);
	if (!apiKey) return { ok: false, reason: "writes_not_provisioned" };

	const config = immichWriteConfig(conn);
	if (!config) return { ok: false, reason: "request_failed" };

	const fetchImpl = opts?.fetch ?? fetch;

	const albumResult = await findOrCreateAlbum(
		fetchImpl,
		config.origin,
		apiKey,
		parsed.albumName,
	);
	if (!albumResult.ok) return albumResult;

	const result = await addAssetsToAlbum(
		fetchImpl,
		config.origin,
		apiKey,
		albumResult.albumId,
		parsed.assetIds,
	);
	if (!result.ok && result.reason === "needs_reauth") {
		await updateConnection(userId, connectionId, {
			status: "needs_reauth",
			statusDetail: "Immich rejected the stored write-scoped API key",
		});
	}
	return result;
}

// ---------------------------------------------------------------------------
// registration (Issue 6.0) — imported for its side effect by pending-writes
// .ts, the same way providers/{nextcloud-files,google-calendar-write,
// apple-caldav-write,imap-write}.ts are (see the comment above that import
// for why this needs to happen on that exact import path).
// ---------------------------------------------------------------------------

registerWriteExecutor({
	provider: "immich",
	async execute(
		userId,
		connectionId,
		op: WriteOperation,
		content,
		opts?: ImmichWriteOpt,
	) {
		switch (op.action) {
			case "immich.add_to_album":
				return executeAddToAlbum(userId, connectionId, content, opts);
			default:
				return { ok: false, reason: "unsupported_operation" };
		}
	},
});

// Re-exported only so callers/tests never need to reach into ImmichError's
// origin module just to type-check a caught error from this executor.
export { ImmichError };
