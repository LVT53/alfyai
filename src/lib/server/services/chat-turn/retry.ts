import { eq } from "drizzle-orm";
import { parseRetryOrigin } from "$lib/chat-turn-origin";
import {
	type MessageUserIntent,
	parseMessageUserIntent,
} from "$lib/message-user-intent";
import type { RuntimeConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { messages } from "$lib/server/db/schema";
import { listChildForksBySourceMessages } from "$lib/server/services/conversation-forks";
import { getConversation } from "$lib/server/services/conversations";
import { keepReadableRecordedPictures } from "$lib/server/services/images/turn-pictures";
import { listMessageAttachments } from "$lib/server/services/knowledge";
import { messageOrderAsc } from "$lib/server/services/message-ordering";
import { repairConversationMessageSequences } from "$lib/server/services/message-sequences";
import { deleteMessages } from "$lib/server/services/messages";
import type { PendingSkillSelection } from "$lib/server/services/skills/types";
import {
	parseUserPictures,
	recordedPictureRequest,
} from "$lib/shared/artifacts/image-body";
import {
	checkChatTurn,
	preflightChatTurn,
	resolveAppliedSkill,
} from "./preflight";
import { parseChatTurnRequest, parsePendingSkill } from "./request";
import { cleanupFailedTurn } from "./retry-cleanup";
import type { StreamOrchestratorOptions } from "./stream-orchestrator";
import type {
	ChatTurnPreflight,
	ChatTurnRequestError,
	ParsedChatTurnRequest,
} from "./types";

const FORKED_SOURCE_HISTORY_CONFIRMATION_REQUIRED_CODE =
	"forked_source_history_confirmation_required";

const REGENERATION_PROMPT_APPENDIX =
	"The user is regenerating their last request. Provide a completely fresh answer without referencing, acknowledging, or building upon your previous response to this same question. Do not mention that you answered this before. Start fresh as if this is the first time you are seeing this query.";

type RetryRequestBody = {
	conversationId?: unknown;
	assistantMessageId?: unknown;
	userMessageId?: unknown;
	userMessage?: unknown;
	activeDocumentArtifactId?: unknown;
	attachmentIds?: unknown;
	// The card pictures and marks of the turn being retried, sent by the
	// browser like a fresh send's; parsed by parseChatTurnRequest.
	pictureRefs?: unknown;
	imageMarks?: unknown;
	streamId?: unknown;
	model?: unknown;
	reasoningDepth?: unknown;
	personalityProfileId?: unknown;
	confirmForkedSourceHistoryMutation?: unknown;
	// Which retry-route caller this is (see $lib/chat-turn-origin.ts);
	// anything unrecognized is a plain regenerate.
	retryOrigin?: unknown;
	// The skill and the forced web search the browser remembers of the turn. Read
	// only when the reply this retry replaces is already gone and its record with
	// it; a recorded intent always wins.
	userIntent?: unknown;
};

export type RetryPreparationError = ChatTurnRequestError & {
	errorKey?: string;
	details?: string;
	responseShape: "json" | "stream-json";
};

export type RetryOrchestratorInput = Pick<
	StreamOrchestratorOptions,
	| "turn"
	| "upstreamMessage"
	| "isReconnect"
	| "systemPromptAppendix"
	| "pendingSkillInstructions"
>;

type RetryPreparationResult =
	| {
			ok: true;
			value: {
				orchestratorInput: RetryOrchestratorInput;
			};
	  }
	| { ok: false; error: RetryPreparationError };

type ConversationMessage = {
	id: string;
	role: string;
	content: string;
	// Raw `messages.metadata_json`. Read for the retried assistant message's
	// `userIntent` record — the only place the user's own turn choices
	// (composer-applied skill, forced `/web`) survive the send that made them.
	metadataJson: string | null;
};

export async function prepareRetryChatTurn(params: {
	userId: string;
	runtimeConfig: RuntimeConfig;
	body: RetryRequestBody;
}): Promise<RetryPreparationResult> {
	const { userId, runtimeConfig, body } = params;
	const {
		conversationId,
		assistantMessageId,
		userMessageId,
		userMessage,
		activeDocumentArtifactId,
		attachmentIds,
		pictureRefs,
		imageMarks,
		streamId,
		model,
		reasoningDepth,
		personalityProfileId,
		confirmForkedSourceHistoryMutation,
		retryOrigin,
		userIntent,
	} = body;

	if (typeof conversationId !== "string" || !conversationId.trim()) {
		return jsonError("conversationId is required", 400);
	}
	if (typeof assistantMessageId !== "string" || !assistantMessageId.trim()) {
		return jsonError("assistantMessageId is required", 400);
	}
	if (typeof userMessageId !== "string" || !userMessageId.trim()) {
		return jsonError("userMessageId is required", 400);
	}
	if (typeof userMessage !== "string" || !userMessage.trim()) {
		return jsonError("userMessage is required", 400);
	}

	const conversation = await getConversation(userId, conversationId);
	if (!conversation) {
		return jsonError("Conversation not found", 404);
	}

	repairConversationMessageSequences(conversationId);

	const conversationMessages = await db
		.select({
			id: messages.id,
			role: messages.role,
			content: messages.content,
			metadataJson: messages.metadataJson,
		})
		.from(messages)
		.where(eq(messages.conversationId, conversationId))
		.orderBy(...messageOrderAsc());

	const target = findRetryTarget(
		conversationMessages,
		assistantMessageId,
		userMessageId,
	);
	if (!target.ok) return target;
	const { assistantMsg, userMsg: precedingUserMsg, trailingMessages } = target;

	if (precedingUserMsg.content.trim() !== userMessage.trim()) {
		return jsonError(
			"Retry user message text does not match persisted message",
			409,
		);
	}

	// What the person chose for the turn being regenerated, read BEFORE the
	// cleanup and `deleteMessages` below drop the reply it comes from (the
	// helper's own comments say what is read and why it must come first).
	// `conversationMessages` came from a conversation this user owns
	// (`getConversation` above) filtered to `conversationId`, so a record
	// belonging to another user or another conversation is never in reach. A
	// reply that is there never lets the browser say what the user chose, so its
	// `userIntent` is passed on only for a reply that is already gone.
	const choices = await resolveStoredTurnChoices({
		userId,
		conversationId,
		userMessage: precedingUserMsg,
		replyMetadataJson: assistantMsg?.metadataJson ?? null,
		body: {
			attachmentIds,
			pictureRefs,
			imageMarks,
			activeDocumentArtifactId,
			userIntent: assistantMsg ? undefined : userIntent,
		},
	});

	// Nothing trails a reply that is gone, so there is no fork of it to ask about.
	if (confirmForkedSourceHistoryMutation !== true) {
		const trailingAssistantMessageIds = trailingMessages
			.filter((message: ConversationMessage) => message.role === "assistant")
			.map((message: ConversationMessage) => message.id);
		if (trailingAssistantMessageIds.length > 0) {
			const childForks = await listChildForksBySourceMessages(
				userId,
				trailingAssistantMessageIds,
			);
			const hasChildForks = Object.values(childForks).some(
				(sourceForks) => (sourceForks.count ?? 0) > 0,
			);
			if (hasChildForks) {
				return {
					ok: false,
					error: {
						status: 409,
						error: "Forked source history requires confirmation",
						code: FORKED_SOURCE_HISTORY_CONFIRMATION_REQUIRED_CODE,
						errorKey: "fork.regenerateWarning",
						responseShape: "json",
					},
				};
			}
		}
	}

	// Ask the turn's read-only gate before the cleanup and the delete below: a
	// refusal here (an attachment not ready, a picture that cannot be read) must
	// leave the conversation untouched, or the reply the person is regenerating
	// is already gone when they are told why it could not run. The gate runs the
	// turn's own input checks and writes nothing. `preflightStoredTurn` still
	// runs after the delete: it covers what the gate does not (linked sources,
	// the skill, the depth) and re-checks the inputs for the turn that runs.
	const storedTurnRequest = await parseStoredTurnRequest({
		runtimeConfig,
		conversationId,
		message: precedingUserMsg.content,
		choices,
		body: {
			activeDocumentArtifactId,
			streamId,
			model,
			reasoningDepth,
			personalityProfileId,
		},
	});
	if (!storedTurnRequest.ok) return storedTurnRequest;

	const gate = await checkChatTurn({
		userId,
		request: storedTurnRequest.request,
	});
	if (!gate.ok) return streamError(gate.error);

	// A reply that is gone has nothing to clean up and nothing to delete: the
	// attempt that took it cleaned up before it failed, and the user message is the
	// one copy there is.
	if (assistantMsg) {
		try {
			const cleanupResult = await cleanupFailedTurn({
				userId,
				conversationId,
				assistantMessageId,
			});
			if (cleanupResult.warnings.length > 0) {
				console.warn("[RETRY] Cleanup warnings:", cleanupResult.warnings);
			}
		} catch (error) {
			console.error("[RETRY] Cleanup failed:", error);
			return {
				ok: false,
				error: {
					status: 500,
					error: "Retry cleanup failed",
					details: error instanceof Error ? error.message : String(error),
					responseShape: "json",
				},
			};
		}

		const trailingMessageIds = trailingMessages.map(
			(message: ConversationMessage) => message.id,
		);
		await deleteMessages(trailingMessageIds);
	}

	if (!precedingUserMsg.content.trim()) {
		return jsonError("No user message found to retry", 400);
	}

	const preflight = await preflightStoredTurn({
		userId,
		runtimeConfig,
		conversationId,
		message: precedingUserMsg.content,
		choices,
		body: {
			activeDocumentArtifactId,
			streamId,
			model,
			reasoningDepth,
			personalityProfileId,
		},
	});
	if (!preflight.ok) return preflight;

	// Stamped here, after parsing, rather than carried in the synthetic body:
	// this route is what makes a turn a regenerate, so no client body on
	// /api/chat/stream can claim one.
	const turn = {
		...preflight.turn,
		turnOrigin: parseRetryOrigin(retryOrigin),
	};
	const upstreamMessage = turn.normalizedMessage;

	return {
		ok: true,
		value: {
			orchestratorInput: {
				turn,
				upstreamMessage,
				isReconnect: false,
				systemPromptAppendix: REGENERATION_PROMPT_APPENDIX,
				pendingSkillInstructions:
					turn.appliedSkill?.instructionsEnvelope ?? undefined,
			},
		},
	};
}

/**
 * What the person chose for a turn that runs again on a message that is already
 * stored: the skill and the forced web search they chose, and the uploads and
 * pictures the message carried. Read from the records the first run left, and
 * handed to `preflightStoredTurn`, so a regenerate and the resume of a reply that
 * asked ("Ask me first") rebuild the person's message the same way.
 */
export type StoredTurnChoices = {
	pendingSkill: PendingSkillSelection | null;
	forceWebSearch: boolean;
	attachmentIds: string[];
	pictureRefs: unknown;
	imageMarks: unknown;
};

/**
 * Reads the person's choices for a stored turn: `replyMetadataJson` is the raw
 * metadata of the reply the turn produced, and `userMessage` is the message it
 * answers. It only reads, and a caller that is about to delete the reply (a
 * retry) reads first: a failure here, in the skill tables, must not land after the
 * turn's messages are already gone, leaving the conversation short an answer it
 * cannot regenerate.
 *
 * The user's own turn choices (composer-applied skill, forced `/web`) survive only
 * as the reply's `userIntent` record. Absent (a message persisted before the record
 * existed) and malformed both read as "the user chose nothing": a plain turn. A
 * reply that is already gone took its record with it: then the browser's own
 * memory of the turn (`body.userIntent`) is read instead, by the same reader, so a
 * skill deleted since is still dropped below. A caller whose reply is there passes
 * no `userIntent`: a reply that is there never lets the browser say what the user
 * chose.
 *
 * Probes the recorded skill BEFORE preflight, and drops it when it no longer
 * resolves: a fresh send with an unavailable `pendingSkill` is rightly refused with
 * 409 `pending_skill_unavailable`, but a regenerate of an older turn must not start
 * failing because the user has since deleted or disabled that skill. Only the drop
 * decision is made here; a skill that survives is handed to preflight as an
 * ordinary `pendingSkill` and resolved there again, so the turn is assembled by
 * exactly one code path (the send path's) and against the request's own normalized
 * message.
 *
 * A regenerated turn keeps the pictures the person sent: when the browser does not
 * resend them, they come back from the user message's record, under the numbers the
 * person saw, and only with what the person can still read: a picture deleted
 * since, or marks on a picture that is no longer open, are left out and the reply
 * is still regenerated.
 */
export async function resolveStoredTurnChoices(p: {
	userId: string;
	conversationId: string;
	userMessage: { id: string; content: string; metadataJson: string | null };
	replyMetadataJson: string | null;
	body: {
		attachmentIds?: unknown;
		pictureRefs?: unknown;
		imageMarks?: unknown;
		activeDocumentArtifactId?: unknown;
		userIntent?: unknown;
	};
}): Promise<StoredTurnChoices> {
	const { userId, conversationId, userMessage, body } = p;

	const recordedUserIntent =
		readRecordedUserIntent(p.replyMetadataJson) ??
		parseMessageUserIntent(body.userIntent);

	const pendingSkill = await resolveRetryPendingSkill({
		userId,
		skill: recordedUserIntent?.skill,
		requestText: userMessage.content,
	});

	const attachmentIds = await resolveRetryAttachmentIds({
		conversationId,
		userMessageId: userMessage.id,
		requestedAttachmentIds: body.attachmentIds,
	});

	const recordedPictures = recordedPictureRequest(
		readRecordedPictures(userMessage.metadataJson),
	);
	const rebuilt =
		body.pictureRefs === undefined || body.imageMarks === undefined
			? await keepReadableRecordedPictures({
					userId,
					conversationId,
					// Recorded marks must be judged against the refs this regenerate will
					// really carry: the browser's when it resent them (maybe only some of
					// the recorded ones), else the recorded ones.
					refs:
						explicitPictureRefs(body.pictureRefs) ??
						recordedPictures.pictureRefs,
					marks: recordedPictures.imageMarks,
					attachmentIds,
					openImageArtifactId:
						typeof body.activeDocumentArtifactId === "string"
							? body.activeDocumentArtifactId.trim()
							: null,
				})
			: null;

	return {
		pendingSkill,
		forceWebSearch: recordedUserIntent?.webSearch === true,
		attachmentIds,
		pictureRefs:
			body.pictureRefs ??
			(rebuilt?.pictureRefs.length ? rebuilt.pictureRefs : undefined),
		imageMarks: body.imageMarks ?? rebuilt?.imageMarks ?? undefined,
	};
}

/**
 * Parses and preflights a turn that runs again on the stored message `message`,
 * with `choices` read by `resolveStoredTurnChoices`. The message is already saved,
 * so the turn runs without saving it again (`skipPersistUserMessage`), and the
 * caller stamps the turn's origin on the result: this is what makes a turn a
 * regenerate or a resume, so no client body on /api/chat/stream can claim one.
 * A refusal comes back in the stream-json shape, as the stream route's would.
 */
export async function preflightStoredTurn(p: {
	userId: string;
	runtimeConfig: RuntimeConfig;
	conversationId: string;
	message: string;
	choices: StoredTurnChoices;
	body: StoredTurnRunBody;
}): Promise<
	| { ok: true; turn: ChatTurnPreflight }
	| { ok: false; error: RetryPreparationError }
> {
	const storedTurnRequest = await parseStoredTurnRequest({
		runtimeConfig: p.runtimeConfig,
		conversationId: p.conversationId,
		message: p.message,
		choices: p.choices,
		body: p.body,
	});
	if (!storedTurnRequest.ok) return storedTurnRequest;

	const preflight = await preflightChatTurn({
		userId: p.userId,
		request: storedTurnRequest.request,
	});
	if (!preflight.ok) {
		return streamError(preflight.error);
	}
	return { ok: true, turn: preflight.value };
}

/**
 * The optional parts of a stored turn's synthetic body. Shared by the two
 * callers above so the parsed request is the same one.
 */
type StoredTurnRunBody = {
	activeDocumentArtifactId?: unknown;
	streamId?: unknown;
	model?: unknown;
	reasoningDepth?: unknown;
	personalityProfileId?: unknown;
	enabledConnectionCapabilities?: unknown;
};

/**
 * The request a stored turn runs with: the synthetic body rebuilt from the
 * person's recorded choices, parsed by the same request parser a send uses. One
 * helper so the read-only gate a retry asks before it deletes (above) and
 * `preflightStoredTurn`, which still runs after the delete, cannot drift apart.
 * A parse refusal comes back in the stream-json shape.
 */
async function parseStoredTurnRequest(p: {
	runtimeConfig: RuntimeConfig;
	conversationId: string;
	message: string;
	choices: StoredTurnChoices;
	body: StoredTurnRunBody;
}): Promise<
	| { ok: true; request: ParsedChatTurnRequest }
	| { ok: false; error: RetryPreparationError }
> {
	const { choices, body } = p;
	const syntheticBody = buildSyntheticRetryBody({
		conversationId: p.conversationId,
		message: p.message,
		activeDocumentArtifactId: body.activeDocumentArtifactId,
		attachmentIds: choices.attachmentIds,
		pictureRefs: choices.pictureRefs,
		imageMarks: choices.imageMarks,
		streamId: body.streamId,
		model: body.model,
		reasoningDepth: body.reasoningDepth,
		personalityProfileId: body.personalityProfileId,
		enabledConnectionCapabilities: body.enabledConnectionCapabilities,
		pendingSkill: choices.pendingSkill,
		forceWebSearch: choices.forceWebSearch,
	});
	const syntheticRequest = new Request("https://internal", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(syntheticBody),
	});

	const parsedRequest = await parseChatTurnRequest(
		syntheticRequest,
		p.runtimeConfig,
		"stream",
	);
	if (!parsedRequest.ok) return streamError(parsedRequest.error);
	return { ok: true, request: parsedRequest.value };
}

