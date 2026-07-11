import { getPersonaSummary } from "$lib/server/services/memory-consolidation/summary";
import {
	type ActiveMemoryProfileContext,
	type FormattedActiveMemoryProfileContext,
	formatActiveMemoryProfileContextForPrompt,
	getActiveMemoryProfileContext,
	type MemoryProfileScope,
} from "$lib/server/services/memory-profile/active-context";
import { getConversationProjectId } from "$lib/server/services/projects";
import { shortlistSemanticMatchesBySubject } from "$lib/server/services/semantic-ranking";
import { clipText, normalizeWhitespace } from "$lib/server/utils/text";
import type { ToolEvidenceCandidate } from "$lib/types";
import { buildMemoryReadSanitizer } from "./sanitize";
import {
	recordMemoryPromptTelemetry,
	summarizeActiveMemoryProfileTelemetry,
} from "./telemetry";
import type {
	GetMemoryContextParams,
	PersonaMemoryContextResult,
} from "./types";

export const DEFAULT_PERSONA_RECALL_QUERY =
	"What durable user preferences, goals, constraints, and personal context are relevant?";
export const PERSONA_ACTIVE_PROFILE_TOKEN_BUDGET = 8_000;
export const PERSONA_FACTS_MIN_TOKEN_BUDGET = 1_000;
const PERSONA_FACT_TITLE_MAX_CHARS = 120;
const PERSONA_SEMANTIC_SHORTLIST_THRESHOLD = 12;
const PERSONA_SEMANTIC_SHORTLIST_LIMIT = 12;

export type ActiveMemoryProfileItem =
	ActiveMemoryProfileContext["items"][number];

/**
 * Reserve room for the persona summary out of the total persona budget while
 * never starving the facts section below its floor.
 */
export function derivePersonaFactsBudget(params: {
	baseBudget: number;
	summaryTokens: number;
}): number {
	return Math.max(
		PERSONA_FACTS_MIN_TOKEN_BUDGET,
		params.baseBudget - params.summaryTokens,
	);
}

export function buildPersonaFactEvidenceCandidates(params: {
	includedItemIds: string[];
	itemsById: Map<string, ActiveMemoryProfileItem>;
}): ToolEvidenceCandidate[] {
	const candidates: ToolEvidenceCandidate[] = [];
	for (const itemId of params.includedItemIds) {
		const item = params.itemsById.get(itemId);
		if (!item) continue;
		const title = clipText(
			normalizeWhitespace(item.statement),
			PERSONA_FACT_TITLE_MAX_CHARS,
		);
		candidates.push({
			id: `memory-fact:${itemId}`,
			title,
			sourceType: "memory",
			metadata: { memoryItemId: itemId },
		});
	}
	return candidates;
}

type PersonaSummary = Awaited<ReturnType<typeof getPersonaSummary>>;

export type PersonaRetrieval =
	| { status: "error"; error: string }
	| {
			status: "ok";
			activeProfile: ActiveMemoryProfileContext;
			factItems: ActiveMemoryProfileItem[];
			formatted: FormattedActiveMemoryProfileContext;
			summary: PersonaSummary | null;
	  };

/**
 * Single source of persona retrieval shared by the baseline profile injection
 * (facts only, model-scaled budget, no summary/shortlist) and the memory_context
 * tool (summary + facts, fixed budget, semantic top-K). Callers supply the
 * scopes, budget and feature flags and own their own composition/telemetry so
 * their existing behaviour is preserved; the fetch → shortlist → format engine
 * lives here exactly once.
 */
export async function retrievePersonaMemory(params: {
	userId: string;
	applicableScopes: MemoryProfileScope[];
	query?: string | null;
	includeSummary: boolean;
	applyShortlist: boolean;
	baseBudget: number;
}): Promise<PersonaRetrieval> {
	let summary: PersonaSummary | null;
	let activeProfile: ActiveMemoryProfileContext;
	try {
		[summary, activeProfile] = await Promise.all([
			params.includeSummary
				? getPersonaSummary({ userId: params.userId })
				: Promise.resolve(null),
			getActiveMemoryProfileContext({
				userId: params.userId,
				applicableScopes: params.applicableScopes,
			}),
		]);
	} catch (error) {
		return {
			status: "error",
			error:
				error instanceof Error ? error.message : "Memory profile unavailable",
		};
	}

	// Top-K: only when requested, a query is present and the active fact set is
	// large, rank facts semantically and keep the best matches. A null shortlist
	// (no TEI configured) leaves the full fact set untouched.
	let factItems = activeProfile.items;
	const trimmedQuery = params.query?.trim() ?? "";
	if (
		params.applyShortlist &&
		trimmedQuery &&
		factItems.length > PERSONA_SEMANTIC_SHORTLIST_THRESHOLD
	) {
		const shortlist = await shortlistSemanticMatchesBySubject({
			userId: params.userId,
			subjectType: "memory_profile_item",
			query: trimmedQuery,
			items: factItems,
			getSubjectId: (item) => item.id,
			limit: PERSONA_SEMANTIC_SHORTLIST_LIMIT,
		}).catch(() => null);
		if (shortlist) {
			factItems = shortlist.map((match) => match.item);
		}
	}

	const summaryTokens = summary ? Math.ceil(summary.text.length / 4) : 0;
	const factsMaxTokens = params.includeSummary
		? derivePersonaFactsBudget({ baseBudget: params.baseBudget, summaryTokens })
		: params.baseBudget;
	const formatted = formatActiveMemoryProfileContextForPrompt(
		{ ...activeProfile, items: factItems },
		{ maxTokens: factsMaxTokens },
	);

	return { status: "ok", activeProfile, factItems, formatted, summary };
}

