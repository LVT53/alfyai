import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import {
	type MessageUserIntent,
	parseMessageUserIntent,
} from "$lib/message-user-intent";
import type { InterimThoughtStep } from "$lib/response-activity-types";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import {
	contextCompressionSnapshots,
	conversations,
	messageAnalytics,
	messages,
	usageEvents,
} from "$lib/server/db/schema";
import type { DepthMetadata } from "$lib/server/services/chat-turn/depth-metadata-types";
import type {
	ForkEvidenceSnapshot,
	MessageEvidenceStatusState,
	MessageEvidenceSummary,
} from "$lib/server/services/message-evidence";
import type {
	ChatMessage,
	ChatTurnCompletionWarningCode,
	MessageRole,
	ThinkingSegment,
} from "$lib/server/services/messages-types";
import type {
	SkillControlMessageMetadata,
	SkillDraftProposal,
	SkillDraftStatus,
} from "$lib/server/services/skills/types";
import type {
	WebCitationAudit,
	WebCitationRepairSummary,
} from "$lib/server/services/web-citation-audit";
import type { InstructionScopeApplication } from "$lib/shared/instructions";
import { parseThoughtSteps } from "./chat-turn/thought-steps";
import { listMessageAttachments } from "./knowledge";
import { messageOrderAsc, messageOrderDesc } from "./message-ordering";
import { repairConversationMessageSequencesWithExecutor } from "./message-sequences";

type PersistedMessageMetadata = SkillControlMessageMetadata & {
	evidenceSummary?: MessageEvidenceSummary | null;
	evidenceStatus?: MessageEvidenceStatusState;
	// Workspaces Slice E — how many of the conversation's project files this
	// turn actually read (a count, never a list; see `projectFilesRead` on
	// ChatMessage). Written by the evidence step in the same metadata write
	// that records evidenceStatus, because the count is defined by the evidence
	// the turn selected and the project's links, and only that step has both.
	// Absent — never 0 — when the turn read none, so a stale count from an
	// earlier turn cannot leave a row that names nothing that happened.
	projectFilesRead?: number;
	modelDisplayName?: string | null;
	providerDisplayName?: string | null;
	providerIconUrl?: string | null;
	depthMetadata?: DepthMetadata;
	webCitationAudit?: WebCitationAudit | null;
	citationAudit?: WebCitationRepairSummary | null;
	// P3b (ADR-0056) — durable Interim Thought Step rail. Not read directly
	// off this parsed object (see projectMessageMetadata below, which uses
	// `parseThoughtSteps` against the raw `metadataJson` string so malformed
	// JSON degrades to `[]` rather than throwing here) — declared on this
	// type only so it round-trips through the persisted metadataJson like
	// every other metadata field.
	thoughtSteps?: InterimThoughtStep[];
	// A1 (owner idea) — the durable, LLM-summarized jump-rail headline for this
	// assistant turn (see `railSummary` on ChatMessage). Written back
	// additively by `updateMessageRailSummary` from the post-turn generation
	// step, and projected out in `projectMessageMetadata` below. Assistant
	// turns only (owner decision O-3).
	railSummary?: string;
	// Owner idea (variant A) — see `followUps` on ChatMessage. Written
	// directly into assistantMetadata by stream-completion.ts (resolved
	// before finalize persists the assistant message — unlike railSummary,
	// no separate write-back call is needed), and projected out in
	// projectMessageMetadata below.
	followUps?: string[];
	// What the user chose for this turn — see `userIntent` on ChatMessage and
	// $lib/message-user-intent.ts. Written into assistantMetadata by the send
	// route and stream-completion.ts; read back through
	// `parseMessageUserIntent` in projectMessageMetadata below, so a malformed
	// record degrades to "chose nothing" rather than reaching the client.
	userIntent?: MessageUserIntent;
	// Which instruction scopes shaped this turn — see `instructionsApplied` on
	// ChatMessage and $lib/shared/instructions.ts. Written into
	// assistantMetadata by the send route and stream-completion.ts from the
	// value context preparation resolved, and projected out below. Scopes only:
	// the instruction text itself never reaches a message record.
	instructionsApplied?: InstructionScopeApplication;
	wasStopped?: boolean;
	// E2 — persisted mirror of E1's completionWarningCodes (written alongside
	// wasStopped by finalize's assistantMetadata; see stream-completion.ts).
	// Projected back here so a reloaded page still shows the warning for a
	// turn that completed with an empty/truncated body, not just the live
	// stream.
	completionWarningCodes?: ChatTurnCompletionWarningCode[];
	forkCopy?: ChatMessage["forkCopy"];
	forkEvidenceSnapshot?: ForkEvidenceSnapshot;
};

