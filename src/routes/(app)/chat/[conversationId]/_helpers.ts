import type { I18nKey } from "$lib/i18n";
import type { StreamMetadata } from "$lib/services/streaming";
import type {
	ArtifactSummary,
	ChatMessage,
	DeepResearchJob,
	EvidenceSourceType,
	FileProductionJob,
	LinkedContextSource,
	ModelId,
	PendingAttachment,
	PendingSkillSelection,
	SkillDraftProposal,
	ThinkingMode,
	ToolEvidenceCandidate,
} from "$lib/types";
import { isOsFileDropEvent } from "$lib/utils/file-drag";
import {
	isFileProductionToolName,
	toolCallInputKey,
} from "$lib/utils/tool-calls";

export { isOsFileDropEvent };

export type SendPayload = {
	message: string;
	attachmentIds: string[];
	attachments: ArtifactSummary[];
	pendingAttachments: PendingAttachment[];
	linkedSources?: LinkedContextSource[];
	pendingSkill?: PendingSkillSelection | null;
	conversationId?: string | null;
	modelId?: ModelId;
	personalityProfileId?: string | null;
	deepResearchDepth?: "focused" | "standard" | "max" | null;
	thinkingMode?: ThinkingMode;
	forceWebSearch?: boolean;
};

export type MessageEditPayload = {
	messageId: string;
	newText: string;
};

export type MessageRegeneratePayload = {
	messageId: string;
};

export type DraftChangePayload = {
	conversationId: string | null;
	draftText: string;
	selectedAttachmentIds: string[];
	selectedAttachments: PendingAttachment[];
	selectedLinkedSources: LinkedContextSource[];
	pendingSkill: PendingSkillSelection | null;
};

export type StreamToolCallDetails = {
	callId?: string;
	outputSummary?: string | null;
	sourceType?: EvidenceSourceType | null;
	candidates?: ToolEvidenceCandidate[];
	metadata?: Record<string, string | number | boolean | null>;
};

type Translate = (key: I18nKey) => string;

const FRIENDLY_SEND_ERROR_KEYS = {
	timeout: "chat.error.timeout",
	network: "chat.error.network",
	backend_failure: "chat.error.backend",
	capacity_exceeded: "chat.error.capacity",
	file_too_large: "chat.error.fileTooLarge",
	message_too_long: "chat.error.messageTooLong",
	provider_tool_rounds: "chat.error.providerToolRounds",
	linked_source_not_found: "chat.error.linkedSourceNotFound",
} as const satisfies Record<string, I18nKey>;

const FALLBACK_SEND_ERRORS: Record<
	keyof typeof FRIENDLY_SEND_ERROR_KEYS,
	string
> = {
	timeout:
		"The model stopped sending updates before it finished. This usually means the provider stream stalled or the request ran too long. Retry the message; if it repeats, try a shorter prompt or another model.",
	network:
		"The chat service could not stay connected to the model provider. Check the server connection and retry; if it keeps happening, the provider endpoint may be unavailable.",
	backend_failure:
		"The model provider or Langflow returned an error before a complete response was produced. Retry the message; if it repeats, check the model and provider logs.",
	capacity_exceeded:
		"The chat service is already handling the maximum number of active responses. Wait a moment, then retry.",
	file_too_large:
		"The uploaded file is larger than the configured upload limit. Upload a smaller file or raise the limit in admin settings.",
	message_too_long:
		"That message is longer than the configured model input limit. Shorten it or split the request into smaller parts.",
	provider_tool_rounds:
		"The provider needed too many tool-call rounds and the turn was stopped to avoid looping. Retry with a narrower request or fewer required sources.",
	linked_source_not_found:
		"One of the linked Library documents is no longer available. Remove the missing source or link it again, then retry.",
};

function friendlyError(
	code: keyof typeof FRIENDLY_SEND_ERROR_KEYS,
	translate?: Translate,
): string {
	return (
		translate?.(FRIENDLY_SEND_ERROR_KEYS[code]) ?? FALLBACK_SEND_ERRORS[code]
	);
}

