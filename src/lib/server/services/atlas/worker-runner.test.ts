import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getConfig: vi.fn(),
	isModelEnabled: vi.fn(),
	recoverStaleAtlasJobs: vi.fn(async () => ({ recovered: 1 })),
	claimNextAtlasJob: vi.fn(),
	completeAtlasJob: vi.fn(async () => null),
	failAtlasJob: vi.fn(async () => true),
	heartbeatAtlasJob: vi.fn(async () => true),
	runAtlasPipeline: vi.fn(),
	auditAtlasBasis: vi.fn(async (input) =>
		input.runAuditModel?.(input.assembledMarkdown),
	),
	buildAtlasLifecycleContext: vi.fn(),
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: mocks.getConfig,
	isModelEnabled: mocks.isModelEnabled,
}));

vi.mock("./job-ledger", () => ({
	claimNextAtlasJob: mocks.claimNextAtlasJob,
	completeAtlasJob: mocks.completeAtlasJob,
	failAtlasJob: mocks.failAtlasJob,
	heartbeatAtlasJob: mocks.heartbeatAtlasJob,
	recoverStaleAtlasJobs: mocks.recoverStaleAtlasJobs,
}));

vi.mock("./pipeline", () => ({
	runAtlasPipeline: mocks.runAtlasPipeline,
}));

vi.mock("./model-stage", () => ({
	runAtlasAuditStage: vi.fn(async () => ({
		text: '{"markers":[],"retryRequested":false}',
		usage: {
			inputTokens: 2,
			outputTokens: 1,
			totalTokens: 3,
			costUsdMicros: 0,
		},
		model: {
			modelId: "model2",
			providerId: "provider",
			displayName: "Audit",
		},
	})),
	runAtlasModelStage: vi.fn(),
}));

vi.mock("./quality-gates", () => ({
	auditAtlasBasis: mocks.auditAtlasBasis,
}));

vi.mock("./renderer-output", () => ({
	renderAtlasOutputs: vi.fn(),
}));

vi.mock("./search", () => ({
	runAtlasSearchStage: vi.fn(),
}));

vi.mock("./sources", () => ({
	resolveAtlasSources: vi.fn(),
	resolveAtlasSourcesForJob: vi.fn(),
}));

vi.mock("./checkpoints", () => ({
	buildAtlasLifecycleContext: mocks.buildAtlasLifecycleContext,
	writeAtlasRoundCheckpoint: vi.fn(),
}));

function atlasJob() {
	return {
		id: "atlas-job-1",
		conversationId: "conv-1",
		assistantMessageId: "assistant-1",
		action: "create",
		parentAtlasJobId: null,
		profile: "overview",
		title: "Atlas research",
		status: "running",
		stage: "decompose",
		progress: { percent: 5, stage: "decompose" },
		sourceCounts: { local: 0, web: 0, accepted: 0, rejected: 0 },
		usage: {
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			costUsdMicros: 0,
		},
		outputs: {
			fileProductionJobId: null,
			htmlChatGeneratedFileId: null,
			pdfChatGeneratedFileId: null,
			markdownChatGeneratedFileId: null,
		},
		error: null,
		createdAt: 1,
		updatedAt: 2,
		completedAt: null,
	} as const;
}

