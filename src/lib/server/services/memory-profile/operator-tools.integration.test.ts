import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootEngine, type EngineHarness } from "../jobs/testing/harness";

let h: EngineHarness;
beforeEach(async () => {
	h = await bootEngine("memory-operator-tools");
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	h.cleanup();
});

interface Fact {
	id: string;
	text: string;
	fact_type: string;
	document_id?: string;
	consolidated_at?: string | null;
	consolidation_failed_at?: string | null;
	source_memory_ids?: string[];
}

/**
 * A synthetic account with one chat source, and a Hindsight the test steers:
 * operations end as it says, a completed retain leaves a fact under its
 * document, and the consolidation recover endpoint clears failed marks.
 */
async function setup() {
	const { db } = await import("$lib/server/db");
	const schema = await import("$lib/server/db/schema");
	const rev = await import("./revisions");
	const jobs = await import("./delivery-job");
	const clientModule = await import("./hindsight-client");
	const config = await import("$lib/server/config-store");
	const contracts = await import("./contracts");
	const tools = await import("./operator-tools");
	const bank = rev.ensureMemoryBank(h.userId, { kind: "personal" });
	db.update(schema.memoryAccounts).set({ authority: "hindsight" }).run();
	const source = rev.recordMemorySource({
		userId: h.userId,
		bankId: bank.id,
		epoch: 0,
		eventId: "event",
		lineageId: "message",
		text: "My kayak is green",
		context: JSON.stringify({ messages: [] }),
		assertedAt: new Date("2026-11-18"),
	});
	vi.spyOn(config, "getConfig").mockReturnValue({
		...config.getConfig(),
		hindsightWorkerEnabled: true,
		hindsightConcurrency: 1,
	});
	const hindsight = {
		operations: new Map<string, string>(),
		facts: [] as Fact[],
		pending: [] as string[],
		posted: [] as string[],
		/** Documents deleted, in order. */
		deleted: [] as string[],
		/** true = a deleted document's facts stay listed, as if the delete did not take. */
		keepFactsOnDelete: false,
		recovered: 0,
		consolidations: 0,
		/** How the next retain ends. */
		nextRetain: "completed",
	};
	const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
		const path = String(url);
		let data: unknown = {};
		if (path.endsWith("/config"))
			data = { config: contracts.nativeBankConfig("personal") };
		else if (path.includes("/documents/") && init?.method === "DELETE") {
			const id = decodeURIComponent(path.split("/documents/")[1]);
			hindsight.deleted.push(id);
			if (!hindsight.keepFactsOnDelete)
				hindsight.facts = hindsight.facts.filter((f) => f.document_id !== id);
			// Hindsight consolidates what is left again: the bank is busy until then.
			hindsight.pending.push(`rebuild-after-${id}`);
		} else if (path.endsWith("/memories") && init?.method === "POST") {
			const body = JSON.parse(String(init.body));
			hindsight.posted.push(body.operation_id);
			if (!hindsight.operations.has(body.operation_id)) {
				hindsight.operations.set(body.operation_id, hindsight.nextRetain);
				if (hindsight.nextRetain === "completed")
					hindsight.facts.push({
						id: `fact-${hindsight.facts.length + 1}`,
						text: "Green kayak",
						fact_type: "world",
						document_id: body.items[0].document_id,
						consolidated_at: "2026-11-18T00:00:00Z",
					});
			}
			data = { operation_id: body.operation_id };
		} else if (path.endsWith("/consolidation/recover")) {
			const failed = hindsight.facts.filter((f) => f.consolidation_failed_at);
			for (const fact of failed) fact.consolidation_failed_at = null;
			hindsight.recovered += failed.length;
			data = { recovered: failed.length };
		} else if (path.endsWith("/consolidate")) {
			hindsight.consolidations += 1;
			const id = `consolidation-${hindsight.consolidations}`;
			hindsight.operations.set(id, "completed");
			for (const fact of hindsight.facts)
				fact.consolidated_at ??= "2026-11-18T00:00:00Z";
			data = { operation_id: id };
		} else if (path.includes("/operations?"))
			data = {
				operations: path.includes("status=pending")
					? hindsight.pending.map((id) => ({ id, status: "pending" }))
					: [],
			};
		else if (path.includes("/operations/")) {
			const id = decodeURIComponent(path.split("/operations/")[1]);
			data = { status: hindsight.operations.get(id) ?? "not_found" };
		} else if (path.includes("/memories/list")) {
			const items = [
				...hindsight.facts,
				...hindsight.facts
					.filter((f) => f.fact_type !== "observation")
					.map((f) => ({
						id: `observation-${f.id}`,
						text: f.text,
						fact_type: "observation",
						source_memory_ids: [f.id],
					})),
			];
			data = { total: items.length, offset: 0, items };
		}
		return new Response(JSON.stringify(data));
	});
	vi.spyOn(clientModule, "configuredNativeBinding").mockReturnValue({
		baseUrl: "http://synthetic",
		credentialHash: "synthetic-hash",
	});
	vi.spyOn(clientModule, "nativeMemoryClient").mockImplementation(
		() =>
			new clientModule.HindsightClient({
				baseUrl: "http://synthetic",
				apiKey: "synthetic",
				bankId: bank.id,
				fetcher,
			}),
	);
	const enqueue = () =>
		jobs.enqueueMemoryDelivery({
			userId: h.userId,
			bankId: bank.id,
			epoch: 0,
			kind: "source",
			sourceId: source.id,
			requestId: "request",
		});
	const job = () => db.select().from(schema.memoryDeliveryJobs).get();
	const revision = () => db.select().from(schema.memorySourceRevisions).get();
	/** A delivery whose retain was sent and failed for good. */
	async function failedDelivery(
		operation: "failed" | "cancelled" | "unknown" | "completed",
	) {
		const queued = await enqueue();
		const id = source.nativeOperationId as string;
		if (operation !== "unknown") hindsight.operations.set(id, operation);
		if (operation === "completed")
			hindsight.facts.push({
				id: "delivered",
				text: "Green kayak",
				fact_type: "world",
				document_id: source.id,
				consolidated_at: "2026-11-18T00:00:00Z",
			});
		db.update(schema.memorySourceRevisions)
			.set({ nativeSubmitted: true })
			.run();
		db.update(schema.memoryDeliveryJobs)
			.set({
				status: "failed",
				errorCode: "native_retain_resubmit_failed",
				errorMessage: "Memory preparation could not complete.",
				retryable: false,
				attemptCount: 3,
			})
			.run();
		return queued.row.id;
	}
	const markExcluded = async (userId: string) => {
		const { eq } = await import("drizzle-orm");
		db.update(schema.users)
			.set({ memoryMigrationExcluded: true })
			.where(eq(schema.users.id, userId))
			.run();
	};
	const { eq } = await import("drizzle-orm");
	const jobById = (id: string) =>
		db
			.select()
			.from(schema.memoryDeliveryJobs)
			.where(eq(schema.memoryDeliveryJobs.id, id))
			.get();
	const attemptById = (id: string) =>
		db
			.select()
			.from(schema.memoryDeliveryAttempts)
			.where(eq(schema.memoryDeliveryAttempts.id, id))
			.get();
	const setJob = (
		id: string,
		values: Partial<typeof schema.memoryDeliveryJobs.$inferInsert>,
	) =>
		db
			.update(schema.memoryDeliveryJobs)
			.set(values)
			.where(eq(schema.memoryDeliveryJobs.id, id))
			.run();
	/** Another chat of the same bank, its delivery queued. */
	async function enqueueChat(name: string, runAfter?: Date) {
		const chat = rev.recordMemorySource({
			userId: h.userId,
			bankId: bank.id,
			epoch: 0,
			eventId: `${name}-event`,
			lineageId: `${name}-message`,
			text: `Synthetic ${name} statement`,
			context: JSON.stringify({ messages: [] }),
			assertedAt: new Date("2026-11-19"),
		});
		const queued = await jobs.enqueueMemoryDelivery({
			userId: h.userId,
			bankId: bank.id,
			epoch: 0,
			kind: "source",
			sourceId: chat.id,
			requestId: `${name}-request`,
			runAfter,
		});
		return { source: chat, jobId: queued.row.id };
	}
	/**
	 * What the failure policy leaves of a job an attempt began: queued again,
	 * started once, and the error that put it back still on it.
	 */
	const putBack = (
		id: string,
		dueInMs: number,
		code = "native_retain_waiting",
	) =>
		setJob(id, {
			status: "queued",
			errorCode: code,
			attemptCount: 1,
			startedAt: new Date(Date.now() - 600_000),
			runAfter: new Date(Date.now() + dueInMs),
		});
	/** A job whose process died: `running`, its lease ten minutes stale. */
	const leaveRunning = (id: string, attemptCount = 1) => {
		const old = new Date(Date.now() - 10 * 60_000);
		const attemptId = randomUUID();
		setJob(id, {
			status: "running",
			currentAttemptId: attemptId,
			attemptCount,
			startedAt: old,
			updatedAt: old,
		});
		db.insert(schema.memoryDeliveryAttempts)
			.values({
				id: attemptId,
				jobId: id,
				attemptNumber: attemptCount,
				status: "running",
				workerId: "memory:gone-host:1:dead",
				claimedAt: old,
				heartbeatAt: old,
				startedAt: old,
				createdAt: old,
				updatedAt: old,
			})
			.run();
		return attemptId;
	};
	return {
		db,
		schema,
		jobs,
		tools,
		config,
		rev,
		bank,
		source,
		hindsight,
		fetcher,
		enqueue,
		enqueueChat,
		job,
		jobById,
		attemptById,
		setJob,
		putBack,
		leaveRunning,
		revision,
		failedDelivery,
		markExcluded,
	};
}
type Fixture = Awaited<ReturnType<typeof setup>>;

