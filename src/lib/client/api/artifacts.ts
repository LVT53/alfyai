/**
 * Reusable browser calls for the artifact family (Feature 2 · Artifacts,
 * Slice 0). Follows `file-production.ts` exactly: injectable `fetchImpl`,
 * `requestJson`, no store — stores own state transitions, not network calls.
 */
import type {
	ArtifactCardSummary,
	ArtifactComment,
	ArtifactDetail,
	ArtifactRecord,
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

export type SaveArtifactBodyResult =
	| { ok: true; version: number }
	| {
			ok: false;
			reason:
				| "not_found"
				| "too_large"
				| "stale"
				| "hash_mismatch"
				| "version_conflict"
				| "invalid_patch";
	  };

/**
 * The one write route every kind's body goes through (ruling 13). Never
 * throws on a documented refusal (409/413/404/400 all decode to `ok: false`
 * with a `reason`) — the editor keeps the user's text either way (T7.3,
 * T7.10, T7.11), so the caller decides what that refusal means rather than
 * this function collapsing it into a thrown Error.
 */
export async function saveArtifactBody(
	artifactId: string,
	body: string,
	expectVersion?: number,
	conversationId?: string | null,
	fetchImpl: FetchLike = fetch,
): Promise<SaveArtifactBodyResult> {
	const response = await fetchImpl(
		`/api/artifacts/${encodeURIComponent(artifactId)}/body${withConversationQuery(conversationId)}`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				body,
				...(expectVersion !== undefined ? { expectVersion } : {}),
			}),
		},
	);
	const payload = (await response
		.json()
		.catch(() => null)) as SaveArtifactBodyResult | null;
	if (!payload) {
		return { ok: false, reason: "not_found" };
	}
	return payload;
}

/**
 * `Tabs.svelte`'s (T9) one write path for add/rename/delete: the SAME body
 * route every other Document edit uses, with a `tabs` field the route
 * threads into `saveDocumentBody`'s `metadataPatch` instead of falling back
 * to the artifact's current stored tabs (`+server.ts`'s own comment). The
 * current markdown is required, not optional — this call still writes the
 * body in the same transaction as the tab change (one version, not two), so
 * the caller passes exactly what it would otherwise autosave.
 */
export async function saveDocumentTabs(
	artifactId: string,
	tabs: { id: string; title: string; startBlockId: string }[],
	markdown: string,
	expectVersion?: number,
	conversationId?: string | null,
	fetchImpl: FetchLike = fetch,
): Promise<SaveArtifactBodyResult> {
	const response = await fetchImpl(
		`/api/artifacts/${encodeURIComponent(artifactId)}/body${withConversationQuery(conversationId)}`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				body: markdown,
				tabs,
				...(expectVersion !== undefined ? { expectVersion } : {}),
			}),
		},
	);
	const payload = (await response
		.json()
		.catch(() => null)) as SaveArtifactBodyResult | null;
	if (!payload) {
		return { ok: false, reason: "not_found" };
	}
	return payload;
}

/**
 * The Document's one direct-create call (`slice-1.md` T7.10's "deleted while
 * open" escape hatch): the artifact the panel had open is gone, so there is
 * no id to PATCH against — this posts the editor's own text as a brand-new
 * Document instead. Every other kind is created only through Alfy's
 * `create_artifact` tool, never from the browser.
 */
export async function createDocumentCopy(
	conversationId: string | null,
	title: string,
	markdown: string,
	fetchImpl: FetchLike = fetch,
): Promise<ArtifactRecord> {
	const payload = await requestJson<{ ok: true; artifact: ArtifactRecord }>(
		"/api/artifacts/document",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ conversationId, title, markdown }),
		},
		"Could not save this as a new document",
		fetchImpl,
	);
	return payload.artifact;
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
