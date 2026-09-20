// End-to-end over the real ledger, the real worker and a scripted extractor.
// The unit files prove each transition in isolation; this one proves the
// sequences a user actually lives through.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact } from "$lib/server/services/knowledge/types";
import type { EXTRACTION_ERROR_CODES } from "$lib/shared/extraction-status";
import {
	createFakeExtractor,
	type FakeExtractor,
} from "./testing/fake-extractor";
import {
	createLedgerFixture,
	type LedgerFixture,
} from "./testing/ledger-fixtures";

type Worker = typeof import("./worker-runner");
type Ledger = typeof import("./job-ledger");
type ReadModel = typeof import("./read-model");

let fixture: LedgerFixture;
let worker: Worker;
let ledger: Ledger;
let readModel: ReadModel;
let storageDir: string;

const PAST = new Date(Date.now() - 600_000);

beforeEach(async () => {
	fixture = createLedgerFixture("integration");
	fixture.seedUser("user-1");
	fixture.seedUser("user-2");
	storageDir = await mkdtemp(join(tmpdir(), "alfyai-integration-"));

	process.env.DATABASE_PATH = fixture.dbPath;
	vi.resetModules();
	worker = await import("./worker-runner");
	ledger = await import("./job-ledger");
	readModel = await import("./read-model");
	worker.resetExtractionWorkerForTests();
});

afterEach(async () => {
	fixture.cleanup();
	await rm(storageDir, { recursive: true, force: true });
});

async function seedJob(
	options: { userId?: string; name?: string; priority?: number } = {},
) {
	const userId = options.userId ?? "user-1";
	const name = options.name ?? `${Math.random()}.pdf`;
	const absolute = join(storageDir, name);
	await writeFile(absolute, "bytes", "utf8");
	const artifactId = fixture.seedArtifact({
		userId,
		name,
		storagePath: relative(process.cwd(), absolute),
	});
	const { job } = await ledger.enqueueExtractionJob({
		userId,
		conversationId: null,
		origin: options.priority === 10 ? "generated_file_readback" : "upload",
		intakeRoute: "mineru",
		fileName: name,
		mimeType: "application/pdf",
		sizeBytes: 5,
		sourceArtifactId: artifactId,
		priority: options.priority,
	});
	return { jobId: job.id, artifactId, userId };
}

function persistInto(fixtureRef: LedgerFixture, userId = "user-1") {
	return (async () => {
		const id = fixtureRef.seedArtifact({
			userId,
			type: "normalized_document",
			name: `normalized-${Math.random()}.md`,
		});
		return { id } as Artifact;
	}) as never;
}

async function runOnce(
	extractor: FakeExtractor,
	overrides: Record<string, unknown> = {},
) {
	return worker.executeNextExtractionJob({
		workerId: "worker-1",
		resolveExtractor: () => extractor,
		persistResult: persistInto(fixture),
		...overrides,
	});
}

/** Moves every backoff gate into the past so the next claim is not blocked. */
function clearBackoffGates(): void {
	fixture.sqlite
		.prepare("UPDATE document_extraction_jobs SET next_attempt_at = NULL")
		.run();
}

describe("1 — a slow success walks the ladder and settles exactly once", () => {
	it("ends succeeded with one attempt and a terminal DTO", async () => {
		const { jobId, artifactId } = await seedJob({ name: "slow.pdf" });
		const extractor = createFakeExtractor({
			steps: [{ kind: "succeed", afterMs: 5, text: "parsed text" }],
			emitHandleAfterPhase: "parsing",
		});

		expect(await runOnce(extractor)).toEqual({ jobId, status: "succeeded" });

		const dto = await readModel.getExtractionJobForArtifact({
			userId: "user-1",
			artifactId,
		});
		expect(dto).toMatchObject({
			status: "succeeded",
			attemptCount: 1,
			retryable: false,
			cancelable: false,
			legacy: false,
		});

		// Terminal exactly once: a second drain must find nothing to do.
		expect(await runOnce(extractor)).toBeNull();
		expect(await ledger.listExtractionJobAttempts(jobId)).toHaveLength(1);
	});
});

describe("2 — two transient failures then success", () => {
	it("records three attempts in order and respects the backoff gate", async () => {
		const { jobId } = await seedJob({ name: "flaky.pdf" });
		const extractor = createFakeExtractor({
			steps: [
				{ kind: "throw", code: "unavailable" },
				{ kind: "throw", code: "unavailable" },
				{ kind: "succeed" },
			],
		});

		expect(await runOnce(extractor)).toEqual({ jobId, status: "queued" });
		// The gate is real: nothing is claimable until it elapses.
		expect(await runOnce(extractor)).toBeNull();
		clearBackoffGates();

		expect(await runOnce(extractor)).toEqual({ jobId, status: "queued" });
		clearBackoffGates();
		expect(await runOnce(extractor)).toEqual({ jobId, status: "succeeded" });

		const attempts = await ledger.listExtractionJobAttempts(jobId);
		expect(attempts.map((a) => a.attemptNumber)).toEqual([1, 2, 3]);
		expect(attempts.map((a) => a.status)).toEqual([
			"failed",
			"failed",
			"succeeded",
		]);
	});
});

