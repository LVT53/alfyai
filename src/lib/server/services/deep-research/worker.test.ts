import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;

async function seedConversation() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });

	const now = new Date("2026-05-05T10:00:00.000Z");
	db.insert(schema.users)
		.values({
			id: "user-1",
			email: "user@example.com",
			passwordHash: "hash",
		})
		.run();
	db.insert(schema.conversations)
		.values({
			id: "conv-1",
			userId: "user-1",
			title: "Research conversation",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.messages)
		.values({
			id: "user-msg-1",
			conversationId: "conv-1",
			role: "user",
			content: "Compare EU and US AI copyright training data rules",
			createdAt: now,
		})
		.run();

	sqlite.close();
}

async function seedAdditionalConversation(input: {
	userId: string;
	conversationId: string;
	messageId: string;
	email?: string;
	createUser?: boolean;
}) {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });

	const now = new Date("2026-05-05T10:00:00.000Z");
	if (input.createUser) {
		db.insert(schema.users)
			.values({
				id: input.userId,
				email: input.email ?? `${input.userId}@example.com`,
				passwordHash: "hash",
			})
			.run();
	}
	db.insert(schema.conversations)
		.values({
			id: input.conversationId,
			userId: input.userId,
			title: "Research conversation",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.messages)
		.values({
			id: input.messageId,
			conversationId: input.conversationId,
			role: "user",
			content: "Compare EU and US AI copyright training data rules",
			createdAt: now,
		})
		.run();

	sqlite.close();
}

async function createApprovedResearchJob(
	input: {
		userId?: string;
		conversationId?: string;
		triggerMessageId?: string;
		userRequest?: string;
		depth?: "focused" | "standard" | "max";
		createdAt?: Date;
		approvedAt?: Date;
	} = {},
) {
	const { approveDeepResearchPlan, startDeepResearchJobShell } = await import(
		"./index"
	);
	const created = await startDeepResearchJobShell({
		userId: input.userId ?? "user-1",
		conversationId: input.conversationId ?? "conv-1",
		triggerMessageId: input.triggerMessageId ?? "user-msg-1",
		userRequest:
			input.userRequest ?? "Compare EU and US AI copyright training data rules",
		depth: input.depth ?? "standard",
		now: input.createdAt ?? new Date("2026-05-05T10:01:00.000Z"),
	});

	const approved = await approveDeepResearchPlan({
		userId: input.userId ?? "user-1",
		jobId: created.id,
		now: input.approvedAt ?? new Date("2026-05-05T10:06:00.000Z"),
	});
	if (!approved)
		throw new Error("Expected Research Plan approval to return the job");
	return approved;
}

async function setResearchJobState(input: {
	jobId: string;
	status: string;
	stage: string;
	updatedAt?: Date;
}) {
	const { db } = await import("$lib/server/db");
	await db
		.update(schema.deepResearchJobs)
		.set({
			status: input.status,
			stage: input.stage,
			updatedAt: input.updatedAt ?? new Date("2026-05-05T10:20:00.000Z"),
		})
		.where(eq(schema.deepResearchJobs.id, input.jobId));
}

