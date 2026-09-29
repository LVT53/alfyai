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
import type { DocumentReviewPendingBlock } from "$lib/server/services/artifacts/document-ops";
import type {
	ArtifactCardSummary,
	ArtifactComment,
	ArtifactDetail,
	ArtifactRecord,
	ArtifactVersionSummary,
} from "$lib/server/services/artifacts/types";
import {
	buildIndex,
	parseDocument,
} from "$lib/shared/artifact-document/blocks";
import {
	applyPatchSet,
	type PatchSet,
} from "$lib/shared/artifact-document/patch";
import type { Anchor } from "$lib/shared/artifacts/anchor";
import type { ArtifactKind } from "$lib/shared/artifacts/kinds";
import type { SaveSummaryKind } from "$lib/shared/artifacts/version-summaries";
import { _unwrapList } from "./_utils";
import {
	ApiError,
	type FetchLike,
	requestJson,
	requestResponse,
	requestVoid,
} from "./http";

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
 * What the browser has learned about one artifact from a response, in a form
 * every surface that shows it can follow (the list row, the in-chat card, the
 * panel header):
 *
 * - `version`: the newest version the server reported, and — when the response
 *   knows it — when the artifact was last changed (`updatedAt`, epoch ms).
 * - `deleted`: the item is gone (this browser deleted it, or the server said
 *   it no longer exists).
 */
export type ArtifactChange =
	| {
			type: "version";
			artifactId: string;
			version: number;
			updatedAt: number | null;
	  }
	| { type: "deleted"; artifactId: string };

type ArtifactChangeListener = (change: ArtifactChange) => void;
const artifactChangeListeners = new Set<ArtifactChangeListener>();

/**
 * Wave 2.5 polish G1-B (one version number everywhere) and G2-A (the same
 * announcement carries the time of the change, and deletions): every response
 * in this module that carries an artifact's current version — a fetch, a save,
 * a tab save, a restore, the newest row of the version list, an App
 * regeneration — is announced here, so the surfaces that print a version or an
 * "edited N min ago" (the list row, the in-chat card, the header) can follow
 * the server instead of each keeping a copy taken at its own moment. A delete
 * is announced through the same channel, so an open list or card flips to its
 * deleted state at once. Returns the unsubscribe function. See
 * `$lib/client/artifact-versions.ts`.
 */
export function subscribeArtifactChanges(
	listener: ArtifactChangeListener,
): () => void {
	artifactChangeListeners.add(listener);
	return () => {
		artifactChangeListeners.delete(listener);
	};
}

function announceArtifactChange(change: ArtifactChange): void {
	for (const listener of artifactChangeListeners) listener(change);
}

/**
 * `updatedAt`: what the response itself says about when the artifact changed,
 * or the moment a write was acknowledged (a write just happened, so "now" is
 * when it changed); `null` when the response does not say (a version list's
 * newest row is a version's own time, not the artifact's).
 */
function announceArtifactVersion(
	artifactId: string,
	version: unknown,
	updatedAt: number | null,
): void {
	if (typeof version !== "number") return;
	announceArtifactChange({ type: "version", artifactId, version, updatedAt });
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
	announceArtifactVersion(
		artifactId,
		response.artifact.versionNumber,
		typeof response.artifact.updatedAt === "number"
			? response.artifact.updatedAt
			: null,
	);
	return {
		artifact: response.artifact,
		versions: response.versions,
		comments: response.comments,
	};
}

export type DeleteArtifactResult = {
	ok: true;
	/** The server had no such item any more (deleted elsewhere): still "gone", which is what the caller wanted. */
	alreadyGone: boolean;
};

/**
 * Deletes one item for good (`DELETE /api/artifacts/[id]`). Once it is gone —
 * removed now, or the server says it was already gone — the deletion is
 * announced through `subscribeArtifactChanges`, so an open list row or chat
 * card flips to its deleted state without waiting for a refresh. Any other
 * failure throws (the item is still there, and the caller says so).
 * `conversationId` is the served conversation (ruling 51), the only way an
 * incognito chat's own item can be reached.
 */
