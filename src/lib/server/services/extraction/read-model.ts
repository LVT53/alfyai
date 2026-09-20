// The read path every client surface shares: composer, landing page, Knowledge
// list and the send gate all render the same DTO from the same rows.
//
// This module writes nothing. That is not an accident of the current
// implementation but the point of it: the equivalent file-production read model
// materialises rows for legacy chat files because it is bounded by one
// conversation's files, while the artifact table is unbounded per user and has
// no anchor to bound a sweep. A pre-ledger document therefore gets a
// synthesised DTO for display, and a real row only when the user presses Retry.
//
// It also deliberately does not import the knowledge store: `store/documents.ts`
// pulls in today's extraction client, and a poll endpoint that only reads rows
// must not drag a backend HTTP client into the request path. The two queries it
// needs are spelled out here instead.

import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	artifactLinks,
	artifacts,
	documentExtractionJobs,
} from "$lib/server/db/schema";
import type {
	DocumentExtractionJobDTO,
	DocumentExtractionStatus,
	ExtractionErrorCode,
} from "$lib/shared/extraction-status";
import {
	isExtractionErrorCode,
	isTerminalExtractionStatus,
	legacyExtractionJobId,
} from "$lib/shared/extraction-status";
import { getExtractionConfig } from "./config";
import type { DocumentExtractionJobRow } from "./types";

/**
 * Grace window before a job-less, normalized-less artifact is called `failed`.
 * Inside it, an enqueue is probably still in flight in another request and
 * calling the document broken would be a lie the user then has to un-believe.
 */
export const LEGACY_EXTRACTION_GRACE_MS = 5 * 60 * 1000;

const LEGACY_UNKNOWN_MESSAGE =
	"This document predates the extraction ledger, so its result is unknown.";

export function mapExtractionJobRow(
	row: DocumentExtractionJobRow,
	maxAttempts: number,
): DocumentExtractionJobDTO {
	const status = row.status as DocumentExtractionStatus;
	const terminal = isTerminalExtractionStatus(status);
	const code: ExtractionErrorCode | null = isExtractionErrorCode(row.errorCode)
		? row.errorCode
		: row.errorCode
			? "internal"
			: null;

	return {
		id: row.id,
		sourceArtifactId: row.sourceArtifactId,
		normalizedArtifactId: row.normalizedArtifactId,
		status,
		intakeRoute: row.intakeRoute === "direct-text" ? "direct-text" : "mineru",
		fileName: row.fileName,
		attemptCount: row.attemptCount,
		maxAttempts,
		// `canceled` is always retryable: the ledger has allowed a retry from it
		// since T15, and reporting otherwise meant a user who hit Stop by mistake
		// had no way back except deleting the document and uploading it again.
		// A `failed` job still has to say so on the row — plenty of failures
		// (`empty_result`, `too_large`) cannot be helped by trying once more.
		retryable:
			status === "canceled" || (status === "failed" && Boolean(row.retryable)),
		cancelable: !terminal && row.cancelRequestedAt === null,
		error: code ? { code, message: row.errorMessage ?? "" } : null,
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
		startedAt: row.startedAt ? row.startedAt.getTime() : null,
		legacy: false,
	};
}

interface LegacyArtifactRow {
	id: string;
	name: string;
	createdAt: Date;
	updatedAt: Date;
}

function synthesizeLegacyDTO(params: {
	artifact: LegacyArtifactRow;
	normalized: { id: string; createdAt: Date; updatedAt: Date } | null;
	maxAttempts: number;
	now: Date;
}): DocumentExtractionJobDTO {
	const base = {
		id: legacyExtractionJobId(params.artifact.id),
		sourceArtifactId: params.artifact.id,
		fileName: params.artifact.name,
		intakeRoute: "mineru" as const,
		attemptCount: 0,
		maxAttempts: params.maxAttempts,
		cancelable: false,
		legacy: true,
		startedAt: null,
	};

	if (params.normalized) {
		return {
			...base,
			normalizedArtifactId: params.normalized.id,
			status: "succeeded",
			retryable: false,
			error: null,
			createdAt: params.normalized.createdAt.getTime(),
			updatedAt: params.normalized.updatedAt.getTime(),
		};
	}

	const inGrace =
		params.artifact.createdAt.getTime() >
		params.now.getTime() - LEGACY_EXTRACTION_GRACE_MS;

	if (inGrace) {
		// An enqueue is probably in flight in another request. Saying "queued" and
		// being wrong for five minutes is cheaper than saying "failed" and being
		// wrong for one second.
		return {
			...base,
			normalizedArtifactId: null,
			status: "queued",
			retryable: false,
			error: null,
			createdAt: params.artifact.createdAt.getTime(),
			updatedAt: params.artifact.updatedAt.getTime(),
		};
	}

	return {
		...base,
		normalizedArtifactId: null,
		status: "failed",
		retryable: true,
		error: { code: "legacy_unknown", message: LEGACY_UNKNOWN_MESSAGE },
		createdAt: params.artifact.createdAt.getTime(),
		updatedAt: params.artifact.updatedAt.getTime(),
	};
}