export class SkillDraftTransitionError extends Error {
	constructor(
		public code: string,
		message: string,
		public status = 409,
	) {
		super(message);
		this.name = "SkillDraftTransitionError";
	}
}

function getModelDisplayName(modelId?: string | null): string | undefined {
	if (!modelId) return undefined;
	const config = getConfig();
	if (modelId === "model1") return config.model1.displayName;
	if (modelId === "model2") return config.model2.displayName;
	return undefined;
}

function isMessageEvidenceSummary(
	value: unknown,
): value is MessageEvidenceSummary {
	return Boolean(
		value &&
			typeof value === "object" &&
			Array.isArray((value as MessageEvidenceSummary).groups),
	);
}

function readEvidenceSummaryFromMetadata(
	metadata: PersistedMessageMetadata | null,
): MessageEvidenceSummary | null {
	if (
		isMessageEvidenceSummary(metadata?.forkEvidenceSnapshot?.evidenceSummary)
	) {
		return metadata.forkEvidenceSnapshot.evidenceSummary;
	}
	if (isMessageEvidenceSummary(metadata?.evidenceSummary)) {
		return metadata.evidenceSummary;
	}
	return null;
}

/**
 * Workspaces Slice E — a positive whole count, or nothing. Zero is not a value
 * here: the Info popover's row exists only when the turn read something, so a
 * 0 that leaked through would be a row about nothing.
 *
 * One definition, read by both the message projection and the evidence read
 * (see `getMessageEvidenceState`): the count is written in the same metadata
 * write as the evidence summary, and the evidence endpoint hands both to the
 * live page so the popover's row can appear without a reload.
 */
function readProjectFilesReadFromMetadata(
	metadata: PersistedMessageMetadata | null,
): number | undefined {
	return typeof metadata?.projectFilesRead === "number" &&
		Number.isFinite(metadata.projectFilesRead) &&
		metadata.projectFilesRead > 0
		? Math.trunc(metadata.projectFilesRead)
		: undefined;
}

function isDepthMetadata(value: unknown): value is DepthMetadata {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<DepthMetadata>;
	return hasValidDepthMetadataBase(candidate);
}

function hasValidDepthMetadataBase(candidate: Partial<DepthMetadata>): boolean {
	// `requested` on a message persisted before ADR-0061 (the thinking-toggle
	// redesign) still carries a legacy off/auto/max ladder value — this isn't
	// re-validated or migrated at read time, so a persisted message keeps
	// whichever value it was written with. Widened to `unknown` here because
	// the current ReasoningDepth type ("thorough" | "quick") has no overlap
	// with those legacy string literals.
	const requested: unknown = candidate.requested;
	return (
		(requested === "thorough" ||
			requested === "quick" ||
			requested === "off" ||
			requested === "auto" ||
			requested === "max") &&
		(candidate.appliedProfile === "off" ||
			candidate.appliedProfile === "standard" ||
			candidate.appliedProfile === "extended" ||
			candidate.appliedProfile === "maximum") &&
		typeof candidate.fallback === "boolean"
	);
}

// ADR-0061 removed `outcome`/`clarification` from DepthMetadata along with
// the Depth Clarification Gate. A message persisted before that removal may
// still carry those keys in its stored JSON; `hasValidDepthMetadataBase`
// above intentionally does not re-validate them — they ride along as
// unused, harmless extra fields on the parsed object instead.

