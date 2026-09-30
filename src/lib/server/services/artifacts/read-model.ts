// What the chat needs to know about the artifacts a conversation made: the
// panel's "what this chat made" list and, by its length, the header count.
// Both come from here and from nowhere else, through the conversation detail
// payload the chat page already refreshes after a file-producing turn.
import { and, count, desc, eq, inArray, max } from "drizzle-orm";
import { db } from "$lib/server/db";
import { selectInBatches } from "$lib/server/db/id-batches";
import {
	artifactComments,
	artifacts,
	artifactVersions,
} from "$lib/server/db/schema";
import { listConversationGeneratedFiles } from "$lib/server/services/file-production/read-model";
import {
	buildArtifactCanonicalOwnershipCondition,
	getArtifactOwnershipScope,
} from "$lib/server/services/knowledge/store/core";
import {
	parseDocument,
	readTaskBlock,
} from "$lib/shared/artifact-document/blocks";
import { normalizeCanvasBody } from "$lib/shared/artifacts/canvas-body";
import { computeCanvasPendingReviewCounts } from "./canvas-review";
import {
	computeDocumentPendingReviewCounts,
	documentTabsFromMetadata,
} from "./document-ops";
import {
	FAMILY_ROW_TYPES,
	kindForArtifactRow,
	parseArtifactMetadata,
	titleForArtifactRow,
} from "./record";
import type {
	AppVerificationSummary,
	ArtifactCardSummary,
	CanvasCardPreview,
	DocumentCardPreview,
} from "./types";

/** T9 steps 4/7's bounded checklist: never more than this many task items travel with the card summary. */
const DOCUMENT_PREVIEW_TASK_LIMIT = 5;

/**
 * The Document card's subtitle facts and tickable checklist, computed from
 * the SAME parse (`parseDocument`) and the SAME task-line reader
 * (`readTaskBlock`) every other Document surface uses — never a body-shaped
 * duplicate of this logic. Bounded on purpose (T9): `tasks` is at most
 * `DOCUMENT_PREVIEW_TASK_LIMIT` items, and the body itself never appears
 * anywhere in the returned value.
 */
function buildDocumentPreview(row: {
	metadataJson: string | null;
	contentText: string | null;
}): DocumentCardPreview {
	const tabCount = documentTabsFromMetadata(
		parseArtifactMetadata(row.metadataJson),
	).length;
	const blocks = row.contentText
		? parseDocument(row.contentText, { mint: false }).blocks
		: [];
	const tasks: DocumentCardPreview["tasks"] = [];
	let totalTaskCount = 0;
	for (const block of blocks) {
		const task = readTaskBlock(block);
		if (!task) continue;
		totalTaskCount += 1;
		if (tasks.length < DOCUMENT_PREVIEW_TASK_LIMIT) {
			tasks.push({ blockId: block.id, text: task.text, checked: task.checked });
		}
	}
	return { tabCount, tasks, totalTaskCount };
}

/**
 * A board's card line: how many blocks it holds, read the way the panel reads
 * it. A body that is empty or is not a board counts as none, never a throw: a
 * card must not be the thing that fails a whole conversation load.
 */
function buildCanvasPreview(row: {
	contentText: string | null;
}): CanvasCardPreview {
	if (!row.contentText?.trim()) return { blockCount: 0 };
	try {
		const { body } = normalizeCanvasBody(JSON.parse(row.contentText));
		return { blockCount: body.nodes.length };
	} catch {
		return { blockCount: 0 };
	}
}

/**
 * Wave 2.5 Step 13: the App panel's own status-row verdict (`AppBody.svelte`
 * reads the identical `metadata.verification` shape client-side), projected
 * through the facade so the in-chat card's fact-check line does not need a
 * second fetch. `null` when the App's facts were never checked (a legacy row,
 * or a kind the classifier found nothing checkable in) — distinct from
 * `undefined`, which `documentPreview`'s own sibling field uses for "not this
 * kind" (the caller below only calls this for `kind === "app"` rows).
 */
function buildAppVerificationSummary(row: {
	metadataJson: string | null;
}): AppVerificationSummary | null {
	const metadata = parseArtifactMetadata(row.metadataJson);
	const verification = metadata?.verification as
		| { checked?: unknown; verdict?: unknown }
		| undefined;
	if (
		!verification ||
		typeof verification.checked !== "boolean" ||
		typeof verification.verdict !== "string"
	) {
		return null;
	}
	return {
		checked: verification.checked,
		verdict: verification.verdict as AppVerificationSummary["verdict"],
	};
}

