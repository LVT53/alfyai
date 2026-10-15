import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import { createWorkerId, parseWorkerId } from "../jobs/worker-identity";
import type { DocumentExtractor } from "./contracts";
import { createFakeExtractor } from "./testing/fake-extractor";
import {
	createLedgerFixture,
	type LedgerFixture,
} from "./testing/ledger-fixtures";
import {
	createPreEngineExtractionDatabase,
	type PreEngineExtractionDatabase,
	SEED_HANDLE_JSON,
} from "./testing/pre-engine-database";
import { installSeams, resetSeams, seams } from "./testing/runner-seams";

// The extraction handler, run through the job engine (`drain`) over a real
// database. What the engine owns (claim order, caps, fencing, beats, take-backs,
// scheduling) is tested in services/jobs; what is tested here is what the HANDLER
// does with a claimed attempt: the phases it reports, the verdicts it writes, what
// it does to a remote job on a cancel and on a lost lease, and how a job that was
// running at the deploy is taken back and resumed.
//
// The extractor registry, the indexing step and the config are replaced by the
// seams in `testing/runner-seams.ts`; the module registry is reset for every test
// so the engine opens the test's own database.

let fixture: LedgerFixture;
let storageDir: string;
const userId = "user-1";

beforeEach(async () => {
	resetSeams();
	fixture = createLedgerFixture("extraction-runner");
	fixture.seedUser(userId);

	storageDir = await mkdtemp(join(tmpdir(), "alfyai-extraction-runner-"));
	process.env.DATABASE_PATH = fixture.dbPath;
	vi.resetModules();
});

