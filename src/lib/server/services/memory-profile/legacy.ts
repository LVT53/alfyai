import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	memoryProfileItemProvenance,
	memoryProfileItems,
	memoryProjectionState,
	memoryResetGenerations,
	memoryReworkTelemetry,
} from "$lib/server/db/schema";

type LegacyMigrationCategory =
	| "about_you"
	| "preferences"
	| "goals_ongoing_work"
	| "constraints_boundaries";

type LegacyMigrationClassification =
	| {
			decision: "activate";
			category: LegacyMigrationCategory;
			statement: string;
			sourceId: string;
	  }
	| {
			decision: "preserve";
			category: LegacyMigrationCategory;
			statement: string;
			sourceId: string;
	  }
	| { decision: "reject"; sourceId: string };

export type LegacyMemoryMigrationResult = {
	status: "completed" | "stale_generation" | "unavailable";
	inspected: number;
	active: number;
	preserved: number;
	rejected: number;
	totalAvailable: number;
};

export type LegacyPersonaMemoryCandidateBatch = {
	totalAvailable: number;
	nextPage?: number | null;
	exhausted?: boolean;
	candidates: Array<{
		id: string;
		content: string;
		scope: "self" | "assistant_about_user";
		sessionId: string | null;
		createdAt: number;
	}>;
};

const LEGACY_MIGRATION_DEFAULT_BATCH_SIZE = 5;
const LEGACY_MIGRATION_MAX_BATCH_SIZE = 5;
const ITEM_KEY_VERSION = "memory-profile-item:v1";