export async function deleteArtifact(
	artifactId: string,
	conversationId?: string | null,
	fetchImpl: FetchLike = fetch,
): Promise<DeleteArtifactResult> {
	let alreadyGone = false;
	try {
		await requestVoid(
			`/api/artifacts/${encodeURIComponent(artifactId)}${withConversationQuery(conversationId)}`,
			{ method: "DELETE" },
			"Failed to delete this item",
			fetchImpl,
		);
	} catch (error) {
		if (!(error instanceof ApiError) || error.status !== 404) throw error;
		alreadyGone = true;
	}
	announceArtifactChange({ type: "deleted", artifactId });
	return { ok: true, alreadyGone };
}

export type RegenerateDeletedArtifactResult =
	| {
			ok: true;
			/** `false`: the item exists again already (made by an earlier click or another tab); nothing was written. */
			created: boolean;
			artifactId: string;
			kind: ArtifactKind;
			title: string;
	  }
	| {
			ok: false;
			reason: "not_found" | "no_stored_input" | "in_progress" | "failed";
			detail?: string;
	  };

/**
 * "Regenerate" on a chat card whose Document or App was deleted
 * (`POST /api/conversations/[id]/artifacts/[artifactId]/regenerate`): the
 * server makes it again from the arguments the model gave `create_artifact`,
 * under the id the card already carries. Every documented refusal is a normal
 * return value with its reason (the card says which); an unreadable answer or
 * a dead connection is a plain `failed`. `language` is the reader's interface
 * language, which an App is made in.
 */
export async function regenerateDeletedArtifact(
	conversationId: string,
	artifactId: string,
	language: "en" | "hu",
	fetchImpl: FetchLike = fetch,
): Promise<RegenerateDeletedArtifactResult> {
	try {
		const response = await requestResponse(
			`/api/conversations/${encodeURIComponent(conversationId)}/artifacts/${encodeURIComponent(artifactId)}/regenerate`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ language }),
			},
			fetchImpl,
		);
		const payload = (await response
			.json()
			.catch(() => null)) as RegenerateDeletedArtifactResult | null;
		return payload && typeof payload.ok === "boolean"
			? payload
			: { ok: false, reason: "failed" };
	} catch {
		return { ok: false, reason: "failed" };
	}
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
	const result = (await response.json()) as RegenerateAppResult;
	// A success reports the new version; a conflict reveals the current one.
	if (result.ok) {
		announceArtifactVersion(artifactId, result.version, Date.now());
	} else if (result.reason === "version_conflict") {
		announceArtifactVersion(artifactId, result.version, null);
	}
	return result;
}

export type DownloadAppResult =
	| { ok: true; job: unknown; reused: boolean }
	| { ok: false; reason: string };

/**
 * Turns the App's CURRENT stored body into a downloadable HTML chat file.
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

export type SaveArtifactBodyResult =
	| {
			ok: true;
			version: number;
			/**
			 * RV-1B, coordinator item 6: the hash of the body this call just wrote.
			 * A caller that keeps typing (the editor's autosave) remembers this as
			 * its next `guard.baseHash`, so the write after this one is checked
			 * against what is REALLY stored now, not stale from before this save.
			 * Optional, not because a real save ever omits it, but so a test's
			 * hand-built response (or an older cached one) still decodes.
			 */
			bodyHash?: string;
	  }
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
	/**
	 * For a writer that is NOT the editor's autosave (the card's tick):
	 * `baseHash` is the body hash it read (a save over a body that moved since
	 * is refused `stale`), and `coalesce: false` makes the save a version of
	 * its own, so an open editor holding the old version number is refused
	 * rather than saving over it. See the body route.
	 */
	guard?: {
		baseHash?: string;
		coalesce?: boolean;
		/** What the save says about itself besides "the user typed" — see `parseSaveSummaryKind`. */
		summaryKind?: SaveSummaryKind;
	},
): Promise<SaveArtifactBodyResult> {
	const response = await fetchImpl(
		`/api/artifacts/${encodeURIComponent(artifactId)}/body${withConversationQuery(conversationId)}`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				body,
				...(expectVersion !== undefined ? { expectVersion } : {}),
				...(guard?.baseHash !== undefined ? { baseHash: guard.baseHash } : {}),
				...(guard?.coalesce !== undefined ? { coalesce: guard.coalesce } : {}),
				...(guard?.summaryKind !== undefined
					? { summaryKind: guard.summaryKind }
					: {}),
			}),
		},
	);
	const payload = (await response
		.json()
		.catch(() => null)) as SaveArtifactBodyResult | null;
	if (!payload) {
		return { ok: false, reason: "not_found" };
	}
	if (payload.ok)
		announceArtifactVersion(artifactId, payload.version, Date.now());
	return payload;
}

