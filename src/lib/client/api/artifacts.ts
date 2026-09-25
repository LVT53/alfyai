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
import { type FetchLike, requestJson } from "./http";

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

function withConversationQuery(conversationId?: string | null): string {
	return conversationId
		? `?conversationId=${encodeURIComponent(conversationId)}`
		: "";
}

/** The History sheet's own list (Slice 1, T6) — separate from fetchArtifact so a restore can refresh just this. */
export async function fetchArtifactVersions(
	artifactId: string,
	conversationId?: string | null,
	fetchImpl: FetchLike = fetch,
): Promise<ArtifactVersionSummary[]> {
	const payload = await requestJson<{
		ok: true;
		versions: ArtifactVersionSummary[];
	}>(
		`/api/artifacts/${encodeURIComponent(artifactId)}/versions${withConversationQuery(conversationId)}`,
		undefined,
		"Failed to load the version history",
		fetchImpl,
	);
	return payload.versions;
}

/** One version's stored body, for the History sheet's preview. */
export async function fetchArtifactVersionBody(
	artifactId: string,
	versionId: string,
	conversationId?: string | null,
	fetchImpl: FetchLike = fetch,
): Promise<string> {
	const payload = await requestJson<{ ok: true; body: string }>(
		`/api/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}${withConversationQuery(conversationId)}`,
		undefined,
		"Failed to load this version",
		fetchImpl,
	);
	return payload.body;
}

/** Restores an older version as a NEW version (never coalesced — ruling 47) and returns its version number. */
export async function restoreArtifactVersion(
	artifactId: string,
	versionId: string,
	conversationId?: string | null,
	fetchImpl: FetchLike = fetch,
): Promise<number> {
	const payload = await requestJson<{ ok: true; version: number }>(
		`/api/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}/restore${withConversationQuery(conversationId)}`,
		{ method: "POST" },
		"Failed to restore this version",
		fetchImpl,
	);
	return payload.version;
}
