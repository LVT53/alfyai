import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import {
	documentTabsFromMetadata,
	getArtifact,
	saveDocumentBody,
	updateArtifactBody,
} from "$lib/server/services/artifacts";
import type { DocumentTab } from "$lib/server/services/artifacts/serialize/document";
import type { RequestHandler } from "./$types";

/**
 * `payload.tabs`, validated field by field — the same shape
 * `document-ops.ts`'s `documentTabsFromMetadata` already trusts, applied here
 * to a client-supplied value instead of the stored metadata. `undefined`
 * (field missing) and "not actually a well-formed tab list" both mean
 * "nothing supplied" — the caller falls back to the stored tabs either way.
 */
function parseSuppliedTabs(value: unknown): DocumentTab[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const tabs: DocumentTab[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") return undefined;
		const { id, title, startBlockId } = entry as Record<string, unknown>;
		if (
			typeof id !== "string" ||
			typeof title !== "string" ||
			typeof startBlockId !== "string"
		) {
			return undefined;
		}
		tabs.push({ id, title, startBlockId });
	}
	return tabs;
}

// PATCH /api/artifacts/[id]/body — the one write route every kind's body goes
// through (ruling 13: the field is `body` for every type, never `markdown`,
// since Canvas and Slides write JSON through this same shape). The panel's
// autosave is its main caller, so this route opts into ruling 47's coalescing
// (`coalesceUserEdits: true`) unless the caller says `coalesce: false` — a
// burst of keystrokes updates the latest version in place rather than
// minting one per debounce.
//
// A Document's tabs are carried forward UNCHANGED on an ordinary body save
// (typing never touches the tab strip): this route reads the artifact's
// current metadata and re-supplies the same tab list UNLESS the caller
// supplies its own well-formed `tabs` array — `Tabs.svelte` (T9) is that one
// caller, threading its add/rename/delete result through the SAME save path
// every other edit uses (one write path, per T9.2/T9.7), rather than a
// second route for tab mutations alone. A malformed `tabs` field is ignored,
// not rejected — falling back to the stored tabs is always safe, and this
// route's job is to fail SAFE on a client bug, not to bounce the request.
export const PATCH: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const artifactId = event.params.id;
	const conversationId = event.url.searchParams.get("conversationId");

	const payload = (await event.request.json().catch(() => null)) as {
		body?: unknown;
		expectVersion?: unknown;
		tabs?: unknown;
		baseHash?: unknown;
		coalesce?: unknown;
	} | null;
	if (!payload || typeof payload.body !== "string") {
		return json({ ok: false, reason: "invalid_patch" }, { status: 400 });
	}
	const expectVersion =
		typeof payload.expectVersion === "number"
			? payload.expectVersion
			: undefined;
	// Ruling 47 coalesces a burst of saves into one version WITHOUT moving the
	// version number, so `expectVersion` alone cannot tell a second writer's
	// save from the editor's own previous one. A writer that is not the
	// editor's autosave — the card's tick, which reads, changes one line and
	// writes — says what it read (`baseHash`, refused as `stale` when the body
	// moved since) and asks for a version of its own (`coalesce: false`), so
	// the number moves and an open editor still holding the old one is refused
	// (`version_conflict`) instead of saving over the tick (RV-1A).
	const baseHash =
		typeof payload.baseHash === "string" ? payload.baseHash : undefined;
	const coalesceUserEdits = payload.coalesce !== false;

	const artifact = await getArtifact({
		userId: user.id,
		artifactId,
		conversationId,
	});
	if (!artifact) {
		return json({ ok: false, reason: "not_found" }, { status: 404 });
	}

	const suppliedTabs = parseSuppliedTabs(payload.tabs);
	const result =
		artifact.kind === "document"
			? await saveDocumentBody({
					userId: user.id,
					artifactId,
					conversationId,
					body: {
						markdown: payload.body,
						tabs: suppliedTabs ?? documentTabsFromMetadata(artifact.metadata),
					},
					author: "user",
					summary: "Edited",
					expectVersion,
					baseHash,
					coalesceUserEdits,
				})
			: await updateArtifactBody({
					userId: user.id,
					artifactId,
					conversationId,
					body: payload.body,
					author: "user",
					summary: "Edited",
					expectVersion,
					baseHash,
					coalesceUserEdits,
				}).then((r) =>
					r.ok ? { ok: true as const, version: r.versionNumber } : r,
				);

	if (!result.ok) {
		const status =
			result.reason === "not_found"
				? 404
				: result.reason === "too_large"
					? 413
					: result.reason === "version_conflict" || result.reason === "stale"
						? 409
						: 400;
		return json({ ok: false, reason: result.reason }, { status });
	}

	return json({ ok: true, version: result.version });
};
