import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/conversations", () => ({
	getConversation: vi.fn(),
	touchConversation: vi.fn(),
}));

vi.mock("$lib/server/services/langflow", () => ({
	isLangflowTimeoutError: vi.fn(() => false),
	resolveTimeoutFailoverTargetModelId: vi.fn(async () => null),
	sendMessage: vi.fn(),
	sendMessageStream: vi.fn(),
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

vi.mock("$lib/server/services/task-state", () => ({
	attachContinuityToTaskState: vi.fn(
		async (_userId: string, taskState: unknown) => taskState,
	),
	getContextDebugState: vi.fn(async () => null),
	getConversationTaskState: vi.fn(async () => null),
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
import {
	getConversation,
	touchConversation,
} from "$lib/server/services/conversations";
import {
	assignFileProductionJobsToAssistantMessage,
	listConversationFileProductionJobs,
} from "$lib/server/services/file-production";
import { assertPromptReadyAttachments } from "$lib/server/services/knowledge";
import { sendMessage, sendMessageStream } from "$lib/server/services/langflow";
import {
	createMessage,
	updateMessageHonchoMetadata,
} from "$lib/server/services/messages";
import { getConversationTaskState } from "$lib/server/services/task-state";
import { POST } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockGetConversation = getConversation as ReturnType<typeof vi.fn>;
const mockTouchConversation = touchConversation as ReturnType<typeof vi.fn>;
const mockSendMessageStream = sendMessageStream as ReturnType<typeof vi.fn>;
const mockSendMessage = sendMessage as ReturnType<typeof vi.fn>;
const mockCreateMessage = createMessage as ReturnType<typeof vi.fn>;
const mockUpdateMessageHonchoMetadata =
	updateMessageHonchoMetadata as ReturnType<typeof vi.fn>;
const mockAssertPromptReadyAttachments =
	assertPromptReadyAttachments as ReturnType<typeof vi.fn>;
const mockGetConversationTaskState = getConversationTaskState as ReturnType<
	typeof vi.fn
>;
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
			webhookBuffer: {
				getSentences: vi.fn(() => null),
				clearSession: vi.fn(),
			},
		},
		params: {},
		url: new URL("http://localhost/api/chat/stream"),
		route: { id: "/api/chat/stream" },
	} as StreamPostEvent;
}

function buildSseStream(lines: string[]): {
	stream: ReadableStream<Uint8Array>;
	contextStatus: undefined;
	taskState: null;
	contextDebug: null;
	honchoContext: null;
	honchoSnapshot: null;
	[Symbol.asyncIterator]: () => AsyncIterator<Uint8Array>;
} {
	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		start(controller) {
			for (const line of lines) {
				controller.enqueue(encoder.encode(line));
			}
			controller.close();
		},
	});
	return {
		stream,
		contextStatus: undefined,
		taskState: null,
		contextDebug: null,
		honchoContext: null,
		honchoSnapshot: null,
		[Symbol.asyncIterator]() {
			return stream[Symbol.asyncIterator]();
		},
	};
}

function buildControlledSseStream() {
	const encoder = new TextEncoder();
	let enqueueToken!: (text: string) => void;
	let finish!: () => void;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			enqueueToken = (text: string) => {
				controller.enqueue(
					encoder.encode(`event: token\ndata: ${JSON.stringify({ text })}\n\n`),
				);
			};
			finish = () => {
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
			};
		},
	});
	return {
		stream,
		contextStatus: undefined,
		taskState: null,
		contextDebug: null,
		honchoContext: null,
		honchoSnapshot: null,
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

describe("POST /api/chat/stream", () => {
	beforeEach(() => {
		vi.clearAllMocks();
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
		mockSendMessageStream.mockResolvedValue(
			buildSseStream([
				'event: add_message\ndata: {"text":"Hello"}\n\n',
				"data: [DONE]\n\n",
			]),
		);

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("text/event-stream");
	});

	it("starts SSE responses with an ignored prelude comment to flush browser-facing proxies", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockResolvedValue(
			buildSseStream([
				'event: add_message\ndata: {"text":"Hello"}\n\n',
				"data: [DONE]\n\n",
			]),
		);

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body.startsWith(":")).toBe(true);
		expect(body).toContain("event: token");
		expect(body).toContain("event: end");
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
		expect(body).toContain("event: error");
		expect(body).toContain('"code":"backend_failure"');
	});

	it("stream contains token events with text chunks", async () => {
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
		mockSendMessageStream.mockResolvedValue({
			...buildSseStream([
				'event: add_message\ndata: {"text":"Hello"}\n\n',
				'event: add_message\ndata: {"text":" world"}\n\n',
				"data: [DONE]\n\n",
			]),
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
		});

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain("event: token");
		expect(body).toContain('"text":"Hello"');
		expect(body).toContain('"text":" world"');
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

	it("forwards the active workspace document id into Langflow streaming calls", async () => {
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
		mockSendMessageStream.mockResolvedValue(
			buildSseStream([
				'event: add_message\ndata: {"text":"Refined"}\n\n',
				"data: [DONE]\n\n",
			]),
		);

		const event = makeEvent({
			message: "Refine it",
			conversationId: "conv-1",
			activeDocumentArtifactId: "artifact-focused-1",
			thinkingMode: "off",
		});
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(response.status).toBe(200);
		expect(body).toContain('"text":"Refined"');
		expect(mockSendMessageStream).toHaveBeenCalledWith(
			"Refine it",
			"conv-1",
			"model1",
			expect.objectContaining({
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

		mockSendMessageStream.mockResolvedValue(
			buildSseStream([
				'event: add_message\ndata: {"text":"Hello"}\n\n',
				"data: [DONE]\n\n",
			]),
		);

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

		const upstream = buildControlledSseStream();
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

	it("parses CRLF-delimited SSE blocks from Langflow", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockResolvedValue(
			buildSseStream([
				'event: add_message\r\ndata: {"text":"Hello"}\r\n\r\n',
				'event: add_message\r\ndata: {"text":" world"}\r\n\r\n',
				"data: [DONE]\r\n\r\n",
			]),
		);

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain("event: token");
		expect(body).toContain('"text":"Hello"');
		expect(body).toContain('"text":" world"');
		expect(body).toContain("event: end");
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
			buildSseStream([
				`event: token\ndata: {"text":"\\u0002TOOL_START\\u001f${JSON.stringify({
					name: "produce_file",
					input: {
						requestTitle: "Report",
						outputs: [{ type: "txt" }],
						sourceMode: "program",
					},
				}).replace(/"/g, '\\"')}\\u0003Done"}\n\n`,
				"data: [DONE]\n\n",
			]),
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

		expect(body).toContain("event: end");
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

	it("parses Langflow JSON event blocks and ignores echoed user messages", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockResolvedValue(
			buildSseStream([
				'{"event":"add_message","data":{"sender":"User","text":"Hi"}}\n\n',
				'{"event":"add_message","data":{"sender":"Machine","text":"Hello"}}\n\n',
				'{"event":"end","data":{}}\n\n',
			]),
		);

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain("event: token");
		expect(body).toContain('"text":"Hello"');
		expect(body).not.toContain('"text":"Hi"');
	});

	it("accepts assistant add_message events from the current Language Model sender label", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockResolvedValue(
			buildSseStream([
				'{"event":"add_message","data":{"sender":"Language Model","text":"Hello"}}\n\n',
				'{"event":"end","data":{}}\n\n',
			]),
		);

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain("event: token");
		expect(body).toContain('"text":"Hello"');
	});

	it("extracts assistant output from Langflow content_blocks when text is empty", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockResolvedValue(
			buildSseStream([
				'{"event":"add_message","data":{"sender":"Language Model","text":"","content_blocks":[{"title":"Agent Steps","contents":[{"type":"text","text":"Tell me a story","header":{"title":"Input","icon":"MessageSquare"}},{"type":"text","text":"Final answer from Langflow.","header":{"title":"Output","icon":"Bot"}}]}]}}\n\n',
				'{"event":"end","data":{}}\n\n',
			]),
		);

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain("event: token");
		expect(body).toContain('"text":"Final answer from Langflow."');
		expect(body).not.toContain('"text":"Tell me a story"');
	});

	it("parses newline-delimited Langflow JSON events without blank separators", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockResolvedValue(
			buildSseStream([
				'{"event":"add_message","data":{"sender":"Machine","text":"Hello"}}\n',
				'{"event":"add_message","data":{"sender":"Machine","text":" world"}}\n',
				'{"event":"end","data":{}}\n',
			]),
		);

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain('"text":"Hello"');
		expect(body).toContain('"text":" world"');
		expect(body).toContain("event: end");
	});

	it("emits only deltas when Langflow sends cumulative assistant snapshots", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockResolvedValue(
			buildSseStream([
				'{"event":"add_message","data":{"sender":"Machine","text":"Hello"}}\n\n',
				'{"event":"add_message","data":{"sender":"Machine","text":"Hello world"}}\n\n',
				'{"event":"add_message","data":{"sender":"Machine","text":"Hello world again"}}\n\n',
				'{"event":"end","data":{}}\n\n',
			]),
		);

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain('"text":"Hello"');
		expect(body).toContain('"text":" world"');
		expect(body).toContain('"text":" again"');
		expect(body).not.toContain('"text":"Hello world"');
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
			"Hello world again",
			undefined,
			undefined,
			{ evidenceStatus: "pending", modelDisplayName: "Model 1" },
		);
	});

	it("does not duplicate the final add_message after token streaming", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockResolvedValue(
			buildSseStream([
				'event: token\ndata: {"text":"Hello"}\n\n',
				'event: token\ndata: {"text":" world"}\n\n',
				'event: add_message\ndata: {"sender":"Machine","text":"Hello world"}\n\n',
				"data: [DONE]\n\n",
			]),
		);

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain('"text":"Hello"');
		expect(body).toContain('"text":" world"');
		expect(body.match(/event: token/g)?.length).toBe(2);
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
			"Hello world",
			undefined,
			undefined,
			{ evidenceStatus: "pending", modelDisplayName: "Model 1" },
		);
	});

	it("extracts reasoning from OpenAI-compatible streaming delta payloads", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockResolvedValue(
			buildSseStream([
				'event: token\ndata: {"choices":[{"delta":{"reasoning_content":"Need to break this down.","content":"Final"}}]}\n\n',
				'event: token\ndata: {"choices":[{"delta":{"content":" answer"}}]}\n\n',
				"data: [DONE]\n\n",
			]),
		);

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain("event: thinking");
		expect(body).toContain("Need to break this down.");
		expect(body).toContain('"text":"Final"');
		expect(body).toContain('"text":" answer"');
		expect(body).toContain('"thinking":"Need to break this down."');
	});

	it("strips a leading Langflow response marker from streamed reasoning", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockResolvedValue(
			buildSseStream([
				'event: token\ndata: {"choices":[{"delta":{"reasoning_content":"response ","content":""}}]}\n\n',
				'event: token\ndata: {"choices":[{"delta":{"reasoning_content":"The user wants me to answer directly.","content":"Final"}}]}\n\n',
				'event: token\ndata: {"choices":[{"delta":{"content":" answer"}}]}\n\n',
				"data: [DONE]\n\n",
			]),
		);

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain("event: thinking");
		expect(body).toContain("The user wants me to answer directly.");
		expect(body).not.toContain('"text":"response');
		expect(body).toContain('"text":"Final"');
		expect(body).toContain(
			'"thinking":"The user wants me to answer directly."',
		);
	});

	it("extracts reasoning from OpenAI-compatible final message payloads", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockResolvedValue(
			buildSseStream([
				'{"event":"add_message","data":{"choices":[{"message":{"role":"assistant","reasoning_content":"First analyze the request.","content":"Completed response."}}]}}\n\n',
				'{"event":"end","data":{}}\n\n',
			]),
		);

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain("event: thinking");
		expect(body).toContain("First analyze the request.");
		expect(body).toContain('"text":"Completed response."');
		expect(body).toContain('"thinking":"First analyze the request."');
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
			buildSseStream([
				'event: token\ndata: {"text":"Before<thinking>Need to reason"}\n\n',
				'event: token\ndata: {"text":" carefully</thinking>After"}\n\n',
				"data: [DONE]\n\n",
			]),
		);

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain("event: thinking");
		expect(body).toContain('"text":"Before"');
		expect(body).toContain('"text":"After"');
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
			buildSseStream([
				'event: token\ndata: {"text":"<think>brief</think>Answer"}\n\n',
				"data: [DONE]\n\n",
			]),
		);

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain("event: thinking");
		expect(body).toContain('"text":"brief"');
		expect(body).toContain('"text":"Answer"');
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
			buildSseStream([
				'event: token\ndata: {"text":"responseThe user wants me to write 500 words about the USA. This is a straightforward content request. I will write an informative piece."}\n\n',
				'event: token\ndata: {"text":"\\n\\nI need to wrap the content in XML-style wrapper tags and provide it in English.\\n</think>\\n\\n"}\n\n',
				'event: token\ndata: {"text":"The United States is a large and diverse country."}\n\n',
				"data: [DONE]\n\n",
			]),
		);

		const event = makeEvent({
			message: "Write a short essay.",
			conversationId: "conv-1",
		});
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain("event: thinking");
		expect(body).toContain(
			"The user wants me to write 500 words about the USA",
		);
		expect(body).toContain("provide it in English");
		expect(body).not.toContain("</think>");
		expect(body).toContain(
			'"text":"The United States is a large and diverse country."',
		);
		expect(body).not.toContain('"text":"responseThe user wants me');
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
			buildSseStream([
				'{"event":"add_message","data":{"sender":"Machine","text":"Final English answer."}}\n\n',
				'{"event":"end","data":{}}\n\n',
			]),
		);

		const event = makeEvent({ message: "Szia", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(mockSendMessageStream).toHaveBeenCalledWith(
			"Szia",
			"conv-1",
			"model1",
			expect.objectContaining({
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
		expect(body).toContain('"text":"Final English answer."');
	});

	it("stream ends with end event after [DONE]", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockResolvedValue(
			buildSseStream([
				'event: add_message\ndata: {"text":"chunk"}\n\n',
				"data: [DONE]\n\n",
			]),
		);

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain("event: end");
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

	it("emits error event when sendMessageStream throws", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockRejectedValue(new Error("Langflow down"));

		const event = makeEvent({ message: "Hi", conversationId: "conv-1" });
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain("event: error");
		expect(body).toContain('"code":"backend_failure"');
		expect(body).toContain("model provider or Langflow returned an error");
	});

	it("falls back to the non-stream Langflow run when the streaming handshake aborts", async () => {
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

		expect(body).toContain("event: token");
		expect(body).toContain('"text":"Recovered final answer"');
		expect(body).toContain("event: end");
		expect(mockSendMessage).toHaveBeenCalledWith(
			"Hi",
			"conv-1",
			"model1",
			expect.objectContaining({
				id: "user-1",
				displayName: undefined,
				email: "test@example.com",
			}),
			expect.objectContaining({
				signal: expect.any(Object),
				attachmentIds: [],
				attachmentTraceId: undefined,
				systemPromptAppendix: undefined,
			}),
		);
	});

	it("completes successfully when Langflow returns JSON instead of SSE for the stream request", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream.mockResolvedValue({
			text: "Non-stream JSON answer",
			rawResponse: {
				outputs: [
					{
						outputs: [
							{ results: { message: { text: "Non-stream JSON answer" } } },
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

		expect(body).toContain("event: token");
		expect(body).toContain('"text":"Non-stream JSON answer"');
		expect(body).toContain("event: end");
	});

	it("retries once with a stricter URL-list tool guard after the upstream urls validation error", async () => {
		const conversation = {
			id: "conv-1",
			title: "Test",
			createdAt: 0,
			updatedAt: 0,
		};
		mockGetConversation.mockResolvedValue(conversation);
		mockSendMessageStream
			.mockResolvedValueOnce(
				buildSseStream([
					'event: error\ndata: {"data":{"text":"1 validation error for InputSchema\\nurls\\n  Input should be a valid list [type=list_type, input_value=\'https://example.com\', input_type=str]\\n"}}\n\n',
				]),
			)
			.mockResolvedValueOnce(
				buildSseStream([
					'event: token\ndata: {"text":"Recovered answer"}\n\n',
					"data: [DONE]\n\n",
				]),
			);

		const event = makeEvent({
			message: "Check https://example.com",
			conversationId: "conv-1",
		});
		const response = await POST(event);
		const body = await readSseResponse(response);

		expect(body).toContain('"text":"Recovered answer"');
		expect(body).toContain("event: end");
		expect(body).not.toContain("event: error");
		expect(mockSendMessageStream).toHaveBeenCalledTimes(2);
		expect(mockSendMessageStream).toHaveBeenNthCalledWith(
			1,
			"Check https://example.com",
			"conv-1",
			"model1",
			expect.objectContaining({
				signal: expect.any(Object),
				user: {
					id: "user-1",
					displayName: undefined,
					email: "test@example.com",
				},
				attachmentIds: [],
			}),
		);
		expect(mockSendMessageStream).toHaveBeenNthCalledWith(
			2,
			"Check https://example.com",
			"conv-1",
			"model1",
			expect.objectContaining({
				signal: expect.any(Object),
				user: {
					id: "user-1",
					displayName: undefined,
					email: "test@example.com",
				},
				attachmentIds: [],
				systemPromptAppendix: expect.stringContaining("field named `urls`"),
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