function readThinkingSegmentsFromRow(
	row: Pick<typeof messages.$inferSelect, "toolCalls">,
): ChatMessage["thinkingSegments"] {
	if (!row.toolCalls) return undefined;
	try {
		const parsed = JSON.parse(row.toolCalls) as ThinkingSegment[];
		if (Array.isArray(parsed) && parsed.length > 0) {
			return parsed;
		}
	} catch {
		// Malformed JSON — silently ignore, fall back to flat thinking text
	}
	return undefined;
}

function readDepthMetadataFromMetadata(
	metadata: PersistedMessageMetadata | null,
): DepthMetadata | undefined {
	if (isDepthMetadata(metadata?.depthMetadata)) {
		return metadata.depthMetadata;
	}
	return undefined;
}

function projectMessageModel(
	metadata: PersistedMessageMetadata | null,
	modelId?: string | null,
): Pick<
	ChatMessage,
	"modelId" | "modelDisplayName" | "providerDisplayName" | "providerIconUrl"
> {
	return {
		modelId: modelId as ChatMessage["modelId"],
		modelDisplayName:
			metadata?.modelDisplayName ?? getModelDisplayName(modelId),
		providerDisplayName: metadata?.providerDisplayName ?? undefined,
		providerIconUrl: metadata?.providerIconUrl ?? undefined,
	};
}

function projectMessageUsage(
	generationTimeMs?: number | null,
	costUsdMicros?: number | null,
	usageTokens?: {
		completionTokens?: number | null;
		reasoningTokens?: number | null;
		totalTokens?: number | null;
	},
): Pick<
	ChatMessage,
	| "generationDurationMs"
	| "thinkingTokenCount"
	| "responseTokenCount"
	| "totalTokenCount"
	| "costUsd"
> {
	return {
		generationDurationMs: generationTimeMs ?? undefined,
		thinkingTokenCount: usageTokens?.reasoningTokens ?? undefined,
		responseTokenCount: usageTokens?.completionTokens ?? undefined,
		totalTokenCount: usageTokens?.totalTokens ?? undefined,
		costUsd: costUsdMicros != null ? costUsdMicros / 1_000_000 : undefined,
	};
}

function projectMessageMetadata(
	row: typeof messages.$inferSelect,
	metadata: PersistedMessageMetadata | null,
): Pick<
	ChatMessage,
	| "evidenceSummary"
	| "webCitationAudit"
	| "citationAudit"
	| "evidencePending"
	| "wasStopped"
	| "completionWarningCodes"
	| "depthMetadata"
	| "skillDrafts"
	| "skillControl"
	| "forkCopy"
	| "forkEvidenceSnapshot"
	| "importSource"
	| "thoughtSteps"
	| "railSummary"
	| "followUps"
	| "userIntent"
	| "instructionsApplied"
	| "projectFilesRead"
> {
	const evidenceSummary =
		readEvidenceSummaryFromMetadata(metadata) ?? undefined;
	const evidencePending =
		metadata?.evidenceStatus === "pending" && !evidenceSummary;
	// P3b (ADR-0056) — the ADR-0022 read model's projection of the durable
	// step rail: reads straight off the raw metadataJson string (not the
	// already-parsed `metadata` object) via the same dormant reader P3a
	// built and the honesty-audit harness already exercises, so malformed
	// JSON degrades to `[]` here exactly as it does there.
	const thoughtSteps = parseThoughtSteps(row.metadataJson);

	return {
		evidenceSummary,
		webCitationAudit: metadata?.webCitationAudit ?? undefined,
		citationAudit: metadata?.citationAudit ?? undefined,
		evidencePending,
		wasStopped: metadata?.wasStopped === true ? true : undefined,
		completionWarningCodes: Array.isArray(metadata?.completionWarningCodes)
			? metadata.completionWarningCodes
			: undefined,
		depthMetadata: readDepthMetadataFromMetadata(metadata),
		skillDrafts: Array.isArray(metadata?.skillDrafts)
			? metadata.skillDrafts
			: undefined,
		skillControl: metadata?.skillControl,
		forkCopy: metadata?.forkCopy,
		forkEvidenceSnapshot: metadata?.forkEvidenceSnapshot,
		importSource: row.importSource ?? undefined,
		thoughtSteps: thoughtSteps.length > 0 ? thoughtSteps : undefined,
		// A1 — the durable LLM rail summary, projected exactly like every other
		// optional metadata field: the string when present and non-blank,
		// `undefined` otherwise (never `""`), so `railEntryText`'s `??` fallback
		// to the verbatim truncation only fires on a genuinely absent summary.
		railSummary:
			typeof metadata?.railSummary === "string" &&
			metadata.railSummary.trim().length > 0
				? metadata.railSummary
				: undefined,
		// Owner idea (variant A) — plain array field, no anchor validation
		// needed (unlike thoughtSteps): present and non-empty, or `undefined`.
		followUps:
			Array.isArray(metadata?.followUps) && metadata.followUps.length > 0
				? metadata.followUps
				: undefined,
		// Validated, not passed through: absent (every message from before the
		// record existed) and malformed both read as `undefined`.
		userIntent: parseMessageUserIntent(metadata?.userIntent),
		// Workspaces Slice E — the same count the evidence read projects, from
		// the same rule; see `readProjectFilesReadFromMetadata`.
		projectFilesRead: readProjectFilesReadFromMetadata(metadata),
		// Scopes applied to the turn, or `undefined` when the record is missing
		// or is not an object at all — never a partially-shaped value the Info
		// popover would have to defend against.
		instructionsApplied:
			metadata?.instructionsApplied &&
			typeof metadata.instructionsApplied === "object"
				? metadata.instructionsApplied
				: undefined,
	};
}

