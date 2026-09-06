import * as crypto from "node:crypto";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { getProviderIdFromModelId, isProviderModelId } from "$lib/model-types";
import type { SessionUser } from "$lib/server/services/auth-types";
import { getConfig } from "../config-store";
import { db } from "../db";
import {
	activityEvents,
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
	// Input tokens of the LAST model step only (promptTokens sums every step
	// of a multi-step tool loop). This is the size of the prompt the model
	// actually saw at the end of the turn, which is what the context usage
	// ring reports. Not billed separately.
	lastStepPromptTokens?: number;
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
	// ADR-0042 amendment — server stream-timeline marks (ms elapsed since turn
	// start, measured server-side; NOT browser-network-inclusive). Optional:
	// a turn with no reasoning has no firstThinkingMs, and a stopped/errored
	// turn only carries whichever marks it reached before it ended.
	firstByteMs?: number;
	firstThinkingMs?: number;
	firstTokenMs?: number;
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
	// Analytics overhaul (backend half) — admin-only narrowing filters over
	// the system/tools/commandsAndSkills/latencyByPromptBucket sections.
	// Ignored for a non-admin caller (only their own personal section is ever
	// returned regardless).
	userId?: string | null;
	modelId?: string | null;
	providerId?: string | null;
}

// A modelId that no longer resolves to an enabled providers/provider_models
// pair — the model was deleted (or its provider was) since the calls that
// reference it were recorded — surfaces as "removed" rather than silently
// dropping from the breakdown. "disabled" is a model/provider that still
// exists but is turned off. Built-in "model1"/"model2" are always "active"
// (they're config-driven, not rows in provider_models).
export type ModelAvailability = "active" | "disabled" | "removed";

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
	// Analytics overhaul (backend half) — resolved against the CURRENT
	// providers/provider_models tables at read time, so an admin can tell a
	// still-billable model apart from one that only appears because of
	// historical usage_events rows.
	availability?: ModelAvailability;
	// Average reasoning-token count and first-token/generation-time
	// percentiles for this model's messages, joined from message_analytics
	// by message_id. Undefined fields mean no message_analytics rows joined
	// (e.g. every call predates the ADR-0042 timing marks); a present field
	// with value `null` means rows joined but none carried that mark.
	avgReasoningTokens?: number;
	firstTokenP50Ms?: number | null;
	firstTokenP90Ms?: number | null;
	generationP50Ms?: number | null;
}

export interface ToolActivitySummary {
	name: string;
	calls: number;
	failed: number;
	cached: number;
	p50DurationMs: number | null;
}

export type CommandOrSkillActivityKind = Exclude<
	(typeof activityEvents.$inferSelect)["kind"],
	"tool_call"
>;

export interface CommandOrSkillActivitySummary {
	kind: CommandOrSkillActivityKind;
	name: string;
	count: number;
}

export const PROMPT_TOKEN_BUCKETS = [
	"<10k",
	"10-30k",
	"30-60k",
	"60-120k",
	">120k",
] as const;
export type PromptTokenBucket = (typeof PROMPT_TOKEN_BUCKETS)[number];

