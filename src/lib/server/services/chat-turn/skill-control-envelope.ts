import type {
	SkillControlMessageMetadata,
	SkillControlOperation,
	SkillDraftDurationPolicy,
	SkillDraftNotesPolicy,
	SkillDraftProposal,
	SkillDraftQuestionPolicy,
	SkillDraftSourceScope,
} from "$lib/server/services/skills/types";
import { stripCompleteSkillControlEnvelopeBlocks } from "$lib/services/stream-protocol";

type JsonRecord = Record<string, unknown>;

export interface ParsedSkillControlEnvelope {
	visibleText: string;
	metadata?: SkillControlMessageMetadata;
	operations: SkillControlOperation[];
}

function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonRecord(value: string): JsonRecord | null {
	try {
		const parsed = JSON.parse(value) as unknown;
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function cleanText(value: unknown, maxLength: number): string {
	if (typeof value !== "string") return "";
	return value.trim().slice(0, maxLength);
}

function cleanStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => cleanText(item, 160))
		.filter(Boolean)
		.slice(0, 12);
}

function parseOptionalPolicy<T extends string>(
	value: unknown,
	allowed: readonly T[],
	fallback: T,
): T | null {
	if (value == null) return fallback;
	return typeof value === "string" && allowed.includes(value as T)
		? (value as T)
		: null;
}

function parseSkillDraftProposal(value: unknown): SkillDraftProposal | null {
	if (!isRecord(value)) return null;
	const id = cleanText(value.id, 120);
	const displayName = cleanText(value.displayName, 120);
	const description = cleanText(value.description, 600);
	const instructions = cleanText(value.instructions, 8000);
	if (!id || !displayName || !instructions) return null;

	const durationPolicy = parseOptionalPolicy<SkillDraftDurationPolicy>(
		value.durationPolicy,
		["next_message", "session"],
		"next_message",
	);
	const questionPolicy = parseOptionalPolicy<SkillDraftQuestionPolicy>(
		value.questionPolicy,
		["none", "ask_when_needed"],
		"none",
	);
	const notesPolicy = parseOptionalPolicy<SkillDraftNotesPolicy>(
		value.notesPolicy,
		["none", "create_private_notes"],
		"none",
	);
	const sourceScope = parseOptionalPolicy<SkillDraftSourceScope>(
		value.sourceScope,
		["current_conversation", "selected_sources_only"],
		"selected_sources_only",
	);
	if (!durationPolicy || !questionPolicy || !notesPolicy || !sourceScope) {
		return null;
	}

	return {
		id,
		status: "proposed",
		displayName,
		description,
		instructions,
		activationExamples: cleanStringList(value.activationExamples),
		durationPolicy,
		questionPolicy,
		notesPolicy,
		sourceScope,
	};
}

function parseSkillDraftOperation(
	candidate: JsonRecord,
	operationId: string,
): SkillControlOperation | null {
	const draft = parseSkillDraftProposal(candidate.draft);
	if (!draft) return null;
	return {
		operationId,
		kind: "skill_draft",
		draft,
	};
}

function parseOperation(value: unknown): SkillControlOperation | null {
	if (!isRecord(value)) return null;
	const operationId = value.operationId;
	if (typeof operationId !== "string" || !operationId.trim()) return null;

	if (value.kind === "skill_draft") {
		return parseSkillDraftOperation(value, operationId);
	}

	return null;
}

export function parseSkillControlEnvelopeFromAssistantText(
	text: string,
): ParsedSkillControlEnvelope {
	const { visibleText, envelopes } =
		stripCompleteSkillControlEnvelopeBlocks(text);
	const parsed = parseSkillControlEnvelopePayloads(
		envelopes.map((envelope) => envelope.rawJson),
	);

	return {
		visibleText: visibleText.trim(),
		metadata: parsed.metadata,
		operations: parsed.operations,
	};
}

export function parseSkillControlEnvelopePayloads(
	payloads: string[],
): Omit<ParsedSkillControlEnvelope, "visibleText"> {
	const operations: SkillControlOperation[] = [];
	const seenOperationIds = new Set<string>();
	let malformedEnvelopeCount = 0;

	for (const payload of payloads) {
		const parsed = parseJsonRecord(payload);
		if (parsed?.version !== 1 || !Array.isArray(parsed.operations)) {
			malformedEnvelopeCount += 1;
			continue;
		}

		for (const candidate of parsed.operations) {
			const operation = parseOperation(candidate);
			if (!operation) continue;
			if (seenOperationIds.has(operation.operationId)) continue;
			seenOperationIds.add(operation.operationId);
			operations.push(operation);
		}
	}

	const skillDrafts = operations.map((operation) => operation.draft);

	const metadata: SkillControlMessageMetadata | undefined =
		operations.length > 0 || malformedEnvelopeCount > 0
			? {
					skillDrafts: skillDrafts.length > 0 ? skillDrafts : undefined,
					skillControl: {
						envelopeVersion: 1 as const,
						operations,
						malformedEnvelopeCount,
					},
				}
			: undefined;

	return {
		metadata,
		operations,
	};
}
