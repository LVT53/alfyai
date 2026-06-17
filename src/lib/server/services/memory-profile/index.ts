import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import {
	memoryDirtyLedger,
	memoryProfileItemProvenance,
	memoryProfileItems,
	memoryProjectionState,
	memoryResetGenerations,
	memoryReviewItems,
	memoryReviewResolutions,
	memoryReworkTelemetry,
	users,
} from "$lib/server/db/schema";
import { estimateTokenCount } from "$lib/utils/tokens";
import {
	getHonchoAssistantPeerId,
	getHonchoUserPeerId,
} from "../honcho-identifiers";
import { sendJsonControlMessage } from "../normal-chat-control-model";
import {
	type LegacyPersonaMemoryCandidateBatch,
	migrateLegacyMemoryForUser,
} from "./legacy";

export { migrateLegacyMemoryForUser } from "./legacy";

export const MEMORY_PROFILE_CATEGORIES = [
	"about_you",
	"preferences",
	"goals_ongoing_work",
	"constraints_boundaries",
] as const;
export const MEMORY_REVIEW_RESOLUTION_TYPES = [
	"use_fact",
	"edit_fact",
	"do_not_remember",
] as const;
export const MEMORY_DIRTY_REASONS = [
	"stale_projection",
	"deferred_intake",
	"profile_action_reconciliation",
	"possible_conflict",
	"possible_duplicate",
	"legacy_migration",
	"honcho_reconciliation",
	"review_generation",
] as const;
export const MEMORY_REWORK_TELEMETRY_FAMILIES = [
	"intake",
	"active_profile_projection",
	"prompt_use",
	"maintenance",
	"guided_review",
	"profile_action",
	"reset_forget",
	"error_fallback",
] as const;

export type MemoryProfileCategory = (typeof MEMORY_PROFILE_CATEGORIES)[number];
export type MemoryReviewResolutionType =
	(typeof MEMORY_REVIEW_RESOLUTION_TYPES)[number];
export type MemoryDirtyReason = (typeof MEMORY_DIRTY_REASONS)[number];
export type MemoryReworkTelemetryFamily =
	(typeof MEMORY_REWORK_TELEMETRY_FAMILIES)[number];
export type MemoryProfileScope =
	| { type: "global" }
	| { type: "project"; id: string }
	| { type: "conversation"; id: string }
	| { type: "document"; id: string };
export type MemoryProfileItemStatus =
	| "active"
	| "deleted"
	| "suppressed"
	| "expired"
	| "blocked"
	| "deferred"
	| "review_needed"
	| "preserved_legacy"
	| "inactive";

export type MemoryProfileCardItem = {
	id: string;
	itemKey: string;
	category: MemoryProfileCategory;
	statement: string;
	scope: MemoryProfileScope;
	status: "active";
	revision: number;
	updatedAt: Date;
	canEdit: boolean;
	canDelete: boolean;
	canSuppress: boolean;
};

export type MemoryProfileSourceChip = {
	id: string;
	sourceType: string;
	label: string;
	summary: string | null;
};

export type MemoryProfileItemDetail = MemoryProfileCardItem & {
	sourceChips: MemoryProfileSourceChip[];
	whyRemembered: string | null;
};

export type MemoryProfileReadModel = {
	resetGeneration: number;
	projectionRevision: number;
	categories: Array<{
		category: MemoryProfileCategory;
		items: MemoryProfileCardItem[];
	}>;
	review: {
		items: Array<{
			id: string;
			subject: string;
			question: string;
			reason: string;
			canAccept: boolean;
		}>;
		visibleItems: Array<{
			id: string;
			subject: string;
			question: string;
			reason: string;
			canAccept: boolean;
		}>;
		openCount: number;
		overflowCount: number;
	};
};

export type ActiveMemoryProfileContext = {
	resetGeneration: number;
	projectionRevision: number;
	items: Array<{
		id: string;
		itemKey: string;
		category: MemoryProfileCategory;
		statement: string;
		scope: MemoryProfileScope;
		revision: number;
		updatedAt: Date;
	}>;
};

export type FormattedActiveMemoryProfileContext = {
	content: string;
	includedCount: number;
	omittedCount: number;
	estimatedTokens: number;
	includedItemIds: string[];
};

export type MemoryDirtyLedgerReconciliationResult = {
	claimed: number;
	completed: number;
	failed: number;
	skipped: number;
	timedOut: boolean;
};

export type LegacyMemoryCandidateLoader = (
	userId: string,
	options: {
		limit: number;
		excludeSourceIds?: string[];
		startPage?: number;
		maxPages?: number;
	},
) => Promise<LegacyPersonaMemoryCandidateBatch>;

type JsonRecord = Record<string, unknown>;

export class StaleMemoryResetGenerationError extends Error {
	constructor() {
		super("Memory reset generation advanced before memory work could apply.");
		this.name = "StaleMemoryResetGenerationError";
	}
}

const ITEM_KEY_VERSION = "memory-profile-item:v1";

function toScopeColumns(scope: MemoryProfileScope): {
	scopeType: string;
	scopeId: string;
} {
	return {
		scopeType: scope.type,
		scopeId: scope.type === "global" ? "" : scope.id,
	};
}

