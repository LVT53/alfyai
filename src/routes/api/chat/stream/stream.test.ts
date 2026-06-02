import { beforeEach, describe, expect, it, vi } from "vitest";

const configMockState = vi.hoisted(() => ({
	composerCommandRegistryEnabled: true,
}));

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(() => ({
		concurrentStreamLimit: 100,
		perUserStreamLimit: 10,
		requestTimeoutMs: 60_000,
		modelTimeoutFailoverEnabled: false,
		modelTimeoutFailoverTargetModel: null,
		modelTimeoutFailoverTimeoutMs: 1_000,
		composerCommandRegistryEnabled:
			configMockState.composerCommandRegistryEnabled,
		model1: {
			displayName: "Model 1",
		},
		model2: {
			displayName: "Model 2",
		},
	})),
	getProviderById: vi.fn(async () => null),
	normalizeModelSelection: vi.fn((model: string) => model),
	getMaxMessageLength: vi.fn(() => 10000),
}));

vi.mock("$lib/server/services/conversations", () => ({
	getConversation: vi.fn(),
	touchConversation: vi.fn(),
}));

vi.mock("$lib/server/services/normal-chat-failover", () => ({
	isModelTimeoutError: vi.fn(() => false),
	resolveModelTimeoutFailoverTargetModelId: vi.fn(async () => null),
}));

vi.mock(
	"$lib/server/services/chat-turn/streaming-normal-chat-model-run",
	() => ({
		runStreamingNormalChatSendModel: vi.fn(),
	}),
);

vi.mock("$lib/server/services/chat-turn/plain-normal-chat-model-run", () => ({
	runPlainNormalChatSendModel: vi.fn(),
}));

vi.mock("$lib/server/services/messages", () => ({
	createMessage: vi.fn(),
	updateMessageEvidence: vi.fn(async () => undefined),
	updateMessageHonchoMetadata: vi.fn(async () => undefined),
}));

vi.mock("$lib/server/services/knowledge", () => ({
	assertPromptReadyAttachments: vi.fn(async () => ({
		displayArtifacts: [],
		promptArtifacts: [],
	})),
	attachArtifactsToMessage: vi.fn(),
	createGeneratedOutputArtifact: vi.fn(),
	getConversationWorkingSet: vi.fn(async () => []),
	getArtifactsForUser: vi.fn(async () => []),
	isAttachmentReadinessError: vi.fn((error: unknown) => {
		return (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error as { code?: unknown }).code === "attachment_not_ready"
		);
	}),
	listConversationSourceArtifactIds: vi.fn(async () => []),
	refreshConversationWorkingSet: vi.fn(async () => []),
	upsertWorkCapsule: vi.fn(async () => null),
}));

vi.mock("$lib/server/services/linked-context-sources", () => ({
	addConversationLinkedContextSources: vi.fn(async () => []),
	isLinkedContextSourceError: vi.fn(() => false),
}));

vi.mock("$lib/server/services/skills/user-skills", () => ({
	getAvailableSkillDefinition: vi.fn(async () => ({
		id: "skill-1",
		ownership: "user",
		displayName: "Interview coach",
		description: "Asks useful questions.",
		instructions: "Ask one concise follow-up before answering.",
		activationExamples: ["interview me first"],
		enabled: true,
		durationPolicy: "next_message",
		questionPolicy: "ask_when_needed",
		notesPolicy: "none",
		sourceScope: "selected_sources_only",
		creationSource: "user_created",
		version: 1,
		createdAt: 1,
		updatedAt: 2,
	})),
	getAvailableSkillSummary: vi.fn(async () => ({
		id: "skill-1",
		ownership: "user",
		displayName: "Interview coach",
	})),
	resolveEffectiveSkillDefinition: vi.fn(async () => ({
		available: true,
		availabilityReason: "available",
		id: "skill-1",
		ownership: "user",
		skillKind: "user_skill",
		displayName: "Interview coach",
		description: "Asks useful questions.",
		effectiveInstructions: "Ask one concise follow-up before answering.",
		effectiveInstructionsHash: "test-hash",
		publicSummary: {
			id: "skill-1",
			ownership: "user",
			skillKind: "user_skill",
			baseSkillId: null,
			baseSkillVersion: null,
			displayName: "Interview coach",
			description: "Asks useful questions.",
			activationExamples: ["interview me first"],
			enabled: true,
			durationPolicy: "next_message",
			questionPolicy: "ask_when_needed",
			notesPolicy: "none",
			sourceScope: "selected_sources_only",
			creationSource: "user_created",
			version: 1,
			createdAt: 1,
			updatedAt: 2,
		},
		durationPolicy: "next_message",
		questionPolicy: "ask_when_needed",
		notesPolicy: "none",
		sourceScope: "selected_sources_only",
		sourceIds: {
			skillId: "skill-1",
			skillVersion: 1,
			packSkillId: null,
			packSkillVersion: null,
			variantSkillId: null,
			variantSkillVersion: null,
		},
	})),
}));

vi.mock("$lib/server/services/skills/sessions", () => ({
	applySkillControlOperations: vi.fn(async () => null),
	getActiveSkillSession: vi.fn(async () => null),
	startSkillSession: vi.fn(async () => null),
}));

vi.mock("$lib/server/services/task-state", () => ({
	attachContinuityToTaskState: vi.fn(
		async (_userId: string, taskState: unknown) => taskState,
	),
	getContextDebugState: vi.fn(async () => null),
	getConversationTaskState: vi.fn(async () => null),
	getProjectReferenceContext: vi.fn(async () => null),
	syncTaskContinuityFromTaskState: vi.fn(async () => null),
	updateTaskStateCheckpoint: vi.fn(async () => null),
}));

vi.mock("$lib/server/services/honcho", () => ({
	listPersonaMemories: vi.fn(async () => []),
	mirrorMessage: vi.fn(async () => undefined),
	mirrorWorkCapsuleConclusion: vi.fn(async () => undefined),
}));

