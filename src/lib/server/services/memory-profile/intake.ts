import { createHash } from "node:crypto";
import {
	addMemoryProfileItemProvenance,
	createMemoryProfileItem,
	createOrUpdateMemoryReviewItem,
	getCurrentMemoryResetGeneration,
	getMemoryProfileReadModel,
	isCurrentMemoryResetGeneration,
	isStaleMemoryResetGenerationError,
	markMemoryDirty,
	recordMemoryReworkTelemetry,
	type MemoryProfileCategory,
	type MemoryProfileScope,
} from "./index";

type JsonRecord = Record<string, unknown>;

export type MemoryIntakeStatus = "admitted" | "deferred" | "rejected";

export type PostTurnMemoryIntakeParams = {
	userId: string;
	conversationId: string;
	userMessage: string;
	assistantMessage?: string | null;
	userMessageId?: string | null;
	assistantMessageId?: string | null;
	startedResetGeneration?: number;
};

export type PostTurnMemoryIntakeResult =
	| {
			status: "admitted";
			itemId: string;
			category: MemoryProfileCategory;
			duplicate: boolean;
	  }
	| {
			status: "deferred";
			reviewItemId: string;
			reason: string;
	  }
	| {
			status: "rejected";
			reason: string;
	  };

type ParsedDurableMemory =
	| {
			decision: "admit";
			category: MemoryProfileCategory;
			statement: string;
			parserRule: string;
	  }
	| {
			decision: "defer";
			reason: string;
			parserRule: string;
	  }
	| {
			decision: "reject";
			reason: string;
	  };

const GLOBAL_SCOPE: MemoryProfileScope = { type: "global" };