function normalizeRememberedStatement(statement: string): string {
	return statement.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeExplicitItemKey(itemKey: string): string {
	const normalized = itemKey.trim();
	if (!normalized) {
		throw new Error("Memory profile item key cannot be empty.");
	}
	return normalized;
}

function deriveMemoryProfileItemKey(params: {
	category: MemoryProfileCategory;
	scope: MemoryProfileScope;
	statement: string;
}): string {
	const scope = toScopeColumns(params.scope);
	const normalizedStatement = normalizeRememberedStatement(params.statement);
	const digest = createHash("sha256")
		.update(
			[
				params.category,
				scope.scopeType,
				scope.scopeId,
				normalizedStatement,
			].join("\u001f"),
		)
		.digest("hex")
		.slice(0, 32);

	return `${ITEM_KEY_VERSION}:${params.category}:${scope.scopeType}:${scope.scopeId || "global"}:${digest}`;
}

function resolveMemoryProfileItemKey(params: {
	category: MemoryProfileCategory;
	scope: MemoryProfileScope;
	statement: string;
	itemKey?: string;
	slotKey?: string;
}): string {
	if (params.itemKey !== undefined && params.slotKey !== undefined) {
		const itemKey = normalizeExplicitItemKey(params.itemKey);
		const slotKey = normalizeExplicitItemKey(params.slotKey);
		if (itemKey !== slotKey) {
			throw new Error("Memory profile itemKey and slotKey must match.");
		}
		return itemKey;
	}
	if (params.itemKey !== undefined) {
		return normalizeExplicitItemKey(params.itemKey);
	}
	if (params.slotKey !== undefined) {
		return normalizeExplicitItemKey(params.slotKey);
	}
	return deriveMemoryProfileItemKey(params);
}

function fromScopeColumns(
	scopeType: string,
	scopeId: string,
): MemoryProfileScope {
	if (scopeType === "project") return { type: "project", id: scopeId };
	if (scopeType === "conversation")
		return { type: "conversation", id: scopeId };
	if (scopeType === "document") return { type: "document", id: scopeId };
	return { type: "global" };
}

function assertMemoryProfileCategory(
	category: string,
): asserts category is MemoryProfileCategory {
	if (!MEMORY_PROFILE_CATEGORIES.includes(category as MemoryProfileCategory)) {
		throw new Error(`Unsupported memory profile category: ${category}`);
	}
}

function assertOneOf<T extends readonly string[]>(
	value: string,
	allowed: T,
	label: string,
): asserts value is T[number] {
	if (!allowed.includes(value)) {
		throw new Error(`Unsupported ${label}: ${value}`);
	}
}

function isOneOf<T extends readonly string[]>(
	value: string,
	allowed: T,
): value is T[number] {
	return allowed.includes(value);
}

function parseJsonArray(value: string | null): unknown[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function parseJsonRecord(value: string | null): JsonRecord {
	if (!value) return {};
	try {
		const parsed = JSON.parse(value);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as JsonRecord;
		}
	} catch {
		// Fall through to an empty object.
	}
	return {};
}

function readMemoryProfileCategory(
	value: unknown,
): MemoryProfileCategory | null {
	return typeof value === "string" &&
		MEMORY_PROFILE_CATEGORIES.includes(value as MemoryProfileCategory)
		? (value as MemoryProfileCategory)
		: null;
}

function readSafeString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readSafePositiveInteger(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	const integer = Math.floor(value);
	return integer > 0 ? integer : null;
}

function stableMemoryMaintenanceDigest(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function formatActiveMemoryProfileItem(
	item: ActiveMemoryProfileContext["items"][number],
): string {
	const scope =
		item.scope.type === "global"
			? "global"
			: `${item.scope.type}:${item.scope.id}`;
	return `- ${item.category} (${scope}): ${item.statement}`;
}

function omittedActiveMemoryProfileLine(count: number): string {
	return `Omitted active memory profile items: ${count}.`;
}

function sortActiveMemoryProfileItemsNewestFirst(
	items: ActiveMemoryProfileContext["items"],
): ActiveMemoryProfileContext["items"] {
	return [...items].sort((left, right) => {
		const updatedDelta = right.updatedAt.getTime() - left.updatedAt.getTime();
		if (updatedDelta !== 0) return updatedDelta;
		return right.id.localeCompare(left.id);
	});
}

export function formatActiveMemoryProfileContextForPrompt(
	context: ActiveMemoryProfileContext,
	options: { maxTokens: number },
): FormattedActiveMemoryProfileContext {
	const maxTokens = Math.max(0, Math.floor(options.maxTokens));
	const orderedItems = sortActiveMemoryProfileItemsNewestFirst(context.items);
	const lines: string[] = [];
	const includedItemIds: string[] = [];
	let omittedCount = 0;

	for (const item of orderedItems) {
		const line = formatActiveMemoryProfileItem(item);
		const candidateLines = [...lines, line];
		const remainingIfIncluded =
			orderedItems.length - includedItemIds.length - 1;
		let candidateFits =
			estimateTokenCount(candidateLines.join("\n")) <= maxTokens;
		if (candidateFits && remainingIfIncluded > 0) {
			const omittedLine = omittedActiveMemoryProfileLine(remainingIfIncluded);
			const fullCandidate = [...candidateLines, omittedLine].join("\n");
			const compactCandidate = [
				...candidateLines,
				`Omitted: ${remainingIfIncluded}.`,
			].join("\n");
			candidateFits =
				estimateTokenCount(fullCandidate) <= maxTokens ||
				estimateTokenCount(compactCandidate) <= maxTokens;
		}
		if (!candidateFits) {
			omittedCount += 1;
			continue;
		}
		lines.push(line);
		includedItemIds.push(item.id);
	}

	if (omittedCount > 0) {
		const omittedLine = omittedActiveMemoryProfileLine(omittedCount);
		const compactOmittedLine = `Omitted: ${omittedCount}.`;
		if (estimateTokenCount([...lines, omittedLine].join("\n")) <= maxTokens) {
			lines.push(omittedLine);
		} else if (
			estimateTokenCount([...lines, compactOmittedLine].join("\n")) <= maxTokens
		) {
			lines.push(compactOmittedLine);
		} else if (lines.length === 0) {
			lines.push(
				estimateTokenCount(omittedLine) <= maxTokens
					? omittedLine
					: compactOmittedLine,
			);
		}
	}

	const content = lines.join("\n");
	return {
		content,
		includedCount: includedItemIds.length,
		omittedCount,
		estimatedTokens: estimateTokenCount(content),
		includedItemIds,
	};
}

function inferReviewCategory(params: {
	subject: string;
	question: string;
	reason: string;
	metadata: JsonRecord;
}): MemoryProfileCategory {
	const explicitCategory = readMemoryProfileCategory(params.metadata.category);
	if (explicitCategory) return explicitCategory;

	const text =
		`${params.subject} ${params.question} ${params.reason}`.toLowerCase();
	if (
		/\b(avoid|never|must|constraint|boundary|do not|don't|dont|privacy|sensitive)\b/.test(
			text,
		)
	) {
		return "constraints_boundaries";
	}
	if (/\b(goal|ongoing|working on|project|roadmap|todo)\b/.test(text)) {
		return "goals_ongoing_work";
	}
	if (
		/\b(prefer|prefers|preference|likes|style|language|ui|labels)\b/.test(text)
	) {
		return "preferences";
	}
	return "about_you";
}

function readReviewProposedStatement(metadata: JsonRecord): string | null {
	const proposedStatement = metadata.proposedStatement;
	if (typeof proposedStatement !== "string") return null;
	const trimmed = proposedStatement.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function normalizeReviewDeduplicationText(value: string): string {
	return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function legacyReviewSubjectKey(params: {
	category: MemoryProfileCategory;
	statement: string;
}): string {
	return `legacy-memory-curation:${stableMemoryMaintenanceDigest(
		`${params.category}\u001f${normalizeReviewDeduplicationText(params.statement)}`,
	)}`;
}

function sanitizePublicMemoryText(
	text: string,
	sanitizer: MemoryProfileTextSanitizer,
): string {
	return sanitizer(text);
}

type MemoryProfileTextSanitizer = (text: string) => string;

function createIdentityTextSanitizer(params: {
	userId: string;
	displayName: string;
	honchoPeerVersion: number;
}): MemoryProfileTextSanitizer {
	const replacement = params.displayName.trim() || "the user";
	const candidateIds = new Set<string>([
		params.userId,
		getHonchoUserPeerId(params.userId, params.honchoPeerVersion),
		getHonchoAssistantPeerId(params.userId, params.honchoPeerVersion),
		getHonchoUserPeerId(params.userId, 0),
		getHonchoAssistantPeerId(params.userId, 0),
	]);
	const broadLegacyPeerIdPattern = /\b[UuAa][_-][A-Za-z0-9_-]{8,}\b/g;

	return (text: string) => {
		let sanitized = text.trim();
		for (const candidateId of candidateIds) {
			if (!candidateId) continue;
			sanitized = sanitized.split(candidateId).join(replacement);
		}
		return sanitized
			.replace(broadLegacyPeerIdPattern, replacement)
			.replace(/\s+/g, " ")
			.trim();
	};
}

async function getMemoryProfileIdentity(userId: string): Promise<{
	displayName: string;
	honchoPeerVersion: number;
}> {
	const [user] = await db
		.select({
			name: users.name,
			honchoPeerVersion: users.honchoPeerVersion,
		})
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	return {
		displayName: user?.name?.trim() || "the user",
		honchoPeerVersion: user?.honchoPeerVersion ?? 0,
	};
}

function toPublicReviewItem(
	row: typeof memoryReviewItems.$inferSelect,
	sanitizer: MemoryProfileTextSanitizer,
) {
	const metadata = parseJsonRecord(row.metadataJson);
	const proposedStatement = readReviewProposedStatement(metadata);
	return {
		id: row.id,
		subject: sanitizePublicMemoryText(
			proposedStatement ?? row.subjectLabel,
			sanitizer,
		),
		question: sanitizePublicMemoryText(row.question, sanitizer),
		reason: sanitizePublicMemoryText(row.reason, sanitizer),
		canAccept: proposedStatement !== null,
	};
}

function reviewDeduplicationKey(
	row: typeof memoryReviewItems.$inferSelect,
): string {
	const metadata = parseJsonRecord(row.metadataJson);
	const proposedStatement = readReviewProposedStatement(metadata);
	const category =
		readMemoryProfileCategory(metadata.category) ?? "uncategorized";
	return [
		category,
		normalizeReviewDeduplicationText(proposedStatement ?? row.subjectLabel),
	].join("\u001f");
}

function dedupeReviewRows(
	rows: Array<typeof memoryReviewItems.$inferSelect>,
): Array<typeof memoryReviewItems.$inferSelect> {
	const deduped = new Map<string, typeof memoryReviewItems.$inferSelect>();
	for (const row of rows) {
		const key = reviewDeduplicationKey(row);
		if (!deduped.has(key)) {
			deduped.set(key, row);
		}
	}
	return [...deduped.values()];
}

function assertPrivacySafeMetadata(metadata: JsonRecord | undefined): void {
	if (!metadata) return;
	const forbiddenFragments = [
		"rawtext",
		"rawmemory",
		"rememberedtext",
		"rawprompt",
		"promptexcerpt",
		"rawchat",
		"chatexcerpt",
	];

	const visit = (value: unknown, path: string[]): void => {
		if (!value || typeof value !== "object") return;
		if (Array.isArray(value)) {
			value.forEach((entry, index) => {
				visit(entry, [...path, String(index)]);
			});
			return;
		}
		for (const [key, nested] of Object.entries(value)) {
			const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
			if (
				forbiddenFragments.some((fragment) => normalized.includes(fragment))
			) {
				throw new Error(
					`Memory profile metadata cannot include raw text field: ${[...path, key].join(".")}`,
				);
			}
			visit(nested, [...path, key]);
		}
	};

	visit(metadata, []);
}

function toCardItem(
	row: typeof memoryProfileItems.$inferSelect,
	sanitizer: MemoryProfileTextSanitizer,
): MemoryProfileCardItem {
	assertMemoryProfileCategory(row.category);
	return {
		id: row.id,
		itemKey: row.itemKey,
		category: row.category,
		statement: sanitizePublicMemoryText(row.statement, sanitizer),
		scope: fromScopeColumns(row.scopeType, row.scopeId),
		status: "active",
		revision: row.revision,
		updatedAt: row.updatedAt,
		canEdit: true,
		canDelete: true,
		canSuppress: true,
	};
}

async function ensureMemoryResetGenerationRow(userId: string): Promise<void> {
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
}

export async function getCurrentMemoryResetGeneration(
	userId: string,
): Promise<number> {
	await ensureMemoryResetGenerationRow(userId);

	const [row] = await db
		.select({ resetGeneration: memoryResetGenerations.resetGeneration })
		.from(memoryResetGenerations)
		.where(eq(memoryResetGenerations.userId, userId))
		.limit(1);

	return row?.resetGeneration ?? 0;
}

export async function advanceMemoryResetGeneration(
	userId: string,
): Promise<number> {
	await ensureMemoryResetGenerationRow(userId);
	const now = new Date();

	await db
		.update(memoryResetGenerations)
		.set({
			resetGeneration: sql`${memoryResetGenerations.resetGeneration} + 1`,
			advancedAt: now,
			updatedAt: now,
		})
		.where(eq(memoryResetGenerations.userId, userId))
		.run();

	return getCurrentMemoryResetGeneration(userId);
}

export async function isCurrentMemoryResetGeneration(params: {
	userId: string;
	resetGeneration: number;
}): Promise<boolean> {
	return (
		(await getCurrentMemoryResetGeneration(params.userId)) ===
		params.resetGeneration
	);
}

export function isStaleMemoryResetGenerationError(
	error: unknown,
): error is StaleMemoryResetGenerationError {
	return error instanceof StaleMemoryResetGenerationError;
}

async function assertExpectedMemoryResetGeneration(params: {
	userId: string;
	expectedResetGeneration?: number;
}): Promise<number> {
	if (params.expectedResetGeneration === undefined) {
		return getCurrentMemoryResetGeneration(params.userId);
	}
	if (
		!(await isCurrentMemoryResetGeneration({
			userId: params.userId,
			resetGeneration: params.expectedResetGeneration,
		}))
	) {
		throw new StaleMemoryResetGenerationError();
	}
	return params.expectedResetGeneration;
}

async function ensureProjectionState(params: {
	userId: string;
	resetGeneration: number;
	scope?: MemoryProfileScope;
}): Promise<typeof memoryProjectionState.$inferSelect> {
	const scope = toScopeColumns(params.scope ?? { type: "global" });
	await db
		.insert(memoryProjectionState)
		.values({
			id: randomUUID(),
			userId: params.userId,
			resetGeneration: params.resetGeneration,
			scopeType: scope.scopeType,
			scopeId: scope.scopeId,
			createdAt: new Date(),
			updatedAt: new Date(),
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

	const [row] = await db
		.select()
		.from(memoryProjectionState)
		.where(
			and(
				eq(memoryProjectionState.userId, params.userId),
				eq(memoryProjectionState.resetGeneration, params.resetGeneration),
				eq(memoryProjectionState.scopeType, scope.scopeType),
				eq(memoryProjectionState.scopeId, scope.scopeId),
			),
		)
		.limit(1);
	if (!row) {
		throw new Error("Memory projection state could not be initialized.");
	}
	return row;
}

async function expireOverdueActiveMemoryProfileItems(params: {
	userId: string;
	resetGeneration: number;
	projectionStateId: string;
	now?: Date;
}): Promise<number> {
	const now = params.now ?? new Date();
	const result = (await db
		.update(memoryProfileItems)
		.set({
			status: "expired",
			updatedAt: now,
		})
		.where(
			and(
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.resetGeneration, params.resetGeneration),
				eq(memoryProfileItems.status, "active"),
				lt(memoryProfileItems.expiresAt, now),
			),
		)
		.run()) as { changes?: number };
	const expiredCount = result.changes ?? 0;
	if (expiredCount > 0) {
		await db
			.update(memoryProjectionState)
			.set({
				revision: sql`${memoryProjectionState.revision} + ${expiredCount}`,
				updatedAt: now,
			})
			.where(eq(memoryProjectionState.id, params.projectionStateId))
			.run();
	}
	return expiredCount;
}

export async function createMemoryProfileItem(params: {
	userId: string;
	category: MemoryProfileCategory;
	scope: MemoryProfileScope;
	statement: string;
	itemKey?: string;
	slotKey?: string;
	status?: MemoryProfileItemStatus;
	expectedResetGeneration?: number;
}): Promise<{
	id: string;
	itemKey: string;
	status: MemoryProfileItemStatus;
	revision: number;
	resetGeneration: number;
	projectionRevision: number;
}> {
	const resetGeneration = await assertExpectedMemoryResetGeneration({
		userId: params.userId,
		expectedResetGeneration: params.expectedResetGeneration,
	});
	const projection = await ensureProjectionState({
		userId: params.userId,
		resetGeneration,
	});
	const scope = toScopeColumns(params.scope);
	const itemKey = resolveMemoryProfileItemKey(params);
	const now = new Date();
	const item = {
		id: randomUUID(),
		userId: params.userId,
		projectionStateId: projection.id,
		resetGeneration,
		itemKey,
		category: params.category,
		scopeType: scope.scopeType,
		scopeId: scope.scopeId,
		statement: params.statement,
		status: params.status ?? "active",
		revision: 0,
		createdAt: now,
		updatedAt: now,
	};

	const result = db.transaction((tx) => {
		const insertResult = tx
			.insert(memoryProfileItems)
			.values(item)
			.onConflictDoNothing({
				target: [
					memoryProfileItems.userId,
					memoryProfileItems.resetGeneration,
					memoryProfileItems.itemKey,
				],
			})
			.run() as { changes?: number };

		if ((insertResult.changes ?? 0) === 1) {
			tx.update(memoryProjectionState)
				.set({
					revision: sql`${memoryProjectionState.revision} + 1`,
					updatedAt: now,
				})
				.where(eq(memoryProjectionState.id, projection.id))
				.run();

			return {
				row: item,
				projectionRevision: projection.revision + 1,
			};
		}

		const [existing] = tx
			.select()
			.from(memoryProfileItems)
			.where(
				and(
					eq(memoryProfileItems.userId, params.userId),
					eq(memoryProfileItems.resetGeneration, resetGeneration),
					eq(memoryProfileItems.itemKey, itemKey),
				),
			)
			.limit(1)
			.all();

		if (!existing) {
			throw new Error("Memory profile item could not be initialized.");
		}

		return {
			row: existing,
			projectionRevision: projection.revision,
		};
	});

	return {
		id: result.row.id,
		itemKey: result.row.itemKey,
		status: result.row.status as MemoryProfileItemStatus,
		revision: result.row.revision,
		resetGeneration,
		projectionRevision: result.projectionRevision,
	};
}

export async function addMemoryProfileItemProvenance(params: {
	userId: string;
	itemId: string;
	sourceType: string;
	sourceId?: string;
	label: string;
	summary?: string;
	expectedResetGeneration?: number;
}): Promise<MemoryProfileSourceChip> {
	const resetGeneration = await assertExpectedMemoryResetGeneration({
		userId: params.userId,
		expectedResetGeneration: params.expectedResetGeneration,
	});
	const [item] = await db
		.select({
			id: memoryProfileItems.id,
			resetGeneration: memoryProfileItems.resetGeneration,
		})
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.id, params.itemId),
				eq(memoryProfileItems.resetGeneration, resetGeneration),
			),
		)
		.limit(1);
	if (!item) {
		throw new Error("Memory profile item not found.");
	}

	const id = randomUUID();
	await db
		.insert(memoryProfileItemProvenance)
		.values({
			id,
			itemId: item.id,
			userId: params.userId,
			resetGeneration: item.resetGeneration,
			sourceType: params.sourceType,
			sourceId: params.sourceId,
			label: params.label,
			summary: params.summary,
			createdAt: new Date(),
		})
		.run();

	return {
		id,
		sourceType: params.sourceType,
		label: params.label,
		summary: params.summary ?? null,
	};
}

export async function getMemoryProfileReadModel(params: {
	userId: string;
}): Promise<MemoryProfileReadModel> {
	const resetGeneration = await getCurrentMemoryResetGeneration(params.userId);
	const identity = await getMemoryProfileIdentity(params.userId);
	const sanitizer = createIdentityTextSanitizer({
		userId: params.userId,
		displayName: identity.displayName,
		honchoPeerVersion: identity.honchoPeerVersion,
	});
	const projection = await ensureProjectionState({
		userId: params.userId,
		resetGeneration,
	});
	const expiredCount = await expireOverdueActiveMemoryProfileItems({
		userId: params.userId,
		resetGeneration,
		projectionStateId: projection.id,
	});
	const rows = await db
		.select()
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.resetGeneration, resetGeneration),
				eq(memoryProfileItems.status, "active"),
			),
		)
		.orderBy(desc(memoryProfileItems.updatedAt));
	const cards = rows.map((row) => toCardItem(row, sanitizer));
	const reviewRows = await db
		.select()
		.from(memoryReviewItems)
		.where(
			and(
				eq(memoryReviewItems.userId, params.userId),
				eq(memoryReviewItems.resetGeneration, resetGeneration),
				eq(memoryReviewItems.status, "open"),
			),
		)
		.orderBy(asc(memoryReviewItems.updatedAt));
	const dedupedReviewRows = dedupeReviewRows(reviewRows);
	const visibleReviews = dedupedReviewRows
		.slice(0, 3)
		.map((row) => toPublicReviewItem(row, sanitizer));
	const allReviews = dedupedReviewRows.map((row) =>
		toPublicReviewItem(row, sanitizer),
	);

	return {
		resetGeneration,
		projectionRevision: projection.revision + expiredCount,
		categories: MEMORY_PROFILE_CATEGORIES.map((category) => ({
			category,
			items: cards.filter((item) => item.category === category),
		})),
		review: {
			items: allReviews,
			visibleItems: visibleReviews,
			openCount: dedupedReviewRows.length,
			overflowCount: Math.max(
				0,
				dedupedReviewRows.length - visibleReviews.length,
			),
		},
	};
}

