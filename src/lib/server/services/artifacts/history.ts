// An artifact's history as moments a reader can follow (ruling 76,
// docs/design/artifacts-versioning/versioning.md): the loader. It reads one
// page of `artifact_versions` rows through the same scoped read as every other
// artifact function, hands them to the pure derivation in `moments/derive.ts`,
// and answers with moments (`$lib/shared/artifacts/history`). Nothing is
// stored here: a moment is derived, so the list, the header and the tests
// cannot disagree, and only what a row cannot say (a name, a burst's first
// save) is a column of its own.
//
// A page reads the newest `limit` rows below `before` plus as many more as the
// deepest moment can reach and the parent of the last, all with their bodies
// except those over the comparison cap; then three light questions that need
// no bodies: which Undo, Redo and restore rows came after the page (for
// "undone later" and "restored from here"), which rows the page names but does
// not hold, and which comments Alfy's replies wrote.
import {
	and,
	asc,
	desc,
	eq,
	gt,
	gte,
	inArray,
	like,
	lt,
	or,
	sql,
} from "drizzle-orm";
import { db } from "$lib/server/db";
import { artifactComments, artifactVersions } from "$lib/server/db/schema";
import { computeCanvasReview } from "$lib/shared/artifacts/canvas-review";
import type {
	ArtifactHistoryResponse,
	MomentAuthor,
} from "$lib/shared/artifacts/history";
import { classifyVersionSummary } from "$lib/shared/artifacts/version-summaries";
import {
	computePendingReviewBlocks,
	documentTabsFromMetadata,
	readDocumentReviewMetadata,
} from "./document-ops";
import {
	ARTIFACT_HISTORY_DIFF_MAX_BYTES,
	ARTIFACT_HISTORY_LOOKAHEAD_ROWS,
	ARTIFACT_HISTORY_PAGE_MAX,
	ARTIFACT_VERSIONS_DEFAULT_LIMIT,
} from "./limits";
import {
	type DetailCache,
	deriveMoments,
	type HistoryReview,
	type HistoryRow,
	type HistoryRowMeta,
} from "./moments/derive";
import {
	isEditableArtifactRow,
	kindForArtifactRow,
	parseArtifactMetadata,
	readScopedArtifactRow,
} from "./record";
import type { ArtifactAuthor, ArtifactScopeOptions } from "./types";

/**
 * The Alfy versions that still wait for the reader, kept for the next page or the
 * next open (RV-V M-10). Computing them parses every version since the review's
 * marker, bodies included, and the answer cannot change while the newest version
 * (its row and its hash: a typing burst saves into one) and the marker are what
 * they were, since an older version's body is never rewritten. A set of version
 * numbers only, never a body.
 */
const REVIEW_CACHE_MAX_ENTRIES = 500;
const reviewCache = new Map<string, ReadonlySet<number>>();
function trimReviewCache(): void {
	while (reviewCache.size > REVIEW_CACHE_MAX_ENTRIES) {
		const oldest = reviewCache.keys().next();
		if (oldest.done) return;
		reviewCache.delete(oldest.value);
	}
}

/**
 * What a row's comparison with its parent came to, kept for the next page or
 * the next open: only the newest row of an artifact can change, and its hash
 * changes with it, so `(version id, body hash)` is exact. Small facts only
 * (a detail line, a tick), never a body.
 */
const DETAIL_CACHE_MAX_ENTRIES = 2000;
const detailCache: DetailCache = new Map();
function trimDetailCache(): void {
	while (detailCache.size > DETAIL_CACHE_MAX_ENTRIES) {
		const oldest = detailCache.keys().next();
		if (oldest.done) return;
		detailCache.delete(oldest.value);
	}
}

/** Alfy's reply is written moments after the edit it answered: the comment within this window of the row is its reply. */
const REPLY_WINDOW_BEFORE_MS = 5_000;
const REPLY_WINDOW_AFTER_MS = 60_000;

function authorOf(value: string): MomentAuthor {
	return value === "alfy" ? "alfy" : "user";
}

function toMeta(row: {
	id: string;
	versionNumber: number;
	author: string;
	summary: string;
	createdAt: Date;
}): HistoryRowMeta {
	return {
		id: row.id,
		versionNumber: row.versionNumber,
		author: authorOf(row.author),
		summary: row.summary,
		createdAt: row.createdAt.getTime(),
	};
}

