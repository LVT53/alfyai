// `DOCUMENT_EXTRACTION_WORKER_ENABLED` is registered with `effect: "live"`,
// and it was live in neither direction.
//
// OFF -> ON did nothing at all until a restart: `ensureExtractionWorker` set
// its once-per-process `initialized` flag BEFORE reading the switch and then
// returned, so nothing was left running to notice the flip. An admin who
// turned the worker on watched a queue that never moved and had no way to know
// the switch was not the problem.
//
// ON -> OFF has to be prompt for NEW claims and must not touch an attempt that
// is already running: the point of the switch is draining a box before a
// deploy, and killing an in-flight parse would strand the job and burn one of
// its attempts.
//
// Everything here moves the injected clock and never calls a wake.

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

const extractionConfig = vi.hoisted(() => ({
	value: {
		workerEnabled: true,
		maxConcurrency: 3,
		perUserConcurrency: 2,
		maxAttempts: 3,
		retryBaseMs: 2000,
		retryMaxMs: 60000,
		outageWindowMs: 1_800_000,
		staleAttemptMs: 120_000,
		heartbeatMs: 15_000,
		inlineBudgetMs: 1500,
		preflightWaitMs: 2500,
		maxDirectTextBytes: 8_388_608,
	},
}));

vi.mock("./config", () => ({
	EXTRACTION_STALE_HEARTBEAT_FLOOR: 4,
	getExtractionConfig: () => extractionConfig.value,
}));

type Worker = typeof import("./worker-runner");
type Ledger = typeof import("./job-ledger");

/** The idle tick the defaults above produce; see `idleTickIntervalMs`. */
const IDLE_TICK_MS = 30_000;

let fixture: LedgerFixture;
let worker: Worker;
let ledger: Ledger;
let storageDir: string;
const userId = "user-1";

beforeEach(async () => {
	extractionConfig.value = { ...extractionConfig.value, workerEnabled: true };
	fixture = createLedgerFixture("worker-enable-switch");
	fixture.seedUser(userId);
	storageDir = await mkdtemp(join(tmpdir(), "alfyai-enable-"));

	process.env.DATABASE_PATH = fixture.dbPath;
	vi.resetModules();
	worker = await import("./worker-runner");
	ledger = await import("./job-ledger");
	worker.resetExtractionWorkerForTests();
});

afterEach(async () => {
	worker.resetExtractionWorkerForTests();
	vi.useRealTimers();
	fixture.cleanup();
	await rm(storageDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function fakePersist() {
	let n = 0;
	return (async () => {
		n += 1;
		const id = fixture.seedArtifact({
			userId,
			type: "normalized_document",
			name: `normalized-${n}.md`,
		});
		return { id } as Artifact;
	}) as never;
}

async function enqueue(name: string): Promise<string> {
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

async function statusOf(jobId: string): Promise<string | undefined> {
	return (await ledger.getExtractionJobRow(jobId))?.status;
}

async function bootWorker(
	extractor: ReturnType<typeof createFakeExtractor>,
): Promise<void> {
	await worker.ensureExtractionWorker({
		startInNonServingContextForTests: true,
		workerId: "enable-switch-worker",
		resolveExtractor: () => extractor,
		persistResult: fakePersist(),
	});
}

describe("DOCUMENT_EXTRACTION_WORKER_ENABLED is live", () => {
	it("starts working when the switch is turned on, without a restart", async () => {
		extractionConfig.value = {
			...extractionConfig.value,
			workerEnabled: false,
		};
		vi.useFakeTimers();

		const jobId = await enqueue("late-start.pdf");
		await bootWorker(createFakeExtractor({ steps: [{ kind: "succeed" }] }));

		// Off: no claim, however long the box sits there.
		await vi.advanceTimersByTimeAsync(IDLE_TICK_MS * 3);
		expect(await statusOf(jobId)).toBe("queued");

		// The admin flips the switch. Nothing restarts.
		extractionConfig.value = { ...extractionConfig.value, workerEnabled: true };
		await vi.advanceTimersByTimeAsync(IDLE_TICK_MS + 1_000);

		expect(await statusOf(jobId)).toBe("succeeded");
	});

	it("stops taking new claims when the switch is turned off", async () => {
		vi.useFakeTimers();

		const first = await enqueue("first.pdf");
		await bootWorker(createFakeExtractor({ steps: [{ kind: "succeed" }] }));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(await statusOf(first)).toBe("succeeded");

		extractionConfig.value = {
			...extractionConfig.value,
			workerEnabled: false,
		};
		const second = await enqueue("second.pdf");

		await vi.advanceTimersByTimeAsync(IDLE_TICK_MS * 3);
		expect(await statusOf(second)).toBe("queued");

		// And back on again: the same process picks it up.
		extractionConfig.value = { ...extractionConfig.value, workerEnabled: true };
		await vi.advanceTimersByTimeAsync(IDLE_TICK_MS + 1_000);
		expect(await statusOf(second)).toBe("succeeded");
	});

	it("lets an in-flight attempt finish after the switch goes off", async () => {
		vi.useFakeTimers();

		const jobId = await enqueue("in-flight.pdf");
		const extractor = createFakeExtractor({ steps: [{ kind: "succeed" }] });
		await bootWorker(extractor);
		// The switch goes off while the attempt this worker already owns is
		// running. Killing it would strand the job and spend an attempt.
		await vi.advanceTimersByTimeAsync(0);

		extractionConfig.value = {
			...extractionConfig.value,
			workerEnabled: false,
		};
		await vi.advanceTimersByTimeAsync(IDLE_TICK_MS * 2);

		// It ran to completion rather than being abandoned mid-attempt.
		expect(await statusOf(jobId)).toBe("succeeded");
	});
});
