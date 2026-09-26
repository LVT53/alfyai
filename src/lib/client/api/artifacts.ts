/**
 * Reusable browser calls for the artifact family (Feature 2 · Artifacts,
 * Slice 0). Follows `file-production.ts` exactly: injectable `fetchImpl`,
 * `requestJson`, no store — stores own state transitions, not network calls.
 */

// Type-only imports: erased at build time, so a client bundle never carries
// the generator/verifier's own server code — the same way ArtifactDetail
// above already crosses this boundary.
import type { AppGenerationFailureReason } from "$lib/server/services/artifacts/app/generate";
import type { AppVerification } from "$lib/server/services/artifacts/app/verify";
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
/**
 * `conversationId` widens the kv route's scope exactly like `fetchArtifact`'s
 * (ruling 51): an incognito conversation's own App cannot read/write its
 * storage unless the request names the conversation the caller is in. It
 * travels in the URL, never the body, so the GET and POST shapes stay
 * consistent with the served route and `downloadAppAsHtml`.
 */
export async function readAppValue(
	artifactId: string,
	key: string,
	conversationId?: string | null,
	fetchImpl: FetchLike = fetch,
): Promise<AppKvReadResult> {
	const params = `key=${encodeURIComponent(key)}${
		conversationId
			? `&conversationId=${encodeURIComponent(conversationId)}`
			: ""
	}`;
	const response = await requestResponse(
		`/api/artifacts/${encodeURIComponent(artifactId)}/app/kv?${params}`,
		undefined,
		fetchImpl,
	);
	return (await response.json()) as AppKvReadResult;
}

export async function writeAppValue(
	artifactId: string,
	key: string,
	value: unknown,
	conversationId?: string | null,
	fetchImpl: FetchLike = fetch,
): Promise<AppKvWriteResult> {
	const query = conversationId
		? `?conversationId=${encodeURIComponent(conversationId)}`
		: "";
	// The value arrives through postMessage's structured clone, which carries a
	// BigInt and a cycle intact; JSON cannot encode either and throws. That is
	// the route's own `not_serialisable`, answered here without a request —
	// a throw would reach the frame as a timeout instead.
	let body: string;
	try {
		body = JSON.stringify({ key, value });
	} catch {
		return { ok: false, reason: "not_serialisable" };
	}
	const response = await requestResponse(
		`/api/artifacts/${encodeURIComponent(artifactId)}/app/kv${query}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
		},
		fetchImpl,
	);
	return (await response.json()) as AppKvWriteResult;
}

export type RegenerateAppResult =
	| { ok: true; version: number; title: string; verification: AppVerification }
	| { ok: false; reason: "version_conflict"; version: number }
	| { ok: false; reason: AppGenerationFailureReason; detail: string };

/**
 * The panel's own regeneration path (`POST /api/artifacts/[id]/app/regenerate`,
 * `slice-2.md §The App card`) — one implementation, shared with the
 * `create_artifact`/tool path; this is the ONLY App route that writes.
 * `expectVersion` is Slice 1's optimistic guard on the version the caller
 * last saw; a 409 keeps the caller's prompt so the dialog can offer to retry
 * rather than silently discarding it. `conversationId` is the panel's
 * conversation (ruling 51), sent in the body like `downloadAppAsHtml`'s: the
 * route widens its scope from it, so without it every App in an incognito
 * conversation answers 404 here.
 */
export async function regenerateApp(
	artifactId: string,
	prompt: string,
	expectVersion?: number,
	conversationId?: string | null,
	fetchImpl: FetchLike = fetch,
): Promise<RegenerateAppResult> {
	const response = await requestResponse(
		`/api/artifacts/${encodeURIComponent(artifactId)}/app/regenerate`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				prompt,
				expectVersion,
				conversationId: conversationId ?? null,
			}),
		},
		fetchImpl,
	);
	return (await response.json()) as RegenerateAppResult;
}

export type DownloadAppResult =
	| { ok: true; job: unknown; reused: boolean }
	| { ok: false; reason: string };

/**
 * Turns the App's CURRENT stored body into a downloadable `.html` chat file.
 * Carries the artifact id and an optional conversation id ONLY — never the
 * HTML itself, which the server re-reads from the artifact row (A6.5): a
 * request this function could compose from a client-side copy of the source
 * would be exactly the second, unverified execution surface this feature
 * spends its CSP and sandbox work avoiding.
 */
export async function downloadAppAsHtml(
	artifactId: string,
	conversationId?: string | null,
	fetchImpl: FetchLike = fetch,
): Promise<DownloadAppResult> {
	const response = await requestResponse(
		`/api/artifacts/${encodeURIComponent(artifactId)}/app/download`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ conversationId: conversationId ?? null }),
		},
		fetchImpl,
	);
	return (await response.json()) as DownloadAppResult;
}
