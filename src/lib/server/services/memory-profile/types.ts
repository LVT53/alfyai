import type { LegacyPersonaMemoryCandidateBatch } from "./legacy";

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
	"projection_reconciliation",
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

export type MemoryProfilePolicyBlockedStatement = {
	id: string;
	status: Extract<
		MemoryProfileItemStatus,
		| "deleted"
		| "suppressed"
		| "expired"
		| "blocked"
		| "review_needed"
		| "preserved_legacy"
	>;
	statement: string;
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

export type JsonRecord = Record<string, unknown>;

export function assertMemoryProfileCategory(
	category: string,
): asserts category is MemoryProfileCategory {
	if (!MEMORY_PROFILE_CATEGORIES.includes(category as MemoryProfileCategory)) {
		throw new Error(`Unsupported memory profile category: ${category}`);
	}
}

export function assertOneOf<T extends readonly string[]>(
	value: string,
	allowed: T,
	label: string,
): asserts value is T[number] {
	if (!allowed.includes(value)) {
		throw new Error(`Unsupported ${label}: ${value}`);
	}
}

export function isOneOf<T extends readonly string[]>(
	value: string,
	allowed: T,
): value is T[number] {
	return allowed.includes(value);
}

export function readMemoryProfileCategory(
	value: unknown,
): MemoryProfileCategory | null {
	return typeof value === "string" &&
		MEMORY_PROFILE_CATEGORIES.includes(value as MemoryProfileCategory)
		? (value as MemoryProfileCategory)
		: null;
}

export function assertPrivacySafeMetadata(
	metadata: JsonRecord | undefined,
): void {
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
