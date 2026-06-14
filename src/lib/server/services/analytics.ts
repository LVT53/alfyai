import * as crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { isProviderModelId } from "$lib/types";
import { getConfig } from "../config-store";
import { db } from "../db";
import {
	analyticsConversations,
	conversations,
	messageAnalytics,
	providerModels,
	usageEvents,
	users,
} from "../db/schema";

export type UsageSource = "provider" | "estimated" | "legacy_estimate";

export interface ProviderUsageSnapshot {
	promptTokens?: number;
	cachedInputTokens?: number;
	cacheHitTokens?: number;
	cacheMissTokens?: number;
	completionTokens?: number;
	reasoningTokens?: number;
	totalTokens?: number;
	source?: UsageSource;
}

export interface AnalyticsParams {
	messageId: string;
	conversationId: string;
	userId: string;
	model: string;
	modelDisplayName?: string | null;
	promptTokens?: number;
	completionTokens?: number;
	reasoningTokens?: number;
	generationTimeMs?: number;
	providerUsage?: ProviderUsageSnapshot | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}

function readNumber(
	container: Record<string, unknown>,
	keys: string[],
): number {
	for (const key of keys) {
		const value = container[key];
		const parsed = normalizeCount(value);
		if (parsed > 0) return parsed;
	}
	return 0;
}

function findUsageObject(
	value: unknown,
	depth = 0,
): Record<string, unknown> | null {
	if (!isObject(value) || depth > 8) return null;
	const directUsage = value.usage;
	if (isObject(directUsage)) return directUsage;
	if (
		"prompt_tokens" in value ||
		"promptTokens" in value ||
		"completion_tokens" in value ||
		"completionTokens" in value
	) {
		return value;
	}
	for (const child of Object.values(value)) {
		if (Array.isArray(child)) {
			for (const item of child) {
				const found = findUsageObject(item, depth + 1);
				if (found) return found;
			}
			continue;
		}
		const found = findUsageObject(child, depth + 1);
		if (found) return found;
	}
	return null;
}

export function extractProviderUsage(
	value: unknown,
): ProviderUsageSnapshot | null {
	const usage = findUsageObject(value);
	if (!usage) return null;

	const promptTokens = readNumber(usage, [
		"prompt_tokens",
		"promptTokens",
		"input_tokens",
		"inputTokens",
	]);
	const completionTokens = readNumber(usage, [
		"completion_tokens",
		"completionTokens",
		"output_tokens",
		"outputTokens",
	]);
	const totalTokens = readNumber(usage, ["total_tokens", "totalTokens"]);
	const reasoningTokens =
		readNumber(usage, ["reasoning_tokens", "reasoningTokens"]) ||
		(isObject(usage.completion_tokens_details)
			? readNumber(usage.completion_tokens_details, [
					"reasoning_tokens",
					"reasoningTokens",
				])
			: 0);
	const cachedInputTokens =
		readNumber(usage, [
			"cached_tokens",
			"cachedTokens",
			"cached_prompt_tokens",
			"cachedPromptTokens",
		]) ||
		(isObject(usage.prompt_tokens_details)
			? readNumber(usage.prompt_tokens_details, [
					"cached_tokens",
					"cachedTokens",
				])
			: 0);
	const cacheHitTokens = readNumber(usage, [
		"prompt_cache_hit_tokens",
		"cache_hit_tokens",
		"cacheHitTokens",
	]);
	const cacheMissTokens = readNumber(usage, [
		"prompt_cache_miss_tokens",
		"cache_miss_tokens",
		"cacheMissTokens",
	]);

	if (
		promptTokens +
			completionTokens +
			totalTokens +
			reasoningTokens +
			cachedInputTokens +
			cacheHitTokens +
			cacheMissTokens ===
		0
	) {
		return null;
	}

	return {
		promptTokens,
		completionTokens,
		totalTokens,
		reasoningTokens,
		cachedInputTokens,
		cacheHitTokens,
		cacheMissTokens,
		source: "provider",
	};
}

function toBillingMonth(date = new Date()): string {
	return date.toISOString().slice(0, 7);
}

