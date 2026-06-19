import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { memoryReworkTelemetry } from "$lib/server/db/schema";
import { parseJsonRecord } from "./internal-json";
import {
	assertExpectedMemoryResetGeneration,
	getCurrentMemoryResetGeneration,
} from "./reset-generation";
import {
	assertMemoryProfileCategory,
	assertOneOf,
	assertPrivacySafeMetadata,
	type JsonRecord,
	MEMORY_REWORK_TELEMETRY_FAMILIES,
	type MemoryProfileCategory,
	type MemoryReworkTelemetryFamily,
} from "./types";

export async function recordMemoryReworkTelemetry(params: {
	userId: string;
	eventFamily: MemoryReworkTelemetryFamily;
	eventName: string;
	category?: MemoryProfileCategory;
	reason?: string;
	status?: string;
	count?: number;
	durationMs?: number;
	subjectId?: string;
	metadata?: JsonRecord;
	expectedResetGeneration?: number;
}): Promise<{ id: string }> {
	assertOneOf(
		params.eventFamily,
		MEMORY_REWORK_TELEMETRY_FAMILIES,
		"memory telemetry family",
	);
	if (params.category) {
		assertMemoryProfileCategory(params.category);
	}
	assertPrivacySafeMetadata(params.metadata);
	const resetGeneration = await assertExpectedMemoryResetGeneration({
		userId: params.userId,
		expectedResetGeneration: params.expectedResetGeneration,
	});
	const id = randomUUID();
	await db
		.insert(memoryReworkTelemetry)
		.values({
			id,
			userId: params.userId,
			resetGeneration,
			eventFamily: params.eventFamily,
			eventName: params.eventName,
			category: params.category,
			reason: params.reason,
			status: params.status,
			count: params.count,
			durationMs: params.durationMs,
			subjectId: params.subjectId,
			metadataJson: JSON.stringify(params.metadata ?? {}),
			createdAt: new Date(),
		})
		.run();
	return { id };
}

export async function listMemoryReworkTelemetry(params: {
	userId: string;
}): Promise<
	Array<{
		id: string;
		eventFamily: MemoryReworkTelemetryFamily;
		eventName: string;
		category: MemoryProfileCategory | null;
		reason: string | null;
		status: string | null;
		count: number | null;
		durationMs: number | null;
		subjectId: string | null;
		metadata: JsonRecord;
	}>
> {
	const resetGeneration = await getCurrentMemoryResetGeneration(params.userId);
	const rows = await db
		.select()
		.from(memoryReworkTelemetry)
		.where(
			and(
				eq(memoryReworkTelemetry.userId, params.userId),
				eq(memoryReworkTelemetry.resetGeneration, resetGeneration),
			),
		)
		.orderBy(asc(memoryReworkTelemetry.createdAt));

	return rows.map((row) => {
		assertOneOf(
			row.eventFamily,
			MEMORY_REWORK_TELEMETRY_FAMILIES,
			"memory telemetry family",
		);
		let category: MemoryProfileCategory | null = null;
		if (row.category) {
			assertMemoryProfileCategory(row.category);
			category = row.category;
		}
		return {
			id: row.id,
			eventFamily: row.eventFamily,
			eventName: row.eventName,
			category,
			reason: row.reason,
			status: row.status,
			count: row.count,
			durationMs: row.durationMs,
			subjectId: row.subjectId,
			metadata: parseJsonRecord(row.metadataJson),
		};
	});
}