function mapRowToChatMessage(
	row: typeof messages.$inferSelect,
	modelId?: string | null,
	generationTimeMs?: number | null,
	costUsdMicros?: number | null,
	usageTokens?: {
		completionTokens?: number | null;
		reasoningTokens?: number | null;
		totalTokens?: number | null;
	},
): ChatMessage {
	const metadata = parseMetadata(row.metadataJson);

	return {
		id: row.id,
		role: row.role as MessageRole,
		content: row.content,
		thinking: row.thinking ?? undefined,
		thinkingSegments: readThinkingSegmentsFromRow(row),
		timestamp: row.createdAt.getTime(),
		...projectMessageModel(metadata, modelId),
		...projectMessageUsage(generationTimeMs, costUsdMicros, usageTokens),
		...projectMessageMetadata(row, metadata),
	};
}

function parseMetadata(value: string | null): PersistedMessageMetadata | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as PersistedMessageMetadata;
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

function messageWindowBaseQuery(conversationId: string) {
	return db
		.select({
			message: messages,
			model: usageEvents.modelId,
			legacyModel: messageAnalytics.model,
			modelDisplayName: usageEvents.modelDisplayName,
			generationTimeMs: usageEvents.generationTimeMs,
			costUsdMicros: usageEvents.costUsdMicros,
			completionTokens: usageEvents.completionTokens,
			reasoningTokens: usageEvents.reasoningTokens,
			totalTokens: usageEvents.totalTokens,
			legacyGenerationTimeMs: messageAnalytics.generationTimeMs,
		})
		.from(messages)
		.leftJoin(usageEvents, eq(messages.id, usageEvents.messageId))
		.leftJoin(messageAnalytics, eq(messages.id, messageAnalytics.messageId))
		.where(eq(messages.conversationId, conversationId));
}

type MessageWindowRow = Awaited<
	ReturnType<typeof messageWindowBaseQuery>
>[number];

function mapMessageWindowRows(
	rows: MessageWindowRow[],
	attachmentMap: Awaited<ReturnType<typeof listMessageAttachments>>,
): ChatMessage[] {
	const uniqueRows = new Map<string, MessageWindowRow>();
	for (const row of rows) {
		if (!uniqueRows.has(row.message.id)) {
			uniqueRows.set(row.message.id, row);
		}
	}

	return Array.from(uniqueRows.values()).map((row) => {
		const mapped = mapRowToChatMessage(
			row.message,
			row.model ?? row.legacyModel,
			row.generationTimeMs ?? row.legacyGenerationTimeMs,
			row.costUsdMicros,
			{
				completionTokens: row.completionTokens,
				reasoningTokens: row.reasoningTokens,
				totalTokens: row.totalTokens,
			},
		);
		return {
			...mapped,
			modelDisplayName: row.modelDisplayName ?? mapped.modelDisplayName,
			attachments: attachmentMap.get(row.message.id) ?? [],
		};
	});
}

