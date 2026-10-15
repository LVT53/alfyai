import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createLedgerFixture,
	type LedgerFixture,
} from "./testing/ledger-fixtures";

type ReadModel = typeof import("./read-model");
type Ledger = typeof import("./extraction-job");

let fixture: LedgerFixture;
let readModel: ReadModel;
let ledger: Ledger;
const userId = "user-1";

const NOW = new Date("2026-09-20T12:00:00.000Z");
const LONG_AGO = new Date("2026-09-01T00:00:00.000Z");
const JUST_NOW = new Date("2026-09-20T11:59:00.000Z");

beforeEach(async () => {
	fixture = createLedgerFixture("read-model");
	fixture.seedUser(userId);
	fixture.seedUser("user-2");

	process.env.DATABASE_PATH = fixture.dbPath;
	vi.resetModules();
	readModel = await import("./read-model");
	ledger = await import("./extraction-job");
});

afterEach(() => {
	fixture.cleanup();
});

describe("getExtractionJobsForArtifacts — legacy synthesis", () => {
	it("returns the real row when one exists", async () => {
		const artifactId = fixture.seedArtifact({ userId, name: "real.pdf" });
		await ledger.enqueueExtractionJob({
			userId,
			conversationId: null,
			origin: "upload",
			intakeRoute: "mineru",
			fileName: "real.pdf",
			mimeType: "application/pdf",
			sizeBytes: 100,
			sourceArtifactId: artifactId,
		});

		const [dto] = await readModel.getExtractionJobsForArtifacts({
			userId,
			artifactIds: [artifactId],
			now: NOW,
		});

		expect(dto.legacy).toBe(false);
		expect(dto.status).toBe("queued");
		expect(dto.cancelable).toBe(true);
	});

	it("synthesises succeeded when a normalized artifact already exists", async () => {
		const artifactId = fixture.seedArtifact({
			userId,
			name: "old.pdf",
			createdAt: LONG_AGO,
		});
		const normalizedId = fixture.seedArtifact({
			userId,
			type: "normalized_document",
			name: "old.md",
			createdAt: LONG_AGO,
		});
		fixture.seedNormalizedLink({
			userId,
			normalizedArtifactId: normalizedId,
			sourceArtifactId: artifactId,
		});

		const [dto] = await readModel.getExtractionJobsForArtifacts({
			userId,
			artifactIds: [artifactId],
			now: NOW,
		});

		expect(dto).toMatchObject({
			id: `legacy-extraction:${artifactId}`,
			status: "succeeded",
			normalizedArtifactId: normalizedId,
			retryable: false,
			cancelable: false,
			legacy: true,
		});
	});

	it("synthesises a retryable legacy_unknown failure past the grace window", async () => {
		const artifactId = fixture.seedArtifact({
			userId,
			name: "orphan.pdf",
			createdAt: LONG_AGO,
		});

		const [dto] = await readModel.getExtractionJobsForArtifacts({
			userId,
			artifactIds: [artifactId],
			now: NOW,
		});

		expect(dto.status).toBe("failed");
		expect(dto.error?.code).toBe("legacy_unknown");
		expect(dto.retryable).toBe(true);
		expect(dto.legacy).toBe(true);
	});

	it("says queued inside the grace window, because an enqueue may be in flight", async () => {
		const artifactId = fixture.seedArtifact({
			userId,
			name: "just-uploaded.pdf",
			createdAt: JUST_NOW,
		});

		const [dto] = await readModel.getExtractionJobsForArtifacts({
			userId,
			artifactIds: [artifactId],
			now: NOW,
		});

		expect(dto.status).toBe("queued");
		expect(dto.cancelable).toBe(false);
		expect(dto.legacy).toBe(true);
	});

	it("writes nothing at all", async () => {
		// D7: the artifact table is unbounded per user and has no anchor to bound
		// a backfill sweep, so display-time synthesis must stay read-only.
		const artifactId = fixture.seedArtifact({
			userId,
			name: "orphan.pdf",
			createdAt: LONG_AGO,
		});

		const before = fixture.sqlite
			.prepare("SELECT count(*) AS n FROM document_extraction_jobs")
			.get() as { n: number };

		await readModel.getExtractionJobsForArtifacts({
			userId,
			artifactIds: [artifactId],
			now: NOW,
		});

		const after = fixture.sqlite
			.prepare("SELECT count(*) AS n FROM document_extraction_jobs")
			.get() as { n: number };
		expect(after.n).toBe(before.n);
		expect(after.n).toBe(0);
	});

	it("omits unknown and unowned ids rather than faking them", async () => {
		const mine = fixture.seedArtifact({
			userId,
			name: "mine.pdf",
			createdAt: LONG_AGO,
		});
		const theirs = fixture.seedArtifact({
			userId: "user-2",
			name: "theirs.pdf",
			createdAt: LONG_AGO,
		});

		const dtos = await readModel.getExtractionJobsForArtifacts({
			userId,
			artifactIds: [mine, theirs, "does-not-exist"],
			now: NOW,
		});

		expect(dtos.map((dto) => dto.sourceArtifactId)).toEqual([mine]);
	});

	it("preserves the caller's order and de-duplicates", async () => {
		const a = fixture.seedArtifact({
			userId,
			name: "a.pdf",
			createdAt: LONG_AGO,
		});
		const b = fixture.seedArtifact({
			userId,
			name: "b.pdf",
			createdAt: LONG_AGO,
		});

		const dtos = await readModel.getExtractionJobsForArtifacts({
			userId,
			artifactIds: [b, a, b],
			now: NOW,
		});
		expect(dtos.map((dto) => dto.sourceArtifactId)).toEqual([b, a]);
	});

	it("returns nothing for an empty request", async () => {
		expect(
			await readModel.getExtractionJobsForArtifacts({
				userId,
				artifactIds: [],
			}),
		).toEqual([]);
	});
});

