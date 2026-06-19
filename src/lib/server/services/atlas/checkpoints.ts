import { randomUUID } from "node:crypto";
import { asc, desc, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { atlasJobs, atlasRoundCheckpoints } from "$lib/server/db/schema";
import type {
	AtlasAction,
	AtlasDocumentFamilyMetadata,
	AtlasLifecycleContext,
	AtlasLifecycleSeed,
} from "./types";

export interface AtlasRoundCheckpointInput {
	jobId: string;
	roundNumber: number;
	stage: string;
	checkpoint: unknown;
	curatedSourcePool?: unknown;
	compressedFindings?: unknown;
	usage?: unknown;
	qualityDiagnostics?: unknown;
	documentSourceSummary?: unknown;
	now?: Date;
}

export interface AtlasRoundCheckpoint {
	jobId: string;
	roundNumber: number;
	stage: string;
	checkpoint: unknown;
	curatedSourcePool: unknown;
	compressedFindings: unknown;
	usage: unknown;
	qualityDiagnostics: unknown;
	documentSourceSummary: unknown;
}

function parseJsonField(value: string, fallback: unknown): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return fallback;
	}
}

function mapAtlasRoundCheckpointRow(
	row: typeof atlasRoundCheckpoints.$inferSelect,
): AtlasRoundCheckpoint {
	return {
		jobId: row.jobId,
		roundNumber: row.roundNumber,
		stage: row.stage,
		checkpoint: parseJsonField(row.checkpointJson, {}),
		curatedSourcePool: parseJsonField(row.curatedSourcePoolJson, []),
		compressedFindings: parseJsonField(row.compressedFindingsJson, {}),
		usage: parseJsonField(row.usageJson, {}),
		qualityDiagnostics: parseJsonField(row.qualityDiagnosticsJson, {}),
		documentSourceSummary: parseJsonField(row.documentSourceSummaryJson, {}),
	};
}

export async function writeAtlasRoundCheckpoint(
	input: AtlasRoundCheckpointInput,
): Promise<void> {
	const now = input.now ?? new Date();
	await db
		.insert(atlasRoundCheckpoints)
		.values({
			id: randomUUID(),
			jobId: input.jobId,
			roundNumber: input.roundNumber,
			checkpointVersion: 1,
			stage: input.stage,
			checkpointJson: JSON.stringify(input.checkpoint ?? {}),
			curatedSourcePoolJson: JSON.stringify(input.curatedSourcePool ?? []),
			compressedFindingsJson: JSON.stringify(input.compressedFindings ?? {}),
			usageJson: JSON.stringify(input.usage ?? {}),
			qualityDiagnosticsJson: JSON.stringify(input.qualityDiagnostics ?? {}),
			documentSourceSummaryJson: JSON.stringify(
				input.documentSourceSummary ?? {},
			),
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [atlasRoundCheckpoints.jobId, atlasRoundCheckpoints.roundNumber],
			set: {
				stage: input.stage,
				checkpointJson: JSON.stringify(input.checkpoint ?? {}),
				curatedSourcePoolJson: JSON.stringify(input.curatedSourcePool ?? []),
				compressedFindingsJson: JSON.stringify(input.compressedFindings ?? {}),
				usageJson: JSON.stringify(input.usage ?? {}),
				qualityDiagnosticsJson: JSON.stringify(input.qualityDiagnostics ?? {}),
				documentSourceSummaryJson: JSON.stringify(
					input.documentSourceSummary ?? {},
				),
				updatedAt: now,
			},
		});
}

export async function listAtlasRoundCheckpoints(
	jobId: string,
): Promise<AtlasRoundCheckpoint[]> {
	const rows = await db
		.select()
		.from(atlasRoundCheckpoints)
		.where(eq(atlasRoundCheckpoints.jobId, jobId))
		.orderBy(asc(atlasRoundCheckpoints.roundNumber));
	return rows.map(mapAtlasRoundCheckpointRow);
}