export async function getMemoryProfileItemDetail(params: {
	userId: string;
	itemId: string;
}): Promise<MemoryProfileItemDetail | null> {
	const resetGeneration = await getCurrentMemoryResetGeneration(params.userId);
	const projection = await ensureProjectionState({
		userId: params.userId,
		resetGeneration,
	});
	await expireOverdueActiveMemoryProfileItems({
		userId: params.userId,
		resetGeneration,
		projectionStateId: projection.id,
	});
	const [item] = await db
		.select()
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.id, params.itemId),
				eq(memoryProfileItems.resetGeneration, resetGeneration),
				eq(memoryProfileItems.status, "active"),
			),
		)
		.limit(1);
	if (!item) return null;
	const identity = await getMemoryProfileIdentity(params.userId);
	const sanitizer = createIdentityTextSanitizer({
		userId: params.userId,
		displayName: identity.displayName,
		honchoPeerVersion: identity.honchoPeerVersion,
	});

	const provenance = await db
		.select()
		.from(memoryProfileItemProvenance)
		.where(
			and(
				eq(memoryProfileItemProvenance.userId, params.userId),
				eq(memoryProfileItemProvenance.itemId, params.itemId),
				eq(memoryProfileItemProvenance.resetGeneration, resetGeneration),
			),
		)
		.orderBy(asc(memoryProfileItemProvenance.createdAt))
		.limit(3);

	return {
		...toCardItem(item, sanitizer),
		sourceChips: provenance.map((row) => ({
			id: row.id,
			sourceType: row.sourceType,
			label: sanitizePublicMemoryText(row.label, sanitizer),
			summary: row.summary
				? sanitizePublicMemoryText(row.summary, sanitizer)
				: null,
		})),
		whyRemembered: provenance[0]?.summary
			? sanitizePublicMemoryText(provenance[0].summary, sanitizer)
			: null,
	};
}

export async function getActiveMemoryProfileContext(params: {
	userId: string;
}): Promise<ActiveMemoryProfileContext> {
	const resetGeneration = await getCurrentMemoryResetGeneration(params.userId);
	const projection = await ensureProjectionState({
		userId: params.userId,
		resetGeneration,
	});
	const expiredCount = await expireOverdueActiveMemoryProfileItems({
		userId: params.userId,
		resetGeneration,
		projectionStateId: projection.id,
	});
	const rows = await db
		.select()
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.resetGeneration, resetGeneration),
				eq(memoryProfileItems.status, "active"),
			),
		)
		.orderBy(desc(memoryProfileItems.updatedAt));

	return {
		resetGeneration,
		projectionRevision: projection.revision + expiredCount,
		items: rows.map((row) => {
			assertMemoryProfileCategory(row.category);
			return {
				id: row.id,
				itemKey: row.itemKey,
				category: row.category,
				statement: row.statement,
				scope: fromScopeColumns(row.scopeType, row.scopeId),
				revision: row.revision,
				updatedAt: row.updatedAt,
			};
		}),
	};
}

export async function updateMemoryProfileItemWithRevision(params: {
	userId: string;
	itemId: string;
	expectedProjectionRevision: number;
	patch: {
		statement?: string;
		status?: MemoryProfileItemStatus;
	};
}): Promise<
	| { status: "updated"; projectionRevision: number }
	| { status: "stale_projection" }
	| { status: "not_found" }