export type ToggleDocumentTaskResult =
	| { ok: true; version: number }
	| {
			ok: false;
			reason:
				| "not_found"
				| "too_large"
				| "stale"
				| "hash_mismatch"
				| "version_conflict"
				| "invalid_patch"
				/** The block is gone, or is no longer a task line — an ordinary race with a concurrent edit, never an error to throw over. */
				| "block_not_found";
	  };

/**
 * The chat card's own tick (T9.7, spec §2.3): "ticking one writes the
 * document (through the same patch path, not a second write path)". The
 * card only ever holds the bounded preview (never a full body), so this
 * reads the current one, applies the toggle through the SAME pure engine
 * `edit_artifact` and the editor's own toolbar use (`applyPatchSet` —
 * snapshotted from the read that just happened, so it is never refused as
 * `block_unseen`/`block_changed`), and saves through the one Document write
 * path (`saveArtifactBody`, ruling 47's coalescing, the hash guard,
 * `expectVersion`) — exactly like the open editor's own autosave.
 */
export async function toggleDocumentTask(
	artifactId: string,
	blockId: string,
	checked: boolean,
	conversationId?: string | null,
	fetchImpl: FetchLike = fetch,
): Promise<ToggleDocumentTaskResult> {
	let detail: ArtifactDetailResponse;
	try {
		detail = await fetchArtifact(artifactId, conversationId, fetchImpl);
	} catch {
		return { ok: false, reason: "not_found" };
	}

	const blocks = parseDocument(detail.artifact.body ?? "", {
		mint: false,
	}).blocks;
	const block = blocks.find((candidate) => candidate.id === blockId);
	if (!block) return { ok: false, reason: "block_not_found" };

	const patch: PatchSet = {
		patchId: `user-toggle-${blockId}`,
		label: "Toggled task",
		ops: [
			{
				opId: "toggle",
				kind: "toggleTask",
				blockId,
				baseHash: block.hash,
				blockLabel: block.label,
				checked,
			},
		],
	};
	const result = applyPatchSet({ blocks, patch, snapshot: buildIndex(blocks) });
	if (result.applied === 0) return { ok: false, reason: "block_not_found" };

	// The tick is a second writer beside any open editor: it says which body it
	// changed, and takes a version of its own (RV-1A) — see saveArtifactBody.
	return saveArtifactBody(
		artifactId,
		result.markdown,
		detail.artifact.versionNumber,
		conversationId,
		fetchImpl,
		{ baseHash: detail.artifact.bodyHash ?? undefined, coalesce: false },
	);
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
	if (payload.ok)
		announceArtifactVersion(artifactId, payload.version, Date.now());
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
	announceArtifactVersion(
		payload.artifact.id,
		payload.artifact.versionNumber,
		typeof payload.artifact.updatedAt === "number"
			? payload.artifact.updatedAt
			: null,
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
	// Newest first: the top row IS the current version.
	announceArtifactVersion(artifactId, payload.versions[0]?.versionNumber, null);
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
	announceArtifactVersion(artifactId, payload.version, Date.now());
	return payload.version;
}

/** Creates a root comment (`anchor` set, `parentId` omitted) or a reply (`anchor: null`, `parentId` set). T10.1. */
export async function createArtifactComment(
	artifactId: string,
	anchor: Anchor | null,
	body: string,
	parentId?: string,
	conversationId?: string | null,
	fetchImpl: FetchLike = fetch,
): Promise<ArtifactComment> {
	const payload = await requestJson<{ ok: true; comment: ArtifactComment }>(
		`/api/artifacts/${encodeURIComponent(artifactId)}/comments${withConversationQuery(conversationId)}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				anchor,
				body,
				...(parentId !== undefined ? { parentId } : {}),
			}),
		},
		"Could not post this comment",
		fetchImpl,
	);
	return payload.comment;
}

/** Resolves or reopens a thread (T10.4). */
export async function resolveArtifactComment(
	artifactId: string,
	commentId: string,
	resolved: boolean,
	conversationId?: string | null,
	fetchImpl: FetchLike = fetch,
): Promise<void> {
	await requestJson<{ ok: true }>(
		`/api/artifacts/${encodeURIComponent(artifactId)}/comments/${encodeURIComponent(commentId)}/resolve${withConversationQuery(conversationId)}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ resolved }),
		},
		"Could not update this comment",
		fetchImpl,
	);
}

