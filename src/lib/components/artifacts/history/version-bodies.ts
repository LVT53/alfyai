/**
 * The stored body of one version, for History's previews (a Document's text, a
 * board's JSON, an App's source). A stored version's body never changes under its
 * id, with one exception: the newest row of a Document or board takes a typing
 * burst's saves into itself, so for that one the key carries the body's hash and a
 * burst that saved again is fetched again. Keeping what was fetched means stepping
 * through the rail, or switching "This version's changes" and "Compared with now",
 * never asks the server for the same body twice.
 *
 * Module-level on purpose: a preview is remounted for every selection, and its own
 * cache would die with it. A small, bounded memory (the bodies can be large).
 */
import { fetchArtifactVersionBody } from "$lib/client/api/artifacts";

const MAX_KEPT = 16;
const kept = new Map<string, Promise<string>>();

export interface VersionBodyRequest {
	artifactId: string;
	versionId: string;
	/** The conversation the panel shows, so an incognito chat's item stays in scope. */
	conversationId: string | null;
	/** The newest version and its hash: its body is keyed by the hash. */
	nowVersionId: string;
	nowHash: string;
}

export function versionBody(request: VersionBodyRequest): Promise<string> {
	const { artifactId, versionId, conversationId } = request;
	const key = `${conversationId ?? ""}|${artifactId}:${versionId}${
		versionId === request.nowVersionId ? `:${request.nowHash}` : ""
	}`;
	const known = kept.get(key);
	if (known) {
		// Most recently used last: the oldest is the first the map yields.
		kept.delete(key);
		kept.set(key, known);
		return known;
	}
	const pending = fetchArtifactVersionBody(
		artifactId,
		versionId,
		conversationId,
	);
	kept.set(key, pending);
	// A failure is not kept: the next ask tries again.
	pending.catch(() => {
		if (kept.get(key) === pending) kept.delete(key);
	});
	while (kept.size > MAX_KEPT) {
		const oldest = kept.keys().next().value;
		if (oldest === undefined) break;
		kept.delete(oldest);
	}
	return pending;
}
