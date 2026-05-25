import { randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "$lib/server/db";
import { contextCompressionSnapshots, messages } from "$lib/server/db/schema";
import type { ContextCompressionMarker, ModelId } from "$lib/types";
import { estimateTokenCount } from "$lib/utils/tokens";
import { parseModelJsonObject } from "./deep-research/llm-json";
import { sendMessage } from "./langflow";
import { messageOrderAsc } from "./message-ordering";
import { repairConversationMessageSequences } from "./message-sequences";

export type ContextCompressionSnapshotTrigger = "manual" | "automatic";
export type ContextCompressionSnapshotStatus = "running" | "valid" | "failed";
export type ContextCompressionSnapshotJson = Record<string, unknown>;

export type ContextCompressionSourceRef = Record<string, unknown>;

export type ContextCompressionSourceMessage = {
	id: string;
	role: string;
	content: string;
	messageSequence: number;
	thinking?: string | null;
	toolCalls?: unknown;
};

export type ContextCompressionSourceRange = {
	startMessageId: string;
	endMessageId: string;
	startMessageSequence?: number;
	endMessageSequence?: number;
};

export type ContextCompressionSnapshot = {
	id: string;
	conversationId: string;
	userId: string;
	trigger: ContextCompressionSnapshotTrigger;
	status: ContextCompressionSnapshotStatus;
	modelId: string;
	sourceStartMessageId: string;
	sourceEndMessageId: string;
	sourceStartMessageSequence: number;
	sourceEndMessageSequence: number;
	snapshot: ContextCompressionSnapshotJson;
	sourceCoverage: ContextCompressionSnapshotJson;
	sourceRefs: ContextCompressionSourceRef[];
	estimatedTokens: number;
	sourceTokenEstimate: number;
	failureReason: string | null;
	createdAt: Date;
	updatedAt: Date;
};

export type CreateContextCompressionSnapshotInput = {
	conversationId: string;
	userId: string;
	trigger: ContextCompressionSnapshotTrigger;
	status?: ContextCompressionSnapshotStatus;
	modelId: string;
	sourceStartMessageId: string;
	sourceEndMessageId: string;
	sourceStartMessageSequence: number;
	sourceEndMessageSequence: number;
	snapshot?: ContextCompressionSnapshotJson;
	sourceCoverage?: ContextCompressionSnapshotJson;
	sourceRefs?: ContextCompressionSourceRef[];
	estimatedTokens?: number;
	sourceTokenEstimate?: number;
	failureReason?: string | null;
};

export type UpdateContextCompressionSnapshotStatusInput = {
	id: string;
	status: ContextCompressionSnapshotStatus;
	snapshot?: ContextCompressionSnapshotJson;
	sourceCoverage?: ContextCompressionSnapshotJson;
	sourceRefs?: ContextCompressionSourceRef[];
	estimatedTokens?: number;
	sourceTokenEstimate?: number;
	failureReason?: string | null;
};

export type RunContextCompressionInput = {
	conversationId: string;
	userId: string;
	trigger: ContextCompressionSnapshotTrigger;
	selectedModelId: ModelId;
	sourceMessages: ContextCompressionSourceMessage[];
	priorSnapshot?: ContextCompressionSnapshot | null;
	sourceRanges?: ContextCompressionSourceRange[];
	sourceTokenEstimate?: number;
	targetTokenEstimate?: number;
	budget?: {
		maxModelContext?: number;
		targetConstructedContext?: number;
	};
};

const compressionSnapshotSchema = z.strictObject({
	goal: z.string().trim().min(1),
	currentState: z.string().trim().min(1),
	importantDecisions: z.array(z.string().trim().min(1)),
	importantFacts: z.array(z.string().trim().min(1)),
	openTasks: z.array(z.string().trim().min(1)),
	openQuestions: z.array(z.string().trim().min(1)),
	toolUseAndEvidenceRefs: z.array(
		z.strictObject({
			kind: z.string().trim().min(1),
			label: z.string().trim().min(1),
			messageIds: z.array(z.string().trim().min(1)).optional(),
			detail: z.string().trim().min(1).optional(),
		}),
	),
	sourceCoverage: z.strictObject({
		messageIds: z.array(z.string().trim().min(1)).min(1),
		ranges: z
			.array(
				z.strictObject({
					startMessageId: z.string().trim().min(1),
					endMessageId: z.string().trim().min(1),
				}),
			)
			.optional(),
	}),
});

export type ContextCompressionStructuredSnapshot = z.infer<
	typeof compressionSnapshotSchema
>;

export const CONTEXT_COMPRESSION_SYSTEM_APPENDIX = `Context compression task.
Return only valid JSON. Do not include markdown, prose, XML tags, or <thinking> blocks.
The JSON shape must be:
{
  "goal": "string",
  "currentState": "string",
  "importantDecisions": ["string"],
  "importantFacts": ["string"],
  "openTasks": ["string"],
  "openQuestions": ["string"],
  "toolUseAndEvidenceRefs": [{"kind":"tool|evidence|source","label":"string","messageIds":["message-id"],"detail":"string"}],
  "sourceCoverage": {"messageIds":["all covered source message ids"],"ranges":[{"startMessageId":"id","endMessageId":"id"}]}
}
Compress semantics, decisions, facts, open work, tool outputs, and useful evidence references. Preserve enough detail for future prompt assembly, but do not copy raw chat transcript.`;

function parseObjectJson(value: string): ContextCompressionSnapshotJson {
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as ContextCompressionSnapshotJson)
			: {};
	} catch {
		return {};
	}
}