export async function listHistory(
	params: {
		userId: string;
		artifactId: string;
		/** Only versions numbered below this: the next page after one that said `nextBefore`. */
		before?: number;
		limit?: number;
	} & ArtifactScopeOptions,
): Promise<ArtifactHistoryResponse> {
	const artifact = await readScopedArtifactRow(params);
	// A produced file has no versions; its id answers like a missing one.
	if (!artifact || !isEditableArtifactRow(artifact)) {
		return { ok: false, reason: "not_found" };
	}
	const kind = kindForArtifactRow(artifact);
	const metadata = parseArtifactMetadata(artifact.metadataJson);
	const limit = Math.min(
		Math.max(Math.floor(params.limit ?? ARTIFACT_VERSIONS_DEFAULT_LIMIT), 1),
		ARTIFACT_HISTORY_PAGE_MAX,
	);
	const owned = and(
		eq(artifactVersions.artifactId, artifact.id),
		eq(artifactVersions.userId, params.userId),
	);

	const newestRow = db
		.select({
			id: artifactVersions.id,
			versionNumber: artifactVersions.versionNumber,
			bodyHash: artifactVersions.bodyHash,
		})
		.from(artifactVersions)
		.where(owned)
		.orderBy(desc(artifactVersions.versionNumber))
		.limit(1)
		.get();
	if (!newestRow) {
		return {
			ok: true,
			artifactKind: kind,
			moments: [],
			older: false,
			nextBefore: null,
			newestVersion: 0,
		};
	}

	// ---- the page's rows, bodies only where they may be compared -------------
	const below =
		params.before !== undefined
			? and(owned, lt(artifactVersions.versionNumber, params.before))
			: owned;
	const windowRows = db
		.select({
			id: artifactVersions.id,
			versionNumber: artifactVersions.versionNumber,
			author: artifactVersions.author,
			summary: artifactVersions.summary,
			createdAt: artifactVersions.createdAt,
			startedAt: artifactVersions.startedAt,
			label: artifactVersions.label,
			bodyHash: artifactVersions.bodyHash,
			bytes: sql<number>`length(CAST(${artifactVersions.body} AS BLOB))`,
		})
		.from(artifactVersions)
		.where(below)
		.orderBy(desc(artifactVersions.versionNumber))
		.limit(limit + ARTIFACT_HISTORY_LOOKAHEAD_ROWS)
		.all();
	const response = {
		ok: true as const,
		artifactKind: kind,
		newestVersion: newestRow.versionNumber,
		newestHash: newestRow.bodyHash,
	};
	if (windowRows.length === 0) {
		return { ...response, moments: [], older: false, nextBefore: null };
	}

	const readable = windowRows.filter(
		(row) => row.bytes <= ARTIFACT_HISTORY_DIFF_MAX_BYTES,
	);
	const bodies = new Map(
		readable.length === 0
			? []
			: db
					.select({ id: artifactVersions.id, body: artifactVersions.body })
					.from(artifactVersions)
					.where(
						and(
							owned,
							inArray(
								artifactVersions.id,
								readable.map((row) => row.id),
							),
						),
					)
					.all()
					.map((row) => [row.id, row.body] as const),
	);
	const rows: HistoryRow[] = windowRows.map((row) => ({
		id: row.id,
		versionNumber: row.versionNumber,
		author: authorOf(row.author),
		summary: row.summary,
		createdAt: row.createdAt.getTime(),
		startedAt: row.startedAt ? row.startedAt.getTime() : null,
		label: row.label,
		bodyHash: row.bodyHash,
		body: bodies.get(row.id) ?? null,
		large: row.bytes > ARTIFACT_HISTORY_DIFF_MAX_BYTES,
	}));
	const lowest = rows[rows.length - 1].versionNumber;

	// ---- what came after the page, and what the page names ------------------
	const newer = db
		.select({
			id: artifactVersions.id,
			versionNumber: artifactVersions.versionNumber,
			author: artifactVersions.author,
			summary: artifactVersions.summary,
			createdAt: artifactVersions.createdAt,
		})
		.from(artifactVersions)
		.where(
			and(
				owned,
				gte(artifactVersions.versionNumber, lowest),
				or(
					like(artifactVersions.summary, "Undid %"),
					like(artifactVersions.summary, "Redid %"),
					like(artifactVersions.summary, "Restored v%"),
				),
			),
		)
		.all()
		.map(toMeta);

	const held = new Set(rows.map((row) => row.versionNumber));
	const wanted = new Set<number>();
	if (lowest > 1) wanted.add(lowest - 1);
	for (const row of rows) {
		const { version } = classifyVersionSummary(row);
		if (version !== null) wanted.add(version);
	}
	const missing = [...wanted].filter((number) => !held.has(number));
	const referenced =
		missing.length === 0
			? []
			: db
					.select({
						id: artifactVersions.id,
						versionNumber: artifactVersions.versionNumber,
						author: artifactVersions.author,
						summary: artifactVersions.summary,
						createdAt: artifactVersions.createdAt,
					})
					.from(artifactVersions)
					.where(and(owned, inArray(artifactVersions.versionNumber, missing)))
					.all()
					.map(toMeta);

	// ---- review: what still waits, from the same computations as the review bar
	const review = readReview({
		kind,
		artifactId: artifact.id,
		userId: params.userId,
		metadata,
		newestVersion: newestRow.versionNumber,
		newestId: newestRow.id,
		newestHash: newestRow.bodyHash,
	});

	// ---- Alfy's replies to comments ------------------------------------------
	const replyRows = rows.filter(
		(row) => classifyVersionSummary(row).kind === "alfy_reply_edit",
	);
	const commentByVersion = new Map<number, string>();
	if (replyRows.length > 0) {
		const from =
			Math.min(...replyRows.map((row) => row.createdAt)) -
			REPLY_WINDOW_BEFORE_MS;
		const to =
			Math.max(...replyRows.map((row) => row.createdAt)) +
			REPLY_WINDOW_AFTER_MS;
		const comments = db
			.select({
				id: artifactComments.id,
				createdAt: artifactComments.createdAt,
			})
			.from(artifactComments)
			.where(
				and(
					eq(artifactComments.artifactId, artifact.id),
					eq(artifactComments.author, "alfy"),
					gt(artifactComments.createdAt, new Date(from - 1000)),
					lt(artifactComments.createdAt, new Date(to + 1000)),
				),
			)
			.orderBy(asc(artifactComments.createdAt))
			.all();
		for (const row of replyRows) {
			const matches = comments.filter((comment) => {
				const at = comment.createdAt.getTime();
				return (
					at >= row.createdAt - REPLY_WINDOW_BEFORE_MS &&
					at <= row.createdAt + REPLY_WINDOW_AFTER_MS
				);
			});
			// Best effort: exactly one reply written with the edit, else none.
			if (matches.length === 1)
				commentByVersion.set(row.versionNumber, matches[0].id);
		}
	}

	const derived = deriveMoments({
		kind,
		rows,
		limit,
		newest: newestRow,
		review,
		newer,
		referenced,
		tabs: kind === "document" ? documentTabsFromMetadata(metadata) : [],
		commentByVersion,
		cache: detailCache,
	});
	trimDetailCache();
	return {
		...response,
		moments: derived.moments,
		older: derived.older,
		nextBefore: derived.nextBefore,
	};
}