export async function getLatestAtlasRoundCheckpoint(
	jobId: string,
): Promise<AtlasRoundCheckpoint | null> {
	const [row] = await db
		.select()
		.from(atlasRoundCheckpoints)
		.where(eq(atlasRoundCheckpoints.jobId, jobId))
		.orderBy(desc(atlasRoundCheckpoints.roundNumber))
		.limit(1);
	return row ? mapAtlasRoundCheckpointRow(row) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readFamilyMetadata(
	value: unknown,
): Partial<AtlasDocumentFamilyMetadata> {
	if (!isRecord(value)) return {};
	const family = isRecord(value.atlasFamily) ? value.atlasFamily : value;
	return {
		familyId: typeof family.familyId === "string" ? family.familyId : undefined,
		mode:
			family.mode === "new_family" || family.mode === "same_family"
				? family.mode
				: undefined,
		action:
			family.action === "create" ||
			family.action === "continue" ||
			family.action === "fork" ||
			family.action === "revise"
				? family.action
				: undefined,
		rootAtlasJobId:
			typeof family.rootAtlasJobId === "string"
				? family.rootAtlasJobId
				: undefined,
		currentAtlasJobId:
			typeof family.currentAtlasJobId === "string"
				? family.currentAtlasJobId
				: undefined,
		parentAtlasJobId:
			typeof family.parentAtlasJobId === "string"
				? family.parentAtlasJobId
				: null,
		forkedFromAtlasJobId:
			typeof family.forkedFromAtlasJobId === "string"
				? family.forkedFromAtlasJobId
				: null,
	};
}

export async function buildAtlasLifecycleContext(input: {
	jobId: string;
	userId: string;
	action: AtlasAction;
	parentAtlasJobId: string | null;
}): Promise<AtlasLifecycleContext> {
	const parent =
		input.parentAtlasJobId && input.action !== "create"
			? await loadParentLifecycleSeed({
					userId: input.userId,
					parentAtlasJobId: input.parentAtlasJobId,
					includeCuratedSourcePool:
						input.action === "continue" || input.action === "revise",
				})
			: null;
	const parentFamily = parent
		? readFamilyMetadata(parent.documentSourceSummary)
		: {};
	const sameFamily =
		parent !== null &&
		(input.action === "continue" || input.action === "revise");
	const familyId = sameFamily
		? parentFamily.familyId || input.parentAtlasJobId || input.jobId
		: input.jobId;
	const rootAtlasJobId = sameFamily
		? parentFamily.rootAtlasJobId || input.parentAtlasJobId || input.jobId
		: input.jobId;

	return {
		family: {
			familyId,
			mode: sameFamily ? "same_family" : "new_family",
			action: input.action,
			rootAtlasJobId,
			currentAtlasJobId: input.jobId,
			parentAtlasJobId: input.parentAtlasJobId,
			forkedFromAtlasJobId:
				input.action === "fork" ? input.parentAtlasJobId : null,
		},
		seed: parent,
	};
}

async function loadParentLifecycleSeed(input: {
	userId: string;
	parentAtlasJobId: string;
	includeCuratedSourcePool: boolean;
}): Promise<AtlasLifecycleSeed | null> {
	const [parentJob] = await db
		.select({ id: atlasJobs.id, userId: atlasJobs.userId })
		.from(atlasJobs)
		.where(eq(atlasJobs.id, input.parentAtlasJobId))
		.limit(1);
	if (!parentJob || parentJob.userId !== input.userId) {
		return null;
	}
	const checkpoint = await getLatestAtlasRoundCheckpoint(
		input.parentAtlasJobId,
	);
	if (!checkpoint) {
		return null;
	}
	return {
		parentAtlasJobId: input.parentAtlasJobId,
		compressedFindings: checkpoint.compressedFindings,
		curatedSourcePool: input.includeCuratedSourcePool
			? checkpoint.curatedSourcePool
			: null,
		checkpoint: checkpoint.checkpoint,
		documentSourceSummary: checkpoint.documentSourceSummary,
	};
}
