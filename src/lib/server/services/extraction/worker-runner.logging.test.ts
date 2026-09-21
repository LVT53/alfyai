// What the worker says out loud.
//
// The live incident produced ZERO `[EXTRACTION]` lines across 23 minutes of a
// stuck job, one stale reclaim and a requeue: everything that happened had to
// be reconstructed from the ledger afterwards. These lines are the minimum that
// makes the same sequence readable in a journal — and they carry ids, counts,
// codes and durations only, never a file name the user chose or a byte of the
// document, because this log ends up in places the document is not allowed to
// reach.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact } from "$lib/server/services/knowledge/types";
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
/** Only what `payloadsFor` reads, so the spy's own generics stay out of it. */
type ConsoleSpy = { mock: { calls: unknown[][] } };

let info: ConsoleSpy;
let warn: ConsoleSpy;
const userId = "user-1";

beforeEach(async () => {
	fixture = createLedgerFixture("worker-logging");
	fixture.seedUser(userId);
	storageDir = await mkdtemp(join(tmpdir(), "alfyai-worker-logging-"));

	process.env.DATABASE_PATH = fixture.dbPath;
	vi.resetModules();
	worker = await import("./worker-runner");
	ledger = await import("./job-ledger");
	worker.resetExtractionWorkerForTests();

	info = vi.spyOn(console, "info").mockImplementation(() => {});
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
	worker.resetExtractionWorkerForTests();
	fixture.cleanup();
	await rm(storageDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

async function enqueueStored(name: string): Promise<string> {
	const absolute = join(storageDir, name);
	await writeFile(absolute, "stored bytes", "utf8");
	const artifactId = fixture.seedArtifact({
		userId,
		name,
		storagePath: relative(process.cwd(), absolute),
	});
	const { job } = await ledger.enqueueExtractionJob({
		userId,
		conversationId: null,
		origin: "upload",
		intakeRoute: "mineru",
		fileName: name,
		mimeType: "application/pdf",
		sizeBytes: 12,
		sourceArtifactId: artifactId,
	});
	return job.id;
}

function fakePersist() {
	return (async () => {
		const id = fixture.seedArtifact({
			userId,
			type: "normalized_document",
			name: "normalized.md",
		});
		return { id } as Artifact;
	}) as never;
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
		const jobId = await enqueueStored("report.pdf");

		await worker.executeNextExtractionJob({
			workerId: "w1",
			resolveExtractor: () =>
				createFakeExtractor({ steps: [{ kind: "succeed", text: "hello" }] }),
			persistResult: fakePersist(),
		});

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
		const jobId = await enqueueStored("flaky.pdf");

		await worker.executeNextExtractionJob({
			workerId: "w1",
			resolveExtractor: () =>
				createFakeExtractor({
					steps: [{ kind: "throw", code: "unavailable" }],
				}),
		});

		const [line] = payloadsFor(warn, "[EXTRACTION] Attempt failed");
		expect(line).toMatchObject({
			jobId,
			errorCode: "unavailable",
			requeued: true,
		});
		expect(typeof line.nextAttemptAt).toBe("string");
		expect(payloadsFor(warn, "[EXTRACTION] Job reached max attempts")).toEqual(
			[],
		);
	});

	it("says when a job has burned its attempts", async () => {
		const jobId = await enqueueStored("doomed.pdf");
		const extractor = createFakeExtractor({
			steps: [{ kind: "throw", code: "unavailable" }],
		});

		for (let attempt = 0; attempt < 3; attempt += 1) {
			await worker.executeNextExtractionJob({
				workerId: "w1",
				resolveExtractor: () => extractor,
				// Past the backoff gate the previous failure wrote.
				now: new Date(Date.now() + attempt * 600_000),
			});
		}

		expect((await ledger.getExtractionJobRow(jobId))?.errorCode).toBe(
			"max_attempts",
		);
		expect(
			payloadsFor(warn, "[EXTRACTION] Job reached max attempts"),
		).toMatchObject([{ jobId, attemptCount: 3 }]);
	});

	it("says when a cancel was honoured", async () => {
		const jobId = await enqueueStored("canceled.pdf");
		const extractor = createFakeExtractor({
			steps: [{ kind: "hang" }],
			emitHandleAfterPhase: "uploading",
		});

		const running = worker.executeNextExtractionJob({
			workerId: "w1",
			resolveExtractor: () => extractor,
			heartbeatMs: 100,
		});
		await vi.waitFor(async () => {
			expect(
				(await ledger.getExtractionJobRow(jobId))?.remoteHandleJson,
			).not.toBeNull();
		});
		await ledger.cancelExtractionJob({ userId, jobId });
		await running;

		expect(payloadsFor(info, "[EXTRACTION] Cancel honoured")).toMatchObject([
			{ jobId, extractor: "fake" },
		]);
	});

	it("says nothing about a sweep that reclaimed nothing", async () => {
		// This one runs forever on an idle box; a line per tick would drown the
		// lines that matter.
		await worker.drainExtractionWorker({ workerId: "w1" });
		expect(payloadsFor(warn, "[EXTRACTION] Reclaimed stale attempts")).toEqual(
			[],
		);
	});
});