> {
	const resetGeneration = await getCurrentMemoryResetGeneration(params.userId);
	const projection = await ensureProjectionState({
		userId: params.userId,
		resetGeneration,
	});
	const now = new Date();
	const itemRows = await db
		.select()
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.id, params.itemId),
				eq(memoryProfileItems.resetGeneration, resetGeneration),
			),
		)
		.limit(1);
	const item = itemRows[0];
	if (!item) return { status: "not_found" };
	assertMemoryProfileCategory(item.category);
	const nextStatement = params.patch.statement ?? item.statement;
	const nextItemKey =
		params.patch.statement !== undefined &&
		item.itemKey.startsWith(`${ITEM_KEY_VERSION}:`)
			? deriveMemoryProfileItemKey({
					category: item.category,
					scope: fromScopeColumns(item.scopeType, item.scopeId),
					statement: nextStatement,
				})
			: item.itemKey;
	if (nextItemKey !== item.itemKey) {
		const [collidingItem] = await db
			.select({ id: memoryProfileItems.id })
			.from(memoryProfileItems)
			.where(
				and(
					eq(memoryProfileItems.userId, params.userId),
					eq(memoryProfileItems.resetGeneration, resetGeneration),
					eq(memoryProfileItems.itemKey, nextItemKey),
				),
			)
			.limit(1);
		if (collidingItem && collidingItem.id !== item.id) {
			return { status: "not_found" };
		}
	}

	const nextRevision = params.expectedProjectionRevision + 1;
	const result = db.transaction((tx) => {
		const projectionClaim = tx
			.update(memoryProjectionState)
			.set({
				revision: sql`${memoryProjectionState.revision} + 1`,
				updatedAt: now,
			})
			.where(
				and(
					eq(memoryProjectionState.id, projection.id),
					eq(memoryProjectionState.revision, params.expectedProjectionRevision),
				),
			)
			.run() as { changes?: number };

		if ((projectionClaim.changes ?? 0) !== 1) {
			return { status: "stale_projection" as const };
		}

		tx.update(memoryProfileItems)
			.set({
				...(params.patch.statement !== undefined
					? { statement: params.patch.statement }
					: {}),
				...(nextItemKey !== item.itemKey ? { itemKey: nextItemKey } : {}),
				...(params.patch.status !== undefined
					? {
							status: params.patch.status,
							deletedAt: params.patch.status === "deleted" ? now : undefined,
							suppressedAt:
								params.patch.status === "suppressed" ? now : undefined,
						}
					: {}),
				revision: sql`${memoryProfileItems.revision} + 1`,
				updatedAt: now,
			})
			.where(
				and(
					eq(memoryProfileItems.userId, params.userId),
					eq(memoryProfileItems.id, params.itemId),
					eq(memoryProfileItems.resetGeneration, resetGeneration),
				),
			)
			.run();

		return {
			status: "updated" as const,
			projectionRevision: nextRevision,
		};
	});

	return result;
}

export async function createOrUpdateMemoryReviewItem(params: {
	userId: string;
	subjectKey: string;
	subjectLabel: string;
	question: string;
	reason: string;
	affectedItemIds?: string[];
	evidence?: unknown[];
	metadata?: JsonRecord;
	expectedResetGeneration?: number;
}): Promise<{ id: string; status: "open"; evidenceCount: number }> {
	assertPrivacySafeMetadata(params.metadata);
	const resetGeneration = await assertExpectedMemoryResetGeneration({
		userId: params.userId,
		expectedResetGeneration: params.expectedResetGeneration,
	});
	const now = new Date();
	const [existing] = await db
		.select()
		.from(memoryReviewItems)
		.where(
			and(
				eq(memoryReviewItems.userId, params.userId),
				eq(memoryReviewItems.resetGeneration, resetGeneration),
				eq(memoryReviewItems.subjectKey, params.subjectKey),
				eq(memoryReviewItems.status, "open"),
			),
		)
		.limit(1);

	if (existing) {
		const evidence = [
			...parseJsonArray(existing.evidenceJson),
			...(params.evidence ?? []),
		];
		const affectedItemIds = Array.from(
			new Set([
				...parseJsonArray(existing.affectedItemIdsJson).filter(
					(value): value is string => typeof value === "string",
				),
				...(params.affectedItemIds ?? []),
			]),
		);
		await db
			.update(memoryReviewItems)
			.set({
				question: params.question,
				reason: params.reason,
				subjectLabel: params.subjectLabel,
				affectedItemIdsJson: JSON.stringify(affectedItemIds),
				evidenceJson: JSON.stringify(evidence),
				metadataJson: JSON.stringify(
					params.metadata ?? parseJsonRecord(existing.metadataJson),
				),
				updatedAt: now,
			})
			.where(eq(memoryReviewItems.id, existing.id))
			.run();
		return {
			id: existing.id,
			status: "open",
			evidenceCount: evidence.length,
		};
	}

	const id = randomUUID();
	await db
		.insert(memoryReviewItems)
		.values({
			id,
			userId: params.userId,
			resetGeneration,
			subjectKey: params.subjectKey,
			subjectLabel: params.subjectLabel,
			question: params.question,
			reason: params.reason,
			affectedItemIdsJson: JSON.stringify(params.affectedItemIds ?? []),
			evidenceJson: JSON.stringify(params.evidence ?? []),
			metadataJson: JSON.stringify(params.metadata ?? {}),
			createdAt: now,
			updatedAt: now,
		})
		.run();
	return {
		id,
		status: "open",
		evidenceCount: params.evidence?.length ?? 0,
	};
}

export async function resolveMemoryReviewItem(params: {
	userId: string;
	reviewItemId: string;
	resolutionType: MemoryReviewResolutionType;
	editedStatement?: string;
	metadata?: JsonRecord;
}): Promise<{ status: "resolved" } | { status: "not_found" }> {
	assertOneOf(
		params.resolutionType,
		MEMORY_REVIEW_RESOLUTION_TYPES,
		"memory review resolution",
	);
	assertPrivacySafeMetadata(params.metadata);
	const resetGeneration = await getCurrentMemoryResetGeneration(params.userId);
	const [review] = await db
		.select()
		.from(memoryReviewItems)
		.where(
			and(
				eq(memoryReviewItems.userId, params.userId),
				eq(memoryReviewItems.id, params.reviewItemId),
				eq(memoryReviewItems.resetGeneration, resetGeneration),
			),
		)
		.limit(1);
	if (!review) return { status: "not_found" };

	const now = new Date();
	await db.transaction((tx) => {
		tx.insert(memoryReviewResolutions)
			.values({
				id: randomUUID(),
				reviewItemId: review.id,
				userId: params.userId,
				resetGeneration,
				resolutionType: params.resolutionType,
				editedStatement: params.editedStatement,
				metadataJson: JSON.stringify(params.metadata ?? {}),
				createdAt: now,
			})
			.onConflictDoNothing({
				target: memoryReviewResolutions.reviewItemId,
			})
			.run();
		tx.update(memoryReviewItems)
			.set({
				status: "resolved",
				resolvedAt: now,
				updatedAt: now,
			})
			.where(eq(memoryReviewItems.id, review.id))
			.run();
	});

	return { status: "resolved" };
}

export async function applyMemoryReviewItemWithRevision(params: {
	userId: string;
	reviewItemId: string;
	expectedProjectionRevision: number;
	action: "accept" | "edit" | "dismiss";
	statement?: string;
}): Promise<
	| {
			status: "updated";
			projectionRevision: number;
			itemId: string | null;
			category: MemoryProfileCategory | null;
	  }
	| { status: "stale_projection" }
	| { status: "not_found" }
> {
	const resetGeneration = await getCurrentMemoryResetGeneration(params.userId);
	const projection = await ensureProjectionState({
		userId: params.userId,
		resetGeneration,
	});
	const [review] = await db
		.select()
		.from(memoryReviewItems)
		.where(
			and(
				eq(memoryReviewItems.userId, params.userId),
				eq(memoryReviewItems.id, params.reviewItemId),
				eq(memoryReviewItems.resetGeneration, resetGeneration),
				eq(memoryReviewItems.status, "open"),
			),
		)
		.limit(1);
	if (!review) return { status: "not_found" };

	const metadata = parseJsonRecord(review.metadataJson);
	const duplicateReviewKey = reviewDeduplicationKey(review);
	const duplicateReviewRows = (
		await db
			.select()
			.from(memoryReviewItems)
			.where(
				and(
					eq(memoryReviewItems.userId, params.userId),
					eq(memoryReviewItems.resetGeneration, resetGeneration),
					eq(memoryReviewItems.status, "open"),
				),
			)
	).filter((row) => reviewDeduplicationKey(row) === duplicateReviewKey);
	const proposedStatement = readReviewProposedStatement(metadata);
	const candidateStatement = params.statement ?? proposedStatement ?? "";
	const category =
		params.action === "dismiss"
			? null
			: inferReviewCategory({
					subject: candidateStatement || review.subjectLabel,
					question: review.question,
					reason: review.reason,
					metadata,
				});
	const statement =
		params.action === "dismiss" ? null : candidateStatement.trim();
	if (params.action !== "dismiss" && !statement) {
		return { status: "not_found" };
	}

	const now = new Date();
	const nextProjectionRevision = params.expectedProjectionRevision + 1;
	const result = db.transaction((tx) => {
		const projectionClaim = tx
			.update(memoryProjectionState)
			.set({
				revision: sql`${memoryProjectionState.revision} + 1`,
				updatedAt: now,
			})
			.where(
				and(
					eq(memoryProjectionState.id, projection.id),
					eq(memoryProjectionState.revision, params.expectedProjectionRevision),
				),
			)
			.run() as { changes?: number };

		if ((projectionClaim.changes ?? 0) !== 1) {
			return { status: "stale_projection" as const };
		}

		let itemId: string | null = null;
		if (category && statement) {
			const scope: MemoryProfileScope = { type: "global" };
			const scopeColumns = toScopeColumns(scope);
			const itemKey = resolveMemoryProfileItemKey({
				category,
				scope,
				statement,
			});
			const [existing] = tx
				.select()
				.from(memoryProfileItems)
				.where(
					and(
						eq(memoryProfileItems.userId, params.userId),
						eq(memoryProfileItems.resetGeneration, resetGeneration),
						eq(memoryProfileItems.itemKey, itemKey),
					),
				)
				.limit(1)
				.all();

			if (existing) {
				itemId = existing.id;
				if (existing.status !== "active" || existing.statement !== statement) {
					tx.update(memoryProfileItems)
						.set({
							statement,
							status: "active",
							deletedAt: null,
							suppressedAt: null,
							revision: sql`${memoryProfileItems.revision} + 1`,
							updatedAt: now,
						})
						.where(eq(memoryProfileItems.id, existing.id))
						.run();
				}
			} else {
				itemId = randomUUID();
				tx.insert(memoryProfileItems)
					.values({
						id: itemId,
						userId: params.userId,
						projectionStateId: projection.id,
						resetGeneration,
						itemKey,
						category,
						scopeType: scopeColumns.scopeType,
						scopeId: scopeColumns.scopeId,
						statement,
						status: "active",
						revision: 0,
						createdAt: now,
						updatedAt: now,
					})
					.run();
			}
		}

		const resolutionType: MemoryReviewResolutionType =
			params.action === "accept"
				? "use_fact"
				: params.action === "edit"
					? "edit_fact"
					: "do_not_remember";
		for (const duplicateReview of duplicateReviewRows) {
			tx.insert(memoryReviewResolutions)
				.values({
					id: randomUUID(),
					reviewItemId: duplicateReview.id,
					userId: params.userId,
					resetGeneration,
					resolutionType,
					editedStatement: params.action === "edit" ? statement : undefined,
					metadataJson: JSON.stringify({
						action: params.action,
						category,
						resolvedWithReviewItemId: review.id,
					}),
					createdAt: now,
				})
				.onConflictDoNothing({
					target: memoryReviewResolutions.reviewItemId,
				})
				.run();
			tx.update(memoryReviewItems)
				.set({
					status: "resolved",
					resolvedAt: now,
					updatedAt: now,
				})
				.where(eq(memoryReviewItems.id, duplicateReview.id))
				.run();
		}

		return {
			status: "updated" as const,
			projectionRevision: nextProjectionRevision,
			itemId,
			category,
		};
	});

	return result;
}