vi.mock("$lib/server/services/chat-files", () => ({
	getChatFilesForAssistantMessage: vi.fn(async () => []),
	syncGeneratedFilesToMemory: vi.fn(async () => undefined),
}));

vi.mock("$lib/server/services/file-production", () => ({
	assignFileProductionJobsToAssistantMessage: vi.fn(async () => undefined),
	listConversationFileProductionJobs: vi.fn(async () => []),
}));

vi.mock("$lib/server/env", () => ({
	getDatabasePath: () => "./data/test.db",
	config: {
		maxMessageLength: 10000,
		model1MaxMessageLength: 10000,
		model2MaxMessageLength: 10000,
		contextSummarizerUrl: "",
		contextSummarizerApiKey: "",
		contextSummarizerModel: "",
		model1: {
			displayName: "Model 1",
		},
		model2: {
			displayName: "Model 2",
		},
	},
}));

import { requireAuth } from "$lib/server/auth/hooks";
import {
	getChatFilesForAssistantMessage,
	syncGeneratedFilesToMemory,
} from "$lib/server/services/chat-files";
import { runPlainNormalChatSendModel } from "$lib/server/services/chat-turn/plain-normal-chat-model-run";
import { runStreamingNormalChatSendModel } from "$lib/server/services/chat-turn/streaming-normal-chat-model-run";
import {
	getConversation,
	touchConversation,
} from "$lib/server/services/conversations";
import {
	assignFileProductionJobsToAssistantMessage,
	listConversationFileProductionJobs,
} from "$lib/server/services/file-production";
import { assertPromptReadyAttachments } from "$lib/server/services/knowledge";
import { addConversationLinkedContextSources } from "$lib/server/services/linked-context-sources";
import {
	createMessage,
	updateMessageHonchoMetadata,
} from "$lib/server/services/messages";
import { applySkillControlOperations } from "$lib/server/services/skills/sessions";
import { getConversationTaskState } from "$lib/server/services/task-state";
import { POST } from "./+server";
import { POST as stopStream } from "./stop/+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockGetConversation = getConversation as ReturnType<typeof vi.fn>;
const mockTouchConversation = touchConversation as ReturnType<typeof vi.fn>;
const mockSendMessageStream = runStreamingNormalChatSendModel as ReturnType<
	typeof vi.fn
>;
const mockSendMessage = runPlainNormalChatSendModel as ReturnType<typeof vi.fn>;
const mockCreateMessage = createMessage as ReturnType<typeof vi.fn>;
const mockUpdateMessageHonchoMetadata =
	updateMessageHonchoMetadata as ReturnType<typeof vi.fn>;
const mockAssertPromptReadyAttachments =
	assertPromptReadyAttachments as ReturnType<typeof vi.fn>;
const mockAddConversationLinkedContextSources =
	addConversationLinkedContextSources as ReturnType<typeof vi.fn>;
const mockGetConversationTaskState = getConversationTaskState as ReturnType<
	typeof vi.fn
>;
const mockApplySkillControlOperations =
	applySkillControlOperations as ReturnType<typeof vi.fn>;
const mockGetChatFilesForAssistantMessage =
	getChatFilesForAssistantMessage as ReturnType<typeof vi.fn>;
const mockSyncGeneratedFilesToMemory = syncGeneratedFilesToMemory as ReturnType<
	typeof vi.fn
>;
const mockAssignFileProductionJobsToAssistantMessage =
	assignFileProductionJobsToAssistantMessage as ReturnType<typeof vi.fn>;
const mockListConversationFileProductionJobs =
	listConversationFileProductionJobs as ReturnType<typeof vi.fn>;
type StreamPostEvent = Parameters<typeof POST>[0];
type StopStreamPostEvent = Parameters<typeof stopStream>[0];

function makeEvent(
	body: unknown,
	user = { id: "user-1", email: "test@example.com" },
	signal?: AbortSignal,
): StreamPostEvent {
	return {
		request: new Request("http://localhost/api/chat/stream", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal,
		}),
		locals: {
			user,
		},
		params: {},
		url: new URL("http://localhost/api/chat/stream"),
		route: { id: "/api/chat/stream" },
	} as StreamPostEvent;
}