function cleanText(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function stripTerminalPunctuation(value: string): string {
	return cleanText(value)
		.replace(/[.!?]+$/g, "")
		.trim();
}

function sentence(value: string): string {
	const stripped = stripTerminalPunctuation(value);
	if (!stripped) return "";
	return `${stripped.charAt(0).toUpperCase()}${stripped.slice(1)}.`;
}

function lowerInitial(value: string): string {
	const stripped = stripTerminalPunctuation(value);
	if (!stripped) return "";
	if (/^[A-Z]{2,}\b/.test(stripped)) return stripped;
	return `${stripped.charAt(0).toLowerCase()}${stripped.slice(1)}`;
}

function hashStable(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function looksDocumentRelated(value: string): boolean {
	return /\b(uploaded|attached|source|document|file|pdf|receipt|receipts|invoice|invoices|tax paper|tax papers|tax return|bank statement|contract)\b/i.test(
		value,
	);
}

function looksSpecificDocumentSourceClaim(value: string): boolean {
	return (
		/\b(uploaded|attached|source)\b/i.test(value) ||
		/\b(this|that|the|my|our)\s+(document|file|pdf|receipt|receipts|invoice|invoices|tax paper|tax papers|tax return|bank statement|contract)\b/i.test(
			value,
		) ||
		/\b(document|file|pdf|receipt|receipts|invoice|invoices|tax paper|tax papers|tax return|bank statement|contract)\s+(says|shows|lists|contains|includes|is|are|was|were)\b/i.test(
			value,
		) ||
		/\bpdf\s+(i|we)\s+(uploaded|attached|sent|shared)\b/i.test(value)
	);
}

type ParsedStatement = {
	category: MemoryProfileCategory;
	statement: string;
	parserRule: string;
};

function parsedStatement(
	category: MemoryProfileCategory,
	statement: string,
	parserRule: string,
): ParsedStatement {
	return {
		category,
		statement: sentence(statement),
		parserRule,
	};
}

function parsePreferenceStatement(
	text: string,
	parserRule: string,
): ParsedStatement | null {
	const preferMatch = /^i prefer\s+(.+)$/i.exec(text);
	if (preferMatch?.[1]) {
		return parsedStatement(
			"preferences",
			`Prefers ${lowerInitial(preferMatch[1])}`,
			parserRule,
		);
	}

	const preferenceMatch = /^my preference is\s+(.+)$/i.exec(text);
	if (preferenceMatch?.[1]) {
		return parsedStatement(
			"preferences",
			`Prefers ${lowerInitial(preferenceMatch[1])}`,
			parserRule,
		);
	}

	return null;
}

function parseWorkingStatement(
	text: string,
	parserRule: string,
): ParsedStatement | null {
	const match = /^i am working on\s+(.+)$/i.exec(text);
	return match?.[1]
		? parsedStatement(
				"goals_ongoing_work",
				`Working on ${lowerInitial(match[1])}`,
				parserRule,
			)
		: null;
}

function parseConstraintStatement(
	text: string,
	parserRule: string,
): ParsedStatement | null {
	const match = /^(do not|don't|dont)\s+(.+)$/i.exec(text);
	return match?.[2]
		? parsedStatement(
				"constraints_boundaries",
				`Do not ${lowerInitial(match[2])}`,
				parserRule,
			)
		: null;
}

function statementFromCandidate(
	candidate: string,
	parserRule: string,
	options: { allowGeneralAboutYou?: boolean } = {},
): ParsedStatement | null {
	const text = stripTerminalPunctuation(candidate);
	if (!text) return null;

	const structuredStatement =
		parsePreferenceStatement(text, parserRule) ??
		parseWorkingStatement(text, parserRule) ??
		parseConstraintStatement(text, parserRule);
	if (structuredStatement) return structuredStatement;

	if (options.allowGeneralAboutYou && /^i\b/i.test(text)) {
		return parsedStatement("about_you", text, parserRule);
	}

	return null;
}

export function parsePostTurnMemoryIntake(
	userMessage: string,
): ParsedDurableMemory {
	const message = cleanText(userMessage);
	if (!message) return { decision: "reject", reason: "empty_user_message" };

	const rememberMatch =
		/^(?:please\s+)?remember(?:\s+that)?\s+(.+)$/i.exec(message) ??
		/^can you remember(?:\s+that)?\s+(.+)$/i.exec(message);
	if (rememberMatch?.[1]) {
		const candidate = rememberMatch[1];
		const statement = statementFromCandidate(candidate, "remember_that", {
			allowGeneralAboutYou: true,
		});
		if (
			looksDocumentRelated(candidate) &&
			(!statement || looksSpecificDocumentSourceClaim(candidate))
		) {
			return {
				decision: "defer",
				reason: "document_related_claim",
				parserRule: "remember_that",
			};
		}
		return statement
			? { decision: "admit", ...statement }
			: {
					decision: "defer",
					reason: "explicit_memory_unclassified",
					parserRule: "remember_that",
				};
	}

	const directStatement = statementFromCandidate(
		message,
		"direct_user_statement",
	);
	if (directStatement) {
		return { decision: "admit", ...directStatement };
	}

	return { decision: "reject", reason: "no_explicit_durable_intent" };
}

function safeSourceMetadata(
	params: PostTurnMemoryIntakeParams,
	extra: JsonRecord = {},
): JsonRecord {
	return {
		conversationId: params.conversationId,
		...(params.userMessageId ? { userMessageId: params.userMessageId } : {}),
		...(params.assistantMessageId
			? { assistantMessageId: params.assistantMessageId }
			: {}),
		...extra,
	};
}

async function markIntakeDirty(params: {
	intake: PostTurnMemoryIntakeParams;
	resetGeneration: number;
	reason: "honcho_reconciliation" | "possible_duplicate" | "deferred_intake";
	status: MemoryIntakeStatus;
	itemId?: string;
	reviewItemId?: string;
}): Promise<void> {
	await markMemoryDirty({
		userId: params.intake.userId,
		reason: params.reason,
		scope: GLOBAL_SCOPE,
		expectedResetGeneration: params.resetGeneration,
		metadata: safeSourceMetadata(params.intake, {
			intakeStatus: params.status,
			...(params.itemId ? { itemId: params.itemId } : {}),
			...(params.reviewItemId ? { reviewItemId: params.reviewItemId } : {}),
		}),
	});
}

async function recordIntakeTelemetry(params: {
	intake: PostTurnMemoryIntakeParams;
	resetGeneration: number;
	eventName: string;
	status: MemoryIntakeStatus | "failed";
	reason: string;
	category?: MemoryProfileCategory;
	subjectId?: string;
	parserRule?: string;
}): Promise<void> {
	await recordMemoryReworkTelemetry({
		userId: params.intake.userId,
		eventFamily: "intake",
		eventName: params.eventName,
		category: params.category,
		reason: params.reason,
		status: params.status,
		subjectId: params.subjectId,
		expectedResetGeneration: params.resetGeneration,
		metadata: safeSourceMetadata(params.intake, {
			...(params.parserRule ? { parserRule: params.parserRule } : {}),
		}),
	});
}

async function isStaleIntakeGeneration(params: {
	userId: string;
	resetGeneration: number;
}): Promise<boolean> {
	return !(await isCurrentMemoryResetGeneration(params));
}

function staleIntakeResult(): PostTurnMemoryIntakeResult {
	return { status: "rejected", reason: "stale_reset_generation" };
}

export async function intakePostTurnMemory(
	params: PostTurnMemoryIntakeParams,
): Promise<PostTurnMemoryIntakeResult> {
	const resetGeneration =
		params.startedResetGeneration ??
		(await getCurrentMemoryResetGeneration(params.userId));
	const parsed = parsePostTurnMemoryIntake(params.userMessage);

	if (parsed.decision === "reject") {
		if (
			await isStaleIntakeGeneration({
				userId: params.userId,
				resetGeneration,
			})
		) {
			return staleIntakeResult();
		}
		await recordIntakeTelemetry({
			intake: params,
			resetGeneration,
			eventName: "memory_intake_rejected",
			status: "rejected",
			reason: parsed.reason,
		});
		return { status: "rejected", reason: parsed.reason };
	}

	try {
		if (
			await isStaleIntakeGeneration({
				userId: params.userId,
				resetGeneration,
			})
		) {
			return staleIntakeResult();
		}
		if (parsed.decision === "defer") {
			const subjectKey = `post-turn-intake:${parsed.reason}:${hashStable(
				[
					params.userId,
					params.conversationId,
					params.userMessageId ?? "",
					parsed.parserRule,
				].join("\u001f"),
			)}`;
			const review = await createOrUpdateMemoryReviewItem({
				userId: params.userId,
				subjectKey,
				subjectLabel:
					parsed.reason === "document_related_claim"
						? "Document-related memory request"
						: "Explicit memory request",
				question: "Should AlfyAI remember this as part of the user profile?",
				reason: "The intake gate could not safely admit this automatically.",
				evidence: [
					safeSourceMetadata(params, {
						sourceType: "chat_turn",
					}),
				],
				metadata: safeSourceMetadata(params, {
					intakeStatus: "deferred",
					parserRule: parsed.parserRule,
					reason: parsed.reason,
				}),
				expectedResetGeneration: resetGeneration,
			});
			await markIntakeDirty({
				intake: params,
				resetGeneration,
				reason: "deferred_intake",
				status: "deferred",
				reviewItemId: review.id,
			});
			await recordIntakeTelemetry({
				intake: params,
				resetGeneration,
				eventName: "memory_intake_deferred",
				status: "deferred",
				reason: parsed.reason,
				subjectId: review.id,
				parserRule: parsed.parserRule,
			});
			return {
				status: "deferred",
				reviewItemId: review.id,
				reason: parsed.reason,
			};
		}

		const before = await getMemoryProfileReadModel({ userId: params.userId });
		const item = await createMemoryProfileItem({
			userId: params.userId,
			category: parsed.category,
			scope: GLOBAL_SCOPE,
			statement: parsed.statement,
			expectedResetGeneration: resetGeneration,
		});
		const duplicate = item.projectionRevision === before.projectionRevision;

		if (item.status !== "active") {
			const review = await createOrUpdateMemoryReviewItem({
				userId: params.userId,
				subjectKey: `post-turn-intake:inactive-duplicate:${item.itemKey}`,
				subjectLabel: "Suppressed or deleted memory request",
				question: "Should this previously inactive memory be restored?",
				reason: "The intake gate matched an inactive memory profile item.",
				affectedItemIds: [item.id],
				evidence: [
					safeSourceMetadata(params, {
						sourceType: "chat_turn",
					}),
				],
				metadata: safeSourceMetadata(params, {
					intakeStatus: "deferred",
					parserRule: parsed.parserRule,
					reason: "inactive_duplicate",
					category: parsed.category,
				}),
				expectedResetGeneration: resetGeneration,
			});
			await markIntakeDirty({
				intake: params,
				resetGeneration,
				reason: "deferred_intake",
				status: "deferred",
				reviewItemId: review.id,
			});
			await recordIntakeTelemetry({
				intake: params,
				resetGeneration,
				eventName: "memory_intake_deferred",
				status: "deferred",
				reason: "inactive_duplicate",
				category: parsed.category,
				subjectId: review.id,
				parserRule: parsed.parserRule,
			});
			return {
				status: "deferred",
				reviewItemId: review.id,
				reason: "inactive_duplicate",
			};
		}

		await addMemoryProfileItemProvenance({
			userId: params.userId,
			itemId: item.id,
			sourceType: "chat_user_message",
			sourceId: params.userMessageId ?? params.conversationId,
			label: "Chat",
			summary: "User explicitly asked AlfyAI to remember this.",
			expectedResetGeneration: resetGeneration,
		});
		await markIntakeDirty({
			intake: params,
			resetGeneration,
			reason: "honcho_reconciliation",
			status: "admitted",
			itemId: item.id,
		});
		if (duplicate) {
			await markIntakeDirty({
				intake: params,
				resetGeneration,
				reason: "possible_duplicate",
				status: "admitted",
				itemId: item.id,
			});
		}
		await recordIntakeTelemetry({
			intake: params,
			resetGeneration,
			eventName: "memory_intake_admitted",
			status: "admitted",
			reason: duplicate ? "possible_duplicate" : "explicit_user_statement",
			category: parsed.category,
			subjectId: item.id,
			parserRule: parsed.parserRule,
		});

		return {
			status: "admitted",
			itemId: item.id,
			category: parsed.category,
			duplicate,
		};
	} catch (error) {
		if (isStaleMemoryResetGenerationError(error)) {
			return staleIntakeResult();
		}
		throw error;
	}
}
