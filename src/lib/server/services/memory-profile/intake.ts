import {
	addMemoryProfileItemProvenance,
	createMemoryProfileItem,
	getCurrentMemoryResetGeneration,
	getMemoryProfileReadModel,
	isCurrentMemoryResetGeneration,
	isStaleMemoryResetGenerationError,
	type MemoryProfileCategory,
	type MemoryProfileScope,
	markMemoryDirty,
	recordMemoryReworkTelemetry,
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

function looksOneOffInstruction(value: string): boolean {
	return /\b(?:this|current)\s+(?:answer|response|reply|message|turn)\b/i.test(
		value,
	);
}

function hasDurableConstraintMarker(value: string): boolean {
	return /\b(?:ever|from now on|going forward|in the future|in future|always|never)\b/i.test(
		value,
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
	const alwaysMatch = /^always\s+(.+)$/i.exec(text);
	if (alwaysMatch?.[1]) {
		return parsedStatement(
			"constraints_boundaries",
			`Always ${lowerInitial(alwaysMatch[1])}`,
			parserRule,
		);
	}

	const neverMatch = /^never\s+(.+)$/i.exec(text);
	if (neverMatch?.[1]) {
		return parsedStatement(
			"constraints_boundaries",
			`Never ${lowerInitial(neverMatch[1])}`,
			parserRule,
		);
	}

	const neverWantMatch = /^i\s+never\s+want\s+(.+)$/i.exec(text);
	if (neverWantMatch?.[1]) {
		return parsedStatement(
			"constraints_boundaries",
			`Never want ${lowerInitial(neverWantMatch[1])}`,
			parserRule,
		);
	}

	const match = /^(do not|don't|dont)\s+(.+)$/i.exec(text);
	if (
		match?.[2] &&
		parserRule !== "remember_that" &&
		!hasDurableConstraintMarker(match[2])
	) {
		return null;
	}
	return match?.[2]
		? parsedStatement(
				"constraints_boundaries",
				`Do not ${lowerInitial(match[2])}`,
				parserRule,
			)
		: null;
}

function parseStableSelfStatement(
	text: string,
	parserRule: string,
): ParsedStatement | null {
	if (
		/^i\s+(?:live|reside)\s+in\s+.+$/i.test(text) ||
		/^i\s+am\s+(?:based|located)\s+in\s+.+$/i.test(text) ||
		/^i(?:'m| am)\s+from\s+.+$/i.test(text)
	) {
		return parsedStatement("about_you", text, parserRule);
	}

	return null;
}

function normalizeExplicitMemoryCandidate(candidate: string): string {
	const text = stripExplicitInstructionTail(stripTerminalPunctuation(candidate));
	const wrapperPatterns = [
		/^this\s+as\s+(?:an?\s+)?(?:durable\s+)?(?:memory\s+profile\s+)?(?:profile\s+)?(?:fact|memory|preference|detail|note)\s*[:,-]\s*/i,
		/^this\s+(?:an?\s+)?(?:durable\s+)?(?:memory\s+profile\s+)?(?:profile\s+)?(?:fact|memory|preference|detail|note)\s*[:,-]\s*/i,
		/^(?:as\s+)?(?:an?\s+)?(?:durable\s+)?(?:memory\s+profile\s+)?(?:profile\s+)?(?:fact|memory|preference|detail|note)\s*[:,-]\s*/i,
	];
	for (const pattern of wrapperPatterns) {
		const normalized = stripExplicitInstructionTail(
			text.replace(pattern, "").trim(),
		);
		if (normalized !== text && normalized.length > 0) {
			return cleanText(normalized);
		}
	}
	return text;
}

function stripExplicitInstructionTail(value: string): string {
	return cleanText(value)
		.replace(
			/([.!?])\s+(?:please\s+)?(?:reply|respond|answer|confirm|acknowledge|say|write|output)\b[\s\S]*$/i,
			"$1",
		)
		.trim();
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
		parseConstraintStatement(text, parserRule) ??
		parseStableSelfStatement(text, parserRule);
	if (structuredStatement) return structuredStatement;

	if (options.allowGeneralAboutYou && /^(?:i|my)\b/i.test(text)) {
		return parsedStatement("about_you", text, parserRule);
	}

	return null;
}

export function parsePostTurnMemoryIntake(
	userMessage: string,
): ParsedDurableMemory {
	const message = cleanText(userMessage);
	if (!message) return { decision: "reject", reason: "empty_user_message" };
	if (looksOneOffInstruction(message)) {
		return { decision: "reject", reason: "one_off_instruction" };
	}

	const rememberMatch =
		/^(?:please\s+)?remember(?:\s+that)?\s+(.+)$/i.exec(message) ??
		/^can you remember(?:\s+that)?\s+(.+)$/i.exec(message);
	if (rememberMatch?.[1]) {
		const candidate = rememberMatch[1];
		const normalizedCandidate = normalizeExplicitMemoryCandidate(candidate);
		const statement = statementFromCandidate(
			normalizedCandidate,
			"remember_that",
			{
				allowGeneralAboutYou: true,
			},
		);
		if (
			(looksDocumentRelated(candidate) ||
				looksDocumentRelated(normalizedCandidate)) &&
			(!statement ||
				looksSpecificDocumentSourceClaim(candidate) ||
				looksSpecificDocumentSourceClaim(normalizedCandidate))
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
		"direct_user_self_statement",
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
	scope?: MemoryProfileScope;
}): Promise<void> {
	await markMemoryDirty({
		userId: params.intake.userId,
		reason: params.reason,
		scope: params.scope ?? GLOBAL_SCOPE,
		expectedResetGeneration: params.resetGeneration,
		metadata: safeSourceMetadata(params.intake, {
			intakeStatus: params.status,
			...(params.itemId ? { itemId: params.itemId } : {}),
		}),
	});
}

function scopeForAdmittedMemory(params: {
	category: MemoryProfileCategory;
	conversationId: string;
}): MemoryProfileScope {
	if (params.category === "goals_ongoing_work" && params.conversationId) {
		return { type: "conversation", id: params.conversationId };
	}
	return GLOBAL_SCOPE;
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
			await markIntakeDirty({
				intake: params,
				resetGeneration,
				reason: "deferred_intake",
				status: "deferred",
				scope: { type: "conversation", id: params.conversationId },
			});
			await recordIntakeTelemetry({
				intake: params,
				resetGeneration,
				eventName: "memory_intake_deferred",
				status: "deferred",
				reason: parsed.reason,
				parserRule: parsed.parserRule,
			});
			return {
				status: "deferred",
				reason: parsed.reason,
			};
		}

		const before = await getMemoryProfileReadModel({ userId: params.userId });
		const scope = scopeForAdmittedMemory({
			category: parsed.category,
			conversationId: params.conversationId,
		});
		const item = await createMemoryProfileItem({
			userId: params.userId,
			category: parsed.category,
			scope,
			statement: parsed.statement,
			expectedResetGeneration: resetGeneration,
		});
		const duplicate = item.projectionRevision === before.projectionRevision;

		if (item.status !== "active") {
			await markIntakeDirty({
				intake: params,
				resetGeneration,
				reason: "deferred_intake",
				status: "deferred",
				scope,
			});
			await recordIntakeTelemetry({
				intake: params,
				resetGeneration,
				eventName: "memory_intake_deferred",
				status: "deferred",
				reason: "inactive_duplicate",
				category: parsed.category,
				subjectId: item.id,
				parserRule: parsed.parserRule,
			});
			return {
				status: "deferred",
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
			scope,
		});
		if (duplicate) {
			await markIntakeDirty({
				intake: params,
				resetGeneration,
				reason: "possible_duplicate",
				status: "admitted",
				itemId: item.id,
				scope,
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