/**
 * memory_context tool persona handler. Thin composition over the shared engine:
 * builds project+conversation scopes, records the tool telemetry vocabulary,
 * sanitises the summary and shapes the tool result.
 */
export async function getPersonaMemoryContext(
	params: GetMemoryContextParams,
): Promise<PersonaMemoryContextResult> {
	const query = params.query?.trim() || DEFAULT_PERSONA_RECALL_QUERY;

	const projectId = await getConversationProjectId(
		params.userId,
		params.conversationId,
	).catch(() => null);
	const applicableScopes: MemoryProfileScope[] = [];
	if (projectId) {
		applicableScopes.push({ type: "project", id: projectId });
	}
	applicableScopes.push({ type: "conversation", id: params.conversationId });

	const retrieval = await retrievePersonaMemory({
		userId: params.userId,
		applicableScopes,
		query: params.query,
		includeSummary: true,
		applyShortlist: true,
		baseBudget: PERSONA_ACTIVE_PROFILE_TOKEN_BUDGET,
	});

	if (retrieval.status === "error") {
		await recordMemoryPromptTelemetry({
			userId: params.userId,
			eventName: "memory_context_persona_active_profile_blocked",
			reason: "active_profile_context_error",
			status: "error",
			count: 0,
		});
		return {
			success: true,
			mode: "persona",
			status: "error",
			source: "active_memory_profile",
			content: null,
			error: retrieval.error,
			evidenceCandidates: [],
			audit: { conversationId: params.conversationId, query },
		};
	}

	const { activeProfile, factItems, formatted, summary } = retrieval;
	const sanitize = buildMemoryReadSanitizer({
		userId: params.userId,
		userDisplayName: params.userDisplayName,
	});

	const summarySection = summary
		? `Persona summary (auto-maintained):\n${sanitize(summary.text)}`
		: null;
	const factsSection =
		formatted.includedCount > 0 ? `Facts:\n${formatted.content}` : null;
	const content =
		[summarySection, factsSection].filter(Boolean).join("\n\n") || null;

	if (!content) {
		await recordMemoryPromptTelemetry({
			userId: params.userId,
			eventName: "memory_context_persona_active_profile_empty",
			reason: "no_active_projection_items",
			status: "empty",
			count: 0,
			metadata: {
				projectionRevision: activeProfile.projectionRevision,
				resetGeneration: activeProfile.resetGeneration,
				totalItemCount: activeProfile.items.length,
				omittedItemCount: formatted.omittedCount,
				hasSummary: false,
			},
		});
		return {
			success: true,
			mode: "persona",
			status: "empty",
			source: "active_memory_profile",
			content: null,
			evidenceCandidates: [],
			audit: { conversationId: params.conversationId, query },
		};
	}

	await recordMemoryPromptTelemetry({
		userId: params.userId,
		eventName: "memory_context_persona_active_profile_included",
		reason: "active_projection_items",
		status: "included",
		count: formatted.includedCount,
		metadata: {
			projectionRevision: activeProfile.projectionRevision,
			resetGeneration: activeProfile.resetGeneration,
			totalItemCount: activeProfile.items.length,
			shortlistedItemCount: factItems.length,
			omittedItemCount: formatted.omittedCount,
			estimatedTokens: formatted.estimatedTokens,
			hasSummary: Boolean(summary),
			...summarizeActiveMemoryProfileTelemetry(activeProfile),
		},
	});

	let evidenceCandidates: ToolEvidenceCandidate[] = [];
	if (params.includeEvidenceCandidates !== false) {
		const itemsById = new Map(factItems.map((item) => [item.id, item]));
		evidenceCandidates = buildPersonaFactEvidenceCandidates({
			includedItemIds: formatted.includedItemIds,
			itemsById,
		});
		if (summary) {
			evidenceCandidates.push({
				id: `memory-context:summary:${params.userId}`,
				title: "Persona summary",
				sourceType: "memory",
			});
		}
	}

	return {
		success: true,
		mode: "persona",
		status: "available",
		source: "active_memory_profile",
		content,
		evidenceCandidates,
		audit: { conversationId: params.conversationId, query },
	};
}