/**
 * The conversation's artifacts, newest change first: its own `artifact` rows,
 * and its produced files (`generated_output`, kind `file`) — but only a
 * produced file that has a file to open. Which chat file a produced-file
 * artifact stands for is the file-production read model's existing join
 * (metadata `originalChatFileId` / rendered-file ids, one artifact per chat
 * file), reused rather than written a second time.
 *
 * The conversation is the served one, so an incognito conversation lists its
 * own artifacts; no other conversation's — and no other user's — ever appear,
 * because the rows are filtered by the canonical ownership condition and pinned
 * to `artifacts.conversationId`.
 */
export async function listArtifactsForConversation(params: {
	userId: string;
	conversationId: string;
}): Promise<ArtifactCardSummary[]> {
	const ownershipScope = await getArtifactOwnershipScope(params.userId, {
		conversationId: params.conversationId,
	});
	// Not one of the caller's conversations: nothing to list, and nothing to
	// reveal about whether it holds anything.
	if (!ownershipScope.conversationIds.has(params.conversationId)) return [];

	const rows = await db
		.select({
			id: artifacts.id,
			type: artifacts.type,
			name: artifacts.name,
			metadataJson: artifacts.metadataJson,
			conversationId: artifacts.conversationId,
			updatedAt: artifacts.updatedAt,
			// T9 steps 4/7: only ever read to COMPUTE `documentPreview` below
			// (`buildDocumentPreview`) for a `kind: "document"` row, and a board's
			// block count (`buildCanvasPreview`) — the raw text itself never
			// reaches `ArtifactCardSummary`.
			contentText: artifacts.contentText,
		})
		.from(artifacts)
		.where(
			and(
				eq(artifacts.conversationId, params.conversationId),
				inArray(artifacts.type, FAMILY_ROW_TYPES),
				buildArtifactCanonicalOwnershipCondition({
					userId: params.userId,
					ownershipScope,
				}),
			),
		)
		.orderBy(desc(artifacts.updatedAt), desc(artifacts.id));
	if (rows.length === 0) return [];

	const openableFileArtifactIds = rows.some(
		(row) => row.type === "generated_output",
	)
		? new Set(
				(await listConversationGeneratedFiles(params.conversationId))
					.map((file) => file.artifactId)
					.filter((id): id is string => Boolean(id)),
			)
		: new Set<string>();
	const listed = rows.filter(
		(row) =>
			row.type !== "generated_output" || openableFileArtifactIds.has(row.id),
	);
	if (listed.length === 0) return [];

	const ids = listed.map((row) => row.id);
	// Wave 2.5 review (F1): the persisted per-Document pending-review count —
	// the chat card, the list row (below) and the header's count-button dot
	// all read this SAME number instead of each re-deriving their own from
	// the ephemeral `liveDocumentAlfyActivity` session signal. Scoped to
	// `kind === "document"` rows only; `computeDocumentPendingReviewCounts`
	// itself already skips the version-history query for a row with no
	// review marker, so this stays cheap for a conversation with no pending
	// Alfy edits at all.
	const documentMetadataRows = listed
		.filter((row) => kindForArtifactRow(row) === "document")
		.map((row) => ({ id: row.id, metadataJson: row.metadataJson }));
	// A board's own (ruling 63): the same number for the same three readers, from
	// the board's marker and its versions.
	const canvasMetadataRows = listed
		.filter((row) => kindForArtifactRow(row) === "canvas")
		.map((row) => ({ id: row.id, metadataJson: row.metadataJson }));
	const [
		versionRows,
		commentRows,
		documentReviewCountById,
		canvasReviewCountById,
	] = await Promise.all([
		db
			.select({
				artifactId: artifactVersions.artifactId,
				newest: max(artifactVersions.versionNumber),
			})
			.from(artifactVersions)
			.where(inArray(artifactVersions.artifactId, ids))
			.groupBy(artifactVersions.artifactId),
		db
			.select({
				artifactId: artifactComments.artifactId,
				total: count(),
			})
			.from(artifactComments)
			.where(inArray(artifactComments.artifactId, ids))
			.groupBy(artifactComments.artifactId),
		computeDocumentPendingReviewCounts(documentMetadataRows),
		computeCanvasPendingReviewCounts(canvasMetadataRows),
	]);
	const pendingReviewCountById = new Map([
		...documentReviewCountById,
		...canvasReviewCountById,
	]);
	const newestVersionById = new Map(
		versionRows.map((row) => [row.artifactId, row.newest ?? 0]),
	);
	const commentCountById = new Map(
		commentRows.map((row) => [row.artifactId, row.total]),
	);

	return listed.map((row) => {
		const kind = kindForArtifactRow(row);
		return {
			id: row.id,
			kind,
			title: titleForArtifactRow(row),
			conversationId: row.conversationId ?? null,
			versionNumber: newestVersionById.get(row.id) ?? 0,
			commentCount: commentCountById.get(row.id) ?? 0,
			updatedAt: row.updatedAt.getTime(),
			...(kind === "document"
				? {
						documentPreview: buildDocumentPreview(row),
						...(pendingReviewCountById.has(row.id)
							? { pendingReviewCount: pendingReviewCountById.get(row.id) }
							: {}),
					}
				: kind === "app"
					? { appVerification: buildAppVerificationSummary(row) }
					: kind === "canvas"
						? {
								canvasPreview: buildCanvasPreview(row),
								...(pendingReviewCountById.has(row.id)
									? { pendingReviewCount: pendingReviewCountById.get(row.id) }
									: {}),
							}
						: {}),
		};
	});
}