describe("3 — the attempt cap, then a user retry", () => {
	it("caps at max_attempts and grants exactly one more attempt", async () => {
		const { jobId, artifactId } = await seedJob({ name: "down.pdf" });
		const extractor = createFakeExtractor({
			steps: [{ kind: "throw", code: "unavailable" }],
		});

		for (let i = 0; i < 3; i += 1) {
			await runOnce(extractor);
			clearBackoffGates();
		}

		let dto = await readModel.getExtractionJobForArtifact({
			userId: "user-1",
			artifactId,
		});
		expect(dto).toMatchObject({
			status: "failed",
			attemptCount: 3,
			// Terminal for the worker, still actionable for the user.
			retryable: true,
		});
		expect(dto?.error?.code).toBe("max_attempts");

		await ledger.retryExtractionJob({ userId: "user-1", jobId });
		expect(await runOnce(extractor)).toEqual({ jobId, status: "failed" });

		dto = await readModel.getExtractionJobForArtifact({
			userId: "user-1",
			artifactId,
		});
		expect(dto?.attemptCount).toBe(4);
		// And only one: the budget is not reset to three.
		clearBackoffGates();
		expect(await runOnce(extractor)).toBeNull();
	});
});

describe("4 — non-retryable codes fail on the first attempt", () => {
	const codes: (typeof EXTRACTION_ERROR_CODES)[number][] = [
		"tier_unavailable",
		"auth_failed",
		"too_large",
		"unsupported_type",
		"empty_result",
		"internal",
	];

	it.each(codes)("%s fails once and is not user-retryable", async (code) => {
		const { jobId, artifactId } = await seedJob({ name: `${code}.pdf` });
		const extractor = createFakeExtractor({ steps: [{ kind: "throw", code }] });

		expect(await runOnce(extractor)).toEqual({ jobId, status: "failed" });
		expect(await ledger.listExtractionJobAttempts(jobId)).toHaveLength(1);

		const dto = await readModel.getExtractionJobForArtifact({
			userId: "user-1",
			artifactId,
		});
		expect(dto?.status).toBe("failed");
		expect(dto?.error?.code).toBe(code);
		expect(dto?.retryable).toBe(false);
	});
});

describe("5 — a worker restart resumes the remote job", () => {
	it("hands attempt 2 the persisted handle instead of re-submitting", async () => {
		const { jobId } = await seedJob({ name: "resume.pdf" });
		const extractor = createFakeExtractor({
			steps: [{ kind: "hang" }, { kind: "succeed" }],
			emitHandleAfterPhase: "parsing",
		});

		const running = runOnce(extractor, { heartbeatMs: 250 });
		await vi.waitFor(async () => {
			expect(
				(await ledger.getExtractionJobRow(jobId))?.remoteHandleJson,
			).not.toBeNull();
		});

		// The process "dies": the attempt stops heartbeating and is recovered.
		await ledger.recoverStaleExtractionAttempts({
			staleBefore: new Date(Date.now() + 60_000),
			maxAttempts: 3,
			retryBaseMs: 2000,
			retryMaxMs: 60000,
		});
		await running;
		clearBackoffGates();

		expect(
			await worker.executeNextExtractionJob({
				workerId: "worker-restarted",
				resolveExtractor: () => extractor,
				persistResult: persistInto(fixture),
			}),
		).toEqual({ jobId, status: "succeeded" });

		expect(extractor.calls).toHaveLength(2);
		expect(extractor.calls[0].resumed).toBe(false);
		expect(extractor.calls[1].resumed).toBe(true);
		expect(extractor.calls[1].handle?.remoteJobId).toBe("remote-parsing");
	});
});

describe("6 — a forgotten handle is cleared and the next attempt submits fresh", () => {
	it("clears remote_handle_json and resumes false", async () => {
		const { jobId } = await seedJob({ name: "forgotten.pdf" });
		const extractor = createFakeExtractor({
			steps: [
				{ kind: "throw", code: "unavailable" },
				{ kind: "forget-handle" },
				{ kind: "succeed" },
			],
			emitHandleAfterPhase: "parsing",
		});

		await runOnce(extractor);
		clearBackoffGates();
		expect(
			(await ledger.getExtractionJobRow(jobId))?.remoteHandleJson,
		).toContain("remote-parsing");

		// Attempt 2 resumes and is told the remote no longer knows the job.
		await runOnce(extractor);
		expect(
			(await ledger.getExtractionJobRow(jobId))?.remoteHandleJson,
		).toBeNull();
		clearBackoffGates();

		expect(await runOnce(extractor)).toEqual({ jobId, status: "succeeded" });
		expect(extractor.calls[1].resumed).toBe(true);
		expect(extractor.calls[2].resumed).toBe(false);
	});
});