export function toFriendlySendError(
	error: Error,
	translate?: Translate,
): string {
	const errorWithCode = error as Error & { code?: unknown };
	if (errorWithCode.code === "attachment_not_ready") {
		return error.message;
	}
	if (errorWithCode.code === "timeout")
		return friendlyError("timeout", translate);
	if (errorWithCode.code === "network")
		return friendlyError("network", translate);
	if (errorWithCode.code === "backend_failure")
		return friendlyError("backend_failure", translate);
	if (errorWithCode.code === "capacity_exceeded")
		return friendlyError("capacity_exceeded", translate);
	if (errorWithCode.code === "file_too_large")
		return friendlyError("file_too_large", translate);
	if (errorWithCode.code === "message_too_long")
		return friendlyError("message_too_long", translate);
	if (errorWithCode.code === "provider_tool_rounds")
		return friendlyError("provider_tool_rounds", translate);
	if (errorWithCode.code === "linked_source_not_found")
		return friendlyError("linked_source_not_found", translate);

	const message = (error.message ?? "").toLowerCase();
	if (message.includes("timeout") || message.includes("timed out")) {
		return friendlyError("timeout", translate);
	}

	if (
		message.includes("network") ||
		message.includes("failed to fetch") ||
		message.includes("fetch") ||
		message.includes("connection")
	) {
		return friendlyError("network", translate);
	}

	if (message.includes("capacity") || message.includes("server at capacity"))
		return friendlyError("capacity_exceeded", translate);

	if (
		message.includes("file too large") ||
		message.includes("too large") ||
		message.includes("maximum size")
	)
		return friendlyError("file_too_large", translate);

	return friendlyError("backend_failure", translate);
}

export function mergeAttachedArtifacts(
	currentArtifacts: ArtifactSummary[],
	nextArtifacts: ArtifactSummary[],
): ArtifactSummary[] {
	if (nextArtifacts.length === 0) return currentArtifacts;

	const mergedArtifacts = new Map(
		currentArtifacts.map((artifact) => [artifact.id, artifact]),
	);
	for (const artifact of nextArtifacts) {
		mergedArtifacts.set(artifact.id, artifact);
	}
	return Array.from(mergedArtifacts.values());
}

export function hasActiveFileProductionJobs(
	jobs: FileProductionJob[],
): boolean {
	return jobs.some(
		(job) => job.status === "queued" || job.status === "running",
	);
}

export function hasActiveDeepResearchJobs(jobs: DeepResearchJob[]): boolean {
	return jobs.some(
		(job) =>
			job.status === "awaiting_plan" ||
			job.status === "awaiting_approval" ||
			job.status === "approved" ||
			job.status === "running",
	);
}

export function mergeDeepResearchJobsForHydration(
	currentJobs: DeepResearchJob[],
	incomingJobs: DeepResearchJob[],
): DeepResearchJob[] {
	const incomingIds = new Set(incomingJobs.map((job) => job.id));
	const merged = [...incomingJobs];
	for (const job of currentJobs) {
		if (incomingIds.has(job.id)) continue;
		if (!shouldPreserveDeepResearchJobDuringHydration(job)) continue;
		if (
			incomingJobs.some((incomingJob) =>
				isEquivalentDeepResearchJob(job, incomingJob),
			)
		) {
			continue;
		}
		merged.push(job);
	}
	return merged;
}

function shouldPreserveDeepResearchJobDuringHydration(
	job: DeepResearchJob,
): boolean {
	return (
		job.id.startsWith("pending-deep-research-") ||
		hasActiveDeepResearchJobs([job])
	);
}

function isEquivalentDeepResearchJob(
	left: DeepResearchJob,
	right: DeepResearchJob,
): boolean {
	if (left.id === right.id) return true;
	if (left.triggerMessageId && left.triggerMessageId === right.triggerMessageId)
		return true;
	const leftRequest = left.userRequest?.trim() ?? "";
	const rightRequest = right.userRequest?.trim() ?? "";
	return (
		left.conversationId === right.conversationId &&
		left.depth === right.depth &&
		leftRequest.length > 0 &&
		leftRequest === rightRequest
	);
}

