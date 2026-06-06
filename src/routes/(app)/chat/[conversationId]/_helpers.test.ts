import { describe, expect, it } from "vitest";
import type { I18nKey } from "$lib/i18n";
import type {
	ChatMessage,
	DeepResearchJob,
	FileProductionJob,
	SkillDraftProposal,
} from "$lib/types";
import {
	applyResponseActivityEntryToMessageList,
	applyToolCallUpdateToMessageList,
	attachUnassignedFileProductionJobsToAssistant,
	cloneSendPayload,
	createAssistantPlaceholder,
	finalizeStreamingMessageList,
	getWorkspacePresentationAfterDocumentOpen,
	hasActiveDeepResearchJobs,
	hasActiveFileProductionJobs,
	isConversationReadOnly,
	isPendingSkillUnavailableError,
	markPendingSkillUnavailable,
	mergeDeepResearchJobsForHydration,
	mergeFileProductionJob,
	patchSkillDraftInMessageList,
	shouldDeleteConversationAfterCancellingDeepResearch,
	shouldHydrateFileProductionJobsOnToolCall,
	shouldStartDeepResearchJob,
	toFriendlySendError,
} from "./_helpers";

function makeJob(
	id: string,
	status: FileProductionJob["status"],
): FileProductionJob {
	return {
		id,
		conversationId: "conv-1",
		assistantMessageId: "assistant-1",
		title: id,
		status,
		stage: null,
		createdAt: 1,
		updatedAt: 1,
		files: [],
		warnings: [],
		error: null,
	};
}

function makeUnassignedJob(
	id: string,
	overrides: Partial<FileProductionJob> = {},
): FileProductionJob {
	return {
		...makeJob(id, "succeeded"),
		assistantMessageId: null,
		...overrides,
	};
}

function makeDeepResearchJob(
	status: DeepResearchJob["status"],
): DeepResearchJob {
	return {
		id: `research-${status}`,
		conversationId: "conv-1",
		triggerMessageId: "user-1",
		depth: "standard",
		status,
		stage: status,
		title: `${status} research`,
		userRequest: `${status} research`,
		createdAt: 1,
		updatedAt: 1,
		completedAt: null,
		cancelledAt: status === "cancelled" ? 2 : null,
	};
}

function makeHydrationDeepResearchJob(
	id: string,
	overrides: Partial<DeepResearchJob> = {},
): DeepResearchJob {
	return {
		id,
		conversationId: "conv-1",
		triggerMessageId: "user-1",
		depth: "standard",
		status: "awaiting_plan",
		stage: "plan_generation",
		title: id,
		userRequest: "Research battery recycling",
		createdAt: 1,
		updatedAt: 1,
		completedAt: null,
		cancelledAt: null,
		...overrides,
	};
}

describe("toFriendlySendError", () => {
	const translate = (key: I18nKey) => `translated:${key}`;

	it("uses localized messages for known stream error codes", () => {
		const error = new Error("Stream error") as Error & { code?: string };
		error.code = "timeout";

		expect(toFriendlySendError(error, translate)).toBe(
			"translated:chat.error.timeout",
		);
	});

	it("maps unknown generation failures to the descriptive backend message", () => {
		expect(toFriendlySendError(new Error("provider down"), translate)).toBe(
			"translated:chat.error.backend",
		);
	});

	it("uses provider-neutral fallback text for unknown generation failures", () => {
		const message = toFriendlySendError(new Error("provider down"));

		expect(message).toContain("model provider");
		expect(message).not.toMatch(/Langflow/i);
	});

	it("maps missing linked source preflight failures to a specific localized message", () => {
		const error = new Error("Linked source is no longer available") as Error & {
			code?: string;
		};
		error.code = "linked_source_not_found";

		expect(toFriendlySendError(error, translate)).toBe(
			"translated:chat.error.linkedSourceNotFound",
		);
	});
});