describe("7 — cancel while parsing", () => {
	it("goes canceled, calls the remote cancel, and writes nothing after", async () => {
		const { jobId } = await seedJob({ name: "cancelme.pdf" });
		const extractor = createFakeExtractor({
			steps: [{ kind: "hang" }],
			emitHandleAfterPhase: "parsing",
		});

		const running = runOnce(extractor, { heartbeatMs: 100 });
		await vi.waitFor(async () => {
			expect((await ledger.getExtractionJobRow(jobId))?.status).toBe("parsing");
		});

		await ledger.cancelExtractionJob({ userId: "user-1", jobId });
		expect(await running).toEqual({ jobId, status: "canceled" });

		expect(extractor.cancelCalls.map((h) => h.remoteJobId)).toEqual([
			"remote-parsing",
		]);
		const row = await ledger.getExtractionJobRow(jobId);
		expect(row?.status).toBe("canceled");
		expect(row?.completedAt).not.toBeNull();
	});
});

describe("8 — concurrency caps hold across users and priorities", () => {
	it("never exceeds the caps and never lets a readback jump an upload", async () => {
		for (const userId of ["user-1", "user-2"]) {
			for (let i = 0; i < 2; i += 1) {
				await seedJob({ userId, name: `${userId}-upload-${i}.pdf` });
			}
			await seedJob({
				userId,
				name: `${userId}-readback.pdf`,
				priority: 10,
			});
		}

		const claims: string[] = [];
		for (let i = 0; i < 4; i += 1) {
			const claimed = await ledger.claimNextExtractionJob({
				workerId: `w${i}`,
				globalLimit: 2,
				perUserLimit: 1,
			});
			if (claimed) claims.push(claimed.job.fileName);
		}

		// Global cap 2 means only two ever run; per-user cap 1 means they belong
		// to different users; priority means both are uploads, not readbacks.
		expect(claims).toHaveLength(2);
		// One per user, because per-user 1 forces the second seat to the other.
		expect(new Set(claims.map((name) => name.split("-")[1])).size).toBe(2);
		expect(claims.every((name) => name.includes("upload"))).toBe(true);
	});
});

describe("9 — no ledger transaction is held across the extractor", () => {
	it("lets a competing writer through while an extraction is running", async () => {
		// better-sqlite3 transactions are synchronous and exclusive: if the worker
		// held one across `extractor.extract`, this write would fail or block the
		// whole process for the duration of every extraction.
		const { jobId } = await seedJob({ name: "concurrent.pdf" });
		const other = await seedJob({ name: "other.pdf" });

		let competingWriteSucceeded = false;
		const extractor = createFakeExtractor({ steps: [{ kind: "succeed" }] });
		const originalExtract = extractor.extract.bind(extractor);
		extractor.extract = async (request) => {
			await ledger.cancelExtractionJob({
				userId: "user-1",
				jobId: other.jobId,
			});
			competingWriteSucceeded = true;
			return originalExtract(request);
		};

		expect(await runOnce(extractor)).toEqual({ jobId, status: "succeeded" });
		expect(competingWriteSucceeded).toBe(true);
		expect((await ledger.getExtractionJobRow(other.jobId))?.status).toBe(
			"canceled",
		);
	});
});

describe("legacy artifacts alongside real rows", () => {
	it("mixes synthesised and real DTOs in one batch read", async () => {
		const { artifactId } = await seedJob({ name: "real.pdf" });
		const legacyId = fixture.seedArtifact({
			userId: "user-1",
			name: "legacy.pdf",
			createdAt: PAST,
		});

		const dtos = await readModel.getExtractionJobsForArtifacts({
			userId: "user-1",
			artifactIds: [artifactId, legacyId],
		});

		expect(dtos.map((dto) => dto.legacy)).toEqual([false, true]);
		expect(dtos[1].error?.code).toBe("legacy_unknown");

		// Retry on the synthetic first materialises a real row.
		const materialized = await ledger.materializeLegacyExtractionJob({
			userId: "user-1",
			sourceArtifactId: legacyId,
			fileName: "legacy.pdf",
		});
		await ledger.retryExtractionJob({
			userId: "user-1",
			jobId: materialized?.id ?? "",
		});

		const after = await readModel.getExtractionJobForArtifact({
			userId: "user-1",
			artifactId: legacyId,
		});
		expect(after?.legacy).toBe(false);
		expect(after?.status).toBe("queued");
	});
});