function makeStopEvent(body: unknown, userId = "user-1"): StopStreamPostEvent {
	return {
		request: new Request("http://localhost/api/chat/stream/stop", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: {
			user: {
				id: userId,
				email: "test@example.com",
			},
		},
		params: {},
		url: new URL("http://localhost/api/chat/stream/stop"),
		route: { id: "/api/chat/stream/stop" },
	} as StopStreamPostEvent;
}

type NeutralStreamEvent =
	| { type: "text_delta"; text: string }
	| { type: "reasoning_delta"; text: string }
	| { type: "tool_call"; callId: string; toolName: string; input: unknown }
	| { type: "tool_result"; callId: string; toolName: string; output: unknown }
	| { type: "tool_error"; callId: string; toolName: string; error: string }
	| {
			type: "usage";
			usage: {
				inputTokens?: number;
				outputTokens?: number;
				totalTokens?: number;
			};
	  }
	| {
			type: "finish";
			finishReason: string;
			rawFinishReason: string | undefined;
			model: {
				providerId: string;
				providerName: string;
				displayName: string;
				requestedModelName: string;
				responseModelName: string;
			};
	  }
	| { type: "error"; error: string };

const finishEvent: NeutralStreamEvent = {
	type: "finish",
	finishReason: "stop",
	rawFinishReason: "stop",
	model: {
		providerId: "model1",
		providerName: "Model 1",
		displayName: "Model 1",
		requestedModelName: "model1",
		responseModelName: "model1",
	},
};

function buildNeutralStream(
	events: AsyncIterable<NeutralStreamEvent> | NeutralStreamEvent[],
	overrides: Record<string, unknown> = {},
) {
	const prefetchedToolCalls =
		(overrides.prefetchedToolCalls as unknown[] | undefined) ?? [];
	const normalChatToolCalls =
		(overrides.normalChatToolCalls as unknown[] | undefined) ?? [];
	const stream =
		Symbol.asyncIterator in events
			? events
			: (async function* () {
					for (const event of events) {
						yield event;
					}
				})();
	return {
		prepared: {
			contextStatus: undefined,
			taskState: null,
			contextDebug: null,
			honchoContext: null,
			honchoSnapshot: null,
			contextTraceSections: undefined,
			...((overrides.prepared as Record<string, unknown> | undefined) ?? {}),
		},
		modelId: "model1",
		modelDisplayName: "Model 1",
		stream,
		prefetchedToolCalls,
		getNormalChatToolCalls: () => normalChatToolCalls,
		getToolCalls: () => [...prefetchedToolCalls, ...normalChatToolCalls],
		...overrides,
	};
}

function buildTextStream(
	chunks: string | string[],
	overrides: Record<string, unknown> = {},
) {
	const textChunks = Array.isArray(chunks) ? chunks : [chunks];
	return buildNeutralStream(
		[
			...textChunks.map(
				(text): NeutralStreamEvent => ({ type: "text_delta", text }),
			),
			finishEvent,
		],
		overrides,
	);
}

function buildErrorStream(
	error: string,
	overrides: Record<string, unknown> = {},
) {
	return buildNeutralStream([{ type: "error", error }], overrides);
}

function buildToolResultStream(params: {
	callId: string;
	name: string;
	input: Record<string, unknown>;
	outputSummary?: string;
	text?: string;
}) {
	const recorderEntry = {
		callId: params.callId,
		name: params.name,
		input: params.input,
		status: "done",
		outputSummary: params.outputSummary ?? null,
		sourceType: "tool",
		candidates: [],
		metadata: { ok: true, evidenceReady: true },
	};
	return buildNeutralStream(
		[
			{
				type: "tool_call",
				callId: params.callId,
				toolName: params.name,
				input: params.input,
			},
			{
				type: "tool_result",
				callId: params.callId,
				toolName: params.name,
				output: { ok: true },
			},
			...(params.text
				? ([{ type: "text_delta", text: params.text }] as NeutralStreamEvent[])
				: []),
			finishEvent,
		],
		{ normalChatToolCalls: [recorderEntry] },
	);
}

function buildControlledNeutralStream() {
	const queue: NeutralStreamEvent[] = [];
	let notify: (() => void) | null = null;
	let closed = false;
	const stream = (async function* () {
		while (!closed || queue.length > 0) {
			const event = queue.shift();
			if (event) {
				yield event;
				continue;
			}
			await new Promise<void>((resolve) => {
				notify = resolve;
			});
		}
	})();
	const enqueueToken = (text: string) => {
		queue.push({ type: "text_delta", text });
		notify?.();
	};
	const finish = () => {
		queue.push(finishEvent);
		closed = true;
		notify?.();
	};
	return {
		...buildNeutralStream(stream),
		enqueueToken,
		finish,
	};
}

async function readSseResponse(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) {
		throw new Error("Missing response body");
	}
	const chunks: Uint8Array[] = [];
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) chunks.push(value);
	}
	const decoder = new TextDecoder();
	return chunks.map((c) => decoder.decode(c)).join("");
}

function parseUiStreamParts(
	body: string,
): Array<Record<string, unknown> | "[DONE]"> {
	return body.split(/\r?\n\r?\n/).flatMap((block) => {
		const dataLines = block
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data: "))
			.map((line) => line.slice("data: ".length));
		if (dataLines.length === 0) return [];
		const data = dataLines.join("\n");
		return data === "[DONE]"
			? ["[DONE]" as const]
			: [JSON.parse(data) as Record<string, unknown>];
	});
}