describe("mapExtractionJobRow", () => {
	it("offers cancel on a live row and retry on a stopped one", async () => {
		const artifactId = fixture.seedArtifact({ userId, name: "x.pdf" });
		const { job } = await ledger.enqueueExtractionJob({
			userId,
			conversationId: null,
			origin: "upload",
			intakeRoute: "direct-text",
			fileName: "x.txt",
			mimeType: "text/plain",
			sizeBytes: 10,
			sourceArtifactId: artifactId,
		});

		const queued = readModel.mapExtractionJobRow(job, 3);
		expect(queued).toMatchObject({
			status: "queued",
			intakeRoute: "direct-text",
			retryable: false,
			cancelable: true,
			maxAttempts: 3,
			legacy: false,
			error: null,
			startedAt: null,
		});

		const canceled = await ledger.cancelExtractionJob({
			userId,
			jobId: job.id,
		});
		if (!canceled) throw new Error("expected the cancel to apply");
		const mapped = readModel.mapExtractionJobRow(canceled, 3);
		expect(mapped.cancelable).toBe(false);
		// The engine allows cancelled -> queued, so the DTO has to say so:
		// a user who hit Stop by mistake otherwise has to delete the document
		// and upload it again.
		expect(mapped.retryable).toBe(true);
	});

	it("surfaces an error while a requeued job waits for its next attempt", async () => {
		const artifactId = fixture.seedArtifact({ userId, name: "y.pdf" });
		const { job } = await ledger.enqueueExtractionJob({
			userId,
			conversationId: null,
			origin: "upload",
			intakeRoute: "mineru",
			fileName: "y.pdf",
			mimeType: null,
			sizeBytes: 10,
			sourceArtifactId: artifactId,
		});
		// What the engine leaves after an attempt failed against a backend that is
		// not answering: queued again behind a gate, the reason kept on the row.
		fixture.sqlite
			.prepare(
				`UPDATE document_extraction_jobs
				 SET status = 'queued', attempt_count = 1, started_at = unixepoch(),
				     error_code = 'unavailable', error_message = 'backend down',
				     retryable = 1, next_attempt_at = unixepoch() + 60
				 WHERE id = ?`,
			)
			.run(job.id);

		const dto = await readModel.getExtractionJobForArtifact({
			userId,
			artifactId,
		});
		// Queued again, but the UI must still be able to say why it is waiting.
		expect(dto?.status).toBe("queued");
		expect(dto?.error).toEqual({
			code: "unavailable",
			message: "backend down",
		});
		expect(dto?.retryable).toBe(false);
		expect(dto?.startedAt).not.toBeNull();
	});
});