export async function listMessages(
	conversationId: string,
): Promise<ChatMessage[]> {
	const [result, attachmentMap] = await Promise.all([
		messageWindowBaseQuery(conversationId).orderBy(...messageOrderAsc()),
		listMessageAttachments(conversationId),
	]);

	return mapMessageWindowRows(result, attachmentMap);
}

/**
 * O1 — the conversation-open read path does not need the entire message
 * history: it needs a recent window, plus a signal that older messages
 * exist so a caller can page backward on demand. Ordered `DESC` (newest
 * first) so the `LIMIT` bounds the row scan to the window itself rather
 * than reading the whole table and truncating in memory; the result is
 * reversed back to the conversation's natural ascending order before
 * returning. `offset` counts messages already loaded by the caller (from
 * the newest end), so passing the running total pages strictly older
 * messages on each call. 100 is chosen as generous headroom over the
 * production maximum observed at slice O1's measurement time (89
 * messages/conversation, 2026-08-15) — the bound exists to cap future
 * growth, not to trim today's conversations.
 */
export const CONVERSATION_MESSAGE_WINDOW_DEFAULT_LIMIT = 100;

export interface MessageWindowPage {
	messages: ChatMessage[];
	hasMoreBefore: boolean;
}

export async function listMessageWindow(
	conversationId: string,
	options: { limit?: number; offset?: number } = {},
): Promise<MessageWindowPage> {
	const limit = Math.max(
		1,
		Math.trunc(options.limit ?? CONVERSATION_MESSAGE_WINDOW_DEFAULT_LIMIT),
	);
	const offset = Math.max(0, Math.trunc(options.offset ?? 0));

	const [result, attachmentMap] = await Promise.all([
		messageWindowBaseQuery(conversationId)
			.orderBy(...messageOrderDesc())
			.limit(limit + 1)
			.offset(offset),
		listMessageAttachments(conversationId),
	]);

	const hasMoreBefore = result.length > limit;
	const windowRowsAscending = result.slice(0, limit).reverse();

	return {
		messages: mapMessageWindowRows(windowRowsAscending, attachmentMap),
		hasMoreBefore,
	};
}

/**
 * Reads only the most recently sequenced message in a conversation, via a
 * single-row `ORDER BY ... LIMIT 1` query. Unlike `listMessages`, this does
 * not join usage/analytics data or resolve attachments — callers that only
 * need the last message's role/content/metadata should use this instead of
 * loading the whole conversation.
 */
export async function getLastMessage(
	conversationId: string,
): Promise<ChatMessage | null> {
	const [row] = await db
		.select()
		.from(messages)
		.where(eq(messages.conversationId, conversationId))
		.orderBy(...messageOrderDesc())
		.limit(1);

	if (!row) return null;

	return mapRowToChatMessage(row);
}

export type ConversationExportMessage = {
	role: MessageRole;
	content: string;
	createdAt: Date;
};

export async function listConversationMessagesForExport(params: {
	conversationId: string;
	limit?: number;
}): Promise<ConversationExportMessage[]> {
	const limit = Math.max(1, Math.min(params.limit ?? 120, 200));

	const rows = await db
		.select({
			role: messages.role,
			content: messages.content,
			createdAt: messages.createdAt,
		})
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, params.conversationId),
				inArray(messages.role, ["user", "assistant"]),
			),
		)
		.orderBy(...messageOrderAsc())
		.limit(limit);

	return rows.map((row) => ({
		role: row.role as MessageRole,
		content: row.content,
		createdAt: row.createdAt,
	}));
}