function parseSourceRefsJson(value: string): ContextCompressionSourceRef[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed)
			? parsed.filter(
					(ref): ref is ContextCompressionSourceRef =>
						Boolean(ref) && typeof ref === "object" && !Array.isArray(ref),
				)
			: [];
	} catch {
		return [];
	}
}

function mapSnapshotRow(
	row: typeof contextCompressionSnapshots.$inferSelect,
): ContextCompressionSnapshot {
	return {
		id: row.id,
		conversationId: row.conversationId,
		userId: row.userId,
		trigger: row.trigger as ContextCompressionSnapshotTrigger,
		status: row.status as ContextCompressionSnapshotStatus,
		modelId: row.modelId,
		sourceStartMessageId: row.sourceStartMessageId,
		sourceEndMessageId: row.sourceEndMessageId,
		sourceStartMessageSequence: row.sourceStartMessageSequence,
		sourceEndMessageSequence: row.sourceEndMessageSequence,
		snapshot: parseObjectJson(row.snapshotJson),
		sourceCoverage: parseObjectJson(row.sourceCoverageJson),
		sourceRefs: parseSourceRefsJson(row.sourceRefsJson),
		estimatedTokens: row.estimatedTokens,
		sourceTokenEstimate: row.sourceTokenEstimate,
		failureReason: row.failureReason,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export async function createContextCompressionSnapshot(
	input: CreateContextCompressionSnapshotInput,
): Promise<ContextCompressionSnapshot> {
	const now = new Date();
	const row = db
		.insert(contextCompressionSnapshots)
		.values({
			id: randomUUID(),
			conversationId: input.conversationId,
			userId: input.userId,
			trigger: input.trigger,
			status: input.status ?? "running",
			modelId: input.modelId,
			sourceStartMessageId: input.sourceStartMessageId,
			sourceEndMessageId: input.sourceEndMessageId,
			sourceStartMessageSequence: input.sourceStartMessageSequence,
			sourceEndMessageSequence: input.sourceEndMessageSequence,
			snapshotJson: JSON.stringify(input.snapshot ?? {}),
			sourceCoverageJson: JSON.stringify(input.sourceCoverage ?? {}),
			sourceRefsJson: JSON.stringify(input.sourceRefs ?? []),
			estimatedTokens: input.estimatedTokens ?? 0,
			sourceTokenEstimate: input.sourceTokenEstimate ?? 0,
			failureReason: input.failureReason ?? null,
			createdAt: now,
			updatedAt: now,
		})
		.returning()
		.get();

	return mapSnapshotRow(row);
}

export async function listContextCompressionSnapshots(
	conversationId: string,
): Promise<ContextCompressionSnapshot[]> {
	const rows = db
		.select()
		.from(contextCompressionSnapshots)
		.where(eq(contextCompressionSnapshots.conversationId, conversationId))
		.orderBy(asc(contextCompressionSnapshots.createdAt))
		.all();

	return rows.map(mapSnapshotRow);
}

export async function listValidContextCompressionSnapshots(
	conversationId: string,
): Promise<ContextCompressionSnapshot[]> {
	const rows = db
		.select()
		.from(contextCompressionSnapshots)
		.where(eq(contextCompressionSnapshots.conversationId, conversationId))
		.orderBy(asc(contextCompressionSnapshots.createdAt))
		.all();

	return rows
		.map(mapSnapshotRow)
		.filter((snapshot) => snapshot.status === "valid");
}

export async function getLatestValidContextCompressionSnapshot(input: {
	conversationId: string;
	userId: string;
}): Promise<ContextCompressionSnapshot | null> {
	const row = db
		.select()
		.from(contextCompressionSnapshots)
		.where(
			and(
				eq(contextCompressionSnapshots.conversationId, input.conversationId),
				eq(contextCompressionSnapshots.userId, input.userId),
				eq(contextCompressionSnapshots.status, "valid"),
			),
		)
		.orderBy(
			desc(contextCompressionSnapshots.updatedAt),
			desc(contextCompressionSnapshots.createdAt),
			desc(contextCompressionSnapshots.sourceEndMessageSequence),
		)
		.limit(1)
		.get();

	return row ? mapSnapshotRow(row) : null;
}

export async function listContextCompressionSourceMessages(
	conversationId: string,
): Promise<ContextCompressionSourceMessage[]> {
	repairConversationMessageSequences(conversationId);
	return db
		.select({
			id: messages.id,
			role: messages.role,
			content: messages.content,
			thinking: messages.thinking,
			toolCalls: messages.toolCalls,
			messageSequence: messages.messageSequence,
		})
		.from(messages)
		.where(eq(messages.conversationId, conversationId))
		.orderBy(...messageOrderAsc())
		.all()
		.filter((message) => message.messageSequence != null)
		.map((message) => ({
			id: message.id,
			role: message.role,
			content: message.content,
			thinking: message.thinking,
			toolCalls: message.toolCalls,
			messageSequence: message.messageSequence ?? 0,
		}));
}

function readSnapshotString(
	value: ContextCompressionSnapshotJson,
	key: string,
): string | null {
	const field = value[key];
	return typeof field === "string" && field.trim() ? field.trim() : null;
}

function readSnapshotStringList(
	value: ContextCompressionSnapshotJson,
	key: string,
): string[] {
	const field = value[key];
	return Array.isArray(field)
		? field
				.filter(
					(item): item is string =>
						typeof item === "string" && item.trim().length > 0,
				)
				.map((item) => item.trim())
		: [];
}

function formatSnapshotList(label: string, values: string[]): string | null {
	if (values.length === 0) return null;
	return [`${label}:`, ...values.map((value) => `- ${value}`)].join("\n");
}

function formatSnapshotRefs(
	value: ContextCompressionSnapshotJson,
): string | null {
	const refs = value.toolUseAndEvidenceRefs;
	if (!Array.isArray(refs) || refs.length === 0) return null;

	const formatted = refs
		.map((ref) => {
			if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
				return null;
			}
			const record = ref as Record<string, unknown>;
			const kind = typeof record.kind === "string" ? record.kind.trim() : "";
			const label = typeof record.label === "string" ? record.label.trim() : "";
			const detail =
				typeof record.detail === "string" ? record.detail.trim() : "";
			const main = [kind, label].filter(Boolean).join(": ");
			if (!main && !detail) return null;
			return detail ? `- ${main || "Reference"} - ${detail}` : `- ${main}`;
		})
		.filter((item): item is string => Boolean(item));

	return formatted.length > 0
		? ["Tool Use And Evidence References:", ...formatted].join("\n")
		: null;
}

export function formatContextCompressionSnapshotForPrompt(
	snapshot: ContextCompressionSnapshot,
): string {
	const parts = [
		readSnapshotString(snapshot.snapshot, "goal")
			? `Goal: ${readSnapshotString(snapshot.snapshot, "goal")}`
			: null,
		readSnapshotString(snapshot.snapshot, "currentState")
			? `Current State: ${readSnapshotString(snapshot.snapshot, "currentState")}`
			: null,
		formatSnapshotList(
			"Important Decisions",
			readSnapshotStringList(snapshot.snapshot, "importantDecisions"),
		),
		formatSnapshotList(
			"Important Facts",
			readSnapshotStringList(snapshot.snapshot, "importantFacts"),
		),
		formatSnapshotList(
			"Open Tasks",
			readSnapshotStringList(snapshot.snapshot, "openTasks"),
		),
		formatSnapshotList(
			"Open Questions",
			readSnapshotStringList(snapshot.snapshot, "openQuestions"),
		),
		formatSnapshotRefs(snapshot.snapshot),
		[
			`Source Coverage: messages #${snapshot.sourceStartMessageSequence} through #${snapshot.sourceEndMessageSequence}`,
			`Snapshot Created: ${snapshot.createdAt.toISOString()}`,
		].join("\n"),
	].filter((part): part is string => Boolean(part?.trim()));

	if (parts.length > 1) {
		return parts.join("\n\n");
	}

	return [
		JSON.stringify(snapshot.snapshot, null, 2),
		`Source Coverage: messages #${snapshot.sourceStartMessageSequence} through #${snapshot.sourceEndMessageSequence}`,
	].join("\n\n");
}

export function serializeContextCompressionSnapshot(
	snapshot: ContextCompressionSnapshot,
): ContextCompressionMarker {
	return {
		id: snapshot.id,
		trigger: snapshot.trigger,
		status: snapshot.status,
		sourceEndMessageId: snapshot.sourceEndMessageId,
		createdAt: snapshot.createdAt.getTime(),
		updatedAt: snapshot.updatedAt.getTime(),
		estimatedTokens: snapshot.estimatedTokens,
		sourceTokenEstimate: snapshot.sourceTokenEstimate,
	};
}

export async function updateContextCompressionSnapshotStatus(
	input: UpdateContextCompressionSnapshotStatusInput,
): Promise<ContextCompressionSnapshot | null> {
	const values: Partial<typeof contextCompressionSnapshots.$inferInsert> = {
		status: input.status,
		updatedAt: new Date(),
	};

	if (input.snapshot !== undefined) {
		values.snapshotJson = JSON.stringify(input.snapshot);
	}
	if (input.sourceCoverage !== undefined) {
		values.sourceCoverageJson = JSON.stringify(input.sourceCoverage);
	}
	if (input.sourceRefs !== undefined) {
		values.sourceRefsJson = JSON.stringify(input.sourceRefs);
	}
	if (input.estimatedTokens !== undefined) {
		values.estimatedTokens = input.estimatedTokens;
	}
	if (input.sourceTokenEstimate !== undefined) {
		values.sourceTokenEstimate = input.sourceTokenEstimate;
	}
	if (input.failureReason !== undefined || input.status !== "failed") {
		values.failureReason = input.failureReason ?? null;
	}

	const row = db
		.update(contextCompressionSnapshots)
		.set(values)
		.where(eq(contextCompressionSnapshots.id, input.id))
		.returning()
		.get();

	return row ? mapSnapshotRow(row) : null;
}

function requireSourceMessages(
	messages: ContextCompressionSourceMessage[],
): [ContextCompressionSourceMessage, ...ContextCompressionSourceMessage[]] {
	if (messages.length === 0) {
		throw new Error("Cannot run context compression without source messages.");
	}

	return messages as [
		ContextCompressionSourceMessage,
		...ContextCompressionSourceMessage[],
	];
}

function defaultSourceRanges(
	messages: [
		ContextCompressionSourceMessage,
		...ContextCompressionSourceMessage[],
	],
	priorSnapshot?: ContextCompressionSnapshot | null,
): ContextCompressionSourceRange[] {
	const first = messages[0];
	const last = messages[messages.length - 1];
	return [
		{
			startMessageId: priorSnapshot?.sourceStartMessageId ?? first.id,
			endMessageId: last.id,
			startMessageSequence:
				priorSnapshot?.sourceStartMessageSequence ?? first.messageSequence,
			endMessageSequence: last.messageSequence,
		},
	];
}

function sourceTextEstimate(params: {
	messages: ContextCompressionSourceMessage[];
	priorSnapshot?: ContextCompressionSnapshot | null;
}): number {
	const priorSnapshotText = params.priorSnapshot
		? formatContextCompressionSnapshotForPrompt(params.priorSnapshot)
		: "";
	const sourceText = params.messages
		.map(
			(message) =>
				`${message.role} ${message.id} #${message.messageSequence}\n${message.content}`,
		)
		.join("\n\n");
	return estimateTokenCount(
		[priorSnapshotText, sourceText].filter(Boolean).join("\n\n"),
	);
}

function snapshotCoverageMessageIds(
	snapshot: ContextCompressionSnapshot | null | undefined,
): string[] {
	const messageIds = snapshot?.sourceCoverage.messageIds;
	return Array.isArray(messageIds)
		? messageIds.filter(
				(id): id is string => typeof id === "string" && id.trim().length > 0,
			)
		: [];
}

function requiredCoverageMessageIds(params: {
	sourceMessages: ContextCompressionSourceMessage[];
	priorSnapshot?: ContextCompressionSnapshot | null;
}): string[] {
	return Array.from(
		new Set([
			...snapshotCoverageMessageIds(params.priorSnapshot),
			...params.sourceMessages.map((message) => message.id),
		]),
	);
}

function buildCompressionPrompt(params: {
	input: RunContextCompressionInput;
	sourceRanges: ContextCompressionSourceRange[];
	repairReason?: string;
}): string {
	const payload = {
		task: "context_compression",
		trigger: params.input.trigger,
		conversationId: params.input.conversationId,
		budget: {
			sourceTokenEstimate: params.input.sourceTokenEstimate,
			targetTokenEstimate: params.input.targetTokenEstimate,
			maxModelContext: params.input.budget?.maxModelContext,
			targetConstructedContext: params.input.budget?.targetConstructedContext,
		},
		sourceRanges: params.sourceRanges,
		priorSnapshot: params.input.priorSnapshot
			? {
					sourceStartMessageId: params.input.priorSnapshot.sourceStartMessageId,
					sourceEndMessageId: params.input.priorSnapshot.sourceEndMessageId,
					sourceStartMessageSequence:
						params.input.priorSnapshot.sourceStartMessageSequence,
					sourceEndMessageSequence:
						params.input.priorSnapshot.sourceEndMessageSequence,
					sourceCoverage: params.input.priorSnapshot.sourceCoverage,
					snapshot: params.input.priorSnapshot.snapshot,
					formatted: formatContextCompressionSnapshotForPrompt(
						params.input.priorSnapshot,
					),
				}
			: null,
		sourceMessages: params.input.sourceMessages.map((message) => ({
			id: message.id,
			sequence: message.messageSequence,
			role: message.role,
			content: message.content,
			toolCalls: message.toolCalls ?? null,
		})),
	};

	const repair = params.repairReason
		? `\n\nPrevious output was rejected: ${params.repairReason}\nReturn repaired JSON only and ensure every source message id is covered.`
		: "";

	return `Compress this conversation source into the required context compression JSON shape.${repair}\n\n${JSON.stringify(payload)}`;
}

function validateCompressionSnapshot(
	output: string,
	requiredMessageIds: string[],
):
	| { ok: true; snapshot: ContextCompressionStructuredSnapshot }
	| { ok: false; reason: string } {
	const parsed = parseModelJsonObject(output);
	if (!parsed) {
		return { ok: false, reason: "Model output was not a JSON object." };
	}

	const result = compressionSnapshotSchema.safeParse(parsed);
	if (!result.success) {
		return {
			ok: false,
			reason: `Model output did not match the context compression schema: ${result.error.issues[0]?.message ?? "unknown validation error"}.`,
		};
	}

	const serialized = JSON.stringify(result.data);
	if (/<\/?thinking\b/i.test(serialized)) {
		return {
			ok: false,
			reason: "Snapshot contained leftover <thinking> tags.",
		};
	}

	const coveredMessageIds = new Set(result.data.sourceCoverage.messageIds);
	const missingMessageIds = requiredMessageIds.filter(
		(id) => !coveredMessageIds.has(id),
	);
	if (missingMessageIds.length > 0) {
		return {
			ok: false,
			reason: `Snapshot source coverage missed message ids: ${missingMessageIds.join(", ")}.`,
		};
	}

	const summaryText = [
		result.data.goal,
		result.data.currentState,
		...result.data.importantDecisions,
		...result.data.importantFacts,
		...result.data.openTasks,
		...result.data.openQuestions,
		...result.data.toolUseAndEvidenceRefs.map((ref) => ref.label),
	].join(" ");
	if (summaryText.trim().length < 40) {
		return { ok: false, reason: "Snapshot summary was too empty." };
	}

	return { ok: true, snapshot: result.data };
}

function buildSourceRefs(params: {
	sourceRanges: ContextCompressionSourceRange[];
	snapshot: ContextCompressionStructuredSnapshot;
}): ContextCompressionSourceRef[] {
	return [
		...params.sourceRanges.map((range) => ({
			kind: "message_range",
			...range,
		})),
		...params.snapshot.toolUseAndEvidenceRefs.map((ref) => ({
			...ref,
			kind: "tool_or_evidence_ref",
		})),
	];
}

export async function runContextCompression(
	input: RunContextCompressionInput,
): Promise<ContextCompressionSnapshot> {
	const sourceMessages = requireSourceMessages(input.sourceMessages);
	const firstMessage = sourceMessages[0];
	const lastMessage = sourceMessages[sourceMessages.length - 1];
	const sourceRanges = input.sourceRanges?.length
		? input.sourceRanges
		: defaultSourceRanges(sourceMessages, input.priorSnapshot);
	const coveredMessageIds = requiredCoverageMessageIds({
		sourceMessages,
		priorSnapshot: input.priorSnapshot,
	});
	const firstCoveredMessageId =
		input.priorSnapshot?.sourceStartMessageId ?? firstMessage.id;
	const firstCoveredMessageSequence =
		input.priorSnapshot?.sourceStartMessageSequence ??
		firstMessage.messageSequence;
	const running = await createContextCompressionSnapshot({
		conversationId: input.conversationId,
		userId: input.userId,
		trigger: input.trigger,
		modelId: input.selectedModelId,
		sourceStartMessageId: firstCoveredMessageId,
		sourceEndMessageId: lastMessage.id,
		sourceStartMessageSequence: firstCoveredMessageSequence,
		sourceEndMessageSequence: lastMessage.messageSequence,
		sourceCoverage: {
			messageIds: coveredMessageIds,
			ranges: sourceRanges,
		},
		sourceRefs: sourceRanges.map((range) => ({
			kind: "message_range",
			...range,
		})),
		sourceTokenEstimate:
			input.sourceTokenEstimate ??
			sourceTextEstimate({
				messages: sourceMessages,
				priorSnapshot: input.priorSnapshot,
			}),
	});

	let rejectionReason: string | null = null;
	for (const attempt of [0, 1] as const) {
		const response = await sendMessage(
			buildCompressionPrompt({
				input,
				sourceRanges,
				repairReason:
					attempt === 1 ? (rejectionReason ?? undefined) : undefined,
			}),
			`context-compression:${input.conversationId}:${running.id}`,
			input.selectedModelId,
			undefined,
			{
				skipHonchoContext: true,
				skipDefaultRuntimeGuidance: true,
				systemPromptOverride: CONTEXT_COMPRESSION_SYSTEM_APPENDIX,
				thinkingMode: "on",
			},
		);

		const validation = validateCompressionSnapshot(
			response.text,
			coveredMessageIds,
		);
		if (!validation.ok) {
			rejectionReason = validation.reason;
			continue;
		}

		const updated = await updateContextCompressionSnapshotStatus({
			id: running.id,
			status: "valid",
			snapshot: validation.snapshot,
			sourceCoverage: validation.snapshot.sourceCoverage,
			sourceRefs: buildSourceRefs({
				sourceRanges,
				snapshot: validation.snapshot,
			}),
			estimatedTokens: estimateTokenCount(JSON.stringify(validation.snapshot)),
			sourceTokenEstimate:
				input.sourceTokenEstimate ??
				sourceTextEstimate({
					messages: sourceMessages,
					priorSnapshot: input.priorSnapshot,
				}),
			failureReason: null,
		});
		if (updated) return updated;
		throw new Error("Context compression snapshot disappeared before update.");
	}

	const failed = await updateContextCompressionSnapshotStatus({
		id: running.id,
		status: "failed",
		failureReason:
			rejectionReason ??
			"Model output did not pass context compression validation.",
	});
	if (failed) return failed;
	throw new Error(
		"Context compression snapshot disappeared before failure update.",
	);
}