describe("getExtractionJobById", () => {
	it("scopes to the owner", async () => {
		const artifactId = fixture.seedArtifact({ userId, name: "z.pdf" });
		const { job } = await ledger.enqueueExtractionJob({
			userId,
			conversationId: null,
			origin: "upload",
			intakeRoute: "mineru",
			fileName: "z.pdf",
			mimeType: null,
			sizeBytes: 1,
			sourceArtifactId: artifactId,
		});

		expect(
			await readModel.getExtractionJobById({ userId, jobId: job.id }),
		).not.toBeNull();
		expect(
			await readModel.getExtractionJobById({
				userId: "user-2",
				jobId: job.id,
			}),
		).toBeNull();
	});
});

describe("mapExtractionJobRow: the engine's words become the browser's", () => {
	async function row(set: string, ...params: Array<string | number>) {
		const artifactId = fixture.seedArtifact({
			userId,
			name: `${Math.random()}.pdf`,
		});
		const { job } = await ledger.enqueueExtractionJob({
			userId,
			conversationId: null,
			origin: "upload",
			intakeRoute: "mineru",
			fileName: "doc.pdf",
			mimeType: "application/pdf",
			sizeBytes: 10,
			sourceArtifactId: artifactId,
		});
		fixture.sqlite
			.prepare(`UPDATE document_extraction_jobs SET ${set} WHERE id = ?`)
			.run(...params, job.id);
		const [stored] = await readModel.getExtractionJobsForArtifacts({
			userId,
			artifactIds: [artifactId],
		});
		return stored;
	}

	it("says which phase a running job is in", async () => {
		for (const phase of ["uploading", "parsing", "downloading", "indexing"]) {
			const dto = await row("status = 'running', phase = ?", phase);
			expect(dto).toMatchObject({
				status: phase,
				cancelable: true,
				retryable: false,
			});
		}
	});

	it("reads a running job with no usable phase as uploading", async () => {
		expect((await row("status = 'running', phase = NULL")).status).toBe(
			"uploading",
		);
		expect((await row("status = 'running', phase = 'nonsense'")).status).toBe(
			"uploading",
		);
	});

	it("spells a cancelled job the way every client surface does", async () => {
		const dto = await row(
			"status = 'cancelled', cancel_requested_at = unixepoch(), attempt_count = 1",
		);
		expect(dto).toMatchObject({
			status: "canceled",
			cancelable: false,
			retryable: true,
		});
	});

	it("passes a word the previous release wrote in the deploy window straight through", async () => {
		expect((await row("status = 'parsing'")).status).toBe("parsing");
		expect((await row("status = 'canceled'")).status).toBe("canceled");
	});

	it("offers Retry on a failed job only when it says so, and never past the ceiling", async () => {
		expect(
			(await row("status = 'failed', retryable = 1, attempt_count = 2"))
				.retryable,
		).toBe(true);
		expect(
			(await row("status = 'failed', retryable = 0, attempt_count = 1"))
				.retryable,
		).toBe(false);
		// The automatic budget plus every retry a user is granted: 3 + 5.
		expect(
			(await row("status = 'failed', retryable = 1, attempt_count = 8"))
				.retryable,
		).toBe(false);
		expect(
			(await row("status = 'cancelled', attempt_count = 8")).retryable,
		).toBe(false);
	});

	it("shows the document's attempts, not the ones an outage spent", async () => {
		const dto = await row(
			"status = 'failed', retryable = 1, attempt_count = 12, retry_state_json = ?",
			JSON.stringify({ since: null, waits: 10 }),
		);
		expect(dto).toMatchObject({ attemptCount: 2, retryable: true });
	});

	it("carries the gate of a queued job as nextAttemptAt", async () => {
		const dto = await row("status = 'queued', next_attempt_at = 1781000000");
		expect(dto.nextAttemptAt).toBe(1_781_000_000_000);
	});
});
