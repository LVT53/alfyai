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
		else if (path.endsWith("/memories") && init?.method === "POST") {
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
	return {
		db,
		schema,
		jobs,
		tools,
		bank,
		source,
		hindsight,
		fetcher,
		enqueue,
		job,
		revision,
		failedDelivery,
		markExcluded,
	};
}
type Fixture = Awaited<ReturnType<typeof setup>>;

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

		it.each([
			["the operation is still running", "operation_processing"],
			["Hindsight holds facts under the document", "facts_under_document"],
			["the bank is busy", "bank_busy"],
		])("refuses when %s", async (situation, code) => {
			const f = await setup();
			const jobId = await f.failedDelivery("failed");
			const id = f.source.nativeOperationId as string;
			if (code === "operation_processing")
				f.hindsight.operations.set(id, "processing");
			if (code === "facts_under_document")
				f.hindsight.facts.push({
					id: "left",
					text: "Green kayak",
					fact_type: "world",
					document_id: f.source.id,
				});
			if (code === "bank_busy") f.hindsight.pending.push("other-operation");
			const report = await f.tools.resendDelivery({
				userId: h.userId,
				jobId,
				execute: true,
			});
			expect(report.outcome, situation).toBe("refused");
			expect(report.steps.at(-1)).toMatchObject({ ok: false, code });
			expect(f.job()?.status).toBe("failed");
			expect(f.revision()?.nativeOperationId).toBe(id);
		});

		it("refuses a job that is not failed, or is another account's", async () => {
			const f = await setup();
			const queued = await f.enqueue();
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
		});
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
	});
});

it("prints nothing of a chat's text in any report", async () => {
	const f = await setup();
	const jobId = await f.failedDelivery("completed");
	const reports = await Promise.all([
		f.tools.resendDelivery({ userId: h.userId, jobId, execute: false }),
		f.tools.reattachDelivery({ userId: h.userId, jobId, execute: false }),
	]);
	expect(JSON.stringify(reports)).not.toMatch(/kayak/i);
});