export async function deleteMessages(ids: string[]): Promise<void> {
	if (ids.length === 0) return;
	db.transaction((tx) => {
		let deletedRows = tx
			.select({
				id: messages.id,
				conversationId: messages.conversationId,
				messageSequence: messages.messageSequence,
			})
			.from(messages)
			.where(inArray(messages.id, ids))
			.all();

		const conversationIds = Array.from(
			new Set(deletedRows.map((row) => row.conversationId)),
		);
		if (deletedRows.some((row) => row.messageSequence == null)) {
			for (const conversationId of conversationIds) {
				repairConversationMessageSequencesWithExecutor(tx, conversationId);
			}
			deletedRows = tx
				.select({
					id: messages.id,
					conversationId: messages.conversationId,
					messageSequence: messages.messageSequence,
				})
				.from(messages)
				.where(inArray(messages.id, ids))
				.all();
		}

		const earliestDeletedSequenceByConversation = new Map<string, number>();
		for (const row of deletedRows) {
			if (row.messageSequence == null) continue;
			const current = earliestDeletedSequenceByConversation.get(
				row.conversationId,
			);
			if (current == null || row.messageSequence < current) {
				earliestDeletedSequenceByConversation.set(
					row.conversationId,
					row.messageSequence,
				);
			}
		}

		for (const [
			conversationId,
			earliestDeletedMessageSequence,
		] of earliestDeletedSequenceByConversation) {
			tx.delete(contextCompressionSnapshots)
				.where(
					and(
						eq(contextCompressionSnapshots.conversationId, conversationId),
						gte(
							contextCompressionSnapshots.sourceEndMessageSequence,
							earliestDeletedMessageSequence,
						),
					),
				)
				.run();
		}

		tx.delete(messages).where(inArray(messages.id, ids)).run();
	});
}

export async function createMessage(
	conversationId: string,
	role: MessageRole,
	content: string,
	thinking?: string,
	thinkingSegments?: ThinkingSegment[],
	metadata?: PersistedMessageMetadata,
): Promise<ChatMessage> {
	const message = db.transaction((tx) => {
		repairConversationMessageSequencesWithExecutor(tx, conversationId);
		const nextSequence = tx
			.select({
				value: sql<number>`COALESCE(MAX(${messages.messageSequence}), 0) + 1`,
			})
			.from(messages)
			.where(eq(messages.conversationId, conversationId))
			.get();

		return tx
			.insert(messages)
			.values({
				id: randomUUID(),
				conversationId,
				messageSequence: nextSequence?.value ?? 1,
				role,
				content,
				thinking: thinking ?? null,
				toolCalls:
					thinkingSegments && thinkingSegments.length > 0
						? JSON.stringify(thinkingSegments)
						: null,
				metadataJson: metadata ? JSON.stringify(metadata) : null,
			})
			.returning()
			.get();
	});

	return mapRowToChatMessage(message);
}

export async function getMessageEvidenceState(
	conversationId: string,
	messageId: string,
): Promise<{
	status: MessageEvidenceStatusState;
	evidenceSummary: MessageEvidenceSummary | null;
	// Workspaces Slice E — how many of the conversation's project files this
	// turn read, the count the Info popover's "Project files" row prints. It is
	// written by `updateMessageEvidence` in the SAME metadata write as the
	// evidence summary, and it is defined by that same evidence (the selected
	// evidence intersecting the project's links — see `countProjectFilesRead`),
	// so it is read back here rather than fetched separately: the live page's
	// evidence poll is the only channel that carries a finished turn's evidence
	// to the browser, and a row about the evidence has to ride it.
	projectFilesRead: number | undefined;
	forkEvidenceSnapshot?: ForkEvidenceSnapshot;
} | null> {
	const [row] = await db
		.select({ metadataJson: messages.metadataJson })
		.from(messages)
		.where(
			and(
				eq(messages.id, messageId),
				eq(messages.conversationId, conversationId),
			),
		)
		.limit(1);

	if (!row) return null;

	const metadata = parseMetadata(row.metadataJson);
	const evidenceSummary = readEvidenceSummaryFromMetadata(metadata);

	return {
		status: metadata?.evidenceStatus ?? (evidenceSummary ? "ready" : "none"),
		evidenceSummary,
		projectFilesRead: readProjectFilesReadFromMetadata(metadata),
		forkEvidenceSnapshot: metadata?.forkEvidenceSnapshot,
	};
}