describe("workspace presentation helpers", () => {
	it("defaults new document opens to the docked workspace from chat rows and cards", () => {
		expect(getWorkspacePresentationAfterDocumentOpen("expanded")).toBe(
			"docked",
		);
	});

	it("preserves expanded presentation for document opens initiated inside the workspace", () => {
		expect(
			getWorkspacePresentationAfterDocumentOpen("expanded", {
				preservePresentation: true,
			}),
		).toBe("expanded");
	});
});

describe("send payload helpers", () => {
	it("marks stale pending skills unavailable while preserving the draft payload", () => {
		const error = new Error(
			"Selected skill is no longer available.",
		) as Error & { code?: string };
		error.code = "pending_skill_unavailable";
		const payload = markPendingSkillUnavailable({
			message: "Use this",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
			pendingSkill: {
				id: "variant-1",
				ownership: "user",
				skillKind: "skill_variant",
				displayName: "Pack variant",
				baseSkillId: "system:pack",
				baseSkillDisplayName: "Pack",
			},
		});

		expect(isPendingSkillUnavailableError(error)).toBe(true);
		expect(payload).toEqual(
			expect.objectContaining({
				message: "Use this",
				pendingSkill: expect.objectContaining({
					id: "variant-1",
					skillKind: "skill_variant",
					baseSkillDisplayName: "Pack",
					unavailable: true,
				}),
			}),
		);
	});

	it("preserves Deep Research depth when cloning queued turns", () => {
		const cloned = cloneSendPayload({
			message: "Research battery recycling",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
			conversationId: "conv-1",
			deepResearchDepth: "focused",
		});

		expect(cloned).toEqual(
			expect.objectContaining({
				message: "Research battery recycling",
				deepResearchDepth: "focused",
			}),
		);
	});

	it("routes composer-selected Deep Research through the job-start path", () => {
		const payload = {
			message: "Research battery recycling",
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
			conversationId: "conv-1",
			deepResearchDepth: "focused" as const,
		};

		expect(shouldStartDeepResearchJob(payload)).toBe(true);
		expect(
			shouldStartDeepResearchJob({ ...payload, deepResearchDepth: null }),
		).toBe(false);
		expect(shouldStartDeepResearchJob(payload, "assistant-retry-1")).toBe(
			false,
		);
	});
});

describe("Skill Draft message helpers", () => {
	function makeSkillDraft(
		overrides: Partial<SkillDraftProposal> = {},
	): SkillDraftProposal {
		return {
			id: "draft-1",
			status: "proposed",
			displayName: "Meeting critic",
			description: "Review meeting notes.",
			instructions: "Find missing owners.",
			activationExamples: [],
			durationPolicy: "next_message",
			questionPolicy: "none",
			notesPolicy: "none",
			sourceScope: "selected_sources_only",
			...overrides,
		};
	}

	it("patches the matching assistant Skill Draft without replacing unrelated messages", () => {
		const userMessage: ChatMessage = {
			id: "user-1",
			role: "user",
			content: "Review this.",
			timestamp: 1,
		};
		const assistantMessage: ChatMessage = {
			id: "assistant-1",
			role: "assistant",
			content: "I can make this reusable.",
			timestamp: 2,
			skillDrafts: [makeSkillDraft()],
		};
		const updatedDraft = makeSkillDraft({ status: "saved" });

		expect(
			patchSkillDraftInMessageList([userMessage, assistantMessage], {
				messageId: "assistant-1",
				draft: updatedDraft,
			}),
		).toEqual([
			userMessage,
			{
				...assistantMessage,
				skillDrafts: [updatedDraft],
			},
		]);
	});

	it("does not patch a same-id draft on a different assistant message", () => {
		const firstMessage: ChatMessage = {
			id: "assistant-1",
			role: "assistant",
			content: "First",
			timestamp: 1,
			skillDrafts: [makeSkillDraft()],
		};
		const secondMessage: ChatMessage = {
			id: "assistant-2",
			role: "assistant",
			content: "Second",
			timestamp: 2,
			skillDrafts: [makeSkillDraft()],
		};
		const updatedDraft = makeSkillDraft({ status: "dismissed" });

		expect(
			patchSkillDraftInMessageList([firstMessage, secondMessage], {
				messageId: "assistant-2",
				draft: updatedDraft,
			}),
		).toEqual([
			firstMessage,
			{
				...secondMessage,
				skillDrafts: [updatedDraft],
			},
		]);
	});
});

