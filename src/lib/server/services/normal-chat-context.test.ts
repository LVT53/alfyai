import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	buildConstructedContext: vi.fn(),
	buildProactiveConnectorContext: vi.fn(),
	getLatestValidContextCompressionSnapshot: vi.fn(),
	getConfig: vi.fn(),
	getSystemPrompt: vi.fn(),
	listContextCompressionSourceMessages: vi.fn(),
	fetchUrlViaParallel: vi.fn(),
	logAttachmentTrace: vi.fn(),
	researchWebViaParallel: vi.fn(),
	runContextCompression: vi.fn(),
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
	getLatestValidContextCompressionSnapshot:
		mocks.getLatestValidContextCompressionSnapshot,
	listContextCompressionSourceMessages:
		mocks.listContextCompressionSourceMessages,
	runContextCompression: mocks.runContextCompression,
}));

vi.mock("./parallel-search/research", () => ({
	researchWebViaParallel: mocks.researchWebViaParallel,
}));

vi.mock("./parallel-search/fetch-url", () => ({
	fetchUrlViaParallel: mocks.fetchUrlViaParallel,
}));

vi.mock("./chat-turn/proactive-connector-context", () => ({
	buildProactiveConnectorContext: mocks.buildProactiveConnectorContext,
}));

import {
	buildOutboundSystemPrompt,
	planNormalChatGuidancePacks,
	prepareOutboundChatContext,
} from "./normal-chat-context";
import {
	evaluateNormalChatContextPreparationSlowStageBudgets,
	getDefaultNormalChatContextPreparationPlan,
	NORMAL_CHAT_CONTEXT_PREPARATION_SLOW_STAGE_BUDGET_MS,
	type NormalChatContextPreparationActivity,
	type NormalChatContextPreparationStageId,
	type NormalChatContextPreparationStageTiming,
	runNormalChatContextPreparationStages,
} from "./normal-chat-context-preparation";

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

function createControlledPromise<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});

	return { promise, resolve, reject };
}

type ConstructedContextTestResult = {
	inputValue: string;
	contextStatus: unknown;
	taskState: unknown;
	contextDebug: unknown;
	contextTraceSections: unknown[];
	_reuseData: unknown;
};

function createConstructedContextResult(
	inputValue: string,
	overrides: Partial<ConstructedContextTestResult> = {},
): ConstructedContextTestResult {
	return {
		inputValue,
		contextStatus: undefined,
		taskState: null,
		contextDebug: null,
		contextTraceSections: [],
		_reuseData: undefined,
		...overrides,
	};
}

async function flushMicrotasks(count = 5) {
	for (let index = 0; index < count; index += 1) {
		await Promise.resolve();
	}
}

function createDeterministicClock(timestamps: number[]) {
	let index = 0;
	return () => {
		const timestamp = timestamps[index];
		if (timestamp === undefined) {
			throw new Error(`Deterministic clock exhausted at tick ${index}`);
		}
		index += 1;
		return timestamp;
	};
}

const compactContextLimits = {
	maxModelContext: 1_000,
	compactionUiThreshold: 800,
	targetConstructedContext: 900,
};

const budgetConstrainedModelConfig = {
	...modelConfig,
	maxTokens: 64,
};

function createLongPromptText(label: string) {
	return `${label} `.repeat(2_000);
}

function findBudgetDiagnosticPayload(warn: { mock: { calls: unknown[][] } }) {
	const call = warn.mock.calls.find(
		([message]) =>
			message === "[NORMAL_CHAT_CONTEXT] Outbound prompt budget applied",
	);
	return call?.[1] as Record<string, unknown> | undefined;
}