export async function markMemoryDirty(params: {
	userId: string;
	reason: MemoryDirtyReason;
	scope?: MemoryProfileScope;
	metadata?: JsonRecord;
	expectedResetGeneration?: number;
}): Promise<{ id: string; reason: MemoryDirtyReason; count: number }> {
	assertOneOf(params.reason, MEMORY_DIRTY_REASONS, "memory dirty reason");
	assertPrivacySafeMetadata(params.metadata);
	const resetGeneration = await assertExpectedMemoryResetGeneration({
		userId: params.userId,
		expectedResetGeneration: params.expectedResetGeneration,
	});
	const scope = toScopeColumns(params.scope ?? { type: "global" });
	const now = new Date();
	const updateExistingPending = async (): Promise<{
		id: string;
		reason: MemoryDirtyReason;
		count: number;
	} | null> => {
		const [existing] = await db
			.select()
			.from(memoryDirtyLedger)
			.where(
				and(
					eq(memoryDirtyLedger.userId, params.userId),
					eq(memoryDirtyLedger.resetGeneration, resetGeneration),
					eq(memoryDirtyLedger.scopeType, scope.scopeType),
					eq(memoryDirtyLedger.scopeId, scope.scopeId),
					eq(memoryDirtyLedger.reason, params.reason),
					eq(memoryDirtyLedger.status, "pending"),
				),
			)
			.limit(1);

		if (!existing) return null;
		const metadata = {
			...parseJsonRecord(existing.reasonMetadataJson),
			...(params.metadata ?? {}),
		};
		await db
			.update(memoryDirtyLedger)
			.set({
				count: sql`${memoryDirtyLedger.count} + 1`,
				reasonMetadataJson: JSON.stringify(metadata),
				lastMarkedAt: now,
			})
			.where(eq(memoryDirtyLedger.id, existing.id))
			.run();
		return {
			id: existing.id,
			reason: params.reason,
			count: existing.count + 1,
		};
	};

	const existingResult = await updateExistingPending();
	if (existingResult) return existingResult;

	const id = randomUUID();
	try {
		await db
			.insert(memoryDirtyLedger)
			.values({
				id,
				userId: params.userId,
				resetGeneration,
				scopeType: scope.scopeType,
				scopeId: scope.scopeId,
				reason: params.reason,
				reasonMetadataJson: JSON.stringify(params.metadata ?? {}),
				firstMarkedAt: now,
				lastMarkedAt: now,
			})
			.run();
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			typeof error.code === "string" &&
			error.code.startsWith("SQLITE_CONSTRAINT")
		) {
			const retried = await updateExistingPending();
			if (retried) return retried;
		}
		throw error;
	}
	return { id, reason: params.reason, count: 1 };
}

export async function listPendingMemoryDirtyEntries(params: {
	userId: string;
}): Promise<
	Array<{
		id: string;
		reason: MemoryDirtyReason;
		count: number;
		scope: MemoryProfileScope;
		metadata: JsonRecord;
	}>
> {
	const resetGeneration = await getCurrentMemoryResetGeneration(params.userId);
	const rows = await db
		.select()
		.from(memoryDirtyLedger)
		.where(
			and(
				eq(memoryDirtyLedger.userId, params.userId),
				eq(memoryDirtyLedger.resetGeneration, resetGeneration),
				eq(memoryDirtyLedger.status, "pending"),
			),
		)
		.orderBy(asc(memoryDirtyLedger.lastMarkedAt));

	return rows.map((row) => {
		assertOneOf(row.reason, MEMORY_DIRTY_REASONS, "memory dirty reason");
		return {
			id: row.id,
			reason: row.reason,
			count: row.count,
			scope: fromScopeColumns(row.scopeType, row.scopeId),
			metadata: parseJsonRecord(row.reasonMetadataJson),
		};
	});
}

const DEFAULT_MEMORY_DIRTY_LEDGER_BATCH_SIZE = 25;
const DEFAULT_MEMORY_DIRTY_LEDGER_MAX_RUNTIME_MS = 1500;
const DEFAULT_MEMORY_DIRTY_LEDGER_STALE_CLAIM_MS = 5 * 60 * 1000;
const LEGACY_DIRTY_LEDGER_CANDIDATE_LIMIT = 5;
const LEGACY_DIRTY_LEDGER_MAX_PAGES = 4;
const DEFAULT_LEGACY_CURATION_BATCH_SIZE = 25;
const MAX_LEGACY_CURATION_BATCH_SIZE = 40;

type ClaimedDirtyLedgerRow = typeof memoryDirtyLedger.$inferSelect;
type PreservedLegacyMemoryRow = typeof memoryProfileItems.$inferSelect & {
	category: MemoryProfileCategory;
};

export type LegacyMemoryCurationInputItem = {
	id: string;
	statement: string;
	category: MemoryProfileCategory;
};

export type LegacyMemoryCurationDecision =
	| {
			id: string;
			decision: "activate";
			category: MemoryProfileCategory;
			statement: string;
	  }
	| {
			id: string;
			decision: "review";
			category: MemoryProfileCategory;
			statement: string;
			reason?: string;
	  }
	| { id: string; decision: "reject"; reason?: string };

export type LegacyMemoryCurator = (
	items: LegacyMemoryCurationInputItem[],
) => Promise<LegacyMemoryCurationDecision[]>;

export type LegacyMemoryCurationResult = {
	status: "completed" | "stale_generation";
	inspected: number;
	active: number;
	review: number;
	rejected: number;
	remainingPreserved: number;
};

function telemetrySubjectIdForDirtyMetadata(
	metadata: JsonRecord,
): string | null {
	return (
		readSafeString(metadata.reviewItemId) ??
		readSafeString(metadata.subjectId) ??
		readSafeString(metadata.subjectKey) ??
		readSafeString(metadata.itemId) ??
		readSafeString(metadata.projectionStateId)
	);
}

function readSafeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return Array.from(
		new Set(
			value
				.filter((entry): entry is string => typeof entry === "string")
				.map((entry) => entry.trim())
				.filter(Boolean),
		),
	);
}

function sanitizeLegacyCurationStatement(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const statement = value.trim().replace(/\s+/g, " ");
	return statement.length >= 4 && statement.length <= 260 ? statement : null;
}

function normalizeLegacyCurationDecision(
	value: unknown,
): LegacyMemoryCurationDecision | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const id = readSafeString(record.id);
	const decision = readSafeString(record.decision);
	if (!id || !decision) return null;

	if (decision === "reject") {
		return {
			id,
			decision,
			...(readSafeString(record.reason)
				? { reason: readSafeString(record.reason) ?? undefined }
				: {}),
		};
	}

	if (decision !== "activate" && decision !== "review") return null;
	const category = readMemoryProfileCategory(record.category);
	const statement = sanitizeLegacyCurationStatement(record.statement);
	if (!category || !statement) return null;

	return {
		id,
		decision,
		category,
		statement,
		...(decision === "review" && readSafeString(record.reason)
			? { reason: readSafeString(record.reason) ?? undefined }
			: {}),
	};
}

function parseLegacyCurationResponse(
	text: string,
): LegacyMemoryCurationDecision[] {
	const parsed = JSON.parse(text) as unknown;
	const record =
		parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	const decisions = Array.isArray(record.decisions) ? record.decisions : [];
	return decisions
		.map(normalizeLegacyCurationDecision)
		.filter((decision): decision is LegacyMemoryCurationDecision =>
			Boolean(decision),
		);
}

async function defaultLegacyMemoryCurator(
	items: LegacyMemoryCurationInputItem[],
): Promise<LegacyMemoryCurationDecision[]> {
	if (items.length === 0) return [];
	const response = await sendJsonControlMessage(
		JSON.stringify({ items }),
		getConfig().memoryLegacyCurationModel,
		{
			systemPrompt: [
				"You curate preserved legacy memory candidates for a user's long-term memory profile.",
				"Return one decision per input id.",
				"Use activate only for stable, user-relevant facts or preferences that should be used immediately.",
				"Use review when the memory may be valuable but is uncertain, ambiguous, contradictory, document-derived, or needs user confirmation.",
				"Use reject for transient chat details, assistant prose, one-off tasks, stale facts, generic observations, document contents that are not explicitly about the user, or junk.",
				"Rewrite activated or reviewed statements as concise third-person memory profile facts.",
				"Do not include raw source text outside the statement field.",
			].join("\n"),
			thinkingMode: "on",
			maxTokens: 1800,
			temperature: 0,
			jsonSchema: {
				name: "legacy_memory_curation",
				strict: true,
				schema: {
					type: "object",
					additionalProperties: false,
					required: ["decisions"],
					properties: {
						decisions: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								required: ["id", "decision", "category", "statement", "reason"],
								properties: {
									id: { type: "string" },
									decision: {
										type: "string",
										enum: ["activate", "review", "reject"],
									},
									category: {
										type: "string",
										enum: [...MEMORY_PROFILE_CATEGORIES],
									},
									statement: { type: "string" },
									reason: { type: "string" },
								},
							},
						},
					},
				},
			},
			allowReasoningFallback: true,
		},
	);

	return parseLegacyCurationResponse(response.text);
}

