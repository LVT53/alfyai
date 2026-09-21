import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact } from "$lib/server/services/knowledge/types";
import { parseWorkerId } from "../worker-identity";
import { createFakeExtractor } from "./testing/fake-extractor";
import {
	createLedgerFixture,
	type LedgerFixture,
} from "./testing/ledger-fixtures";

type Worker = typeof import("./worker-runner");
type Ledger = typeof import("./job-ledger");

let fixture: LedgerFixture;
let worker: Worker;
let ledger: Ledger;
let storageDir: string;
const userId = "user-1";

beforeEach(async () => {
	fixture = createLedgerFixture("worker");
	fixture.seedUser(userId);

	storageDir = await mkdtemp(join(tmpdir(), "alfyai-worker-"));
	process.env.DATABASE_PATH = fixture.dbPath;
	vi.resetModules();
	worker = await import("./worker-runner");
	ledger = await import("./job-ledger");
	worker.resetExtractionWorkerForTests();
});

afterEach(async () => {
	fixture.cleanup();
	await rm(storageDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

/**
 * Storage paths are stored relative to cwd and joined against it by the worker,
 * so the fixture file has to be reachable that way.
 */
async function seedStoredDocument(name = "report.pdf"): Promise<string> {
	const absolute = join(storageDir, name);
	await writeFile(absolute, "stored bytes", "utf8");
	return fixture.seedArtifact({
		userId,
		name,
		storagePath: relative(process.cwd(), absolute),
		binaryHash: "a".repeat(64),
	});
}

async function enqueue(artifactId: string, fileName = "report.pdf") {
	const { job } = await ledger.enqueueExtractionJob({
		userId,
		conversationId: null,
		origin: "upload",
		intakeRoute: "mineru",
		fileName,
		mimeType: "application/pdf",
		sizeBytes: 12,
		sourceArtifactId: artifactId,
	});
	return job;
}

/**
 * Stands in for the real indexing step, but still inserts a real artifact row:
 * `normalized_artifact_id` carries a foreign key, so a fake that invented an id
 * would fail the completion write and hide whatever the test meant to prove.
 */
function fakePersist() {
	const calls: unknown[] = [];
	const persist = (async (params: unknown) => {
		calls.push(params);
		const id = fixture.seedArtifact({
			userId,
			type: "normalized_document",
			name: `normalized-${calls.length}.md`,
		});
		return { id } as Artifact;
	}) as never;
	return { persist, calls };
}

describe("executeNextExtractionJob", () => {
	it("walks the full ladder and succeeds", async () => {
		const artifactId = await seedStoredDocument();
		const job = await enqueue(artifactId);
		const extractor = createFakeExtractor({
			steps: [{ kind: "succeed", text: "hello world" }],
			emitHandleAfterPhase: "parsing",
		});
		const { persist, calls } = fakePersist();

		const result = await worker.executeNextExtractionJob({
			workerId: "w1",
			resolveExtractor: () => extractor,
			persistResult: persist,
		});

		expect(result).toEqual({ jobId: job.id, status: "succeeded" });

		const row = await ledger.getExtractionJobRow(job.id);
		expect(row?.status).toBe("succeeded");
		expect(row?.normalizedArtifactId).not.toBeNull();
		expect(row?.remoteHandleJson).toBeNull();

		const [attempt] = await ledger.listExtractionJobAttempts(job.id);
		expect(attempt.status).toBe("succeeded");
		expect(attempt.extractor).toBe("fake");
		expect(attempt.textLength).toBe("hello world".length);
		expect(calls).toHaveLength(1);
	});

	it("hands the extractor the artifact's hash, id and owner", async () => {
		// Δ1/Δ2: the ledger already holds the verified digest, so a backend must
		// never have to re-stream 200 MB to recompute it.
		const artifactId = await seedStoredDocument();
		await enqueue(artifactId);
		const extractor = createFakeExtractor({ steps: [{ kind: "succeed" }] });
		const { persist } = fakePersist();

		await worker.executeNextExtractionJob({
			workerId: "w1",
			resolveExtractor: () => extractor,
			persistResult: persist,
		});

		expect(extractor.calls[0].request).toMatchObject({
			contentSha256: "a".repeat(64),
			sourceArtifactId: artifactId,
			userId,
			intakeRoute: "mineru",
		});
	});

	it("returns null when nothing is claimable", async () => {
		expect(
			await worker.executeNextExtractionJob({ workerId: "w1" }),
		).toBeNull();
	});

	it("fails the job when the stored file cannot be located", async () => {
		const artifactId = fixture.seedArtifact({
			userId,
			name: "ghost.pdf",
			storagePath: null,
		});
		const job = await enqueue(artifactId, "ghost.pdf");

		const result = await worker.executeNextExtractionJob({
			workerId: "w1",
			resolveExtractor: () =>
				createFakeExtractor({ steps: [{ kind: "succeed" }] }),
		});

		expect(result).toEqual({ jobId: job.id, status: "failed" });
		const row = await ledger.getExtractionJobRow(job.id);
		expect(row?.errorCode).toBe("internal");
		expect(row?.retryable).toBe(false);
	});

	// F19. The missing-file branch reported "failed" whatever
	// `failExtractionAttempt` answered, so a worker that had already lost its
	// claim asserted a verdict it never wrote — the one thing the `applied`
	// flag exists to prevent, and which its two sibling branches honour.
	it("reports nothing when the claim is lost before the missing-file verdict", async () => {
		const artifactId = fixture.seedArtifact({
			userId,
			name: "ghost-lost.pdf",
			storagePath: null,
		});
		const job = await enqueue(artifactId, "ghost-lost.pdf");

		const result = await worker.executeNextExtractionJob({
			workerId: "w1",
			// Runs between the claim and the source lookup: whoever holds the
			// attempt now is the only legitimate writer.
			resolveExtractor: () => {
				fixture.sqlite
					.prepare(
						"UPDATE document_extraction_job_attempts SET status = 'canceled' WHERE job_id = ?",
					)
					.run(job.id);
				return createFakeExtractor({ steps: [{ kind: "succeed" }] });
			},
		});

		expect(result).toBeNull();
		const row = await ledger.getExtractionJobRow(job.id);
		expect(row?.status).toBe("uploading");
		expect(row?.errorCode).toBeNull();
	});

	it("requeues a retryable throw and fails a non-retryable one", async () => {
		const retryableArtifact = await seedStoredDocument("retry.pdf");
		const retryableJob = await enqueue(retryableArtifact, "retry.pdf");

		expect(
			await worker.executeNextExtractionJob({
				workerId: "w1",
				resolveExtractor: () =>
					createFakeExtractor({
						steps: [{ kind: "throw", code: "unavailable" }],
					}),
			}),
		).toEqual({ jobId: retryableJob.id, status: "queued" });

		const fatalArtifact = await seedStoredDocument("fatal.pdf");
		const fatalJob = await enqueue(fatalArtifact, "fatal.pdf");
		expect(
			await worker.executeNextExtractionJob({
				workerId: "w1",
				resolveExtractor: () =>
					createFakeExtractor({
						steps: [{ kind: "throw", code: "empty_result" }],
					}),
			}),
		).toEqual({ jobId: fatalJob.id, status: "failed" });
	});

	it("clears the handle when the remote forgot it", async () => {
		const artifactId = await seedStoredDocument();
		const job = await enqueue(artifactId);

		await worker.executeNextExtractionJob({
			workerId: "w1",
			resolveExtractor: () =>
				createFakeExtractor({
					steps: [{ kind: "throw", code: "protocol", handleUnknown: true }],
					emitHandleAfterPhase: "parsing",
				}),
		});

		const row = await ledger.getExtractionJobRow(job.id);
		expect(row?.status).toBe("queued");
		expect(row?.remoteHandleJson).toBeNull();
	});

	it("aborts and writes nothing when the claim is lost mid-extraction", async () => {
		const artifactId = await seedStoredDocument();
		const job = await enqueue(artifactId);
		const extractor = createFakeExtractor({ steps: [{ kind: "hang" }] });

		const running = worker.executeNextExtractionJob({
			workerId: "w1",
			resolveExtractor: () => extractor,
			heartbeatMs: 250,
		});

		// Another worker takes the claim out from under this one.
		await vi.waitFor(async () => {
			const row = await ledger.getExtractionJobRow(job.id);
			expect(row?.status).toBe("uploading");
		});
		await ledger.recoverStaleExtractionAttempts({
			staleBefore: new Date(Date.now() + 60_000),
			maxAttempts: 3,
			retryBaseMs: 2000,
			retryMaxMs: 60000,
			outageWindowMs: 1_800_000,
		});

		const result = await running;
		// The stale recovery already requeued it; the losing worker must report
		// nothing rather than assert a verdict it never wrote.
		expect(result).toBeNull();
		expect((await ledger.getExtractionJobRow(job.id))?.status).toBe("queued");
		const attempts = await ledger.listExtractionJobAttempts(job.id);
		expect(attempts).toHaveLength(1);
		expect(attempts[0].errorCode).toBe("stale_worker");
	});

	it("honours a cancel, calls the remote cancel, and survives it throwing", async () => {
		const artifactId = await seedStoredDocument();
		const job = await enqueue(artifactId);
		const extractor = createFakeExtractor({
			steps: [{ kind: "hang" }],
			emitHandleAfterPhase: "uploading",
		});
		extractor.cancelShouldThrow = true;

		const running = worker.executeNextExtractionJob({
			workerId: "w1",
			resolveExtractor: () => extractor,
			heartbeatMs: 100,
		});

		await vi.waitFor(async () => {
			const row = await ledger.getExtractionJobRow(job.id);
			expect(row?.remoteHandleJson).not.toBeNull();
		});
		await ledger.cancelExtractionJob({ userId, jobId: job.id });

		const result = await running;
		expect(result).toEqual({ jobId: job.id, status: "canceled" });
		expect(extractor.cancelCalls).toHaveLength(1);
		expect(extractor.cancelCalls[0].remoteJobId).toBe("remote-uploading");

		const row = await ledger.getExtractionJobRow(job.id);
		expect(row?.status).toBe("canceled");
	});

	it("fails the job when indexing throws, instead of claiming success", async () => {
		const artifactId = await seedStoredDocument();
		const job = await enqueue(artifactId);

		const result = await worker.executeNextExtractionJob({
			workerId: "w1",
			resolveExtractor: () =>
				createFakeExtractor({ steps: [{ kind: "succeed" }] }),
			persistResult: (async () => {
				throw new Error("chunk sync exploded");
			}) as never,
		});

		expect(result?.status).toBe("failed");
		const row = await ledger.getExtractionJobRow(job.id);
		expect(row?.status).toBe("failed");
		expect(row?.errorMessage).toContain("chunk sync exploded");
		expect(row?.normalizedArtifactId).toBeNull();
	});

	// F16. The heartbeat used to stop the moment the extractor returned, so the
	// indexing pass — chunking and embedding a large document, the slowest step
	// here — ran with a frozen `heartbeat_at` and could be reclaimed as stale
	// while it was working perfectly.
	it("keeps heartbeating through indexing so a long index is not reclaimed", async () => {
		const artifactId = await seedStoredDocument();
		const job = await enqueue(artifactId);

		let releaseIndexing: () => void = () => {};
		const indexing = new Promise<void>((resolve) => {
			releaseIndexing = resolve;
		});
		let markBackdated: () => void = () => {};
		const backdated = new Promise<void>((resolve) => {
			markBackdated = resolve;
		});

		const running = worker.executeNextExtractionJob({
			workerId: "w1",
			resolveExtractor: () =>
				createFakeExtractor({ steps: [{ kind: "succeed", text: "body" }] }),
			heartbeatMs: 100,
			persistResult: (async () => {
				// Backdate the attempt: as far as the ledger can see nothing has
				// touched it for ten minutes, and only a live heartbeat can put
				// that right while indexing runs.
				fixture.sqlite
					.prepare(
						"UPDATE document_extraction_job_attempts SET heartbeat_at = ? WHERE job_id = ?",
					)
					.run(Math.floor((Date.now() - 600_000) / 1000), job.id);
				markBackdated();
				await indexing;
				const id = fixture.seedArtifact({
					userId,
					type: "normalized_document",
					name: "normalized-indexing.md",
				});
				return { id } as Artifact;
			}) as never,
		});

		await backdated;
		const staleBefore = new Date(Date.now() - 300_000);
		await vi.waitFor(
			async () => {
				const [attempt] = await ledger.listExtractionJobAttempts(job.id);
				expect(attempt?.heartbeatAt?.getTime() ?? 0).toBeGreaterThan(
					staleBefore.getTime(),
				);
			},
			{ timeout: 3000 },
		);

		expect(
			await ledger.recoverStaleExtractionAttempts({
				staleBefore,
				maxAttempts: 3,
				retryBaseMs: 2000,
				retryMaxMs: 60000,
				outageWindowMs: 1_800_000,
			}),
		).toEqual({ recovered: 0, requeued: 0 });
		expect((await ledger.getExtractionJobRow(job.id))?.status).toBe("indexing");

		releaseIndexing();
		expect(await running).toEqual({ jobId: job.id, status: "succeeded" });
	});

	it("refuses a readback job with no sink registered, rather than losing it", async () => {
		fixture.seedConversation("conv-1", userId);
		fixture.sqlite
			.prepare(
				`INSERT INTO messages (id, conversation_id, role, content, created_at)
				 VALUES ('msg-1', 'conv-1', 'assistant', 'here', unixepoch())`,
			)
			.run();
		const absolute = join(storageDir, "generated.pdf");
		await writeFile(absolute, "generated bytes", "utf8");
		fixture.sqlite
			.prepare(
				`INSERT INTO chat_generated_files
				 (id, conversation_id, assistant_message_id, user_id, filename, mime_type, size_bytes, storage_path, created_at)
				 VALUES ('gen-1', 'conv-1', 'msg-1', ?, 'generated.pdf', 'application/pdf', 10, ?, unixepoch())`,
			)
			.run(
				userId,
				relative(join(process.cwd(), "data", "chat-files"), absolute),
			);

		const { job } = await ledger.enqueueExtractionJob({
			userId,
			conversationId: "conv-1",
			origin: "generated_file_readback",
			intakeRoute: "mineru",
			fileName: "generated.pdf",
			mimeType: "application/pdf",
			sizeBytes: 10,
			chatGeneratedFileId: "gen-1",
			priority: 10,
		});

		const result = await worker.executeNextExtractionJob({
			workerId: "w1",
			resolveExtractor: () =>
				createFakeExtractor({ steps: [{ kind: "succeed" }] }),
		});

		expect(result?.status).toBe("failed");
		expect((await ledger.getExtractionJobRow(job.id))?.errorMessage).toContain(
			"readback sink",
		);
	});

	it("routes a readback job to the registered sink", async () => {
		fixture.seedConversation("conv-1", userId);
		fixture.sqlite
			.prepare(
				`INSERT INTO messages (id, conversation_id, role, content, created_at)
				 VALUES ('msg-1', 'conv-1', 'assistant', 'here', unixepoch())`,
			)
			.run();
		const absolute = join(storageDir, "generated.txt");
		await writeFile(absolute, "generated bytes", "utf8");
		fixture.sqlite
			.prepare(
				`INSERT INTO chat_generated_files
				 (id, conversation_id, assistant_message_id, user_id, filename, mime_type, size_bytes, storage_path, created_at)
				 VALUES ('gen-1', 'conv-1', 'msg-1', ?, 'generated.txt', 'text/plain', 10, ?, unixepoch())`,
			)
			.run(
				userId,
				relative(join(process.cwd(), "data", "chat-files"), absolute),
			);

		const { job } = await ledger.enqueueExtractionJob({
			userId,
			conversationId: "conv-1",
			origin: "generated_file_readback",
			intakeRoute: "direct-text",
			fileName: "generated.txt",
			mimeType: "text/plain",
			sizeBytes: 10,
			chatGeneratedFileId: "gen-1",
			priority: 10,
		});

		const generatedArtifactId = fixture.seedArtifact({
			userId,
			type: "generated_output",
			name: "generated.txt",
		});
		const sink = vi.fn(async () => ({ artifactId: generatedArtifactId }));
		worker.setGeneratedFileReadbackSink(sink);

		const result = await worker.executeNextExtractionJob({
			workerId: "w1",
			resolveExtractor: () =>
				createFakeExtractor({ steps: [{ kind: "succeed", text: "readback" }] }),
		});

		expect(result?.status).toBe("succeeded");
		expect(sink).toHaveBeenCalledWith(
			expect.objectContaining({
				chatGeneratedFileId: "gen-1",
				text: "readback",
				userId,
			}),
		);
		expect(
			(await ledger.getExtractionJobRow(job.id))?.normalizedArtifactId,
		).toBe(generatedArtifactId);
	});
});

describe("drainExtractionWorker", () => {
	it("empties the queue and stops", async () => {
		for (const name of ["a.pdf", "b.pdf", "c.pdf"]) {
			await enqueue(await seedStoredDocument(name), name);
		}
		const { persist } = fakePersist();

		await worker.drainExtractionWorker({
			workerId: "w1",
			resolveExtractor: () =>
				createFakeExtractor({ steps: [{ kind: "succeed" }] }),
			persistResult: persist,
		});

		const remaining = fixture.sqlite
			.prepare(
				"SELECT count(*) AS n FROM document_extraction_jobs WHERE status != 'succeeded'",
			)
			.get() as { n: number };
		expect(remaining.n).toBe(0);
	});

	it("returns immediately against an empty table", async () => {
		await expect(
			worker.drainExtractionWorker({ workerId: "w1" }),
		).resolves.toBeUndefined();
	});
});

describe("ensureExtractionWorker", () => {
	it("does nothing under vitest, and is idempotent", async () => {
		// The bootstrap must not start draining a test's temp database, and a
		// double import must not arm two schedulers.
		await expect(worker.ensureExtractionWorker()).resolves.toBeUndefined();
		await expect(worker.ensureExtractionWorker()).resolves.toBeUndefined();
	});
});

describe("runDirectTextExtractionInline", () => {
	it("runs a direct-text job to completion inside the caller's context", async () => {
		const absolute = join(storageDir, "notes.txt");
		await writeFile(absolute, "inline text", "utf8");
		const artifactId = fixture.seedArtifact({
			userId,
			name: "notes.txt",
			mimeType: "text/plain",
			storagePath: relative(process.cwd(), absolute),
		});
		const { job } = await ledger.enqueueExtractionJob({
			userId,
			conversationId: null,
			origin: "upload",
			intakeRoute: "direct-text",
			fileName: "notes.txt",
			mimeType: "text/plain",
			sizeBytes: 11,
			sourceArtifactId: artifactId,
		});

		const dto = await worker.runDirectTextExtractionInline({
			jobId: job.id,
			budgetMs: 5000,
		});

		// The real direct-text extractor and the real persist path both run here.
		expect(dto?.status).toBe("succeeded");
		expect(dto?.normalizedArtifactId).not.toBeNull();
	});

	// The boot reclaim asks `parseWorkerId` whose process wrote an attempt. The
	// inline runner used to stamp `${DEFAULT_WORKER_ID}:inline` — five
	// segments, which the parser refuses by design — so a previous boot's
	// inline attempt never parsed, never looked dead, and always waited out the
	// full stale window. It is the one class of job a user watches
	// synchronously.
	it("stamps an attempt with a worker id the reclaim can read back", async () => {
		const absolute = join(storageDir, "inline-id.txt");
		await writeFile(absolute, "inline text", "utf8");
		const artifactId = fixture.seedArtifact({
			userId,
			name: "inline-id.txt",
			mimeType: "text/plain",
			storagePath: relative(process.cwd(), absolute),
		});
		const { job } = await ledger.enqueueExtractionJob({
			userId,
			conversationId: null,
			origin: "upload",
			intakeRoute: "direct-text",
			fileName: "inline-id.txt",
			mimeType: "text/plain",
			sizeBytes: 11,
			sourceArtifactId: artifactId,
		});

		await worker.runDirectTextExtractionInline({
			jobId: job.id,
			budgetMs: 5000,
		});

		const [attempt] = await ledger.listExtractionJobAttempts(job.id);
		expect(attempt).toBeDefined();
		expect(parseWorkerId(attempt.workerId)).toMatchObject({
			hostname: (hostname() || "unknown").split(":").join(""),
			pid: process.pid,
		});
	});

	it("returns the non-terminal DTO when the budget is zero", async () => {
		const artifactId = await seedStoredDocument("notes.txt");
		const { job } = await ledger.enqueueExtractionJob({
			userId,
			conversationId: null,
			origin: "upload",
			intakeRoute: "direct-text",
			fileName: "notes.txt",
			mimeType: "text/plain",
			sizeBytes: 11,
			sourceArtifactId: artifactId,
		});

		const dto = await worker.runDirectTextExtractionInline({
			jobId: job.id,
			budgetMs: 0,
		});
		expect(dto?.status).toBe("queued");
	});

	it("returns null for a job that does not exist", async () => {
		expect(
			await worker.runDirectTextExtractionInline({
				jobId: "nope",
				budgetMs: 0,
			}),
		).toBeNull();
	});
});