export function shouldStartDeepResearchJob(
	payload: Pick<SendPayload, "deepResearchDepth">,
	retryAssistantMessageId?: string,
): boolean {
	return Boolean(payload.deepResearchDepth && !retryAssistantMessageId);
}

export function shouldDeleteConversationAfterCancellingDeepResearch(params: {
	jobBeforeCancel: DeepResearchJob | null | undefined;
	messageCount: number;
	deepResearchJobCount: number;
}): boolean {
	const status = params.jobBeforeCancel?.status;
	const notStarted =
		status === "awaiting_plan" || status === "awaiting_approval";
	return (
		notStarted && params.messageCount <= 1 && params.deepResearchJobCount <= 1
	);
}

export function isConversationReadOnly(
	conversation: { status?: "open" | "sealed" | null },
	_deepResearchJobs: DeepResearchJob[] = [],
): boolean {
	return conversation.status === "sealed";
}

export function shouldHydrateFileProductionJobsOnToolCall(
	name: string,
	status: "running" | "done",
): boolean {
	return isFileProductionToolName(name) && status === "done";
}

export function mergeFileProductionJob(
	currentJobs: FileProductionJob[],
	updatedJob: FileProductionJob,
): FileProductionJob[] {
	const existingIndex = currentJobs.findIndex(
		(job) => job.id === updatedJob.id,
	);
	if (existingIndex === -1) {
		return [updatedJob, ...currentJobs];
	}

	return currentJobs.map((job, index) =>
		index === existingIndex ? updatedJob : job,
	);
}

export function attachUnassignedFileProductionJobsToAssistant(
	currentJobs: FileProductionJob[],
	params: { conversationId: string; assistantMessageId: string },
): FileProductionJob[] {
	return currentJobs.map((job) =>
		job.conversationId === params.conversationId &&
		job.assistantMessageId === null
			? { ...job, assistantMessageId: params.assistantMessageId }
			: job,
	);
}

export type WorkspacePresentation = "docked" | "expanded";

export function getWorkspacePresentationAfterDocumentOpen(
	currentPresentation: WorkspacePresentation,
	options: { preservePresentation?: boolean } = {},
): WorkspacePresentation {
	return options.preservePresentation ? currentPresentation : "docked";
}

export function createAssistantPlaceholder(
	id: string,
	timestamp = Date.now(),
): ChatMessage {
	return {
		id,
		renderKey: id,
		role: "assistant",
		content: "",
		timestamp,
		isStreaming: true,
	};
}

export function createUserMessage(params: {
	id: string;
	text: string;
	timestamp?: number;
	attachmentIds: string[];
	attachedArtifacts: ArtifactSummary[];
}): ChatMessage {
	const timestamp = params.timestamp ?? Date.now();

	return {
		id: params.id,
		renderKey: params.id,
		role: "user",
		content: params.text,
		attachments: params.attachedArtifacts
			.filter((artifact) => params.attachmentIds.includes(artifact.id))
			.map((artifact) => ({
				id: artifact.id,
				artifactId: artifact.id,
				name: artifact.name,
				type: artifact.type,
				mimeType: artifact.mimeType,
				sizeBytes: artifact.sizeBytes,
				conversationId: artifact.conversationId,
				messageId: null,
				createdAt: artifact.createdAt,
			})),
		timestamp,
	};
}

export function appendAssistantPlaceholder(
	list: ChatMessage[],
	placeholder: ChatMessage,
): ChatMessage[] {
	return [...list, placeholder];
}

export function appendUserMessageAndPlaceholder(
	list: ChatMessage[],
	userMessage: ChatMessage,
	placeholder: ChatMessage,
): ChatMessage[] {
	return [...list, userMessage, placeholder];
}

