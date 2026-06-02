import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	buildConstructedContext: vi.fn(),
	getConfig: vi.fn(),
	getSystemPrompt: vi.fn(),
	logAttachmentTrace: vi.fn(),
	researchWeb: vi.fn(),
	summarizeAttachmentSectionInInput: vi.fn(),
}));

vi.mock("../config-store", () => ({
	getConfig: mocks.getConfig,
}));

vi.mock("../prompts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../prompts")>();
	return {
		...actual,
		getSystemPrompt: mocks.getSystemPrompt,
	};
});

vi.mock("./chat-turn/context-selection", () => ({
	buildConstructedContext: mocks.buildConstructedContext,
}));

vi.mock("./attachment-trace", () => ({
	logAttachmentTrace: mocks.logAttachmentTrace,
	summarizeAttachmentSectionInInput: mocks.summarizeAttachmentSectionInInput,
}));

vi.mock("./context-compression", () => ({
	getLatestValidContextCompressionSnapshot: vi.fn(),
	listContextCompressionSourceMessages: vi.fn(),
	runContextCompression: vi.fn(),
}));

vi.mock("./web-research", () => ({
	researchWeb: mocks.researchWeb,
}));

import {
	buildOutboundSystemPrompt,
	prepareOutboundChatContext,
} from "./normal-chat-context";

const modelConfig = {
	baseUrl: "http://local-model/v1",
	apiKey: "local-key",
	modelName: "local-model",
	displayName: "Local Model",
	systemPrompt: "alfyai-nemotron",
	maxTokens: 4096,
	reasoningEffort: null,
	thinkingType: null,
};

describe("prepareOutboundChatContext", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getConfig.mockReturnValue({ contextDiagnosticsDebug: false });
		mocks.getSystemPrompt.mockReturnValue("Base system prompt");
		mocks.summarizeAttachmentSectionInInput.mockReturnValue({
			hasMarker: false,
			preview: "",
			previewHash: "",
		});
		mocks.researchWeb.mockResolvedValue({
			answerBrief: {
				markdown:
					"Research brief for: What changed today?\n\nSources:\n[S1] Official source - https://example.com/source",
				sources: [
					{
						sourceId: "source-1",
						title: "Official source",
						url: "https://example.com/source",
					},
				],
				evidence: [],
			},
		});
	});

	it("describes produce_file using direct AI SDK tool inputs without Langflow-era wording", () => {
		const prompt = buildOutboundSystemPrompt({
			basePrompt: "Base system prompt",
			inputValue: "Create a downloadable PDF and CSV.",
			modelDisplayName: "Provider Model",
		});

		expect(prompt).toContain(
			"`requestedOutputs` is an array of output descriptors, not a JSON-encoded string.",
		);
		expect(prompt).toContain('Use `requestedOutputs: [{ "type": "pdf" }]`');
		expect(prompt).toContain(
			"`documentSource` and `program` are direct `produce_file` input object fields.",
		);
		expect(prompt).toContain(
			"For raw provider follow-up retrieval, chain `search` calls first, then use the connected content retrieval tool if one is listed.",
		);
		expect(prompt).not.toMatch(/Langflow/i);
		expect(prompt).not.toContain("JSON string containing an array");
		expect(prompt).not.toContain("JSON-encoded array string");
		expect(prompt).not.toContain("current legacy external search flows");
	});

	it("uses neutral trace and warning labels while preparing attachment context", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		try {
			await prepareOutboundChatContext({
				message: "Summarize the attached file.",
				sessionId: "conv-1",
				modelConfig,
				attachmentIds: ["attachment-1"],
				attachmentTraceId: "trace-1",
				skipHonchoContext: true,
				modelId: "model1",
				contextLimits: {
					maxModelContext: 262_144,
					compactionUiThreshold: 209_715,
					targetConstructedContext: 157_286,
				},
				logLabel: "provider request",
			});

			expect(mocks.logAttachmentTrace).toHaveBeenCalledWith(
				"normal_chat_context",
				expect.objectContaining({
					traceId: "trace-1",
					sessionId: "conv-1",
					hasCurrentAttachmentsMarker: false,
				}),
			);
			expect(warn).toHaveBeenCalledWith(
				"[NORMAL_CHAT_CONTEXT] Attachment marker missing from outgoing provider request",
				expect.objectContaining({
					sessionId: "conv-1",
					attachmentIds: ["attachment-1"],
					traceId: "trace-1",
				}),
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("prefetches forced web search before the current user message through the neutral Normal Chat context boundary", async () => {
		const prepared = await prepareOutboundChatContext({
			message: "What changed today?",
			sessionId: "conv-1",
			modelConfig,
			forceWebSearch: true,
			skipHonchoContext: true,
			modelId: "model1",
			contextLimits: {
				maxModelContext: 262_144,
				compactionUiThreshold: 209_715,
				targetConstructedContext: 157_286,
			},
			logLabel: "provider request",
		});

		expect(mocks.researchWeb).toHaveBeenCalledWith(
			expect.objectContaining({
				query: "What changed today?",
				mode: "exact",
				freshness: "live",
			}),
		);
		expect(prepared.inputValue).toContain("## Current Web Research");
		expect(prepared.inputValue).toContain("https://example.com/source");
		expect(prepared.inputValue).toContain(
			"## Current User Message\nWhat changed today?",
		);
		expect(prepared.prefetchedToolCalls).toEqual([
			expect.objectContaining({
				name: "research_web",
				status: "done",
				sourceType: "web",
				candidates: [
					expect.objectContaining({
						id: "source-1",
						title: "Official source",
						url: "https://example.com/source",
						sourceType: "web",
					}),
				],
				metadata: expect.objectContaining({
					serverPrefetched: true,
					sourceCount: 1,
				}),
			}),
		]);
	});
});