export async function updateMessageEvidence(
	messageId: string,
	params: {
		evidenceSummary?: MessageEvidenceSummary | null;
		evidenceStatus: MessageEvidenceStatusState;
		// Workspaces Slice E — how many of the project's files the turn read.
		// Optional on the call: the evidence step is the only writer that knows
		// it, and every other caller (a fork copy, a repair pass) leaves the
		// field exactly as the turn that produced it recorded it. Zero and
		// negative counts clear the field rather than persist a row about
		// nothing.
		projectFilesRead?: number;
	},
): Promise<void> {
	const [row] = await db
		.select({ metadataJson: messages.metadataJson })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);

	if (!row) return;

	const existing = parseMetadata(row.metadataJson) ?? {};
	const next: PersistedMessageMetadata = {
		...existing,
		evidenceStatus: params.evidenceStatus,
	};

	if (params.evidenceSummary && params.evidenceSummary.groups.length > 0) {
		next.evidenceSummary = params.evidenceSummary;
		next.evidenceStatus = "ready";
	} else if (params.evidenceStatus !== "ready") {
		delete next.evidenceSummary;
	}

	if (params.projectFilesRead != null && params.projectFilesRead > 0) {
		next.projectFilesRead = Math.trunc(params.projectFilesRead);
	} else if (params.projectFilesRead != null) {
		delete next.projectFilesRead;
	}

	await db
		.update(messages)
		.set({
			metadataJson: JSON.stringify(next),
		})
		.where(eq(messages.id, messageId));
}

export async function updateMessageWebCitationAudit(
	messageId: string,
	webCitationAudit: WebCitationAudit | null,
): Promise<void> {
	const [row] = await db
		.select({ metadataJson: messages.metadataJson })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);

	if (!row) return;

	const next: PersistedMessageMetadata = {
		...(parseMetadata(row.metadataJson) ?? {}),
	};
	if (webCitationAudit && webCitationAudit.status !== "none") {
		next.webCitationAudit = webCitationAudit;
	} else {
		delete next.webCitationAudit;
	}

	await db
		.update(messages)
		.set({
			metadataJson: Object.keys(next).length > 0 ? JSON.stringify(next) : null,
		})
		.where(eq(messages.id, messageId));
}

/**
 * A1 (owner idea) — write the durable, LLM-summarized jump-rail headline for
 * an assistant turn back into its `metadataJson.railSummary`, additively
 * (same paved road as `updateMessageWebCitationAudit`; no migration). Called
 * from the fire-and-forget post-turn generation step. A `null`/blank summary
 * clears the field (honesty: the rail falls back to the verbatim truncation),
 * a non-blank one is stored trimmed. Never `""` on disk.
 */
export async function updateMessageRailSummary(
	messageId: string,
	railSummary: string | null,
): Promise<void> {
	const [row] = await db
		.select({ metadataJson: messages.metadataJson })
		.from(messages)
		.where(eq(messages.id, messageId))
		.limit(1);

	if (!row) return;

	const next: PersistedMessageMetadata = {
		...(parseMetadata(row.metadataJson) ?? {}),
	};
	const trimmed = railSummary?.trim();
	if (trimmed) {
		next.railSummary = trimmed;
	} else {
		delete next.railSummary;
	}

	await db
		.update(messages)
		.set({
			metadataJson: Object.keys(next).length > 0 ? JSON.stringify(next) : null,
		})
		.where(eq(messages.id, messageId));
}

export async function getAssistantMessageSkillDraft(params: {
	conversationId: string;
	messageId: string;
	draftId: string;
}): Promise<SkillDraftProposal | null> {
	const [row] = await db
		.select({ metadataJson: messages.metadataJson, role: messages.role })
		.from(messages)
		.where(
			and(
				eq(messages.id, params.messageId),
				eq(messages.conversationId, params.conversationId),
				eq(messages.role, "assistant"),
			),
		)
		.limit(1);

	if (row?.role !== "assistant") return null;
	const metadata = parseMetadata(row.metadataJson);
	const drafts = Array.isArray(metadata?.skillDrafts)
		? metadata.skillDrafts
		: [];
	return drafts.find((draft) => draft.id === params.draftId) ?? null;
}

