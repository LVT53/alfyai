import { json } from "@sveltejs/kit";
import { inArray } from "drizzle-orm";
import { requireAuth } from "$lib/server/auth/hooks";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import {
	analyticsConversations,
	providers,
	usageEvents,
} from "$lib/server/db/schema";
import { getProviderIdFromModelId, isProviderModelId } from "$lib/types";
import type { RequestHandler } from "./$types";

const MOCK_ANALYTICS = {
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

type UsageRow = typeof usageEvents.$inferSelect;
type ConversationRow = typeof analyticsConversations.$inferSelect;

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

	// Collect provider IDs that need display name resolution
	const providerIds = new Set<string>();
	for (const row of rows) {
		if (!row.modelDisplayName && isProviderModelId(row.modelId)) {
			const pid = getProviderIdFromModelId(row.modelId);
			if (pid) providerIds.add(pid);
		}
	}

	// Batch-resolve provider display names from the DB
	const providerNames = new Map<string, string>();
	if (providerIds.size > 0) {
		const providerRows = await db
			.select({ id: providers.id, displayName: providers.displayName })
			.from(providers)
			.where(inArray(providers.id, [...providerIds]));
		for (const p of providerRows) {
			providerNames.set(p.id, p.displayName);
		}
	}

	for (const row of rows) {
		const key = row.modelId;
		const pid = isProviderModelId(row.modelId)
			? getProviderIdFromModelId(
					row.modelId as Parameters<typeof getProviderIdFromModelId>[0],
				)
			: null;
		const resolvedName =
			row.modelDisplayName ??
			(pid ? providerNames.get(pid) : null) ??
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

	// Collect provider IDs that need display name resolution
	const providerIds = new Set<string>();
	for (const row of rows) {
		if (row.providerId) providerIds.add(row.providerId);
	}

	// Batch-resolve provider display names
	const providerNames = new Map<string, string>();
	if (providerIds.size > 0) {
		const providerRows = await db
			.select({ id: providers.id, displayName: providers.displayName })
			.from(providers)
			.where(inArray(providers.id, [...providerIds]));
		for (const p of providerRows) {
			providerNames.set(p.id, p.displayName);
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

function computeTimeline(
	rows: UsageRow[],
	granularity: "weekly" | "monthly" | "yearly",
) {
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

async function summarize(rows: UsageRow[], conversations: ConversationRow[]) {
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

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	const isAdmin = user.role === "admin";

	if (event.url.searchParams.get("mock") === "1") {
		return json(
			isAdmin ? MOCK_ANALYTICS : { personal: MOCK_ANALYTICS.personal },
		);
	}

	const [usageRows, conversationRows] = await Promise.all([
		db.select().from(usageEvents),
		db.select().from(analyticsConversations),
	]);

	const monthParam = event.url.searchParams.get("month");
	const systemMonthParam = isAdmin
		? (event.url.searchParams.get("systemMonth") ?? monthParam)
		: null;
	const filteredUsage = monthParam
		? usageRows.filter((row) => row.billingMonth === monthParam)
		: usageRows;
	const filteredConversations = monthParam
		? conversationRows.filter((row) => row.billingMonth === monthParam)
		: conversationRows;
	const systemFilteredUsage = systemMonthParam
		? usageRows.filter((row) => row.billingMonth === systemMonthParam)
		: usageRows;
	const systemFilteredConversations = systemMonthParam
		? conversationRows.filter((row) => row.billingMonth === systemMonthParam)
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
	const systemAvailableMonths = isAdmin
		? monthlyBreakdown(usageRows).map((row) => row.month)
		: undefined;
	const personal = await summarize(personalUsageRows, personalConversationRows);

	const timelineParam = event.url.searchParams.get("timeline") as
		| "weekly"
		| "monthly"
		| "yearly"
		| null;
	let timeline: Array<{ label: string; tokens: number }> | null = null;

	if (timelineParam && personalUsageRows.length > 0) {
		timeline = computeTimeline(personalUsageRows, timelineParam);
	}

	if (!isAdmin) {
		return json({
			personal,
			availableMonths,
			...(timeline ? { timeline } : {}),
		});
	}

	const system = {
		...(await summarize(systemFilteredUsage, systemFilteredConversations)),
		totalUsers: new Set([
			...systemFilteredUsage.map((row) => row.userId),
			...systemFilteredConversations.map((row) => row.userId),
		]).size,
		totalConversations: new Set(
			systemFilteredConversations.map((row) => row.conversationId),
		).size,
	};

	const userIds = new Set([
		...systemFilteredUsage.map((row) => row.userId),
		...systemFilteredConversations.map((row) => row.userId),
	]);
	const perUser = (
		await Promise.all(
			[...userIds].map(async (userId) => {
				const rows = systemFilteredUsage.filter((row) => row.userId === userId);
				const convRows = systemFilteredConversations.filter(
					(row) => row.userId === userId,
				);
				const summary = await summarize(rows, convRows);
				const latestSnapshot = rows[rows.length - 1] ?? null;
				const latestConversationSnapshot =
					convRows[convRows.length - 1] ?? null;
				return {
					userId,
					displayName:
						latestSnapshot?.userName ??
						latestConversationSnapshot?.userName ??
						latestSnapshot?.userEmail ??
						latestConversationSnapshot?.userEmail ??
						userId,
					email:
						latestSnapshot?.userEmail ??
						latestConversationSnapshot?.userEmail ??
						"",
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

	return json({
		personal,
		system,
		perUser,
		availableMonths,
		systemAvailableMonths,
	});
};
