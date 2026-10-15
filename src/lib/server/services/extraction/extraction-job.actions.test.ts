import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import { createFakeExtractor } from "./testing/fake-extractor";
import {
	createLedgerFixture,
	type LedgerFixture,
} from "./testing/ledger-fixtures";
import { installSeams, resetSeams, seams } from "./testing/runner-seams";

// What the app calls to start, retry, cancel and wait for an extraction job:
// `enqueueExtractionJob`, `retryExtractionJob`, `cancelExtractionJob`,
// `materializeLegacyExtractionJob`, `requeueExtractionJobForReextraction` and
// `waitForExtractionJobVerdict`. Each is the engine's transition with a rule of
// extraction's own; the engine's tests own the transition (idempotent enqueue,
// fenced writes, cancel's immediate abort, reopen), and these own the rule: what
// is reused, what a retry carries across, what the ceiling refuses, which words
// come back.

let fixture: LedgerFixture;
let storageDir: string;
let storagePath: string;
let userId: string;
let artifactId: string;

beforeEach(async () => {
	resetSeams();
	fixture = createLedgerFixture("extraction-actions");
	userId = fixture.seedUser("user-1");
	storageDir = await mkdtemp(join(tmpdir(), "alfyai-extraction-actions-"));
	const stored = join(storageDir, "stored.pdf");
	await writeFile(stored, "stored bytes", "utf8");
	storagePath = relative(process.cwd(), stored);
	artifactId = fixture.seedArtifact({
		userId,
		name: "report.pdf",
		storagePath,
	});
	process.env.DATABASE_PATH = fixture.dbPath;
	vi.resetModules();
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
	await rm(storageDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

async function load() {
	await installSeams();
	const jobs = await import("$lib/server/services/jobs");
	const kind = await import("./extraction-job");
	const hints = await import("./hints");
	const reextract = await import("./reextract");
	const retryPolicy = await import("./retry-policy");
	return { ...jobs, ...kind, ...hints, ...reextract, ...retryPolicy };
}

async function enqueueJob(overrides: Record<string, unknown> = {}) {
	const { enqueueExtractionJob } = await load();
	const { job } = await enqueueExtractionJob({
		userId,
		conversationId: null,
		origin: "upload",
		intakeRoute: "mineru",
		fileName: "report.pdf",
		mimeType: "application/pdf",
		sizeBytes: 2048,
		sourceArtifactId: artifactId,
		...overrides,
	});
	return job;
}

/** Puts a job in a settled state the way the engine leaves it, without running it. */
function settle(jobId: string, set: string, ...params: Array<string | number>) {
	fixture.sqlite
		.prepare(`UPDATE document_extraction_jobs SET ${set} WHERE id = ?`)
		.run(...params, jobId);
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

describe("enqueueExtractionJob", () => {
	it("inserts a queued job with no attempt", async () => {
		const { listExtractionJobAttempts } = await load();
		const job = await enqueueJob();

		expect(job).toMatchObject({
			status: "queued",
			attemptCount: 0,
			phase: null,
			priority: 0,
			startedAt: null,
			completedAt: null,
			userId,
			sourceArtifactId: artifactId,
			intakeRoute: "mineru",
		});
		expect(await listExtractionJobAttempts(job.id)).toEqual([]);
	});

	it("is idempotent on the source artifact, however the second request differs", async () => {
		const first = await enqueueJob();
		const { enqueueExtractionJob } = await load();

		const second = await enqueueExtractionJob({
			userId,
			conversationId: null,
			origin: "upload",
			intakeRoute: "direct-text",
			fileName: "other-name.pdf",
			mimeType: null,
			sizeBytes: 1,
			sourceArtifactId: artifactId,
		});

		expect(second.reused).toBe(true);
		expect(second.job.id).toBe(first.id);
		// The first request's words stand.
		expect(second.job.intakeRoute).toBe("mineru");
	});

	it("makes ONE job of two parallel requests for one artifact", async () => {
		const { enqueueExtractionJob } = await load();
		const request = () =>
			enqueueExtractionJob({
				userId,
				conversationId: null,
				origin: "upload",
				intakeRoute: "mineru",
				fileName: "report.pdf",
				mimeType: "application/pdf",
				sizeBytes: 2048,
				sourceArtifactId: artifactId,
			});

		const results = await Promise.all([request(), request()]);

		expect(new Set(results.map((result) => result.job.id)).size).toBe(1);
		expect(results.filter((result) => result.reused)).toHaveLength(1);
		expect(
			(
				fixture.sqlite
					.prepare("SELECT count(*) AS n FROM document_extraction_jobs")
					.get() as { n: number }
			).n,
		).toBe(1);
	});

	it("is idempotent on a generated file too", async () => {
		fixture.seedConversation("conv-1", userId);
		fixture.sqlite
			.prepare(
				`INSERT INTO messages (id, conversation_id, role, content, created_at)
				 VALUES ('msg-1', 'conv-1', 'assistant', 'here', unixepoch())`,
			)
			.run();
		fixture.sqlite
			.prepare(
				`INSERT INTO chat_generated_files
				 (id, conversation_id, assistant_message_id, user_id, filename, mime_type, size_bytes, storage_path, created_at)
				 VALUES ('gen-1', 'conv-1', 'msg-1', ?, 'gen.pdf', 'application/pdf', 10, 'x', unixepoch())`,
			)
			.run(userId);
		const { enqueueExtractionJob } = await load();
		const input = {
			userId,
			conversationId: "conv-1",
			origin: "generated_file_readback" as const,
			intakeRoute: "mineru" as const,
			fileName: "gen.pdf",
			mimeType: "application/pdf",
			sizeBytes: 10,
			chatGeneratedFileId: "gen-1",
			priority: 10,
		};

		const first = await enqueueExtractionJob(input);
		const second = await enqueueExtractionJob(input);

		expect(first.reused).toBe(false);
		expect(first.job.priority).toBe(10);
		expect(second).toMatchObject({ reused: true, job: { id: first.job.id } });
	});

	it("a dedupe hit is born succeeded with no attempt row, and is never claimed", async () => {
		const { listExtractionJobAttempts, drain, extractionJob } = await load();
		const normalizedId = fixture.seedArtifact({
			userId,
			type: "normalized_document",
			name: "report.md",
		});

		const job = await enqueueJob({ normalizedArtifactId: normalizedId });

		expect(job).toMatchObject({
			status: "succeeded",
			normalizedArtifactId: normalizedId,
			attemptCount: 0,
		});
		expect(job.completedAt).not.toBeNull();
		expect(job.startedAt).not.toBeNull();
		expect(await listExtractionJobAttempts(job.id)).toEqual([]);
		await drain(extractionJob);
		expect(readJob(job.id).attemptCount).toBe(0);
	});

	it("a file no extractor can read is born failed, and says whether Retry is worth offering", async () => {
		const job = await enqueueJob({
			failure: {
				errorCode: "unsupported_type",
				errorMessage: "report.pdf is not a file type this app can read.",
				retryable: false,
			},
		});

		expect(job).toMatchObject({
			status: "failed",
			errorCode: "unsupported_type",
			errorMessage: "report.pdf is not a file type this app can read.",
			retryable: false,
			attemptCount: 0,
		});
		expect(job.completedAt).not.toBeNull();
	});

	it("stores hints opaquely and hands them back", async () => {
		const { parseExtractionHints } = await load();
		const job = await enqueueJob({ hints: { tier: "standard" } });

		expect(parseExtractionHints(job.hintsJson)).toEqual({ tier: "standard" });
	});

	it("stores no hints for an empty object", async () => {
		const job = await enqueueJob({ hints: {} });
		expect(job.hintsJson).toBeNull();
	});

	it("refuses a job with neither an artifact nor a generated file", async () => {
		const { enqueueExtractionJob } = await load();

		await expect(
			enqueueExtractionJob({
				userId,
				conversationId: null,
				origin: "upload",
				intakeRoute: "mineru",
				fileName: "x",
				mimeType: null,
				sizeBytes: 0,
			}),
		).rejects.toThrow(/sourceArtifactId or a chatGeneratedFileId/);
	});
});

describe("cancelExtractionJob", () => {
	it("cancels a queued job without touching an attempt", async () => {
		const { cancelExtractionJob, listExtractionJobAttempts } = await load();
		const job = await enqueueJob();

		const cancelled = await cancelExtractionJob({ userId, jobId: job.id });

		expect(cancelled).toMatchObject({ status: "cancelled" });
		expect(cancelled?.cancelRequestedAt).not.toBeNull();
		expect(await listExtractionJobAttempts(job.id)).toEqual([]);
	});

	it("leaves a settled job alone, and another user's", async () => {
		const { cancelExtractionJob } = await load();
		const other = fixture.seedUser("user-2");
		const job = await enqueueJob();

		expect(await cancelExtractionJob({ userId: other, jobId: job.id })).toBe(
			null,
		);
		await cancelExtractionJob({ userId, jobId: job.id });
		expect(await cancelExtractionJob({ userId, jobId: job.id })).toBe(null);
	});

	it("cancels a user's live jobs for account erasure, and only that user's", async () => {
		const { cancelActiveDocumentExtractionForUser } = await load();
		const other = fixture.seedUser("user-2");
		const mine = await enqueueJob();
		const otherArtifact = fixture.seedArtifact({
			userId: other,
			name: "theirs.pdf",
		});
		const theirs = await enqueueJob({
			userId: other,
			sourceArtifactId: otherArtifact,
		});
		settle(mine.id, "status = 'running', phase = 'parsing'");

		const outcome = await cancelActiveDocumentExtractionForUser(userId);

		expect(outcome).toEqual({ cancelled: 1 });
		expect(readJob(mine.id).status).toBe("cancelled");
		expect(readJob(theirs.id).status).toBe("queued");
	});
});

describe("retryExtractionJob", () => {
	it("refuses another user's job and a job that has not failed", async () => {
		const { retryExtractionJob } = await load();
		const other = fixture.seedUser("user-2");
		const job = await enqueueJob();

		expect(await retryExtractionJob({ userId, jobId: job.id })).toBeNull();
		settle(job.id, "status = 'failed', attempt_count = 1");
		expect(
			await retryExtractionJob({ userId: other, jobId: job.id }),
		).toBeNull();
		for (const status of ["succeeded", "running"]) {
			settle(job.id, "status = ?", status);
			expect(await retryExtractionJob({ userId, jobId: job.id })).toBeNull();
		}
	});

	it("keeps attempt_count, clears the error and the gate, and numbers the next attempt one past", async () => {
		const {
			retryExtractionJob,
			drain,
			extractionJob,
			listExtractionJobAttempts,
		} = await load();
		const job = await enqueueJob();
		settle(
			job.id,
			`status = 'failed', attempt_count = 1, error_code = 'empty_result', error_message = 'nothing', retryable = 0, next_attempt_at = 4102444800, completed_at = unixepoch()`,
		);
		fixture.sqlite
			.prepare(
				"INSERT INTO document_extraction_job_attempts (id, job_id, attempt_number, status) VALUES ('att-1', ?, 1, 'failed')",
			)
			.run(job.id);

		const retried = await retryExtractionJob({ userId, jobId: job.id });

		expect(retried).toMatchObject({
			status: "queued",
			attemptCount: 1,
			errorCode: null,
			errorMessage: null,
			runAfter: null,
			completedAt: null,
		});
		seams.extractor = createFakeExtractor({ steps: [{ kind: "succeed" }] });
		seams.persist = async () => ({
			id: fixture.seedArtifact({
				userId,
				type: "normalized_document",
				name: "report.md",
			}),
		});
		await drain(extractionJob);
		// Attempt numbers stay unique per job: the next claim is attempt 2.
		expect(
			(await listExtractionJobAttempts(job.id)).map((a) => a.attemptNumber),
		).toEqual([1, 2]);
	});

	it("brings a cancelled job back, with the cancel request forgotten", async () => {
		const { cancelExtractionJob, retryExtractionJob } = await load();
		const job = await enqueueJob();
		await cancelExtractionJob({ userId, jobId: job.id });

		const retried = await retryExtractionJob({ userId, jobId: job.id });

		expect(retried).toMatchObject({
			status: "queued",
			cancelRequestedAt: null,
		});
	});

	it("updates the stored hints when a retry supplies new ones, and leaves them when it does not", async () => {
		const { retryExtractionJob, parseExtractionHints } = await load();
		const job = await enqueueJob({ hints: { tier: "basic" } });
		settle(job.id, "status = 'failed', attempt_count = 1");

		const kept = await retryExtractionJob({ userId, jobId: job.id });
		expect(parseExtractionHints(kept?.hintsJson ?? null)).toEqual({
			tier: "basic",
		});

		settle(job.id, "status = 'failed'");
		const replaced = await retryExtractionJob({
			userId,
			jobId: job.id,
			hints: { tier: "standard" },
		});
		expect(parseExtractionHints(replaced?.hintsJson ?? null)).toEqual({
			tier: "standard",
		});

		settle(job.id, "status = 'failed'");
		const cleared = await retryExtractionJob({
			userId,
			jobId: job.id,
			hints: null,
		});
		expect(cleared?.hintsJson).toBeNull();
	});

	// Each Retry grants one more attempt with no ceiling, so one user holding one
	// broken document could keep a backend seat busy for as long as they were
	// willing to click. The ledger, not the endpoint, has to say no.
	it("refuses a retry past the total-attempt ceiling, and accepts one below it", async () => {
		const { retryExtractionJob, extractionAttemptCeiling } = await load();
		const ceiling = extractionAttemptCeiling(3);
		const job = await enqueueJob();

		settle(job.id, "status = 'failed', attempt_count = ?", ceiling);
		expect(
			await retryExtractionJob({ userId, jobId: job.id, maxAttempts: 3 }),
		).toBeNull();
		expect(readJob(job.id).status).toBe("failed");

		settle(job.id, "status = 'failed', attempt_count = ?", ceiling - 1);
		expect(
			await retryExtractionJob({ userId, jobId: job.id, maxAttempts: 3 }),
		).toMatchObject({ status: "queued" });
	});

	it("measures the ceiling in document attempts, and carries the outage waits into the new run", async () => {
		const {
			retryExtractionJob,
			extractionAttemptCeiling,
			readExtractionRetryState,
		} = await load();
		const ceiling = extractionAttemptCeiling(3);
		const job = await enqueueJob();
		// Twelve of the attempts were spent waiting for a backend that was down.
		settle(
			job.id,
			`status = 'failed', attempt_count = ?, retry_state_json = ?, error_code = 'unavailable', retryable = 1`,
			ceiling + 4,
			JSON.stringify({ since: 123, waits: 12 }),
		);

		const retried = await retryExtractionJob({
			userId,
			jobId: job.id,
			maxAttempts: 3,
		});

		expect(retried).toMatchObject({ status: "queued" });
		// A user retry starts a fresh outage window; the discount survives it.
		expect(readExtractionRetryState(readJob(job.id).retryState)).toEqual({
			since: null,
			waits: 12,
		});
	});

	it("gives up after the outage window, user-retryable, and the Retry still works", async () => {
		const { retryExtractionJob, drain, extractionJob } = await load();
		const job = await enqueueJob();
		seams.extractor = createFakeExtractor({
			steps: [{ kind: "throw", code: "unavailable" }],
		});
		// Half an hour of an unreachable backend is already behind this job.
		settle(
			job.id,
			"retry_state_json = ?",
			JSON.stringify({ since: Date.now() - 1_900_000, waits: 12 }),
		);

		await drain(extractionJob);

		const row = readJob(job.id);
		expect(row).toMatchObject({
			status: "failed",
			errorCode: "unavailable",
			retryable: true,
		});
		// The button the live failure could not offer.
		expect(await retryExtractionJob({ userId, jobId: job.id })).not.toBeNull();
		expect(readJob(job.id).status).toBe("queued");
	});

	it("keeps the outage discount when the job finally succeeds", async () => {
		const {
			drain,
			extractionJob,
			readExtractionRetryState,
			parseExtractionHints,
		} = await load();
		const job = await enqueueJob({ hints: { tier: "basic" } });
		// It waited out an outage once, and is queued again.
		settle(
			job.id,
			"attempt_count = 1, retry_state_json = ?",
			JSON.stringify({ since: 1_000, waits: 1 }),
		);
		seams.extractor = createFakeExtractor({ steps: [{ kind: "succeed" }] });
		seams.persist = async () => ({
			id: fixture.seedArtifact({
				userId,
				type: "normalized_document",
				name: "report.md",
			}),
		});

		await drain(extractionJob);

		const row = readJob(job.id);
		expect(row.status).toBe("succeeded");
		// The caller's own hint steered a parse that is over...
		expect(parseExtractionHints(row.hintsJson)).toBeNull();
		// ...the record that an attempt was the backend's fault is not.
		// `attempt_count` is never reset, so without it the ceiling would charge the
		// outage to the document the moment anyone pressed Re-extract.
		expect(readExtractionRetryState(row.retryState).waits).toBe(1);
	});
});

describe("materializeLegacyExtractionJob", () => {
	it("writes a failed, retryable row a user can act on", async () => {
		const { materializeLegacyExtractionJob, retryExtractionJob } = await load();

		const job = await materializeLegacyExtractionJob({
			userId,
			sourceArtifactId: artifactId,
			fileName: "report.pdf",
		});

		expect(job).toMatchObject({
			status: "failed",
			errorCode: "legacy_unknown",
			retryable: true,
			attemptCount: 0,
			intakeRoute: "mineru",
			origin: "upload",
		});
		const retried = await retryExtractionJob({ userId, jobId: job?.id ?? "" });
		expect(retried?.status).toBe("queued");
	});

	it("stamps the route the registry would give the file today, not always the backend", async () => {
		const { materializeLegacyExtractionJob } = await load();
		const textId = fixture.seedArtifact({
			userId,
			name: "notes.txt",
			mimeType: "text/plain",
		});

		const job = await materializeLegacyExtractionJob({
			userId,
			sourceArtifactId: textId,
		});

		expect(job?.intakeRoute).toBe("direct-text");
		expect(job?.fileName).toBe("notes.txt");
	});

	it("returns the existing row rather than a second one", async () => {
		const { materializeLegacyExtractionJob } = await load();
		const first = await enqueueJob();

		const second = await materializeLegacyExtractionJob({
			userId,
			sourceArtifactId: artifactId,
		});

		expect(second?.id).toBe(first.id);
	});

	it("refuses to hand another user's artifact back", async () => {
		const { materializeLegacyExtractionJob } = await load();
		const other = fixture.seedUser("user-2");
		await enqueueJob();

		expect(
			await materializeLegacyExtractionJob({
				userId: other,
				sourceArtifactId: artifactId,
			}),
		).toBeNull();
	});
});

describe("requeueExtractionJobForReextraction", () => {
	it("reopens a succeeded job with new hints, clears the checkpoint, and keeps the attempt count", async () => {
		const { requeueExtractionJobForReextraction } = await load();
		const job = await enqueueJob({ hints: { tier: "basic" } });
		settle(
			job.id,
			`status = 'succeeded', attempt_count = 1, completed_at = unixepoch(), remote_handle_json = '{"extractor":"mineru4","version":1}'`,
		);

		const result = await requeueExtractionJobForReextraction({
			userId,
			jobId: job.id,
			hints: { tier: "advanced", reextract: true },
		});

		expect(result).toMatchObject({
			ok: true,
			job: { status: "queued", attemptCount: 1, checkpoint: null },
		});
		expect(JSON.parse(readJob(job.id).hintsJson ?? "null")).toEqual({
			tier: "advanced",
			reextract: true,
		});
	});

	it("answers why it refused", async () => {
		const { requeueExtractionJobForReextraction, extractionAttemptCeiling } =
			await load();
		const other = fixture.seedUser("user-2");
		const job = await enqueueJob();

		expect(
			await requeueExtractionJobForReextraction({ userId, jobId: "nope" }),
		).toEqual({ ok: false, reason: "not_found" });
		expect(
			await requeueExtractionJobForReextraction({
				userId: other,
				jobId: job.id,
			}),
		).toEqual({ ok: false, reason: "not_found" });
		// Queued: being read right now, or about to be.
		expect(
			await requeueExtractionJobForReextraction({ userId, jobId: job.id }),
		).toEqual({ ok: false, reason: "active" });
		settle(job.id, "status = 'running', phase = 'parsing'");
		expect(
			await requeueExtractionJobForReextraction({ userId, jobId: job.id }),
		).toEqual({ ok: false, reason: "active" });
		settle(
			job.id,
			"status = 'succeeded', attempt_count = ?",
			extractionAttemptCeiling(3),
		);
		expect(
			await requeueExtractionJobForReextraction({
				userId,
				jobId: job.id,
				maxAttempts: 3,
			}),
		).toEqual({ ok: false, reason: "attempt_ceiling" });
		expect(readJob(job.id).status).toBe("succeeded");
	});

	it("holds the per-user cap on re-extractions in flight", async () => {
		const { requeueExtractionJobForReextraction } = await load();
		const jobs = [];
		for (let index = 0; index < 3; index += 1) {
			const artifact = fixture.seedArtifact({
				userId,
				name: `doc-${index}.pdf`,
			});
			jobs.push(
				await enqueueJob({
					sourceArtifactId: artifact,
					fileName: `doc-${index}.pdf`,
				}),
			);
		}
		for (const job of jobs) settle(job.id, "status = 'succeeded'");

		const asked = [];
		for (const job of jobs) {
			asked.push(
				await requeueExtractionJobForReextraction({
					userId,
					jobId: job.id,
					hints: { tier: "advanced", reextract: true },
					maxActiveReextractions: 2,
				}),
			);
		}

		expect(asked.map((result) => result.ok)).toEqual([true, true, false]);
		expect(asked[2]).toEqual({ ok: false, reason: "user_limit" });
	});

	it("carries the outage waits into the new run and starts its window again", async () => {
		const { requeueExtractionJobForReextraction, readExtractionRetryState } =
			await load();
		const job = await enqueueJob();
		settle(
			job.id,
			"status = 'succeeded', attempt_count = 14, retry_state_json = ?",
			JSON.stringify({ since: 99, waits: 12 }),
		);

		const result = await requeueExtractionJobForReextraction({
			userId,
			jobId: job.id,
			hints: { tier: "advanced" },
		});

		// Fourteen attempts, twelve of them the backend's: two against a ceiling of 8.
		expect(result.ok).toBe(true);
		expect(readExtractionRetryState(readJob(job.id).retryState)).toEqual({
			since: null,
			waits: 12,
		});
	});
});

describe("waitForExtractionJobVerdict", () => {
	it("answers the DTO the moment the job settles", async () => {
		const { waitForExtractionJobVerdict, drain, extractionJob } = await load();
		const job = await enqueueJob();
		seams.extractor = createFakeExtractor({ steps: [{ kind: "succeed" }] });
		seams.persist = async () => ({
			id: fixture.seedArtifact({
				userId,
				type: "normalized_document",
				name: "report.md",
			}),
		});

		const waiting = waitForExtractionJobVerdict({
			jobId: job.id,
			userId,
			timeoutMs: 5000,
		});
		await drain(extractionJob);

		const verdict = await waiting;
		expect(verdict.settled).toBe(true);
		expect(verdict.job).toMatchObject({
			id: job.id,
			status: "succeeded",
			attemptCount: 1,
		});
	});

	it("reports the last thing seen when the time runs out, never an error", async () => {
		const { waitForExtractionJobVerdict } = await load();
		const job = await enqueueJob();

		const verdict = await waitForExtractionJobVerdict({
			jobId: job.id,
			userId,
			timeoutMs: 30,
		});

		expect(verdict.settled).toBe(false);
		expect(verdict.job).toMatchObject({ id: job.id, status: "queued" });
	});

	it("stops when the caller's signal does", async () => {
		const { waitForExtractionJobVerdict } = await load();
		const job = await enqueueJob();
		const controller = new AbortController();
		const waiting = waitForExtractionJobVerdict({
			jobId: job.id,
			userId,
			timeoutMs: 60_000,
			signal: controller.signal,
		});

		controller.abort();

		await expect(waiting).resolves.toMatchObject({ settled: false });
	});

	it("answers a settled job at once, and a job that is not there as unsettled", async () => {
		const { waitForExtractionJobVerdict } = await load();
		const job = await enqueueJob();
		settle(job.id, "status = 'failed', error_code = 'empty_result'");

		expect(
			await waitForExtractionJobVerdict({
				jobId: job.id,
				userId,
				timeoutMs: 60_000,
			}),
		).toMatchObject({
			settled: true,
			job: { status: "failed", error: { code: "empty_result" } },
		});
		expect(
			await waitForExtractionJobVerdict({
				jobId: "nope",
				userId,
				timeoutMs: 60_000,
			}),
		).toEqual({ settled: false, job: null });
	});

	it("does not show another user's job", async () => {
		const { waitForExtractionJobVerdict } = await load();
		const other = fixture.seedUser("user-2");
		const job = await enqueueJob();
		settle(job.id, "status = 'failed', error_code = 'empty_result'");

		const verdict = await waitForExtractionJobVerdict({
			jobId: job.id,
			userId: other,
			timeoutMs: 60_000,
		});

		expect(verdict.job).toBeNull();
		expect(verdict.settled).toBe(false);
	});
});