type RetryTarget =
	| {
			ok: true;
			/** The reply being replaced, or null when it is already gone. */
			assistantMsg: ConversationMessage | null;
			/** The user message the reply answers, which stays and is not saved again. */
			userMsg: ConversationMessage;
			/** What the retry deletes: the reply and all that follows it, nothing when the reply is gone. */
			trailingMessages: ConversationMessage[];
	  }
	| { ok: false; error: RetryPreparationError };

/**
 * The reply a retry replaces and the user message it answers. The reply is
 * normally there, directly after its user message. It is gone when an earlier
 * attempt of the same retry deleted it and then failed in the model: the server
 * keeps nothing of a failed turn, so the user message ends the conversation, and
 * the Retry button asks again for a reply that is not there. Then the retry is
 * the turn that user message never got. Only that: a missing reply with anything
 * after the user message, or with another message at the end, is still not found.
 */
function findRetryTarget(
	conversationMessages: ConversationMessage[],
	assistantMessageId: string,
	userMessageId: string,
): RetryTarget {
	const assistantIndex = conversationMessages.findIndex(
		(message: ConversationMessage) => message.id === assistantMessageId,
	);
	if (assistantIndex === -1) {
		const last = conversationMessages.at(-1);
		if (last?.role !== "user" || last.id !== userMessageId) {
			return jsonError("Assistant message not found", 404);
		}
		return {
			ok: true,
			assistantMsg: null,
			userMsg: last,
			trailingMessages: [],
		};
	}

	const assistantMsg = conversationMessages[assistantIndex];
	if (assistantMsg.role !== "assistant") {
		return jsonError("Assistant message not found", 404);
	}
	const userMsg = conversationMessages[assistantIndex - 1];
	if (userMsg?.role !== "user" || userMsg.id !== userMessageId) {
		return jsonError(
			"Retry target does not match the preceding user message",
			409,
		);
	}
	return {
		ok: true,
		assistantMsg,
		userMsg,
		trailingMessages: conversationMessages.slice(assistantIndex),
	};
}