function fallbackReviewDecision(
	row: PreservedLegacyMemoryRow,
): LegacyMemoryCurationDecision {
	return {
		id: row.id,
		decision: "review",
		category: row.category,
		statement: row.statement,
		reason: "Needs user confirmation before becoming active memory.",
	};
}

async function loadPreservedLegacyMemoryRows(params: {
	userId: string;
	resetGeneration: number;
	limit: number;
}): Promise<PreservedLegacyMemoryRow[]> {
	const rows = await db
		.select()
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.resetGeneration, params.resetGeneration),
				eq(memoryProfileItems.status, "preserved_legacy"),
			),
		)
		.orderBy(asc(memoryProfileItems.createdAt))
		.limit(params.limit);
	return rows.map((row) => {
		assertMemoryProfileCategory(row.category);
		return { ...row, category: row.category };
	});
}

async function countPreservedLegacyMemoryRows(params: {
	userId: string;
	resetGeneration: number;
}): Promise<number> {
	const [row] = await db
		.select({ count: sql<number>`count(*)` })
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.resetGeneration, params.resetGeneration),
				eq(memoryProfileItems.status, "preserved_legacy"),
			),
		)
		.limit(1);
	return Number(row?.count ?? 0);
}

function legacyCurationMetadata(params: {
	row: PreservedLegacyMemoryRow;
	decision: LegacyMemoryCurationDecision;
}): string {
	return JSON.stringify({
		...parseJsonRecord(params.row.metadataJson),
		source: "legacy_memory_curation",
		legacyCurationDecision: params.decision.decision,
		legacyCurationReason:
			"reason" in params.decision ? params.decision.reason : undefined,
		curatedAt: new Date().toISOString(),
	});
}

function bumpProjectionRevision(params: {
	projectionStateId: string;
	amount: number;
	now: Date;
}): void {
	if (params.amount <= 0) return;
	db.update(memoryProjectionState)
		.set({
			revision: sql`${memoryProjectionState.revision} + ${params.amount}`,
			updatedAt: params.now,
		})
		.where(eq(memoryProjectionState.id, params.projectionStateId))
		.run();
}

function applyActivateLegacyCurationDecision(params: {
	userId: string;
	resetGeneration: number;
	row: PreservedLegacyMemoryRow;
	decision: Extract<LegacyMemoryCurationDecision, { decision: "activate" }>;
	now: Date;
}): "active" | "rejected" | "skipped" {
	const scope: MemoryProfileScope = { type: "global" };
	const itemKey = resolveMemoryProfileItemKey({
		category: params.decision.category,
		scope,
		statement: params.decision.statement,
	});
	const [duplicate] = db
		.select({ id: memoryProfileItems.id })
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.resetGeneration, params.resetGeneration),
				eq(memoryProfileItems.itemKey, itemKey),
			),
		)
		.limit(1)
		.all();

	const nextStatus =
		duplicate && duplicate.id !== params.row.id ? "inactive" : "active";
	const result = db
		.update(memoryProfileItems)
		.set({
			itemKey: nextStatus === "active" ? itemKey : params.row.itemKey,
			category:
				nextStatus === "active"
					? params.decision.category
					: params.row.category,
			statement:
				nextStatus === "active"
					? params.decision.statement
					: params.row.statement,
			status: nextStatus,
			revision: sql`${memoryProfileItems.revision} + 1`,
			metadataJson: legacyCurationMetadata(params),
			updatedAt: params.now,
		})
		.where(
			and(
				eq(memoryProfileItems.id, params.row.id),
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.resetGeneration, params.resetGeneration),
				eq(memoryProfileItems.status, "preserved_legacy"),
			),
		)
		.run() as { changes?: number };
	if ((result.changes ?? 0) !== 1) return "skipped";

	if (nextStatus !== "active") return "rejected";
	db.insert(memoryProfileItemProvenance)
		.values({
			id: randomUUID(),
			itemId: params.row.id,
			userId: params.userId,
			resetGeneration: params.resetGeneration,
			sourceType: "legacy_memory_curation",
			sourceId: params.row.id,
			label: "Legacy memory",
			summary: "Curated from preserved legacy memory.",
			metadataJson: JSON.stringify({
				source: "legacy_memory_curation",
				legacyItemToken: stableMemoryMaintenanceDigest(params.row.id),
			}),
			createdAt: params.now,
		})
		.run();
	return "active";
}

async function applyReviewLegacyCurationDecision(params: {
	userId: string;
	resetGeneration: number;
	row: PreservedLegacyMemoryRow;
	decision: Extract<LegacyMemoryCurationDecision, { decision: "review" }>;
	now: Date;
}): Promise<"review" | "skipped"> {
	const result = (await db
		.update(memoryProfileItems)
		.set({
			status: "review_needed",
			revision: sql`${memoryProfileItems.revision} + 1`,
			metadataJson: legacyCurationMetadata(params),
			updatedAt: params.now,
		})
		.where(
			and(
				eq(memoryProfileItems.id, params.row.id),
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.resetGeneration, params.resetGeneration),
				eq(memoryProfileItems.status, "preserved_legacy"),
			),
		)
		.run()) as { changes?: number };
	if ((result.changes ?? 0) !== 1) return "skipped";

	await createOrUpdateMemoryReviewItem({
		userId: params.userId,
		subjectKey: legacyReviewSubjectKey({
			category: params.decision.category,
			statement: params.decision.statement,
		}),
		subjectLabel: params.decision.statement,
		question: "Should AlfyAI remember this?",
		reason:
			params.decision.reason ??
			"Legacy memory needs confirmation before becoming active.",
		affectedItemIds: [params.row.id],
		evidence: [
			{
				sourceType: "legacy_memory_curation",
				legacyItemToken: stableMemoryMaintenanceDigest(params.row.id),
			},
		],
		metadata: {
			source: "legacy_memory_curation",
			category: params.decision.category,
			proposedStatement: params.decision.statement,
			legacyItemToken: stableMemoryMaintenanceDigest(params.row.id),
		},
		expectedResetGeneration: params.resetGeneration,
	});
	return "review";
}

function applyRejectLegacyCurationDecision(params: {
	userId: string;
	resetGeneration: number;
	row: PreservedLegacyMemoryRow;
	decision: Extract<LegacyMemoryCurationDecision, { decision: "reject" }>;
	now: Date;
}): "rejected" | "skipped" {
	const result = db
		.update(memoryProfileItems)
		.set({
			status: "inactive",
			revision: sql`${memoryProfileItems.revision} + 1`,
			metadataJson: legacyCurationMetadata(params),
			updatedAt: params.now,
		})
		.where(
			and(
				eq(memoryProfileItems.id, params.row.id),
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.resetGeneration, params.resetGeneration),
				eq(memoryProfileItems.status, "preserved_legacy"),
			),
		)
		.run() as { changes?: number };
	return (result.changes ?? 0) === 1 ? "rejected" : "skipped";
}

async function applyLegacyCurationDecision(params: {
	userId: string;
	resetGeneration: number;
	row: PreservedLegacyMemoryRow;
	decision: LegacyMemoryCurationDecision;
	now: Date;
}): Promise<"active" | "review" | "rejected" | "skipped"> {
	if (params.decision.decision === "activate") {
		return applyActivateLegacyCurationDecision({
			userId: params.userId,
			resetGeneration: params.resetGeneration,
			row: params.row,
			decision: params.decision,
			now: params.now,
		});
	}
	if (params.decision.decision === "review") {
		return applyReviewLegacyCurationDecision({
			userId: params.userId,
			resetGeneration: params.resetGeneration,
			row: params.row,
			decision: params.decision,
			now: params.now,
		});
	}
	return applyRejectLegacyCurationDecision({
		userId: params.userId,
		resetGeneration: params.resetGeneration,
		row: params.row,
		decision: params.decision,
		now: params.now,
	});
}

export async function curatePreservedLegacyMemoryForUser(params: {
	userId: string;
	batchSize?: number;
	startedResetGeneration?: number;
	curateBatch?: LegacyMemoryCurator;
}): Promise<LegacyMemoryCurationResult> {
	const batchSize = Math.max(
		0,
		Math.min(
			MAX_LEGACY_CURATION_BATCH_SIZE,
			Math.floor(params.batchSize ?? DEFAULT_LEGACY_CURATION_BATCH_SIZE),
		),
	);
	const resetGeneration =
		params.startedResetGeneration ??
		(await getCurrentMemoryResetGeneration(params.userId));
	if (
		!(await isCurrentMemoryResetGeneration({
			userId: params.userId,
			resetGeneration,
		}))
	) {
		return {
			status: "stale_generation",
			inspected: 0,
			active: 0,
			review: 0,
			rejected: 0,
			remainingPreserved: 0,
		};
	}

	const rows =
		batchSize > 0
			? await loadPreservedLegacyMemoryRows({
					userId: params.userId,
					resetGeneration,
					limit: batchSize,
				})
			: [];
	if (rows.length === 0) {
		return {
			status: "completed",
			inspected: 0,
			active: 0,
			review: 0,
			rejected: 0,
			remainingPreserved: await countPreservedLegacyMemoryRows({
				userId: params.userId,
				resetGeneration,
			}),
		};
	}

	const curator = params.curateBatch ?? defaultLegacyMemoryCurator;
	let decisions: LegacyMemoryCurationDecision[];
	try {
		decisions = await curator(
			rows.map((row) => ({
				id: row.id,
				statement: row.statement,
				category: row.category,
			})),
		);
	} catch {
		decisions = rows.map(fallbackReviewDecision);
	}
	if (
		!(await isCurrentMemoryResetGeneration({
			userId: params.userId,
			resetGeneration,
		}))
	) {
		return {
			status: "stale_generation",
			inspected: rows.length,
			active: 0,
			review: 0,
			rejected: 0,
			remainingPreserved: 0,
		};
	}
	const decisionMap = new Map(
		decisions
			.map(normalizeLegacyCurationDecision)
			.filter((decision): decision is LegacyMemoryCurationDecision =>
				Boolean(decision),
			)
			.map((decision) => [decision.id, decision] as const),
	);

	let active = 0;
	let review = 0;
	let rejected = 0;
	let changed = 0;
	const now = new Date();
	for (const row of rows) {
		const applied = await applyLegacyCurationDecision({
			userId: params.userId,
			resetGeneration,
			row,
			decision: decisionMap.get(row.id) ?? fallbackReviewDecision(row),
			now,
		});
		if (applied === "active") active += 1;
		if (applied === "review") review += 1;
		if (applied === "rejected") rejected += 1;
		if (applied !== "skipped") changed += 1;
	}

	if (changed > 0) {
		bumpProjectionRevision({
			projectionStateId: rows[0].projectionStateId,
			amount: changed,
			now,
		});
	}
	const remainingPreserved = await countPreservedLegacyMemoryRows({
		userId: params.userId,
		resetGeneration,
	});
	await recordMemoryReworkTelemetry({
		userId: params.userId,
		eventFamily: "maintenance",
		eventName: "legacy_curation_completed",
		reason: "legacy_migration",
		status: "completed",
		count: rows.length,
		metadata: {
			inspectedCount: rows.length,
			activeCount: active,
			reviewCount: review,
			rejectedCount: rejected,
			remainingPreserved,
			requestedLimit: batchSize,
		},
		expectedResetGeneration: resetGeneration,
	});

	return {
		status: "completed",
		inspected: rows.length,
		active,
		review,
		rejected,
		remainingPreserved,
	};
}

