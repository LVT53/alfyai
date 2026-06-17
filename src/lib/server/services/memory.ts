import type {
	KnowledgeMemoryOverviewPayload,
	MemoryProfileActionPayload,
	MemoryProfilePublicItem,
	MemoryProfilePublicItemDetail,
	MemoryProfilePublicPayload,
} from "$lib/types";
import {
	applyMemoryReviewItemWithRevision,
	getMemoryProfileItemDetail,
	getMemoryProfileReadModel,
	type MemoryProfileCardItem,
	type MemoryProfileCategory,
	type MemoryProfileItemDetail,
	type MemoryProfileItemStatus,
	type MemoryProfileReadModel,
	markMemoryDirty,
	recordMemoryReworkTelemetry,
	updateMemoryProfileItemWithRevision,
} from "./memory-profile";

export class MemoryProfileActionError extends Error {
	readonly code: "invalid_action" | "stale_projection" | "not_found";
	readonly status: number;

	constructor(
		code: MemoryProfileActionError["code"],
		message: string,
		status: number,
	) {
		super(message);
		this.name = "MemoryProfileActionError";
		this.code = code;
		this.status = status;
	}
}

function serializeMemoryProfileItem(
	item: MemoryProfileCardItem,
): MemoryProfilePublicItem {
	return {
		...item,
		updatedAt: item.updatedAt.toISOString(),
	};
}

function serializeMemoryProfileItemDetail(
	item: MemoryProfileItemDetail,
): MemoryProfilePublicItemDetail {
	return {
		...serializeMemoryProfileItem(item),
		sourceChips: item.sourceChips,
		whyRemembered: item.whyRemembered,
	};
}

function serializeMemoryProfileReadModel(
	profile: MemoryProfileReadModel,
): MemoryProfilePublicPayload {
	return {
		resetGeneration: profile.resetGeneration,
		projectionRevision: profile.projectionRevision,
		categories: profile.categories.map((group) => ({
			category: group.category,
			items: group.items.map(serializeMemoryProfileItem),
		})),
		review: profile.review,
	};
}

async function markStaleProjectionRead(userId: string, source: string) {
	await markMemoryDirty({
		userId,
		reason: "stale_projection",
		scope: { type: "global" },
		metadata: { source },
	});
}

async function markLegacyMigrationRead(userId: string, source: string) {
	await markMemoryDirty({
		userId,
		reason: "legacy_migration",
		scope: { type: "global" },
		metadata: { source },
	});
}

function hasActiveMemoryProfileItems(profile: MemoryProfileReadModel): boolean {
	return profile.categories.some((group) => group.items.length > 0);
}

function queueMemoryReadMaintenance(userId: string, source: string): void {
	void import("./memory-maintenance")
		.then(({ runUserMemoryMaintenance }) =>
			runUserMemoryMaintenance(userId, source),
		)
		.catch((error) => {
			console.error("[KNOWLEDGE_MEMORY] Deferred maintenance failed", {
				userId,
				source,
				error,
			});
		});
}