async function resolveRetryAttachmentIds(params: {
	conversationId: string;
	userMessageId: string;
	requestedAttachmentIds: unknown;
}): Promise<string[]> {
	const explicitAttachmentIds = normalizeStringArray(
		params.requestedAttachmentIds,
	);
	if (explicitAttachmentIds.length > 0) {
		return explicitAttachmentIds;
	}

	const attachmentsByMessage = await listMessageAttachments(
		params.conversationId,
	);
	const persistedAttachments =
		attachmentsByMessage.get(params.userMessageId) ?? [];
	return normalizeStringArray(
		persistedAttachments.map((attachment) => attachment.artifactId),
	);
}

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];

	const seen = new Set<string>();
	const result: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const normalized = item.trim();
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		result.push(normalized);
	}
	return result;
}

/**
 * The `userIntent` record persisted with an assistant message, or `undefined`
 * for a legacy message that has none (and for anything malformed —
 * `parseMessageUserIntent` validates rather than passes through).
 */
function readRecordedUserIntent(
	metadataJson: string | null | undefined,
): MessageUserIntent | undefined {
	if (!metadataJson) return undefined;
	try {
		const parsed: unknown = JSON.parse(metadataJson);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return undefined;
		}
		return parseMessageUserIntent(
			(parsed as { userIntent?: unknown }).userIntent,
		);
	} catch {
		return undefined;
	}
}

