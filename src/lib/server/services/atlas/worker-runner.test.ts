import { beforeEach, describe, expect, it, vi } from "vitest";

// Atlas runs pipeline v3 exclusively (Phase B of the v3-only consolidation).
// Dispatch here no longer branches on `pipelineVersion` — `claimNextAtlasJob`
// (job-ledger.ts, tested separately) already restamps every claimed row onto
// v3 regardless of what it was stamped at kickoff, so a queued row that used
// to be 1 or 2 simply runs fresh on v3.

const mocks = vi.hoisted(() => ({
	getConfig: vi.fn(),
	isModelEnabled: vi.fn(),
	recoverStaleAtlasJobs: vi.fn(async () => ({ recovered: 1 })),
	claimNextAtlasJob: vi.fn(),
	completeAtlasJob: vi.fn(async () => null),
	failAtlasJob: vi.fn(async () => true),
	heartbeatAtlasJob: vi.fn(async () => true),
	applyAtlasGeneratedTitle: vi.fn(async () => ({
		id: "atlas-job-1",
		conversationId: "conv-1",
		assistantMessageId: "assistant-1",
		action: "create",
		parentAtlasJobId: null,
		profile: "overview",
		title: "Generated Atlas title",
		status: "running",
		stage: "write",
		progress: { percent: 82, stage: "write", details: { queries: [] } },
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
	})),
	runAtlasV3PipelineForClaimedJob: vi.fn(),
	buildAtlasLifecycleContext: vi.fn(),
}));

vi.mock("$lib/server/config-store", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/server/config-store")>();
	return {
		...actual,
		getConfig: mocks.getConfig,
		isModelEnabled: mocks.isModelEnabled,
	};
});

vi.mock("./job-ledger", () => ({
	applyAtlasGeneratedTitle: mocks.applyAtlasGeneratedTitle,
	claimNextAtlasJob: mocks.claimNextAtlasJob,
	completeAtlasJob: mocks.completeAtlasJob,
	failAtlasJob: mocks.failAtlasJob,
	heartbeatAtlasJob: mocks.heartbeatAtlasJob,
	recoverStaleAtlasJobs: mocks.recoverStaleAtlasJobs,
}));

vi.mock("../atlas-v3/worker-bindings", () => ({
	runAtlasV3PipelineForClaimedJob: mocks.runAtlasV3PipelineForClaimedJob,
}));

vi.mock("../atlas-v3/types", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../atlas-v3/types")>();
	return actual;
});

vi.mock("./checkpoints", () => ({
	buildAtlasLifecycleContext: mocks.buildAtlasLifecycleContext,
	writeAtlasRoundCheckpoint: vi.fn(),
}));