/**
 * The Alfy versions that still wait for the reader, by the review's own
 * computations (a Document's `computePendingReviewBlocks`, a board's
 * `computeCanvasReview`) against the marker on the artifact. Reads only the
 * versions from the marker's up, as the review does; nothing when the marker
 * is already at the newest version.
 */
function readReview(params: {
	kind: ReturnType<typeof kindForArtifactRow>;
	artifactId: string;
	userId: string;
	metadata: ReturnType<typeof parseArtifactMetadata>;
	newestVersion: number;
	/** The newest row and its hash: the cache's key (a version row is made once, and its body only changes by a typing burst saving into it). */
	newestId: string;
	newestHash: string;
}): HistoryReview {
	const marker = readDocumentReviewMetadata(params.metadata);
	const none: HistoryReview = {
		hasMarker: marker !== null,
		waiting: new Set(),
	};
	if (!marker || marker.throughVersion >= params.newestVersion) return none;
	if (params.kind !== "document" && params.kind !== "canvas") return none;

	const cacheKey = [
		params.artifactId,
		params.userId,
		params.newestId,
		params.newestHash,
		marker.throughVersion,
		[...marker.keptBlockIds].sort().join(","),
	].join("|");
	const known = reviewCache.get(cacheKey);
	if (known) return { hasMarker: true, waiting: new Set(known) };
	const review = computeReview(params, marker);
	reviewCache.set(cacheKey, new Set(review.waiting));
	trimReviewCache();
	return review;
}

/** Parses every version since the marker, as the review's own computation does. */
function computeReview(
	params: {
		kind: ReturnType<typeof kindForArtifactRow>;
		artifactId: string;
		userId: string;
	},
	marker: NonNullable<ReturnType<typeof readDocumentReviewMetadata>>,
): HistoryReview {
	const versions = db
		.select({
			id: artifactVersions.id,
			versionNumber: artifactVersions.versionNumber,
			author: artifactVersions.author,
			summary: artifactVersions.summary,
			body: artifactVersions.body,
		})
		.from(artifactVersions)
		.where(
			and(
				eq(artifactVersions.artifactId, params.artifactId),
				eq(artifactVersions.userId, params.userId),
				gte(artifactVersions.versionNumber, marker.throughVersion),
			),
		)
		.orderBy(asc(artifactVersions.versionNumber))
		.all();

	if (params.kind === "document") {
		const pending = computePendingReviewBlocks(
			marker.throughVersion,
			marker.keptBlockIds,
			versions.map((row) => ({
				versionNumber: row.versionNumber,
				author: row.author as ArtifactAuthor,
				body: row.body,
			})),
		);
		return {
			hasMarker: true,
			waiting: new Set(pending.map((block) => block.alfyVersionNumber)),
		};
	}
	const state = computeCanvasReview({
		throughVersion: marker.throughVersion,
		versions: versions.map((row) => ({
			id: row.id,
			versionNumber: row.versionNumber,
			author: row.author === "alfy" ? "alfy" : "user",
			summary: row.summary,
			body: row.body,
		})),
	});
	return {
		hasMarker: true,
		waiting: new Set(state.changes.map((change) => change.versionNumber)),
	};
}