export function updateMessageById(
	list: ChatMessage[],
	messageId: string,
	updater: (message: ChatMessage) => ChatMessage,
): ChatMessage[] {
	return list.map((message) =>
		message.id === messageId ? updater(message) : message,
	);
}

export function patchSkillDraftInMessageList(
	list: ChatMessage[],
	params: { messageId: string; draft: SkillDraftProposal },
): ChatMessage[] {
	return list.map((message) => {
		if (message.id !== params.messageId) return message;
		const skillDrafts = message.skillDrafts ?? [];
		if (!skillDrafts.some((draft) => draft.id === params.draft.id))
			return message;
		return {
			...message,
			skillDrafts: skillDrafts.map((draft) =>
				draft.id === params.draft.id ? params.draft : draft,
			),
		};
	});
}

export function appendTokenChunkToMessageList(
	list: ChatMessage[],
	placeholderId: string,
	chunk: string,
): ChatMessage[] {
	// NOTE: Do NOT set isThinkingStreaming: false here.
	// isThinkingStreaming tracks whether thinking chunks are still arriving.
	// It should only be set true by appendThinkingChunkToMessageList (when thinking
	// chunks arrive) and set false by finalizeStreamingMessageList (when stream ends).
	// Setting it false on first visible token causes thinkingIsDone to become true
	// while tool_call thinking segments may still be arriving, showing <tool_call|>
	// artifacts in the UI before the thinking block is fully rendered.
	return updateMessageById(list, placeholderId, (message) => ({
		...message,
		content: message.content + chunk,
	}));
}

export function appendThinkingChunkToMessageList(
	list: ChatMessage[],
	placeholderId: string,
	chunk: string,
): ChatMessage[] {
	return updateMessageById(list, placeholderId, (message) => {
		const segments = message.thinkingSegments ?? [];
		const lastSegment = segments[segments.length - 1];
		const nextSegments =
			lastSegment?.type === "text"
				? [
						...segments.slice(0, -1),
						{ type: "text" as const, content: lastSegment.content + chunk },
					]
				: [...segments, { type: "text" as const, content: chunk }];

		return {
			...message,
			thinking: (message.thinking ?? "") + chunk,
			thinkingSegments: nextSegments,
			isThinkingStreaming: true,
		};
	});
}

export function applyToolCallUpdateToMessageList(
	list: ChatMessage[],
	params: {
		placeholderId: string;
		name: string;
		input: Record<string, unknown>;
		status: "running" | "done";
		details?: StreamToolCallDetails;
	},
): ChatMessage[] {
	return updateMessageById(list, params.placeholderId, (message) => {
		if (isFileProductionToolName(params.name)) {
			return message;
		}

		const segments = message.thinkingSegments ?? [];
		const callId = params.details?.callId;
		if (params.status === "running") {
			const inputKey = toolCallInputKey(params.input);
			const duplicateRunning = segments.some(
				(segment) =>
					segment.type === "tool_call" &&
					segment.status === "running" &&
					segment.name === params.name &&
					(callId
						? segment.callId === callId
						: toolCallInputKey(segment.input) === inputKey),
			);
			if (duplicateRunning) return message;
			return {
				...message,
				thinkingSegments: [
					...segments,
					{
						type: "tool_call" as const,
						...(callId ? { callId } : {}),
						name: params.name,
						input: params.input,
						status: "running" as const,
					},
				],
			};
		}

		const updatedSegments = [...segments];
		let lastRunningIndex = -1;
		for (let i = updatedSegments.length - 1; i >= 0; i -= 1) {
			const segment = updatedSegments[i];
			if (
				segment.type === "tool_call" &&
				segment.name === params.name &&
				segment.status === "running" &&
				(callId ? segment.callId === callId : true)
			) {
				lastRunningIndex = i;
				break;
			}
		}

		if (lastRunningIndex !== -1) {
			updatedSegments[lastRunningIndex] = {
				...updatedSegments[lastRunningIndex],
				status: "done" as const,
				...(callId ? { callId } : {}),
				outputSummary: params.details?.outputSummary ?? null,
				sourceType: params.details?.sourceType ?? null,
				candidates: params.details?.candidates,
				metadata: params.details?.metadata,
			};
		}

		return { ...message, thinkingSegments: updatedSegments };
	});
}