function atlasJob(pipelineVersion: 1 | 2 | 3 = 3) {
	return {
		id: "atlas-job-1",
		conversationId: "conv-1",
		assistantMessageId: "assistant-1",
		action: "create",
		parentAtlasJobId: null,
		profile: "overview",
		pipelineVersion,
		title: "Atlas research",
		status: "running",
		stage: "ask",
		progress: { percent: 0, stage: "ask", details: { queries: [] } },
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

function v3PipelineResult() {
	return {
		status: "succeeded" as const,
		stage: "render" as const,
		pipelineVersion: 3 as const,
		title: "Atlas research",
		executiveSummaryMarkdown: "Report body.",
		abstained: false,
		outputs: {
			fileProductionJobId: "fp-job-1",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
		},
		usage: {
			inputTokens: 10,
			outputTokens: 5,
			totalTokens: 15,
			costUsdMicros: 25,
		},
		sourceCounts: { local: 1, web: 2, accepted: 3, rejected: 0 },
		diagnostics: {},
	};
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
			braveSearchApiKey: "test-brave-key",
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

	it.each([
		1, 2, 3,
	] as const)("runs a job stamped pipelineVersion %d on v3 and completes it through the ledger", async (stampedPipelineVersion) => {
		mocks.claimNextAtlasJob.mockResolvedValueOnce({
			job: atlasJob(stampedPipelineVersion),
			userId: "user-1",
			workerId: "atlas-worker-1",
		});
		mocks.runAtlasV3PipelineForClaimedJob.mockResolvedValueOnce(
			v3PipelineResult(),
		);
		const { executeNextAtlasJob } = await import("./worker-runner");

		const processed = await executeNextAtlasJob({
			workerId: "atlas-worker-1",
			now: new Date("2026-06-19T14:00:00.000Z"),
			resolveJobQuery: vi.fn(async () => ({
				query: "Research SvelteKit routing docs",
				userMessageId: "user-msg-1",
			})),
		});

		expect(processed).toBe(true);
		expect(mocks.runAtlasV3PipelineForClaimedJob).toHaveBeenCalledWith(
			expect.objectContaining({
				job: expect.objectContaining({
					id: "atlas-job-1",
					userId: "user-1",
					conversationId: "conv-1",
					query: "Research SvelteKit routing docs",
					kickoffUserMessageId: "user-msg-1",
					lifecycle: expect.objectContaining({
						family: expect.objectContaining({
							familyId: "atlas-job-1",
							mode: "new_family",
						}),
					}),
				}),
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
				stage: "render",
				progressPercent: 100,
				fileProductionJobId: "fp-job-1",
				htmlChatGeneratedFileId: "file-html",
				pdfChatGeneratedFileId: "file-pdf",
				markdownChatGeneratedFileId: "file-md",
			}),
		);
		expect(mocks.failAtlasJob).not.toHaveBeenCalled();
	});

	it("passes null kickoffUserMessageId through when the query cannot be traced to a user message", async () => {
		mocks.claimNextAtlasJob.mockResolvedValueOnce({
			job: atlasJob(),
			userId: "user-1",
			workerId: "atlas-worker-1",
		});
		mocks.runAtlasV3PipelineForClaimedJob.mockResolvedValueOnce(
			v3PipelineResult(),
		);
		const { executeNextAtlasJob } = await import("./worker-runner");

		await executeNextAtlasJob({
			workerId: "atlas-worker-1",
			now: new Date("2026-06-19T14:00:00.000Z"),
			resolveJobQuery: vi.fn(async () => ({
				query: "Research SvelteKit routing docs",
				userMessageId: null,
			})),
		});

		expect(mocks.runAtlasV3PipelineForClaimedJob).toHaveBeenCalledWith(
			expect.objectContaining({
				job: expect.objectContaining({ kickoffUserMessageId: null }),
			}),
		);
	});

	it("fails the job with the AtlasV3PipelineError code when the v3 pipeline throws one", async () => {
		mocks.claimNextAtlasJob.mockResolvedValueOnce({
			job: atlasJob(),
			userId: "user-1",
			workerId: "atlas-worker-1",
		});
		const { AtlasV3PipelineError } = await import("../atlas-v3/types");
		mocks.runAtlasV3PipelineForClaimedJob.mockRejectedValueOnce(
			new AtlasV3PipelineError(
				"atlas_v3_no_answer",
				"The report could not answer the question.",
			),
		);
		const { executeNextAtlasJob } = await import("./worker-runner");

		const processed = await executeNextAtlasJob({
			workerId: "atlas-worker-1",
			now: new Date("2026-06-19T14:00:00.000Z"),
			resolveJobQuery: vi.fn(async () => ({
				query: "Research SvelteKit routing docs",
				userMessageId: "user-msg-1",
			})),
		});

		expect(processed).toBe(true);
		expect(mocks.failAtlasJob).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: "atlas-job-1",
				workerId: "atlas-worker-1",
				errorCode: "atlas_v3_no_answer",
				errorMessage: "The report could not answer the question.",
				retryable: true,
			}),
		);
		expect(mocks.completeAtlasJob).not.toHaveBeenCalled();
	});

	it("falls back to a generic error code for an unrecognized failure", async () => {
		mocks.claimNextAtlasJob.mockResolvedValueOnce({
			job: atlasJob(),
			userId: "user-1",
			workerId: "atlas-worker-1",
		});
		mocks.runAtlasV3PipelineForClaimedJob.mockRejectedValueOnce(
			new Error("boom"),
		);
		const { executeNextAtlasJob } = await import("./worker-runner");

		await executeNextAtlasJob({
			workerId: "atlas-worker-1",
			now: new Date("2026-06-19T14:00:00.000Z"),
			resolveJobQuery: vi.fn(async () => ({
				query: "Research SvelteKit routing docs",
				userMessageId: "user-msg-1",
			})),
		});

		expect(mocks.failAtlasJob).toHaveBeenCalledWith(
			expect.objectContaining({
				errorCode: "atlas_pipeline_failed",
				errorMessage: "boom",
			}),
		);
	});

	it("keeps matching provider synthesis and audit configs on the provider model", async () => {
		const providerModel = "provider:deepseek-provider:deepseek-flash" as const;
		const config = {
			...mocks.getConfig(),
			atlasSynthesisModel: providerModel,
			atlasAuditModel: providerModel,
		};
		const { resolveAuditModelSelection } = await import("./worker-runner");

		expect(
			resolveAuditModelSelection({
				synthesisModel: providerModel,
				auditModel: providerModel,
				config,
			}),
		).toEqual({ modelSelection: providerModel, warning: null });
	});
});
