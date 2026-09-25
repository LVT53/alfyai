/**
 * Reusable browser calls for the artifact family (Feature 2 · Artifacts,
 * Slice 0). Follows `file-production.ts` exactly: injectable `fetchImpl`,
 * `requestJson`, no store — stores own state transitions, not network calls.
 */
import type {
	ArtifactCardSummary,
	ArtifactComment,
	ArtifactDetail,
	ArtifactVersionSummary,
} from "$lib/server/services/artifacts/types";
import { _unwrapList } from "./_utils";
import { type FetchLike, requestJson, requestResponse } from "./http";

/** The kv route's one reason vocabulary (Contracts, storage.ts's `APP_KV_LIMITS`). */
export type AppKvRefusalReason =
	| "invalid_key"
	| "too_large"
	| "too_many_keys"
	| "not_serialisable"
	| "not_found";

export type AppKvReadResult =
	| { ok: true; value: unknown }
	| { ok: false; reason: AppKvRefusalReason };

export type AppKvWriteResult =
	| { ok: true }
	| { ok: false; reason: AppKvRefusalReason };

export interface ArtifactDetailResponse {
	artifact: ArtifactDetail;
	versions: ArtifactVersionSummary[];
	comments: ArtifactComment[];
}

/**
 * `conversationId` widens the read past the default ownership scope
 * (`getArtifact`'s `ArtifactScopeOptions`), which otherwise hides an
 * incognito conversation's own artifacts — so opening an artifact from
 * inside the chat that made it must always send the current conversation's
 * id, incognito or not. The server only widens scope to a conversation the
 * caller owns, so sending it is always safe.
 */
/**
 * Ruling 49: the route answers `{ ok: true, artifact, versions, comments }`
 * on success. `ok` is the wire shape's success/failure discriminator, not
 * part of what a caller of this function wants — every existing caller wants
 * exactly `ArtifactDetailResponse`, so it is read here and left behind.
 */
export async function fetchArtifact(
	artifactId: string,
	conversationId?: string | null,
	fetchImpl: FetchLike = fetch,
): Promise<ArtifactDetailResponse> {
	const query = conversationId
		? `?conversationId=${encodeURIComponent(conversationId)}`
		: "";
	const response = await requestJson<ArtifactDetailResponse & { ok: true }>(
		`/api/artifacts/${encodeURIComponent(artifactId)}${query}`,
		undefined,
		"Failed to open this item",
		fetchImpl,
	);
	return {
		artifact: response.artifact,
		versions: response.versions,
		comments: response.comments,
	};
}

export async function fetchConversationArtifacts(
	conversationId: string,
	fetchImpl: FetchLike = fetch,
): Promise<ArtifactCardSummary[]> {
	const payload = await requestJson<unknown>(
		`/api/artifacts?conversationId=${encodeURIComponent(conversationId)}`,
		undefined,
		"Failed to open this item",
		fetchImpl,
	);
	return _unwrapList<ArtifactCardSummary>(payload, "artifacts");
}

/**
 * The App storage bridge's two browser calls (`AppFrame.svelte`'s reply
 * path). Every status the kv route can answer — 200/400/404/413/409 — carries
 * the same `{ ok, ... }` body (ruling 49), so both functions read the parsed
 * body directly through `requestResponse` rather than `requestJson`, which
 * would throw away the `reason` the moment a status is not 2xx. The frame
 * needs that reason to pick the app's own localised line
 * (`artifacts.app.storage.*`) — never a generic "something went wrong".
 */
export async function readAppValue(
	artifactId: string,
	key: string,
	fetchImpl: FetchLike = fetch,
): Promise<AppKvReadResult> {
	const response = await requestResponse(
		`/api/artifacts/${encodeURIComponent(artifactId)}/app/kv?key=${encodeURIComponent(key)}`,
		undefined,
		fetchImpl,
	);
	return (await response.json()) as AppKvReadResult;
}

export async function writeAppValue(
	artifactId: string,
	key: string,
	value: unknown,
	fetchImpl: FetchLike = fetch,
): Promise<AppKvWriteResult> {
	const response = await requestResponse(
		`/api/artifacts/${encodeURIComponent(artifactId)}/app/kv`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ key, value }),
		},
		fetchImpl,
	);
	return (await response.json()) as AppKvWriteResult;
}