describe("Deep Research cancellation helpers", () => {
	it("deletes a brand-new unstarted Deep Research conversation after cancellation", () => {
		expect(
			shouldDeleteConversationAfterCancellingDeepResearch({
				jobBeforeCancel: makeDeepResearchJob("awaiting_approval"),
				messageCount: 1,
				deepResearchJobCount: 1,
			}),
		).toBe(true);
	});

	it("keeps conversations with started research or prior chat history", () => {
		expect(
			shouldDeleteConversationAfterCancellingDeepResearch({
				jobBeforeCancel: makeDeepResearchJob("running"),
				messageCount: 1,
				deepResearchJobCount: 1,
			}),
		).toBe(false);
		expect(
			shouldDeleteConversationAfterCancellingDeepResearch({
				jobBeforeCancel: makeDeepResearchJob("awaiting_approval"),
				messageCount: 2,
				deepResearchJobCount: 1,
			}),
		).toBe(false);
		expect(
			shouldDeleteConversationAfterCancellingDeepResearch({
				jobBeforeCancel: makeDeepResearchJob("awaiting_approval"),
				messageCount: 1,
				deepResearchJobCount: 2,
			}),
		).toBe(false);
	});
});

describe("Deep Research hydration helpers", () => {
	it("preserves an optimistic planning card when a stale hydration payload has no jobs yet", () => {
		const optimisticJob = makeHydrationDeepResearchJob(
			"pending-deep-research-1",
		);

		expect(mergeDeepResearchJobsForHydration([optimisticJob], [])).toEqual([
			optimisticJob,
		]);
	});

	it("preserves an active server job when a stale hydration payload temporarily misses it", () => {
		const activeJob = makeHydrationDeepResearchJob("research-1", {
			status: "awaiting_plan",
		});

		expect(mergeDeepResearchJobsForHydration([activeJob], [])).toEqual([
			activeJob,
		]);
	});

	it("does not preserve completed local jobs that are absent from the hydrated payload", () => {
		const completedJob = makeHydrationDeepResearchJob("research-1", {
			status: "completed",
			stage: "report_ready",
			reportArtifactId: "artifact-1",
			completedAt: 2,
		});

		expect(mergeDeepResearchJobsForHydration([completedJob], [])).toEqual([]);
	});

	it("replaces an optimistic equivalent once the server job is present", () => {
		const optimisticJob = makeHydrationDeepResearchJob(
			"pending-deep-research-1",
		);
		const serverJob = makeHydrationDeepResearchJob("research-1", {
			triggerMessageId: "server-user-1",
			status: "awaiting_approval",
			stage: "plan_drafted",
		});

		expect(
			mergeDeepResearchJobsForHydration([optimisticJob], [serverJob]),
		).toEqual([serverJob]);
	});
});

describe("conversation read-only helpers", () => {
	it("treats sealed conversations as read-only for chat input", () => {
		expect(isConversationReadOnly({ status: "sealed" })).toBe(true);
		expect(isConversationReadOnly({ status: "open" })).toBe(false);
		expect(isConversationReadOnly({ status: undefined })).toBe(false);
	});

	it("does not infer read-only mode from cancelled or failed Deep Research jobs", () => {
		const jobs = [
			makeDeepResearchJob("cancelled"),
			makeDeepResearchJob("failed"),
		];

		expect(isConversationReadOnly({ status: "open" }, jobs)).toBe(false);
	});
});