afterEach(async () => {
	vi.useRealTimers();
	try {
		const { resetJobsForTests } = await import("$lib/server/services/jobs");
		resetJobsForTests();
		const readback = await import("./readback-sink");
		readback.setGeneratedFileReadbackSink(null);
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
	await rm(storageDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

async function engine() {
	await installSeams();
	const jobs = await import("$lib/server/services/jobs");
	const { extractionJob } = await import("./extraction-job");
	return { ...jobs, extractionJob };
}

/**
 * Storage paths are stored relative to cwd and joined against it by the handler,
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

async function enqueueJob(
	artifactId: string,
	fileName = "report.pdf",
	extra: {
		intakeRoute?: "direct-text" | "mineru";
		hintsJson?: string | null;
		priority?: number;
	} = {},
) {
	const { enqueue, extractionJob } = await engine();
	const { row } = await enqueue(extractionJob, {
		values: {
			userId,
			conversationId: null,
			sourceArtifactId: artifactId,
			origin: "upload",
			intakeRoute: extra.intakeRoute ?? "mineru",
			fileName,
			mimeType: "application/pdf",
			sizeBytes: 12,
			hintsJson: extra.hintsJson ?? null,
		},
		priority: extra.priority,
	});
	return row;
}

function readJob(jobId: string) {
	const row = fixture.db
		.select()
		.from(schema.documentExtractionJobs)
		.where(eq(schema.documentExtractionJobs.id, jobId))
		.get();
	if (!row) throw new Error(`No extraction job ${jobId}`);
	return row;
}

function readAttempts(jobId: string) {
	return fixture.db
		.select()
		.from(schema.documentExtractionJobAttempts)
		.where(eq(schema.documentExtractionJobAttempts.jobId, jobId))
		.orderBy(asc(schema.documentExtractionJobAttempts.attemptNumber))
		.all();
}

/**
 * Stands in for the real indexing step, but still inserts a real artifact row:
 * `normalized_artifact_id` carries a foreign key, so a fake that invented an id
 * would fail the completion write and hide whatever the test meant to prove.
 */
function fakePersist() {
	const calls: unknown[] = [];
	seams.persist = async (params) => {
		calls.push(params);
		const id = fixture.seedArtifact({
			userId,
			type: "normalized_document",
			name: `normalized-${calls.length}.md`,
		});
		return { id };
	};
	return { calls };
}

function useExtractor<T extends DocumentExtractor>(extractor: T): T {
	seams.extractor = extractor;
	return extractor;
}

describe("the extraction handler", () => {
	it("walks the full ladder and succeeds", async () => {
		const { drain, extractionJob } = await engine();
		const artifactId = await seedStoredDocument();
		const job = await enqueueJob(artifactId, "report.pdf", {
			hintsJson: JSON.stringify({ tier: "advanced" }),
		});
		const extractor = useExtractor(
			createFakeExtractor({
				steps: [{ kind: "succeed", text: "hello world" }],
				emitHandleAfterPhase: "parsing",
			}),
		);
		const { calls } = fakePersist();

		await drain(extractionJob);

		const row = readJob(job.id);
		expect(row).toMatchObject({
			status: "succeeded",
			// The phase it ended in stays on the row.
			phase: "indexing",
			attemptCount: 1,
			// A success clears the checkpoint and the hints that steered it.
			checkpoint: null,
			hintsJson: null,
			errorCode: null,
			retryable: false,
		});
		expect(row.normalizedArtifactId).not.toBeNull();
		expect(row.startedAt).not.toBeNull();
		expect(row.completedAt).not.toBeNull();

		const [attempt] = readAttempts(job.id);
		expect(attempt).toMatchObject({
			status: "succeeded",
			extractor: "fake",
			resumed: false,
			textLength: "hello world".length,
			// The call carried the caller's hints through.
			attemptNumber: 1,
		});
		expect(extractor.calls[0].request.hints).toEqual({ tier: "advanced" });
		expect(calls).toHaveLength(1);
	});

	it("moves the job through the phases an extractor reports, storing its handle as the checkpoint", async () => {
		const { drain, extractionJob } = await engine();
		const artifactId = await seedStoredDocument();
		const job = await enqueueJob(artifactId);
		const seen: Array<{
			status: string;
			phase: string | null;
			checkpoint: string | null;
		}> = [];
		const base = createFakeExtractor({ steps: [{ kind: "succeed" }] });
		useExtractor({
			...base,
			async extract(request) {
				const sample = () => {
					const row = readJob(job.id);
					seen.push({
						status: row.status,
						phase: row.phase,
						checkpoint: row.checkpoint,
					});
				};
				sample();
				request.onProgress({ phase: "parsing" });
				request.onProgress({
					phase: "parsing",
					handle: { extractor: "fake", version: 1, remoteJobId: "r1" },
				});
				// The progress calls are fire-and-forget; give them their turn.
				await new Promise((resolve) => setTimeout(resolve, 20));
				sample();
				request.onProgress({ phase: "downloading" });
				await new Promise((resolve) => setTimeout(resolve, 20));
				sample();
				return base.extract(request);
			},
		});
		fakePersist();

		await drain(extractionJob);

		expect(seen[0]).toMatchObject({
			status: "running",
			phase: "uploading",
			checkpoint: null,
		});
		expect(seen[1]).toMatchObject({ status: "running", phase: "parsing" });
		expect(JSON.parse(seen[1].checkpoint ?? "null")).toMatchObject({
			remoteJobId: "r1",
		});
		expect(seen[2]).toMatchObject({ status: "running", phase: "downloading" });
		expect(readJob(job.id).status).toBe("succeeded");
	});

	it("hands the extractor the artifact's hash, id and owner", async () => {
		// Δ1/Δ2: the ledger already holds the verified digest, so a backend must
		// never have to re-stream 200 MB to recompute it.
		const { drain, extractionJob } = await engine();
		const artifactId = await seedStoredDocument();
		await enqueueJob(artifactId);
		const extractor = useExtractor(
			createFakeExtractor({ steps: [{ kind: "succeed" }] }),
		);
		fakePersist();

		await drain(extractionJob);

		expect(extractor.calls[0].request).toMatchObject({
			contentSha256: "a".repeat(64),
			sourceArtifactId: artifactId,
			userId,
			intakeRoute: "mineru",
		});
	});

	it("strips what the ledger once reserved from the hints an extractor sees", async () => {
		const { drain, extractionJob } = await engine();
		const artifactId = await seedStoredDocument();
		await enqueueJob(artifactId, "report.pdf", {
			hintsJson: JSON.stringify({
				tier: "basic",
				$outage: { since: null, waits: 1 },
			}),
		});
		const extractor = useExtractor(
			createFakeExtractor({ steps: [{ kind: "succeed" }] }),
		);
		fakePersist();

		await drain(extractionJob);

		expect(extractor.calls[0].request.hints).toEqual({ tier: "basic" });
	});

	it("fails the job when the stored file cannot be located", async () => {
		const { drain, extractionJob } = await engine();
		const artifactId = fixture.seedArtifact({
			userId,
			name: "ghost.pdf",
			storagePath: null,
		});
		const job = await enqueueJob(artifactId, "ghost.pdf");
		useExtractor(createFakeExtractor({ steps: [{ kind: "succeed" }] }));

		await drain(extractionJob);

		expect(readJob(job.id)).toMatchObject({
			status: "failed",
			errorCode: "internal",
			retryable: false,
		});
	});

	// F19. The missing-file branch reported "failed" whatever the failure write
	// answered, so a worker that had already lost its claim asserted a verdict it
	// never wrote.
	it("writes nothing when the claim is lost before the missing-file verdict", async () => {
		const { drain, extractionJob } = await engine();
		const artifactId = fixture.seedArtifact({
			userId,
			name: "ghost-lost.pdf",
			storagePath: null,
		});
		const job = await enqueueJob(artifactId, "ghost-lost.pdf");
		useExtractor(createFakeExtractor({ steps: [{ kind: "succeed" }] }));
		// Runs between the claim and the source lookup: whoever holds the attempt
		// now is the only legitimate writer.
		seams.onResolve = () => {
			fixture.sqlite
				.prepare(
					"UPDATE document_extraction_job_attempts SET status = 'cancelled' WHERE job_id = ?",
				)
				.run(job.id);
		};

		await drain(extractionJob);

		const row = readJob(job.id);
		expect(row.status).toBe("running");
		expect(row.errorCode).toBeNull();
	});

	it("requeues a retryable throw and fails a non-retryable one", async () => {
		const { drain, extractionJob } = await engine();
		const retryableArtifact = await seedStoredDocument("retry.pdf");
		const retryableJob = await enqueueJob(retryableArtifact, "retry.pdf");
		const extractor = createFakeExtractor({
			steps: [{ kind: "throw", code: "unavailable" }],
		});
		useExtractor(extractor);

		await drain(extractionJob);

		// The backend is not answering: a patient wait, which does not spend the
		// document's attempts, and the reason stays on the row so the card can say
		// it is retrying.
		expect(readJob(retryableJob.id)).toMatchObject({
			status: "queued",
			errorCode: "unavailable",
			retryable: true,
		});
		expect(readJob(retryableJob.id).runAfter).not.toBeNull();
		expect(JSON.parse(readJob(retryableJob.id).retryState ?? "null")).toEqual({
			since: expect.any(Number),
			waits: 1,
		});

		const fatalArtifact = await seedStoredDocument("fatal.pdf");
		const fatalJob = await enqueueJob(fatalArtifact, "fatal.pdf");
		useExtractor(
			createFakeExtractor({ steps: [{ kind: "throw", code: "empty_result" }] }),
		);
		await drain(extractionJob);
		expect(readJob(fatalJob.id)).toMatchObject({
			status: "failed",
			errorCode: "empty_result",
			retryable: false,
		});
		expect(readJob(fatalJob.id).retryState).toBeNull();
	});

	it("clears the handle when the remote forgot it", async () => {
		const { drain, extractionJob } = await engine();
		const artifactId = await seedStoredDocument();
		const job = await enqueueJob(artifactId);
		useExtractor(
			createFakeExtractor({
				steps: [{ kind: "throw", code: "protocol", handleUnknown: true }],
				emitHandleAfterPhase: "parsing",
			}),
		);

		await drain(extractionJob);

		const row = readJob(job.id);
		expect(row.status).toBe("queued");
		expect(row.checkpoint).toBeNull();
	});

	it("resumes the stored handle on the next attempt, and starts fresh for another extractor's", async () => {
		const { drain, extractionJob } = await engine();
		const artifactId = await seedStoredDocument();
		const job = await enqueueJob(artifactId);
		// A previous attempt left a handle of this extractor and went back in the
		// queue (a take-back keeps the checkpoint).
		fixture.sqlite
			.prepare(
				"UPDATE document_extraction_jobs SET remote_handle_json = ? WHERE id = ?",
			)
			.run(
				JSON.stringify({ extractor: "fake", version: 1, remoteJobId: "r-old" }),
				job.id,
			);
		const resumed = useExtractor(
			createFakeExtractor({ steps: [{ kind: "succeed" }] }),
		);
		fakePersist();
		await drain(extractionJob);
		expect(resumed.calls[0]).toMatchObject({
			resumed: true,
			handle: { remoteJobId: "r-old" },
		});
		expect(readAttempts(job.id)[0].resumed).toBe(true);

		const otherArtifact = await seedStoredDocument("other.pdf");
		const other = await enqueueJob(otherArtifact, "other.pdf");
		fixture.sqlite
			.prepare(
				"UPDATE document_extraction_jobs SET remote_handle_json = ? WHERE id = ?",
			)
			.run(
				JSON.stringify({
					extractor: "somebody-else",
					version: 1,
					remoteJobId: "r-foreign",
				}),
				other.id,
			);
		const fresh = useExtractor(
			createFakeExtractor({ steps: [{ kind: "succeed" }] }),
		);
		await drain(extractionJob);
		expect(fresh.calls[0].resumed).toBe(false);
		expect(readAttempts(other.id)[0].resumed).toBe(false);
	});

	it("aborts and writes nothing when the claim is lost mid-extraction", async () => {
		const { drain, extractionJob, recover } = await engine();
		const artifactId = await seedStoredDocument();
		const job = await enqueueJob(artifactId);
		const extractor = useExtractor(
			createFakeExtractor({
				steps: [{ kind: "hang" }],
				emitHandleAfterPhase: "uploading",
			}),
		);

		const running = drain(extractionJob);
		await vi.waitFor(() => {
			expect(readJob(job.id).checkpoint).not.toBeNull();
		});
		// Another worker takes the claim out from under this one: as far as the
		// ledger can see the attempt has not beaten for a minute.
		await recover(extractionJob, {
			staleBefore: new Date(Date.now() + 60_000),
		});
		await running;

		// The take-back requeued it; the losing run reported nothing, and it did NOT
		// delete the remote job: the next attempt resumes it from the checkpoint.
		expect(readJob(job.id)).toMatchObject({
			status: "queued",
			errorCode: "stale_worker",
		});
		expect(readJob(job.id).checkpoint).not.toBeNull();
		const attempts = readAttempts(job.id);
		expect(attempts).toHaveLength(1);
		expect(attempts[0]).toMatchObject({
			status: "failed",
			errorCode: "stale_worker",
		});
		expect(extractor.cancelCalls).toEqual([]);
	});

	it("honours a cancel, calls the remote cancel, and survives it throwing", async () => {
		const { drain, extractionJob, cancel } = await engine();
		const artifactId = await seedStoredDocument();
		const job = await enqueueJob(artifactId);
		const extractor = useExtractor(
			createFakeExtractor({
				steps: [{ kind: "hang" }],
				emitHandleAfterPhase: "uploading",
			}),
		);
		extractor.cancelShouldThrow = true;

		const running = drain(extractionJob);
		await vi.waitFor(() => {
			expect(readJob(job.id).checkpoint).not.toBeNull();
		});
		await cancel(extractionJob, job.id, { userId });
		await running;

		expect(extractor.cancelCalls).toHaveLength(1);
		expect(extractor.cancelCalls[0].remoteJobId).toBe("remote-uploading");
		// The handle is dropped on a cancel: a later Retry must not resume a remote
		// job that was just deleted.
		expect(readJob(job.id)).toMatchObject({
			status: "cancelled",
			checkpoint: null,
		});
		expect(readAttempts(job.id)[0].status).toBe("cancelled");
	});

	it("leaves the remote cancel to an extractor that does it on abort itself", async () => {
		const { drain, extractionJob, cancel } = await engine();
		const artifactId = await seedStoredDocument();
		const job = await enqueueJob(artifactId);
		const extractor = Object.assign(
			createFakeExtractor({
				steps: [{ kind: "hang" }],
				emitHandleAfterPhase: "uploading",
			}),
			{ cancelsOnAbort: true },
		);
		useExtractor(extractor);

		const running = drain(extractionJob);
		await vi.waitFor(() => {
			expect(readJob(job.id).checkpoint).not.toBeNull();
		});
		await cancel(extractionJob, job.id, { userId });
		await running;

		// Exactly one DELETE reaches the backend per Stop, and it is the extractor's.
		expect(extractor.cancelCalls).toEqual([]);
		expect(readJob(job.id).status).toBe("cancelled");
	});

	it("tells the extractor why it was stopped, in the seam's own words", async () => {
		const { drain, extractionJob, cancel, recover } = await engine();
		const reasons: Array<string | null> = [];
		const base = createFakeExtractor({ steps: [{ kind: "hang" }] });
		useExtractor({
			...base,
			async extract(request) {
				request.signal.addEventListener("abort", () => {
					reasons.push(
						(request.signal.reason as { extractionAbortReason?: string })
							?.extractionAbortReason ?? null,
					);
				});
				return base.extract(request);
			},
		});

		const cancelled = await enqueueJob(
			await seedStoredDocument("a.pdf"),
			"a.pdf",
		);
		const first = drain(extractionJob);
		await vi.waitFor(() => {
			expect(readJob(cancelled.id).status).toBe("running");
		});
		await cancel(extractionJob, cancelled.id, { userId });
		await first;

		const lost = await enqueueJob(await seedStoredDocument("b.pdf"), "b.pdf");
		const second = drain(extractionJob);
		await vi.waitFor(() => {
			expect(readJob(lost.id).status).toBe("running");
		});
		await recover(extractionJob, {
			staleBefore: new Date(Date.now() + 60_000),
		});
		await second;

		// `user-cancel` is the only reason that may destroy remote work.
		expect(reasons).toEqual(["user-cancel", "claim-lost"]);
	});

	it("fails the job when indexing throws, instead of claiming success", async () => {
		const { drain, extractionJob } = await engine();
		const artifactId = await seedStoredDocument();
		const job = await enqueueJob(artifactId);
		useExtractor(createFakeExtractor({ steps: [{ kind: "succeed" }] }));
		seams.persist = async () => {
			throw new Error("chunk sync exploded");
		};

		await drain(extractionJob);

		const row = readJob(job.id);
		expect(row.status === "failed" || row.status === "queued").toBe(true);
		expect(row.errorMessage).toContain("chunk sync exploded");
		expect(row.normalizedArtifactId).toBeNull();
		// Whatever the remote job was, it has been read: a retry starts over.
		expect(row.checkpoint).toBeNull();
	});

	// F16. The heartbeat used to stop the moment the extractor returned, so the
	// indexing pass — chunking and embedding a large document, the slowest step
	// here — ran with a frozen `heartbeat_at` and could be reclaimed as stale
	// while it was working perfectly. The engine beats on a timer of its own.
	it("keeps heartbeating through indexing so a long index is not reclaimed", async () => {
		seams.config = { heartbeatMs: 250 };
		const { drain, extractionJob, recover } = await engine();
		const artifactId = await seedStoredDocument();
		const job = await enqueueJob(artifactId);
		useExtractor(
			createFakeExtractor({ steps: [{ kind: "succeed", text: "body" }] }),
		);

		let releaseIndexing: () => void = () => {};
		const indexing = new Promise<void>((resolve) => {
			releaseIndexing = resolve;
		});
		let markBackdated: () => void = () => {};
		const backdated = new Promise<void>((resolve) => {
			markBackdated = resolve;
		});
		seams.persist = async () => {
			// Backdate the attempt: as far as the ledger can see nothing has touched
			// it for ten minutes, and only a live heartbeat can put that right while
			// indexing runs.
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
			return { id };
		};

		const running = drain(extractionJob);
		await backdated;
		const staleBefore = new Date(Date.now() - 300_000);
		await vi.waitFor(
			() => {
				const [attempt] = readAttempts(job.id);
				expect(attempt?.heartbeatAt?.getTime() ?? 0).toBeGreaterThan(
					staleBefore.getTime(),
				);
			},
			{ timeout: 3000 },
		);

		expect(await recover(extractionJob, { staleBefore })).toEqual({
			recovered: 0,
		});
		expect(readJob(job.id)).toMatchObject({
			status: "running",
			phase: "indexing",
		});

		releaseIndexing();
		await running;
		expect(readJob(job.id).status).toBe("succeeded");
	});

	describe("generated-file readback", () => {
		async function seedReadbackJob(
			filename: string,
			intakeRoute: "mineru" | "direct-text",
		) {
			fixture.seedConversation("conv-1", userId);
			fixture.sqlite
				.prepare(
					`INSERT INTO messages (id, conversation_id, role, content, created_at)
					 VALUES ('msg-1', 'conv-1', 'assistant', 'here', unixepoch())`,
				)
				.run();
			const absolute = join(storageDir, filename);
			await writeFile(absolute, "generated bytes", "utf8");
			fixture.sqlite
				.prepare(
					`INSERT INTO chat_generated_files
					 (id, conversation_id, assistant_message_id, user_id, filename, mime_type, size_bytes, storage_path, created_at)
					 VALUES ('gen-1', 'conv-1', 'msg-1', ?, ?, 'application/octet-stream', 10, ?, unixepoch())`,
				)
				.run(
					userId,
					filename,
					relative(join(process.cwd(), "data", "chat-files"), absolute),
				);

			const { enqueue, extractionJob } = await engine();
			const { row } = await enqueue(extractionJob, {
				values: {
					userId,
					conversationId: "conv-1",
					chatGeneratedFileId: "gen-1",
					origin: "generated_file_readback",
					intakeRoute,
					fileName: filename,
					mimeType: "application/octet-stream",
					sizeBytes: 10,
				},
				priority: 10,
			});
			return row;
		}

		it("refuses a readback job with no sink registered, rather than losing it", async () => {
			const { drain, extractionJob } = await engine();
			const job = await seedReadbackJob("generated.pdf", "mineru");
			useExtractor(createFakeExtractor({ steps: [{ kind: "succeed" }] }));

			await drain(extractionJob);

			const row = readJob(job.id);
			expect(row.status === "failed" || row.status === "queued").toBe(true);
			expect(row.errorMessage).toContain("readback sink");
		});

		it("routes a readback job to the registered sink", async () => {
			const { drain, extractionJob } = await engine();
			const job = await seedReadbackJob("generated.txt", "direct-text");
			const generatedArtifactId = fixture.seedArtifact({
				userId,
				type: "generated_output",
				name: "generated.txt",
			});
			const sink = vi.fn(async () => ({ artifactId: generatedArtifactId }));
			const readback = await import("./readback-sink");
			readback.setGeneratedFileReadbackSink(sink);
			useExtractor(
				createFakeExtractor({ steps: [{ kind: "succeed", text: "readback" }] }),
			);

			await drain(extractionJob);

			expect(readJob(job.id).status).toBe("succeeded");
			expect(sink).toHaveBeenCalledWith(
				expect.objectContaining({
					chatGeneratedFileId: "gen-1",
					text: "readback",
					userId,
				}),
			);
			expect(readJob(job.id).normalizedArtifactId).toBe(generatedArtifactId);
		});
	});
});

describe("draining the queue", () => {
	it("empties the queue and stops", async () => {
		const { drain, extractionJob } = await engine();
		for (const name of ["a.pdf", "b.pdf", "c.pdf"]) {
			await enqueueJob(await seedStoredDocument(name), name);
		}
		useExtractor(createFakeExtractor({ steps: [{ kind: "succeed" }] }));
		fakePersist();

		await drain(extractionJob);

		const remaining = fixture.sqlite
			.prepare(
				"SELECT count(*) AS n FROM document_extraction_jobs WHERE status != 'succeeded'",
			)
			.get() as { n: number };
		expect(remaining.n).toBe(0);
	});

	it("returns immediately against an empty table", async () => {
		const { drain, extractionJob } = await engine();
		await expect(drain(extractionJob)).resolves.toBeUndefined();
	});

	it("does nothing while the worker switch is off, and claims once it is on", async () => {
		const { drain, extractionJob } = await engine();
		const job = await enqueueJob(await seedStoredDocument());
		useExtractor(createFakeExtractor({ steps: [{ kind: "succeed" }] }));
		fakePersist();

		seams.config = { workerEnabled: false };
		await drain(extractionJob);
		expect(readJob(job.id).status).toBe("queued");

		seams.config = { workerEnabled: true };
		await drain(extractionJob);
		expect(readJob(job.id).status).toBe("succeeded");
	});
});

describe("a direct-text job run inline", () => {
	async function enqueueDirectText(name: string, withFile = true) {
		const absolute = join(storageDir, name);
		if (withFile) await writeFile(absolute, "inline text", "utf8");
		const artifactId = fixture.seedArtifact({
			userId,
			name,
			mimeType: "text/plain",
			storagePath: relative(process.cwd(), absolute),
		});
		const { enqueue, extractionJob } = await engine();
		const { row } = await enqueue(extractionJob, {
			values: {
				userId,
				conversationId: null,
				sourceArtifactId: artifactId,
				origin: "upload",
				intakeRoute: "direct-text",
				fileName: name,
				mimeType: "text/plain",
				sizeBytes: 11,
			},
		});
		return row;
	}

	it("runs to completion inside the caller's context", async () => {
		const { runInline, extractionJob } = await engine();
		const job = await enqueueDirectText("notes.txt");

		await runInline(extractionJob, job.id, { budgetMs: 5000 });

		// The real direct-text extractor and the real persist path both run here.
		const row = readJob(job.id);
		expect({ status: row.status, error: row.errorMessage }).toEqual({
			status: "succeeded",
			error: null,
		});
		expect(row.normalizedArtifactId).not.toBeNull();
	});

	// The boot reclaim asks `parseWorkerId` whose process wrote an attempt. The
	// inline runner used to stamp a five-segment id, which the parser refuses by
	// design, so a previous boot's inline attempt never looked dead and always
	// waited out the full stale window. It is the one class of job a user watches
	// synchronously.
	it("stamps an attempt with a worker id the reclaim can read back", async () => {
		const { runInline, extractionJob } = await engine();
		const job = await enqueueDirectText("inline-id.txt");

		await runInline(extractionJob, job.id, { budgetMs: 5000 });

		const [attempt] = readAttempts(job.id);
		expect(parseWorkerId(attempt.workerId)).toMatchObject({
			slice: "extraction-inline",
			pid: process.pid,
		});
		// Sharing this process's boot nonce is what keeps our OWN inline attempts
		// from being reclaimed as a dead worker's.
		const identity = await import("../jobs/worker-identity");
		expect(parseWorkerId(attempt.workerId)?.nonce).toBe(
			parseWorkerId(identity.createWorkerId("extraction"))?.nonce,
		);
	});

	it("does not run a job with a budget of zero, nor one that is not direct text, nor one that does not exist", async () => {
		const { runInline, extractionJob } = await engine();
		const direct = await enqueueDirectText("notes.txt");
		await runInline(extractionJob, direct.id, { budgetMs: 0 });
		expect(readJob(direct.id).status).toBe("queued");

		const pdf = await enqueueJob(await seedStoredDocument("scan.pdf"));
		await runInline(extractionJob, pdf.id, { budgetMs: 5000 });
		expect(readJob(pdf.id).status).toBe("queued");

		await expect(
			runInline(extractionJob, "nope", { budgetMs: 5000 }),
		).resolves.toBeUndefined();
	});

	it("runs past the caps: direct text is local CPU, not a backend seat", async () => {
		seams.config = { maxConcurrency: 1 };
		const { runInline, extractionJob } = await engine();
		// A scanned PDF holds the only slot...
		const busy = await enqueueJob(await seedStoredDocument("scan.pdf"));
		fixture.sqlite
			.prepare(
				"UPDATE document_extraction_jobs SET status = 'running', phase = 'parsing' WHERE id = ?",
			)
			.run(busy.id);
		// ...and a .txt upload still answers inside its own request.
		const job = await enqueueDirectText("notes.txt");

		await runInline(extractionJob, job.id, { budgetMs: 5000 });

		expect({
			status: readJob(job.id).status,
			error: readJob(job.id).errorMessage,
		}).toEqual({ status: "succeeded", error: null });
	});

	it("stays queued while the worker switch is off", async () => {
		const { runInline, extractionJob } = await engine();
		const job = await enqueueDirectText("paused.txt");
		seams.config = { workerEnabled: false };

		await runInline(extractionJob, job.id, { budgetMs: 5000 });

		expect(readJob(job.id).status).toBe("queued");
	});
});

describe("a job that was running at the deploy", () => {
	let preEngine: PreEngineExtractionDatabase | null = null;

	afterEach(() => {
		preEngine?.cleanup();
		preEngine = null;
	});

	/**
	 * The database of the release before the engine, upgraded the way a deploy
	 * upgrades it, then opened by a restarted server: the shim runs first, then the
	 * engine would start. `job-queued` is moved far into the future so the boot's
	 * first drain, which is real, has nothing to claim.
	 */
	async function startNewReleaseOn(
		old: PreEngineExtractionDatabase,
	): Promise<void> {
		// The attempts the old release was running belong to a process that is gone.
		const gone = createWorkerId("extraction").replace(
			`:${process.pid}:`,
			":999999:",
		);
		old.sqlite
			.prepare(
				"UPDATE document_extraction_job_attempts SET worker_id = ? WHERE status = 'running'",
			)
			.run(gone);
		old.sqlite
			.prepare(
				"UPDATE document_extraction_jobs SET next_attempt_at = unixepoch() + 604800 WHERE id = 'job-queued'",
			)
			.run();
		// The documents are on disk, as they were.
		const stored = join(storageDir, "cutover.pdf");
		await writeFile(stored, "stored bytes", "utf8");
		old.sqlite
			.prepare(
				"UPDATE artifacts SET storage_path = ? WHERE type = 'source_document'",
			)
			.run(relative(process.cwd(), stored));
		old.close();
		process.env.DATABASE_PATH = old.dbPath;
		vi.resetModules();
		seams.installed = false;
		// The restarted server runs the shim before it starts the engine.
		const { sqlite } = await import("$lib/server/db");
		const { normalizeExtractionLifecycleWords } = await import(
			"$lib/server/db/compat"
		);
		normalizeExtractionLifecycleWords(sqlite);
	}

	async function appRows() {
		const { db } = await import("$lib/server/db");
		return new Map(
			db
				.select()
				.from(schema.documentExtractionJobs)
				.all()
				.map((row) => [row.id, row] as const),
		);
	}

	async function appAttempts(jobId: string) {
		const { db } = await import("$lib/server/db");
		return db
			.select()
			.from(schema.documentExtractionJobAttempts)
			.where(eq(schema.documentExtractionJobAttempts.jobId, jobId))
			.orderBy(asc(schema.documentExtractionJobAttempts.attemptNumber))
			.all();
	}

	it("takes back each of the four active rows once, keeps its handle, and resumes it", async () => {
		const old = createPreEngineExtractionDatabase();
		preEngine = old;
		old.seedEveryOldWord();
		old.upgrade();
		await startNewReleaseOn(old);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { startJobs, drain, extractionJob } = await engine();
		// Time stands still for the boot: a requeue waits out its backoff, and the
		// first drain must not claim it before the assertions have looked.
		vi.useFakeTimers({ toFake: ["Date"] });

		await startJobs([extractionJob], {
			startInNonServingContextForTests: true,
			isProcessAlive: () => false,
		});

		const rows = await appRows();
		// No row keeps a legacy word, and nothing is left running.
		for (const row of rows.values()) {
			expect(["queued", "succeeded", "failed", "cancelled"]).toContain(
				row.status,
			);
		}
		for (const word of ["uploading", "parsing", "downloading", "indexing"]) {
			expect(rows.get(`job-${word}`), word).toMatchObject({
				status: "queued",
				// The policy's reason stays on the row, retryable; the handle is kept so
				// the next attempt resumes the remote job instead of paying for it twice.
				errorCode: "stale_worker",
				retryable: true,
				checkpoint: SEED_HANDLE_JSON,
				attemptCount: 1,
			});
			expect(rows.get(`job-${word}`)?.runAfter, word).not.toBeNull();
			expect(await appAttempts(`job-${word}`), word).toMatchObject([
				{ status: "failed", errorCode: "stale_worker" },
			]);
		}
		// The rows that were not running are not touched.
		expect(rows.get("job-succeeded")?.status).toBe("succeeded");
		expect(rows.get("job-failed")?.errorCode).toBe("unavailable");
		expect(rows.get("job-canceled")?.status).toBe("cancelled");
		// Once, and loudly enough to read in a journal.
		expect(
			warn.mock.calls.filter(
				([line]) =>
					line === "[EXTRACTION] Reclaimed attempts from a dead worker",
			),
		).toEqual([
			[
				"[EXTRACTION] Reclaimed attempts from a dead worker",
				{ recovered: 4, requeued: 4 },
			],
		]);

		// A minute later the backoff has passed; the next drain resumes the remote
		// job from the stored handle.
		const extractor = useExtractor(
			createFakeExtractor({ name: "mineru4", steps: [{ kind: "succeed" }] }),
		);
		seams.persist = async () => {
			const { db } = await import("$lib/server/db");
			const id = `normalized-${Math.random().toString(36).slice(2)}`;
			db.insert(schema.artifacts)
				.values({
					id,
					userId,
					type: "normalized_document",
					name: `${id}.md`,
				})
				.run();
			return { id };
		};
		vi.setSystemTime(new Date(Date.now() + 120_000));
		await drain(extractionJob);

		expect(extractor.calls).toHaveLength(4);
		for (const call of extractor.calls) {
			expect(call.resumed).toBe(true);
			expect(call.handle).toMatchObject({ remoteJobId: "remote-1" });
		}
		const after = await appRows();
		for (const word of ["uploading", "parsing", "downloading", "indexing"]) {
			expect(after.get(`job-${word}`), word).toMatchObject({
				status: "succeeded",
				// The attempt after the take-back is attempt 2, never a collision.
				attemptCount: 2,
				errorCode: null,
			});
		}
		// The one that was waiting out an outage is still waiting.
		expect(after.get("job-queued")?.status).toBe("queued");
	});

	it("keeps the outage waits a job had before the deploy", async () => {
		const old = createPreEngineExtractionDatabase();
		preEngine = old;
		old.seedEveryOldWord();
		old.upgrade();
		await startNewReleaseOn(old);
		const row = (await appRows()).get("job-failed");

		// The rewrite moved `$outage` out of the hints, and what is left is exactly
		// what the retry policy reads.
		expect(row?.hintsJson).toBe('{"tier":"advanced"}');
		const { readExtractionRetryState } = await import("./retry-policy");
		expect(readExtractionRetryState(row?.retryState)).toEqual({
			since: 1_781_000_000 * 1000,
			waits: 5,
		});
	});
});