describe("Atlas worker runner", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		mocks.getConfig.mockReturnValue({
			atlasWorkerEnabled: true,
			atlasGlobalActiveLimit: 2,
			atlasSynthesisModel: "model1",
			atlasAuditModel: "model1",
			searxngBaseUrl: "http://searxng.local",
			model1: { baseUrl: "http://model1.local", modelName: "model-1" },
			model2: { baseUrl: "http://model2.local", modelName: "model-2" },
			model2Enabled: true,
			webPushVapidPublicKey: "",
			webPushVapidPrivateKey: "",
			webPushVapidSubject: "",
		});
		mocks.isModelEnabled.mockImplementation((modelId: string) => {
			return modelId === "model1" || modelId === "model2";
		});
		mocks.buildAtlasLifecycleContext.mockResolvedValue({
			family: {
				familyId: "atlas-job-1",
				mode: "new_family",
				action: "create",
				rootAtlasJobId: "atlas-job-1",
				currentAtlasJobId: "atlas-job-1",
				parentAtlasJobId: null,
				forkedFromAtlasJobId: null,
			},
			seed: null,
		});
	});

	it("startup recovers stale running jobs and wakes the drain loop with ATLAS logging", async () => {
		mocks.claimNextAtlasJob.mockResolvedValueOnce(null);
		const { ensureAtlasWorker } = await import("./worker-runner");

		await ensureAtlasWorker();
		await Promise.resolve();

		expect(mocks.recoverStaleAtlasJobs).toHaveBeenCalledWith({
			staleBefore: expect.any(Date),
		});
		expect(mocks.claimNextAtlasJob).toHaveBeenCalledWith(
			expect.objectContaining({
				workerId: expect.stringMatching(/^atlas:/),
				globalActiveLimit: 2,
			}),
		);
	});

	it("claims one job, runs the pipeline, and completes through the ledger", async () => {
		mocks.claimNextAtlasJob
			.mockResolvedValueOnce({
				job: atlasJob(),
				userId: "user-1",
				workerId: "atlas-worker-1",
			})
			.mockResolvedValueOnce(null);
		mocks.runAtlasPipeline.mockResolvedValueOnce({
			status: "succeeded",
			stage: "audit",
			outputs: {
				fileProductionJobId: "fp-job-1",
				htmlChatGeneratedFileId: "file-html",
				pdfChatGeneratedFileId: "file-pdf",
				markdownChatGeneratedFileId: "file-md",
			},
			audit: { honestyMarkers: [] },
			usage: {
				inputTokens: 10,
				outputTokens: 5,
				totalTokens: 15,
				costUsdMicros: 25,
			},
			sourceCounts: { local: 1, web: 2, accepted: 3, rejected: 0 },
		});
		const { executeNextAtlasJob } = await import("./worker-runner");

		const processed = await executeNextAtlasJob({
			workerId: "atlas-worker-1",
			now: new Date("2026-06-19T14:00:00.000Z"),
			resolveJobQuery: vi.fn(async () => "Research SvelteKit routing docs"),
		});

		expect(processed).toBe(true);
		expect(mocks.runAtlasPipeline).toHaveBeenCalledWith(
			expect.objectContaining({
				job: expect.objectContaining({
					id: "atlas-job-1",
					userId: "user-1",
					conversationId: "conv-1",
					query: "Research SvelteKit routing docs",
					lifecycle: expect.objectContaining({
						family: expect.objectContaining({
							familyId: "atlas-job-1",
							mode: "new_family",
						}),
					}),
				}),
			}),
		);
		const pipelineInput = mocks.runAtlasPipeline.mock.calls[0]?.[0];
		const audit = await pipelineInput.dependencies.auditBasis({
			assembledMarkdown: "Report",
			sources: [{ title: "Source", url: "https://example.com" }],
			limitation: null,
		});
		expect(audit).toEqual(
			expect.objectContaining({
				usage: expect.objectContaining({ totalTokens: 3 }),
			}),
		);
		expect(mocks.buildAtlasLifecycleContext).toHaveBeenCalledWith({
			jobId: "atlas-job-1",
			userId: "user-1",
			action: "create",
			parentAtlasJobId: null,
		});
		expect(mocks.completeAtlasJob).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: "atlas-job-1",
				workerId: "atlas-worker-1",
				stage: "audit",
				progressPercent: 100,
				fileProductionJobId: "fp-job-1",
				htmlChatGeneratedFileId: "file-html",
				pdfChatGeneratedFileId: "file-pdf",
				markdownChatGeneratedFileId: "file-md",
			}),
		);
		expect(mocks.failAtlasJob).not.toHaveBeenCalled();
	});
});