describe("normal chat context preparation stages", () => {
	it("defines the default preparation plan with parallel-safe dependencies", () => {
		const expectedStageIds: NormalChatContextPreparationStageId[] = [
			"plan",
			"constructed_context",
			"attachment_trace",
			"base_prompt",
			"system_prompt",
			"automatic_compression",
			"forced_web_prefetch",
			"proactive_connector_context",
			"prompt_budget",
		];

		const plan = getDefaultNormalChatContextPreparationPlan();

		expect(plan.stages.map((stage) => stage.id)).toEqual(expectedStageIds);
		expect(plan.stages.map((stage) => stage.dependsOn)).toEqual([
			[],
			["plan"],
			["constructed_context"],
			["plan"],
			["attachment_trace", "base_prompt"],
			["system_prompt"],
			["automatic_compression"],
			["forced_web_prefetch"],
			["proactive_connector_context"],
		]);
	});

	it("records stage activity and preserves the first thrown stage error", async () => {
		const activities: NormalChatContextPreparationActivity[] = [];

		await expect(
			runNormalChatContextPreparationStages({
				plan: {
					stages: [
						{ id: "plan", dependsOn: [] },
						{ id: "base_prompt", dependsOn: ["plan"] },
						{ id: "system_prompt", dependsOn: ["base_prompt"] },
					],
				},
				initialState: { steps: [] as string[] },
				handlers: {
					plan: (state) => ({ steps: [...state.steps, "plan"] }),
					base_prompt: () => {
						throw new Error("base prompt failed");
					},
					system_prompt: (state) => state,
				},
				onActivity: (activity) => activities.push(activity),
			}),
		).rejects.toThrow("base prompt failed");

		expect(
			activities.map((activity) => `${activity.stageId}:${activity.status}`),
		).toEqual([
			"plan:started",
			"plan:done",
			"base_prompt:started",
			"base_prompt:error",
		]);
		expect(activities.at(-1)).toEqual(
			expect.objectContaining({
				stageId: "base_prompt",
				status: "error",
				error: "base prompt failed",
			}),
		);
	});

	it("returns deterministic timing records for every completed stage", async () => {
		const result = await runNormalChatContextPreparationStages({
			plan: {
				stages: [
					{ id: "plan", dependsOn: [] },
					{ id: "base_prompt", dependsOn: ["plan"] },
				],
			},
			initialState: { steps: [] as string[] },
			handlers: {
				plan: (state) => ({ steps: [...state.steps, "plan"] }),
				base_prompt: (state) => ({ steps: [...state.steps, "base_prompt"] }),
			},
			now: createDeterministicClock([1_000, 1_005, 1_010, 1_025]),
		});

		expect(result.state.steps).toEqual(["plan", "base_prompt"]);
		expect(result.timings).toEqual([
			{
				stageId: "plan",
				activityClass: "planning",
				startedAt: 1_000,
				completedAt: 1_005,
				durationMs: 5,
				status: "done",
			},
			{
				stageId: "base_prompt",
				activityClass: "prompt-assembly",
				startedAt: 1_010,
				completedAt: 1_025,
				durationMs: 15,
				status: "done",
			},
		]);
	});

	it("exposes deterministic timing records for a failing started stage", async () => {
		let thrown: unknown;

		try {
			await runNormalChatContextPreparationStages({
				plan: {
					stages: [
						{ id: "plan", dependsOn: [] },
						{ id: "base_prompt", dependsOn: ["plan"] },
						{ id: "system_prompt", dependsOn: ["base_prompt"] },
					],
				},
				initialState: { steps: [] as string[] },
				handlers: {
					plan: (state) => ({ steps: [...state.steps, "plan"] }),
					base_prompt: () => {
						throw new Error("base prompt failed");
					},
					system_prompt: (state) => state,
				},
				now: createDeterministicClock([2_000, 2_008, 2_010, 2_017]),
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toBe("base prompt failed");
		expect(
			(
				thrown as Error & {
					contextPreparationTimings?: NormalChatContextPreparationStageTiming[];
				}
			).contextPreparationTimings,
		).toEqual([
			{
				stageId: "plan",
				activityClass: "planning",
				startedAt: 2_000,
				completedAt: 2_008,
				durationMs: 8,
				status: "done",
			},
			{
				stageId: "base_prompt",
				activityClass: "prompt-assembly",
				startedAt: 2_010,
				completedAt: 2_017,
				durationMs: 7,
				status: "error",
			},
		]);
	});

	it("classifies slow-stage budgets without changing stage execution", async () => {
		const promptAssemblyBudgetMs =
			NORMAL_CHAT_CONTEXT_PREPARATION_SLOW_STAGE_BUDGET_MS["prompt-assembly"];
		const result = await runNormalChatContextPreparationStages({
			plan: {
				stages: [
					{ id: "plan", dependsOn: [] },
					{ id: "base_prompt", dependsOn: ["plan"] },
					{ id: "system_prompt", dependsOn: ["base_prompt"] },
				],
			},
			initialState: { steps: [] as string[] },
			handlers: {
				plan: (state) => ({ steps: [...state.steps, "plan"] }),
				base_prompt: (state) => ({ steps: [...state.steps, "base_prompt"] }),
				system_prompt: (state) => ({
					steps: [...state.steps, "system_prompt"],
				}),
			},
			now: createDeterministicClock([
				1_000,
				1_005,
				2_000,
				2_000 + promptAssemblyBudgetMs,
				3_000,
				3_000 + promptAssemblyBudgetMs + 1,
			]),
		});

		expect(result.state.steps).toEqual([
			"plan",
			"base_prompt",
			"system_prompt",
		]);
		expect(() =>
			evaluateNormalChatContextPreparationSlowStageBudgets(result.timings),
		).not.toThrow();
		expect(
			evaluateNormalChatContextPreparationSlowStageBudgets(result.timings),
		).toEqual([
			{
				activityClass: "prompt-assembly",
				stageId: "system_prompt",
				timingMark: "context_preparation_primary_system_prompt",
				diagnosticKey:
					"prompt-assembly:context_preparation_primary_system_prompt",
				durationMs: promptAssemblyBudgetMs + 1,
				budgetMs: promptAssemblyBudgetMs,
				overByMs: 1,
			},
		]);
	});
});

describe("prepareOutboundChatContext", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getConfig.mockReturnValue({
			contextDiagnosticsDebug: false,
			parallelApiKey: "parallel-key",
		});
		mocks.getSystemPrompt.mockReturnValue("Base system prompt");
		mocks.getLatestValidContextCompressionSnapshot.mockResolvedValue(null);
		mocks.listContextCompressionSourceMessages.mockResolvedValue([]);
		mocks.runContextCompression.mockResolvedValue({
			id: "snapshot-1",
			status: "valid",
		});
		mocks.buildProactiveConnectorContext.mockResolvedValue(null);
		mocks.summarizeAttachmentSectionInInput.mockReturnValue({
			hasMarker: false,
			preview: "",
			previewHash: "",
		});
		const groundedWebResult = {
			query: "What changed today?",
			queries: [{ query: "What changed today?", purpose: "exact" }],
			sources: [
				{
					id: "source-1",
					provider: "parallel",
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
					provider: "parallel",
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
				providers: { parallelConfigured: true },
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
				fallbackReasons: [],
			},
		};
		mocks.researchWebViaParallel.mockResolvedValue(groundedWebResult);
		mocks.fetchUrlViaParallel.mockResolvedValue(groundedWebResult);
	});

	it("describes produce_file using direct AI SDK tool inputs without Langflow-era wording", () => {
		const prompt = buildOutboundSystemPrompt({
			basePrompt: "Base system prompt",
			inputValue: "Create a downloadable PDF and CSV.",
			modelDisplayName: "Provider Model",
		});

		expect(prompt).toContain(
			"Prefer `requestTitle`, `outputType`/`filename`, and `markdown`, `content`, or `text` in tool calls.",
		);
		expect(prompt).toContain("requestTitle");
		expect(prompt).toContain("filename");
		expect(prompt).toContain("markdown");
		expect(prompt).toContain("produce_file");
		expect(prompt).not.toMatch(/Langflow/i);
		expect(prompt).not.toContain("JSON string containing an array");
		expect(prompt).not.toContain("JSON-encoded array string");
		expect(prompt).not.toContain("current legacy external search flows");
	});

	describe("Connections framing (Redesign R8)", () => {
		it("omits the connections framing when hasActiveConnections is not set", () => {
			const prompt = buildOutboundSystemPrompt({
				basePrompt: "Base system prompt",
				inputValue: "What's on my schedule today?",
			});

			expect(prompt).not.toContain("Connected Accounts:");
		});

		it("omits the connections framing when hasActiveConnections is false", () => {
			const prompt = buildOutboundSystemPrompt({
				basePrompt: "Base system prompt",
				inputValue: "What's on my schedule today?",
				hasActiveConnections: false,
			});

			expect(prompt).not.toContain("Connected Accounts:");
		});

		it("includes a concise confirm-before-write connections framing when hasActiveConnections is true", () => {
			const prompt = buildOutboundSystemPrompt({
				basePrompt: "Base system prompt",
				inputValue: "What's on my schedule today?",
				hasActiveConnections: true,
			});

			expect(prompt).toContain("Connected Accounts:");
			expect(prompt).toContain(
				"You never modify a connected account immediately or autonomously",
			);
			expect(prompt).toContain("must explicitly confirm");
			expect(prompt).toContain("ask the user which one to use");
		});
	});

	describe("planNormalChatGuidancePacks", () => {
		it("keeps simple direct prompts compact and estimates savings versus full guidance", () => {
			const compactPlan = planNormalChatGuidancePacks({
				message: "Ping!",
				responseLanguage: "en",
			});

			expect(compactPlan.mode).toBe("compact");
			expect(compactPlan.selectedPackIds).toEqual([
				"runtime-core",
				"json-formatting",
				"tool-termination",
			]);
			expect(compactPlan.selectedPackTokenEstimate).toBeLessThan(
				compactPlan.fullPackTokenEstimate,
			);
			expect(compactPlan.estimatedTokenSavings).toBeGreaterThan(0);
		});

		it("keeps standalone Q&A prompts compact", () => {
			const twoPlusTwoPlan = planNormalChatGuidancePacks({
				message: "What is 2+2?",
				responseLanguage: "en",
			});
			expect(twoPlusTwoPlan.mode).toBe("compact");
			expect(twoPlusTwoPlan.selectedPackIds).toEqual([
				"runtime-core",
				"json-formatting",
				"tool-termination",
			]);
			expect(twoPlusTwoPlan.selectedPackIds).not.toContain("web-core");

			const whoAreYouPlan = planNormalChatGuidancePacks({
				message: "Who are you?",
				responseLanguage: "en",
			});
			expect(whoAreYouPlan.mode).toBe("compact");
			expect(whoAreYouPlan.selectedPackIds).toEqual([
				"runtime-core",
				"json-formatting",
				"tool-termination",
			]);
		});

		it("keeps benchmark test prompts with explicit non-tool constraints compact", () => {
			const plan = planNormalChatGuidancePacks({
				message:
					"Reply in one short sentence about safe benchmark prompts. Do not use external tools, web search, or files.",
				responseLanguage: "en",
			});

			expect(plan.mode).toBe("compact");
			expect(plan.selectedPackIds).toEqual([
				"runtime-core",
				"json-formatting",
				"tool-termination",
			]);
		});

		it("selects file guidance when a new-file request is detected", () => {
			const plan = planNormalChatGuidancePacks({
				message: "Can you turn this into a PDF for me?",
				responseLanguage: "en",
			});

			expect(plan.mode).toBe("compact");
			expect(plan.selectedPackIds).toEqual(
				expect.arrayContaining(["file-core"]),
			);
			expect(plan.selectedPackIds).not.toContain("file-detailed");
		});

		it("omits file guidance from full fallback prompts when file tools are unavailable", () => {
			const message =
				"Create a 30-day rollout plan for changing an AI model reasoning-depth setting. Include checkpoints, metrics, risks, rollback criteria, and who should review the data.";
			const plan = planNormalChatGuidancePacks({
				message,
				responseLanguage: "en",
				fileProductionToolsAvailable: false,
			});

			expect(plan.mode).toBe("full");
			expect(plan.selectedPackIds).not.toContain("file-core");
			expect(plan.selectedPackIds).not.toContain("file-detailed");
			expect(plan.fullPackIds).not.toContain("file-core");
			expect(plan.fullPackIds).not.toContain("file-detailed");

			const prompt = buildOutboundSystemPrompt({
				basePrompt: "Base system prompt",
				inputValue: message,
				responseLanguage: "en",
				fileProductionToolsAvailable: false,
			});

			expect(prompt).not.toContain("produce_file");
			expect(prompt).not.toContain("read_generated_file");
		});

		it("selects revision guidance for generated-file edits", () => {
			const plan = planNormalChatGuidancePacks({
				message: "Can you shorten the report we made?",
				responseLanguage: "en",
			});

			expect(plan.selectedPackIds).toEqual(
				expect.arrayContaining(["file-core", "file-detailed"]),
			);
		});

		it("selects web packs for source-backed current prompts", () => {
			const plan = planNormalChatGuidancePacks({
				message:
					"Is this still true today? Back it with a source and verify official policy.",
				responseLanguage: "en",
			});

			expect(plan.selectedPackIds).toEqual(
				expect.arrayContaining(["web-core", "web-detailed"]),
			);
		});

		it("selects web packs for release/freshness prompts", () => {
			const plan = planNormalChatGuidancePacks({
				message: "What is the latest SvelteKit release?",
				responseLanguage: "en",
			});

			expect(plan.selectedPackIds).toEqual(
				expect.arrayContaining(["web-core", "web-detailed"]),
			);
			expect(plan.mode).toBe("compact");
		});

		it("selects image guidance for venue image prompts", () => {
			const plan = planNormalChatGuidancePacks({
				message: "Show me what this venue looks like.",
				responseLanguage: "en",
			});

			expect(plan.selectedPackIds).toEqual(
				expect.arrayContaining(["image-search"]),
			);
			expect(plan.mode).toBe("compact");
		});

		it("selects memory guidance for project-folder continuity prompts", () => {
			const plan = planNormalChatGuidancePacks({
				message: "Use my previous notes from the project folder.",
				responseLanguage: "en",
			});

			expect(plan.selectedPackIds).toEqual(
				expect.arrayContaining(["memory-core"]),
			);
			expect(plan.mode).toBe("compact");
		});

		it("selects memory guidance for remember prompts", () => {
			const plan = planNormalChatGuidancePacks({
				message: "What do you remember about my bike setup?",
				responseLanguage: "en",
			});

			expect(plan.selectedPackIds).toEqual(
				expect.arrayContaining(["memory-core"]),
			);
		});

		it("falls back to conservative full guidance for ambiguous and high-stakes prompts", () => {
			const attachmentPlan = planNormalChatGuidancePacks({
				message:
					"Please review the attached legal contract and summarize the financial, policy, and compliance implications.",
				attachmentIds: ["att-1"],
				activeDocumentArtifactId: "doc-1",
				responseLanguage: "en",
			});

			expect(attachmentPlan.mode).toBe("full");
			expect(attachmentPlan.fallbackReason).toBe(
				"full_fallback_attachment_or_activity",
			);
			expect(attachmentPlan.selectedPackIds).toEqual(
				expect.arrayContaining(["runtime-core", "web-core", "memory-core"]),
			);
		});
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
		expect(prompt).not.toContain("Source budget");
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

	it("emits typed context preparation activity through the public preparation seam", async () => {
		const activities: NormalChatContextPreparationActivity[] = [];

		const prepared = await prepareOutboundChatContext({
			message: "Summarize the current conversation.",
			sessionId: "conv-1",
			modelConfig,
			modelId: "model1",
			contextLimits: {
				maxModelContext: 262_144,
				compactionUiThreshold: 209_715,
				targetConstructedContext: 157_286,
			},
			logLabel: "provider request",
			onContextPreparationActivity: (activity) => activities.push(activity),
		});

		const stageEvents = activities.map(
			(activity) => `${activity.stageId}:${activity.status}`,
		);
		const eventIndex = (event: string) => stageEvents.indexOf(event);

		expect(prepared.inputValue).toBe("Summarize the current conversation.");
		expect(stageEvents[0]).toBe("plan:started");
		expect(stageEvents.at(-1)).toBe("prompt_budget:done");
		expect(stageEvents).toEqual(
			expect.arrayContaining([
				"plan:started",
				"plan:done",
				"constructed_context:started",
				"constructed_context:done",
				"attachment_trace:started",
				"attachment_trace:done",
				"base_prompt:started",
				"base_prompt:done",
				"system_prompt:started",
				"system_prompt:done",
				"automatic_compression:started",
				"automatic_compression:done",
				"forced_web_prefetch:started",
				"forced_web_prefetch:done",
				"proactive_connector_context:started",
				"proactive_connector_context:done",
				"prompt_budget:started",
				"prompt_budget:done",
			]),
		);
		expect(eventIndex("attachment_trace:started")).toBeGreaterThan(
			eventIndex("constructed_context:done"),
		);
		expect(eventIndex("system_prompt:started")).toBeGreaterThan(
			eventIndex("attachment_trace:done"),
		);
		expect(eventIndex("system_prompt:started")).toBeGreaterThan(
			eventIndex("base_prompt:done"),
		);
		expect(eventIndex("proactive_connector_context:started")).toBeGreaterThan(
			eventIndex("forced_web_prefetch:done"),
		);
		expect(eventIndex("prompt_budget:started")).toBeGreaterThan(
			eventIndex("proactive_connector_context:done"),
		);
		expect(prepared.contextPreparationTimings).toHaveLength(9);
		expect(
			prepared.contextPreparationTimings?.map((timing) => ({
				stageId: timing.stageId,
				activityClass: timing.activityClass,
				status: timing.status,
				durationMs: timing.durationMs,
			})),
		).toEqual([
			{
				stageId: "plan",
				activityClass: "planning",
				status: "done",
				durationMs: expect.any(Number),
			},
			{
				stageId: "constructed_context",
				activityClass: "context-retrieval",
				status: "done",
				durationMs: expect.any(Number),
			},
			{
				stageId: "base_prompt",
				activityClass: "prompt-assembly",
				status: "done",
				durationMs: expect.any(Number),
			},
			{
				stageId: "attachment_trace",
				activityClass: "attachment-processing",
				status: "done",
				durationMs: expect.any(Number),
			},
			{
				stageId: "system_prompt",
				activityClass: "prompt-assembly",
				status: "done",
				durationMs: expect.any(Number),
			},
			{
				stageId: "automatic_compression",
				activityClass: "context-compression",
				status: "done",
				durationMs: expect.any(Number),
			},
			{
				stageId: "forced_web_prefetch",
				activityClass: "web-grounding",
				status: "done",
				durationMs: expect.any(Number),
			},
			{
				stageId: "proactive_connector_context",
				activityClass: "context-retrieval",
				status: "done",
				durationMs: expect.any(Number),
			},
			{
				stageId: "prompt_budget",
				activityClass: "budgeting",
				status: "done",
				durationMs: expect.any(Number),
			},
		]);
	});

	it("still rejects constructed context failures after independent base prompt setup may start", async () => {
		mocks.buildConstructedContext.mockRejectedValueOnce(
			new Error("constructed context unavailable"),
		);

		await expect(
			prepareOutboundChatContext({
				message: "Use my prior context.",
				sessionId: "conv-1",
				modelConfig,
				user: { id: "user-1" },
				modelId: "model1",
				contextLimits: {
					maxModelContext: 262_144,
					compactionUiThreshold: 209_715,
					targetConstructedContext: 157_286,
				},
				logLabel: "provider request",
			}),
		).rejects.toThrow("constructed context unavailable");

		expect(mocks.getSystemPrompt).toHaveBeenCalledWith("alfyai-nemotron");
		expect(mocks.logAttachmentTrace).not.toHaveBeenCalled();
	});

	it("starts base prompt setup before constructed context resolves when user context is enabled", async () => {
		const constructedContext =
			createControlledPromise<
				ReturnType<typeof createConstructedContextResult>
			>();
		const observedEvents: string[] = [];
		mocks.buildConstructedContext.mockImplementationOnce(() => {
			observedEvents.push("constructed_context_started");
			return constructedContext.promise;
		});
		mocks.getSystemPrompt.mockImplementationOnce((promptName) => {
			observedEvents.push(`base_prompt_started:${String(promptName)}`);
			return "Base system prompt";
		});

		const preparePromise = prepareOutboundChatContext({
			message: "Use my prior context.",
			sessionId: "conv-1",
			modelConfig,
			user: {
				id: "user-1",
				displayName: "Ada Lovelace",
				email: "ada@example.com",
			},
			modelId: "model1",
			contextLimits: {
				maxModelContext: 262_144,
				compactionUiThreshold: 209_715,
				targetConstructedContext: 157_286,
			},
			logLabel: "provider request",
		});
		await flushMicrotasks();
		const basePromptStartedBeforeConstructedResolved =
			mocks.getSystemPrompt.mock.calls.length > 0;

		constructedContext.resolve(
			createConstructedContextResult(
				"## Current User Message\nUse my prior context.",
			),
		);
		const prepared = await preparePromise;

		expect(observedEvents).toContain("constructed_context_started");
		expect(basePromptStartedBeforeConstructedResolved).toBe(true);
		expect(prepared.systemPrompt).toContain("Display Name: Ada Lovelace");
		expect(prepared.systemPrompt).toContain("Email: ada@example.com");
	});

	it("resolves context limits once before constructed context when caller does not provide explicit limits", async () => {
		const resolvedLimits = {
			maxModelContext: 262_144,
			compactionUiThreshold: 209_715,
			targetConstructedContext: 157_286,
		};
		mocks.getConfig.mockReturnValue({
			contextDiagnosticsDebug: false,
			systemPrompt: "configured-base",
			model1MaxModelContext: resolvedLimits.maxModelContext,
			model1CompactionUiThreshold: resolvedLimits.compactionUiThreshold,
			model1TargetConstructedContext: resolvedLimits.targetConstructedContext,
		});
		mocks.buildConstructedContext.mockResolvedValueOnce(
			createConstructedContextResult(
				"## Current User Message\nUse context limits.",
			),
		);

		const prepared = await prepareOutboundChatContext({
			message: "Use context limits.",
			sessionId: "conv-1",
			modelConfig,
			user: { id: "user-1" },
			modelId: "model1",
			logLabel: "provider request",
		});

		expect(mocks.buildConstructedContext).toHaveBeenCalledWith(
			expect.objectContaining({
				contextLimits: resolvedLimits,
			}),
		);
		expect(prepared.contextLimits).toEqual(resolvedLimits);
		expect(mocks.getConfig).toHaveBeenCalledTimes(1);
		expect(mocks.getSystemPrompt).toHaveBeenCalledWith("configured-base");
	});

	it("records a not-possible compression outcome when the user id is missing", async () => {
		mocks.getConfig.mockReturnValue({ contextDiagnosticsDebug: true });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		try {
			await prepareOutboundChatContext({
				message: createLongPromptText("anonymous context compression"),
				sessionId: "conv-1",
				modelConfig: budgetConstrainedModelConfig,
				modelId: "model1",
				contextLimits: compactContextLimits,
				compressionControlMessageSender: vi.fn() as never,
				logLabel: "provider request",
			});

			expect(mocks.buildConstructedContext).not.toHaveBeenCalled();
			expect(mocks.listContextCompressionSourceMessages).not.toHaveBeenCalled();
			expect(mocks.runContextCompression).not.toHaveBeenCalled();
			expect(findBudgetDiagnosticPayload(warn)).toEqual(
				expect.objectContaining({
					automaticCompressionOutcome: "not_possible",
					automaticCompressionAttempted: false,
					automaticCompressionReason: "missing_user",
				}),
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("records a not-possible compression outcome when the control sender is missing", async () => {
		mocks.getConfig.mockReturnValue({ contextDiagnosticsDebug: true });
		mocks.buildConstructedContext.mockResolvedValueOnce(
			createConstructedContextResult(
				`${createLongPromptText("constructed context")}\n\n## Current User Message\nCompress me.`,
			),
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		try {
			await prepareOutboundChatContext({
				message: "Compress me.",
				sessionId: "conv-1",
				modelConfig: budgetConstrainedModelConfig,
				user: { id: "user-1" },
				modelId: "model1",
				contextLimits: compactContextLimits,
				logLabel: "provider request",
			});

			expect(mocks.listContextCompressionSourceMessages).not.toHaveBeenCalled();
			expect(mocks.runContextCompression).not.toHaveBeenCalled();
			expect(findBudgetDiagnosticPayload(warn)).toEqual(
				expect.objectContaining({
					automaticCompressionOutcome: "not_possible",
					automaticCompressionAttempted: false,
					automaticCompressionReason: "missing_control_message_sender",
				}),
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("does not run automatic compression when the prompt and raw source fit", async () => {
		mocks.buildConstructedContext.mockResolvedValueOnce(
			createConstructedContextResult(
				"## Current User Message\nKeep this small.",
			),
		);
		mocks.listContextCompressionSourceMessages.mockResolvedValueOnce([
			{
				messageSequence: 1,
				role: "user",
				content: "Small earlier context.",
				thinking: null,
				toolCalls: null,
			},
		]);

		const prepared = await prepareOutboundChatContext({
			message: "Keep this small.",
			sessionId: "conv-1",
			modelConfig,
			user: { id: "user-1" },
			modelId: "model1",
			contextLimits: {
				maxModelContext: 262_144,
				compactionUiThreshold: 209_715,
				targetConstructedContext: 157_286,
			},
			compressionControlMessageSender: vi.fn() as never,
			logLabel: "provider request",
		});

		expect(prepared.inputValue).toBe(
			"## Current User Message\nKeep this small.",
		);
		expect(mocks.listContextCompressionSourceMessages).toHaveBeenCalledWith(
			"conv-1",
		);
		expect(mocks.runContextCompression).not.toHaveBeenCalled();
		expect(mocks.buildConstructedContext).toHaveBeenCalledTimes(1);
	});

	it("records a failed compression outcome and continues with fallback prompt budgeting", async () => {
		mocks.getConfig.mockReturnValue({ contextDiagnosticsDebug: true });
		mocks.buildConstructedContext.mockResolvedValueOnce(
			createConstructedContextResult(
				`${createLongPromptText("constructed context")}\n\n## Current User Message\nCompress me.`,
			),
		);
		mocks.listContextCompressionSourceMessages.mockResolvedValueOnce([
			{
				messageSequence: 1,
				role: "user",
				content: createLongPromptText("source message"),
				thinking: null,
				toolCalls: null,
			},
		]);
		mocks.runContextCompression.mockRejectedValueOnce(
			new Error("compression model unavailable"),
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		try {
			await expect(
				prepareOutboundChatContext({
					message: "Compress me.",
					sessionId: "conv-1",
					modelConfig: budgetConstrainedModelConfig,
					user: { id: "user-1" },
					modelId: "model1",
					contextLimits: compactContextLimits,
					compressionControlMessageSender: vi.fn() as never,
					logLabel: "provider request",
				}),
			).resolves.toEqual(
				expect.objectContaining({
					inputValue: expect.stringContaining("## Current User Message"),
				}),
			);

			expect(warn).toHaveBeenCalledWith(
				"[NORMAL_CHAT_CONTEXT] Automatic context compression skipped",
				expect.objectContaining({
					sessionId: "conv-1",
					error: "compression model unavailable",
				}),
			);
			expect(findBudgetDiagnosticPayload(warn)).toEqual(
				expect.objectContaining({
					automaticCompressionOutcome: "failed",
					automaticCompressionAttempted: true,
					automaticCompressionReason: "compression model unavailable",
				}),
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("rebuilds context with reuse data and system prompt after automatic compression succeeds", async () => {
		const compressedInput = [
			"## Compressed Context",
			"https://compressed.example/source",
			"",
			"## Current User Message",
			"Summarize this context.",
		].join("\n");
		const reuseData = {
			relevantArtifacts: [],
			preparedContext: null,
			artifactSnippets: new Map(),
		};
		const compressedStatus = { status: "compressed" };
		const compressedDebug = { route: "compressed-context" };
		mocks.buildConstructedContext
			.mockResolvedValueOnce(
				createConstructedContextResult(
					"## Current User Message\nSummarize this context.",
					{ _reuseData: reuseData },
				),
			)
			.mockResolvedValueOnce(
				createConstructedContextResult(compressedInput, {
					contextStatus: compressedStatus,
					contextDebug: compressedDebug,
				}),
			);
		mocks.listContextCompressionSourceMessages.mockResolvedValueOnce([
			{
				messageSequence: 1,
				role: "user",
				content: "Earlier conversation context. ".repeat(20_000),
				thinking: null,
				toolCalls: null,
			},
		]);

		const prepared = await prepareOutboundChatContext({
			message: "Summarize this context.",
			sessionId: "conv-1",
			modelConfig,
			user: { id: "user-1" },
			modelId: "model1",
			contextLimits: {
				maxModelContext: 50_000,
				compactionUiThreshold: 40_000,
				targetConstructedContext: 20_000,
			},
			compressionControlMessageSender: vi.fn() as never,
			logLabel: "provider request",
		});

		expect(mocks.buildConstructedContext).toHaveBeenCalledTimes(2);
		expect(mocks.buildConstructedContext).toHaveBeenLastCalledWith(
			expect.objectContaining({
				reuseFrom: reuseData,
			}),
		);
		expect(prepared.inputValue).toBe(compressedInput);
		expect(prepared.contextStatus).toBe(compressedStatus);
		expect(prepared.contextDebug).toBe(compressedDebug);
		expect(prepared.systemPrompt).toContain("Tool Termination:");
		expect(prepared.systemPrompt).toContain(
			"Tool JSON formatting rules — all tool arguments MUST be valid JSON:",
		);
	});

	it("returns guidance-pack diagnostics without exposing prompt body", async () => {
		const prepared = await prepareOutboundChatContext({
			message: "Ping!",
			sessionId: "conv-1",
			modelConfig,
			modelId: "model1",
			contextLimits: {
				maxModelContext: 262_144,
				compactionUiThreshold: 209_715,
				targetConstructedContext: 157_286,
			},
			logLabel: "provider request",
		});

		expect(prepared.promptPackPlan).toEqual(
			expect.objectContaining({
				mode: "compact",
				selectedPackIds: [
					"runtime-core",
					"json-formatting",
					"tool-termination",
				],
				fullPackIds: expect.any(Array),
				selectedPackTokenEstimate: expect.any(Number),
				fullPackTokenEstimate: expect.any(Number),
				estimatedTokenSavings: expect.any(Number),
				fallbackReason: expect.any(String),
			}),
		);
		expect(prepared.promptPackPlan?.estimatedTokenSavings).toBeGreaterThan(0);
	});

	it("prefetches forced web search before the current user message through the neutral Normal Chat context boundary", async () => {
		const prepared = await prepareOutboundChatContext({
			message: "What changed today?",
			sessionId: "conv-1",
			modelConfig,
			forceWebSearch: true,
			modelId: "model1",
			contextLimits: {
				maxModelContext: 262_144,
				compactionUiThreshold: 209_715,
				targetConstructedContext: 157_286,
			},
			logLabel: "provider request",
		});

		expect(mocks.researchWebViaParallel).toHaveBeenCalledWith(
			expect.objectContaining({ query: "What changed today?" }),
			expect.objectContaining({
				config: { parallelApiKey: "parallel-key" },
			}),
		);
		expect(prepared.inputValue.indexOf("## Current Web Research")).toBeLessThan(
			prepared.inputValue.indexOf("## Current User Message"),
		);
		expect(prepared.inputValue).toContain("https://example.com/source");
		expect(prepared.inputValue).toContain(
			"## Current User Message\nWhat changed today?",
		);
		expect(prepared.systemPrompt).toContain("Web research workflow:");
		expect(prepared.systemPrompt).toContain(
			"Current-turn forced web retrieval:",
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
				outputSummary: expect.stringContaining("Web research returned"),
			}),
		]);
	});

	it("prefetches pasted URLs before the model run so URL questions are grounded", async () => {
		const url = "https://example.com/source";

		const prepared = await prepareOutboundChatContext({
			message: `What does this page say? ${url}`,
			sessionId: "conv-1",
			modelConfig,
			modelId: "model1",
			contextLimits: {
				maxModelContext: 262_144,
				compactionUiThreshold: 209_715,
				targetConstructedContext: 157_286,
			},
			logLabel: "provider request",
		});

		expect(mocks.fetchUrlViaParallel).toHaveBeenCalledWith(
			expect.objectContaining({ urls: [url] }),
			expect.objectContaining({
				config: { parallelApiKey: "parallel-key" },
			}),
		);
		expect(mocks.researchWebViaParallel).not.toHaveBeenCalled();
		expect(prepared.inputValue).toContain("## Current Web Research");
		expect(prepared.inputValue).toContain(
			"Server-prefetched page content for the pasted URL",
		);
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

	it("warns and continues with the original input when forced web prefetch fails", async () => {
		mocks.researchWebViaParallel.mockRejectedValueOnce(
			new Error("search backend down"),
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		try {
			const prepared = await prepareOutboundChatContext({
				message: "What changed today?",
				sessionId: "conv-1",
				modelConfig,
				forceWebSearch: true,
				modelId: "model1",
				contextLimits: {
					maxModelContext: 262_144,
					compactionUiThreshold: 209_715,
					targetConstructedContext: 157_286,
				},
				logLabel: "provider request",
			});

			expect(prepared.inputValue).toBe("What changed today?");
			expect(prepared.prefetchedToolCalls).toEqual([]);
			expect(warn).toHaveBeenCalledWith(
				"[NORMAL_CHAT_CONTEXT] Web prefetch failed",
				expect.objectContaining({
					sessionId: "conv-1",
					modelId: "model1",
					prefetchReason: "forced_search",
					error: "search backend down",
				}),
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("rebuilds the system prompt after forced prefetch injects web context", async () => {
		const prepared = await prepareOutboundChatContext({
			message: "What changed today?",
			sessionId: "conv-1",
			modelConfig,
			forceWebSearch: true,
			modelId: "model1",
			contextLimits: {
				maxModelContext: 262_144,
				compactionUiThreshold: 209_715,
				targetConstructedContext: 157_286,
			},
			logLabel: "provider request",
		});

		expect(prepared.systemPrompt).toContain("Web research workflow:");
		expect(prepared.systemPrompt).toContain(
			"Current-turn forced web retrieval:",
		);
	});

	it("applies prompt budgeting after forced web prefetch and keeps output token budget fields", async () => {
		mocks.getConfig.mockReturnValue({ contextDiagnosticsDebug: true });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		try {
			const prepared = await prepareOutboundChatContext({
				message: "What changed today?",
				sessionId: "conv-1",
				modelConfig: budgetConstrainedModelConfig,
				forceWebSearch: true,
				modelId: "model1",
				contextLimits: compactContextLimits,
				logLabel: "provider request",
			});

			const budgetDiagnostic = findBudgetDiagnosticPayload(warn);
			expect(budgetDiagnostic).toEqual(
				expect.objectContaining({
					sessionId: "conv-1",
					automaticCompressionOutcome: "not_possible",
					automaticCompressionAttempted: false,
					automaticCompressionReason: "missing_user",
				}),
			);
			expect(budgetDiagnostic?.beforeInputTokens).toBeGreaterThan(
				budgetDiagnostic?.afterInputTokens as number,
			);
			expect(prepared.inputValue).not.toContain("## Current Web Research");
			expect(prepared.inputValue).toContain(
				"## Current User Message\nWhat changed today?",
			);
			expect(prepared.prefetchedToolCalls).toHaveLength(1);
			expect(prepared.outputTokenBudget).toEqual(
				expect.objectContaining({
					configuredMaxTokens: 64,
					effectiveMaxTokens: expect.any(Number),
					outputReserve: expect.any(Number),
					outputReserveClamped: expect.any(Boolean),
				}),
			);
		} finally {
			warn.mockRestore();
		}
	});

	describe("proactive_connector_context stage (Issue 8.1)", () => {
		const stageContextLimits = {
			maxModelContext: 262_144,
			compactionUiThreshold: 209_715,
			targetConstructedContext: 157_286,
		};

		it("injects the block returned by buildProactiveConnectorContext before the current user message", async () => {
			mocks.buildProactiveConnectorContext.mockResolvedValue({
				block:
					"## Your calendar & mail (live)\n\nCalendar (next 48h):\n- 2026-07-09 15:00–15:30 — Team sync",
			});
			mocks.buildConstructedContext.mockResolvedValueOnce(
				createConstructedContextResult("Do I have any meetings today?"),
			);

			const prepared = await prepareOutboundChatContext({
				message: "Do I have any meetings today?",
				sessionId: "conv-1",
				modelConfig,
				user: { id: "user-1" },
				modelId: "model1",
				activeConnectionCapabilities: new Set(["calendar"]),
				contextLimits: stageContextLimits,
				logLabel: "provider request",
			});

			expect(mocks.buildProactiveConnectorContext).toHaveBeenCalledWith(
				expect.objectContaining({
					userId: "user-1",
					conversationId: "conv-1",
					modelId: "model1",
					message: "Do I have any meetings today?",
					activeCapabilities: new Set(["calendar"]),
				}),
			);
			expect(
				prepared.inputValue.indexOf("## Your calendar & mail (live)"),
			).toBeGreaterThanOrEqual(0);
			expect(
				prepared.inputValue.indexOf("## Your calendar & mail (live)"),
			).toBeLessThan(prepared.inputValue.indexOf("## Current User Message"));
			expect(prepared.inputValue).toContain("Team sync");
		});

		it("does not call buildProactiveConnectorContext when no capability set is provided", async () => {
			mocks.buildConstructedContext.mockResolvedValueOnce(
				createConstructedContextResult("Do I have any meetings today?"),
			);
			await prepareOutboundChatContext({
				message: "Do I have any meetings today?",
				sessionId: "conv-1",
				modelConfig,
				user: { id: "user-1" },
				modelId: "model1",
				contextLimits: stageContextLimits,
				logLabel: "provider request",
			});

			expect(mocks.buildProactiveConnectorContext).not.toHaveBeenCalled();
		});

		it("does not call buildProactiveConnectorContext when the active set has neither calendar nor email", async () => {
			mocks.buildConstructedContext.mockResolvedValueOnce(
				createConstructedContextResult("Do I have any meetings today?"),
			);
			await prepareOutboundChatContext({
				message: "Do I have any meetings today?",
				sessionId: "conv-1",
				modelConfig,
				user: { id: "user-1" },
				modelId: "model1",
				activeConnectionCapabilities: new Set(["files"] as never),
				contextLimits: stageContextLimits,
				logLabel: "provider request",
			});

			expect(mocks.buildProactiveConnectorContext).not.toHaveBeenCalled();
		});

		it("does not call buildProactiveConnectorContext without an authenticated user", async () => {
			const prepared = await prepareOutboundChatContext({
				message: "Do I have any meetings today?",
				sessionId: "conv-1",
				modelConfig,
				modelId: "model1",
				activeConnectionCapabilities: new Set(["calendar"]),
				contextLimits: stageContextLimits,
				logLabel: "provider request",
			});

			expect(mocks.buildProactiveConnectorContext).not.toHaveBeenCalled();
			expect(prepared.inputValue).not.toContain(
				"## Your calendar & mail (live)",
			);
		});

		it("injects nothing when buildProactiveConnectorContext resolves null (capability active but message not relevant, or nothing to show)", async () => {
			mocks.buildProactiveConnectorContext.mockResolvedValue(null);
			mocks.buildConstructedContext.mockResolvedValueOnce(
				createConstructedContextResult("Write me a poem about the ocean"),
			);

			const prepared = await prepareOutboundChatContext({
				message: "Write me a poem about the ocean",
				sessionId: "conv-1",
				modelConfig,
				user: { id: "user-1" },
				modelId: "model1",
				activeConnectionCapabilities: new Set(["calendar", "email"]),
				contextLimits: stageContextLimits,
				logLabel: "provider request",
			});

			expect(prepared.inputValue).not.toContain(
				"## Your calendar & mail (live)",
			);
		});

		it("rebuilds the system prompt after the proactive connector context injects a block", async () => {
			mocks.buildProactiveConnectorContext.mockResolvedValue({
				block:
					"## Your calendar & mail (live)\n\nCalendar (next 48h):\n- 2026-07-09 15:00–15:30 — Team sync",
			});
			mocks.buildConstructedContext.mockResolvedValueOnce(
				createConstructedContextResult("Do I have any meetings today?"),
			);

			const prepared = await prepareOutboundChatContext({
				message: "Do I have any meetings today?",
				sessionId: "conv-1",
				modelConfig,
				user: { id: "user-1" },
				modelId: "model1",
				activeConnectionCapabilities: new Set(["calendar"]),
				contextLimits: stageContextLimits,
				logLabel: "provider request",
			});

			expect(prepared.systemPrompt).toContain("Base system prompt");
		});

		it("silently continues (never throws, never breaks the turn) when buildProactiveConnectorContext rejects", async () => {
			mocks.buildProactiveConnectorContext.mockRejectedValue(
				new Error("connector fetch exploded"),
			);
			mocks.buildConstructedContext.mockResolvedValueOnce(
				createConstructedContextResult("Do I have any meetings today?"),
			);
			const warn = vi
				.spyOn(console, "warn")
				.mockImplementation(() => undefined);

			try {
				const prepared = await prepareOutboundChatContext({
					message: "Do I have any meetings today?",
					sessionId: "conv-1",
					modelConfig,
					user: { id: "user-1" },
					modelId: "model1",
					activeConnectionCapabilities: new Set(["calendar"]),
					contextLimits: stageContextLimits,
					logLabel: "provider request",
				});

				expect(prepared.inputValue).not.toContain(
					"## Your calendar & mail (live)",
				);
				expect(warn).toHaveBeenCalledWith(
					"[NORMAL_CHAT_CONTEXT] Proactive connector context skipped",
					expect.objectContaining({
						sessionId: "conv-1",
						modelId: "model1",
						error: "connector fetch exploded",
					}),
				);
			} finally {
				warn.mockRestore();
			}
		});

		it("combines with a forced web prefetch in the same turn without either clobbering the other", async () => {
			mocks.buildProactiveConnectorContext.mockResolvedValue({
				block:
					"## Your calendar & mail (live)\n\nCalendar (next 48h):\n- 2026-07-09 15:00–15:30 — Team sync",
			});
			mocks.buildConstructedContext.mockResolvedValueOnce(
				createConstructedContextResult(
					"What changed today, and do I have any meetings?",
				),
			);

			const prepared = await prepareOutboundChatContext({
				message: "What changed today, and do I have any meetings?",
				sessionId: "conv-1",
				modelConfig,
				user: { id: "user-1" },
				forceWebSearch: true,
				modelId: "model1",
				activeConnectionCapabilities: new Set(["calendar"]),
				contextLimits: stageContextLimits,
				logLabel: "provider request",
			});

			expect(prepared.inputValue).toContain("## Current Web Research");
			expect(prepared.inputValue).toContain("## Your calendar & mail (live)");
			expect(
				prepared.inputValue.indexOf("## Current Web Research"),
			).toBeLessThan(prepared.inputValue.indexOf("## Current User Message"));
			expect(
				prepared.inputValue.indexOf("## Your calendar & mail (live)"),
			).toBeLessThan(prepared.inputValue.indexOf("## Current User Message"));
		});
	});

	describe("Connections framing gating (Redesign R8)", () => {
		it("includes the connections framing in the system prompt when the user has an active connection capability", async () => {
			mocks.buildConstructedContext.mockResolvedValueOnce(
				createConstructedContextResult("Save this file to my Nextcloud."),
			);

			const prepared = await prepareOutboundChatContext({
				message: "Save this file to my Nextcloud.",
				sessionId: "conv-1",
				modelConfig,
				user: { id: "user-1" },
				modelId: "model1",
				activeConnectionCapabilities: new Set(["files"]),
				logLabel: "provider request",
			});

			expect(prepared.systemPrompt).toContain("Connected Accounts:");
		});

		it("omits the connections framing when no connection capabilities are active", async () => {
			mocks.buildConstructedContext.mockResolvedValueOnce(
				createConstructedContextResult("What's the weather like today?"),
			);

			const prepared = await prepareOutboundChatContext({
				message: "What's the weather like today?",
				sessionId: "conv-1",
				modelConfig,
				user: { id: "user-1" },
				modelId: "model1",
				logLabel: "provider request",
			});

			expect(prepared.systemPrompt).not.toContain("Connected Accounts:");
		});

		it("omits the connections framing when the active capability set is empty", async () => {
			mocks.buildConstructedContext.mockResolvedValueOnce(
				createConstructedContextResult("What's the weather like today?"),
			);

			const prepared = await prepareOutboundChatContext({
				message: "What's the weather like today?",
				sessionId: "conv-1",
				modelConfig,
				user: { id: "user-1" },
				modelId: "model1",
				activeConnectionCapabilities: new Set(),
				logLabel: "provider request",
			});

			expect(prepared.systemPrompt).not.toContain("Connected Accounts:");
		});
	});
});