describe("Deep Research worker tick and scheduler", () => {
	afterEach(async () => {
		const { stopDeepResearchWorkerScheduler } = await import("./worker");
		stopDeepResearchWorkerScheduler();
		vi.restoreAllMocks();
		vi.useRealTimers();
		vi.resetModules();
	});

	it("does nothing when the real workflow worker tick is disabled", async () => {
		const recoverStaleJobs = vi.fn();
		const advanceWorkflowStep = vi.fn();
		const { runDeepResearchWorkerTick } = await import("./worker");

		const result = await runDeepResearchWorkerTick({
			enabled: false,
			intervalMs: 5_000,
			staleTimeoutMs: 30_000,
			now: new Date("2026-05-05T10:00:00.000Z"),
			recoverStaleJobs,
			advanceWorkflowStep,
		});

		expect(result).toEqual({
			enabled: false,
			recoveredJobs: [],
			recoveredCount: 0,
			workerStep: null,
			advanced: false,
		});
		expect(recoverStaleJobs).not.toHaveBeenCalled();
		expect(advanceWorkflowStep).not.toHaveBeenCalled();
	});

	it("recovers stale jobs before advancing at most one real workflow step", async () => {
		const now = new Date("2026-05-05T10:00:00.000Z");
		const recoveredJob = { id: "recovered-job" };
		const advancedJob = { id: "advanced-job" };
		const recoverStaleJobs = vi.fn(async () => ({
			recoveredJobs: [recoveredJob],
		}));
		const advanceWorkflowStep = vi.fn(async () => ({
			job: advancedJob,
			advanced: true,
		}));
		const { runDeepResearchWorkerTick } = await import("./worker");

		const result = await runDeepResearchWorkerTick({
			enabled: true,
			intervalMs: 5_000,
			staleTimeoutMs: 30_000,
			controls: {
				globalConcurrencyLimit: 2,
				userConcurrencyLimit: 1,
			},
			now,
			recoverStaleJobs,
			advanceWorkflowStep,
		});

		expect(recoverStaleJobs).toHaveBeenCalledWith({
			now,
			timeoutMs: 30_000,
		});
		expect(advanceWorkflowStep).toHaveBeenCalledWith({
			now,
			controls: {
				globalConcurrencyLimit: 2,
				userConcurrencyLimit: 1,
			},
		});
		expect(recoverStaleJobs.mock.invocationCallOrder[0]).toBeLessThan(
			advanceWorkflowStep.mock.invocationCallOrder[0],
		);
		expect(result).toEqual({
			enabled: true,
			recoveredJobs: [recoveredJob],
			recoveredCount: 1,
			workerStep: {
				job: advancedJob,
				advanced: true,
			},
			advanced: true,
		});
	});

	it("starts one idempotent scheduler, unrefs its timer, and can stop it", async () => {
		const intervalCallbacks: Array<() => void> = [];
		const timer = { unref: vi.fn() };
		const setIntervalSpy = vi
			.spyOn(global, "setInterval")
			.mockImplementation((callback: TimerHandler, _intervalMs?: number) => {
				intervalCallbacks.push(callback as () => void);
				return timer as ReturnType<typeof setInterval>;
			});
		const clearIntervalSpy = vi
			.spyOn(global, "clearInterval")
			.mockImplementation(() => undefined);
		const recoverStaleJobs = vi.fn(async () => ({ recoveredJobs: [] }));
		const advanceWorkflowStep = vi.fn(async () => null);
		const {
			ensureDeepResearchWorkerScheduler,
			stopDeepResearchWorkerScheduler,
		} = await import("./worker");

		ensureDeepResearchWorkerScheduler(() => ({
			enabled: true,
			intervalMs: 5_000,
			staleTimeoutMs: 30_000,
			now: new Date("2026-05-05T10:00:00.000Z"),
			recoverStaleJobs,
			advanceWorkflowStep,
		}));
		ensureDeepResearchWorkerScheduler(() => ({
			enabled: true,
			intervalMs: 10_000,
			staleTimeoutMs: 60_000,
			recoverStaleJobs,
			advanceWorkflowStep,
		}));

		expect(setIntervalSpy).toHaveBeenCalledOnce();
		expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 5_000);
		expect(timer.unref).toHaveBeenCalledOnce();

		intervalCallbacks[0]?.();
		await Promise.resolve();

		expect(recoverStaleJobs).toHaveBeenCalledOnce();
		expect(advanceWorkflowStep).toHaveBeenCalledOnce();

		stopDeepResearchWorkerScheduler();

		expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
	});

	it("installs a safe scheduler while disabled and starts work after runtime enablement", async () => {
		const intervalCallbacks: Array<() => void> = [];
		const timer = { unref: vi.fn() };
		const setIntervalSpy = vi
			.spyOn(global, "setInterval")
			.mockImplementation((callback: TimerHandler, _intervalMs?: number) => {
				intervalCallbacks.push(callback as () => void);
				return timer as ReturnType<typeof setInterval>;
			});
		let enabled = false;
		const recoverStaleJobs = vi.fn(async () => ({ recoveredJobs: [] }));
		const advanceWorkflowStep = vi.fn(async () => null);
		const { ensureDeepResearchWorkerScheduler } = await import("./worker");

		ensureDeepResearchWorkerScheduler(() => ({
			enabled,
			intervalMs: 5_000,
			staleTimeoutMs: 30_000,
			now: new Date("2026-05-05T10:00:00.000Z"),
			recoverStaleJobs,
			advanceWorkflowStep,
		}));

		expect(setIntervalSpy).toHaveBeenCalledOnce();
		expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 5_000);
		expect(timer.unref).toHaveBeenCalledOnce();

		intervalCallbacks[0]?.();
		await Promise.resolve();

		expect(recoverStaleJobs).not.toHaveBeenCalled();
		expect(advanceWorkflowStep).not.toHaveBeenCalled();

		enabled = true;
		intervalCallbacks[0]?.();
		await Promise.resolve();

		expect(recoverStaleJobs).toHaveBeenCalledOnce();
		expect(advanceWorkflowStep).toHaveBeenCalledOnce();
	});
});

