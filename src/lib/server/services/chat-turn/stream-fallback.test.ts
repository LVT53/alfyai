import type { ModelMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelId } from "$lib/model-types";
import type { RuntimeConfig } from "$lib/server/config-store";
import { createTurnTakes } from "$lib/server/services/images/turn-takes";
import { runNonStreamFallback } from "./stream-fallback";

describe("runNonStreamFallback", () => {
	const mockRunPlainNormalChatSendModel = vi.fn();
	const mockAttachContinuity = vi.fn();
	const mockEmitText = vi.fn();
	const mockFlushPendingThinking = vi.fn();
	const mockFlushInlineThinking = vi.fn();
	const mockFlushOutput = vi.fn();
	const mockGetVisibleAssistantText = vi.fn();
	let visibleText = "";
	const mockCompleteSuccess = vi.fn();
	const mockOnContextStatus = vi.fn();
	const mockOnTaskState = vi.fn();
	const mockOnContextDebug = vi.fn();
	const mockOnProviderUsage = vi.fn();
	const mockOnRecoveredToolCalls = vi.fn();
	const mockOnContextPreparationTimings = vi.fn();

	const defaultSendParams = {
		runtimeConfig: {
			requestTimeoutMs: 30000,
		} as unknown as RuntimeConfig,
		upstreamMessage: "test message",
		conversationId: "conv-1",
		modelId: "model-1" as ModelId,
		attachmentIds: ["att-1"],
		activeDocumentArtifactId: "doc-1",
		attachmentTraceId: "trace-1",
		thinkingMode: "auto" as const,
		forceWebSearch: false,
	};

	const defaultUser = {
		id: "user-1",
		displayName: "Test User",
		email: "test@example.com",
	};

	const defaultFallbackResponse = {
		text: "fallback response",
		contextStatus: { active: true } as Record<string, unknown>,
		taskState: { id: "task-1" } as Record<string, unknown>,
		contextDebug: { debug: true } as Record<string, unknown>,
		providerUsage: { tokens: 100 } as Record<string, unknown>,
	};

	function callFallback(overrides: Record<string, unknown> = {}) {
		return runNonStreamFallback({
			runPlainNormalChatSendModel: mockRunPlainNormalChatSendModel,
			sendParams: defaultSendParams,
			user: defaultUser,
			attachContinuityToTaskState: mockAttachContinuity,
			emitResolvedAssistantText: mockEmitText,
			flushPendingThinking: mockFlushPendingThinking,
			flushInlineThinkingBuffer: mockFlushInlineThinking,
			flushOutputBuffer: mockFlushOutput,
			getVisibleAssistantText: mockGetVisibleAssistantText,
			completeSuccess: mockCompleteSuccess,
			signal: new AbortController().signal,
			systemPromptAppendix: undefined,
			personalityPrompt: undefined,
			onContextStatus: mockOnContextStatus,
			onTaskState: mockOnTaskState,
			onContextDebug: mockOnContextDebug,
			onProviderUsage: mockOnProviderUsage,
			onRecoveredToolCalls: mockOnRecoveredToolCalls,
			onContextPreparationTimings: mockOnContextPreparationTimings,
			...overrides,
		});
	}

	beforeEach(() => {
		vi.resetAllMocks();
		mockRunPlainNormalChatSendModel.mockResolvedValue(defaultFallbackResponse);
		mockEmitText.mockImplementation(async (text: string) => {
			visibleText += text;
			return true;
		});
		mockFlushInlineThinking.mockReturnValue(true);
		mockFlushOutput.mockReturnValue(true);
		visibleText = "Preamble.";
		mockGetVisibleAssistantText.mockImplementation(() => visibleText);
		mockAttachContinuity.mockImplementation(
			(_userId: string, taskState: unknown) => Promise.resolve(taskState),
		);
	});

	it.each([
		"",
		" ",
		"\u200B\u200C\u200D\u2060\uFEFF",
	])("does not recover from a preamble when only invisible text is added: %j", async (addition) => {
		mockRunPlainNormalChatSendModel.mockResolvedValue({ text: addition });
		expect(await callFallback()).toBe(false);
		expect(mockRunPlainNormalChatSendModel).toHaveBeenCalledTimes(2);
		expect(mockCompleteSuccess).not.toHaveBeenCalled();
	});

	it("calls runPlainNormalChatSendModel with correct parameters", async () => {
		await callFallback();

		expect(mockRunPlainNormalChatSendModel).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				message: "test message",
				conversationId: "conv-1",
				modelId: "model-1",
				user: {
					id: "user-1",
					displayName: "Test User",
					email: "test@example.com",
				},
				attachmentIds: ["att-1"],
				activeDocumentArtifactId: "doc-1",
				attachmentTraceId: "trace-1",
			}),
		);
	});

	it("hands the turn's make_image bookkeeping to the rerun so it does not make a picture twice", async () => {
		const turnTakes = createTurnTakes();
		await callFallback({
			sendParams: { ...defaultSendParams, turnTakes },
		});
		expect(mockRunPlainNormalChatSendModel).toHaveBeenCalledWith(
			expect.objectContaining({ turnTakes }),
		);
	});

	it("forwards prompt modifiers to runPlainNormalChatSendModel", async () => {
		await callFallback({
			systemPromptAppendix: "retry fresh",
			personalityPrompt: "be terse",
		});

		expect(mockRunPlainNormalChatSendModel).toHaveBeenCalledWith(
			expect.objectContaining({
				systemPromptAppendix: "retry fresh",
				personalityPrompt: "be terse",
			}),
		);
	});

	it("updates context status from fallback response", async () => {
		const status = { active: true };
		mockRunPlainNormalChatSendModel.mockResolvedValue({
			...defaultFallbackResponse,
			contextStatus: status,
		});

		await callFallback();

		expect(mockRunPlainNormalChatSendModel).toHaveBeenCalled();
	});

	it("attaches continuity to task state", async () => {
		await callFallback();

		expect(mockAttachContinuity).toHaveBeenCalledWith("user-1", {
			id: "task-1",
		});
	});

	it("emits resolved assistant text", async () => {
		await callFallback();

		expect(mockEmitText).toHaveBeenCalledWith("fallback response");
	});

	it("flushes thinking buffers after emitting text", async () => {
		await callFallback();

		expect(mockFlushPendingThinking).toHaveBeenCalled();
		expect(mockFlushInlineThinking).toHaveBeenCalled();
		expect(mockFlushOutput).toHaveBeenCalled();
	});

	it("calls completeSuccess after successful fallback", async () => {
		await callFallback();

		expect(mockCompleteSuccess).toHaveBeenCalled();
	});

	it("returns early if emitResolvedAssistantText returns false", async () => {
		mockEmitText.mockResolvedValue(false);

		await callFallback();

		expect(mockFlushPendingThinking).not.toHaveBeenCalled();
		expect(mockCompleteSuccess).not.toHaveBeenCalled();
	});

	it("returns early if flushInlineThinkingBuffer returns false", async () => {
		mockFlushInlineThinking.mockReturnValue(false);

		await callFallback();

		expect(mockFlushOutput).not.toHaveBeenCalled();
		expect(mockCompleteSuccess).not.toHaveBeenCalled();
	});

	it("returns early if flushOutputBuffer returns false", async () => {
		mockFlushOutput.mockReturnValue(false);

		await callFallback();

		expect(mockCompleteSuccess).not.toHaveBeenCalled();
	});

	it("returns early if fallback text normalizes to no visible assistant text", async () => {
		mockGetVisibleAssistantText.mockReturnValue("Preamble.");

		const result = await callFallback();

		expect(result).toBe(false);
		expect(mockRunPlainNormalChatSendModel).toHaveBeenCalledTimes(2);
		expect(mockEmitText).toHaveBeenCalledTimes(2);
		expect(mockFlushPendingThinking).toHaveBeenCalled();
		expect(mockCompleteSuccess).not.toHaveBeenCalled();
	});

	it("handles null taskState gracefully", async () => {
		mockRunPlainNormalChatSendModel.mockResolvedValue({
			...defaultFallbackResponse,
			taskState: null,
		});

		await callFallback();

		expect(mockAttachContinuity).toHaveBeenCalledWith("user-1", null);
	});

	it("handles null contextDebug gracefully", async () => {
		mockRunPlainNormalChatSendModel.mockResolvedValue({
			...defaultFallbackResponse,
			contextDebug: null,
		});

		await callFallback();
	});

	it("does not complete when fallback returns no assistant text", async () => {
		mockRunPlainNormalChatSendModel.mockResolvedValue({
			...defaultFallbackResponse,
			text: null,
		});
		mockEmitText.mockResolvedValue(true);

		const result = await callFallback();

		expect(result).toBe(false);
		expect(mockRunPlainNormalChatSendModel).toHaveBeenCalledTimes(2);
		expect(mockEmitText).not.toHaveBeenCalled();
		expect(mockCompleteSuccess).not.toHaveBeenCalled();
	});

	it("retries once with an empty-output recovery appendix", async () => {
		mockRunPlainNormalChatSendModel
			.mockResolvedValueOnce({
				...defaultFallbackResponse,
				text: null,
			})
			.mockResolvedValueOnce(defaultFallbackResponse);

		const result = await callFallback({
			systemPromptAppendix: "Existing appendix",
		});

		expect(result).toBe(true);
		expect(mockRunPlainNormalChatSendModel).toHaveBeenCalledTimes(2);
		expect(mockRunPlainNormalChatSendModel).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				systemPromptAppendix: expect.stringContaining(
					"Existing appendix\n\nThe previous attempt produced no visible final answer",
				),
				disableTools: true,
			}),
		);
		expect(mockEmitText).toHaveBeenCalledWith("fallback response");
		expect(mockCompleteSuccess).toHaveBeenCalled();
	});

	it("reports context-preparation timings for each fallback attempt", async () => {
		const firstAttemptTimings = [
			{
				stageId: "plan",
				activityClass: "planning",
				status: "done",
				startedAt: 10,
				completedAt: 13,
				durationMs: 3,
			},
		];
		const secondAttemptTimings = [
			{
				stageId: "plan",
				activityClass: "planning",
				status: "done",
				startedAt: 20,
				completedAt: 25,
				durationMs: 5,
			},
			{
				stageId: "prompt_budget",
				activityClass: "budgeting",
				status: "done",
				startedAt: 30,
				completedAt: 37,
				durationMs: 7,
			},
		];
		mockRunPlainNormalChatSendModel
			.mockResolvedValueOnce({
				...defaultFallbackResponse,
				text: null,
				contextPreparationTimings: firstAttemptTimings,
			})
			.mockResolvedValueOnce({
				...defaultFallbackResponse,
				contextPreparationTimings: secondAttemptTimings,
			});

		const result = await callFallback();

		expect(result).toBe(true);
		expect(mockOnContextPreparationTimings).toHaveBeenNthCalledWith(
			1,
			firstAttemptTimings,
			1,
		);
		expect(mockOnContextPreparationTimings).toHaveBeenNthCalledWith(
			2,
			secondAttemptTimings,
			2,
		);
	});

	it("uses completed tool context and disables tools when recovering after tool-only stream output", async () => {
		const result = await callFallback({
			systemPromptAppendix: "Existing appendix",
			completedToolCallContext:
				'Tool 1: memory_context\nInput: {"mode":"project","query":"AlmaLinux Server"}\nSummary: Project memory found: AlmaLinux Server',
		});

		expect(result).toBe(true);
		expect(mockRunPlainNormalChatSendModel).toHaveBeenCalledWith(
			expect.objectContaining({
				disableTools: true,
				systemPromptAppendix: expect.stringContaining(
					"The previous streaming attempt completed these tool calls",
				),
			}),
		);
		expect(mockRunPlainNormalChatSendModel).toHaveBeenCalledWith(
			expect.objectContaining({
				systemPromptAppendix: expect.stringContaining(
					"Project memory found: AlmaLinux Server",
				),
			}),
		);
	});

	it("keeps the forced file tool available when recovering a file request with completed context", async () => {
		const result = await callFallback({
			sendParams: {
				...defaultSendParams,
				upstreamMessage:
					"Generate a detailed PDF report from the AlmaLinux Server project folder.",
			},
			completedToolCallContext:
				"Tool 1: memory_context\nSummary: Project memory found: AlmaLinux Server",
		});

		expect(result).toBe(true);
		expect(mockRunPlainNormalChatSendModel).toHaveBeenCalledWith(
			expect.objectContaining({
				disableTools: false,
				forceProduceFileTool: true,
				message:
					"Generate a detailed PDF report from the AlmaLinux Server project folder.",
				systemPromptAppendix: expect.stringContaining(
					"Use this compact tool context to create the requested file now",
				),
			}),
		);
	});

	it("reports fallback tool calls so file jobs can attach to the final assistant turn", async () => {
		const producedFileToolCall = {
			callId: "call-file-1",
			name: "produce_file",
			input: { requestTitle: "AlmaLinux Server report" },
			status: "done" as const,
			outputSummary: "Queued PDF generation.",
			metadata: { ok: true, evidenceReady: true },
		};
		mockRunPlainNormalChatSendModel.mockResolvedValue({
			...defaultFallbackResponse,
			normalChatToolCalls: [producedFileToolCall],
		});

		const result = await callFallback({
			sendParams: {
				...defaultSendParams,
				upstreamMessage:
					"Generate a detailed PDF report from the AlmaLinux Server project folder.",
			},
			completedToolCallContext:
				"Tool 1: memory_context\nSummary: Project memory found: AlmaLinux Server",
		});

		expect(result).toBe(true);
		expect(mockOnRecoveredToolCalls).toHaveBeenCalledWith([
			producedFileToolCall,
		]);
	});

	// "Ask me first": the rerun of a reply that asked carries the same continuation
	// the stream was given, and what a resume adds to the turn (the history cut, no
	// second page read, the gate, the provenance), or it would answer a different
	// conversation from the one the person is in.
	describe("a rerun of a reply that carries on from the person's answer", () => {
		const continuation: ModelMessage[] = [
			{
				role: "assistant",
				content: [
					{
						type: "tool-call",
						toolCallId: "call-ask",
						toolName: "ask_user",
						input: { questions: [] },
					},
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call-ask",
						toolName: "ask_user",
						output: { type: "json", value: { status: "answered" } },
					},
				],
			},
		];
		const completedToolCalls = [
			{
				callId: "call-own",
				name: "research_web",
				input: { query: "wall colours" },
				status: "done" as const,
				outputSummary: "Found 1 source.",
			},
		];
		const gate = vi.fn((messages: ModelMessage[]) => messages);
		const resumeProvenance = {
			userTexts: ["use https://typed.example/a"],
			priorResults: [],
		};
		const resumeSendParams = {
			...defaultSendParams,
			continuationMessages: continuation,
			historyBeforeMessageId: "message-asked",
			skipWebPrefetch: true,
			gateMessagesForAttempt: gate,
			resumeProvenance,
		};

		it("keeps the continuation before the fallback's own messages", async () => {
			await callFallback({
				sendParams: resumeSendParams,
				completedToolCalls,
				completedToolCallContext: "Tool 1: research_web",
			});

			const sent = mockRunPlainNormalChatSendModel.mock.calls[0]?.[0]
				.continuationMessages as ModelMessage[];
			// the continuation first, then the replay of the fallback's own calls
			expect(sent.slice(0, continuation.length)).toEqual(continuation);
			expect(sent).toHaveLength(continuation.length + 2);
			expect(sent[continuation.length]).toMatchObject({
				role: "assistant",
				content: [
					expect.objectContaining({
						type: "tool-call",
						toolCallId: "call-own",
						toolName: "research_web",
					}),
				],
			});
			expect(sent[continuation.length + 1]).toMatchObject({ role: "tool" });
		});

		it("sends the continuation alone when the fallback has completed nothing of its own", async () => {
			await callFallback({ sendParams: resumeSendParams });

			expect(
				mockRunPlainNormalChatSendModel.mock.calls[0]?.[0].continuationMessages,
			).toEqual(continuation);
		});

		it("sends no continuation when there is neither", async () => {
			await callFallback();

			expect(
				mockRunPlainNormalChatSendModel.mock.calls[0]?.[0].continuationMessages,
			).toBeUndefined();
		});

		it("carries the history cut, the prefetch skip, the gate and the provenance to every attempt", async () => {
			mockGetVisibleAssistantText
				.mockReturnValueOnce("Preamble.")
				.mockReturnValueOnce("Preamble.")
				.mockReturnValueOnce("Preamble.")
				.mockReturnValueOnce("Preamble. Answer.");

			await callFallback({ sendParams: resumeSendParams });

			expect(mockRunPlainNormalChatSendModel).toHaveBeenCalledTimes(2);
			for (const [params] of mockRunPlainNormalChatSendModel.mock.calls) {
				expect(params).toMatchObject({
					historyBeforeMessageId: "message-asked",
					skipWebPrefetch: true,
					gateMessagesForAttempt: gate,
					resumeProvenance,
					continuationMessages: continuation,
				});
			}
		});

		it("adds nothing of it to the rerun of an ordinary turn", async () => {
			await callFallback();

			const params = mockRunPlainNormalChatSendModel.mock.calls[0]?.[0];
			expect(params.historyBeforeMessageId).toBeUndefined();
			expect(params.skipWebPrefetch).toBeUndefined();
			expect(params.gateMessagesForAttempt).toBeUndefined();
			expect(params.resumeProvenance).toBeUndefined();
		});
	});

	it("retries once when fallback text normalizes to no visible output", async () => {
		mockGetVisibleAssistantText
			.mockReturnValueOnce("Preamble.")
			.mockReturnValueOnce("Preamble.")
			.mockReturnValueOnce("Preamble.")
			.mockReturnValueOnce("Preamble. Answer.");

		const result = await callFallback();

		expect(result).toBe(true);
		expect(mockRunPlainNormalChatSendModel).toHaveBeenCalledTimes(2);
		expect(mockEmitText).toHaveBeenCalledTimes(2);
		expect(mockCompleteSuccess).toHaveBeenCalled();
	});

	it("returns false instead of throwing when fallback send fails", async () => {
		mockRunPlainNormalChatSendModel.mockRejectedValue(
			new Error("Provider API error: 502"),
		);

		const result = await callFallback();

		expect(result).toBe(false);
		expect(mockEmitText).not.toHaveBeenCalled();
		expect(mockCompleteSuccess).not.toHaveBeenCalled();
	});
});
