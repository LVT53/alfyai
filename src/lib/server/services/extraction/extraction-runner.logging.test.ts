// What the extraction worker says out loud.
//
// The live incident produced ZERO `[EXTRACTION]` lines across 23 minutes of a
// stuck job, one stale reclaim and a requeue: everything that happened had to
// be reconstructed from the ledger afterwards. These lines are the minimum that
// makes the same sequence readable in a journal — and they carry ids, counts,
// codes and durations only, never a file name the user chose or a byte of the
// document, because this log ends up in places the document is not allowed to
// reach.
//
// The lines come from two places now: the handler says what only it knows (a job
// succeeded, with its extractor and its text length), and the job engine says what
// happened to the attempt (it failed, was requeued until a time, ran out of
// attempts, was cancelled, was taken back). The words are the ones the worker used
// before the engine, and this test pins them.

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

let fixture: LedgerFixture;
let storageDir: string;
/** Only what `payloadsFor` reads, so the spy's own generics stay out of it. */
type ConsoleSpy = { mock: { calls: unknown[][] } };

let info: ConsoleSpy;
let warn: ConsoleSpy;
const userId = "user-1";

beforeEach(async () => {
	resetSeams();
	fixture = createLedgerFixture("extraction-runner-logging");
	fixture.seedUser(userId);
	storageDir = await mkdtemp(join(tmpdir(), "alfyai-extraction-logging-"));

	process.env.DATABASE_PATH = fixture.dbPath;
	vi.resetModules();

	info = vi.spyOn(console, "info").mockImplementation(() => {});
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
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

async function engine() {
	await installSeams();
	const jobs = await import("$lib/server/services/jobs");
	const { extractionJob } = await import("./extraction-job");
	return { ...jobs, extractionJob };
}

async function enqueueStored(name: string): Promise<string> {
	const absolute = join(storageDir, name);
	await writeFile(absolute, "stored bytes", "utf8");
	const artifactId = fixture.seedArtifact({
		userId,
		name,
		storagePath: relative(process.cwd(), absolute),
	});
	const { enqueue, extractionJob } = await engine();
	const { row } = await enqueue(extractionJob, {
		values: {
			userId,
			conversationId: null,
			sourceArtifactId: artifactId,
			origin: "upload",
			intakeRoute: "mineru",
			fileName: name,
			mimeType: "application/pdf",
			sizeBytes: 12,
		},
	});
	return row.id;
}

function fakePersist(): void {
	seams.persist = async () => {
		const id = fixture.seedArtifact({
			userId,
			type: "normalized_document",
			name: "normalized.md",
		});
		return { id };
	};
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

function payloadsFor(
	spy: ConsoleSpy,
	message: string,
): Record<string, unknown>[] {
	return spy.mock.calls
		.filter((call) => call[0] === message)
		.map((call) => call[1] as Record<string, unknown>);
}

describe("[EXTRACTION] worker log lines", () => {
	it("reports a success with its duration and text length", async () => {
		const { drain, extractionJob } = await engine();
		const jobId = await enqueueStored("report.pdf");
		seams.extractor = createFakeExtractor({
			steps: [{ kind: "succeed", text: "hello" }],
		});
		fakePersist();

		await drain(extractionJob);

		const [line] = payloadsFor(info, "[EXTRACTION] Job succeeded");
		expect(line).toMatchObject({
			jobId,
			attemptNumber: 1,
			extractor: "fake",
			textLength: 5,
		});
		expect(typeof line.durationMs).toBe("number");

		// Ids, counts and codes only: no file name, no extracted text.
		const serialized = JSON.stringify(line);
		expect(serialized).not.toContain("report.pdf");
		expect(serialized).not.toContain("hello");
	});

	it("reports a failed attempt with its code and its next attempt time", async () => {
		const { drain, extractionJob } = await engine();
		const jobId = await enqueueStored("flaky.pdf");
		seams.extractor = createFakeExtractor({
			steps: [{ kind: "throw", code: "job_failed" }],
		});

		await drain(extractionJob);

		const [line] = payloadsFor(warn, "[EXTRACTION] Attempt failed");
		expect(line).toMatchObject({
			jobId,
			errorCode: "job_failed",
			requeued: true,
		});
		expect(typeof line.nextAttemptAt).toBe("string");
		expect(payloadsFor(warn, "[EXTRACTION] Job reached max attempts")).toEqual(
			[],
		);
	});

	it("says when a job has burned its attempts", async () => {
		const { drain, extractionJob } = await engine();
		const jobId = await enqueueStored("doomed.pdf");
		seams.extractor = createFakeExtractor({
			steps: [{ kind: "throw", code: "job_failed" }],
		});

		for (let attempt = 0; attempt < 3; attempt += 1) {
			await drain(extractionJob);
			// Past the backoff gate the previous failure wrote.
			fixture.sqlite
				.prepare(
					"UPDATE document_extraction_jobs SET next_attempt_at = NULL WHERE id = ? AND status = 'queued'",
				)
				.run(jobId);
		}

		expect(readJob(jobId).errorCode).toBe("max_attempts");
		expect(
			payloadsFor(warn, "[EXTRACTION] Job reached max attempts"),
		).toMatchObject([{ jobId, attemptCount: 3 }]);
	});

	it("says when a cancel was honoured", async () => {
		const { drain, extractionJob, cancel } = await engine();
		const jobId = await enqueueStored("canceled.pdf");
		seams.extractor = createFakeExtractor({
			steps: [{ kind: "hang" }],
			emitHandleAfterPhase: "uploading",
		});

		const running = drain(extractionJob);
		await vi.waitFor(() => {
			expect(readJob(jobId).checkpoint).not.toBeNull();
		});
		await cancel(extractionJob, jobId, { userId });
		await running;

		expect(payloadsFor(info, "[EXTRACTION] Cancel honoured")).toMatchObject([
			{ jobId, attemptNumber: 1 },
		]);
	});

	it("says when an attempt was released without a verdict", async () => {
		const { drain, extractionJob, recover } = await engine();
		const jobId = await enqueueStored("taken.pdf");
		seams.extractor = createFakeExtractor({
			steps: [{ kind: "hang" }],
			emitHandleAfterPhase: "uploading",
		});

		const running = drain(extractionJob);
		await vi.waitFor(() => {
			expect(readJob(jobId).checkpoint).not.toBeNull();
		});
		await recover(extractionJob, {
			staleBefore: new Date(Date.now() + 60_000),
		});
		await running;

		expect(
			payloadsFor(warn, "[EXTRACTION] Attempt released without a verdict"),
		).toMatchObject([{ jobId, attemptNumber: 1 }]);
	});

	it("says nothing about a sweep that reclaimed nothing", async () => {
		const { drain, extractionJob } = await engine();
		// This one runs forever on an idle box; a line per tick would drown the
		// lines that matter.
		await drain(extractionJob);
		expect(payloadsFor(warn, "[EXTRACTION] Reclaimed stale attempts")).toEqual(
			[],
		);
	});
});