describe("Deep Research worker cleanup and recovery", () => {
	beforeEach(async () => {
		dbPath = `/tmp/alfyai-deep-research-worker-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		await seedConversation();
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// The DB module may not have been imported if a test failed early.
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// Temporary DB cleanup is best-effort.
		}
	});

	it("does not expose legacy mock worker entrypoints", async () => {
		const worker = await import("./worker");

		expect(worker).not.toHaveProperty("runNextMockDeepResearchWorkerStep");
		expect(worker).not.toHaveProperty("triggerMockDeepResearchWorkerForJob");
	});

	it("resumes stale running workflow jobs from their latest resume point after the configured timeout", async () => {
		await seedAdditionalConversation({
			userId: "user-1",
			conversationId: "conv-2",
			messageId: "user-msg-2",
		});
		const runningJob = await createApprovedResearchJob({
			createdAt: new Date("2026-05-05T10:01:00.000Z"),
			approvedAt: new Date("2026-05-05T10:02:00.000Z"),
		});
		const reportReadyJob = await createApprovedResearchJob({
			conversationId: "conv-2",
			triggerMessageId: "user-msg-2",
			userRequest: "Research stale report ready recovery",
			createdAt: new Date("2026-05-05T10:03:00.000Z"),
			approvedAt: new Date("2026-05-05T10:04:00.000Z"),
		});
		const { db } = await import("$lib/server/db");
		await db
			.update(schema.deepResearchJobs)
			.set({
				status: "running",
				stage: "source_review",
				updatedAt: new Date("2026-05-05T09:00:00.000Z"),
			})
			.where(eq(schema.deepResearchJobs.id, runningJob.id));
		await db
			.update(schema.deepResearchJobs)
			.set({
				status: "running",
				stage: "research_tasks",
				updatedAt: new Date("2026-05-05T09:10:00.000Z"),
			})
			.where(eq(schema.deepResearchJobs.id, reportReadyJob.id));
		const { upsertResearchResumePoint } = await import("./resume-points");
		await upsertResearchResumePoint({
			userId: "user-1",
			jobId: runningJob.id,
			conversationId: "conv-1",
			boundary: "running_pass",
			resumeKey: `pass:${runningJob.id}:1:source_review`,
			stage: "source_review",
			passNumber: 1,
			now: new Date("2026-05-05T09:00:00.000Z"),
		});
		await upsertResearchResumePoint({
			userId: "user-1",
			jobId: reportReadyJob.id,
			conversationId: "conv-2",
			boundary: "research_task",
			resumeKey: `task:${reportReadyJob.id}:stale`,
			stage: "research_tasks",
			passNumber: 2,
			now: new Date("2026-05-05T09:10:00.000Z"),
		});
		const { recoverStaleDeepResearchJobs } = await import("./worker");
		const { listResearchTimelineEvents } = await import("./timeline");

		const result = await recoverStaleDeepResearchJobs({
			now: new Date("2026-05-05T11:00:00.000Z"),
			timeoutMs: 30 * 60 * 1000,
		});
		const runningTimeline = await listResearchTimelineEvents({
			userId: "user-1",
			jobId: runningJob.id,
		});
		const reportReadyTimeline = await listResearchTimelineEvents({
			userId: "user-1",
			jobId: reportReadyJob.id,
		});

		expect(
			result.recoveredJobs.map((job) => [job.id, job.status, job.stage]),
		).toEqual([
			[runningJob.id, "running", "source_review"],
			[reportReadyJob.id, "running", "research_tasks"],
		]);
		expect(
			runningTimeline.map((event) => ({
				stage: event.stage,
				kind: event.kind,
				summary: event.summary,
				warnings: event.warnings,
			})),
		).toContainEqual({
			stage: "report_completion",
			kind: "warning",
			summary:
				"Deep Research job resumed from the latest durable Research Resume Point after exceeding the stale worker timeout.",
			warnings: ["Worker timeout exceeded for stage source_review."],
		});
		expect(
			reportReadyTimeline.map((event) => ({
				stage: event.stage,
				kind: event.kind,
				summary: event.summary,
				warnings: event.warnings,
			})),
		).toContainEqual({
			stage: "report_completion",
			kind: "warning",
			summary:
				"Deep Research job resumed from the latest durable Research Resume Point after exceeding the stale worker timeout.",
			warnings: ["Worker timeout exceeded for stage research_tasks."],
		});
	});

	it("cancels running workflow work before further advancement and records a diagnostic timeline summary", async () => {
		const approved = await createApprovedResearchJob();
		await setResearchJobState({
			jobId: approved.id,
			status: "running",
			stage: "source_review",
			updatedAt: new Date("2026-05-05T10:07:00.000Z"),
		});
		const {
			claimResearchTasks,
			createResearchTasksFromCoverageGaps,
			listResearchTasks,
		} = await import("./tasks");
		const [task] = await createResearchTasksFromCoverageGaps({
			userId: "user-1",
			jobId: approved.id,
			conversationId: "conv-1",
			passNumber: 1,
			gaps: [
				{
					id: "cancel-gap",
					keyQuestion: "Which source still needs review?",
					summary: "A running task should be cancelled with the job.",
					severity: "major",
				},
			],
			now: new Date("2026-05-05T10:07:10.000Z"),
		});
		await claimResearchTasks({
			userId: "user-1",
			jobId: approved.id,
			passNumber: 1,
			limit: 1,
			claimToken: "workflow-cancel-test",
			now: new Date("2026-05-05T10:07:20.000Z"),
		});
		const {
			requestDeepResearchWorkerCancellation,
			triggerDeepResearchWorkflowWorkerForJob,
		} = await import("./worker");
		const { listResearchTimelineEvents } = await import("./timeline");
		const workflowStep = vi.fn();

		const cancelled = await requestDeepResearchWorkerCancellation({
			userId: "user-1",
			jobId: approved.id,
			now: new Date("2026-05-05T10:08:00.000Z"),
		});
		const laterTrigger = await triggerDeepResearchWorkflowWorkerForJob({
			userId: "user-1",
			jobId: approved.id,
			now: new Date("2026-05-05T10:09:00.000Z"),
			workflowStep,
		});
		const timeline = await listResearchTimelineEvents({
			userId: "user-1",
			jobId: approved.id,
		});
		const tasks = await listResearchTasks({
			userId: "user-1",
			jobId: approved.id,
			passNumber: 1,
		});

		expect(cancelled).toMatchObject({
			id: approved.id,
			status: "cancelled",
			stage: "cancelled_by_request",
			cancelledAt: new Date("2026-05-05T10:08:00.000Z").getTime(),
		});
		expect(laterTrigger).toMatchObject({
			job: {
				id: approved.id,
				status: "cancelled",
				stage: "cancelled_by_request",
			},
			advanced: false,
		});
		expect(workflowStep).not.toHaveBeenCalled();
		expect(tasks).toEqual([
			expect.objectContaining({
				id: task.id,
				status: "cancelled",
				failureKind: "permanent",
				failureReason: "Deep Research job cancelled by user request.",
			}),
		]);
		expect(
			timeline.map((event) => ({
				stage: event.stage,
				kind: event.kind,
				messageKey: event.messageKey,
				summary: event.summary,
				warnings: event.warnings,
			})),
		).toContainEqual({
			stage: "report_completion",
			kind: "warning",
			messageKey: "deepResearch.timeline.workerCancelled",
			summary: "Deep Research job cancelled before further worker advancement.",
			warnings: [
				"Cancellation requested while job was at stage source_review.",
			],
		});
	});
});

describe("real Deep Research workflow worker", () => {
	beforeEach(async () => {
		dbPath = `/tmp/alfyai-deep-research-workflow-worker-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		await seedConversation();
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// The DB module may not have been imported if a test failed early.
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// Temporary DB cleanup is best-effort.
		}
	});

	it("runs one workflow step for the oldest eligible real workflow job", async () => {
		await seedAdditionalConversation({
			userId: "user-1",
			conversationId: "conv-2",
			messageId: "user-msg-2",
		});
		const older = await createApprovedResearchJob({
			createdAt: new Date("2026-05-05T10:01:00.000Z"),
			approvedAt: new Date("2026-05-05T10:06:00.000Z"),
		});
		const newer = await createApprovedResearchJob({
			conversationId: "conv-2",
			triggerMessageId: "user-msg-2",
			userRequest: "Research newer eligible work",
			createdAt: new Date("2026-05-05T10:02:00.000Z"),
			approvedAt: new Date("2026-05-05T10:07:00.000Z"),
		});
		const workflowStep = vi.fn(
			async (input: { userId: string; jobId: string }) => {
				const { listConversationDeepResearchJobs } = await import("./index");
				const conversationId = input.jobId === older.id ? "conv-1" : "conv-2";
				const jobs = await listConversationDeepResearchJobs(
					input.userId,
					conversationId,
				);
				return {
					job: jobs.find((job) => job.id === input.jobId) ?? older,
					advanced: true,
					outcome: "discovery_completed" as const,
				};
			},
		);
		const { runNextDeepResearchWorkflowWorkerStep } = await import("./worker");

		const result = await runNextDeepResearchWorkflowWorkerStep({
			now: new Date("2026-05-05T10:08:00.000Z"),
			workflowStep,
		});

		expect(workflowStep).toHaveBeenCalledTimes(1);
		expect(workflowStep).toHaveBeenCalledWith({
			userId: "user-1",
			jobId: older.id,
			now: new Date("2026-05-05T10:08:00.000Z"),
		});
		expect(result).toMatchObject({
			job: {
				id: older.id,
			},
			advanced: true,
		});
		expect(result?.job.id).not.toBe(newer.id);
	});

	it("advances only a user-owned job by explicit workflow trigger", async () => {
		await seedAdditionalConversation({
			userId: "user-2",
			conversationId: "conv-2",
			messageId: "user-msg-2",
			email: "second-user@example.com",
			createUser: true,
		});
		const otherUserJob = await createApprovedResearchJob({
			userId: "user-2",
			conversationId: "conv-2",
			triggerMessageId: "user-msg-2",
			createdAt: new Date("2026-05-05T10:01:00.000Z"),
			approvedAt: new Date("2026-05-05T10:06:00.000Z"),
		});
		const workflowStep = vi.fn(async () => ({
			job: otherUserJob,
			advanced: true,
			outcome: "discovery_completed" as const,
		}));
		const { triggerDeepResearchWorkflowWorkerForJob } = await import(
			"./worker"
		);

		await expect(
			triggerDeepResearchWorkflowWorkerForJob({
				userId: "user-1",
				jobId: otherUserJob.id,
				now: new Date("2026-05-05T10:07:00.000Z"),
				workflowStep,
			}),
		).resolves.toBeNull();

		const result = await triggerDeepResearchWorkflowWorkerForJob({
			userId: "user-2",
			jobId: otherUserJob.id,
			now: new Date("2026-05-05T10:08:00.000Z"),
			workflowStep,
		});

		expect(workflowStep).toHaveBeenCalledTimes(1);
		expect(workflowStep).toHaveBeenCalledWith({
			userId: "user-2",
			jobId: otherUserJob.id,
			now: new Date("2026-05-05T10:08:00.000Z"),
		});
		expect(result).toMatchObject({
			job: {
				id: otherUserJob.id,
			},
			advanced: true,
		});
	});

	it("enforces concurrency only before starting approved workflow jobs", async () => {
		await seedAdditionalConversation({
			userId: "user-1",
			conversationId: "conv-2",
			messageId: "user-msg-2",
		});
		const running = await createApprovedResearchJob({
			createdAt: new Date("2026-05-05T10:01:00.000Z"),
			approvedAt: new Date("2026-05-05T10:06:00.000Z"),
		});
		await setResearchJobState({
			jobId: running.id,
			status: "running",
			stage: "source_review",
		});
		const approved = await createApprovedResearchJob({
			conversationId: "conv-2",
			triggerMessageId: "user-msg-2",
			userRequest: "Research queued approved work",
			createdAt: new Date("2026-05-05T10:02:00.000Z"),
			approvedAt: new Date("2026-05-05T10:07:00.000Z"),
		});
		const workflowStep = vi.fn(
			async (input: { userId: string; jobId: string }) => {
				const { listConversationDeepResearchJobs } = await import("./index");
				const conversationId = input.jobId === running.id ? "conv-1" : "conv-2";
				const jobs = await listConversationDeepResearchJobs(
					input.userId,
					conversationId,
				);
				const job = jobs.find((candidate) => candidate.id === input.jobId);
				if (!job) throw new Error("Expected job to reload");
				return {
					job,
					advanced: true,
					outcome: "report_completed" as const,
				};
			},
		);
		const {
			triggerDeepResearchWorkflowWorkerForJob,
			runNextDeepResearchWorkflowWorkerStep,
		} = await import("./worker");

		await expect(
			triggerDeepResearchWorkflowWorkerForJob({
				userId: "user-1",
				jobId: approved.id,
				controls: {
					userConcurrencyLimit: 1,
				},
				workflowStep,
			}),
		).resolves.toMatchObject({
			job: {
				id: approved.id,
				status: "approved",
				stage: "plan_approved",
			},
			advanced: false,
		});
		expect(workflowStep).not.toHaveBeenCalled();

		await expect(
			triggerDeepResearchWorkflowWorkerForJob({
				userId: "user-1",
				jobId: running.id,
				controls: {
					globalConcurrencyLimit: 0,
					userConcurrencyLimit: 0,
				},
				workflowStep,
			}),
		).resolves.toMatchObject({
			job: {
				id: running.id,
				status: "running",
				stage: "source_review",
			},
			advanced: true,
		});

		const nextResult = await runNextDeepResearchWorkflowWorkerStep({
			controls: {
				userConcurrencyLimit: 1,
			},
			workflowStep,
		});

		expect(nextResult).toMatchObject({
			job: {
				id: running.id,
			},
			advanced: true,
		});
		expect(workflowStep).toHaveBeenCalledTimes(2);
	});

	it("returns terminal workflow jobs without advancing them", async () => {
		const approved = await createApprovedResearchJob();
		await setResearchJobState({
			jobId: approved.id,
			status: "completed",
			stage: "report_completed",
		});
		const workflowStep = vi.fn();
		const { triggerDeepResearchWorkflowWorkerForJob } = await import(
			"./worker"
		);

		const result = await triggerDeepResearchWorkflowWorkerForJob({
			userId: "user-1",
			jobId: approved.id,
			now: new Date("2026-05-05T10:08:00.000Z"),
			workflowStep,
		});

		expect(workflowStep).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			job: {
				id: approved.id,
				status: "completed",
				stage: "report_completed",
			},
			advanced: false,
		});
	});
});