function cleanLegacyText(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function stripTerminalPunctuation(value: string): string {
	return cleanLegacyText(value)
		.replace(/[.!?]+$/g, "")
		.trim();
}

function lowerInitial(value: string): string {
	const text = stripTerminalPunctuation(value);
	if (!text) return "";
	return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

function sentence(value: string): string {
	const text = stripTerminalPunctuation(value);
	if (!text) return "";
	return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function stableDigest(value: string, length = 24): string {
	return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function legacyItemKey(params: {
	category: LegacyMigrationCategory;
	statement: string;
}): string {
	const normalizedStatement = params.statement
		.trim()
		.replace(/\s+/g, " ")
		.toLowerCase();
	const digest = stableDigest(
		[params.category, normalizedStatement].join("\u001f"),
		32,
	);
	return `${ITEM_KEY_VERSION}:${params.category}:global:global:${digest}`;
}

function looksLikeAssistantProse(text: string): boolean {
	return (
		/^(assistant|alfyai|chatgpt)\s*:/i.test(text) ||
		/\b(here is|here's|i can help|i will|as an ai)\b/i.test(text)
	);
}

function looksLikeRawDump(text: string): boolean {
	return (
		text.length > 320 ||
		(text.match(/[{}[\]|]/g)?.length ?? 0) >= 4 ||
		(text.match(/\n/g)?.length ?? 0) >= 2 ||
		/```|^\s*[{[]|"\w+"\s*:/i.test(text)
	);
}

function looksDocumentDerived(text: string): boolean {
	return /\b(uploaded|attached|document|file|pdf|receipt|invoice|statement|contract|source)\b/i.test(
		text,
	);
}

type LegacyClassificationWithoutSource =
	| Omit<
			Extract<LegacyMigrationClassification, { decision: "activate" }>,
			"sourceId"
	  >
	| Omit<
			Extract<LegacyMigrationClassification, { decision: "preserve" }>,
			"sourceId"
	  >;

function classifyHighConfidence(
	text: string,
): LegacyClassificationWithoutSource | null {
	const preference =
		/^(?:the\s+)?user prefers\s+(.+)$/i.exec(text) ??
		/^prefers\s+(.+)$/i.exec(text);
	if (preference?.[1]) {
		return {
			decision: "activate",
			category: "preferences",
			statement: sentence(`Prefers ${lowerInitial(preference[1])}`),
		};
	}

	const working =
		/^(?:the\s+)?user is working on\s+(.+)$/i.exec(text) ??
		/^working on\s+(.+)$/i.exec(text);
	if (working?.[1]) {
		return {
			decision: "preserve",
			category: "goals_ongoing_work",
			statement: sentence(`Working on ${lowerInitial(working[1])}`),
		};
	}

	const constraint =
		/^(?:the\s+)?user (?:does not|doesn't|doesnt) want\s+(.+)$/i.exec(text) ??
		/^(?:do not|don't|dont|never)\s+(.+)$/i.exec(text);
	if (constraint?.[1]) {
		return {
			decision: "activate",
			category: "constraints_boundaries",
			statement: sentence(`Do not ${lowerInitial(constraint[1])}`),
		};
	}

	const aboutYou =
		/^(?:the\s+)?user\s+((?:lives in|works as|uses|has|owns)\s+.+)$/i.exec(
			text,
		);
	if (aboutYou?.[1]) {
		return {
			decision: "activate",
			category: "about_you",
			statement: sentence(aboutYou[1]),
		};
	}

	return null;
}

function classifyLegacyCandidate(candidate: {
	id: string;
	content: string;
}): LegacyMigrationClassification {
	const text = cleanLegacyText(candidate.content);
	if (
		!text ||
		looksLikeAssistantProse(text) ||
		looksLikeRawDump(text) ||
		looksDocumentDerived(text)
	) {
		return { decision: "reject", sourceId: candidate.id };
	}

	const active = classifyHighConfidence(text);
	if (active) {
		return { ...active, sourceId: candidate.id };
	}

	if (
		text.length >= 12 &&
		/\b(user|prefers|likes|goal|working|might|maybe)\b/i.test(text)
	) {
		return {
			decision: "preserve",
			category: "about_you",
			statement: sentence(text),
			sourceId: candidate.id,
		};
	}

	return { decision: "reject", sourceId: candidate.id };
}

async function getCurrentResetGeneration(userId: string): Promise<number> {
	await db
		.insert(memoryResetGenerations)
		.values({
			userId,
			resetGeneration: 0,
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.onConflictDoNothing({ target: memoryResetGenerations.userId })
		.run();

	const [row] = await db
		.select({ resetGeneration: memoryResetGenerations.resetGeneration })
		.from(memoryResetGenerations)
		.where(eq(memoryResetGenerations.userId, userId))
		.limit(1);

	return row?.resetGeneration ?? 0;
}

function applyLegacyMigrationRows(params: {
	userId: string;
	resetGeneration: number;
	requestedLimit: number;
	totalAvailable: number;
	classifications: LegacyMigrationClassification[];
}): "completed" | "stale_generation" {
	const now = new Date();
	return db.transaction((tx) => {
		const [generation] = tx
			.select({ resetGeneration: memoryResetGenerations.resetGeneration })
			.from(memoryResetGenerations)
			.where(eq(memoryResetGenerations.userId, params.userId))
			.limit(1)
			.all();
		if (generation?.resetGeneration !== params.resetGeneration) {
			return "stale_generation" as const;
		}

		tx.insert(memoryProjectionState)
			.values({
				id: randomUUID(),
				userId: params.userId,
				resetGeneration: params.resetGeneration,
				scopeType: "global",
				scopeId: "",
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoNothing({
				target: [
					memoryProjectionState.userId,
					memoryProjectionState.resetGeneration,
					memoryProjectionState.scopeType,
					memoryProjectionState.scopeId,
				],
			})
			.run();

		const [projection] = tx
			.select()
			.from(memoryProjectionState)
			.where(
				and(
					eq(memoryProjectionState.userId, params.userId),
					eq(memoryProjectionState.resetGeneration, params.resetGeneration),
					eq(memoryProjectionState.scopeType, "global"),
					eq(memoryProjectionState.scopeId, ""),
				),
			)
			.limit(1)
			.all();
		if (!projection) {
			throw new Error("Memory projection state could not be initialized.");
		}

		let inserted = 0;
		for (const classification of params.classifications) {
			if (classification.decision === "reject") continue;
			const status =
				classification.decision === "activate" ? "active" : "preserved_legacy";
			const itemId = randomUUID();
			const insertResult = tx
				.insert(memoryProfileItems)
				.values({
					id: itemId,
					userId: params.userId,
					projectionStateId: projection.id,
					resetGeneration: params.resetGeneration,
					itemKey: legacyItemKey({
						category: classification.category,
						statement: classification.statement,
					}),
					category: classification.category,
					scopeType: "global",
					scopeId: "",
					statement: classification.statement,
					status,
					metadataJson: JSON.stringify({
						source: "legacy_migration",
						legacySourceToken: stableDigest(classification.sourceId),
						legacyDecision: classification.decision,
					}),
					createdAt: now,
					updatedAt: now,
				})
				.onConflictDoNothing({
					target: [
						memoryProfileItems.userId,
						memoryProfileItems.resetGeneration,
						memoryProfileItems.itemKey,
					],
				})
				.run() as { changes?: number };

			let provenanceItemId: string = itemId;
			if ((insertResult.changes ?? 0) === 1) {
				inserted += 1;
			} else {
				const [existing] = tx
					.select()
					.from(memoryProfileItems)
					.where(
						and(
							eq(memoryProfileItems.userId, params.userId),
							eq(memoryProfileItems.resetGeneration, params.resetGeneration),
							eq(
								memoryProfileItems.itemKey,
								legacyItemKey({
									category: classification.category,
									statement: classification.statement,
								}),
							),
						),
					)
					.limit(1)
					.all();
				if (!existing) continue;
				provenanceItemId = existing.id;
				if (status === "active" && existing.status === "preserved_legacy") {
					tx.update(memoryProfileItems)
						.set({
							status: "active",
							updatedAt: now,
						})
						.where(eq(memoryProfileItems.id, existing.id))
						.run();
					inserted += 1;
				}
			}
			tx.insert(memoryProfileItemProvenance)
				.values({
					id: randomUUID(),
					itemId: provenanceItemId,
					userId: params.userId,
					resetGeneration: params.resetGeneration,
					sourceType: "legacy_persona_memory",
					sourceId: classification.sourceId,
					label: "Legacy memory",
					summary:
						classification.decision === "activate"
							? "Migrated from a high-confidence legacy persona memory."
							: "Preserved for review from legacy persona memory.",
					metadataJson: JSON.stringify({
						source: "legacy_migration",
						legacySourceToken: stableDigest(classification.sourceId),
					}),
					createdAt: now,
				})
				.run();
		}

		if (inserted > 0) {
			tx.update(memoryProjectionState)
				.set({
					revision: sql`${memoryProjectionState.revision} + ${inserted}`,
					updatedAt: now,
				})
				.where(eq(memoryProjectionState.id, projection.id))
				.run();
		}

		const activeCount = params.classifications.filter(
			(item) => item.decision === "activate",
		).length;
		const preservedCount = params.classifications.filter(
			(item) => item.decision === "preserve",
		).length;
		const rejectedCount = params.classifications.filter(
			(item) => item.decision === "reject",
		).length;
		tx.insert(memoryReworkTelemetry)
			.values({
				id: randomUUID(),
				userId: params.userId,
				resetGeneration: params.resetGeneration,
				eventFamily: "maintenance",
				eventName: "legacy_migration_completed",
				reason: "legacy_migration",
				status: "completed",
				count: params.classifications.length,
				metadataJson: JSON.stringify({
					activeCount,
					inspectedCount: params.classifications.length,
					preservedCount,
					rejectedCount,
					requestedLimit: params.requestedLimit,
					totalAvailable: params.totalAvailable,
				}),
				createdAt: now,
			})
			.run();

		return "completed" as const;
	});
}

export async function migrateLegacyMemoryForUser(params: {
	userId: string;
	batchSize?: number;
	startedResetGeneration?: number;
	legacyBatch?: LegacyPersonaMemoryCandidateBatch;
}): Promise<LegacyMemoryMigrationResult> {
	const requestedLimit = Math.max(
		1,
		Math.min(
			LEGACY_MIGRATION_MAX_BATCH_SIZE,
			Math.floor(params.batchSize ?? LEGACY_MIGRATION_DEFAULT_BATCH_SIZE),
		),
	);
	const resetGeneration =
		params.startedResetGeneration ??
		(await getCurrentResetGeneration(params.userId));
	const legacyBatch = params.legacyBatch;

	if (!legacyBatch) {
		return {
			status: "unavailable",
			inspected: 0,
			active: 0,
			preserved: 0,
			rejected: 0,
			totalAvailable: 0,
		};
	}

	const classifications = legacyBatch.candidates.map(classifyLegacyCandidate);
	const applied = applyLegacyMigrationRows({
		userId: params.userId,
		resetGeneration,
		requestedLimit,
		totalAvailable: legacyBatch.totalAvailable,
		classifications,
	});
	if (applied === "stale_generation") {
		return {
			status: "stale_generation",
			inspected: classifications.length,
			active: 0,
			preserved: 0,
			rejected: 0,
			totalAvailable: legacyBatch.totalAvailable,
		};
	}

	const active = classifications.filter(
		(classification) => classification.decision === "activate",
	).length;
	const preserved = classifications.filter(
		(classification) => classification.decision === "preserve",
	).length;
	const rejected = classifications.filter(
		(classification) => classification.decision === "reject",
	).length;

	return {
		status: "completed",
		inspected: classifications.length,
		active,
		preserved,
		rejected,
		totalAvailable: legacyBatch.totalAvailable,
	};
}