/**
 * Turns the recorded `{ id, displayName }` back into the `pendingSkill` a fresh
 * send would have carried, or `null` when the skill no longer resolves for this
 * user (deleted, disabled, unpublished, or the Composer Command Registry turned
 * off) — the caller then regenerates without it.
 *
 * The record deliberately keeps no ownership, but the skill lookup queries on
 * it, so try the one the id implies first (system skills are `system:`-prefixed;
 * a user skill's id is a UUID) and the other only if that misses. The selection
 * goes through `parsePendingSkill` — the same validator a request body's
 * `pendingSkill` gets — and `resolveAppliedSkill`, the same resolver preflight
 * uses, which re-checks ownership and enabled state.
 */
async function resolveRetryPendingSkill(params: {
	userId: string;
	skill: MessageUserIntent["skill"];
	requestText: string;
}): Promise<PendingSkillSelection | null> {
	const { userId, skill, requestText } = params;
	if (!skill) return null;

	const ownerships: Array<"user" | "system"> = skill.id.startsWith("system:")
		? ["system", "user"]
		: ["user", "system"];

	for (const ownership of ownerships) {
		const candidate = parsePendingSkill({
			id: skill.id,
			ownership,
			displayName: skill.displayName,
		});
		if (!candidate) return null;
		const resolved = await resolveAppliedSkill({
			userId,
			pendingSkill: candidate,
			requestText,
		});
		if (resolved.ok) return candidate;
		// The registry being off is not about this skill — the other ownership
		// would fail identically, and so would preflight.
		if (resolved.error.code === "composer_commands_disabled") return null;
	}

	return null;
}