/**
 * What became of the artifact ids a conversation's tool calls named, so a
 * card can tell the two apart:
 *
 * - `deleted`: no item of the caller's holds the id any more (deleted in the
 *   panel, the Knowledge library or another tab). Another user's row reads
 *   exactly like a missing one — nothing about it, not even that it exists,
 *   is revealed.
 * - `unreachable`: the caller's OWN item, which exists but cannot be reached
 *   from this conversation — the parent of a forked incognito chat (the fork
 *   is incognito too, and a fork copies the parent's tool calls but never its
 *   items), or a row whose chat link was cleared. It is not deleted, so the
 *   card must not say so, and nothing may regenerate it: it is still there.
 *   Containment is unchanged; only "there is one" is said, to its own owner.
 *
 * "Reachable" is the very same ownership condition every artifact read uses.
 * A conversation that is not the caller's answers nothing at all.
 */
export async function listMissingArtifactIds(params: {
	userId: string;
	conversationId: string;
	artifactIds: readonly string[];
}): Promise<{ deleted: string[]; unreachable: string[] }> {
	const wanted = [...new Set(params.artifactIds)];
	if (wanted.length === 0) return { deleted: [], unreachable: [] };
	const ownershipScope = await getArtifactOwnershipScope(params.userId, {
		conversationId: params.conversationId,
	});
	if (!ownershipScope.conversationIds.has(params.conversationId)) {
		return { deleted: [], unreachable: [] };
	}

	const reachable = new Set(
		(
			await selectInBatches(wanted, (batch) =>
				db
					.select({ id: artifacts.id })
					.from(artifacts)
					.where(
						and(
							inArray(artifacts.id, batch),
							inArray(artifacts.type, FAMILY_ROW_TYPES),
							buildArtifactCanonicalOwnershipCondition({
								userId: params.userId,
								ownershipScope,
							}),
						),
					),
			)
		).map((row) => row.id),
	);
	const missing = wanted.filter((id) => !reachable.has(id));
	if (missing.length === 0) return { deleted: [], unreachable: [] };

	// Of those, the caller's own rows that are still there: out of reach, not
	// gone. Only the caller's own — a stranger's id stays "missing".
	const existing = new Set(
		(
			await selectInBatches(missing, (batch) =>
				db
					.select({ id: artifacts.id })
					.from(artifacts)
					.where(
						and(
							inArray(artifacts.id, batch),
							inArray(artifacts.type, FAMILY_ROW_TYPES),
							eq(artifacts.userId, params.userId),
						),
					),
			)
		).map((row) => row.id),
	);
	return {
		deleted: missing.filter((id) => !existing.has(id)),
		unreachable: missing.filter((id) => existing.has(id)),
	};
}
