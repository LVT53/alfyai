/**
 * A board's review state on the server (Feature 2 · Artifacts, Slice 3, ruling
 * 63): what Alfy's change left waiting for the reader, derived from the
 * board's own versions and the marker on the artifact's metadata
 * (`metadata.review`, ruling 61's, written by `applyArtifactOps` when Alfy's
 * first change lands). Nothing here is a second store: a pending change
 * survives a reload because it is recomputed from what is saved, and Keep is
 * the marker moving.
 *
 * The rule itself is pure and lives in `$lib/shared/artifacts/canvas-review`;
 * this module reads the versions, holds the ownership scope and does the one
 * write. Routes and the read model call it through `review.ts` and the facade.
 */
import { and, asc, eq, gte, or } from "drizzle-orm";
import { db } from "$lib/server/db";
import { artifacts, artifactVersions } from "$lib/server/db/schema";
import { parseJsonRecord } from "$lib/server/utils/json";
import {
	type CanvasReviewState,
	type CanvasReviewVersion,
	computeCanvasReview,
	EMPTY_CANVAS_REVIEW,
} from "$lib/shared/artifacts/canvas-review";
import {
	type DocumentReviewMetadata,
	readDocumentReviewMetadata,
} from "./document-ops";
import {
	kindForArtifactRow,
	parseArtifactMetadata,
	readScopedArtifactRow,
} from "./record";
import type { ArtifactScopeOptions } from "./types";

export type CanvasReviewFailure = "not_found" | "not_a_canvas";

type ArtifactTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function toReviewVersion(row: {
	id: string;
	versionNumber: number;
	author: string;
	summary: string;
	body: string;
}): CanvasReviewVersion {
	return {
		id: row.id,
		versionNumber: row.versionNumber,
		author:
			row.author === "alfy" || row.author === "system" ? row.author : "user",
		summary: row.summary,
		body: row.body,
	};
}

/** The marker's own version and everything after it: all the review reads. */
function readVersionsFrom(
	source: ArtifactTransaction | typeof db,
	artifactId: string,
	throughVersion: number,
): CanvasReviewVersion[] {
	return source
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
				eq(artifactVersions.artifactId, artifactId),
				gte(artifactVersions.versionNumber, throughVersion),
			),
		)
		.orderBy(asc(artifactVersions.versionNumber))
		.all()
		.map(toReviewVersion);
}

async function readScopedBoardRow(
	params: { userId: string; artifactId: string } & ArtifactScopeOptions,
): Promise<
	| { ok: true; id: string; metadataJson: string | null }
	| { ok: false; reason: CanvasReviewFailure }
> {
	const row = await readScopedArtifactRow(params);
	if (!row) return { ok: false, reason: "not_found" };
	if (kindForArtifactRow(row) !== "canvas") {
		return { ok: false, reason: "not_a_canvas" };
	}
	return { ok: true, id: row.id, metadataJson: row.metadataJson };
}

/**
 * Read-only: the review state recomputed from what is saved, so it is the truth
 * after any number of reloads and any other tab's Keep. A board Alfy never
 * edited has no marker and answers "nothing" (the read model tells it apart
 * from "reviewed" by leaving it out of its counts).
 */
export async function getCanvasReviewState(
	params: { userId: string; artifactId: string } & ArtifactScopeOptions,
): Promise<
	| { ok: true; review: CanvasReviewState }
	| { ok: false; reason: CanvasReviewFailure }
> {
	const scoped = await readScopedBoardRow(params);
	if (!scoped.ok) return scoped;
	const marker = readDocumentReviewMetadata(
		parseArtifactMetadata(scoped.metadataJson),
	);
	if (!marker) return { ok: true, review: EMPTY_CANVAS_REVIEW };
	return {
		ok: true,
		review: computeCanvasReview({
			throughVersion: marker.throughVersion,
			versions: readVersionsFrom(db, scoped.id, marker.throughVersion),
		}),
	};
}

