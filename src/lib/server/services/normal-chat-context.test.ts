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
			query: "What changed today?",
			queries: [{ query: "What changed today?", purpose: "exact" }],
			sources: [
				{
					id: "source-1",
					provider: "searxng",
					title: "Official source",
					url: "https://example.com/source",
					canonicalUrl: "https://example.com/source",
					snippet: "Official update details.",
					highlights: ["Official update details."],
					text: null,
					score: 0.9,
					providerRank: 1,
					query: "What changed today?",
					publishedAt: null,
					updatedAt: null,
					retrievedAt: "2026-06-05T10:00:00.000Z",
					authorityClass: "official",
					authorityScore: 95,
				},
			],
			evidence: [
				{
					id: "evidence-1",
					sourceId: "source-1",
					title: "Official source",
					url: "https://example.com/source",
					provider: "searxng",
					quote: "Official update details.",
					surroundingText: "Official update details.",
					score: 0.9,
					authorityScore: 95,
				},
			],
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
				evidence: [
					{
						ref: "E1",
						evidenceId: "evidence-1",
						sourceRef: "S1",
						sourceId: "source-1",
						title: "Official source",
						url: "https://example.com/source",
						quote: "Official update details.",
						score: 0.9,
					},
				],
			},
			diagnostics: {
				mode: "exact",
				freshness: "live",
				sourcePolicy: "general",
				providers: { searxngConfigured: true },
				plannedQueryCount: 1,
				directUrlCount: 0,
				fetchedSourceCount: 1,
				fusedSourceCount: 1,
				selectedSourceCount: 1,
				providerCalls: [],
				contentCharBudget: 12000,
				openedPageCount: 1,
				sourceReranked: false,
				evidenceCandidateCount: 1,
				exactEvidenceCandidateCount: 0,
				reranked: false,
				youtubeTranscriptCandidateCount: 0,
				youtubeTranscriptFetchedCount: 0,
				youtubeTranscriptFailedCount: 0,
				youtubeTranscriptErrors: [],
				fallbackReasons: [],
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
			"Prefer the simple form: `requestTitle`, `outputType` or `filename`, and `markdown`, `content`, or `text`.",
		);
		expect(prompt).toContain(
			'"requestTitle": "News summary", "filename": "hungarian-parliament-news.md", "markdown": "# Hungarian Parliament News\\n\\n## Latest Session\\n\\nThe parliament passed..."',
		);
		expect(prompt).toContain(
			"It handles searching, page fetching, evidence extraction, and answer-brief assembly in one call — there is no separate search or fetch step.",
		);
		expect(prompt).not.toMatch(/Langflow/i);
		expect(prompt).not.toContain("JSON string containing an array");
		expect(prompt).not.toContain("JSON-encoded array string");
		expect(prompt).not.toContain("current legacy external search flows");
	});

	it("adds depth grounding guidance without forcing web search", () => {
		const prompt = buildOutboundSystemPrompt({
			basePrompt: "Base system prompt",
			inputValue: "Compare current release options.",
			modelDisplayName: "Provider Model",
			forceWebSearch: false,
			reasoningDepthEffort: {
				depthMetadata: {
					requested: "auto",
					appliedProfile: "maximum",
					fallback: false,
				},
				webSourceBudget: {
					maxSources: 12,
					sourceExpansion: true,
				},
				maxToolSteps: 28,
				grounding: {
					guidance: "strict",
					externalEvidence: "required",
					forceWebSearch: false,
				},
			} as never,
		});

		expect(prompt).toContain("Applied Normal Chat profile: maximum");
		expect(prompt).toContain("does not force web search");
		expect(prompt).toContain("Maximum-depth reasoning contract");
		expect(prompt).toContain(
			"deliberately spend extra private reasoning effort",
		);
		expect(prompt).toContain("edge cases, likely failure modes, and tradeoffs");
		expect(prompt).toContain(
			"test the strongest candidate answer against alternatives",
		);
		expect(prompt).toContain(
			"Do not expose chain-of-thought or scratchpad reasoning",
		);
		expect(prompt).toContain("you may use up to 12 sources");
		expect(prompt).not.toContain("Current-turn forced web retrieval");
	});

	it("removes GPT-OSS reasoning directives for explicit Off depth", () => {
		const promptWithExistingDirective = buildOutboundSystemPrompt({
			basePrompt: "Base system prompt\nReasoning: high\nStay concise.",
			inputValue: "Answer briefly.",
			modelName: "gpt-oss-120b",
			reasoningDepthEffort: {
				depthMetadata: {
					requested: "off",
					appliedProfile: "off",
					fallback: false,
				},
				providerReasoning: {
					thinkingMode: "off",
					supported: true,
					constrained: false,
				},
				webSourceBudget: {
					maxSources: 4,
					sourceExpansion: false,
				},
				maxToolSteps: 8,
				grounding: {
					guidance: "minimal",
					externalEvidence: "none",
					forceWebSearch: false,
				},
			} as never,
		});
		const promptWithoutExistingDirective = buildOutboundSystemPrompt({
			basePrompt: "Base system prompt",
			inputValue: "Answer briefly.",
			modelName: "gpt-oss-120b",
			reasoningDepthEffort: {
				depthMetadata: {
					requested: "off",
					appliedProfile: "off",
					fallback: false,
				},
				providerReasoning: {
					thinkingMode: "off",
					supported: true,
					constrained: false,
				},
				webSourceBudget: {
					maxSources: 4,
					sourceExpansion: false,
				},
				maxToolSteps: 8,
				grounding: {
					guidance: "minimal",
					externalEvidence: "none",
					forceWebSearch: false,
				},
			} as never,
		});

		expect(promptWithExistingDirective).not.toMatch(/^Reasoning:\s*high/im);
		expect(promptWithExistingDirective).not.toMatch(/^Reasoning:\s*medium/im);
		expect(promptWithExistingDirective).not.toMatch(/^Reasoning:\s*low/im);
		expect(promptWithExistingDirective).toContain("Stay concise.");
		expect(promptWithoutExistingDirective).not.toMatch(/^Reasoning:/im);
	});

	it("keeps GPT-OSS high reasoning directive for maximum depth", () => {
		const prompt = buildOutboundSystemPrompt({
			basePrompt: "Base system prompt\nReasoning: low\nUse constraints.",
			inputValue: "Investigate carefully.",
			modelDisplayName: "GPT OSS 120B",
			reasoningDepthEffort: {
				depthMetadata: {
					requested: "max",
					appliedProfile: "maximum",
					fallback: false,
				},
				providerReasoning: {
					thinkingMode: "on",
					reasoningEffort: "high",
					supported: true,
					constrained: false,
				},
				webSourceBudget: {
					maxSources: 12,
					sourceExpansion: true,
				},
				maxToolSteps: 28,
				grounding: {
					guidance: "strict",
					externalEvidence: "required",
					forceWebSearch: false,
				},
			} as never,
		});

		expect(prompt).toMatch(/^Reasoning:\s*high/im);
		expect(prompt).not.toMatch(/^Reasoning:\s*low/im);
		expect(prompt).toContain("Applied Normal Chat profile: maximum");
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
					prefetchReason: "forced_search",
					sourceCount: 1,
					evidenceReady: true,
				}),
			}),
		]);
	});

	it("prefetches pasted URLs before the model run so URL questions are grounded", async () => {
		const url = "https://example.com/source";

		const prepared = await prepareOutboundChatContext({
			message: `What does this page say? ${url}`,
			sessionId: "conv-1",
			modelConfig,
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
				query: `What does this page say? ${url}`,
				mode: "exact",
				freshness: "live",
			}),
		);
		expect(prepared.inputValue).toContain("## Current Web Research");
		expect(prepared.inputValue).toContain("because the user pasted a URL");
		expect(prepared.inputValue).toContain(url);
		expect(prepared.prefetchedToolCalls).toEqual([
			expect.objectContaining({
				name: "research_web",
				status: "done",
				sourceType: "web",
				metadata: expect.objectContaining({
					serverPrefetched: true,
					prefetchReason: "pasted_url",
					evidenceReady: true,
				}),
			}),
		]);
	});
});