describe("POST /api/chat/stream", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		configMockState.composerCommandRegistryEnabled = true;
		vi.spyOn(console, "info").mockImplementation(() => undefined);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		mockRequireAuth.mockReturnValue(undefined);
		mockTouchConversation.mockImplementation(async () => null);
		mockCreateMessage.mockImplementation(async () => ({
			id: crypto.randomUUID(),
			role: "assistant",
			content: "",
			timestamp: Date.now(),
		}));
		mockAssertPromptReadyAttachments.mockResolvedValue({
			displayArtifacts: [],
			promptArtifacts: [],
		});
		mockAddConversationLinkedContextSources.mockResolvedValue([]);
		mockSendMessage.mockReset();
		mockGetChatFilesForAssistantMessage.mockResolvedValue([]);
		mockSyncGeneratedFilesToMemory.mockResolvedValue(undefined);
		mockAssignFileProductionJobsToAssistantMessage.mockResolvedValue(undefined);
		mockListConversationFileProductionJobs.mockResolvedValue([]);
	});

	it("returns text/event-stream content-type for valid request", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockResolvedValue(buildTextStream("Hello"));

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("text/event-stream");
		expect(response.headers.get("X-Vercel-AI-UI-Message-Stream")).toBe("v1");
	});

	it("exposes route phase timings in Server-Timing without adding SSE events", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockResolvedValue(buildTextStream("Hello"));

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);
		const parts = parseUiStreamParts(body);

		expect(response.headers.get("Server-Timing")).toEqual(
			expect.stringContaining("route_parse;dur="),
		);
		expect(response.headers.get("Server-Timing")).toEqual(
			expect.stringContaining("preflight;dur="),
		);
		const eventNames = Array.from(body.matchAll(/^event: ([^\n\r]+)/gm)).map(
			(match) => match[1],
		);
		expect(new Set(eventNames)).toEqual(new Set());
		expect(
			parts.map((part) => (part === "[DONE]" ? "[DONE]" : part.type)),
		).toEqual([
			"text-start",
			"text-delta",
			"text-end",
			"data-stream-metadata",
			"finish",
			"[DONE]",
		]);
		expect(parts[1]).toEqual({
			type: "text-delta",
			id: "answer",
			delta: "Hello",
		});
		expect(parts[3]).toEqual(
			expect.objectContaining({
				type: "data-stream-metadata",
				transient: true,
				data: expect.objectContaining({
					responseTokenCount: 2,
					modelDisplayName: "Model 1",
				}),
			}),
		);
	});

	it("starts SSE responses with an ignored prelude comment to flush browser-facing proxies", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockResolvedValue(buildTextStream("Hello"));

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body.startsWith(":")).toBe(true);
		expect(body).toContain('"type":"text-delta"');
		expect(body).toContain('"type":"data-stream-metadata"');
	});

	it("returns 422 before streaming when a same-turn attachment is not prompt-ready", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockAssertPromptReadyAttachments.mockRejectedValue({
			name: "AttachmentReadinessError",
			message: "Attached file is not ready for chat.",
			code: "attachment_not_ready",
			status: 422,
			attachmentIds: ["artifact-1"],
		});

		const event = makeEvent({
			message: "Use this file",
			conversationId: "conv-1",
			attachmentIds: ["artifact-1"],
		});
		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(422);
		expect(data.code).toBe("attachment_not_ready");
		expect(mockSendMessageStream).not.toHaveBeenCalled();
	});

	it("emits an error event when prompt construction fails closed after preflight", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockRejectedValue({
			name: "AttachmentReadinessError",
			message:
				"Attached file content was missing from the final prompt bundle.",
			code: "attachment_not_ready",
			status: 422,
			attachmentIds: ["artifact-1"],
		});

		const event = makeEvent({
			message: "Use this file",
			conversationId: "conv-1",
			attachmentIds: ["artifact-1"],
		});
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("text/event-stream");
		expect(body).toContain('"type":"data-stream-error"');
		expect(body).toContain('"code":"backend_failure"');
	});

	it("stream contains UI text deltas with text chunks", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockCreateMessage
			.mockResolvedValueOnce({
				id: "user-msg",
				role: "user",
				content: "Hi",
				timestamp: Date.now(),
			})
			.mockResolvedValueOnce({
				id: "assistant-msg",
				role: "assistant",
				content: "Hello world",
				timestamp: Date.now(),
			});
		mockSendMessageStream.mockResolvedValue(
			buildTextStream(["Hello", " world"], {
				prepared: {
					honchoContext: {
						source: "live",
						waitedMs: 40,
						queuePendingWorkUnits: 0,
						queueInProgressWorkUnits: 0,
						fallbackReason: null,
						snapshotCreatedAt: 999,
					},
					honchoSnapshot: {
						createdAt: 999,
						summary: "Stream Honcho summary",
						messages: [
							{
								role: "assistant",
								content: "Hello world",
								createdAt: Date.now(),
							},
						],
					},
				},
			}),
		);

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain('"type":"text-delta"');
		expect(body).toContain('"delta":"Hello"');
		expect(body).toContain('"delta":" world"');
		expect(mockUpdateMessageHonchoMetadata).toHaveBeenCalledWith(
			"assistant-msg",
			{
				honchoContext: expect.objectContaining({ source: "live" }),
				honchoSnapshot: expect.objectContaining({
					summary: "Stream Honcho summary",
				}),
			},
		);
	});

	it("strips Skill Control Envelopes from stream tokens and applies captured operations", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockCreateMessage
			.mockResolvedValueOnce({
				id: "user-msg",
				role: "user",
				content: "Coach me",
				timestamp: Date.now(),
			})
			.mockResolvedValueOnce({
				id: "assistant-msg",
				role: "assistant",
				content: "What deadline should I use?",
				timestamp: Date.now(),
			});
		mockSendMessageStream.mockResolvedValue(
			buildTextStream([
				"What deadline should I use?\n<skill_control",
				`_v1>${JSON.stringify({
					version: 1,
					operations: [
						{
							operationId: "stream-question",
							kind: "session_transition",
							transition: "awaiting_user",
						},
					],
				})}</skill_control_v1>`,
			]),
		);

		const response = await POST(
			makeEvent({ message: "Coach me", conversationId: "conv-1" }),
		);
		const body = await readSseResponse(response);

		expect(body).toContain('"delta":"What deadline should I use?\\n"');
		expect(body).not.toContain("skill_control_v1");
		expect(mockCreateMessage).toHaveBeenCalledWith(
			"conv-1",
			"assistant",
			"What deadline should I use?\n",
			undefined,
			undefined,
			expect.objectContaining({
				evidenceStatus: "pending",
				skillQuestion: true,
			}),
		);
		expect(mockApplySkillControlOperations).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-msg",
			operations: [
				{
					operationId: "stream-question",
					kind: "session_transition",
					transition: "awaiting_user",
				},
			],
		});
	});

	it("forwards the active workspace document id into Normal Chat streaming calls", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockCreateMessage
			.mockResolvedValueOnce({
				id: "user-msg",
				role: "user",
				content: "Refine it",
				timestamp: Date.now(),
			})
			.mockResolvedValueOnce({
				id: "assistant-msg",
				role: "assistant",
				content: "Refined",
				timestamp: Date.now(),
			});
		mockSendMessageStream.mockResolvedValue(buildTextStream("Refined"));

		const event = makeEvent({
			message: "Refine it",
			conversationId: "conv-1",
			activeDocumentArtifactId: "artifact-focused-1",
			thinkingMode: "off",
		});
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(response.status).toBe(200);
		expect(body).toContain('"delta":"Refined"');
		expect(mockSendMessageStream).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Refine it",
				conversationId: "conv-1",
				modelId: "model1",
				activeDocumentArtifactId: "artifact-focused-1",
				thinkingMode: "off",
				user: {
					id: "user-1",
					displayName: undefined,
					email: "test@example.com",
				},
			}),
		);
	});

	it("passes a forced web-search turn flag into Normal Chat streaming options", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockCreateMessage
			.mockResolvedValueOnce({
				id: "user-msg",
				role: "user",
				content: "What changed today?",
				timestamp: Date.now(),
			})
			.mockResolvedValueOnce({
				id: "assistant-msg",
				role: "assistant",
				content: "Grounded",
				timestamp: Date.now(),
			});
		mockSendMessageStream.mockResolvedValue(buildTextStream("Grounded"));

		const event = makeEvent({
			message: "What changed today?",
			conversationId: "conv-1",
			forceWebSearch: true,
		});
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(response.status).toBe(200);
		expect(body).toContain('"delta":"Grounded"');
		expect(mockSendMessageStream).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "What changed today?",
				conversationId: "conv-1",
				modelId: "model1",
				forceWebSearch: true,
			}),
		);
	});

	it("passes pending Skill instructions as a system appendix without changing the streamed user transcript", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockCreateMessage
			.mockResolvedValueOnce({
				id: "user-msg",
				role: "user",
				content: "Draft the plan",
				timestamp: Date.now(),
			})
			.mockResolvedValueOnce({
				id: "assistant-msg",
				role: "assistant",
				content: "Question first.",
				timestamp: Date.now(),
			});
		mockSendMessageStream.mockResolvedValue(buildTextStream("Question first."));
		const linkedSources = [
			{
				displayArtifactId: "display-1",
				promptArtifactId: "prompt-1",
				familyArtifactIds: ["display-1", "prompt-1"],
				name: "Discovery notes.pdf",
				type: "document" as const,
			},
		];
		mockAddConversationLinkedContextSources.mockResolvedValueOnce(
			linkedSources,
		);

		const event = makeEvent({
			message: "  Draft the plan  ",
			conversationId: "conv-1",
			pendingSkill: {
				id: "skill-1",
				ownership: "user",
				displayName: "Interview coach",
			},
			linkedSources,
		});
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(response.status).toBe(200);
		expect(body).toContain("Question first.");
		expect(mockSendMessageStream).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Draft the plan",
				conversationId: "conv-1",
				modelId: "model1",
				systemPromptAppendix: expect.stringContaining(
					"Ask one concise follow-up before answering.",
				),
			}),
		);
		const options = mockSendMessageStream.mock.calls.at(-1)?.[0];
		expect(options.systemPromptAppendix).toContain("Discovery notes.pdf");
		expect(options.systemPromptAppendix).toContain(
			"displayArtifactId: display-1",
		);
		expect(options.systemPromptAppendix).not.toContain("  Draft the plan  ");
		expect(mockCreateMessage).toHaveBeenCalledWith(
			"conv-1",
			"user",
			"Draft the plan",
		);
	});

	it("rejects pending Skill payloads when Composer Command Registry is disabled", async () => {
		configMockState.composerCommandRegistryEnabled = false;
		mockGetConversation.mockResolvedValue({
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		});

		const response = await POST(
			makeEvent({
				message: "Use this skill",
				conversationId: "conv-1",
				pendingSkill: {
					id: "skill-1",
					ownership: "user",
					displayName: "Interview coach",
				},
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(403);
		expect(data).toMatchObject({
			error: "Composer Command Registry is disabled.",
			code: "composer_commands_disabled",
		});
		expect(mockSendMessageStream).not.toHaveBeenCalled();
	});

	it("streams Skill Control Envelopes as plain output when Composer Command Registry is disabled", async () => {
		configMockState.composerCommandRegistryEnabled = false;
		mockGetConversation.mockResolvedValue({
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		});
		mockCreateMessage
			.mockResolvedValueOnce({
				id: "user-msg",
				role: "user",
				content: "Hello",
				timestamp: Date.now(),
			})
			.mockResolvedValueOnce({
				id: "assistant-msg",
				role: "assistant",
				content: "Visible answer.",
				timestamp: Date.now(),
			});
		mockSendMessageStream.mockResolvedValue(
			buildTextStream([
				"Visible answer.\n<skill_control",
				[
					"_v1>",
					JSON.stringify({
						version: 1,
						operations: [
							{
								operationId: "ask-deadline",
								kind: "session_transition",
								transition: "awaiting_user",
							},
						],
					}),
					"</skill_control_v1>",
				].join("\n"),
			]),
		);

		const response = await POST(
			makeEvent({ message: "Hello", conversationId: "conv-1" }),
		);
		const body = await readSseResponse(response);

		expect(response.status).toBe(200);
		expect(body).toContain("skill_control_v1");
		expect(mockCreateMessage).toHaveBeenCalledWith(
			"conv-1",
			"assistant",
			expect.stringContaining("<skill_control_v1>"),
			undefined,
			undefined,
			expect.not.objectContaining({
				skillControl: expect.anything(),
				skillQuestion: expect.anything(),
			}),
		);
		expect(mockApplySkillControlOperations).not.toHaveBeenCalled();
	});

	it("continues processing upstream after the client disconnects during metadata loading", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);

		let taskStateRequested = false;
		let resolveTaskState!: (value: null) => void;
		const taskStateGate = new Promise<null>((resolve) => {
			resolveTaskState = resolve;
		});
		mockGetConversationTaskState.mockImplementationOnce(async () => {
			taskStateRequested = true;
			return taskStateGate;
		});

		mockSendMessageStream.mockResolvedValue(buildTextStream("Hello"));

		const abortController = new AbortController();
		const event = makeEvent(
			{ message: "Hi", conversationId: "conv-1" },
			undefined,
			abortController.signal,
		);
		const response = await POST(event);

		while (!taskStateRequested) {
			await Promise.resolve();
		}

		abortController.abort();
		resolveTaskState(null);

		const body = await readSseResponse(response);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(body.startsWith(":")).toBe(true);
		expect(mockCreateMessage).toHaveBeenNthCalledWith(
			1,
			"conv-1",
			"user",
			"Hi",
		);
		expect(mockCreateMessage).toHaveBeenNthCalledWith(
			2,
			"conv-1",
			"assistant",
			"Hello",
			undefined,
			undefined,
			{ evidenceStatus: "pending", modelDisplayName: "Model 1" },
		);
		expect(mockTouchConversation).toHaveBeenCalledWith("user-1", "conv-1");
	});

	it("continues processing upstream after the response body is cancelled mid-generation", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);

		const upstream = buildControlledNeutralStream();
		mockSendMessageStream.mockResolvedValue(upstream);

		const event = makeEvent({
			message: "Hi",
			conversationId: "conv-1",
			streamId: "stream-cancelled-client",
		});
		const response = await POST(event);
		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error("Missing response body");
		}

		await reader.read();
		await reader.cancel();

		upstream.enqueueToken("Still running");
		upstream.finish();

		await vi.waitFor(() => {
			expect(mockCreateMessage).toHaveBeenNthCalledWith(
				2,
				"conv-1",
				"assistant",
				"Still running",
				undefined,
				undefined,
				{ evidenceStatus: "pending", modelDisplayName: "Model 1" },
			);
		});
		expect(mockTouchConversation).toHaveBeenCalledWith("user-1", "conv-1");
	});

	it("aborts the upstream body when the user explicitly stops after stream headers", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);

		let upstreamAbortSignal: AbortSignal | undefined;
		let markStreamListening!: () => void;
		const streamListening = new Promise<void>((resolve) => {
			markStreamListening = resolve;
		});
		mockSendMessageStream.mockImplementationOnce(
			async (params: { signal?: AbortSignal }) => {
				upstreamAbortSignal = params.signal;
				return buildNeutralStream(
					(async function* () {
						await new Promise((_resolve, reject) => {
							markStreamListening();
							params.signal?.addEventListener(
								"abort",
								() => {
									const error = new Error("upstream stream aborted");
									error.name = "AbortError";
									reject(error);
								},
								{ once: true },
							);
						});
					})(),
				);
			},
		);

		const response = await POST(
			makeEvent({
				message: "Hi",
				conversationId: "conv-1",
				streamId: "stream-explicit-stop",
			}),
		);
		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error("Missing response body");
		}

		await expect(reader.read()).resolves.toMatchObject({ done: false });
		await streamListening;

		const stopResponse = await stopStream(
			makeStopEvent({ streamId: "stream-explicit-stop" }),
		);
		const stopPayload = await stopResponse.json();
		const remainingChunks: Uint8Array[] = [];
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) remainingChunks.push(value);
		}
		const remainingBody = remainingChunks
			.map((chunk) => new TextDecoder().decode(chunk))
			.join("");

		expect(stopResponse.status).toBe(200);
		expect(stopPayload.stopped).toBe(true);
		expect(upstreamAbortSignal?.aborted).toBe(true);
		expect(remainingBody).toContain('"type":"data-stream-metadata"');
		expect(remainingBody).toContain('"wasStopped":true');
		expect(mockSendMessage).not.toHaveBeenCalled();
	});

	it("does not wait for generated-file memory sync before ending the stream", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockCreateMessage
			.mockResolvedValueOnce({
				id: "user-msg",
				role: "user",
				content: "Make a file",
				timestamp: Date.now(),
			})
			.mockResolvedValueOnce({
				id: "assistant-msg",
				role: "assistant",
				content: "Done",
				timestamp: Date.now(),
			});
		mockSendMessageStream.mockResolvedValue(
			buildToolResultStream({
				callId: "file-call-1",
				name: "produce_file",
				input: {
					requestTitle: "Report",
					requestedOutputs: [{ type: "txt" }],
					sourceMode: "program",
				},
				text: "Done",
			}),
		);
		mockListConversationFileProductionJobs
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				{
					id: "job-1",
					files: [{ id: "file-1" }],
				},
			]);
		mockGetChatFilesForAssistantMessage.mockResolvedValue([
			{
				id: "file-1",
				conversationId: "conv-1",
				assistantMessageId: "assistant-msg",
				userId: "user-1",
				filename: "report.txt",
				mimeType: "text/plain",
				sizeBytes: 12,
				storagePath: "conv-1/file-1.txt",
				createdAt: Date.now(),
			},
		]);
		mockSyncGeneratedFilesToMemory.mockImplementation(
			() => new Promise(() => undefined),
		);

		const event = makeEvent({
			message: "Make a file",
			conversationId: "conv-1",
		});
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain('"type":"data-stream-metadata"');
		expect(body).toContain('"assistantMessageId":"assistant-msg"');
		expect(body).toContain('"generatedFiles":[{');
		expect(mockAssignFileProductionJobsToAssistantMessage).toHaveBeenCalledWith(
			"user-1",
			"conv-1",
			"assistant-msg",
			["job-1"],
		);
		expect(mockSyncGeneratedFilesToMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: "conv-1",
				assistantMessageId: "assistant-msg",
				fileIds: ["file-1"],
			}),
		);
	});

	it("aggregates native streamed tool call deltas into structured tool_call events", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockResolvedValue(
			buildToolResultStream({
				callId: "call-native-1",
				name: "research_web",
				input: { query: "SvelteKit docs" },
				text: "Tool answer",
			}),
		);

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain('"type":"data-tool-call"');
		expect(body).toContain('"callId":"call-native-1"');
		expect(body).toContain('"name":"research_web"');
		expect(body).toContain('"status":"running"');
		expect(body).toContain('"status":"done"');
		expect(body).toContain('"query":"SvelteKit docs"');
	});

	it("falls back when a non-file tool call completes without final assistant text", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockResolvedValue(
			buildToolResultStream({
				callId: "lc-call-1",
				name: "research_web",
				input: { query: "SvelteKit docs" },
			}),
		);
		mockSendMessage.mockResolvedValue({
			text: "Recovered final answer",
			rawResponse: {
				outputs: [
					{
						outputs: [
							{ results: { message: { text: "Recovered final answer" } } },
						],
					},
				],
			},
			contextStatus: undefined,
			taskState: null,
			contextDebug: null,
		});

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain('"type":"data-tool-call"');
		expect(body).toContain('"callId":"lc-call-1"');
		expect(body).toContain('"status":"done"');
		expect(body).toContain('"type":"text-delta"');
		expect(body).toContain('"delta":"Recovered final answer"');
		expect(body).toContain('"type":"data-stream-metadata"');
		expect(mockSendMessage).toHaveBeenCalled();
	});

	it("allows file-production tool-only streams to complete without fallback", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockResolvedValue(
			buildToolResultStream({
				callId: "file-call-1",
				name: "produce_file",
				input: {
					requestTitle: "Report",
					sourceMode: "program",
					requestedOutputs: [{ type: "pdf" }],
				},
			}),
		);

		const event = makeEvent({
			message: "Make a file",
			conversationId: "conv-1",
		});
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain('"type":"data-tool-call"');
		expect(body).toContain('"callId":"file-call-1"');
		expect(body).toContain('"name":"produce_file"');
		expect(body).toContain('"status":"done"');
		expect(body).toContain('"type":"data-stream-metadata"');
		expect(body).not.toContain('"type":"text-delta"');
		expect(mockSendMessage).not.toHaveBeenCalled();
	});

	it("extracts final native message tool calls into structured tool_call events", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockResolvedValue(
			buildToolResultStream({
				callId: "call-final-1",
				name: "research_web",
				input: { query: "OpenAI tool calls" },
				text: "Tool answer",
			}),
		);

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain('"type":"data-tool-call"');
		expect(body).toContain('"callId":"call-final-1"');
		expect(body).toContain('"name":"research_web"');
		expect(body).toContain('"status":"running"');
		expect(body).toContain('"status":"done"');
		expect(body).toContain('"query":"OpenAI tool calls"');
	});

	it("extracts LangChain tool_calls into structured tool_call events", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockResolvedValue(
			buildToolResultStream({
				callId: "lc-call-1",
				name: "research_web",
				input: { query: "LangChain tool calls" },
				text: "Tool answer",
			}),
		);

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain('"type":"data-tool-call"');
		expect(body).toContain('"callId":"lc-call-1"');
		expect(body).toContain('"name":"research_web"');
		expect(body).toContain('"status":"running"');
		expect(body).toContain('"status":"done"');
		expect(body).toContain('"query":"LangChain tool calls"');
	});

	it("aggregates LangChain tool_call_chunks into structured tool_call events", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockResolvedValue(
			buildToolResultStream({
				callId: "lc-chunk-1",
				name: "research_web",
				input: { query: "LangChain chunks" },
				text: "Tool answer",
			}),
		);

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain('"type":"data-tool-call"');
		expect(body).toContain('"callId":"lc-chunk-1"');
		expect(body).toContain('"name":"research_web"');
		expect(body).toContain('"status":"running"');
		expect(body).toContain('"status":"done"');
		expect(body).toContain('"query":"LangChain chunks"');
	});

	it("forwards neutral reasoning deltas and persists separated thinking", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockResolvedValue(
			buildNeutralStream([
				{ type: "reasoning_delta", text: "Need to break this down." },
				{ type: "text_delta", text: "Final" },
				{ type: "text_delta", text: " answer" },
				finishEvent,
			]),
		);

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain('"type":"reasoning-delta"');
		expect(body).toContain("Need to break this down.");
		expect(body).toContain('"delta":"Final"');
		expect(body).toContain('"delta":" answer"');
		expect(body).toContain('"thinking":"Need to break this down."');
	});

	it("strips a leading response marker from streamed reasoning", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockResolvedValue(
			buildNeutralStream([
				{ type: "reasoning_delta", text: "response " },
				{
					type: "reasoning_delta",
					text: "The user wants me to answer directly.",
				},
				{ type: "text_delta", text: "Final" },
				{ type: "text_delta", text: " answer" },
				finishEvent,
			]),
		);

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain('"type":"reasoning-delta"');
		expect(body).toContain("The user wants me to answer directly.");
		expect(body).not.toContain('"delta":"response');
		expect(body).toContain('"delta":"Final"');
		expect(body).toContain(
			'"thinking":"The user wants me to answer directly."',
		);
	});

	it("extracts inline thinking tags from token chunks and persists separated thinking", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockResolvedValue(
			buildTextStream([
				"Before<thinking>Need to reason",
				" carefully</thinking>After",
			]),
		);

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain('"type":"reasoning-delta"');
		expect(body).toContain('"delta":"Before"');
		expect(body).toContain('"delta":"After"');
		expect(body).toContain('"thinking":"Need to reason carefully"');
		expect(mockCreateMessage).toHaveBeenNthCalledWith(
			1,
			"conv-1",
			"user",
			"Hi",
		);
		expect(mockCreateMessage).toHaveBeenNthCalledWith(
			2,
			"conv-1",
			"assistant",
			"BeforeAfter",
			"Need to reason carefully",
			[{ type: "text", content: "Need to reason carefully" }],
			{ evidenceStatus: "pending", modelDisplayName: "Model 1" },
		);
	});

	it("flushes short inline Qwen thinking before completing the stream", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockResolvedValue(
			buildTextStream("<think>brief</think>Answer"),
		);

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain('"type":"reasoning-delta"');
		expect(body).toContain('"delta":"brief"');
		expect(body).toContain('"delta":"Answer"');
		expect(body).toContain('"thinking":"brief"');
	});

	it("routes an untagged Qwen planning preamble into thinking", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockResolvedValue(
			buildTextStream([
				"responseThe user wants me to write 500 words about the USA. This is a straightforward content request. I will write an informative piece.",
				"\n\nI need to wrap the content in XML-style wrapper tags and provide it in English.\n</think>\n\n",
				"The United States is a large and diverse country.",
			]),
		);

		const event = makeEvent({
			message: "Write a short essay.",
			conversationId: "conv-1",
		});
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain('"type":"reasoning-delta"');
		expect(body).toContain(
			"The user wants me to write 500 words about the USA",
		);
		expect(body).toContain("provide it in English");
		expect(body).not.toContain("</think>");
		expect(body).toContain(
			'"delta":"The United States is a large and diverse country."',
		);
		expect(body).not.toContain('"delta":"responseThe user wants me');
		expect(mockCreateMessage).toHaveBeenNthCalledWith(
			2,
			"conv-1",
			"assistant",
			"The United States is a large and diverse country.",
			"The user wants me to write 500 words about the USA. This is a straightforward content request. I will write an informative piece.\n\nI need to wrap the content in XML-style wrapper tags and provide it in English.",
			[
				{
					type: "text",
					content:
						"The user wants me to write 500 words about the USA. This is a straightforward content request. I will write an informative piece.\n\nI need to wrap the content in XML-style wrapper tags and provide it in English.",
				},
			],
			{ evidenceStatus: "pending", modelDisplayName: "Model 1" },
		);
	});

	it("passes input through unchanged", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockResolvedValue(
			buildTextStream("Final English answer."),
		);

		const event = makeEvent({ message: "Szia", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(mockSendMessageStream).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Szia",
				conversationId: "conv-1",
				modelId: "model1",
				signal: expect.any(Object),
				user: {
					id: "user-1",
					displayName: undefined,
					email: "test@example.com",
				},
				attachmentIds: [],
				thinkingMode: "auto",
			}),
		);
		expect(body).toContain('"delta":"Final English answer."');
	});

	it("stream ends with metadata and finish parts after the neutral finish event", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockResolvedValue(buildTextStream("chunk"));

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain('"type":"data-stream-metadata"');
		expect(body).toContain('"type":"finish"');
		expect(body).toContain("data: [DONE]");
		expect(body).toContain('"thinkingTokenCount":0');
		expect(body).toContain('"responseTokenCount":2');
		expect(body).toContain('"totalTokenCount":2');
		expect(body).toContain('"modelDisplayName":"Model 1"');
	});

	it("returns 401 when user is not authenticated", async () => {
		mockRequireAuth.mockImplementation(() => {
			throw { status: 302, location: "/login" };
		});

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });

		await expect(POST(event)).rejects.toMatchObject({ status: 302 });
	});

	it("returns 404 when conversationId does not exist", async () => {
		mockGetConversation.mockResolvedValue(null);

		const event = makeEvent({ message: "Hi", conversationId: "nonexistent" });
		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.error).toMatch(/not found/i);
	});

	it("emits error event when the neutral stream wrapper throws", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockRejectedValue(new Error("Provider down"));

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain('"type":"data-stream-error"');
		expect(body).toContain('"code":"backend_failure"');
	});

	it("falls back to the non-stream Normal Chat run when the streaming handshake aborts", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		const abortError = new Error("This operation was aborted");
		abortError.name = "AbortError";
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockRejectedValue(abortError);
		mockSendMessage.mockResolvedValue({
			text: "Recovered final answer",
			rawResponse: {
				outputs: [
					{
						outputs: [
							{ results: { message: { text: "Recovered final answer" } } },
						],
					},
				],
			},
			contextStatus: undefined,
			taskState: null,
			contextDebug: null,
		});

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain('"type":"text-delta"');
		expect(body).toContain('"delta":"Recovered final answer"');
		expect(body).toContain('"type":"data-stream-metadata"');
		expect(mockSendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				message: "Hi",
				conversationId: "conv-1",
				modelId: "model1",
				user: {
					id: "user-1",
					displayName: undefined,
					email: "test@example.com",
				},
				signal: expect.any(Object),
				attachmentIds: [],
				attachmentTraceId: undefined,
				systemPromptAppendix: undefined,
			}),
		);
	});

	it("completes successfully from neutral wrapper text events", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockResolvedValue(
			buildNeutralStream([
				{ type: "text_delta", text: "Neutral wrapper answer" },
				finishEvent,
			]),
		);

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain('"type":"text-delta"');
		expect(body).toContain('"delta":"Neutral wrapper answer"');
		expect(body).toContain('"type":"data-stream-metadata"');
	});

	it("emits provider errors without URL-list retry recovery", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockResolvedValueOnce(
			buildErrorStream(
				"1 validation error for InputSchema\nurls\n  Input should be a valid list [type=list_type, input_value='https://example.com', input_type=str]\n",
			),
		);

		const event = makeEvent({
			message: "Check https://example.com",
			conversationId: "conv-1",
		});
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain('"type":"data-stream-error"');
		expect(body).not.toContain("Recovered answer");
		expect(mockSendMessageStream).toHaveBeenCalledTimes(1);
		expect(mockSendMessageStream).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Check https://example.com",
				conversationId: "conv-1",
				modelId: "model1",
				signal: expect.any(Object),
				user: {
					id: "user-1",
					displayName: undefined,
					email: "test@example.com",
				},
				attachmentIds: [],
			}),
		);
	});

	it("returns 400 when message is empty", async () => {
		const event = makeEvent({ message: "", conversationId: "conv-1" });
		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toMatch(/non-empty/i);
	});

	it("returns 400 when conversationId is missing", async () => {
		const event = makeEvent({ message: "Hello" });
		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toMatch(/conversationId/i);
	});
});
