import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import {
	createJobsFixture,
	type JobsFixture,
} from "$lib/server/services/jobs/testing/fixture";
import { createPreEngineAtlasDatabase } from "./testing/pre-engine-database";

// Atlas runs pipeline v3 exclusively (Phase B of the v3-only consolidation).
// Dispatch no longer branches on `pipelineVersion`: the engine's claim restamps
// every claimed row onto v3 through the kind's `onTransition`, whatever it was
// stamped at kickoff, so a queued row that used to be 1 or 2 simply runs fresh
// on v3. These tests run the kind through the engine (`drain`) over a real
// database, with the pipeline and the things around it mocked.

const mocks = vi.hoisted(() => ({
	getConfig: vi.fn(),
	isModelEnabled: vi.fn(),
	runAtlasV3PipelineForClaimedJob: vi.fn(),
	buildAtlasLifecycleContext: vi.fn(),
	resolveAtlasKickoffMessage: vi.fn(),
	recordAtlasJobAnalytics: vi.fn(async () => undefined),
	notifyAtlasCompletion: vi.fn(async () => undefined),
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

vi.mock("$lib/server/services/analytics", () => ({
	recordAtlasJobAnalytics: mocks.recordAtlasJobAnalytics,
}));

vi.mock("$lib/server/services/browser-push", () => ({
	notifyAtlasCompletion: mocks.notifyAtlasCompletion,
}));

vi.mock("../atlas-v3/worker-bindings", () => ({
	runAtlasV3PipelineForClaimedJob: mocks.runAtlasV3PipelineForClaimedJob,
}));

vi.mock("./checkpoints", () => ({
	buildAtlasLifecycleContext: mocks.buildAtlasLifecycleContext,
	writeAtlasRoundCheckpoint: vi.fn(),
}));

vi.mock("./kickoff-message", () => ({
	resolveAtlasKickoffMessage: mocks.resolveAtlasKickoffMessage,
}));

const NO_OUTPUTS = {
	fileProductionJobId: null,
	htmlChatGeneratedFileId: null,
	pdfChatGeneratedFileId: null,
	markdownChatGeneratedFileId: null,
};

function v3PipelineResult(
	overrides: { outputs?: typeof NO_OUTPUTS } = {},
): Record<string, unknown> {
	return {
		status: "succeeded" as const,
		stage: "render" as const,
		pipelineVersion: 3 as const,
		title: "Atlas research",
		executiveSummaryMarkdown: "Report body.",
		abstained: false,
		outputs: overrides.outputs ?? {
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

interface PipelineInput {
	heartbeat: (progress: {
		stage: string;
		progressPercent: number;
		progressDetails?: unknown;
	}) => Promise<void>;
	applyGeneratedTitle?: (input: {
		jobId: string;
		title: string;
	}) => Promise<void>;
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

let fixture: JobsFixture;

async function appDb() {
	const { db } = await import("$lib/server/db");
	return db;
}

async function readJob(jobId: string) {
	const db = await appDb();
	const row = db
		.select()
		.from(schema.atlasJobs)
		.where(eq(schema.atlasJobs.id, jobId))
		.get();
	if (!row) throw new Error(`No Atlas job ${jobId}`);
	return row;
}

async function readAttempts(jobId: string) {
	const db = await appDb();
	return db
		.select()
		.from(schema.atlasJobAttempts)
		.where(eq(schema.atlasJobAttempts.jobId, jobId))
		.orderBy(asc(schema.atlasJobAttempts.attemptNumber))
		.all();
}

/** The rows an Atlas run's outputs point at (the job's foreign keys need them). */
async function seedOutputRows(): Promise<void> {
	const db = await appDb();
	const now = new Date();
	for (const id of ["file-html", "file-pdf", "file-md"]) {
		db.insert(schema.chatGeneratedFiles)
			.values({
				id,
				conversationId: "conv-1",
				userId: "user-1",
				filename: `${id}.bin`,
				storagePath: `/tmp/${id}`,
				createdAt: now,
			})
			.run();
	}
	db.insert(schema.fileProductionJobs)
		.values({
			id: "fp-job-1",
			conversationId: "conv-1",
			userId: "user-1",
			title: "Atlas report",
			createdAt: now,
			updatedAt: now,
		})
		.run();
}

/**
 * A job the way the app makes one: intake at kickoff, the reply message after the
 * turn is saved, then the link that makes it claimable. Nothing runs yet (the
 * engine is not started in a test, so the wake the link sends is only counted).
 */
async function kickoffAtlasJob(
	options: { query?: string; link?: boolean } = {},
): Promise<{ jobId: string; assistantMessageId: string }> {
	const { createOrReuseAtlasJob, linkAtlasJobAssistantMessage } = await import(
		"./research-job"
	);
	const intake = await createOrReuseAtlasJob({
		userId: "user-1",
		conversationId: "conv-1",
		action: "create",
		parentAtlasJobId: null,
		profile: "overview",
		query: options.query ?? "Research SvelteKit routing docs",
		clientAtlasTurnId: `turn-${randomUUID()}`,
	});
	const assistantMessageId = `assistant-${randomUUID()}`;
	const db = await appDb();
	db.insert(schema.messages)
		.values({
			id: assistantMessageId,
			conversationId: "conv-1",
			role: "assistant",
			content: "",
			createdAt: new Date(),
		})
		.run();
	if (options.link !== false) {
		await linkAtlasJobAssistantMessage({
			userId: "user-1",
			conversationId: "conv-1",
			jobId: intake.job.id,
			assistantMessageId,
		});
	}
	return { jobId: intake.job.id, assistantMessageId };
}

async function engine() {
	const jobs = await import("$lib/server/services/jobs");
	const { atlasResearchJob } = await import("./research-job");
	return { ...jobs, atlasResearchJob };
}

describe("Atlas research runner", () => {
	beforeEach(async () => {
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
		mocks.resolveAtlasKickoffMessage.mockResolvedValue({
			query: "Research SvelteKit routing docs",
			userMessageId: "user-msg-1",
		});
		mocks.runAtlasV3PipelineForClaimedJob.mockResolvedValue(
			v3PipelineResult({ outputs: NO_OUTPUTS }),
		);

		fixture = createJobsFixture("atlas-runner");
		fixture.seedUser("user-1");
		fixture.sqlite
			.prepare(
				"INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES ('conv-1', 'user-1', 'Atlas', unixepoch(), unixepoch())",
			)
			.run();
		process.env.DATABASE_PATH = fixture.dbPath;
	});

	afterEach(async () => {
		try {
			const { resetJobsForTests } = await import("$lib/server/services/jobs");
			resetJobsForTests();
		} catch {
			// The engine was never imported.
		}
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// The DB module may not have been imported if a test failed early.
		}
		fixture.cleanup();
	});

	it.each([
		1, 2, 3,
	] as const)("runs a job stamped pipelineVersion %d on v3 and completes it through the engine", async (stampedPipelineVersion) => {
		const { drain, atlasResearchJob } = await engine();
		const { jobId } = await kickoffAtlasJob();
		await seedOutputRows();
		// A Continue child queued before the v3-only deploy, or a job requeued by a
		// take-back, still carries its old stamp and the old pipeline's stage and
		// details. The claim must hand it to v3 with a clean slate (D1 routing).
		const db = await appDb();
		db.update(schema.atlasJobs)
			.set({
				pipelineVersion: stampedPipelineVersion,
				stage: stampedPipelineVersion === 1 ? "decompose" : "plan",
				progressPercent: 5,
				progressDetailsJson: JSON.stringify({ queries: ["old query"] }),
			})
			.where(eq(schema.atlasJobs.id, jobId))
			.run();
		let seenWhileRunning: Awaited<ReturnType<typeof readJob>> | null = null;
		mocks.runAtlasV3PipelineForClaimedJob.mockImplementationOnce(async () => {
			seenWhileRunning = await readJob(jobId);
			return v3PipelineResult();
		});

		await drain(atlasResearchJob);

		expect(mocks.runAtlasV3PipelineForClaimedJob).toHaveBeenCalledWith(
			expect.objectContaining({
				job: expect.objectContaining({
					id: jobId,
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
			jobId,
			userId: "user-1",
			action: "create",
			parentAtlasJobId: null,
		});
		expect(seenWhileRunning).toMatchObject({
			status: "running",
			pipelineVersion: 3,
			stage: "ask",
			progressPercent: 0,
			progressDetailsJson: "{}",
		});
		expect(await readJob(jobId)).toMatchObject({
			status: "succeeded",
			stage: "render",
			progressPercent: 100,
			inputTokens: 10,
			outputTokens: 5,
			totalTokens: 15,
			costUsdMicros: 25,
			localSourceCount: 1,
			webSourceCount: 2,
			acceptedSourceCount: 3,
			rejectedSourceCount: 0,
			fileProductionJobId: "fp-job-1",
			htmlChatGeneratedFileId: "file-html",
			pdfChatGeneratedFileId: "file-pdf",
			markdownChatGeneratedFileId: "file-md",
			errorCode: null,
			retryable: false,
			attemptCount: 1,
			// The legacy fence columns are never left set.
			workerId: null,
			heartbeatAt: null,
		});
		expect(await readAttempts(jobId)).toMatchObject([
			{ attemptNumber: 1, status: "succeeded" },
		]);
	});

	it("runs the success side effects once, with the stored title, after the job is settled", async () => {
		const { drain, atlasResearchJob } = await engine();
		const { jobId, assistantMessageId } = await kickoffAtlasJob();
		mocks.runAtlasV3PipelineForClaimedJob.mockImplementationOnce(
			async (input: PipelineInput) => {
				await input.applyGeneratedTitle?.({
					jobId,
					title: "  Generated Enterprise RAG Strategy  ",
				});
				return v3PipelineResult({ outputs: NO_OUTPUTS });
			},
		);

		await drain(atlasResearchJob);

		// The title the model generated is stored cleaned, and it is the one the
		// push notification carries.
		expect((await readJob(jobId)).title).toBe(
			"Generated Enterprise RAG Strategy",
		);
		expect(mocks.recordAtlasJobAnalytics).toHaveBeenCalledOnce();
		expect(mocks.recordAtlasJobAnalytics).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			atlasJobId: jobId,
			assistantMessageId,
			profile: "overview",
			inputTokens: 10,
			outputTokens: 5,
			totalTokens: 15,
			costUsdMicros: 25,
		});
		expect(mocks.notifyAtlasCompletion).toHaveBeenCalledOnce();
		expect(mocks.notifyAtlasCompletion).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			jobId,
			title: "Generated Enterprise RAG Strategy",
		});
	});

	it("stores each progress report's stage and percent with sanitized details, and counts it as a beat", async () => {
		const { drain, atlasResearchJob } = await engine();
		const { jobId } = await kickoffAtlasJob();
		let midRun: Awaited<ReturnType<typeof readJob>> | null = null;
		mocks.runAtlasV3PipelineForClaimedJob.mockImplementationOnce(
			async (input: PipelineInput) => {
				await input.heartbeat({
					stage: "search",
					progressPercent: 42,
					progressDetails: {
						queries: [
							"  durable RAG adoption query  ",
							"Fetched page excerpt: raw page text should not persist",
						],
						roundKind: "gap-fill",
						focus: [
							" source reliability gaps ",
							"Evidence pack: raw source text should not persist",
						],
					},
				});
				midRun = await readJob(jobId);
				return v3PipelineResult({ outputs: NO_OUTPUTS });
			},
		);

		await drain(atlasResearchJob);

		expect(midRun).toMatchObject({
			status: "running",
			stage: "search",
			progressPercent: 42,
		});
		const persisted = JSON.parse(
			(midRun as unknown as { progressDetailsJson: string })
				.progressDetailsJson,
		);
		expect(persisted).toEqual({
			queries: ["durable RAG adoption query"],
			roundKind: "gap-fill",
			focus: ["source reliability gaps"],
		});
		expect(
			(midRun as unknown as { progressDetailsJson: string })
				.progressDetailsJson,
		).not.toContain("Fetched page excerpt");
	});

	// The Atlas card shows each web source's icon through the favicon proxy, which
	// answers only for a host a tool returned to this user (docs/plans/exfil-channels).
	// The pipeline reports the sources it has read as it goes, so the handler notes
	// their hosts for the job's user as each report is stored: the card never asks
	// for an icon the ledger cannot vouch for.
	it("notes the web sources each progress report carries for the job's user, and no library document", async () => {
		const { drain, atlasResearchJob } = await engine();
		await kickoffAtlasJob();
		mocks.runAtlasV3PipelineForClaimedJob.mockImplementationOnce(
			async (input: PipelineInput) => {
				await input.heartbeat({
					stage: "research",
					progressPercent: 40,
					progressDetails: {
						pipelineVersion: 3,
						evidence: {
							sources: [
								{ n: 1, title: "A", host: "atlas-source.example", kind: "web" },
								{ n: 2, title: "B", host: "", kind: "local" },
							],
						},
					},
				});
				return v3PipelineResult({ outputs: NO_OUTPUTS });
			},
		);
		const { hasSourceHost } = await import(
			"$lib/server/services/url-provenance"
		);

		await drain(atlasResearchJob);

		expect(hasSourceHost("user-1", "atlas-source.example")).toBe(true);
		expect(hasSourceHost("user-2", "atlas-source.example")).toBe(false);
	});

	it("notes nothing from a progress report for a job that is no longer running", async () => {
		const { drain, atlasResearchJob } = await engine();
		const { cancelAtlasJob } = await import("./research-job");
		const { jobId } = await kickoffAtlasJob();
		mocks.runAtlasV3PipelineForClaimedJob.mockImplementationOnce(
			async (input: PipelineInput) => {
				// The person presses Cancel while the pipeline is mid-run; its next
				// progress report finds the job gone.
				await cancelAtlasJob({ userId: "user-1", jobId });
				await input.heartbeat({
					stage: "research",
					progressPercent: 40,
					progressDetails: {
						evidence: {
							sources: [{ host: "stale-job.example", kind: "web" }],
						},
					},
				});
				return v3PipelineResult({ outputs: NO_OUTPUTS });
			},
		);
		const { hasSourceHost } = await import(
			"$lib/server/services/url-provenance"
		);

		await drain(atlasResearchJob);

		expect(hasSourceHost("user-1", "stale-job.example")).toBe(false);
		// The job stays cancelled: the run's failure is refused, it is not a verdict.
		expect(await readJob(jobId)).toMatchObject({
			status: "cancelled",
			stage: "cancelled",
			workerId: null,
		});
		expect(await readAttempts(jobId)).toMatchObject([
			{ status: "cancelled", errorCode: "cancelled" },
		]);
	});

	it("passes null kickoffUserMessageId through when the query cannot be traced to a user message", async () => {
		const { drain, atlasResearchJob } = await engine();
		await kickoffAtlasJob();
		mocks.resolveAtlasKickoffMessage.mockResolvedValueOnce({
			query: "Research SvelteKit routing docs",
			userMessageId: null,
		});

		await drain(atlasResearchJob);

		expect(mocks.runAtlasV3PipelineForClaimedJob).toHaveBeenCalledWith(
			expect.objectContaining({
				job: expect.objectContaining({ kickoffUserMessageId: null }),
			}),
		);
	});

	it("fails the job with the AtlasV3PipelineError code when the v3 pipeline throws one", async () => {
		const { drain, atlasResearchJob } = await engine();
		const { jobId } = await kickoffAtlasJob();
		const { AtlasV3PipelineError } = await import("../atlas-v3/types");
		mocks.runAtlasV3PipelineForClaimedJob.mockRejectedValueOnce(
			new AtlasV3PipelineError(
				"atlas_v3_no_answer",
				"The report could not answer the question.",
			),
		);

		await drain(atlasResearchJob);

		expect(await readJob(jobId)).toMatchObject({
			status: "failed",
			stage: "failed",
			errorCode: "atlas_v3_no_answer",
			errorMessage: "The report could not answer the question.",
			retryable: true,
			failureMetadataJson: null,
			workerId: null,
			heartbeatAt: null,
		});
		expect(await readAttempts(jobId)).toMatchObject([
			{
				attemptNumber: 1,
				status: "failed",
				errorCode: "atlas_v3_no_answer",
				retryable: true,
			},
		]);
		expect(mocks.recordAtlasJobAnalytics).not.toHaveBeenCalled();
		expect(mocks.notifyAtlasCompletion).not.toHaveBeenCalled();
	});

	it("falls back to a generic error code for an unrecognized failure", async () => {
		const { drain, atlasResearchJob } = await engine();
		const { jobId } = await kickoffAtlasJob();
		mocks.runAtlasV3PipelineForClaimedJob.mockRejectedValueOnce(
			new Error("boom"),
		);

		await drain(atlasResearchJob);

		expect(await readJob(jobId)).toMatchObject({
			status: "failed",
			errorCode: "atlas_pipeline_failed",
			errorMessage: "boom",
			retryable: true,
		});
	});

	it("fails the job when the kickoff message's query cannot be resolved", async () => {
		const { drain, atlasResearchJob } = await engine();
		const { jobId } = await kickoffAtlasJob();
		mocks.resolveAtlasKickoffMessage.mockResolvedValueOnce({
			query: "   ",
			userMessageId: null,
		});

		await drain(atlasResearchJob);

		expect(mocks.runAtlasV3PipelineForClaimedJob).not.toHaveBeenCalled();
		expect(await readJob(jobId)).toMatchObject({
			status: "failed",
			errorCode: "atlas_pipeline_failed",
			errorMessage: "Atlas kickoff message query could not be resolved.",
		});
	});

	it("a run on a cancelled job sends no push and records no analytics", async () => {
		const { drain, atlasResearchJob } = await engine();
		const { cancelAtlasJob } = await import("./research-job");
		const { jobId } = await kickoffAtlasJob();
		mocks.runAtlasV3PipelineForClaimedJob.mockImplementationOnce(async () => {
			// Cancelled in the last stretch, after the final progress report: the
			// pipeline finishes without ever learning of it.
			await cancelAtlasJob({ userId: "user-1", jobId });
			return v3PipelineResult({ outputs: NO_OUTPUTS });
		});

		await drain(atlasResearchJob);

		expect(mocks.recordAtlasJobAnalytics).not.toHaveBeenCalled();
		expect(mocks.notifyAtlasCompletion).not.toHaveBeenCalled();
		// And the report is not written over the cancelled job.
		expect(await readJob(jobId)).toMatchObject({
			status: "cancelled",
			stage: "cancelled",
			progressPercent: 0,
			totalTokens: 0,
		});
	});

	it("leaves a job whose reply message is not linked yet alone until it is linked", async () => {
		const { drain, atlasResearchJob } = await engine();
		const { linkAtlasJobAssistantMessage } = await import("./research-job");
		const { jobId, assistantMessageId } = await kickoffAtlasJob({
			link: false,
		});

		await drain(atlasResearchJob);

		expect(mocks.runAtlasV3PipelineForClaimedJob).not.toHaveBeenCalled();
		expect(await readJob(jobId)).toMatchObject({ status: "queued" });

		await linkAtlasJobAssistantMessage({
			userId: "user-1",
			conversationId: "conv-1",
			jobId,
			assistantMessageId,
		});
		await drain(atlasResearchJob);

		expect(await readJob(jobId)).toMatchObject({ status: "succeeded" });
	});

	it("a lost Atlas attempt requeues twice then fails retryable", async () => {
		const { atlasResearchJob, recover } = await engine();
		const { claimNext } = await import("$lib/server/services/jobs/ledger");
		const { jobId } = await kickoffAtlasJob();
		const db = await appDb();
		const losePrevious = async () => {
			// The worker that held the attempt is gone: its last beat is far in the
			// past, so the next sweep takes the attempt back.
			db.update(schema.atlasJobAttempts)
				.set({ heartbeatAt: new Date(Date.now() - 600_000) })
				.where(eq(schema.atlasJobAttempts.jobId, jobId))
				.run();
			return recover(atlasResearchJob, {});
		};

		for (const attempt of [1, 2]) {
			expect(
				claimNext(atlasResearchJob, {
					workerId: `atlas:gone-host:1:${attempt}`,
				})?.attempt.number,
			).toBe(attempt);
			expect(await losePrevious()).toEqual({ recovered: 1 });
			// Requeued at once, with the reason on the row so the card can say why.
			const requeued = await readJob(jobId);
			expect(requeued).toMatchObject({
				status: "queued",
				stage: "queued",
				progressPercent: 0,
				progressDetailsJson: "{}",
				errorCode: "atlas_worker_heartbeat_timeout",
				errorMessage: "Atlas worker heartbeat timed out before completion.",
				retryable: true,
				attemptCount: attempt,
				workerId: null,
				heartbeatAt: null,
			});
			// No delay: due the moment it was put back.
			expect(requeued.runAfter?.getTime()).toBeLessThanOrEqual(Date.now());
		}

		expect(
			claimNext(atlasResearchJob, { workerId: "atlas:gone-host:1:3" })?.attempt
				.number,
		).toBe(3);
		expect(await losePrevious()).toEqual({ recovered: 1 });
		// The third lost attempt settles the job: a job that kills the process is
		// not retried at every restart. It is still retryable, by the person.
		expect(await readJob(jobId)).toMatchObject({
			status: "failed",
			stage: "failed",
			errorCode: "atlas_worker_heartbeat_timeout",
			retryable: true,
			attemptCount: 3,
		});
		expect(
			(await readAttempts(jobId)).map((attempt) => [
				attempt.attemptNumber,
				attempt.status,
				attempt.errorCode,
			]),
		).toEqual([
			[1, "failed", "atlas_worker_heartbeat_timeout"],
			[2, "failed", "atlas_worker_heartbeat_timeout"],
			[3, "failed", "atlas_worker_heartbeat_timeout"],
		]);
	});

	it("keeps matching provider synthesis and audit configs on the provider model", async () => {
		const providerModel = "provider:deepseek-provider:deepseek-flash" as const;
		const config = {
			...mocks.getConfig(),
			atlasSynthesisModel: providerModel,
			atlasAuditModel: providerModel,
		};
		const { resolveAuditModelSelection } = await import("./research-runner");

		expect(
			resolveAuditModelSelection({
				synthesisModel: providerModel,
				auditModel: providerModel,
				config,
			}),
		).toEqual({ modelSelection: providerModel, warning: null });
	});

	it("moves a matching model1 audit to model2 when model2 is enabled", async () => {
		const { resolveAuditModelSelection } = await import("./research-runner");

		expect(
			resolveAuditModelSelection({
				synthesisModel: "model1",
				auditModel: "model1",
				config: mocks.getConfig(),
			}),
		).toEqual({ modelSelection: "model2", warning: null });
	});
});

// A deploy lands while an Atlas job is running (Review focus 1). The release
// before the engine had no attempts, so the row says `running` with a job-level
// worker id and nothing else. The engine takes it back once, at its first boot,
// and the job runs again from the start under the engine's fence.
describe("an Atlas job that was running at the cutover", () => {
	let preEngine: ReturnType<typeof createPreEngineAtlasDatabase> | null = null;

	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		mocks.getConfig.mockReturnValue({
			atlasWorkerEnabled: true,
			atlasGlobalActiveLimit: 2,
			atlasSynthesisModel: "model1",
			atlasAuditModel: "model1",
			model1: { baseUrl: "http://model1.local", modelName: "model-1" },
			model2: { baseUrl: "http://model2.local", modelName: "model-2" },
			model2Enabled: true,
		});
		mocks.isModelEnabled.mockReturnValue(true);
		mocks.buildAtlasLifecycleContext.mockResolvedValue({
			family: {
				familyId: "f",
				mode: "new_family",
				action: "create",
				rootAtlasJobId: "f",
				currentAtlasJobId: "f",
				parentAtlasJobId: null,
				forkedFromAtlasJobId: null,
			},
			seed: null,
		});
		mocks.resolveAtlasKickoffMessage.mockResolvedValue({
			query: "Research SvelteKit routing docs",
			userMessageId: "user-msg-1",
		});
	});

	afterEach(async () => {
		try {
			const { resetJobsForTests } = await import("$lib/server/services/jobs");
			resetJobsForTests();
		} catch {
			// The engine was never imported.
		}
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// The DB module may not have been imported if a test failed early.
		}
		preEngine?.cleanup();
		preEngine = null;
	});

	it("a row running at the cutover is taken back and requeued, then runs as attempt 1", async () => {
		const old = createPreEngineAtlasDatabase();
		preEngine = old;
		old.seedLiveRows();
		old.upgrade();
		// The restarted server opens its own connection to the file.
		old.close();
		process.env.DATABASE_PATH = old.dbPath;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const release = deferred();
		mocks.runAtlasV3PipelineForClaimedJob
			// The first claim (the queued row, which is older) holds, so the requeued
			// row can be seen waiting behind it.
			.mockImplementationOnce(async () => {
				await release.promise;
				return v3PipelineResult({ outputs: NO_OUTPUTS });
			})
			.mockResolvedValue(v3PipelineResult({ outputs: NO_OUTPUTS }));
		const { startJobs, atlasResearchJob } = await engine();

		await startJobs([atlasResearchJob], {
			startInNonServingContextForTests: true,
		});

		await vi.waitFor(async () => {
			expect((await readJob("job-queued")).status).toBe("running");
		});
		// Taken back once, with no attempt row to close (there never was one): the
		// row is queued again with the reason on it, ready for the next claim, and
		// the legacy fence columns are cleared so the old ledger can never write.
		expect(await readJob("job-running")).toMatchObject({
			status: "queued",
			stage: "queued",
			progressPercent: 0,
			progressDetailsJson: "{}",
			errorCode: "atlas_worker_heartbeat_timeout",
			retryable: true,
			attemptCount: 0,
			currentAttemptId: null,
			workerId: null,
			heartbeatAt: null,
		});
		expect(await readAttempts("job-running")).toEqual([]);
		expect(
			warn.mock.calls.filter(
				([line]) =>
					line === "[ATLAS] Reclaimed jobs whose attempt state was lost",
			),
		).toEqual([
			[
				"[ATLAS] Reclaimed jobs whose attempt state was lost",
				{ reason: "boot", recovered: 1, requeued: 1 },
			],
		]);
		// The settled row is not touched.
		expect(await readJob("job-failed")).toMatchObject({
			status: "failed",
			errorCode: "atlas_pipeline_failed",
			errorMessage: "boom",
		});

		release.resolve();
		await vi.waitFor(async () => {
			expect((await readJob("job-running")).status).toBe("succeeded");
		});
		// The requeued job ran as the engine's first attempt at it.
		expect(await readJob("job-running")).toMatchObject({
			attemptCount: 1,
			errorCode: null,
			retryable: false,
		});
		expect(await readAttempts("job-running")).toMatchObject([
			{ attemptNumber: 1, status: "succeeded" },
		]);
		expect(await readJob("job-queued")).toMatchObject({
			status: "succeeded",
			attemptCount: 1,
		});
		warn.mockRestore();
	});
});