function normalizeCount(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function microsToUsd(value: number): number {
	return value / 1_000_000;
}

async function getUserSnapshot(userId: string) {
	const [row] = await db
		.select({ id: users.id, email: users.email, name: users.name })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	return row ?? { id: userId, email: null, name: null };
}

async function getConversationSnapshot(userId: string, conversationId: string) {
	const [row] = await db
		.select({
			id: conversations.id,
			title: conversations.title,
			createdAt: conversations.createdAt,
		})
		.from(conversations)
		.where(
			and(
				eq(conversations.id, conversationId),
				eq(conversations.userId, userId),
			),
		)
		.limit(1);
	return row ?? { id: conversationId, title: null, createdAt: new Date() };
}

async function getModelSnapshot(
	modelId: string,
	fallbackDisplayName?: string | null,
) {
	const config = getConfig();
	if (modelId === "model1") {
		return {
			modelDisplayName: fallbackDisplayName ?? config.model1.displayName,
			providerId: null,
			providerDisplayName: null,
			providerBaseUrl: config.model1.baseUrl,
			providerModelName: config.model1.modelName,
		};
	}
	if (modelId === "model2") {
		return {
			modelDisplayName: fallbackDisplayName ?? config.model2.displayName,
			providerId: null,
			providerDisplayName: null,
			providerBaseUrl: config.model2.baseUrl,
			providerModelName: config.model2.modelName,
		};
	}

	const rawId = modelId.startsWith("provider:")
		? modelId.slice("provider:".length)
		: modelId;
	const providerId = rawId.includes(":") ? rawId.split(":")[0] : rawId;
	try {
		const [{ getProviderWithSecrets }, { listEnabledProviderModels }] =
			await Promise.all([import("./providers"), import("./provider-models")]);
		const provider = await getProviderWithSecrets(providerId).catch(() => null);
		if (provider) {
			const models = await listEnabledProviderModels(providerId).catch(
				() => [],
			);
			const primaryModel = models[0];
			return {
				modelDisplayName:
					fallbackDisplayName ?? provider.displayName ?? modelId,
				providerId,
				providerDisplayName:
					provider.displayName ?? fallbackDisplayName ?? null,
				providerBaseUrl: provider.baseUrl ?? null,
				providerModelName: primaryModel?.name ?? null,
			};
		}
	} catch {}

	return {
		modelDisplayName: fallbackDisplayName ?? modelId,
		providerId: null,
		providerDisplayName: null,
		providerBaseUrl: null,
		providerModelName: null,
	};
}

export async function findPriceRule(params: {
	modelId: string;
	providerId: string | null;
	providerModelName: string | null;
}) {
	const enabledRows = await db
		.select()
		.from(providerModels)
		.where(eq(providerModels.enabled, 1));

	const normalizedModelName =
		params.providerModelName?.trim().toLowerCase() ?? "";
	const normalizedModelId = params.modelId.trim().toLowerCase();
	const normalizedProviderId = params.providerId?.trim().toLowerCase() ?? "";

	if (!normalizedModelName) return null;

	// Tier 1: modelId match for built-in models ("model1" / "model2")
	if (normalizedModelId === "model1" || normalizedModelId === "model2") {
		const match = enabledRows.find(
			(rule) => rule.name.toLowerCase() === normalizedModelName,
		);
		if (match) return match;
	}

	// Tier 2: providerId + modelName match
	if (normalizedProviderId) {
		const match = enabledRows.find(
			(rule) =>
				rule.providerId.toLowerCase() === normalizedProviderId &&
				rule.name.toLowerCase() === normalizedModelName,
		);
		if (match) return match;
	}

	// Tier 3: modelName-only match (fallback)
	return (
		enabledRows.find(
			(rule) => rule.name.toLowerCase() === normalizedModelName,
		) ?? null
	);
}

export function calculateCostUsdMicros(
	rule: typeof providerModels.$inferSelect | null,
	usage: {
		promptTokens: number;
		cachedInputTokens: number;
		cacheHitTokens: number;
		cacheMissTokens: number;
		completionTokens: number;
		reasoningTokens: number;
	},
): number {
	if (!rule) return 0;

	const cacheHitTokens = usage.cacheHitTokens || usage.cachedInputTokens;
	const cacheMissTokens = usage.cacheMissTokens;
	const cacheAccounted = cacheHitTokens + cacheMissTokens;
	const regularInputTokens = Math.max(0, usage.promptTokens - cacheAccounted);
	const outputTokens = usage.completionTokens || usage.reasoningTokens;

	const inputCost = (regularInputTokens * rule.inputUsdMicrosPer1m) / 1_000_000;
	const cacheHitRate =
		rule.cacheHitUsdMicrosPer1m ||
		rule.cachedInputUsdMicrosPer1m ||
		rule.inputUsdMicrosPer1m;
	const cacheMissRate =
		rule.cacheMissUsdMicrosPer1m || rule.inputUsdMicrosPer1m;
	const cacheHitCost = (cacheHitTokens * cacheHitRate) / 1_000_000;
	const cacheMissCost = (cacheMissTokens * cacheMissRate) / 1_000_000;
	const outputCost = (outputTokens * rule.outputUsdMicrosPer1m) / 1_000_000;

	return Math.round(inputCost + cacheHitCost + cacheMissCost + outputCost);
}

export async function recordConversationAnalytics(params: {
	conversationId: string;
	userId: string;
	title?: string | null;
	createdAt?: Date | null;
	source?: "live" | "legacy_estimate";
}): Promise<void> {
	const [user, conversation] = await Promise.all([
		getUserSnapshot(params.userId),
		params.title === undefined
			? getConversationSnapshot(params.userId, params.conversationId)
			: Promise.resolve(null),
	]);
	const createdAt = params.createdAt ?? conversation?.createdAt ?? new Date();

	await db
		.insert(analyticsConversations)
		.values({
			id: crypto.randomUUID(),
			conversationId: params.conversationId,
			userId: params.userId,
			userEmail: user.email,
			userName: user.name,
			title: params.title ?? conversation?.title ?? null,
			source: params.source ?? "live",
			billingMonth: toBillingMonth(createdAt),
			conversationCreatedAt: createdAt,
		})
		.onConflictDoNothing();
}

export async function recordMessageAnalytics(
	params: AnalyticsParams,
): Promise<void> {
	const providerUsage = params.providerUsage ?? null;
	const promptTokens = normalizeCount(
		providerUsage?.promptTokens ?? params.promptTokens,
	);
	const cachedInputTokens = normalizeCount(providerUsage?.cachedInputTokens);
	const cacheHitTokens = normalizeCount(providerUsage?.cacheHitTokens);
	const cacheMissTokens = normalizeCount(providerUsage?.cacheMissTokens);
	const completionTokens = normalizeCount(
		providerUsage?.completionTokens ?? params.completionTokens,
	);
	const reasoningTokens = normalizeCount(
		providerUsage?.reasoningTokens ?? params.reasoningTokens,
	);
	const totalTokens =
		normalizeCount(providerUsage?.totalTokens) ||
		promptTokens + completionTokens + reasoningTokens;
	const usageSource: UsageSource = providerUsage?.source ?? "estimated";

	await db
		.insert(messageAnalytics)
		.values({
			id: crypto.randomUUID(),
			messageId: params.messageId,
			userId: params.userId,
			model: params.model,
			promptTokens: promptTokens || null,
			completionTokens: completionTokens || null,
			reasoningTokens: reasoningTokens || null,
			generationTimeMs: params.generationTimeMs ?? null,
		})
		.onConflictDoNothing();

	const [user, conversation, model] = await Promise.all([
		getUserSnapshot(params.userId),
		getConversationSnapshot(params.userId, params.conversationId),
		getModelSnapshot(params.model, params.modelDisplayName),
	]);
	await recordConversationAnalytics({
		conversationId: params.conversationId,
		userId: params.userId,
		title: conversation.title,
		createdAt: conversation.createdAt,
	}).catch(() => undefined);

	const priceRule = await findPriceRule({
		modelId: params.model,
		providerId: model.providerId,
		providerModelName: model.providerModelName,
	});
	const costUsdMicros = calculateCostUsdMicros(priceRule, {
		promptTokens,
		cachedInputTokens,
		cacheHitTokens,
		cacheMissTokens,
		completionTokens,
		reasoningTokens,
	});

	await db
		.insert(usageEvents)
		.values({
			id: crypto.randomUUID(),
			userId: params.userId,
			userEmail: user.email,
			userName: user.name,
			conversationId: params.conversationId,
			conversationTitle: conversation.title,
			messageId: params.messageId,
			modelId: params.model,
			modelDisplayName: model.modelDisplayName,
			providerId: model.providerId,
			providerDisplayName: model.providerDisplayName,
			providerBaseUrl: model.providerBaseUrl,
			providerModelName: model.providerModelName,
			promptTokens,
			cachedInputTokens,
			cacheHitTokens,
			cacheMissTokens,
			completionTokens,
			reasoningTokens,
			totalTokens,
			usageSource,
			generationTimeMs: params.generationTimeMs ?? null,
			billingMonth: toBillingMonth(),
			costUsdMicros,
			priceRuleId: priceRule?.id ?? null,
		})
		.onConflictDoNothing();

	console.info("[ANALYTICS] Recorded usage event", {
		userId: params.userId,
		conversationId: params.conversationId,
		messageId: params.messageId,
		modelId: params.model,
		usageSource,
		totalTokens,
		costUsd: microsToUsd(costUsdMicros),
		providerId: isProviderModelId(params.model) ? model.providerId : null,
	});
}

export interface ConversationCostSummary {
	totalCostUsdMicros: number;
	totalTokens: number;
}

export async function getConversationCostSummary(
	conversationId: string,
): Promise<ConversationCostSummary> {
	const [row] = await db
		.select({
			totalCostUsdMicros: sql<number>`COALESCE(SUM(${usageEvents.costUsdMicros}), 0)`,
			totalTokens: sql<number>`COALESCE(SUM(${usageEvents.totalTokens}), 0)`,
		})
		.from(usageEvents)
		.where(eq(usageEvents.conversationId, conversationId));

	return {
		totalCostUsdMicros: row?.totalCostUsdMicros ?? 0,
		totalTokens: row?.totalTokens ?? 0,
	};
}
