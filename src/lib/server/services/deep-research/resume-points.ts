import { randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { deepResearchResumePoints } from "$lib/server/db/schema";
import type {
	DeepResearchResumePoint,
	DeepResearchResumePointBoundary,
	DeepResearchResumePointStatus,
} from "$lib/types";

type DeepResearchResumePointRow = typeof deepResearchResumePoints.$inferSelect;

export type UpsertResearchResumePointInput = {
	userId: string;
	jobId: string;
	conversationId: string;
	boundary: DeepResearchResumePointBoundary;
	resumeKey: string;
	stage: string;
	passNumber?: number | null;
	taskId?: string | null;
	payload?: Record<string, unknown> | null;
	now?: Date;
	expiresAt?: Date | null;
};

export type CompleteResearchResumePointInput = {
	userId: string;
	jobId: string;
	resumeKey: string;
	status?: Extract<DeepResearchResumePointStatus, "completed" | "failed">;
	result?: Record<string, unknown> | null;
	now?: Date;
};

export type ListResearchResumePointsInput = {
	userId: string;
	jobId: string;
};

export type GetResearchResumePointInput = {
	userId: string;
	jobId: string;
	resumeKey: string;
};

export async function upsertResearchResumePoint(
	input: UpsertResearchResumePointInput,
): Promise<DeepResearchResumePoint> {
	const { db } = await import("$lib/server/db");
	const now = input.now ?? new Date();
	const [existing] = await db
		.select()
		.from(deepResearchResumePoints)
		.where(
			and(
				eq(deepResearchResumePoints.userId, input.userId),
				eq(deepResearchResumePoints.jobId, input.jobId),
				eq(deepResearchResumePoints.resumeKey, input.resumeKey),
			),
		)
		.limit(1);

	if (existing) {
		if (existing.status === "completed")
			return mapResearchResumePointRow(existing);
		const [row] = await db
			.update(deepResearchResumePoints)
			.set({
				boundary: input.boundary,
				stage: input.stage,
				passNumber: input.passNumber ?? null,
				taskId: input.taskId ?? null,
				payloadJson: stringifyOptionalJson(input.payload),
				status: existing.status === "failed" ? "running" : existing.status,
				expiresAt: input.expiresAt ?? null,
				updatedAt: now,
			})
			.where(eq(deepResearchResumePoints.id, existing.id))
			.returning();
		return mapResearchResumePointRow(row);
	}

	const [row] = await db
		.insert(deepResearchResumePoints)
		.values({
			id: randomUUID(),
			jobId: input.jobId,
			conversationId: input.conversationId,
			userId: input.userId,
			boundary: input.boundary,
			resumeKey: input.resumeKey,
			status: "running",
			stage: input.stage,
			passNumber: input.passNumber ?? null,
			taskId: input.taskId ?? null,
			payloadJson: stringifyOptionalJson(input.payload),
			resultJson: null,
			startedAt: now,
			expiresAt: input.expiresAt ?? null,
			createdAt: now,
			updatedAt: now,
		})
		.returning();

	return mapResearchResumePointRow(row);
}

export async function completeResearchResumePoint(
	input: CompleteResearchResumePointInput,
): Promise<DeepResearchResumePoint | null> {
	const { db } = await import("$lib/server/db");
	const now = input.now ?? new Date();
	const [row] = await db
		.update(deepResearchResumePoints)
		.set({
			status: input.status ?? "completed",
			resultJson: stringifyOptionalJson(input.result),
			completedAt: now,
			updatedAt: now,
		})
		.where(
			and(
				eq(deepResearchResumePoints.userId, input.userId),
				eq(deepResearchResumePoints.jobId, input.jobId),
				eq(deepResearchResumePoints.resumeKey, input.resumeKey),
			),
		)
		.returning();

	return row ? mapResearchResumePointRow(row) : null;
}

export async function getResearchResumePoint(
	input: GetResearchResumePointInput,
): Promise<DeepResearchResumePoint | null> {
	const { db } = await import("$lib/server/db");
	const [row] = await db
		.select()
		.from(deepResearchResumePoints)
		.where(
			and(
				eq(deepResearchResumePoints.userId, input.userId),
				eq(deepResearchResumePoints.jobId, input.jobId),
				eq(deepResearchResumePoints.resumeKey, input.resumeKey),
			),
		)
		.limit(1);
	return row ? mapResearchResumePointRow(row) : null;
}

export async function getLatestValidResearchResumePoint(input: {
	userId: string;
	jobId: string;
}): Promise<DeepResearchResumePoint | null> {
	const { db } = await import("$lib/server/db");
	const [row] = await db
		.select()
		.from(deepResearchResumePoints)
		.where(
			and(
				eq(deepResearchResumePoints.userId, input.userId),
				eq(deepResearchResumePoints.jobId, input.jobId),
			),
		)
		.orderBy(
			desc(deepResearchResumePoints.updatedAt),
			desc(deepResearchResumePoints.startedAt),
		)
		.limit(1);
	return row ? mapResearchResumePointRow(row) : null;
}

export async function listResearchResumePoints(
	input: ListResearchResumePointsInput,
): Promise<DeepResearchResumePoint[]> {
	const { db } = await import("$lib/server/db");
	const rows = await db
		.select()
		.from(deepResearchResumePoints)
		.where(
			and(
				eq(deepResearchResumePoints.userId, input.userId),
				eq(deepResearchResumePoints.jobId, input.jobId),
			),
		)
		.orderBy(
			asc(deepResearchResumePoints.startedAt),
			asc(deepResearchResumePoints.resumeKey),
		);
	return rows.map(mapResearchResumePointRow);
}

function mapResearchResumePointRow(
	row: DeepResearchResumePointRow,
): DeepResearchResumePoint {
	return {
		id: row.id,
		jobId: row.jobId,
		conversationId: row.conversationId,
		userId: row.userId,
		boundary: row.boundary as DeepResearchResumePointBoundary,
		resumeKey: row.resumeKey,
		status: row.status as DeepResearchResumePointStatus,
		stage: row.stage,
		passNumber: row.passNumber,
		taskId: row.taskId,
		payload: parseOptionalJson<Record<string, unknown>>(row.payloadJson),
		result: parseOptionalJson<Record<string, unknown>>(row.resultJson),
		startedAt: row.startedAt.toISOString(),
		completedAt: row.completedAt?.toISOString() ?? null,
		expiresAt: row.expiresAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

function stringifyOptionalJson(
	value: Record<string, unknown> | null | undefined,
) {
	return value ? JSON.stringify(value) : null;
}

function parseOptionalJson<T>(value: string | null): T | null {
	if (!value) return null;
	return JSON.parse(value) as T;
}
