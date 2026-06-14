import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "$lib/server/db";
import { semanticEmbeddings } from "$lib/server/db/schema";
import type {
	SemanticEmbedding,
	SemanticEmbeddingSubjectType,
} from "$lib/types";

export interface SemanticEmbeddingInput {
	userId: string;
	subjectType: SemanticEmbeddingSubjectType;
	subjectId: string;
	modelName: string;
	sourceText: string;
	embedding: number[];
}

function normalizeEmbedding(values: number[]): number[] {
	return values.filter((value) => Number.isFinite(value));
}

function mapSemanticEmbeddingRow(
	row: typeof semanticEmbeddings.$inferSelect,
): SemanticEmbedding {
	const parsed = JSON.parse(row.embeddingJson) as unknown;
	const embedding = Array.isArray(parsed)
		? parsed.filter((value): value is number => typeof value === "number")
		: [];

	return {
		id: row.id,
		userId: row.userId,
		subjectType: row.subjectType as SemanticEmbeddingSubjectType,
		subjectId: row.subjectId,
		modelName: row.modelName,
		sourceTextHash: row.sourceTextHash,
		dimensions: row.dimensions,
		embedding,
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
	};
}

export function hashEmbeddingSourceText(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return createHash("sha256").update(normalized).digest("hex");
}

export async function upsertSemanticEmbedding(
	params: SemanticEmbeddingInput,
): Promise<void> {
	const embedding = normalizeEmbedding(params.embedding);
	const now = new Date();

	await db
		.insert(semanticEmbeddings)
		.values({
			id: randomUUID(),
			userId: params.userId,
			subjectType: params.subjectType,
			subjectId: params.subjectId,
			modelName: params.modelName,
			sourceTextHash: hashEmbeddingSourceText(params.sourceText),
			dimensions: embedding.length,
			embeddingJson: JSON.stringify(embedding),
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [
				semanticEmbeddings.userId,
				semanticEmbeddings.subjectType,
				semanticEmbeddings.subjectId,
				semanticEmbeddings.modelName,
			],
			set: {
				sourceTextHash: hashEmbeddingSourceText(params.sourceText),
				dimensions: embedding.length,
				embeddingJson: JSON.stringify(embedding),
				updatedAt: now,
			},
		});
}

export async function getSemanticEmbedding(params: {
	userId: string;
	subjectType: SemanticEmbeddingSubjectType;
	subjectId: string;
	modelName: string;
}): Promise<SemanticEmbedding | null> {
	const rows = await db
		.select()
		.from(semanticEmbeddings)
		.where(
			and(
				eq(semanticEmbeddings.userId, params.userId),
				eq(semanticEmbeddings.subjectType, params.subjectType),
				eq(semanticEmbeddings.subjectId, params.subjectId),
				eq(semanticEmbeddings.modelName, params.modelName),
			),
		)
		.orderBy(desc(semanticEmbeddings.updatedAt))
		.limit(1);

	return rows[0] ? mapSemanticEmbeddingRow(rows[0]) : null;
}

export async function listSemanticEmbeddingsBySubject(params: {
	userId: string;
	subjectType: SemanticEmbeddingSubjectType;
	subjectIds: string[];
	modelName?: string;
}): Promise<Map<string, SemanticEmbedding>> {
	if (params.subjectIds.length === 0) {
		return new Map();
	}

	const conditions = [
		eq(semanticEmbeddings.userId, params.userId),
		eq(semanticEmbeddings.subjectType, params.subjectType),
		inArray(semanticEmbeddings.subjectId, params.subjectIds),
	];

	if (params.modelName) {
		conditions.push(eq(semanticEmbeddings.modelName, params.modelName));
	}

	const rows = await db
		.select()
		.from(semanticEmbeddings)
		.where(and(...conditions))
		.orderBy(desc(semanticEmbeddings.updatedAt));

	const latestBySubject = new Map<string, SemanticEmbedding>();
	for (const row of rows) {
		if (latestBySubject.has(row.subjectId)) continue;
		latestBySubject.set(row.subjectId, mapSemanticEmbeddingRow(row));
	}

	return latestBySubject;
}

export async function deleteSemanticEmbeddingsForSubjects(params: {
	userId: string;
	subjectType?: SemanticEmbeddingSubjectType;
	subjectIds?: string[];
}): Promise<number> {
	const conditions = [eq(semanticEmbeddings.userId, params.userId)];

	if (params.subjectType) {
		conditions.push(eq(semanticEmbeddings.subjectType, params.subjectType));
	}

	if (params.subjectIds) {
		if (params.subjectIds.length === 0) return 0;
		conditions.push(inArray(semanticEmbeddings.subjectId, params.subjectIds));
	}

	const result = await db.delete(semanticEmbeddings).where(and(...conditions));
	return result.changes;
}

export function needsSemanticEmbeddingRefresh(params: {
	current: Pick<SemanticEmbedding, "sourceTextHash" | "dimensions"> | null;
	sourceText: string;
	embedding?: number[] | null;
}): boolean {
	const nextHash = hashEmbeddingSourceText(params.sourceText);
	const nextDimensions = normalizeEmbedding(params.embedding ?? []).length;

	if (!params.current) return true;
	if (params.current.sourceTextHash !== nextHash) return true;
	if (nextDimensions > 0 && params.current.dimensions !== nextDimensions)
		return true;
	return false;
}
