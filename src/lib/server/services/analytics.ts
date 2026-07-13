import * as crypto from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { SessionUser } from "$lib/types";
import { getProviderIdFromModelId, isProviderModelId } from "$lib/types";
import { getConfig } from "../config-store";
import { db } from "../db";
import {
	analyticsConversations,
	conversations,
	messageAnalytics,
	providerModelPriceWindows,
	providerModels,
	providers,
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

type UsageRow = typeof usageEvents.$inferSelect;
type ConversationRow = typeof analyticsConversations.$inferSelect;

type AnalyticsUser = Pick<SessionUser, "id" | "role">;

export type AnalyticsTimelineGranularity = "weekly" | "monthly" | "yearly";

export interface AnalyticsDashboardReadParams {
	user: AnalyticsUser;
	mock?: boolean;
	month?: string | null;
	systemMonth?: string | null;
	timeline?: string | null;
	excludedUserIds?: string[];
}

interface AnalyticsByModelRow {
	model: string;
	displayName?: string;
	providerDisplayName?: string | null;
	msgCount: number;
	promptTokens?: number;
	cachedInputTokens?: number;
	outputTokens?: number;
	reasoningTokens?: number;
	totalTokens?: number;
	totalCostUsd: number;
}

interface AnalyticsByProviderRow {
	providerId: string | null;
	displayName: string;
	msgCount: number;
	promptTokens?: number;
	cachedInputTokens?: number;
	outputTokens?: number;
	reasoningTokens?: number;
	totalTokens?: number;
	totalCostUsd: number;
}

interface MonthlyAnalyticsRow {
	month: string;
	messages: number;
	promptTokens?: number;
	cachedInputTokens?: number;
	outputTokens?: number;
	reasoningTokens?: number;
	totalTokens: number;
	totalCostUsd: number;
}

interface PersonalAnalytics {
	byModel: AnalyticsByModelRow[];
	byProvider: AnalyticsByProviderRow[];
	totalMessages: number;
	avgGenerationMs: number;
	promptTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	totalTokens: number;
	totalCostUsd: number;
	favoriteModel: string | null;
	chatCount: number;
	monthly: MonthlyAnalyticsRow[];
}

export interface ParallelUsageBreakdown {
	monthly: Array<{
		month: string;
		turboCalls: number;
		extractCalls: number;
		costUsd: number;
	}>;
	totalTurboCalls: number;
	totalExtractCalls: number;
	totalCostUsd: number;
}

interface SystemAnalytics {
	byModel: AnalyticsByModelRow[];
	byProvider: AnalyticsByProviderRow[];
	totalMessages: number;
	avgGenerationMs: number;
	promptTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	totalTokens: number;
	totalCostUsd: number;
	totalUsers: number;
	totalConversations: number;
	monthly?: MonthlyAnalyticsRow[];
	favoriteModel?: string | null;
	chatCount?: number;
	// Admin-only rollup of Parallel API usage (Turbo search + Extract fetch),
	// derived from usage_events rows whose modelId starts with "parallel:".
	parallel?: ParallelUsageBreakdown;
}

interface PerUserAnalytics {
	userId: string;
	displayName: string;
	email: string;
	messageCount: number;
	avgGenerationMs: number;
	totalTokens: number;
	promptTokens: number;
	cachedInputTokens?: number;
	outputTokens: number;
	reasoningTokens: number;
	totalCostUsd: number;
	favoriteModel: string | null;
	conversationCount: number;
}

export interface AnalyticsUserSummary {
	userId: string;
	email: string | null;
	name: string | null;
}

export interface AnalyticsDashboardReadModel {
	personal: PersonalAnalytics;
	system?: SystemAnalytics;
	perUser?: PerUserAnalytics[];
	availableMonths?: string[];
	systemAvailableMonths?: string[];
	timeline?: Array<{ label: string; tokens: number }>;
	analyticsUsers?: AnalyticsUserSummary[];
}

const MOCK_ANALYTICS: AnalyticsDashboardReadModel = {
	personal: {
		byModel: [
			{
				model: "model1",
				displayName: "Model 1",
				msgCount: 87,
				totalCostUsd: 1.42,
			},
			{
				model: "model2",
				displayName: "Model 2",
				msgCount: 34,
				totalCostUsd: 0.94,
			},
		],
		byProvider: [
			{
				providerId: null,
				displayName: "Native Model",
				msgCount: 87,
				totalCostUsd: 1.42,
			},
			{
				providerId: "provider-abc",
				displayName: "OpenRouter",
				msgCount: 34,
				totalCostUsd: 0.94,
			},
		],
		totalMessages: 121,
		avgGenerationMs: 2340,
		promptTokens: 35800,
		cachedInputTokens: 5100,
		outputTokens: 48200,
		reasoningTokens: 12400,
		totalTokens: 96400,
		totalCostUsd: 2.36,
		favoriteModel: "model1",
		chatCount: 18,
		monthly: [
			{
				month: "2026-04",
				messages: 121,
				totalTokens: 96400,
				totalCostUsd: 2.36,
			},
		],
	},
	system: {
		byModel: [
			{
				model: "model1",
				displayName: "Model 1",
				msgCount: 310,
				totalCostUsd: 6.1,
			},
			{
				model: "model2",
				displayName: "Model 2",
				msgCount: 120,
				totalCostUsd: 3.7,
			},
		],
		byProvider: [
			{
				providerId: null,
				displayName: "Native Model",
				msgCount: 310,
				totalCostUsd: 6.1,
			},
			{
				providerId: "provider-abc",
				displayName: "OpenRouter",
				msgCount: 120,
				totalCostUsd: 3.7,
			},
		],
		totalMessages: 430,
		avgGenerationMs: 2100,
		promptTokens: 132000,
		cachedInputTokens: 18800,
		outputTokens: 176000,
		reasoningTokens: 44000,
		totalTokens: 352000,
		totalCostUsd: 9.8,
		totalUsers: 5,
		totalConversations: 60,
		monthly: [
			{
				month: "2026-04",
				messages: 430,
				totalTokens: 352000,
				totalCostUsd: 9.8,
			},
		],
	},
	systemAvailableMonths: ["2026-04"],
	perUser: [
		{
			userId: "1",
			displayName: "Admin",
			email: "admin@demo.com",
			messageCount: 121,
			avgGenerationMs: 2340,
			totalTokens: 96400,
			promptTokens: 35800,
			outputTokens: 48200,
			reasoningTokens: 12400,
			totalCostUsd: 2.36,
			favoriteModel: "model1",
			conversationCount: 18,
		},
		{
			userId: "2",
			displayName: "Alice",
			email: "alice@demo.com",
			messageCount: 95,
			avgGenerationMs: 1980,
			totalTokens: 75200,
			promptTokens: 27600,
			outputTokens: 38100,
			reasoningTokens: 9500,
			totalCostUsd: 1.9,
			favoriteModel: "model1",
			conversationCount: 12,
		},
	],
};

function usd(micros: number): number {
	return Math.round((micros / 1_000_000) * 10000) / 10000;
}

function fallbackModelDisplayName(modelId: string): string {
	const config = getConfig();
	if (modelId === "model1") return config.model1.displayName;
	if (modelId === "model2") return config.model2.displayName;
	return modelId;
}

function average(values: number[]): number {
	const present = values.filter((value) => Number.isFinite(value) && value > 0);
	if (present.length === 0) return 0;
	return present.reduce((sum, value) => sum + value, 0) / present.length;
}

type UsageAccumulator = {
	promptTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	totalTokens: number;
	totalCostMicros: number;
};

function createUsageAccumulator(): UsageAccumulator {
	return {
		promptTokens: 0,
		cachedInputTokens: 0,
		outputTokens: 0,
		reasoningTokens: 0,
		totalTokens: 0,
		totalCostMicros: 0,
	};
}

function addUsageRowUsage(rowAccumulator: UsageAccumulator, row: UsageRow) {
	rowAccumulator.promptTokens += row.promptTokens;
	rowAccumulator.cachedInputTokens += row.cachedInputTokens;
	rowAccumulator.outputTokens += row.completionTokens;
	rowAccumulator.reasoningTokens += row.reasoningTokens;
	rowAccumulator.totalTokens += row.totalTokens;
	rowAccumulator.totalCostMicros += row.costUsdMicros;
}

function materializeUsageBreakdown<T extends { totalCostMicros: number }>(
	grouped: Map<string, T>,
	sort: (
		left: T & { totalCostUsd: number },
		right: T & { totalCostUsd: number },
	) => number,
) {
	return [...grouped.values()]
		.map((row) => ({ ...row, totalCostUsd: usd(row.totalCostMicros) }))
		.sort(sort);
}

async function modelBreakdown(rows: UsageRow[]) {
	const grouped = new Map<
		string,
		{
			model: string;
			displayName: string;
			providerDisplayName: string | null;
			msgCount: number;
			promptTokens: number;
			cachedInputTokens: number;
			outputTokens: number;
			reasoningTokens: number;
			totalTokens: number;
			totalCostMicros: number;
		}
	>();

	const providerIds = new Set<string>();
	for (const row of rows) {
		if (!row.modelDisplayName && isProviderModelId(row.modelId)) {
			const providerId = getProviderIdFromModelId(row.modelId);
			if (providerId) providerIds.add(providerId);
		}
	}

	const providerNames = new Map<string, string>();
	if (providerIds.size > 0) {
		const providerRows = await db
			.select({ id: providers.id, displayName: providers.displayName })
			.from(providers)
			.where(inArray(providers.id, [...providerIds]));
		for (const provider of providerRows) {
			providerNames.set(provider.id, provider.displayName);
		}
	}

	for (const row of rows) {
		const key = row.modelId;
		const providerId = isProviderModelId(row.modelId)
			? getProviderIdFromModelId(row.modelId)
			: null;
		const resolvedName =
			row.modelDisplayName ??
			(providerId ? providerNames.get(providerId) : null) ??
			row.providerModelName ??
			fallbackModelDisplayName(row.modelId);
		const current = grouped.get(key) ?? {
			model: row.modelId,
			displayName: resolvedName,
			providerDisplayName: row.providerDisplayName,
			msgCount: 0,
			...createUsageAccumulator(),
		};
		current.msgCount += 1;
		addUsageRowUsage(current, row);
		grouped.set(key, current);
	}

	return materializeUsageBreakdown(
		grouped,
		(left, right) => right.msgCount - left.msgCount,
	);
}

async function providerBreakdown(rows: UsageRow[]) {
	const grouped = new Map<
		string,
		{
			providerId: string | null;
			displayName: string;
			msgCount: number;
			promptTokens: number;
			cachedInputTokens: number;
			outputTokens: number;
			reasoningTokens: number;
			totalTokens: number;
			totalCostMicros: number;
		}
	>();

	const providerIds = new Set<string>();
	for (const row of rows) {
		if (row.providerId) providerIds.add(row.providerId);
	}

	const providerNames = new Map<string, string>();
	if (providerIds.size > 0) {
		const providerRows = await db
			.select({ id: providers.id, displayName: providers.displayName })
			.from(providers)
			.where(inArray(providers.id, [...providerIds]));
		for (const provider of providerRows) {
			providerNames.set(provider.id, provider.displayName);
		}
	}

	for (const row of rows) {
		const key = row.providerId ?? "__native__";
		const resolvedName =
			row.providerDisplayName ??
			providerNames.get(row.providerId ?? "") ??
			row.providerId ??
			"Native Model";

		const current = grouped.get(key) ?? {
			providerId: row.providerId,
			displayName: resolvedName,
			msgCount: 0,
			...createUsageAccumulator(),
		};
		current.msgCount += 1;
		addUsageRowUsage(current, row);
		if (current.providerId === null && row.providerId) {
			current.providerId = row.providerId;
		}
		grouped.set(key, current);
	}

	return materializeUsageBreakdown(
		grouped,
		(left, right) => right.totalCostMicros - left.totalCostMicros,
	);
}

function monthlyBreakdown(rows: UsageRow[]) {
	const grouped = new Map<
		string,
		{
			month: string;
			messages: number;
			promptTokens: number;
			cachedInputTokens: number;
			outputTokens: number;
			reasoningTokens: number;
			totalTokens: number;
			totalCostMicros: number;
		}
	>();

	for (const row of rows) {
		const current = grouped.get(row.billingMonth) ?? {
			month: row.billingMonth,
			messages: 0,
			...createUsageAccumulator(),
		};
		current.messages += 1;
		addUsageRowUsage(current, row);
		grouped.set(row.billingMonth, current);
	}

	return materializeUsageBreakdown(grouped, (left, right) =>
		left.month.localeCompare(right.month),
	);
}

// Roll up Parallel API usage from usage_events. Turbo search rows carry
// modelId "parallel:turbo" and Extract fetch rows "parallel:extract"; every
// other row is ignored. Grouped by billing month and summed into a flat cost.
export function parallelBreakdown(events: UsageRow[]): ParallelUsageBreakdown {
	const grouped = new Map<
		string,
		{
			month: string;
			turboCalls: number;
			extractCalls: number;
			costMicros: number;
		}
	>();
	let totalTurboCalls = 0;
	let totalExtractCalls = 0;
	let totalCostMicros = 0;

	for (const row of events) {
		if (!row.modelId.startsWith("parallel:")) continue;
		const current = grouped.get(row.billingMonth) ?? {
			month: row.billingMonth,
			turboCalls: 0,
			extractCalls: 0,
			costMicros: 0,
		};
		if (row.modelId === "parallel:turbo") {
			current.turboCalls += 1;
			totalTurboCalls += 1;
		} else if (row.modelId === "parallel:extract") {
			current.extractCalls += 1;
			totalExtractCalls += 1;
		}
		current.costMicros += row.costUsdMicros;
		totalCostMicros += row.costUsdMicros;
		grouped.set(row.billingMonth, current);
	}

	const monthly = [...grouped.values()]
		.map(({ costMicros, ...rest }) => ({ ...rest, costUsd: usd(costMicros) }))
		.sort((left, right) => left.month.localeCompare(right.month));

	return {
		monthly,
		totalTurboCalls,
		totalExtractCalls,
		totalCostUsd: usd(totalCostMicros),
	};
}

function computeTimeline(rows: UsageRow[], granularity: string) {
	const grouped = new Map<string, { label: string; tokens: number }>();

	for (const row of rows) {
		const date =
			row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
		let key: string;
		let label: string;

		if (granularity === "weekly") {
			const startOfYear = new Date(date.getFullYear(), 0, 1);
			const days = Math.floor(
				(date.getTime() - startOfYear.getTime()) / 86400000,
			);
			const weekNum = Math.ceil((days + startOfYear.getDay() + 1) / 7);
			key = `${date.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
			label = key;
		} else if (granularity === "monthly") {
			key = row.billingMonth;
			label = key;
		} else {
			key = row.billingMonth.slice(0, 4);
			label = key;
		}

		const current = grouped.get(key) ?? { label, tokens: 0 };
		current.tokens += row.totalTokens;
		grouped.set(key, current);
	}

	return [...grouped.values()].sort((a, b) => a.label.localeCompare(b.label));
}

async function summarize(
	rows: UsageRow[],
	conversations: ConversationRow[],
): Promise<PersonalAnalytics> {
	const [byModel, byProvider] = await Promise.all([
		modelBreakdown(rows),
		providerBreakdown(rows),
	]);
	const promptTokens = rows.reduce((sum, row) => sum + row.promptTokens, 0);
	const cachedInputTokens = rows.reduce(
		(sum, row) => sum + row.cachedInputTokens,
		0,
	);
	const outputTokens = rows.reduce((sum, row) => sum + row.completionTokens, 0);
	const reasoningTokens = rows.reduce(
		(sum, row) => sum + row.reasoningTokens,
		0,
	);
	const totalTokens = rows.reduce((sum, row) => sum + row.totalTokens, 0);
	const totalCostMicros = rows.reduce((sum, row) => sum + row.costUsdMicros, 0);

	return {
		byModel,
		byProvider,
		totalMessages: rows.length,
		avgGenerationMs: average(rows.map((row) => row.generationTimeMs ?? 0)),
		promptTokens,
		cachedInputTokens,
		outputTokens,
		reasoningTokens,
		totalTokens,
		totalCostUsd: usd(totalCostMicros),
		favoriteModel: byModel[0]?.model ?? null,
		chatCount: new Set(conversations.map((row) => row.conversationId)).size,
		monthly: monthlyBreakdown(rows),
	};
}

export async function getAnalyticsDashboardReadModel({
	user,
	mock = false,
	month = null,
	systemMonth = null,
	timeline = null,
	excludedUserIds = [],
}: AnalyticsDashboardReadParams): Promise<AnalyticsDashboardReadModel> {
	const isAdmin = user.role === "admin";

	if (mock) {
		return isAdmin ? MOCK_ANALYTICS : { personal: MOCK_ANALYTICS.personal };
	}

	const [usageRows, conversationRows] = await Promise.all([
		db.select().from(usageEvents),
		db.select().from(analyticsConversations),
	]);

	const systemMonthParam = isAdmin ? (systemMonth ?? month) : null;

	const filteredUsage = month
		? usageRows.filter((row) => row.billingMonth === month)
		: usageRows;
	const filteredConversations = month
		? conversationRows.filter((row) => row.billingMonth === month)
		: conversationRows;

	const personalUsageRows = filteredUsage.filter(
		(row) => row.userId === user.id,
	);
	const personalConversationRows = filteredConversations.filter(
		(row) => row.userId === user.id,
	);
	const availableMonths = monthlyBreakdown(
		usageRows.filter((row) => row.userId === user.id),
	).map((row) => row.month);

	const excludedSet = new Set(excludedUserIds);
	let systemFilteredUsage = systemMonthParam
		? usageRows.filter((row) => row.billingMonth === systemMonthParam)
		: usageRows;
	let systemFilteredConversations = systemMonthParam
		? conversationRows.filter((row) => row.billingMonth === systemMonthParam)
		: conversationRows;

	if (isAdmin && excludedSet.size > 0) {
		systemFilteredUsage = systemFilteredUsage.filter(
			(row) => !excludedSet.has(row.userId),
		);
		systemFilteredConversations = systemFilteredConversations.filter(
			(row) => !excludedSet.has(row.userId),
		);
	}

	const systemAvailableMonths = isAdmin
		? monthlyBreakdown(usageRows).map((row) => row.month)
		: undefined;
	const personal = await summarize(personalUsageRows, personalConversationRows);
	let timelineRows: Array<{ label: string; tokens: number }> | null = null;

	if (timeline && personalUsageRows.length > 0) {
		timelineRows = computeTimeline(personalUsageRows, timeline);
	}

	if (!isAdmin) {
		return {
			personal,
			availableMonths,
			...(timelineRows ? { timeline: timelineRows } : {}),
		};
	}

	const systemSummary = await summarize(
		systemFilteredUsage,
		systemFilteredConversations,
	);
	const system: SystemAnalytics = {
		...systemSummary,
		totalUsers: new Set([
			...systemFilteredUsage.map((row) => row.userId),
			...systemFilteredConversations.map((row) => row.userId),
		]).size,
		totalConversations: new Set(
			systemFilteredConversations.map((row) => row.conversationId),
		).size,
		parallel: parallelBreakdown(systemFilteredUsage),
	};

	const userIds = new Set([
		...systemFilteredUsage.map((row) => row.userId),
		...systemFilteredConversations.map((row) => row.userId),
	]);
	// Identity is resolved from `users` at READ time (not denormalized onto the
	// analytics rows), so an erased user — whose `users` row is gone — surfaces
	// anonymously (its opaque userId, no email/name) instead of via a frozen
	// person-linked snapshot. Strengthens ADR-0029.
	const userIdentities = await loadUserIdentities([
		...usageRows.map((row) => row.userId),
		...conversationRows.map((row) => row.userId),
	]);
	const perUser = (
		await Promise.all(
			[...userIds].map(async (userId) => {
				const rows = systemFilteredUsage.filter((row) => row.userId === userId);
				const conversationRowsForUser = systemFilteredConversations.filter(
					(row) => row.userId === userId,
				);
				const summary = await summarize(rows, conversationRowsForUser);
				const identity = userIdentities.get(userId) ?? null;
				return {
					userId,
					displayName: identity?.name ?? identity?.email ?? userId,
					email: identity?.email ?? "",
					messageCount: summary.totalMessages,
					avgGenerationMs: summary.avgGenerationMs,
					totalTokens: summary.totalTokens,
					promptTokens: summary.promptTokens,
					cachedInputTokens: summary.cachedInputTokens,
					outputTokens: summary.outputTokens,
					reasoningTokens: summary.reasoningTokens,
					totalCostUsd: summary.totalCostUsd,
					favoriteModel: summary.favoriteModel,
					conversationCount: summary.chatCount,
				};
			}),
		)
	).sort((left, right) => right.messageCount - left.messageCount);

	const analyticsUsers: AnalyticsUserSummary[] = [
		...new Map(
			usageRows.map((row) => {
				const identity = userIdentities.get(row.userId) ?? null;
				return [
					row.userId,
					{
						userId: row.userId,
						email: identity?.email ?? null,
						name: identity?.name ?? null,
					},
				];
			}),
		).values(),
	].sort((left, right) => {
		const leftName = left.name ?? left.email ?? left.userId;
		const rightName = right.name ?? right.email ?? right.userId;
		return leftName.localeCompare(rightName);
	});

	return {
		personal,
		system,
		perUser,
		availableMonths,
		systemAvailableMonths,
		analyticsUsers: isAdmin ? analyticsUsers : undefined,
		...(timelineRows ? { timeline: timelineRows } : {}),
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

// Resolve display identity for a set of userIds from the `users` table at read
// time. A userId with no matching row (e.g. an erased account) is simply absent
// from the map, so callers render it anonymously.
async function loadUserIdentities(
	userIds: string[],
): Promise<Map<string, { email: string | null; name: string | null }>> {
	const uniqueIds = [...new Set(userIds)];
	if (uniqueIds.length === 0) return new Map();
	const rows = await db
		.select({ id: users.id, email: users.email, name: users.name })
		.from(users)
		.where(inArray(users.id, uniqueIds));
	return new Map(
		rows.map((row) => [row.id, { email: row.email, name: row.name }]),
	);
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

// Resolve the enabled price rule that applies to a configured model id
// ("model1"/"model2" or "provider:<uuid>:<uuid>"). Thin wrapper over
// getModelSnapshot + findPriceRule so callers outside analytics can price a
// call without reimplementing the snapshot/rule resolution.
export async function resolveModelPriceRule(
	modelId: string,
): Promise<typeof providerModels.$inferSelect | null> {
	const snapshot = await getModelSnapshot(modelId);
	return findPriceRule({
		modelId,
		providerId: snapshot.providerId,
		providerModelName: snapshot.providerModelName,
	});
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

// The subset of a provider_model_price_windows row the resolver needs. The rate
// columns are nullable — null means "inherit the base provider_models rate".
export interface EffectivePriceWindow {
	id: string;
	// Subset of "0123456" (0=Sunday, UTC) the window's START day applies to.
	daysOfWeek: string;
	// Minutes from UTC midnight. start inclusive, end exclusive; when
	// end <= start the window wraps past midnight into the next day.
	startMinute: number;
	endMinute: number;
	inputUsdMicrosPer1m: number | null;
	cachedInputUsdMicrosPer1m: number | null;
	cacheHitUsdMicrosPer1m: number | null;
	cacheMissUsdMicrosPer1m: number | null;
	outputUsdMicrosPer1m: number | null;
	enabled: boolean;
}

function priceWindowSortKey(a: EffectivePriceWindow, b: EffectivePriceWindow) {
	if (a.startMinute !== b.startMinute) return a.startMinute - b.startMinute;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function priceWindowCoversDay(window: EffectivePriceWindow, day: number) {
	return window.daysOfWeek.includes(String(day));
}

// Whether `window` is active at the given UTC weekday (0=Sunday) + minute-of-day.
// Non-wrapping windows (end > start) match [start, end) on their own day.
// Wrapping windows (end <= start) run from `start` on their START day through
// `end` on the following day, so the early-morning tail belongs to the window
// that STARTED the previous day — days_of_week is checked against that day.
function priceWindowActiveAt(
	window: EffectivePriceWindow,
	weekday: number,
	minuteOfDay: number,
): boolean {
	if (!window.enabled) return false;
	if (window.endMinute > window.startMinute) {
		return (
			priceWindowCoversDay(window, weekday) &&
			minuteOfDay >= window.startMinute &&
			minuteOfDay < window.endMinute
		);
	}
	// Wraparound: today's leading portion, or yesterday's spilled tail.
	if (
		minuteOfDay >= window.startMinute &&
		priceWindowCoversDay(window, weekday)
	) {
		return true;
	}
	const previousDay = (weekday + 6) % 7;
	return (
		minuteOfDay < window.endMinute && priceWindowCoversDay(window, previousDay)
	);
}

// Find the FIRST active window for `now`, ordered by start_minute then id so
// overlapping windows resolve to a stable, documented winner (earliest start,
// then lexicographically smallest id).
export function findActivePriceWindow(
	windows: readonly EffectivePriceWindow[],
	now: Date,
): EffectivePriceWindow | null {
	const weekday = now.getUTCDay();
	const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
	const ordered = [...windows].sort(priceWindowSortKey);
	for (const window of ordered) {
		if (priceWindowActiveAt(window, weekday, minuteOfDay)) return window;
	}
	return null;
}

// Given the base provider_models rule and its enabled windows, return a
// shallow-cloned rule with each non-null rate of the first active window
// overriding the base. With no windows (or none active) the base rule is
// returned unchanged.
export function resolveEffectivePriceRule(
	rule: typeof providerModels.$inferSelect | null,
	windows: readonly EffectivePriceWindow[],
	now: Date,
): typeof providerModels.$inferSelect | null {
	if (!rule || windows.length === 0) return rule;
	const active = findActivePriceWindow(windows, now);
	if (!active) return rule;
	return {
		...rule,
		inputUsdMicrosPer1m: active.inputUsdMicrosPer1m ?? rule.inputUsdMicrosPer1m,
		cachedInputUsdMicrosPer1m:
			active.cachedInputUsdMicrosPer1m ?? rule.cachedInputUsdMicrosPer1m,
		cacheHitUsdMicrosPer1m:
			active.cacheHitUsdMicrosPer1m ?? rule.cacheHitUsdMicrosPer1m,
		cacheMissUsdMicrosPer1m:
			active.cacheMissUsdMicrosPer1m ?? rule.cacheMissUsdMicrosPer1m,
		outputUsdMicrosPer1m:
			active.outputUsdMicrosPer1m ?? rule.outputUsdMicrosPer1m,
	};
}

// Load the ENABLED price windows for a provider model, shaped for
// resolveEffectivePriceRule. Returns [] for models without any window rows so
// callers stay a no-op in the common (flat-rate) case.
export async function listPriceWindowsForModel(
	providerModelId: string,
): Promise<EffectivePriceWindow[]> {
	const rows = await db
		.select()
		.from(providerModelPriceWindows)
		.where(
			and(
				eq(providerModelPriceWindows.providerModelId, providerModelId),
				eq(providerModelPriceWindows.enabled, 1),
			),
		);
	return rows.map((row) => ({
		id: row.id,
		daysOfWeek: row.daysOfWeek,
		startMinute: row.startMinute,
		endMinute: row.endMinute,
		inputUsdMicrosPer1m: row.inputUsdMicrosPer1m,
		cachedInputUsdMicrosPer1m: row.cachedInputUsdMicrosPer1m,
		cacheHitUsdMicrosPer1m: row.cacheHitUsdMicrosPer1m,
		cacheMissUsdMicrosPer1m: row.cacheMissUsdMicrosPer1m,
		outputUsdMicrosPer1m: row.outputUsdMicrosPer1m,
		enabled: row.enabled === 1,
	}));
}

export async function recordConversationAnalytics(params: {
	conversationId: string;
	userId: string;
	title?: string | null;
	createdAt?: Date | null;
	source?: "live" | "legacy_estimate";
}): Promise<void> {
	const conversation =
		params.title === undefined
			? await getConversationSnapshot(params.userId, params.conversationId)
			: null;
	const createdAt = params.createdAt ?? conversation?.createdAt ?? new Date();

	await db
		.insert(analyticsConversations)
		.values({
			id: crypto.randomUUID(),
			conversationId: params.conversationId,
			userId: params.userId,
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

	const [conversation, model] = await Promise.all([
		getConversationSnapshot(params.userId, params.conversationId),
		getModelSnapshot(params.model, params.modelDisplayName),
	]);
	await recordConversationAnalytics({
		conversationId: params.conversationId,
		userId: params.userId,
		title: conversation.title,
		createdAt: conversation.createdAt,
	}).catch(() => undefined);

	const basePriceRule = await findPriceRule({
		modelId: params.model,
		providerId: model.providerId,
		providerModelName: model.providerModelName,
	});
	// Price at the rate active at call time: a time-slot window overrides the
	// flat rate while active, otherwise the base rule is used unchanged.
	const priceRule = basePriceRule
		? resolveEffectivePriceRule(
				basePriceRule,
				await listPriceWindowsForModel(basePriceRule.id),
				new Date(),
			)
		: basePriceRule;
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

export async function recordAtlasJobAnalytics(params: {
	userId: string;
	conversationId: string;
	atlasJobId: string;
	assistantMessageId: string | null;
	profile: string;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costUsdMicros: number;
}): Promise<void> {
	const conversation = await getConversationSnapshot(
		params.userId,
		params.conversationId,
	);
	const billingMonth = new Date().toISOString().slice(0, 7);
	const modelDisplayName = `Atlas (${params.profile})`;
	await db
		.insert(usageEvents)
		.values({
			id: crypto.randomUUID(),
			userId: params.userId,
			conversationId: params.conversationId,
			conversationTitle: conversation.title,
			messageId: params.atlasJobId,
			modelId: "atlas",
			modelDisplayName,
			providerId: null,
			providerDisplayName: null,
			providerBaseUrl: null,
			providerModelName: null,
			promptTokens: params.inputTokens,
			cachedInputTokens: 0,
			cacheHitTokens: 0,
			cacheMissTokens: 0,
			completionTokens: params.outputTokens,
			reasoningTokens: 0,
			totalTokens: params.totalTokens,
			usageSource: "estimated",
			generationTimeMs: null,
			billingMonth,
			costUsdMicros: params.costUsdMicros,
			priceRuleId: null,
		})
		.onConflictDoNothing();
	await recordConversationAnalytics({
		conversationId: params.conversationId,
		userId: params.userId,
		title: conversation.title,
		createdAt: conversation.createdAt,
	}).catch(() => undefined);
}

// Flat cost booked per Parallel API call: $1 per 1,000 calls = 1,000 micros.
const PARALLEL_COST_USD_MICROS = 1000;

const PARALLEL_TOOL_MODEL = {
	research_web: {
		modelId: "parallel:turbo",
		modelDisplayName: "Parallel Turbo",
	},
	fetch_url: {
		modelId: "parallel:extract",
		modelDisplayName: "Parallel Extract",
	},
} as const;

// Record a single Parallel API call (Turbo search or Extract fetch) as a
// usage_events row so its cost folds into the model breakdown automatically and
// the admin dashboard can chart Parallel usage. Best-effort: like the other
// analytics writers it never throws into the caller. The synthetic messageId is
// unique per call so it never collides with a real message row or another
// Parallel call under the messageId unique index.
export async function recordParallelUsage(input: {
	userId: string;
	conversationId?: string | null;
	tool: "research_web" | "fetch_url";
}): Promise<void> {
	if (!input.userId) return;
	try {
		const model = PARALLEL_TOOL_MODEL[input.tool];
		await db
			.insert(usageEvents)
			.values({
				id: crypto.randomUUID(),
				userId: input.userId,
				conversationId: input.conversationId ?? "",
				conversationTitle: null,
				messageId: `parallel:${crypto.randomUUID()}`,
				modelId: model.modelId,
				modelDisplayName: model.modelDisplayName,
				providerId: null,
				providerDisplayName: "Parallel",
				providerBaseUrl: null,
				providerModelName: null,
				promptTokens: 0,
				cachedInputTokens: 0,
				cacheHitTokens: 0,
				cacheMissTokens: 0,
				completionTokens: 0,
				reasoningTokens: 0,
				totalTokens: 0,
				usageSource: "provider",
				generationTimeMs: null,
				billingMonth: toBillingMonth(new Date()),
				costUsdMicros: PARALLEL_COST_USD_MICROS,
				priceRuleId: null,
			})
			.onConflictDoNothing();
	} catch (error) {
		console.error("[ANALYTICS] Failed to record Parallel usage", error);
	}
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
