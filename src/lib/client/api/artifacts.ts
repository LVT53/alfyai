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

export async function fetchArtifact(
	artifactId: string,
	fetchImpl: FetchLike = fetch,
): Promise<ArtifactDetailResponse> {
	return requestJson<ArtifactDetailResponse>(
		`/api/artifacts/${encodeURIComponent(artifactId)}`,
		undefined,
		"Failed to open this item",
		fetchImpl,
	);
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