export async function isAssistantMessageForkCopy(params: {
	conversationId: string;
	messageId: string;
}): Promise<boolean> {
	const [row] = await db
		.select({ metadataJson: messages.metadataJson, role: messages.role })
		.from(messages)
		.where(
			and(
				eq(messages.id, params.messageId),
				eq(messages.conversationId, params.conversationId),
				eq(messages.role, "assistant"),
			),
		)
		.limit(1);

	if (row?.role !== "assistant") return false;
	return Boolean(parseMetadata(row.metadataJson)?.forkCopy);
}

export async function updateAssistantMessageSkillDraftStatus(params: {
	conversationId: string;
	messageId: string;
	draftId: string;
	status: SkillDraftStatus;
	savedSkillId?: string;
	publishedSystemSkillId?: string;
}): Promise<SkillDraftProposal | null> {
	const [row] = await db
		.select({ metadataJson: messages.metadataJson, role: messages.role })
		.from(messages)
		.where(
			and(
				eq(messages.id, params.messageId),
				eq(messages.conversationId, params.conversationId),
				eq(messages.role, "assistant"),
			),
		)
		.limit(1);

	if (row?.role !== "assistant") return null;

	const metadata = parseMetadata(row.metadataJson) ?? {};
	const drafts = Array.isArray(metadata.skillDrafts)
		? metadata.skillDrafts
		: [];
	const draftIndex = drafts.findIndex((draft) => draft.id === params.draftId);
	if (draftIndex === -1) return null;
	const currentDraft = drafts[draftIndex];

	if (
		params.status === "saved" &&
		currentDraft.status === "saved" &&
		currentDraft.savedSkillId
	) {
		return currentDraft;
	}

	if (currentDraft.status !== "proposed") {
		throw new SkillDraftTransitionError(
			"skill_draft_transition_conflict",
			"Skill draft is already in a final state.",
			409,
		);
	}

	if (
		(params.status === "saved" && !params.savedSkillId) ||
		params.status === "published"
	) {
		throw new SkillDraftTransitionError(
			"skill_draft_transition_conflict",
			"Skill draft transition is not allowed.",
			409,
		);
	}

	const nextDraft: SkillDraftProposal = {
		...currentDraft,
		status: params.status,
		updatedAt: Date.now(),
	};
	if (params.savedSkillId) {
		nextDraft.savedSkillId = params.savedSkillId;
	}
	if (params.publishedSystemSkillId) {
		nextDraft.publishedSystemSkillId = params.publishedSystemSkillId;
	}

	const nextDrafts = drafts.slice();
	nextDrafts[draftIndex] = nextDraft;
	const next: PersistedMessageMetadata = {
		...metadata,
		skillDrafts: nextDrafts,
	};

	await db
		.update(messages)
		.set({
			metadataJson: JSON.stringify(next),
		})
		.where(
			and(
				eq(messages.id, params.messageId),
				eq(messages.conversationId, params.conversationId),
				eq(messages.role, "assistant"),
			),
		);

	return nextDraft;
}

export async function clearMessageEvidenceForUser(
	userId: string,
): Promise<void> {
	const conversationRows = await db
		.select({ id: conversations.id })
		.from(conversations)
		.where(eq(conversations.userId, userId));
	const conversationIds = conversationRows.map((row) => row.id);
	if (conversationIds.length === 0) return;

	const rows = await db
		.select({ id: messages.id, metadataJson: messages.metadataJson })
		.from(messages)
		.where(inArray(messages.conversationId, conversationIds));

	for (const row of rows) {
		const metadata = parseMetadata(row.metadataJson);
		if (
			!metadata ||
			(!("evidenceSummary" in metadata) &&
				!("evidenceStatus" in metadata) &&
				!("webCitationAudit" in metadata) &&
				!("citationAudit" in metadata))
		) {
			continue;
		}

		const next = { ...metadata };
		delete next.evidenceSummary;
		delete next.evidenceStatus;
		delete next.webCitationAudit;
		delete next.citationAudit;

		await db
			.update(messages)
			.set({
				metadataJson:
					Object.keys(next).length > 0 ? JSON.stringify(next) : null,
			})
			.where(eq(messages.id, row.id));
	}
}
