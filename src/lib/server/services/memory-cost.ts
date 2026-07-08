import { and, eq, gte } from "drizzle-orm";
import { db } from "$lib/server/db";
import { memoryReworkTelemetry } from "$lib/server/db/schema";
import {
	calculateCostUsdMicros,
	listPriceWindowsForModel,
	resolveEffectivePriceRule,
	resolveModelPriceRule,
} from "./analytics";
import { parseJsonRecord } from "./memory-profile/internal-json";
import { recordMemoryReworkTelemetry } from "./memory-profile/telemetry";

export const MEMORY_MODEL_FEATURES = [
	"judge",
	"consolidation",
	"summary",
	"recuration",
] as const;

export type MemoryModelFeature = (typeof MEMORY_MODEL_FEATURES)[number];

export type MemoryModelUsage = {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	// Optional cache breakdown so cache-aware providers (e.g. DeepSeek) price
	// memory-pipeline control-model calls at their hit/miss rates rather than the
	// flat input rate. Absent fields default to zero (no cache accounting).
	cachedInputTokens?: number;
	cacheHitTokens?: number;
	cacheMissTokens?: number;
};

const COST_EVENT_NAME = "model_usage";

/**
 * Price one memory-pipeline control-model call and record its token usage + cost
 * as a "cost"/"model_usage" telemetry row. Best-effort: pricing lookups, an
 * unconfigured reset generation, or a malformed model id must never surface into
 * the memory pipeline, so every failure is swallowed. Absent usage is recorded
 * as zeros rather than skipped so call counts stay accurate.
 */
export async function recordMemoryModelUsage(params: {
	userId: string;
	feature: MemoryModelFeature;
	modelId: string;
	usage?: MemoryModelUsage;
}): Promise<void> {
	try {
		const promptTokens = params.usage?.promptTokens ?? 0;
		const completionTokens = params.usage?.completionTokens ?? 0;
		const totalTokens =
			params.usage?.totalTokens || promptTokens + completionTokens;
		const cachedInputTokens = params.usage?.cachedInputTokens ?? 0;
		const cacheHitTokens = params.usage?.cacheHitTokens ?? 0;
		const cacheMissTokens = params.usage?.cacheMissTokens ?? 0;

		const baseRule = await resolveModelPriceRule(params.modelId);
		// Price at the rate active right now: a time-slot window overrides the
		// flat rate while active, otherwise the base rule is used unchanged.
		const rule = baseRule
			? resolveEffectivePriceRule(
					baseRule,
					await listPriceWindowsForModel(baseRule.id),
					new Date(),
				)
			: baseRule;
		const costUsdMicros = calculateCostUsdMicros(rule, {
			promptTokens,
			cachedInputTokens,
			cacheHitTokens,
			cacheMissTokens,
			completionTokens,
			reasoningTokens: 0,
		});

		await recordMemoryReworkTelemetry({
			userId: params.userId,
			eventFamily: "cost",
			eventName: COST_EVENT_NAME,
			count: totalTokens,
			// Only privacy-safe numbers and the configured model id string (a
			// config value, never user content) — assertPrivacySafeMetadata gates
			// on field names, none of which trip the raw-text guard.
			metadata: {
				feature: params.feature,
				modelId: params.modelId,
				promptTokens,
				completionTokens,
				totalTokens,
				costUsdMicros,
			},
		});
	} catch {
		// Best-effort: cost tracking must never break the memory pipeline.
	}
}

export type MemoryCostFeatureRollup = {
	feature: string;
	calls: number;
	totalTokens: number;
	totalCostUsdMicros: number;
};

export type MemoryCostSummary = {
	byFeature: MemoryCostFeatureRollup[];
	totals: {
		calls: number;
		totalTokens: number;
		totalCostUsdMicros: number;
	};
};

function readNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Admin rollup of recorded memory-model cost, grouped by feature, read back from
 * the "cost"/"model_usage" telemetry rows across all users. `since` bounds the
 * window by createdAt.
 */
export async function getMemoryCostSummary(params?: {
	since?: Date;
}): Promise<MemoryCostSummary> {
	const filters = [
		eq(memoryReworkTelemetry.eventFamily, "cost"),
		eq(memoryReworkTelemetry.eventName, COST_EVENT_NAME),
	];
	if (params?.since) {
		filters.push(gte(memoryReworkTelemetry.createdAt, params.since));
	}

	const rows = await db
		.select({ metadataJson: memoryReworkTelemetry.metadataJson })
		.from(memoryReworkTelemetry)
		.where(and(...filters));

	const byFeature = new Map<string, MemoryCostFeatureRollup>();
	const totals = { calls: 0, totalTokens: 0, totalCostUsdMicros: 0 };

	for (const row of rows) {
		const metadata = parseJsonRecord(row.metadataJson);
		const feature =
			typeof metadata.feature === "string" ? metadata.feature : "unknown";
		const totalTokens = readNumber(metadata.totalTokens);
		const costUsdMicros = readNumber(metadata.costUsdMicros);

		const bucket = byFeature.get(feature) ?? {
			feature,
			calls: 0,
			totalTokens: 0,
			totalCostUsdMicros: 0,
		};
		bucket.calls += 1;
		bucket.totalTokens += totalTokens;
		bucket.totalCostUsdMicros += costUsdMicros;
		byFeature.set(feature, bucket);

		totals.calls += 1;
		totals.totalTokens += totalTokens;
		totals.totalCostUsdMicros += costUsdMicros;
	}

	return {
		byFeature: [...byFeature.values()].sort((a, b) =>
			a.feature.localeCompare(b.feature),
		),
		totals,
	};
}