/**
 * Everything a tool could change: every Memory job, attempt, source, bank and
 * account row, and each write it sent to Hindsight (its reads are GETs).
 */
function written(f: Fixture) {
	return {
		db: JSON.stringify([
			f.db.select().from(f.schema.memoryDeliveryJobs).all(),
			f.db.select().from(f.schema.memoryDeliveryAttempts).all(),
			f.db.select().from(f.schema.memorySourceRevisions).all(),
			f.db.select().from(f.schema.memoryBanks).all(),
			f.db.select().from(f.schema.memoryAccounts).all(),
		]),
		hindsight: f.fetcher.mock.calls
			.filter(([, init]) => (init?.method ?? "GET") !== "GET")
			.map(([url, init]) => `${init?.method} ${new URL(String(url)).pathname}`),
	};
}

/** A clock for the waiting tools: sleeping moves the faked Date on. */
const testClock = {
	now: () => Date.now(),
	sleep: async (ms: number) => {
		vi.setSystemTime(Date.now() + ms);
	},
};

function runEach(f: Fixture, jobId: string, userId: string, execute: boolean) {
	return [
		f.tools.resendDelivery({ userId, jobId, execute }),
		f.tools.reattachDelivery({ userId, jobId, execute }),
		f.tools.recoverConsolidation({
			userId,
			bankId: f.bank.id,
			execute,
			clock: testClock,
		}),
		f.tools.drainMemory({ userId, execute, clock: testClock }),
	];
}