async function bootstrapEmptyMemoryProfile(
	userId: string,
	source: string,
	profile: MemoryProfileReadModel,
): Promise<MemoryProfileReadModel> {
	if (hasActiveMemoryProfileItems(profile)) return profile;

	await markLegacyMigrationRead(userId, source);
	queueMemoryReadMaintenance(userId, source);
	return profile;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isExpectedProjectionRevision(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

type ParsedMemoryProfileAction = MemoryProfileActionPayload;

function parseMemoryProfileAction(payload: unknown): ParsedMemoryProfileAction {
	if (!payload || typeof payload !== "object") {
		throw new MemoryProfileActionError(
			"invalid_action",
			"Invalid memory profile action payload.",
			400,
		);
	}
	const record = payload as Record<string, unknown>;
	const itemId = record.itemId;
	const expectedProjectionRevision = record.expectedProjectionRevision;
	if (
		record.target !== undefined &&
		record.target !== "profile_item" &&
		record.target !== "review_item"
	) {
		throw new MemoryProfileActionError(
			"invalid_action",
			"Invalid memory profile action payload.",
			400,
		);
	}
	const target =
		record.target === "review_item" ? "review_item" : "profile_item";
	if (
		!isNonEmptyString(itemId) ||
		!isExpectedProjectionRevision(expectedProjectionRevision)
	) {
		throw new MemoryProfileActionError(
			"invalid_action",
			"Memory profile actions require itemId and expectedProjectionRevision.",
			400,
		);
	}

	if (target === "review_item") {
		if (record.action === "accept") {
			return {
				target: "review_item",
				action: "accept",
				itemId: itemId.trim(),
				expectedProjectionRevision,
			};
		}
		if (record.action === "suppress") {
			return {
				target: "review_item",
				action: "suppress",
				itemId: itemId.trim(),
				expectedProjectionRevision,
			};
		}
		if (record.action === "edit" && isNonEmptyString(record.statement)) {
			return {
				target: "review_item",
				action: "edit",
				itemId: itemId.trim(),
				statement: record.statement.trim(),
				expectedProjectionRevision,
			};
		}
		throw new MemoryProfileActionError(
			"invalid_action",
			"Invalid memory profile action payload.",
			400,
		);
	}

	if (record.action === "delete" || record.action === "suppress") {
		return {
			target: "profile_item",
			action: record.action,
			itemId: itemId.trim(),
			expectedProjectionRevision,
		};
	}

	if (record.action === "edit" && isNonEmptyString(record.statement)) {
		return {
			target: "profile_item",
			action: "edit",
			itemId: itemId.trim(),
			statement: record.statement.trim(),
			expectedProjectionRevision,
		};
	}

	throw new MemoryProfileActionError(
		"invalid_action",
		"Invalid memory profile action payload.",
		400,
	);
}

async function markProfileActionReconciliation(params: {
	userId: string;
	action: ParsedMemoryProfileAction["action"];
	itemId?: string | null;
	reviewItemId?: string;
}) {
	const metadata = {
		action: params.action,
		...(params.itemId ? { itemId: params.itemId } : {}),
		...(params.reviewItemId ? { reviewItemId: params.reviewItemId } : {}),
	};
	await markMemoryDirty({
		userId: params.userId,
		reason: "profile_action_reconciliation",
		scope: { type: "global" },
		metadata,
	});
	await markMemoryDirty({
		userId: params.userId,
		reason: "honcho_reconciliation",
		scope: { type: "global" },
		metadata,
	});
}

async function recordProfileActionTelemetry(params: {
	userId: string;
	action: ParsedMemoryProfileAction["action"];
	itemId: string;
	status: "updated" | "stale_projection" | "not_found";
	target?: "profile_item" | "review_item";
}) {
	await recordMemoryReworkTelemetry({
		userId: params.userId,
		eventFamily: "profile_action",
		eventName: `memory_profile_${params.action}`,
		reason: "user_action",
		status: params.status,
		subjectId: params.itemId,
		metadata: {
			action: params.action,
			...(params.target ? { target: params.target } : {}),
		},
	});
}

async function recordReviewActionTelemetry(params: {
	userId: string;
	action: Extract<
		ParsedMemoryProfileAction["action"],
		"accept" | "edit" | "suppress"
	>;
	reviewItemId: string;
	itemId?: string | null;
	category?: MemoryProfileCategory | null;
	status: "updated" | "stale_projection" | "not_found";
}) {
	await recordMemoryReworkTelemetry({
		userId: params.userId,
		eventFamily: "guided_review",
		eventName: `memory_review_${params.action}`,
		category: params.category ?? undefined,
		reason: "user_action",
		status: params.status,
		subjectId: params.reviewItemId,
		metadata: {
			action: params.action,
			...(params.itemId ? { itemId: params.itemId } : {}),
		},
	});
}

export async function getKnowledgeMemory(
	userId: string,
	_userDisplayName: string,
): Promise<MemoryProfilePublicPayload> {
	const source = "knowledge_memory_read";
	await markStaleProjectionRead(userId, source);
	const profile = await bootstrapEmptyMemoryProfile(
		userId,
		source,
		await getMemoryProfileReadModel({ userId }),
	);
	return serializeMemoryProfileReadModel(profile);
}

export async function getKnowledgeMemoryItemDetail(
	userId: string,
	itemId: string,
): Promise<MemoryProfilePublicItemDetail | null> {
	const detail = await getMemoryProfileItemDetail({ userId, itemId });
	return detail ? serializeMemoryProfileItemDetail(detail) : null;
}

function buildCompatibilitySummary(
	profile: MemoryProfilePublicPayload,
): KnowledgeMemoryOverviewPayload["summary"] {
	const activeItemCount = profile.categories.reduce(
		(total, group) => total + group.items.length,
		0,
	);
	return {
		personaCount: activeItemCount,
		taskCount: 0,
		focusContinuityCount: 0,
		activeConstraintCount:
			profile.categories.find(
				(group) => group.category === "constraints_boundaries",
			)?.items.length ?? 0,
		currentProjectContextCount:
			profile.categories.find(
				(group) => group.category === "goals_ongoing_work",
			)?.items.length ?? 0,
		overview: null,
		overviewBullets: [],
		overviewSource: null,
		overviewStatus: activeItemCount > 0 ? "ready" : "not_enough_durable_memory",
		overviewUpdatedAt: null,
		overviewLastAttemptAt: Date.now(),
		durablePersonaCount: activeItemCount,
	};
}

export async function getKnowledgeMemoryOverview(
	userId: string,
	_userDisplayName: string,
	options: { awaitLive?: boolean; force?: boolean } = {},
): Promise<KnowledgeMemoryOverviewPayload> {
	const source = options.force
		? "knowledge_memory_overview_force_read"
		: "knowledge_memory_overview_read";
	await markStaleProjectionRead(userId, source);
	const profile = serializeMemoryProfileReadModel(
		await bootstrapEmptyMemoryProfile(
			userId,
			source,
			await getMemoryProfileReadModel({ userId }),
		),
	);
	return {
		summary: buildCompatibilitySummary(profile),
		profile,
	};
}

export async function applyKnowledgeMemoryAction(
	userId: string,
	_userDisplayName: string,
	payload: unknown,
): Promise<MemoryProfilePublicPayload> {
	const action = parseMemoryProfileAction(payload);
	if (action.target === "review_item") {
		const reviewResult = await applyMemoryReviewItemWithRevision({
			userId,
			reviewItemId: action.itemId,
			expectedProjectionRevision: action.expectedProjectionRevision,
			action:
				action.action === "suppress"
					? "dismiss"
					: action.action === "accept"
						? "accept"
						: "edit",
			...(action.action === "edit" ? { statement: action.statement } : {}),
		});

		if (reviewResult.status !== "updated") {
			await recordReviewActionTelemetry({
				userId,
				action: action.action,
				reviewItemId: action.itemId,
				status: reviewResult.status,
			});
			await recordProfileActionTelemetry({
				userId,
				action: action.action,
				itemId: action.itemId,
				status: reviewResult.status,
				target: "review_item",
			});
			if (reviewResult.status === "stale_projection") {
				throw new MemoryProfileActionError(
					"stale_projection",
					"Memory profile changed before this action was applied.",
					409,
				);
			}
			throw new MemoryProfileActionError(
				"not_found",
				"Memory review item was not found.",
				404,
			);
		}

		await markProfileActionReconciliation({
			userId,
			action: action.action,
			itemId: reviewResult.itemId,
			reviewItemId: action.itemId,
		});
		await recordReviewActionTelemetry({
			userId,
			action: action.action,
			reviewItemId: action.itemId,
			itemId: reviewResult.itemId,
			category: reviewResult.category,
			status: "updated",
		});
		await recordProfileActionTelemetry({
			userId,
			action: action.action,
			itemId: reviewResult.itemId ?? action.itemId,
			status: "updated",
			target: "review_item",
		});

		return serializeMemoryProfileReadModel(
			await getMemoryProfileReadModel({ userId }),
		);
	}

	const patch: {
		statement?: string;
		status?: MemoryProfileItemStatus;
	} =
		action.action === "edit"
			? { statement: action.statement }
			: { status: action.action === "delete" ? "deleted" : "suppressed" };
	const result = await updateMemoryProfileItemWithRevision({
		userId,
		itemId: action.itemId,
		expectedProjectionRevision: action.expectedProjectionRevision,
		patch,
	});

	if (result.status !== "updated") {
		await recordProfileActionTelemetry({
			userId,
			action: action.action,
			itemId: action.itemId,
			status: result.status,
		});
		if (result.status === "stale_projection") {
			throw new MemoryProfileActionError(
				"stale_projection",
				"Memory profile changed before this action was applied.",
				409,
			);
		}
		throw new MemoryProfileActionError(
			"not_found",
			"Memory profile item was not found.",
			404,
		);
	}

	await markProfileActionReconciliation({
		userId,
		action: action.action,
		itemId: action.itemId,
	});
	await recordProfileActionTelemetry({
		userId,
		action: action.action,
		itemId: action.itemId,
		status: "updated",
	});

	return serializeMemoryProfileReadModel(
		await getMemoryProfileReadModel({ userId }),
	);
}