export interface GetExtractionJobsForArtifactsInput {
	userId: string;
	artifactIds: string[];
	now?: Date;
}

/**
 * Batch read for the poll endpoint. One entry per resolvable, owned id;
 * unknown or unowned ids are omitted rather than faked, so a client cannot
 * learn that another user's artifact exists by polling for it.
 */
export async function getExtractionJobsForArtifacts(
	input: GetExtractionJobsForArtifactsInput,
): Promise<DocumentExtractionJobDTO[]> {
	const ids = Array.from(new Set(input.artifactIds.filter(Boolean)));
	if (ids.length === 0) return [];

	const now = input.now ?? new Date();
	const maxAttempts = getExtractionConfig().maxAttempts;

	const rows = await db
		.select()
		.from(documentExtractionJobs)
		.where(
			and(
				eq(documentExtractionJobs.userId, input.userId),
				inArray(documentExtractionJobs.sourceArtifactId, ids),
			),
		);

	const byArtifactId = new Map<string, DocumentExtractionJobDTO>();
	for (const row of rows) {
		if (row.sourceArtifactId) {
			byArtifactId.set(
				row.sourceArtifactId,
				mapExtractionJobRow(row, maxAttempts),
			);
		}
	}

	const missing = ids.filter((id) => !byArtifactId.has(id));
	if (missing.length > 0) {
		const legacyArtifacts = await db
			.select({
				id: artifacts.id,
				name: artifacts.name,
				createdAt: artifacts.createdAt,
				updatedAt: artifacts.updatedAt,
			})
			.from(artifacts)
			.where(
				and(
					eq(artifacts.userId, input.userId),
					eq(artifacts.type, "source_document"),
					inArray(artifacts.id, missing),
				),
			);

		const normalizedBySource = await getNormalizedArtifactsForSources(
			input.userId,
			legacyArtifacts.map((artifact) => artifact.id),
		);

		for (const artifact of legacyArtifacts) {
			byArtifactId.set(
				artifact.id,
				synthesizeLegacyDTO({
					artifact,
					normalized: normalizedBySource.get(artifact.id) ?? null,
					maxAttempts,
					now,
				}),
			);
		}
	}

	// Preserve the caller's order; a poller that diffs by index should not see
	// rows shuffle because SQLite chose a different scan order.
	return ids
		.map((id) => byArtifactId.get(id))
		.filter((dto): dto is DocumentExtractionJobDTO => dto !== undefined);
}

async function getNormalizedArtifactsForSources(
	userId: string,
	sourceArtifactIds: string[],
): Promise<Map<string, { id: string; createdAt: Date; updatedAt: Date }>> {
	const result = new Map<
		string,
		{ id: string; createdAt: Date; updatedAt: Date }
	>();
	if (sourceArtifactIds.length === 0) return result;

	const rows = await db
		.select({
			sourceArtifactId: artifactLinks.relatedArtifactId,
			id: artifacts.id,
			createdAt: artifacts.createdAt,
			updatedAt: artifacts.updatedAt,
		})
		.from(artifactLinks)
		.innerJoin(artifacts, eq(artifactLinks.artifactId, artifacts.id))
		.where(
			and(
				eq(artifactLinks.userId, userId),
				inArray(artifactLinks.relatedArtifactId, sourceArtifactIds),
				eq(artifactLinks.linkType, "derived_from"),
				eq(artifacts.type, "normalized_document"),
			),
		)
		.orderBy(asc(artifactLinks.createdAt));

	for (const row of rows) {
		if (!row.sourceArtifactId || result.has(row.sourceArtifactId)) continue;
		result.set(row.sourceArtifactId, {
			id: row.id,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		});
	}

	return result;
}

export async function getExtractionJobForArtifact(input: {
	userId: string;
	artifactId: string;
	now?: Date;
}): Promise<DocumentExtractionJobDTO | null> {
	const [dto] = await getExtractionJobsForArtifacts({
		userId: input.userId,
		artifactIds: [input.artifactId],
		now: input.now,
	});
	return dto ?? null;
}

export async function getExtractionJobById(input: {
	userId: string;
	jobId: string;
}): Promise<DocumentExtractionJobDTO | null> {
	const [row] = await db
		.select()
		.from(documentExtractionJobs)
		.where(
			and(
				eq(documentExtractionJobs.id, input.jobId),
				eq(documentExtractionJobs.userId, input.userId),
			),
		)
		.limit(1);

	return row
		? mapExtractionJobRow(row, getExtractionConfig().maxAttempts)
		: null;
}