export interface AskAlfyResult {
	outcome: "applied" | "refused" | "answered";
	applied: number;
	refused: number;
	version: number;
	reply: ArtifactComment;
}

/**
 * The `@Alfy` hook (T10.5). All three outcomes — applied, refused, answered —
 * come back as a normal resolved value (the route answers `ok: true` for
 * every one of them, since a refusal is the feature, not an error); this
 * throws only for the genuine failures (a foreign/missing artifact or
 * comment, or the call timing out server-side).
 */
export async function askAlfyInComment(
	artifactId: string,
	commentId: string,
	conversationId?: string | null,
	fetchImpl: FetchLike = fetch,
): Promise<AskAlfyResult> {
	const payload = await requestJson<{ ok: true } & AskAlfyResult>(
		`/api/artifacts/${encodeURIComponent(artifactId)}/comments/${encodeURIComponent(commentId)}/alfy${withConversationQuery(conversationId)}`,
		{ method: "POST" },
		"Could not reach Alfy for this comment",
		fetchImpl,
	);
	return {
		outcome: payload.outcome,
		applied: payload.applied,
		refused: payload.refused,
		version: payload.version,
		reply: payload.reply,
	};
}

export type ExportArtifactDocumentFormat = "pdf" | "docx" | "markdown";

export type ExportArtifactDocumentResult =
	| { ok: true; job: { id: string } }
	| {
			ok: false;
			reason:
				| "not_found"
				| "no_conversation"
				| "source_too_large"
				| "invalid_format"
				| string;
	  };

/**
 * Export through `produce_file` (T12). Mirrors `saveArtifactBody`: a
 * documented refusal (a limit, a missing conversation, a foreign artifact)
 * is a normal return value, never a thrown `ApiError` — `DownloadSheet`
 * decides what each reason means, the same way the editor decides what a
 * save conflict means.
 */
export async function exportArtifactDocument(
	artifactId: string,
	format: ExportArtifactDocumentFormat,
	conversationId?: string | null,
	fetchImpl: FetchLike = fetch,
): Promise<ExportArtifactDocumentResult> {
	const response = await fetchImpl(
		`/api/artifacts/${encodeURIComponent(artifactId)}/export${withConversationQuery(conversationId)}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ format }),
		},
	);
	const payload = (await response
		.json()
		.catch(() => null)) as ExportArtifactDocumentResult | null;
	if (!payload) {
		return { ok: false, reason: "not_found" };
	}
	return payload;
}

/**
 * Ruling 61's first point: the Document's pending-review set, recomputed
 * server-side on every call — never cached client-side across a reload. Used
 * once right after the editor loads, to mark Alfy's still-unreviewed changes
 * again (§4.2's "Reload with a pending change").
 */
export async function fetchDocumentReviewState(
	artifactId: string,
	conversationId?: string | null,
	fetchImpl: FetchLike = fetch,
): Promise<DocumentReviewPendingBlock[]> {
	const payload = await requestJson<{
		ok: true;
		pending: DocumentReviewPendingBlock[];
	}>(
		`/api/artifacts/${encodeURIComponent(artifactId)}/review${withConversationQuery(conversationId)}`,
		undefined,
		"Failed to load what Alfy changed",
		fetchImpl,
	);
	return payload.pending;
}

/**
 * Keep and Undo both "acknowledge" (ruling 61) — this is the one call for
 * both. Answers the recomputed pending list so the caller can resync its own
 * review bar/pill state without a second round trip.
 */
export async function acknowledgeDocumentReviewBlocks(
	artifactId: string,
	blockIds: string[],
	conversationId?: string | null,
	fetchImpl: FetchLike = fetch,
): Promise<DocumentReviewPendingBlock[]> {
	const payload = await requestJson<{
		ok: true;
		pending: DocumentReviewPendingBlock[];
	}>(
		`/api/artifacts/${encodeURIComponent(artifactId)}/review${withConversationQuery(conversationId)}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ blockIds }),
		},
		"Failed to save what you reviewed",
		fetchImpl,
	);
	return payload.pending;
}