function mergeDirtyLedgerMetadata(
	current: string | null,
	next: string | null,
): string {
	return JSON.stringify({
		...parseJsonRecord(current),
		...parseJsonRecord(next),
	});
}

function reclaimStaleClaimedMemoryDirtyLedgerRows(params: {
	userId: string;
	resetGeneration: number;
	staleBefore: Date;
	limit: number;
}): number {
	if (params.limit <= 0) return 0;

	return db.transaction((tx) => {
		const staleRows = tx
			.select()
			.from(memoryDirtyLedger)
			.where(
				and(
					eq(memoryDirtyLedger.userId, params.userId),
					eq(memoryDirtyLedger.resetGeneration, params.resetGeneration),
					eq(memoryDirtyLedger.status, "claimed"),
					lt(memoryDirtyLedger.claimedAt, params.staleBefore),
				),
			)
			.orderBy(asc(memoryDirtyLedger.claimedAt))
			.limit(params.limit)
			.all();
		const now = new Date();
		let reclaimed = 0;

		for (const row of staleRows) {
			const [pending] = tx
				.select()
				.from(memoryDirtyLedger)
				.where(
					and(
						eq(memoryDirtyLedger.userId, params.userId),
						eq(memoryDirtyLedger.resetGeneration, params.resetGeneration),
						eq(memoryDirtyLedger.scopeType, row.scopeType),
						eq(memoryDirtyLedger.scopeId, row.scopeId),
						eq(memoryDirtyLedger.reason, row.reason),
						eq(memoryDirtyLedger.status, "pending"),
					),
				)
				.limit(1)
				.all();

			if (pending) {
				tx.update(memoryDirtyLedger)
					.set({
						count: sql`${memoryDirtyLedger.count} + ${row.count}`,
						reasonMetadataJson: mergeDirtyLedgerMetadata(
							pending.reasonMetadataJson,
							row.reasonMetadataJson,
						),
						lastMarkedAt: now,
					})
					.where(eq(memoryDirtyLedger.id, pending.id))
					.run();
				tx.update(memoryDirtyLedger)
					.set({
						status: "completed",
						completedAt: now,
					})
					.where(eq(memoryDirtyLedger.id, row.id))
					.run();
			} else {
				tx.update(memoryDirtyLedger)
					.set({
						status: "pending",
						claimedAt: null,
					})
					.where(eq(memoryDirtyLedger.id, row.id))
					.run();
			}
			reclaimed += 1;
		}

		return reclaimed;
	});
}

function claimNextMemoryDirtyLedgerRow(params: {
	userId: string;
	resetGeneration: number;
	attemptedIds: Set<string>;
}): ClaimedDirtyLedgerRow | null {
	const now = new Date();
	return db.transaction((tx) => {
		const rows = tx
			.select()
			.from(memoryDirtyLedger)
			.where(
				and(
					eq(memoryDirtyLedger.userId, params.userId),
					eq(memoryDirtyLedger.resetGeneration, params.resetGeneration),
					eq(memoryDirtyLedger.status, "pending"),
				),
			)
			.orderBy(asc(memoryDirtyLedger.lastMarkedAt))
			.limit(Math.max(1, params.attemptedIds.size + 1))
			.all();
		const row = rows.find(
			(candidate) => !params.attemptedIds.has(candidate.id),
		);
		if (!row) return null;

		const claim = tx
			.update(memoryDirtyLedger)
			.set({
				status: "claimed",
				claimedAt: now,
			})
			.where(
				and(
					eq(memoryDirtyLedger.id, row.id),
					eq(memoryDirtyLedger.userId, params.userId),
					eq(memoryDirtyLedger.resetGeneration, params.resetGeneration),
					eq(memoryDirtyLedger.status, "pending"),
				),
			)
			.run() as { changes?: number };

		return (claim.changes ?? 0) === 1
			? {
					...row,
					status: "claimed",
					claimedAt: now,
				}
			: null;
	});
}

async function completeClaimedMemoryDirtyLedgerRow(params: {
	userId: string;
	resetGeneration: number;
	id: string;
}): Promise<boolean> {
	const result = (await db
		.update(memoryDirtyLedger)
		.set({
			status: "completed",
			completedAt: new Date(),
		})
		.where(
			and(
				eq(memoryDirtyLedger.id, params.id),
				eq(memoryDirtyLedger.userId, params.userId),
				eq(memoryDirtyLedger.resetGeneration, params.resetGeneration),
				eq(memoryDirtyLedger.status, "claimed"),
			),
		)
		.run()) as { changes?: number };

	return (result.changes ?? 0) === 1;
}

async function requeueClaimedMemoryDirtyLedgerRow(params: {
	userId: string;
	resetGeneration: number;
	id: string;
}): Promise<void> {
	await db
		.update(memoryDirtyLedger)
		.set({
			status: "pending",
			claimedAt: null,
		})
		.where(
			and(
				eq(memoryDirtyLedger.id, params.id),
				eq(memoryDirtyLedger.userId, params.userId),
				eq(memoryDirtyLedger.resetGeneration, params.resetGeneration),
				eq(memoryDirtyLedger.status, "claimed"),
			),
		)
		.run();
}

async function handleClaimedMemoryDirtyLedgerRow(params: {
	userId: string;
	row: ClaimedDirtyLedgerRow;
	loadLegacyMemoryCandidates?: LegacyMemoryCandidateLoader;
	curatePreservedLegacyMemory?: LegacyMemoryCurator;
}): Promise<void> {
	assertOneOf(params.row.reason, MEMORY_DIRTY_REASONS, "memory dirty reason");
	const metadata = parseJsonRecord(params.row.reasonMetadataJson);
	if (
		params.row.reason === "possible_duplicate" ||
		params.row.reason === "review_generation"
	) {
		const reviewCount = await createExactDuplicateMemoryReviews({
			userId: params.userId,
			resetGeneration: params.row.resetGeneration,
			ledgerEntryId: params.row.id,
		});
		await recordMemoryReworkTelemetry({
			userId: params.userId,
			eventFamily: "maintenance",
			eventName:
				reviewCount > 0
					? "dirty_ledger_duplicate_review_created"
					: "dirty_ledger_acknowledged",
			reason: params.row.reason,
			status: "completed",
			count: reviewCount,
			subjectId: telemetrySubjectIdForDirtyMetadata(metadata) ?? undefined,
			metadata: {
				ledgerEntryId: params.row.id,
				scopeType: params.row.scopeType,
				scopeId: params.row.scopeId,
				reviewCount,
			},
		});
		return;
	}
	if (params.row.reason === "possible_conflict") {
		const subjectId = readSafeString(metadata.subjectId);
		const subjectKey = readSafeString(metadata.subjectKey);
		const deterministicSubject = subjectId ?? subjectKey;
		if (deterministicSubject) {
			await createOrUpdateMemoryReviewItem({
				userId: params.userId,
				subjectKey: `memory-profile:conflict:${stableMemoryMaintenanceDigest(deterministicSubject)}`,
				subjectLabel: "Memory profile conflict",
				question: "Which memory profile value should AlfyAI keep?",
				reason: "Maintenance found a deterministic conflict marker.",
				affectedItemIds: subjectId ? [subjectId] : [],
				evidence: [
					{
						sourceType: "memory_dirty_ledger",
						ledgerEntryId: params.row.id,
					},
				],
				metadata: {
					source: "dirty_ledger_reconciliation",
					subjectKind: subjectId ? "subjectId" : "subjectKey",
					subjectToken: stableMemoryMaintenanceDigest(deterministicSubject),
				},
			});
			await recordMemoryReworkTelemetry({
				userId: params.userId,
				eventFamily: "maintenance",
				eventName: "dirty_ledger_conflict_review_created",
				reason: params.row.reason,
				status: "completed",
				count: params.row.count,
				subjectId: deterministicSubject,
				metadata: {
					ledgerEntryId: params.row.id,
					scopeType: params.row.scopeType,
					scopeId: params.row.scopeId,
				},
			});
			return;
		}
	}
	if (params.row.reason === "profile_action_reconciliation") {
		await verifyProfileActionReadModelExclusion({
			userId: params.userId,
			resetGeneration: params.row.resetGeneration,
			ledgerEntryId: params.row.id,
		});
		return;
	}
	if (params.row.reason === "honcho_reconciliation") {
		const action = readSafeString(metadata.action);
		await recordMemoryReworkTelemetry({
			userId: params.userId,
			eventFamily: "maintenance",
			eventName: "dirty_ledger_honcho_reconciliation_projection_only",
			reason: params.row.reason,
			status: "completed",
			count: params.row.count,
			subjectId: telemetrySubjectIdForDirtyMetadata(metadata) ?? undefined,
			metadata: {
				ledgerEntryId: params.row.id,
				scopeType: params.row.scopeType,
				scopeId: params.row.scopeId,
				...(action ? { action } : {}),
			},
		});
		return;
	}
	if (params.row.reason === "legacy_migration") {
		const excludedSourceIds = readSafeStringArray(
			metadata.legacyExcludedSourceIds,
		);
		const legacyStartPage =
			readSafePositiveInteger(metadata.legacyNextPage) ?? 1;
		let legacyBatch: LegacyPersonaMemoryCandidateBatch | undefined;
		if (params.loadLegacyMemoryCandidates) {
			legacyBatch = await params.loadLegacyMemoryCandidates(params.userId, {
				limit: LEGACY_DIRTY_LEDGER_CANDIDATE_LIMIT,
				excludeSourceIds: excludedSourceIds,
				startPage: legacyStartPage,
				maxPages: LEGACY_DIRTY_LEDGER_MAX_PAGES,
			});
		}
		const migration = await migrateLegacyMemoryForUser({
			userId: params.userId,
			batchSize: LEGACY_DIRTY_LEDGER_CANDIDATE_LIMIT,
			legacyBatch,
			startedResetGeneration: params.row.resetGeneration,
		});
		if (migration.status === "unavailable") {
			await recordMemoryReworkTelemetry({
				userId: params.userId,
				eventFamily: "maintenance",
				eventName: "legacy_migration_unavailable",
				reason: params.row.reason,
				status: "skipped",
				count: params.row.count,
				metadata: {
					ledgerEntryId: params.row.id,
					scopeType: params.row.scopeType,
					scopeId: params.row.scopeId,
				},
			});
		}
		const inspectedSourceIds = readSafeStringArray(
			legacyBatch?.candidates.map((candidate) => candidate.id),
		);
		const nextExcludedSourceIds = Array.from(
			new Set([...excludedSourceIds, ...inspectedSourceIds]),
		);
		if (
			migration.status === "completed" &&
			legacyBatch?.exhausted === false &&
			legacyBatch.nextPage
		) {
			await markMemoryDirty({
				userId: params.userId,
				reason: "legacy_migration",
				metadata: {
					legacyCandidateEstimate: migration.totalAvailable,
					legacyExcludedSourceIds: nextExcludedSourceIds.slice(-25),
					legacyNextPage: legacyBatch.nextPage,
				},
				expectedResetGeneration: params.row.resetGeneration,
			});
		}
		if (migration.status === "completed") {
			await curatePreservedLegacyMemoryForUser({
				userId: params.userId,
				startedResetGeneration: params.row.resetGeneration,
				curateBatch: params.curatePreservedLegacyMemory,
			});
		}
		return;
	}

	await recordMemoryReworkTelemetry({
		userId: params.userId,
		eventFamily: "maintenance",
		eventName: "dirty_ledger_acknowledged",
		reason: params.row.reason,
		status: "completed",
		count: params.row.count,
		subjectId: telemetrySubjectIdForDirtyMetadata(metadata) ?? undefined,
		metadata: {
			ledgerEntryId: params.row.id,
			scopeType: params.row.scopeType,
			scopeId: params.row.scopeId,
			dirtyCount: params.row.count,
		},
	});
}