export interface LatencyPromptBucketSummary {
	bucket: PromptTokenBucket;
	n: number;
	firstTokenP50Ms: number | null;
	firstTokenP90Ms: number | null;
	reasoningTokensMedian: number | null;
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
	// Analytics overhaul (backend half) — admin-only, alongside `system`.
	// Honour the same month/userId/modelId/providerId/excludedUserIds
	// filters as `system` does.
	tools?: ToolActivitySummary[];
	commandsAndSkills?: CommandOrSkillActivitySummary[];
	latencyByPromptBucket?: LatencyPromptBucketSummary[];
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

// Nearest-rank percentile over an ALREADY ascending-sorted array. Returns
// null for an empty input (no data to report) rather than 0, which would
// misleadingly read as "measured, and it's instant".
function percentile(sortedAscending: number[], p: number): number | null {
	if (sortedAscending.length === 0) return null;
	const rank = Math.ceil((p / 100) * sortedAscending.length);
	const index = Math.min(sortedAscending.length - 1, Math.max(0, rank - 1));
	return sortedAscending[index];
}

function sortedNumbers(values: number[]): number[] {
	return [...values].sort((left, right) => left - right);
}

// Parses the provider/model ids out of a "provider:<providerId>:<modelUuid>"
// (current) or legacy "provider:<providerId>" modelId. Distinct from
// model-types.ts's getProviderIdFromModelId, which — despite its name —
// returns the MODEL uuid (parts[2]) for the 3-part form; this helper is the
// one both availability resolution and providerId filtering need.
function parseProviderModelId(
	modelId: string,
): { providerId: string; modelUuid: string | null } | null {
	if (!modelId.startsWith("provider:")) return null;
	const parts = modelId.slice("provider:".length).split(":");
	if (parts.length >= 2 && parts[0] && parts[1]) {
		return { providerId: parts[0], modelUuid: parts[1] };
	}
	if (parts.length === 1 && parts[0]) {
		return { providerId: parts[0], modelUuid: null };
	}
	return null;
}

interface AvailabilityContext {
	providersById: Map<string, typeof providers.$inferSelect>;
	providerModelsById: Map<string, typeof providerModels.$inferSelect>;
}

async function loadAvailabilityContext(): Promise<AvailabilityContext> {
	const [providerRows, providerModelRows] = await Promise.all([
		db.select().from(providers),
		db.select().from(providerModels),
	]);
	return {
		providersById: new Map(providerRows.map((row) => [row.id, row])),
		providerModelsById: new Map(providerModelRows.map((row) => [row.id, row])),
	};
}

function resolveModelAvailability(
	modelId: string,
	context: AvailabilityContext,
): ModelAvailability {
	if (modelId === "model1" || modelId === "model2") return "active";
	const parsed = parseProviderModelId(modelId);
	if (!parsed) return "active";

	if (parsed.modelUuid) {
		const modelRow = context.providerModelsById.get(parsed.modelUuid);
		if (!modelRow) return "removed";
		const providerRow = context.providersById.get(parsed.providerId);
		if (!providerRow || providerRow.enabled !== 1 || modelRow.enabled !== 1) {
			return "disabled";
		}
		return "active";
	}

	// Legacy 2-part id, predating per-model rows: only the provider can be
	// checked.
	const providerRow = context.providersById.get(parsed.providerId);
	if (!providerRow) return "removed";
	return providerRow.enabled === 1 ? "active" : "disabled";
}

type MessageAnalyticsRow = typeof messageAnalytics.$inferSelect;

// SQLite's compiled bound-parameter ceiling is well above this, but a single
// enormous IN list is slower to plan than a handful of smaller ones.
const MESSAGE_ANALYTICS_ID_CHUNK = 400;
// Past this many ids the id list has stopped being a narrowing (it is most of
// the table), so one sequential scan beats N indexed lookups.
const MESSAGE_ANALYTICS_FULL_SCAN_THRESHOLD = 4_000;

// message_analytics is joined to usage_events by message_id, so the only rows
// this read model can ever use are the ones belonging to the usage rows that
// survived the month window (and the admin user/model/provider filters). Push
// that set into the WHERE instead of reading the whole table on every GET —
// the id set IS the month window, expressed exactly, and does not rely on
// message_analytics.created_at agreeing with usage_events.billing_month.
// `null` means "no narrowing available"; fall back to the whole table.
async function loadMessageAnalyticsById(
	messageIds: string[] | null,
): Promise<Map<string, MessageAnalyticsRow>> {
	if (messageIds !== null && messageIds.length === 0) return new Map();

	const rows: MessageAnalyticsRow[] = [];
	if (
		messageIds === null ||
		messageIds.length > MESSAGE_ANALYTICS_FULL_SCAN_THRESHOLD
	) {
		rows.push(...(await db.select().from(messageAnalytics)));
	} else {
		for (
			let offset = 0;
			offset < messageIds.length;
			offset += MESSAGE_ANALYTICS_ID_CHUNK
		) {
			const chunk = messageIds.slice(
				offset,
				offset + MESSAGE_ANALYTICS_ID_CHUNK,
			);
			rows.push(
				...(await db
					.select()
					.from(messageAnalytics)
					.where(inArray(messageAnalytics.messageId, chunk))),
			);
		}
	}
	return new Map(rows.map((row) => [row.messageId, row]));
}

// The UTC half-open range covering a "YYYY-MM" billing month, matching
// toBillingMonth (which slices a UTC ISO string). Returns null for anything
// that is not a well-formed month, so a garbage filter narrows to nothing
// rather than silently widening to everything.
function billingMonthRange(month: string): { start: Date; end: Date } | null {
	const match = /^(\d{4})-(\d{2})$/.exec(month);
	if (!match) return null;
	const year = Number(match[1]);
	const monthIndex = Number(match[2]) - 1;
	if (monthIndex < 0 || monthIndex > 11) return null;
	return {
		start: new Date(Date.UTC(year, monthIndex, 1)),
		end: new Date(Date.UTC(year, monthIndex + 1, 1)),
	};
}

// activity_events feeds ONLY the admin-only tools/commandsAndSkills sections,
// so a non-admin caller never queries it at all (see the call site). For an
// admin the month window and the userId filter are pushed into the WHERE
// rather than applied to a whole-table read; the remaining narrowings
// (excluded users, modelId, providerId) stay in memory because they need the
// alias→provider resolution below.
async function loadActivityEventRows(params: {
	month: string | null;
	userId: string | null;
}): Promise<ActivityEventRow[]> {
	const conditions = [];
	if (params.month) {
		const range = billingMonthRange(params.month);
		if (!range) return [];
		conditions.push(
			gte(activityEvents.createdAt, range.start),
			lt(activityEvents.createdAt, range.end),
		);
	}
	if (params.userId) {
		conditions.push(eq(activityEvents.userId, params.userId));
	}
	const query = db.select().from(activityEvents);
	return conditions.length > 0 ? query.where(and(...conditions)) : query;
}

interface AnalyticsQueryContext {
	messageAnalyticsById: Map<string, MessageAnalyticsRow>;
	availability: AvailabilityContext;
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

async function modelBreakdown(
	rows: UsageRow[],
	context: AnalyticsQueryContext,
) {
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

	// Analytics overhaul (backend half) — availability + latency/reasoning
	// stats, joined by message_id from message_analytics and batched per
	// model rather than per row.
	const latencyByModel = new Map<
		string,
		{
			firstTokenMs: number[];
			generationMs: number[];
			reasoningTokens: number[];
		}
	>();
	for (const row of rows) {
		const messageAnalyticsRow = context.messageAnalyticsById.get(row.messageId);
		if (!messageAnalyticsRow) continue;
		const bucket = latencyByModel.get(row.modelId) ?? {
			firstTokenMs: [],
			generationMs: [],
			reasoningTokens: [],
		};
		if (typeof messageAnalyticsRow.firstTokenMs === "number") {
			bucket.firstTokenMs.push(messageAnalyticsRow.firstTokenMs);
		}
		if (typeof messageAnalyticsRow.generationTimeMs === "number") {
			bucket.generationMs.push(messageAnalyticsRow.generationTimeMs);
		}
		if (typeof messageAnalyticsRow.reasoningTokens === "number") {
			bucket.reasoningTokens.push(messageAnalyticsRow.reasoningTokens);
		}
		latencyByModel.set(row.modelId, bucket);
	}

	return materializeUsageBreakdown(
		grouped,
		(left, right) => right.msgCount - left.msgCount,
	).map((entry) => {
		const latency = latencyByModel.get(entry.model);
		return {
			...entry,
			availability: resolveModelAvailability(entry.model, context.availability),
			// Undefined (not 0) when no message_analytics row joined for this
			// model at all — the documented contract on AnalyticsByModelRow, so
			// the admin table blanks the cell instead of printing a zero that
			// reads as "measured, and it's none".
			avgReasoningTokens:
				latency && latency.reasoningTokens.length > 0
					? average(latency.reasoningTokens)
					: undefined,
			firstTokenP50Ms: percentile(
				sortedNumbers(latency?.firstTokenMs ?? []),
				50,
			),
			firstTokenP90Ms: percentile(
				sortedNumbers(latency?.firstTokenMs ?? []),
				90,
			),
			generationP50Ms: percentile(
				sortedNumbers(latency?.generationMs ?? []),
				50,
			),
		};
	});
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
	context: AnalyticsQueryContext,
): Promise<PersonalAnalytics> {
	const [byModel, byProvider] = await Promise.all([
		modelBreakdown(rows, context),
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

type ActivityEventRow = typeof activityEvents.$inferSelect;

// Analytics overhaul (backend half) — per-tool call/failure/cache counts and
// duration percentile, from activity_events rows already narrowed to the
// caller's filters.
function buildToolsSummary(rows: ActivityEventRow[]): ToolActivitySummary[] {
	const grouped = new Map<
		string,
		{ calls: number; failed: number; cached: number; durations: number[] }
	>();
	for (const row of rows) {
		if (row.kind !== "tool_call") continue;
		const current = grouped.get(row.name) ?? {
			calls: 0,
			failed: 0,
			cached: 0,
			durations: [],
		};
		current.calls += 1;
		if (row.status === "failed") current.failed += 1;
		if (row.status === "cached") current.cached += 1;
		if (typeof row.durationMs === "number")
			current.durations.push(row.durationMs);
		grouped.set(row.name, current);
	}
	return [...grouped.entries()]
		.map(([name, stats]) => ({
			name,
			calls: stats.calls,
			failed: stats.failed,
			cached: stats.cached,
			p50DurationMs: percentile(sortedNumbers(stats.durations), 50),
		}))
		.sort((left, right) => right.calls - left.calls);
}

// Analytics overhaul (backend half) — per (kind, name) counts for every
// non-tool-call activity kind (skill_use, composer_command, follow_up_click,
// answer_now).
function buildCommandsAndSkillsSummary(
	rows: ActivityEventRow[],
): CommandOrSkillActivitySummary[] {
	const grouped = new Map<
		string,
		{ kind: CommandOrSkillActivityKind; name: string; count: number }
	>();
	for (const row of rows) {
		if (row.kind === "tool_call") continue;
		const kind = row.kind as CommandOrSkillActivityKind;
		const key = `${kind}:${row.name}`;
		const current = grouped.get(key) ?? { kind, name: row.name, count: 0 };
		current.count += 1;
		grouped.set(key, current);
	}
	return [...grouped.values()].sort((left, right) => right.count - left.count);
}

const PROMPT_TOKEN_BUCKET_BOUNDS: Array<{
	bucket: PromptTokenBucket;
	min: number;
	max: number | null;
}> = [
	{ bucket: "<10k", min: 0, max: 10_000 },
	{ bucket: "10-30k", min: 10_000, max: 30_000 },
	{ bucket: "30-60k", min: 30_000, max: 60_000 },
	{ bucket: "60-120k", min: 60_000, max: 120_000 },
	{ bucket: ">120k", min: 120_000, max: null },
];

function promptTokenBucketFor(promptTokens: number): PromptTokenBucket {
	for (const bound of PROMPT_TOKEN_BUCKET_BOUNDS) {
		if (
			promptTokens >= bound.min &&
			(bound.max === null || promptTokens < bound.max)
		) {
			return bound.bucket;
		}
	}
	return PROMPT_TOKEN_BUCKET_BOUNDS[PROMPT_TOKEN_BUCKET_BOUNDS.length - 1]
		.bucket;
}

// Analytics overhaul (backend half) — latency/reasoning stats bucketed by
// each message's prompt-token count (from message_analytics), for the
// usage_events rows the caller has already filtered down to.
function buildLatencyByPromptBucket(
	usageRows: UsageRow[],
	messageAnalyticsById: Map<string, MessageAnalyticsRow>,
): LatencyPromptBucketSummary[] {
	const buckets = new Map<
		PromptTokenBucket,
		{ n: number; firstTokenMs: number[]; reasoningTokens: number[] }
	>();
	for (const row of usageRows) {
		const messageAnalyticsRow = messageAnalyticsById.get(row.messageId);
		if (
			!messageAnalyticsRow ||
			typeof messageAnalyticsRow.promptTokens !== "number"
		) {
			continue;
		}
		const bucketId = promptTokenBucketFor(messageAnalyticsRow.promptTokens);
		const bucket = buckets.get(bucketId) ?? {
			n: 0,
			firstTokenMs: [],
			reasoningTokens: [],
		};
		bucket.n += 1;
		if (typeof messageAnalyticsRow.firstTokenMs === "number") {
			bucket.firstTokenMs.push(messageAnalyticsRow.firstTokenMs);
		}
		if (typeof messageAnalyticsRow.reasoningTokens === "number") {
			bucket.reasoningTokens.push(messageAnalyticsRow.reasoningTokens);
		}
		buckets.set(bucketId, bucket);
	}

	return PROMPT_TOKEN_BUCKET_BOUNDS.map(({ bucket: bucketId }) => {
		const bucket = buckets.get(bucketId);
		return {
			bucket: bucketId,
			n: bucket?.n ?? 0,
			firstTokenP50Ms: percentile(
				sortedNumbers(bucket?.firstTokenMs ?? []),
				50,
			),
			firstTokenP90Ms: percentile(
				sortedNumbers(bucket?.firstTokenMs ?? []),
				90,
			),
			reasoningTokensMedian: percentile(
				sortedNumbers(bucket?.reasoningTokens ?? []),
				50,
			),
		};
	});
}

export async function getAnalyticsDashboardReadModel({
	user,
	mock = false,
	month = null,
	systemMonth = null,
	timeline = null,
	excludedUserIds = [],
	userId: userIdFilter = null,
	modelId: modelIdFilter = null,
	providerId: providerIdFilter = null,
}: AnalyticsDashboardReadParams): Promise<AnalyticsDashboardReadModel> {
	const isAdmin = user.role === "admin";

	if (mock) {
		return isAdmin ? MOCK_ANALYTICS : { personal: MOCK_ANALYTICS.personal };
	}

	const systemMonthParam = isAdmin ? (systemMonth ?? month) : null;

	const [usageRows, conversationRows, activityRows, availability] =
		await Promise.all([
			db.select().from(usageEvents),
			db.select().from(analyticsConversations),
			// activity_events only ever feeds admin-only sections, and its
			// month/user narrowing is done in SQL — a non-admin request does not
			// touch the table at all.
			isAdmin
				? loadActivityEventRows({
						month: systemMonthParam,
						userId: userIdFilter,
					})
				: Promise.resolve<ActivityEventRow[]>([]),
			loadAvailabilityContext(),
		]);

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
	// The month window and the userId filter were already applied in SQL by
	// loadActivityEventRows; only the narrowings that need in-process
	// resolution are left below.
	let systemFilteredActivity = activityRows;

	if (isAdmin && excludedSet.size > 0) {
		systemFilteredUsage = systemFilteredUsage.filter(
			(row) => !excludedSet.has(row.userId),
		);
		systemFilteredConversations = systemFilteredConversations.filter(
			(row) => !excludedSet.has(row.userId),
		);
		systemFilteredActivity = systemFilteredActivity.filter(
			(row) => !excludedSet.has(row.userId),
		);
	}

	// Admin-only narrowing filters (Analytics overhaul, backend half). A
	// non-admin caller never sees the system/tools/commandsAndSkills/
	// latencyByPromptBucket sections at all, so these are no-ops for them.
	if (isAdmin && userIdFilter) {
		systemFilteredUsage = systemFilteredUsage.filter(
			(row) => row.userId === userIdFilter,
		);
		systemFilteredConversations = systemFilteredConversations.filter(
			(row) => row.userId === userIdFilter,
		);
	}
	if (isAdmin && modelIdFilter) {
		systemFilteredUsage = systemFilteredUsage.filter(
			(row) => row.modelId === modelIdFilter,
		);
		systemFilteredActivity = systemFilteredActivity.filter(
			(row) => row.modelId === modelIdFilter,
		);
	}
	if (isAdmin && providerIdFilter) {
		systemFilteredUsage = systemFilteredUsage.filter(
			(row) => row.providerId === providerIdFilter,
		);
		systemFilteredActivity = systemFilteredActivity.filter(
			(row) =>
				parseProviderModelId(row.modelId ?? "")?.providerId ===
				providerIdFilter,
		);
	}

	// Only the usage rows that survived the filters above can ever join
	// message_analytics, so the id set is loaded now that they are known —
	// instead of reading the whole table before any narrowing exists.
	const neededMessageIds = new Set(
		personalUsageRows.map((row) => row.messageId),
	);
	if (isAdmin) {
		for (const row of systemFilteredUsage) neededMessageIds.add(row.messageId);
	}
	const queryContext: AnalyticsQueryContext = {
		messageAnalyticsById: await loadMessageAnalyticsById([...neededMessageIds]),
		availability,
	};

	const systemAvailableMonths = isAdmin
		? monthlyBreakdown(usageRows).map((row) => row.month)
		: undefined;
	const personal = await summarize(
		personalUsageRows,
		personalConversationRows,
		queryContext,
	);
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
		queryContext,
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
	const tools = buildToolsSummary(systemFilteredActivity);
	const commandsAndSkills = buildCommandsAndSkillsSummary(
		systemFilteredActivity,
	);
	const latencyByPromptBucket = buildLatencyByPromptBucket(
		systemFilteredUsage,
		queryContext.messageAnalyticsById,
	);

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
				const summary = await summarize(
					rows,
					conversationRowsForUser,
					queryContext,
				);
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
		tools,
		commandsAndSkills,
		latencyByPromptBucket,
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

// ADR-0042 amendment — a stream-timeline mark is observability, never a turn
// input: any non-finite/negative/non-number value degrades to null (the
// column is nullable) instead of throwing or coercing to a misleading 0.
function normalizeTimingMs(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return null;
	}
	return Math.round(value);
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
	// Provider-reported completion tokens already include reasoning: the AI
	// SDK's `usage.outputTokens` is "the number of total output (completion)
	// tokens" and `outputTokenDetails.reasoningTokens` is a breakdown of that
	// figure (normal-chat-model/index.ts maps outputTokens -> completionTokens
	// and never reports reasoningTokens separately). So when the provider gave
	// a completion count, total = prompt + completion. Reasoning is only added
	// on top when completionTokens is our own visible-text estimate, which
	// excludes the thinking stream (stream-completion.ts counts the two
	// separately), or when the provider explicitly reported reasoning tokens
	// alongside an estimated completion count.
	const completionIncludesReasoning =
		typeof providerUsage?.completionTokens === "number";
	const totalTokens =
		normalizeCount(providerUsage?.totalTokens) ||
		promptTokens +
			completionTokens +
			(completionIncludesReasoning ? 0 : reasoningTokens);
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
			// ADR-0042 amendment — observability only: a missing/invalid mark
			// degrades to null rather than throwing or blocking this insert.
			firstByteMs: normalizeTimingMs(params.firstByteMs),
			firstThinkingMs: normalizeTimingMs(params.firstThinkingMs),
			firstTokenMs: normalizeTimingMs(params.firstTokenMs),
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

// P2 (ADR-0056) — spend for an auxiliary chat-turn control-model call (the
// instant-acknowledgment classifier; any future classifier sharing this
// shape, e.g. P3's, reuses this same function). These calls are not the
// turn's main model run and are not tied to a persisted assistant message,
// so — mirroring recordParallelUsage above — they get a synthetic,
// feature-prefixed messageId, unique per call, which can never collide with
// a real message row or another control-model call under the messageId
// unique index. Priced through the exact same resolver
// (findPriceRule/resolveEffectivePriceRule/calculateCostUsdMicros) as every
// other model call (ADR-0047). Best-effort: pricing/lookup failures are
// swallowed rather than surfaced, exactly like every other analytics writer
// here — never let cost accounting fail a turn.
export async function recordControlModelUsage(params: {
	userId: string;
	conversationId?: string | null;
	/** Cost-attribution tag folded into the synthetic messageId, e.g. "turn_acknowledgment". */
	feature: string;
	modelId: string;
	modelDisplayName?: string | null;
	promptTokens?: number;
	completionTokens?: number;
	totalTokens?: number;
	cachedInputTokens?: number;
	cacheHitTokens?: number;
	cacheMissTokens?: number;
}): Promise<void> {
	if (!params.userId) return;
	try {
		const promptTokens = normalizeCount(params.promptTokens);
		const completionTokens = normalizeCount(params.completionTokens);
		const cachedInputTokens = normalizeCount(params.cachedInputTokens);
		const cacheHitTokens = normalizeCount(params.cacheHitTokens);
		const cacheMissTokens = normalizeCount(params.cacheMissTokens);
		const totalTokens =
			normalizeCount(params.totalTokens) || promptTokens + completionTokens;

		const model = await getModelSnapshot(
			params.modelId,
			params.modelDisplayName,
		);
		const basePriceRule = await findPriceRule({
			modelId: params.modelId,
			providerId: model.providerId,
			providerModelName: model.providerModelName,
		});
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
			reasoningTokens: 0,
		});

		const conversationTitle = params.conversationId
			? (await getConversationSnapshot(params.userId, params.conversationId))
					.title
			: null;

		await db
			.insert(usageEvents)
			.values({
				id: crypto.randomUUID(),
				userId: params.userId,
				conversationId: params.conversationId ?? "",
				conversationTitle,
				messageId: `control:${params.feature}:${crypto.randomUUID()}`,
				modelId: params.modelId,
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
				reasoningTokens: 0,
				totalTokens,
				usageSource: "provider",
				generationTimeMs: null,
				billingMonth: toBillingMonth(),
				costUsdMicros,
				priceRuleId: priceRule?.id ?? null,
			})
			.onConflictDoNothing();
	} catch (error) {
		console.error("[ANALYTICS] Failed to record control-model usage", error);
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