export function finalizeStreamingMessageList(
	list: ChatMessage[],
	params: {
		placeholderId: string;
		clientUserMessageId: string | null;
		metadata?: StreamMetadata;
	},
): ChatMessage[] {
	const serverAssistantId = params.metadata?.assistantMessageId;
	const serverUserMessageId = params.metadata?.userMessageId;

	return list.map((message) => {
		if (message.id === params.placeholderId) {
			const finalizedThinkingSegments = message.thinkingSegments?.map(
				(segment) =>
					segment.type === "tool_call" && segment.status === "running"
						? { ...segment, status: "done" as const }
						: segment,
			);
			return {
				...message,
				renderKey: message.renderKey ?? params.placeholderId,
				id: serverAssistantId ?? message.id,
				content: params.metadata?.wasStopped
					? message.content || "Stopped"
					: message.content,
				isStreaming: false,
				thinking: params.metadata?.thinking ?? message.thinking,
				isThinkingStreaming: false,
				modelId: params.metadata?.modelId ?? message.modelId,
				modelDisplayName:
					params.metadata?.modelDisplayName ?? message.modelDisplayName,
				thinkingTokenCount: params.metadata?.thinkingTokenCount,
				responseTokenCount: params.metadata?.responseTokenCount,
				totalTokenCount: params.metadata?.totalTokenCount,
				thinkingSegments: finalizedThinkingSegments,
				evidenceSummary: message.evidenceSummary,
				evidencePending: Boolean(serverAssistantId),
			};
		}

		if (
			params.clientUserMessageId &&
			message.id === params.clientUserMessageId &&
			serverUserMessageId
		) {
			return {
				...message,
				renderKey: message.renderKey ?? params.clientUserMessageId,
				id: serverUserMessageId,
			};
		}

		return message;
	});
}

export function removeMessageById(
	list: ChatMessage[],
	messageId: string,
): ChatMessage[] {
	return list.filter((message) => message.id !== messageId);
}

export function cloneSendPayload(payload: SendPayload): SendPayload {
	return {
		message: payload.message,
		attachmentIds: [...(payload.attachmentIds ?? [])],
		attachments: [...(payload.attachments ?? [])],
		pendingAttachments: (payload.pendingAttachments ?? []).map(
			(attachment) => ({
				...attachment,
			}),
		),
		linkedSources: (payload.linkedSources ?? []).map((source) => ({
			...source,
			familyArtifactIds: [...source.familyArtifactIds],
		})),
		pendingSkill: payload.pendingSkill
			? {
					id: payload.pendingSkill.id,
					ownership: payload.pendingSkill.ownership,
					skillKind: payload.pendingSkill.skillKind,
					displayName: payload.pendingSkill.displayName,
					baseSkillId: payload.pendingSkill.baseSkillId ?? null,
					baseSkillDisplayName:
						payload.pendingSkill.baseSkillDisplayName ?? null,
					unavailable: payload.pendingSkill.unavailable === true,
				}
			: null,
		conversationId: payload.conversationId ?? null,
		modelId: payload.modelId,
		deepResearchDepth: payload.deepResearchDepth ?? null,
		thinkingMode: payload.thinkingMode,
		forceWebSearch: payload.forceWebSearch === true,
	};
}

export function isPendingSkillUnavailableError(error: unknown): boolean {
	const maybeError = error as { code?: unknown; message?: unknown } | null;
	return (
		maybeError?.code === "pending_skill_unavailable" ||
		maybeError?.code === "skill_unavailable"
	);
}

export function markPendingSkillUnavailable(payload: SendPayload): SendPayload {
	const cloned = cloneSendPayload(payload);
	if (!cloned.pendingSkill) return cloned;
	return {
		...cloned,
		pendingSkill: {
			...cloned.pendingSkill,
			unavailable: true,
		},
	};
}