/**
 * Keep: the marker moves to the newest version of Alfy's that is no newer than
 * `throughVersion` (the newest one the reader was shown, so a change that lands
 * while they decide is not swallowed). Never onto a reader's version, never
 * backwards. Answers the recomputed state.
 */
export async function acknowledgeCanvasReview(
	params: {
		userId: string;
		artifactId: string;
		throughVersion: number;
	} & ArtifactScopeOptions,
): Promise<
	| { ok: true; review: CanvasReviewState }
	| { ok: false; reason: CanvasReviewFailure }
> {
	const scoped = await readScopedBoardRow(params);
	if (!scoped.ok) return scoped;

	return db.transaction((tx) => {
		const current = tx
			.select({ metadataJson: artifacts.metadataJson })
			.from(artifacts)
			.where(eq(artifacts.id, scoped.id))
			.get();
		if (!current) return { ok: false as const, reason: "not_found" as const };
		const marker = readDocumentReviewMetadata(
			parseArtifactMetadata(current.metadataJson),
		);
		if (!marker) return { ok: true as const, review: EMPTY_CANVAS_REVIEW };

		let versions = readVersionsFrom(tx, scoped.id, marker.throughVersion);
		let nextThrough = marker.throughVersion;
		for (const version of versions) {
			if (
				version.author === "alfy" &&
				version.versionNumber <= params.throughVersion &&
				version.versionNumber > nextThrough
			) {
				nextThrough = version.versionNumber;
			}
		}
		if (nextThrough !== marker.throughVersion) {
			tx.update(artifacts)
				.set({
					// Not an edit of the board: `updatedAt` stays what the last change made it.
					metadataJson: JSON.stringify({
						...(parseJsonRecord(current.metadataJson) ?? {}),
						review: {
							throughVersion: nextThrough,
							keptBlockIds: [],
						} satisfies DocumentReviewMetadata,
					}),
				})
				.where(eq(artifacts.id, scoped.id))
				.run();
			versions = versions.filter(
				(version) => version.versionNumber >= nextThrough,
			);
		}
		return {
			ok: true as const,
			review: computeCanvasReview({ throughVersion: nextThrough, versions }),
		};
	});
}

/**
 * The bulk counterpart for the chat's card, the list row and the count button
 * (`read-model.ts`): one number per board, from the same computation, so the
 * three cannot disagree with the panel. Takes rows the caller already fetched
 * inside its own ownership scope, and reads the versions of a board with a
 * marker only, from the marker on. A board with no marker gets no entry: "never
 * edited by Alfy" is distinct from `0`, "reviewed".
 */
export async function computeCanvasPendingReviewCounts(
	rows: readonly { id: string; metadataJson: string | null }[],
): Promise<Map<string, number>> {
	const throughById = new Map<string, number>();
	for (const row of rows) {
		const marker = readDocumentReviewMetadata(
			parseArtifactMetadata(row.metadataJson),
		);
		if (marker) throughById.set(row.id, marker.throughVersion);
	}
	if (throughById.size === 0) return new Map();

	const versionRows = db
		.select({
			id: artifactVersions.id,
			artifactId: artifactVersions.artifactId,
			versionNumber: artifactVersions.versionNumber,
			author: artifactVersions.author,
			summary: artifactVersions.summary,
			body: artifactVersions.body,
		})
		.from(artifactVersions)
		.where(
			or(
				...[...throughById].map(([id, through]) =>
					and(
						eq(artifactVersions.artifactId, id),
						gte(artifactVersions.versionNumber, through),
					),
				),
			),
		)
		.orderBy(asc(artifactVersions.versionNumber))
		.all();

	const versionsById = new Map<string, CanvasReviewVersion[]>();
	for (const row of versionRows) {
		const list = versionsById.get(row.artifactId) ?? [];
		list.push(toReviewVersion(row));
		versionsById.set(row.artifactId, list);
	}
	const counts = new Map<string, number>();
	for (const [id, through] of throughById) {
		counts.set(
			id,
			computeCanvasReview({
				throughVersion: through,
				versions: versionsById.get(id) ?? [],
			}).count,
		);
	}
	return counts;
}