describe("file production chat helpers", () => {
	it("detects only queued and running jobs as active polling candidates", () => {
		expect(hasActiveFileProductionJobs([makeJob("queued", "queued")])).toBe(
			true,
		);
		expect(hasActiveFileProductionJobs([makeJob("running", "running")])).toBe(
			true,
		);
		expect(
			hasActiveFileProductionJobs([
				makeJob("succeeded", "succeeded"),
				makeJob("failed", "failed"),
				makeJob("cancelled", "cancelled"),
			]),
		).toBe(false);
	});

	it("merges an updated job into the existing chat state without duplicating cards", () => {
		const current = [makeJob("job-1", "running"), makeJob("job-2", "queued")];
		const merged = mergeFileProductionJob(current, {
			...makeJob("job-1", "failed"),
			error: {
				code: "renderer_timeout",
				message: "Renderer timed out.",
				retryable: true,
			},
		});

		expect(merged).toHaveLength(2);
		expect(merged[0]).toMatchObject({
			id: "job-1",
			status: "failed",
			error: {
				code: "renderer_timeout",
			},
		});
		expect(merged[1].id).toBe("job-2");
	});

	it("hydrates file-production jobs once the produce_file tool call has created a job", () => {
		expect(
			shouldHydrateFileProductionJobsOnToolCall("produce_file", "done"),
		).toBe(true);
		expect(
			shouldHydrateFileProductionJobsOnToolCall("file_production", "done"),
		).toBe(true);
		expect(
			shouldHydrateFileProductionJobsOnToolCall("produce_file", "running"),
		).toBe(false);
		expect(
			shouldHydrateFileProductionJobsOnToolCall("web_search", "done"),
		).toBe(false);
	});

	it("keeps produce_file events out of visible thinking segments", () => {
		const list = [createAssistantPlaceholder("assistant-1")];
		const running = applyToolCallUpdateToMessageList(list, {
			placeholderId: "assistant-1",
			name: "produce_file",
			input: { requestTitle: "Quarterly report" },
			status: "running",
		});
		const done = applyToolCallUpdateToMessageList(running, {
			placeholderId: "assistant-1",
			name: "produce_file",
			input: {},
			status: "done",
		});

		expect(done[0].thinkingSegments).toBeUndefined();
	});

	it("merges response activity entries by id without capping the row count", () => {
		const list = [createAssistantPlaceholder("assistant-1")];
		const withRows = Array.from({ length: 12 }, (_, index) => ({
			id: `activity-${index}`,
			kind: "context" as const,
			status: "running" as const,
			detail: `Context ${index}`,
		})).reduce(
			(current, entry) =>
				applyResponseActivityEntryToMessageList(current, "assistant-1", entry),
			list,
		);

		const updated = applyResponseActivityEntryToMessageList(
			withRows,
			"assistant-1",
			{
				id: "activity-5",
				kind: "context",
				status: "done",
				detail: "Context ready",
			},
		);

		expect(updated[0].responseActivity).toHaveLength(12);
		expect(updated[0].responseActivity?.[5]).toMatchObject({
			id: "activity-5",
			status: "done",
			detail: "Context ready",
		});
	});

	it("mirrors deliberation activity into auditable thinking status segments", () => {
		const list = [createAssistantPlaceholder("assistant-1")];
		const running = applyResponseActivityEntryToMessageList(
			list,
			"assistant-1",
			{
				id: "deliberation-pass-1",
				kind: "deliberation",
				status: "running",
				label: "Reviewing context and sources",
			},
		);
		const done = applyResponseActivityEntryToMessageList(
			running,
			"assistant-1",
			{
				id: "deliberation-pass-1",
				kind: "deliberation",
				status: "done",
				label: "Reviewed context and sources",
			},
		);

		expect(done[0].thinkingSegments).toEqual([
			{
				type: "status",
				id: "deliberation-pass-1",
				label: "Reviewed context and sources",
				status: "done",
			},
		]);
		expect(done[0].responseActivity).toEqual([
			expect.objectContaining({
				id: "deliberation-pass-1",
				kind: "deliberation",
				status: "done",
			}),
		]);
	});

	it("projects existing tool-call events into live tool and source activity rows", () => {
		const list = [createAssistantPlaceholder("assistant-1")];
		const running = applyToolCallUpdateToMessageList(list, {
			placeholderId: "assistant-1",
			name: "research_web",
			input: { query: "SvelteKit streaming docs" },
			status: "running",
			details: { callId: "tool-call-1", sourceType: "web" },
		});
		const done = applyToolCallUpdateToMessageList(running, {
			placeholderId: "assistant-1",
			name: "research_web",
			input: {},
			status: "done",
			details: {
				callId: "tool-call-1",
				sourceType: "web",
				outputSummary: "Found 3 sources",
				candidates: [
					{
						id: "source-1",
						title: "SvelteKit docs",
						url: "https://svelte.dev/docs/kit",
						sourceType: "web",
					},
					{
						id: "source-2",
						title: "Svelte docs",
						url: "https://svelte.dev/docs/svelte",
						sourceType: "web",
					},
					{
						id: "source-3",
						title: "Vitest docs",
						url: "https://vitest.dev",
						sourceType: "web",
					},
				],
			},
		});

		expect(done[0].responseActivity).toEqual([
			expect.objectContaining({
				id: "tool:tool-call-1",
				kind: "tool",
				status: "done",
				toolName: "research_web",
				sourceType: "web",
				detail: "Found 3 sources",
			}),
			expect.objectContaining({
				id: "source:tool-call-1:source-1",
				kind: "source",
				status: "done",
				title: "SvelteKit docs",
				url: "https://svelte.dev/docs/kit",
			}),
			expect.objectContaining({
				id: "source:tool-call-1:source-2",
				kind: "source",
				status: "done",
				title: "Svelte docs",
				url: "https://svelte.dev/docs/svelte",
			}),
			expect.objectContaining({
				id: "source:tool-call-1:source-3",
				kind: "source",
				status: "done",
				title: "Vitest docs",
				url: "https://vitest.dev",
			}),
		]);
	});

	it("keeps non-file tool calls visible in thinking segments", () => {
		const list = [createAssistantPlaceholder("assistant-1")];
		const updated = applyToolCallUpdateToMessageList(list, {
			placeholderId: "assistant-1",
			name: "web_search",
			input: { query: "Svelte docs" },
			status: "running",
		});

		expect(updated[0].thinkingSegments).toEqual([
			{
				type: "tool_call",
				name: "web_search",
				input: { query: "Svelte docs" },
				status: "running",
			},
		]);
	});

	it("coalesces duplicate running tool-call updates with the same call id", () => {
		const list = [createAssistantPlaceholder("assistant-1")];
		const firstRunning = applyToolCallUpdateToMessageList(list, {
			placeholderId: "assistant-1",
			name: "research_web",
			input: { query: "SvelteKit streaming docs" },
			status: "running",
			details: { callId: "tool-call-1" },
		});
		const duplicateRunning = applyToolCallUpdateToMessageList(firstRunning, {
			placeholderId: "assistant-1",
			name: "research_web",
			input: { query: "SvelteKit streaming docs" },
			status: "running",
			details: { callId: "tool-call-1" },
		});
		const done = applyToolCallUpdateToMessageList(duplicateRunning, {
			placeholderId: "assistant-1",
			name: "research_web",
			input: {},
			status: "done",
			details: {
				callId: "tool-call-1",
				sourceType: "web",
				outputSummary: "Found sources",
			},
		});

		expect(done[0].thinkingSegments).toEqual([
			expect.objectContaining({
				callId: "tool-call-1",
				type: "tool_call",
				name: "research_web",
				status: "done",
				outputSummary: "Found sources",
			}),
		]);
	});

	it("closes stale running tool rows when the stream finalizes", () => {
		const list = [createAssistantPlaceholder("assistant-1")];
		const running = applyToolCallUpdateToMessageList(list, {
			placeholderId: "assistant-1",
			name: "research_web",
			input: { query: "SvelteKit streaming docs" },
			status: "running",
		});

		const finalized = finalizeStreamingMessageList(running, {
			placeholderId: "assistant-1",
			clientUserMessageId: null,
			metadata: { assistantMessageId: "server-assistant-1" },
		});

		expect(finalized[0].thinkingSegments).toEqual([
			expect.objectContaining({
				type: "tool_call",
				name: "research_web",
				status: "done",
			}),
		]);
	});

	it("clears live response activity when the streaming placeholder finalizes", () => {
		const list = applyResponseActivityEntryToMessageList(
			[createAssistantPlaceholder("assistant-1")],
			"assistant-1",
			{
				id: "drafting",
				kind: "drafting",
				status: "running",
			},
		);

		const finalized = finalizeStreamingMessageList(list, {
			placeholderId: "assistant-1",
			clientUserMessageId: null,
			metadata: { assistantMessageId: "server-assistant-1" },
		});

		expect(finalized[0].responseActivity).toBeUndefined();
	});

	it("copies streamed Depth Metadata onto the finalized assistant message", () => {
		const list = [createAssistantPlaceholder("assistant-placeholder")];

		const finalized = finalizeStreamingMessageList(list, {
			placeholderId: "assistant-placeholder",
			clientUserMessageId: null,
			metadata: {
				assistantMessageId: "server-assistant-1",
				depthMetadata: {
					requested: "max",
					appliedProfile: "maximum",
					fallback: false,
					modelId: "model1",
					modelDisplayName: "Model 1",
				},
			},
		});

		expect(finalized[0]).toMatchObject({
			id: "server-assistant-1",
			depthMetadata: {
				requested: "max",
				appliedProfile: "maximum",
				fallback: false,
				modelId: "model1",
				modelDisplayName: "Model 1",
			},
		});
	});

	it("keeps newly produced files attached when the streaming placeholder becomes the server assistant message", () => {
		const jobs = [
			makeUnassignedJob("job-new"),
			makeUnassignedJob("job-other-conversation", { conversationId: "conv-2" }),
			makeJob("job-existing", "succeeded"),
		];

		const attached = attachUnassignedFileProductionJobsToAssistant(jobs, {
			conversationId: "conv-1",
			assistantMessageId: "assistant-server",
		});

		expect(attached).toEqual([
			expect.objectContaining({
				id: "job-new",
				assistantMessageId: "assistant-server",
			}),
			expect.objectContaining({
				id: "job-other-conversation",
				assistantMessageId: null,
			}),
			expect.objectContaining({
				id: "job-existing",
				assistantMessageId: "assistant-1",
			}),
		]);
	});
});

describe("Deep Research chat helpers", () => {
	it("detects research jobs that still need chat card refreshes", () => {
		expect(
			hasActiveDeepResearchJobs([makeDeepResearchJob("awaiting_plan")]),
		).toBe(true);
		expect(
			hasActiveDeepResearchJobs([makeDeepResearchJob("awaiting_approval")]),
		).toBe(true);
		expect(hasActiveDeepResearchJobs([makeDeepResearchJob("approved")])).toBe(
			true,
		);
		expect(hasActiveDeepResearchJobs([makeDeepResearchJob("running")])).toBe(
			true,
		);
		expect(
			hasActiveDeepResearchJobs([
				makeDeepResearchJob("completed"),
				makeDeepResearchJob("failed"),
				makeDeepResearchJob("cancelled"),
			]),
		).toBe(false);
	});
});