function readRecordedPictures(metadataJson: string | null) {
	if (!metadataJson) return undefined;
	try {
		return parseUserPictures(
			(JSON.parse(metadataJson) as { pictures?: unknown }).pictures,
		);
	} catch {
		return undefined;
	}
}

function buildSyntheticRetryBody(params: {
	conversationId: string;
	message: string;
	activeDocumentArtifactId: unknown;
	attachmentIds: unknown;
	pictureRefs: unknown;
	imageMarks: unknown;
	streamId: unknown;
	model: unknown;
	reasoningDepth: unknown;
	personalityProfileId: unknown;
	// Only a resume sends it (the answer's body); a regenerate never has, and
	// leaves it out of the body as it always has.
	enabledConnectionCapabilities: unknown;
	pendingSkill: PendingSkillSelection | null;
	forceWebSearch: boolean;
}): Record<string, unknown> {
	return {
		message: params.message,
		conversationId: params.conversationId,
		// Carried so `parseChatTurnRequest` + `preflightChatTurn` re-apply the
		// user's own choices for this turn exactly as the send path did; the
		// orchestrator then rebuilds the same `userIntent` record from
		// `turn.appliedSkill` / `turn.forceWebSearch` for the regenerated message.
		pendingSkill: params.pendingSkill ?? undefined,
		forceWebSearch: params.forceWebSearch ? true : undefined,
		attachmentIds:
			Array.isArray(params.attachmentIds) && params.attachmentIds.length > 0
				? params.attachmentIds
				: undefined,
		activeDocumentArtifactId:
			typeof params.activeDocumentArtifactId === "string" &&
			params.activeDocumentArtifactId.trim()
				? params.activeDocumentArtifactId.trim()
				: undefined,
		pictureRefs: params.pictureRefs ?? undefined,
		imageMarks: params.imageMarks ?? undefined,
		streamId:
			typeof params.streamId === "string" && params.streamId.trim()
				? params.streamId.trim()
				: undefined,
		model:
			typeof params.model === "string" && params.model.trim()
				? params.model.trim()
				: undefined,
		reasoningDepth:
			typeof params.reasoningDepth === "string" && params.reasoningDepth.trim()
				? params.reasoningDepth.trim()
				: undefined,
		personalityProfileId:
			typeof params.personalityProfileId === "string" &&
			params.personalityProfileId.trim()
				? params.personalityProfileId.trim()
				: undefined,
		enabledConnectionCapabilities:
			params.enabledConnectionCapabilities ?? undefined,
		skipPersistUserMessage: true,
	};
}

function jsonError(
	error: string,
	status: number,
): { ok: false; error: RetryPreparationError } {
	return {
		ok: false,
		error: {
			error,
			status,
			responseShape: "json",
		},
	};
}

function streamError(error: ChatTurnRequestError): {
	ok: false;
	error: RetryPreparationError;
} {
	return {
		ok: false,
		error: {
			...error,
			responseShape: "stream-json",
		},
	};
}

/** The refs a browser resent, in the shape the picture helpers read; null when it sent none at all. Invalid entries are left for the request parser to refuse. */
function explicitPictureRefs(
	value: unknown,
): Array<{ imageFileId: string; number: number }> | null {
	if (!Array.isArray(value)) return null;
	return value.flatMap((entry) => {
		if (typeof entry !== "object" || entry === null) return [];
		const { imageFileId, number } = entry as Record<string, unknown>;
		return typeof imageFileId === "string" && typeof number === "number"
			? [{ imageFileId, number }]
			: [];
	});
}