async function verifyProfileActionReadModelExclusion(params: {
	userId: string;
	resetGeneration: number;
	ledgerEntryId: string;
}): Promise<void> {
	const activeContext = await getActiveMemoryProfileContext({
		userId: params.userId,
	});
	const rows = await db
		.select({
			id: memoryProfileItems.id,
			status: memoryProfileItems.status,
		})
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.resetGeneration, params.resetGeneration),
			),
		);
	const nonActiveIds = new Set(
		rows.filter((row) => row.status !== "active").map((row) => row.id),
	);
	const leakedIds = activeContext.items
		.map((item) => item.id)
		.filter((id) => nonActiveIds.has(id));

	await recordMemoryReworkTelemetry({
		userId: params.userId,
		eventFamily: "maintenance",
		eventName:
			leakedIds.length > 0
				? "dirty_ledger_profile_action_issue_found"
				: "dirty_ledger_profile_action_read_model_verified",
		reason: "profile_action_reconciliation",
		status: leakedIds.length > 0 ? "issue_found" : "completed",
		count: leakedIds.length,
		metadata: {
			ledgerEntryId: params.ledgerEntryId,
			activeContextCount: activeContext.items.length,
			nonActiveProfileItemCount: nonActiveIds.size,
			...(leakedIds.length > 0 ? { affectedItemIds: leakedIds } : {}),
		},
	});
}

async function createExactDuplicateMemoryReviews(params: {
	userId: string;
	resetGeneration: number;
	ledgerEntryId: string;
}): Promise<number> {
	const rows = await db
		.select()
		.from(memoryProfileItems)
		.where(
			and(
				eq(memoryProfileItems.userId, params.userId),
				eq(memoryProfileItems.resetGeneration, params.resetGeneration),
				eq(memoryProfileItems.status, "active"),
			),
		)
		.orderBy(asc(memoryProfileItems.updatedAt));

	const groups = new Map<string, typeof rows>();
	for (const row of rows) {
		assertMemoryProfileCategory(row.category);
		const key = [
			row.category,
			row.scopeType,
			row.scopeId,
			normalizeRememberedStatement(row.statement),
		].join("\u001f");
		const group = groups.get(key);
		if (group) {
			group.push(row);
		} else {
			groups.set(key, [row]);
		}
	}

	let reviewCount = 0;
	for (const [key, group] of groups.entries()) {
		if (group.length < 2) continue;
		const [category, scopeType, scopeId] = key.split("\u001f");
		assertMemoryProfileCategory(category);
		const affectedItemIds = group.map((row) => row.id).sort();
		await createOrUpdateMemoryReviewItem({
			userId: params.userId,
			subjectKey: `memory-profile:exact-duplicate:${stableMemoryMaintenanceDigest(key)}`,
			subjectLabel: "Duplicate memory profile items",
			question: "Which duplicate memory profile item should remain active?",
			reason: "Maintenance found exact active duplicate memory profile items.",
			affectedItemIds,
			evidence: [
				{
					sourceType: "memory_dirty_ledger",
					ledgerEntryId: params.ledgerEntryId,
					affectedItemIds,
				},
			],
			metadata: {
				category,
				scopeType,
				scopeId: scopeId ?? "",
				duplicateCount: group.length,
				source: "dirty_ledger_reconciliation",
			},
		});
		reviewCount += 1;
	}

	return reviewCount;
}

export async function reconcileMemoryProfileDirtyLedgerForUser(params: {
	userId: string;
	batchSize?: number;
	maxRuntimeMs?: number;
	staleClaimMs?: number;
	loadLegacyMemoryCandidates?: LegacyMemoryCandidateLoader;
	curatePreservedLegacyMemory?: LegacyMemoryCurator;
}): Promise<MemoryDirtyLedgerReconciliationResult> {
	const batchSize = Math.max(
		0,
		Math.floor(params.batchSize ?? DEFAULT_MEMORY_DIRTY_LEDGER_BATCH_SIZE),
	);
	const maxRuntimeMs = Math.max(
		1,
		Math.floor(
			params.maxRuntimeMs ?? DEFAULT_MEMORY_DIRTY_LEDGER_MAX_RUNTIME_MS,
		),
	);
	const startedAt = Date.now();
	const resetGeneration = await getCurrentMemoryResetGeneration(params.userId);
	reclaimStaleClaimedMemoryDirtyLedgerRows({
		userId: params.userId,
		resetGeneration,
		staleBefore: new Date(
			startedAt -
				Math.max(
					1,
					Math.floor(
						params.staleClaimMs ?? DEFAULT_MEMORY_DIRTY_LEDGER_STALE_CLAIM_MS,
					),
				),
		),
		limit: Math.max(batchSize, 1),
	});
	const result: MemoryDirtyLedgerReconciliationResult = {
		claimed: 0,
		completed: 0,
		failed: 0,
		skipped: 0,
		timedOut: false,
	};
	const attemptedIds = new Set<string>();

	while (result.claimed < batchSize) {
		if (Date.now() - startedAt >= maxRuntimeMs) {
			result.timedOut = true;
			break;
		}

		const row = claimNextMemoryDirtyLedgerRow({
			userId: params.userId,
			resetGeneration,
			attemptedIds,
		});
		if (!row) break;
		attemptedIds.add(row.id);
		result.claimed += 1;

		if (!isOneOf(row.reason, MEMORY_DIRTY_REASONS)) {
			const metadata = parseJsonRecord(row.reasonMetadataJson);
			const completed = await completeClaimedMemoryDirtyLedgerRow({
				userId: params.userId,
				resetGeneration,
				id: row.id,
			});
			if (completed) {
				result.completed += 1;
			} else {
				result.skipped += 1;
			}
			await recordMemoryReworkTelemetry({
				userId: params.userId,
				eventFamily: "error_fallback",
				eventName: "dirty_ledger_invalid_reason_skipped",
				reason: row.reason,
				status: "skipped",
				count: row.count,
				subjectId: telemetrySubjectIdForDirtyMetadata(metadata) ?? undefined,
				metadata: {
					ledgerEntryId: row.id,
					scopeType: row.scopeType,
					scopeId: row.scopeId,
				},
			});
			continue;
		}

		try {
			await handleClaimedMemoryDirtyLedgerRow({
				userId: params.userId,
				row,
				loadLegacyMemoryCandidates: params.loadLegacyMemoryCandidates,
				curatePreservedLegacyMemory: params.curatePreservedLegacyMemory,
			});
			const completed = await completeClaimedMemoryDirtyLedgerRow({
				userId: params.userId,
				resetGeneration,
				id: row.id,
			});
			if (completed) {
				result.completed += 1;
			} else {
				result.skipped += 1;
			}
		} catch (error) {
			result.failed += 1;
			try {
				await requeueClaimedMemoryDirtyLedgerRow({
					userId: params.userId,
					resetGeneration,
					id: row.id,
				});
				await recordMemoryReworkTelemetry({
					userId: params.userId,
					eventFamily: "error_fallback",
					eventName: "dirty_ledger_reconciliation_failed",
					reason: row.reason,
					status: "retry_pending",
					count: row.count,
					subjectId:
						telemetrySubjectIdForDirtyMetadata(
							parseJsonRecord(row.reasonMetadataJson),
						) ?? undefined,
					metadata: {
						ledgerEntryId: row.id,
						errorName: error instanceof Error ? error.name : "UnknownError",
					},
				});
			} catch (telemetryError) {
				console.warn("[MEMORY_PROFILE] Dirty ledger retry failed", {
					userId: params.userId,
					ledgerEntryId: row.id,
					reason: row.reason,
					errorName:
						telemetryError instanceof Error
							? telemetryError.name
							: "UnknownError",
				});
			}
		}
	}

	return result;
}

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