describe("the Memory operator tools", () => {
	it("refuse the excluded account and an unknown one at their first step, and write nothing", async () => {
		const f = await setup();
		const jobId = await f.failedDelivery("failed");
		await f.markExcluded(h.userId);
		const before = JSON.stringify([f.job(), f.revision()]);
		for (const userId of [h.userId, "nobody"]) {
			const reports = await Promise.all(runEach(f, jobId, userId, true));
			for (const report of reports) {
				expect(report.outcome).toBe("refused");
				expect(report.steps).toEqual([
					{
						step: "guard",
						ok: false,
						code:
							userId === h.userId
								? "memory_migration_excluded"
								: "unknown_account",
					},
				]);
			}
		}
		expect(JSON.stringify([f.job(), f.revision()])).toBe(before);
		expect(f.fetcher).not.toHaveBeenCalled();
	});

	it.each([
		["resend", "failed"],
		["reattach", "completed"],
		["recover-consolidation", "failed"],
		["drain", "failed"],
	] as const)("%s writes nothing on a dry run", async (tool, operation) => {
		const f = await setup();
		const jobId = await f.failedDelivery(operation);
		// A fact of another chat stuck in consolidation: work for the recover tool.
		f.hindsight.facts.push({
			id: "stuck",
			text: "Blue bicycle",
			fact_type: "world",
			document_id: "another-chat",
			consolidated_at: null,
			consolidation_failed_at: "2026-11-22T00:00:00Z",
		});
		const before = written(f);
		const userId = h.userId;
		const report = await {
			resend: () => f.tools.resendDelivery({ userId, jobId, execute: false }),
			reattach: () =>
				f.tools.reattachDelivery({ userId, jobId, execute: false }),
			"recover-consolidation": () =>
				f.tools.recoverConsolidation({
					userId,
					bankId: f.bank.id,
					execute: false,
					clock: testClock,
				}),
			drain: () =>
				f.tools.drainMemory({ userId, execute: false, clock: testClock }),
		}[tool]();
		expect(report.tool).toBe(tool);
		expect(report.outcome).toBe("dry_run");
		expect(written(f)).toEqual(before);
	});

	it("refuse another account's job or bank at their own step, and write nothing", async () => {
		const f = await setup();
		const jobId = await f.failedDelivery("completed");
		const other = h.fixture.seedUser("user-2");
		const before = written(f);
		const reports = await Promise.all([
			f.tools.resendDelivery({ userId: other, jobId, execute: true }),
			f.tools.reattachDelivery({ userId: other, jobId, execute: true }),
			f.tools.recoverConsolidation({
				userId: other,
				bankId: f.bank.id,
				execute: true,
				clock: testClock,
			}),
		]);
		expect(
			reports.map((report) => [
				report.outcome,
				report.steps.at(-1)?.step,
				report.steps.at(-1)?.code,
			]),
		).toEqual([
			["refused", "job", "job_not_found"],
			["refused", "job", "job_not_found"],
			["refused", "bank", "bank_not_found"],
		]);
		expect(written(f)).toEqual(before);
	});

	it.each([
		["resend", "failed"],
		["reattach", "completed"],
	] as const)(
		"%s refuses, writing nothing, when the chat changed after its checks",
		async (tool, operation) => {
			const f = await setup();
			const jobId = await f.failedDelivery(operation);
			const inner = f.fetcher.getMockImplementation();
			if (!inner) throw Error("Missing fixture fetch");
			let before: ReturnType<typeof written> | undefined;
			f.fetcher.mockImplementation(async (url, init) => {
				const response = await inner(url, init);
				if (!before && String(url).includes("/memories/list")) {
					// Another operator's resend lands between this tool's checks and its reopen.
					f.db
						.update(f.schema.memorySourceRevisions)
						.set({
							nativeOperationId: "another-resend",
							nativeSubmitted: false,
						})
						.run();
					before = written(f);
				}
				return response;
			});
			const report = await (tool === "resend"
				? f.tools.resendDelivery
				: f.tools.reattachDelivery)({ userId: h.userId, jobId, execute: true });
			expect(report.outcome).toBe("refused");
			expect(report.steps.at(-1)).toMatchObject({
				step: tool,
				ok: false,
				code: "reopen_refused",
			});
			expect(before).toBeDefined();
			expect(written(f)).toEqual(before);
			expect(f.job()?.status).toBe("failed");
		},
	);

	describe("resend", () => {
		it("looks without writing on a dry run, then sends the chat again under a new operation", async () => {
			const f = await setup();
			const jobId = await f.failedDelivery("failed");
			const old = f.source.nativeOperationId as string;
			const dry = await f.tools.resendDelivery({
				userId: h.userId,
				jobId,
				execute: false,
			});
			expect(dry.outcome).toBe("dry_run");
			expect(dry.steps.map((s) => [s.step, s.ok])).toEqual([
				["guard", true],
				["job", true],
				["operation", true],
				["bank_quiet", true],
				["document", true],
			]);
			expect(f.job()?.status).toBe("failed");
			expect(f.revision()?.nativeOperationId).toBe(old);

			const done = await f.tools.resendDelivery({
				userId: h.userId,
				jobId,
				execute: true,
			});
			expect(done.outcome).toBe("done");
			const fresh = f.revision()?.nativeOperationId as string;
			expect(fresh).not.toBe(old);
			// Written as not yet sent: nothing polls it before the job sends it.
			expect(f.revision()).toMatchObject({
				nativeSubmitted: false,
				nativeAcknowledged: false,
			});
			expect(JSON.parse(f.revision()?.context ?? "{}")).toEqual({
				messages: [],
				nativeRetainResentFrom: old,
			});
			expect(f.job()?.status).toBe("queued");
			await h.engine.drain(f.jobs.memoryDeliveryJob);
			expect(f.hindsight.posted).toEqual([fresh]);
			expect(f.job()?.status).toBe("succeeded");
		});

		it.each<[string, string, string, (f: Fixture) => void]>([
			[
				"the operation is still running",
				"operation",
				"operation_processing",
				(f) =>
					f.hindsight.operations.set(
						f.source.nativeOperationId as string,
						"processing",
					),
			],
			[
				"Hindsight finished the retain after all",
				"operation",
				"operation_completed",
				(f) =>
					f.hindsight.operations.set(
						f.source.nativeOperationId as string,
						"completed",
					),
			],
			[
				"Hindsight holds facts under the document",
				"document",
				"facts_under_document",
				(f) =>
					f.hindsight.facts.push({
						id: "left",
						text: "Green kayak",
						fact_type: "world",
						document_id: f.source.id,
					}),
			],
			[
				"the bank is busy",
				"bank_quiet",
				"bank_busy",
				(f) => f.hindsight.pending.push("other-operation"),
			],
			[
				"another process is running the job",
				"job",
				"job_running",
				(f) =>
					f.db
						.update(f.schema.memoryDeliveryJobs)
						.set({ status: "running" })
						.run(),
			],
			[
				"the retain was acknowledged",
				"job",
				"retain_already_acknowledged",
				(f) =>
					f.db
						.update(f.schema.memorySourceRevisions)
						.set({ nativeAcknowledged: true })
						.run(),
			],
		])(
			"refuses, writing nothing, when %s",
			async (situation, step, code, arrange) => {
				const f = await setup();
				const jobId = await f.failedDelivery("failed");
				const id = f.source.nativeOperationId as string;
				arrange(f);
				const before = written(f);
				const report = await f.tools.resendDelivery({
					userId: h.userId,
					jobId,
					execute: true,
				});
				expect(report.outcome, situation).toBe("refused");
				expect(report.steps.at(-1)).toMatchObject({ step, ok: false, code });
				expect(f.job()?.status).toBe(
					code === "job_running" ? "running" : "failed",
				);
				expect(f.revision()?.nativeOperationId).toBe(id);
				expect(written(f)).toEqual(before);
			},
		);

		it("refuses a job that is not failed, or is another account's", async () => {
			const f = await setup();
			const queued = await f.enqueue();
			const before = written(f);
			const report = await f.tools.resendDelivery({
				userId: h.userId,
				jobId: queued.row.id,
				execute: true,
			});
			expect(report.steps.at(-1)).toMatchObject({
				step: "job",
				code: "job_queued",
			});
			const other = h.fixture.seedUser("user-2");
			const theirs = await f.tools.resendDelivery({
				userId: other,
				jobId: queued.row.id,
				execute: true,
			});
			expect(theirs.steps.at(-1)).toMatchObject({
				step: "job",
				code: "job_not_found",
			});
			expect(written(f)).toEqual(before);
		});

		// A chat whose retain landed but whose delivery failed after: its facts hold
		// the bank up, and the way out is to delete the document and send it again.
		describe("with deleteLanded", () => {
			/** A failed delivery whose retain completed, acknowledged, its document holding a fact. */
			async function landedDelivery(f: Fixture) {
				const jobId = await f.failedDelivery("completed");
				f.db
					.update(f.schema.memorySourceRevisions)
					.set({
						nativeAcknowledged: true,
						acknowledgedFactsJson: JSON.stringify([
							{ id: "delivered", text: "Green kayak" },
						]),
					})
					.run();
				return jobId;
			}
			const stepNames = (report: { steps: Array<{ step: string }> }) =>
				report.steps.map((s) => s.step);

			it("looks without writing on a dry run, and says how many facts it would delete", async () => {
				const f = await setup();
				const jobId = await landedDelivery(f);
				const before = written(f);
				const dry = await f.tools.resendDelivery({
					userId: h.userId,
					jobId,
					execute: false,
					deleteLanded: true,
				});
				expect(dry.outcome).toBe("dry_run");
				expect(dry.steps.map((s) => [s.step, s.ok])).toEqual([
					["guard", true],
					["job", true],
					["operation", true],
					["bank_quiet", true],
					["document", true],
				]);
				expect(dry.steps[1]).toMatchObject({ counts: { acknowledged: 1 } });
				expect(dry.steps[2]).toMatchObject({ detail: "completed" });
				expect(dry.steps[4]).toMatchObject({ counts: { facts: 1 } });
				expect(written(f)).toEqual(before);
				expect(f.hindsight.deleted).toEqual([]);
			});

			it("deletes the document, waits for the bank to be quiet, and sends the chat again as if never sent", async () => {
				const f = await setup();
				vi.useFakeTimers({ toFake: ["Date"] });
				const jobId = await landedDelivery(f);
				const old = f.source.nativeOperationId as string;
				const sleeps: number[] = [];
				const done = await f.tools.resendDelivery({
					userId: h.userId,
					jobId,
					execute: true,
					deleteLanded: true,
					clock: {
						now: () => Date.now(),
						sleep: async (ms) => {
							sleeps.push(ms);
							// Hindsight finishes consolidating what was left a few looks later.
							if (sleeps.length === 2) f.hindsight.pending.length = 0;
							vi.setSystemTime(Date.now() + ms);
						},
					},
				});
				expect(done.outcome).toBe("done");
				expect(stepNames(done)).toEqual([
					"guard",
					"job",
					"operation",
					"bank_quiet",
					"document",
					"delete_document",
					"bank_settled",
					"document_after",
					"resend",
				]);
				expect(f.hindsight.deleted).toEqual([f.source.id]);
				expect(sleeps).toEqual([2_000, 2_000]);
				expect(
					done.steps.find((s) => s.step === "document_after"),
				).toMatchObject({ counts: { facts: 0 } });
				const fresh = f.revision()?.nativeOperationId as string;
				expect(fresh).not.toBe(old);
				expect(f.revision()).toMatchObject({
					nativeSubmitted: false,
					nativeAcknowledged: false,
					acknowledgedFactsJson: "[]",
				});
				expect(JSON.parse(f.revision()?.context ?? "{}")).toEqual({
					messages: [],
					nativeRetainResentFrom: old,
				});
				expect(f.job()).toMatchObject({ status: "queued", errorCode: null });
				// The job sends the whole chat once more, under the fresh operation.
				await h.engine.drain(f.jobs.memoryDeliveryJob);
				expect(f.hindsight.posted).toEqual([fresh]);
				expect(f.job()?.status).toBe("succeeded");
			});

			it("sends again without deleting when nothing is left under the document", async () => {
				const f = await setup();
				const jobId = await f.failedDelivery("failed");
				f.db
					.update(f.schema.memorySourceRevisions)
					.set({
						nativeAcknowledged: true,
						acknowledgedFactsJson: JSON.stringify([
							{ id: "gone", text: "Green kayak" },
						]),
					})
					.run();
				const done = await f.tools.resendDelivery({
					userId: h.userId,
					jobId,
					execute: true,
					deleteLanded: true,
					clock: testClock,
				});
				expect(done.outcome).toBe("done");
				expect(stepNames(done)).toEqual([
					"guard",
					"job",
					"operation",
					"bank_quiet",
					"document",
					"resend",
				]);
				expect(f.hindsight.deleted).toEqual([]);
				expect(f.revision()).toMatchObject({
					nativeSubmitted: false,
					nativeAcknowledged: false,
					acknowledgedFactsJson: "[]",
				});
				expect(f.job()?.status).toBe("queued");
			});

			it("refuses facts_remain, leaving the chat as it was, when the facts are still listed after the delete", async () => {
				const f = await setup();
				vi.useFakeTimers({ toFake: ["Date"] });
				const jobId = await landedDelivery(f);
				f.hindsight.keepFactsOnDelete = true;
				// The bank is quiet again at the first look.
				const inner = f.fetcher.getMockImplementation();
				if (!inner) throw Error("Missing fixture fetch");
				f.fetcher.mockImplementation(async (url, init) => {
					const response = await inner(url, init);
					if (init?.method === "DELETE") f.hindsight.pending.length = 0;
					return response;
				});
				const revisionBefore = JSON.stringify(f.revision());
				const report = await f.tools.resendDelivery({
					userId: h.userId,
					jobId,
					execute: true,
					deleteLanded: true,
					clock: testClock,
				});
				expect(report.outcome).toBe("refused");
				expect(report.steps.at(-1)).toMatchObject({
					step: "document_after",
					ok: false,
					code: "facts_remain",
					counts: { facts: 1 },
				});
				expect(f.hindsight.deleted).toEqual([f.source.id]);
				expect(f.job()?.status).toBe("failed");
				expect(JSON.stringify(f.revision())).toBe(revisionBefore);
			});

			it("refuses bank_busy, leaving the chat as it was, when the bank never goes quiet after the delete", async () => {
				const f = await setup();
				vi.useFakeTimers({ toFake: ["Date"] });
				vi.spyOn(f.config, "getMemoryNativeWaits").mockReturnValue({
					retainMs: 30_000,
					consolidationMs: 10_000,
				});
				const jobId = await landedDelivery(f);
				const start = Date.now();
				const revisionBefore = JSON.stringify(f.revision());
				const report = await f.tools.resendDelivery({
					userId: h.userId,
					jobId,
					execute: true,
					deleteLanded: true,
					clock: testClock,
				});
				expect(report.outcome).toBe("refused");
				expect(report.steps.at(-1)).toMatchObject({
					step: "bank_settled",
					ok: false,
					code: "bank_busy",
					counts: { pending: 1 },
				});
				// It waited the consolidation wait out and no longer.
				expect(Date.now() - start).toBe(10_000);
				expect(f.job()?.status).toBe("failed");
				expect(JSON.stringify(f.revision())).toBe(revisionBefore);
			});

			it("refuses at the reopen, after the delete, when the chat changed in between", async () => {
				const f = await setup();
				vi.useFakeTimers({ toFake: ["Date"] });
				const jobId = await landedDelivery(f);
				const inner = f.fetcher.getMockImplementation();
				if (!inner) throw Error("Missing fixture fetch");
				f.fetcher.mockImplementation(async (url, init) => {
					const response = await inner(url, init);
					if (init?.method === "DELETE") {
						// The bank is quiet at once, and another operator's resend lands.
						f.hindsight.pending.length = 0;
						f.db
							.update(f.schema.memorySourceRevisions)
							.set({ nativeOperationId: "another-resend" })
							.run();
					}
					return response;
				});
				const report = await f.tools.resendDelivery({
					userId: h.userId,
					jobId,
					execute: true,
					deleteLanded: true,
					clock: testClock,
				});
				expect(report.outcome).toBe("refused");
				expect(report.steps.at(-1)).toMatchObject({
					step: "resend",
					ok: false,
					code: "reopen_refused",
				});
				expect(f.job()?.status).toBe("failed");
				expect(f.revision()?.nativeOperationId).toBe("another-resend");
			});

			it.each<[string, string, string, (f: Fixture) => void]>([
				[
					"the retain is still running",
					"operation",
					"operation_processing",
					(f) =>
						f.hindsight.operations.set(
							f.source.nativeOperationId as string,
							"processing",
						),
				],
				[
					"the bank is busy",
					"bank_quiet",
					"bank_busy",
					(f) => f.hindsight.pending.push("other-operation"),
				],
				[
					"another process is running the job",
					"job",
					"job_running",
					(f) =>
						f.db
							.update(f.schema.memoryDeliveryJobs)
							.set({ status: "running" })
							.run(),
				],
				[
					"the chat was withdrawn",
					"job",
					"source_revoked",
					(f) =>
						f.db
							.update(f.schema.memorySourceRevisions)
							.set({ state: "revoked" })
							.run(),
				],
			])(
				"still refuses, deleting nothing, when %s",
				async (situation, step, code, arrange) => {
					const f = await setup();
					const jobId = await landedDelivery(f);
					arrange(f);
					const before = written(f);
					const report = await f.tools.resendDelivery({
						userId: h.userId,
						jobId,
						execute: true,
						deleteLanded: true,
						clock: testClock,
					});
					expect(report.outcome, situation).toBe("refused");
					expect(report.steps.at(-1)).toMatchObject({ step, ok: false, code });
					expect(f.hindsight.deleted).toEqual([]);
					expect(written(f)).toEqual(before);
				},
			);

			it("without the flag still refuses an acknowledged delivery whose retain landed", async () => {
				const f = await setup();
				const jobId = await landedDelivery(f);
				const before = written(f);
				const report = await f.tools.resendDelivery({
					userId: h.userId,
					jobId,
					execute: true,
				});
				expect(report.outcome).toBe("refused");
				expect(report.steps.at(-1)).toMatchObject({
					step: "job",
					code: "retain_already_acknowledged",
				});
				expect(written(f)).toEqual(before);
				expect(f.hindsight.deleted).toEqual([]);
			});
		});
	});

	describe("reattach", () => {
		it("acknowledges a delivered document and lets its job go on without sending it again", async () => {
			const f = await setup();
			const jobId = await f.failedDelivery("completed");
			const report = await f.tools.reattachDelivery({
				userId: h.userId,
				jobId,
				execute: true,
			});
			expect(report.outcome).toBe("done");
			expect(report.steps.find((s) => s.step === "document")).toMatchObject({
				counts: { facts: 1 },
			});
			expect(f.revision()).toMatchObject({
				nativeSubmitted: true,
				nativeAcknowledged: true,
			});
			await h.engine.drain(f.jobs.memoryDeliveryJob);
			expect(f.hindsight.posted).toEqual([]);
			expect(f.job()?.status).toBe("succeeded");
		});

		it("refuses a document Hindsight does not hold", async () => {
			const f = await setup();
			const jobId = await f.failedDelivery("failed");
			const before = written(f);
			const report = await f.tools.reattachDelivery({
				userId: h.userId,
				jobId,
				execute: true,
			});
			expect(report.outcome).toBe("refused");
			expect(report.steps.at(-1)).toMatchObject({
				step: "document",
				code: "document_not_delivered",
				counts: { facts: 0 },
			});
			expect(f.revision()?.nativeAcknowledged).toBe(false);
			expect(written(f)).toEqual(before);
		});

		it.each<[string, string, string, (f: Fixture) => void]>([
			[
				"the bank is busy",
				"bank_quiet",
				"bank_busy",
				(f) => f.hindsight.pending.push("other-operation"),
			],
			[
				"another process is running the job",
				"job",
				"job_running",
				(f) =>
					f.db
						.update(f.schema.memoryDeliveryJobs)
						.set({ status: "running" })
						.run(),
			],
			[
				"the job was queued again",
				"job",
				"job_queued",
				(f) =>
					f.db
						.update(f.schema.memoryDeliveryJobs)
						.set({ status: "queued" })
						.run(),
			],
			[
				"the chat was never sent",
				"job",
				"source_never_sent",
				(f) =>
					f.db
						.update(f.schema.memorySourceRevisions)
						.set({ nativeSubmitted: false })
						.run(),
			],
			[
				"the chat was withdrawn",
				"job",
				"source_revoked",
				(f) =>
					f.db
						.update(f.schema.memorySourceRevisions)
						.set({ state: "revoked" })
						.run(),
			],
		])(
			"refuses, writing nothing, when %s",
			async (situation, step, code, arrange) => {
				const f = await setup();
				const jobId = await f.failedDelivery("completed");
				arrange(f);
				const before = written(f);
				const report = await f.tools.reattachDelivery({
					userId: h.userId,
					jobId,
					execute: true,
				});
				expect(report.outcome, situation).toBe("refused");
				expect(report.steps.at(-1)).toMatchObject({ step, ok: false, code });
				expect(written(f)).toEqual(before);
			},
		);
	});

	describe("recover consolidation", () => {
		it("resets the failed facts, runs a consolidation and counts again", async () => {
			const f = await setup();
			f.hindsight.facts.push(
				{
					id: "stuck",
					text: "Green kayak",
					fact_type: "world",
					document_id: f.source.id,
					consolidated_at: null,
					consolidation_failed_at: "2026-11-22T00:00:00Z",
				},
				{
					id: "fine",
					text: "Blue bicycle",
					fact_type: "world",
					document_id: "other",
					consolidated_at: "2026-11-18T00:00:00Z",
				},
			);
			const dry = await f.tools.recoverConsolidation({
				userId: h.userId,
				bankId: f.bank.id,
				execute: false,
				clock: testClock,
			});
			expect(dry.outcome).toBe("dry_run");
			expect(f.hindsight.recovered).toBe(0);
			const done = await f.tools.recoverConsolidation({
				userId: h.userId,
				bankId: f.bank.id,
				execute: true,
				clock: testClock,
			});
			expect(done.outcome).toBe("done");
			expect(done.steps.map((s) => s.step)).toEqual([
				"guard",
				"bank",
				"failed_facts",
				"bank_quiet",
				"recover",
				"consolidate",
				"consolidation_settled",
				"failed_facts_after",
			]);
			expect(done.steps[2]).toMatchObject({
				counts: { failed: 1, unconsolidated: 1 },
			});
			expect(done.steps.at(-1)).toMatchObject({
				ok: true,
				counts: { failed: 0, unconsolidated: 0 },
			});
			expect(f.hindsight.recovered).toBe(1);
			expect(f.hindsight.consolidations).toBe(1);
		});

		it.each<[string, string, string, (f: Fixture) => void, RegExp[]]>([
			[
				"the bank is busy",
				"bank_quiet",
				"bank_busy",
				(f) => f.hindsight.pending.push("other-operation"),
				[],
			],
			[
				"the consolidation fails",
				"consolidation_settled",
				"consolidation_failed",
				(f) => {
					const inner = f.fetcher.getMockImplementation();
					if (!inner) throw Error("Missing fixture fetch");
					f.fetcher.mockImplementation(async (url, init) => {
						const response = await inner(url, init);
						if (String(url).endsWith("/consolidate"))
							f.hindsight.operations.set(
								`consolidation-${f.hindsight.consolidations}`,
								"failed",
							);
						return response;
					});
				},
				[/^POST .*\/consolidation\/recover$/, /^POST .*\/consolidate$/],
			],
			[
				"the facts stay failed",
				"failed_facts_after",
				"facts_still_failed",
				(f) => {
					const inner = f.fetcher.getMockImplementation();
					if (!inner) throw Error("Missing fixture fetch");
					f.fetcher.mockImplementation(async (url, init) =>
						String(url).endsWith("/consolidation/recover")
							? new Response(JSON.stringify({ recovered: 0 }))
							: inner(url, init),
					);
				},
				[/^POST .*\/consolidation\/recover$/, /^POST .*\/consolidate$/],
			],
		])(
			"refuses when %s, writing nothing of the app's and only its own steps to Hindsight",
			async (situation, step, code, arrange, sent) => {
				const f = await setup();
				f.hindsight.facts.push({
					id: "stuck",
					text: "Green kayak",
					fact_type: "world",
					document_id: f.source.id,
					consolidated_at: null,
					consolidation_failed_at: "2026-11-22T00:00:00Z",
				});
				arrange(f);
				const before = written(f);
				const report = await f.tools.recoverConsolidation({
					userId: h.userId,
					bankId: f.bank.id,
					execute: true,
					clock: testClock,
				});
				expect(report.outcome, situation).toBe("refused");
				expect(report.steps.at(-1)).toMatchObject({ step, ok: false, code });
				const after = written(f);
				expect(after.db).toBe(before.db);
				expect(after.hindsight).toEqual(
					sent.map((pattern) => expect.stringMatching(pattern)),
				);
			},
		);
	});

	describe("drain", () => {
		it("retries what failed retryably, waits out holds, skips what cannot run and says why", async () => {
			const f = await setup();
			vi.useFakeTimers({ toFake: ["Date"] });
			// A delivery that timed out waiting on Hindsight: retryable, retried once.
			const timedOut = await f.enqueue();
			f.db
				.update(f.schema.memoryDeliveryJobs)
				.set({
					status: "failed",
					errorCode: "native_operation_timeout",
					retryable: true,
					attemptCount: 1,
				})
				.run();
			// A second chat whose delivery ended for good: skipped, with its code.
			const rev = await import("./revisions");
			const held = rev.recordMemorySource({
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				eventId: "event-2",
				lineageId: "message-2",
				text: "My sister plays the bassoon",
				context: JSON.stringify({ messages: [] }),
				assertedAt: new Date("2026-11-19"),
			});
			const ended = await f.jobs.enqueueMemoryDelivery({
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				kind: "source",
				sourceId: held.id,
				requestId: "request-2",
			});
			const { eq } = await import("drizzle-orm");
			f.db
				.update(f.schema.memoryDeliveryJobs)
				.set({
					status: "failed",
					errorCode: "native_retain_resubmit_failed",
					retryable: false,
				})
				.where(eq(f.schema.memoryDeliveryJobs.id, ended.row.id))
				.run();
			// Another account's queued job: never this drain's.
			const other = h.fixture.seedUser("user-2");
			const otherBank = rev.ensureMemoryBank(other, { kind: "personal" });
			const theirs = await f.jobs.enqueueMemoryDelivery({
				userId: other,
				bankId: otherBank.id,
				epoch: 0,
				kind: "provision",
				requestId: "their-request",
			});
			// The first try of the retried job meets a busy bank once: a hold it waits out.
			let busyOnce = true;
			const inner = f.fetcher.getMockImplementation();
			if (!inner) throw Error("Missing fixture fetch");
			f.fetcher.mockImplementation(async (url, init) => {
				if (busyOnce && String(url).includes("/operations?status=pending")) {
					busyOnce = false;
					return new Response(
						JSON.stringify({
							operations: [{ id: "someone-elses", status: "pending" }],
						}),
					);
				}
				if (String(url).includes("/operations/someone-elses"))
					return new Response(JSON.stringify({ status: "completed" }));
				return inner(url, init);
			});
			const dry = await f.tools.drainMemory({
				userId: h.userId,
				execute: false,
				clock: testClock,
			});
			expect(dry.outcome).toBe("dry_run");
			expect(dry.steps[1]).toMatchObject({
				step: "jobs",
				counts: { failed: 2 },
			});
			const report = await f.tools.drainMemory({
				userId: h.userId,
				execute: true,
				clock: testClock,
			});
			expect(report.outcome).toBe("done");
			expect(report.steps.find((s) => s.step === "retry_failed")).toMatchObject(
				{
					ids: [timedOut.row.id],
				},
			);
			const summary = report.steps.find((s) => s.step === "summary");
			expect(summary?.counts).toMatchObject({ succeeded: 1, failed: 1 });
			expect(summary?.skipped).toEqual([
				{
					id: ended.row.id,
					kind: "source",
					status: "failed",
					code: "native_retain_resubmit_failed",
				},
			]);
			expect(
				f.db
					.select()
					.from(f.schema.memoryDeliveryJobs)
					.where(eq(f.schema.memoryDeliveryJobs.id, theirs.row.id))
					.get()?.status,
			).toBe("queued");
			// Counts, ids and codes only: no memory text anywhere in the report.
			expect(JSON.stringify(report)).not.toMatch(/kayak|bassoon/i);
		});

		it("gives way to another account's due job, and takes its own once that one is taken up", async () => {
			const f = await setup();
			vi.useFakeTimers({ toFake: ["Date"] });
			const { eq } = await import("drizzle-orm");
			const rev = await import("./revisions");
			const other = h.fixture.seedUser("user-2");
			const otherBank = rev.ensureMemoryBank(other, { kind: "personal" });
			const theirs = await f.jobs.enqueueMemoryDelivery({
				userId: other,
				bankId: otherBank.id,
				epoch: 0,
				kind: "provision",
				requestId: "their-request",
			});
			const mine = await f.enqueue();
			const statusOf = (id: string) =>
				f.db
					.select()
					.from(f.schema.memoryDeliveryJobs)
					.where(eq(f.schema.memoryDeliveryJobs.id, id))
					.get()?.status;
			const waited: string[] = [];
			const report = await f.tools.drainMemory({
				userId: h.userId,
				execute: true,
				clock: {
					now: () => Date.now(),
					sleep: async (ms) => {
						waited.push(`${ms}ms with mine ${statusOf(mine.row.id)}`);
						// Their own worker takes their job while this drain waits.
						f.db
							.update(f.schema.memoryDeliveryJobs)
							.set({ status: "succeeded" })
							.where(eq(f.schema.memoryDeliveryJobs.id, theirs.row.id))
							.run();
						vi.setSystemTime(Date.now() + ms);
					},
				},
			});

			expect(waited[0]).toBe("2000ms with mine queued");
			expect(report.outcome).toBe("done");
			expect(statusOf(mine.row.id)).toBe("succeeded");
		});

		it("refuses with the Memory worker off, retrying nothing", async () => {
			const f = await setup();
			await f.enqueue();
			f.db
				.update(f.schema.memoryDeliveryJobs)
				.set({
					status: "failed",
					errorCode: "native_operation_timeout",
					retryable: true,
					attemptCount: 1,
				})
				.run();
			const config = await import("$lib/server/config-store");
			vi.spyOn(config, "getConfig").mockReturnValue({
				...config.getConfig(),
				hindsightWorkerEnabled: false,
			});
			const before = written(f);
			const report = await f.tools.drainMemory({
				userId: h.userId,
				execute: true,
				clock: testClock,
			});
			expect(report.outcome).toBe("refused");
			expect(report.steps.at(-1)).toMatchObject({
				step: "worker_enabled",
				ok: false,
				code: "memory_worker_disabled",
			});
			expect(written(f)).toEqual(before);
		});

		it("leaves a job another process is running alone, waits for it, and says so", async () => {
			const f = await setup();
			vi.useFakeTimers({ toFake: ["Date"] });
			const running = await f.enqueue();
			f.db.update(f.schema.memoryDeliveryJobs).set({ status: "running" }).run();
			const before = written(f);
			const report = await f.tools.drainMemory({
				userId: h.userId,
				execute: true,
				maxMinutes: 1,
				clock: testClock,
			});
			expect(report.outcome).toBe("done");
			expect(report.steps.find((s) => s.step === "retry_failed")).toMatchObject(
				{ ids: [] },
			);
			expect(report.steps.find((s) => s.step === "summary")?.skipped).toEqual([
				{ id: running.row.id, kind: "source", status: "running", code: null },
			]);
			expect(written(f)).toEqual(before);
		});

		it("looks again every few seconds, not every second, at a due job it cannot claim", async () => {
			const f = await setup();
			vi.useFakeTimers({ toFake: ["Date"] });
			const { eq } = await import("drizzle-orm");
			const rev = await import("./revisions");
			// Another account's job holds the one slot (HINDSIGHT_CONCURRENCY 1) all along.
			const other = h.fixture.seedUser("user-2");
			const otherBank = rev.ensureMemoryBank(other, { kind: "personal" });
			const theirs = await f.jobs.enqueueMemoryDelivery({
				userId: other,
				bankId: otherBank.id,
				epoch: 0,
				kind: "provision",
				requestId: "their-request",
			});
			f.db
				.update(f.schema.memoryDeliveryJobs)
				.set({ status: "running" })
				.where(eq(f.schema.memoryDeliveryJobs.id, theirs.row.id))
				.run();
			// This account's delivery was put back behind a delay that has passed:
			// due, and never claimable while the slot is taken.
			const due = await f.enqueue();
			f.db
				.update(f.schema.memoryDeliveryJobs)
				.set({ runAfter: new Date(Date.now() - 10_000) })
				.where(eq(f.schema.memoryDeliveryJobs.id, due.row.id))
				.run();
			const sleeps: number[] = [];
			const report = await f.tools.drainMemory({
				userId: h.userId,
				execute: true,
				maxMinutes: 1,
				clock: {
					now: () => Date.now(),
					sleep: async (ms) => {
						sleeps.push(ms);
						vi.setSystemTime(Date.now() + ms);
					},
				},
			});
			expect(report.outcome).toBe("done");
			expect(sleeps.length).toBeGreaterThan(0);
			expect(Math.min(...sleeps)).toBeGreaterThanOrEqual(5_000);
			expect(
				report.steps.find((s) => s.step === "drain")?.counts?.rounds,
			).toBeLessThanOrEqual(13);
			expect(report.steps.find((s) => s.step === "summary")?.skipped).toEqual([
				{ id: due.row.id, kind: "source", status: "queued", code: null },
			]);
			expect(f.hindsight.posted).toEqual([]);
		});

		// A drain stopped mid-attempt (its process killed) leaves its job `running`
		// with a lease that goes stale and nobody to take it back: it held the box's
		// one Memory slot, and every account's Memory with it, for forty minutes.
		it("takes back this account's own job whose worker died, and leaves another account's alone", async () => {
			const f = await setup();
			vi.useFakeTimers({ toFake: ["Date"] });
			// Room for the other account's dead row beside this one: only the scope is under test.
			vi.spyOn(f.config, "getConfig").mockReturnValue({
				...f.config.getConfig(),
				hindsightConcurrency: 2,
			});
			const mine = await f.enqueue();
			const deadAttempt = f.leaveRunning(mine.row.id);
			const other = h.fixture.seedUser("user-2");
			const otherBank = f.rev.ensureMemoryBank(other, { kind: "personal" });
			const theirs = await f.jobs.enqueueMemoryDelivery({
				userId: other,
				bankId: otherBank.id,
				epoch: 0,
				kind: "provision",
				requestId: "their-request",
			});
			const theirAttempt = f.leaveRunning(theirs.row.id);

			const report = await f.tools.drainMemory({
				userId: h.userId,
				execute: true,
				clock: testClock,
			});

			expect(report.outcome).toBe("done");
			expect(report.steps.map((s) => s.step)).toEqual([
				"guard",
				"jobs",
				"worker_enabled",
				"recover_stale",
				"retry_failed",
				"drain",
				"summary",
			]);
			expect(report.steps.find((s) => s.step === "jobs")).toMatchObject({
				counts: { running: 1 },
			});
			expect(
				report.steps.find((s) => s.step === "recover_stale"),
			).toMatchObject({ ok: true, counts: { recovered: 1 } });
			expect(f.attemptById(deadAttempt)).toMatchObject({
				status: "failed",
				errorCode: "memory_worker_lost",
			});
			// It ran again, to the end.
			expect(f.jobById(mine.row.id)?.status).toBe("succeeded");
			expect(f.hindsight.posted).toEqual([f.source.nativeOperationId]);
			// The other account's worker is theirs to take back.
			expect(f.jobById(theirs.row.id)?.status).toBe("running");
			expect(f.attemptById(theirAttempt)?.status).toBe("running");
		});

		it("leaves a job whose worker still beats alone", async () => {
			const f = await setup();
			vi.useFakeTimers({ toFake: ["Date"] });
			const running = await f.enqueue();
			const attempt = f.leaveRunning(running.row.id);
			f.db
				.update(f.schema.memoryDeliveryAttempts)
				.set({ heartbeatAt: new Date() })
				.run();
			const before = written(f);
			const report = await f.tools.drainMemory({
				userId: h.userId,
				execute: true,
				maxMinutes: 1,
				clock: testClock,
			});
			expect(
				report.steps.find((s) => s.step === "recover_stale"),
			).toMatchObject({ counts: { recovered: 0 } });
			expect(f.attemptById(attempt)?.status).toBe("running");
			expect(written(f)).toEqual(before);
		});

		it("retries a job the recovery settled as failed for want of tries", async () => {
			const f = await setup();
			vi.useFakeTimers({ toFake: ["Date"] });
			const mine = await f.enqueue();
			// Its third attempt is the one that died: the policy has no try left to give.
			f.leaveRunning(mine.row.id, 3);

			const report = await f.tools.drainMemory({
				userId: h.userId,
				execute: true,
				clock: testClock,
			});

			expect(
				report.steps.find((s) => s.step === "recover_stale"),
			).toMatchObject({ counts: { recovered: 1 } });
			expect(report.steps.find((s) => s.step === "retry_failed")).toMatchObject(
				{
					ids: [mine.row.id],
				},
			);
			expect(f.jobById(mine.row.id)?.status).toBe("succeeded");
		});

		it("resumes its own put-back job before it gives way to another account's due job", async () => {
			const f = await setup();
			vi.useFakeTimers({ toFake: ["Date"] });
			const other = h.fixture.seedUser("user-2");
			const otherBank = f.rev.ensureMemoryBank(other, { kind: "personal" });
			const theirs = await f.jobs.enqueueMemoryDelivery({
				userId: other,
				bankId: otherBank.id,
				epoch: 0,
				kind: "provision",
				requestId: "their-request",
			});
			const mine = await f.enqueue();
			f.putBack(mine.row.id, -1_000);
			const atFirstWait: Array<string | undefined> = [];

			const report = await f.tools.drainMemory({
				userId: h.userId,
				execute: true,
				clock: {
					now: () => Date.now(),
					sleep: async (ms) => {
						atFirstWait.push(f.jobById(mine.row.id)?.status);
						vi.setSystemTime(Date.now() + ms);
					},
				},
			});

			expect(report.outcome).toBe("done");
			// Its wait budget ran while it sat: it was taken up before any waiting.
			expect(atFirstWait[0]).toBe("succeeded");
			expect(f.jobById(theirs.row.id)?.status).toBe("queued");
		});

		describe("past its time limit", () => {
			// A job put back waiting on Hindsight, due after the limit, and another
			// chat of the account that was never attempted, due after it too.
			async function limitedDrain(maxMinutes: number) {
				const f = await setup();
				vi.useFakeTimers({ toFake: ["Date"] });
				const first = await f.enqueue();
				f.putBack(first.row.id, 90_000);
				const second = await f.enqueueChat(
					"second",
					new Date(Date.now() + 75_000),
				);
				const start = Date.now();
				const report = await f.tools.drainMemory({
					userId: h.userId,
					execute: true,
					maxMinutes,
					clock: testClock,
				});
				return {
					f,
					first: first.row.id,
					second,
					report,
					elapsed: Date.now() - start,
				};
			}

			it("finishes the job it put back, and starts no job that was never attempted", async () => {
				const { f, first, second, report, elapsed } = await limitedDrain(1);

				expect(report.outcome).toBe("done");
				expect(f.jobById(first)?.status).toBe("succeeded");
				expect(f.jobById(second.jobId)).toMatchObject({
					status: "queued",
					attemptCount: 0,
				});
				// Only the first chat was sent; it ran after the limit.
				expect(f.hindsight.posted).toEqual([f.source.nativeOperationId]);
				expect(elapsed).toBeGreaterThan(60_000);
				expect(report.steps.find((s) => s.step === "drain")).toMatchObject({
					ok: true,
					counts: { finishedAfterDeadline: 1, leftInFlight: 0 },
				});
				expect(report.steps.find((s) => s.step === "summary")?.skipped).toEqual(
					[{ id: second.jobId, kind: "source", status: "queued", code: null }],
				);
			});

			it("starts that other chat too when the limit has not passed", async () => {
				const { f, first, second, report } = await limitedDrain(10);

				expect(f.jobById(first)?.status).toBe("succeeded");
				expect(f.jobById(second.jobId)?.status).toBe("succeeded");
				expect(report.steps.find((s) => s.step === "drain")).toMatchObject({
					counts: { finishedAfterDeadline: 0, leftInFlight: 0 },
				});
			});

			it("ends its tail at both of Hindsight's waits, leaving a job it could not claim", async () => {
				const f = await setup();
				vi.useFakeTimers({ toFake: ["Date"] });
				vi.spyOn(f.config, "getMemoryNativeWaits").mockReturnValue({
					retainMs: 60_000,
					consolidationMs: 120_000,
				});
				// Another account's job holds the one slot (HINDSIGHT_CONCURRENCY 1) all along.
				const other = h.fixture.seedUser("user-2");
				const otherBank = f.rev.ensureMemoryBank(other, { kind: "personal" });
				const theirs = await f.jobs.enqueueMemoryDelivery({
					userId: other,
					bankId: otherBank.id,
					epoch: 0,
					kind: "provision",
					requestId: "their-request",
				});
				f.setJob(theirs.row.id, { status: "running" });
				const mine = await f.enqueue();
				f.putBack(mine.row.id, -1_000);
				const start = Date.now();

				const report = await f.tools.drainMemory({
					userId: h.userId,
					execute: true,
					maxMinutes: 1,
					clock: testClock,
				});

				expect(report.outcome).toBe("done");
				// The limit, then the two waits, and no further than one look past them.
				expect(Date.now() - start).toBeGreaterThanOrEqual(60_000 + 180_000);
				expect(Date.now() - start).toBeLessThan(60_000 + 180_000 + 10_000);
				expect(report.steps.find((s) => s.step === "drain")).toMatchObject({
					ok: true,
					counts: { finishedAfterDeadline: 0, leftInFlight: 1 },
				});
				expect(report.steps.find((s) => s.step === "summary")?.skipped).toEqual(
					[
						{
							id: mine.row.id,
							kind: "source",
							status: "queued",
							code: "native_retain_waiting",
						},
					],
				);
				expect(f.hindsight.posted).toEqual([]);
			});

			it("does not wait on a drain that has nothing in flight", async () => {
				const f = await setup();
				vi.useFakeTimers({ toFake: ["Date"] });
				// Never attempted, and not due until well past the limit.
				await f.enqueueChat("later", new Date(Date.now() + 10 * 60_000));
				const start = Date.now();

				const report = await f.tools.drainMemory({
					userId: h.userId,
					execute: true,
					maxMinutes: 1,
					clock: testClock,
				});

				expect(report.outcome).toBe("done");
				// It ended with the limit: there was nothing to finish.
				expect(Date.now() - start).toBeLessThan(60_000 + 10_000);
				expect(report.steps.find((s) => s.step === "drain")).toMatchObject({
					counts: { finishedAfterDeadline: 0, leftInFlight: 0 },
				});
			});
		});
	});
});

it("prints nothing of a chat's text in any report", async () => {
	const f = await setup();
	const jobId = await f.failedDelivery("completed");
	const reports = await Promise.all([
		f.tools.resendDelivery({ userId: h.userId, jobId, execute: false }),
		f.tools.resendDelivery({
			userId: h.userId,
			jobId,
			execute: false,
			deleteLanded: true,
		}),
		f.tools.reattachDelivery({ userId: h.userId, jobId, execute: false }),
	]);
	expect(JSON.stringify(reports)).not.toMatch(/kayak/i);
});
