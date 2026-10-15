// Intake: what `startUploadExtraction` and `startGeneratedFileReadback` do with
// the job an upload or a generated file becomes.
//
// Waking the worker is not the intake's business any more: the job engine wakes its
// kind itself whenever a transition leaves claimable work, and a job waiting behind
// a backoff gate has the timer the drain that requeued it armed (the live failure
// this file once guarded, a job queued 212 seconds past its own gate while a `.txt`
// upload arrived and did not unstick it, is the engine's `rearmAfterDrain` and idle
// tick now, and is tested there). What is left to prove here is what the intake
// itself decides: the route stamped on the job, which jobs settle inside the request,
// which are born settled, and what a re-upload of the same bytes means.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import type { Artifact } from "$lib/server/services/knowledge/types";
import { createFakeExtractor } from "./testing/fake-extractor";
import {
	createLedgerFixture,
	type LedgerFixture,
} from "./testing/ledger-fixtures";
import { runExtractionOnce } from "./testing/run-once";
import { resetSeams } from "./testing/runner-seams";

type Intake = typeof import("./intake");
type Jobs = typeof import("$lib/server/services/jobs");

let fixture: LedgerFixture;
let intake: Intake;
let jobs: Jobs;
let storageDir: string;
const userId = "user-1";

beforeEach(async () => {
	resetSeams();
	fixture = createLedgerFixture("intake");
	fixture.seedUser(userId);
	storageDir = await mkdtemp(join(tmpdir(), "alfyai-intake-"));

	process.env.DATABASE_PATH = fixture.dbPath;
	vi.resetModules();
	intake = await import("./intake");
	jobs = await import("$lib/server/services/jobs");
});

afterEach(async () => {
	jobs.resetJobsForTests();
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

/** How many times the engine was asked to wake the extraction kind. */
function wakes(): number {
	return jobs.inspectJobsForTests().extraction?.wakeRequests ?? 0;
}

async function storedArtifact(
	name: string,
	mimeType: string,
	contents = "some text",
): Promise<Artifact> {
	const absolute = join(storageDir, name);
	await writeFile(absolute, contents, "utf8");
	const id = fixture.seedArtifact({
		userId,
		name,
		mimeType,
		storagePath: relative(process.cwd(), absolute),
		sizeBytes: contents.length,
	});
	return {
		id,
		userId,
		name,
		mimeType,
		sizeBytes: contents.length,
	} as Artifact;
}

describe("startUploadExtraction", () => {
	it("settles a direct-text upload inside the request", async () => {
		const artifact = await storedArtifact("notes.txt", "text/plain");

		const dto = await intake.startUploadExtraction({
			userId,
			conversationId: null,
			artifact,
			inlineBudgetMs: 5000,
		});

		expect(dto.status).toBe("succeeded");
		expect(dto.normalizedArtifactId).not.toBeNull();
	});

	it("leaves the job queued for the engine when the inline budget is zero, and says so to the engine", async () => {
		const artifact = await storedArtifact("notes.txt", "text/plain");

		const dto = await intake.startUploadExtraction({
			userId,
			conversationId: null,
			artifact,
			inlineBudgetMs: 0,
		});

		expect(dto.status).toBe("queued");
		expect(wakes()).toBeGreaterThan(0);
	});

	it("leaves a PDF queued for the engine", async () => {
		const artifact = await storedArtifact("report.pdf", "application/pdf");

		const dto = await intake.startUploadExtraction({
			userId,
			conversationId: null,
			artifact,
		});

		expect(dto.status).toBe("queued");
		expect(dto.intakeRoute).toBe("mineru");
		expect(wakes()).toBeGreaterThan(0);
	});

	it("answers a dedupe hit as succeeded without running anything", async () => {
		const artifact = await storedArtifact("dupe.pdf", "application/pdf");
		const normalizedArtifactId = fixture.seedArtifact({
			userId,
			type: "normalized_document",
			name: "dupe.pdf.md",
		});

		const dto = await intake.startUploadExtraction({
			userId,
			conversationId: null,
			artifact,
			existingNormalizedArtifactId: normalizedArtifactId,
		});

		expect(dto).toMatchObject({
			status: "succeeded",
			normalizedArtifactId,
			attemptCount: 0,
		});
	});

	it("answers an unsupported type as failed without ever queueing it", async () => {
		const artifact = await storedArtifact("clip.mp4", "video/mp4");

		const dto = await intake.startUploadExtraction({
			userId,
			conversationId: null,
			artifact,
		});

		expect(dto).toMatchObject({
			status: "failed",
			attemptCount: 0,
			error: { code: "unsupported_type" },
		});
		expect(wakes()).toBe(0);
	});

	// Phase 5 P5-B: the MinerU-4 availability gate's html fallback (amended
	// OQ2). `getIntakeRoute("page.html", ...)` alone always says "mineru"; the
	// gate is what can downgrade it to "direct-text" — and only for html.
	describe("MinerU-4 gate fallback (html)", () => {
		async function freshIntakeWithGate(reason: "backend_version" | null) {
			vi.doMock(
				"$lib/server/services/knowledge/format-availability",
				async () => {
					const actual = await vi.importActual<
						typeof import("$lib/server/services/knowledge/format-availability")
					>("$lib/server/services/knowledge/format-availability");
					return {
						...actual,
						getUploadFormatGate: vi.fn(async () => ({
							disabledEntryIds: new Set<string>(),
							reason,
							backendVersion: reason === "backend_version" ? "3.9.0" : null,
							checkedAt: new Date(0).toISOString(),
						})),
					};
				},
			);
			vi.resetModules();
			resetSeams();
			const freshIntake: Intake = await import("./intake");
			jobs = await import("$lib/server/services/jobs");
			return { freshIntake };
		}

		it("keeps html on the mineru route while the gate is open", async () => {
			const { freshIntake } = await freshIntakeWithGate(null);
			const artifact = await storedArtifact("page.html", "text/html");

			const dto = await freshIntake.startUploadExtraction({
				userId,
				conversationId: null,
				artifact,
			});

			expect(dto.intakeRoute).toBe("mineru");
		});

		it("falls html back to direct-text once the gate positively closes", async () => {
			const { freshIntake } = await freshIntakeWithGate("backend_version");
			const artifact = await storedArtifact("page.html", "text/html");

			const dto = await freshIntake.startUploadExtraction({
				userId,
				conversationId: null,
				artifact,
				inlineBudgetMs: 5000,
			});

			expect(dto.intakeRoute).toBe("direct-text");
		});

		it("leaves an ungated type's route untouched even when the gate is closed", async () => {
			const { freshIntake } = await freshIntakeWithGate("backend_version");
			const artifact = await storedArtifact("report.pdf", "application/pdf");

			const dto = await freshIntake.startUploadExtraction({
				userId,
				conversationId: null,
				artifact,
			});

			expect(dto.intakeRoute).toBe("mineru");
		});
	});
});

// Re-uploading the same bytes is the user saying "try this again".
//
// Binary-hash dedupe hands the upload path the artifact it already has, and
// the partial UNIQUE index on `source_artifact_id` hands the enqueue the job
// row it already has. Live, that pair replayed a terminal verdict into every
// later upload of the same file: a PDF that failed against a misconfigured
// backend stayed failed after the admin fixed the config, with no new attempt
// and no way out but deleting the document. The rule lives in
// `startUploadExtraction` because that is the one place all three upload
// routes already meet.
describe("startUploadExtraction on a re-upload of the same bytes", () => {
	function jobRows(sourceArtifactId: string) {
		return fixture.db
			.select()
			.from(schema.documentExtractionJobs)
			.where(
				eq(schema.documentExtractionJobs.sourceArtifactId, sourceArtifactId),
			)
			.all();
	}

	it("retries a cancelled direct-text job and settles it inline", async () => {
		const artifact = await storedArtifact(
			"minutes.txt",
			"text/plain",
			"Minutes of the meeting.",
		);

		// A budget of 0 leaves the job queued, which is the state a user can
		// actually press Cancel on.
		const first = await intake.startUploadExtraction({
			userId,
			conversationId: null,
			artifact,
			inlineBudgetMs: 0,
		});
		expect(first.status).toBe("queued");

		const ledger = await import("./extraction-job");
		await ledger.cancelExtractionJob({ userId, jobId: first.id });

		const second = await intake.startUploadExtraction({
			userId,
			conversationId: null,
			artifact,
			inlineBudgetMs: 5000,
		});

		expect(second.id).toBe(first.id);
		expect(second.status).toBe("succeeded");
		expect(second.normalizedArtifactId).not.toBeNull();
		expect(jobRows(artifact.id)).toHaveLength(1);
	});

	it("leaves a direct-text job that failed `internal` alone", async () => {
		const artifact = await storedArtifact("vanished.txt", "text/plain");
		// The stored file is gone, so the attempt fails `internal` — a code the
		// policy table marks NOT user-retryable, because the same bytes coming
		// back cannot make a missing file readable.
		await rm(join(storageDir, "vanished.txt"));

		const first = await intake.startUploadExtraction({
			userId,
			conversationId: null,
			artifact,
			inlineBudgetMs: 5000,
		});
		expect(first.status).toBe("failed");
		expect(first.error?.code).toBe("internal");

		const second = await intake.startUploadExtraction({
			userId,
			conversationId: null,
			artifact,
			inlineBudgetMs: 5000,
		});

		expect(second.status).toBe("failed");
		expect(second.error?.code).toBe("internal");
		expect(second.attemptCount).toBe(first.attemptCount);
		expect(jobRows(artifact.id)[0]?.status).toBe("failed");
	});

	it("never re-attempts a type the registry refuses", async () => {
		const artifact = await storedArtifact("clip.mp4", "video/mp4");

		const first = await intake.startUploadExtraction({
			userId,
			conversationId: null,
			artifact,
		});
		expect(first.status).toBe("failed");
		expect(first.error?.code).toBe("unsupported_type");

		const second = await intake.startUploadExtraction({
			userId,
			conversationId: null,
			artifact,
		});

		expect(second.status).toBe("failed");
		expect(second.error?.code).toBe("unsupported_type");
		expect(second.attemptCount).toBe(0);
		const rows = jobRows(artifact.id);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("failed");
	});

	it("returns the existing failure once the attempt ceiling is spent", async () => {
		const artifact = await storedArtifact("capped.pdf", "application/pdf");
		const first = await intake.startUploadExtraction({
			userId,
			conversationId: null,
			artifact,
		});

		const { extractionAttemptCeiling } = await import("./retry-policy");
		const { getExtractionConfig } = await import("./config");
		const ceiling = extractionAttemptCeiling(getExtractionConfig().maxAttempts);
		// The shape a job has after the user spent every retry they are granted:
		// user-retryable by code, refused by the ceiling.
		fixture.db
			.update(schema.documentExtractionJobs)
			.set({
				status: "failed",
				attemptCount: ceiling,
				errorCode: "max_attempts",
				errorMessage: "This document has been tried as often as it may be.",
				retryable: true,
				completedAt: new Date(),
			})
			.where(eq(schema.documentExtractionJobs.id, first.id))
			.run();

		const second = await intake.startUploadExtraction({
			userId,
			conversationId: null,
			artifact,
		});

		expect(second.status).toBe("failed");
		expect(second.error?.code).toBe("max_attempts");
		expect(jobRows(artifact.id)[0]?.attemptCount).toBe(ceiling);
	});

	it("turns two simultaneous re-uploads into exactly one retry", async () => {
		// Counts the transitions rather than inferring them: "one retry" is a claim
		// about the engine's compare-and-set inside `retryExtractionJob`, and a test
		// that only looked at the final row could not tell one transition from two.
		const retried: (string | null)[] = [];
		vi.doMock("./extraction-job", async (importOriginal) => {
			const actual = await importOriginal<typeof import("./extraction-job")>();
			return {
				...actual,
				retryExtractionJob: async (
					input: Parameters<typeof actual.retryExtractionJob>[0],
				) => {
					const row = await actual.retryExtractionJob(input);
					retried.push(row?.id ?? null);
					return row;
				},
			};
		});
		try {
			vi.resetModules();
			resetSeams();
			const freshIntake: Intake = await import("./intake");
			jobs = await import("$lib/server/services/jobs");

			const artifact = await storedArtifact("race.pdf", "application/pdf");
			const first = await freshIntake.startUploadExtraction({
				userId,
				conversationId: null,
				artifact,
			});
			await runExtractionOnce(fixture.sqlite, {
				resolveExtractor: () =>
					createFakeExtractor({
						steps: [{ kind: "throw", code: "backend_misconfigured" }],
					}),
			});
			expect(jobRows(artifact.id)[0]?.status).toBe("failed");

			const [a, b] = await Promise.all([
				freshIntake.startUploadExtraction({
					userId,
					conversationId: null,
					artifact,
				}),
				freshIntake.startUploadExtraction({
					userId,
					conversationId: null,
					artifact,
				}),
			]);

			expect(a.id).toBe(first.id);
			expect(b.id).toBe(first.id);
			expect(a.status).toBe("queued");
			expect(b.status).toBe("queued");
			expect(retried.filter((id) => id !== null)).toHaveLength(1);

			// One row, and the one extra attempt the retry grants — not two.
			const requeued = jobRows(artifact.id);
			expect(requeued).toHaveLength(1);
			expect(requeued[0]?.attemptCount).toBe(1);

			await runExtractionOnce(fixture.sqlite, {
				resolveExtractor: () =>
					createFakeExtractor({
						steps: [{ kind: "succeed", text: "Read at last." }],
					}),
			});
			expect(jobRows(artifact.id)[0]?.attemptCount).toBe(2);
			expect(
				await runExtractionOnce(fixture.sqlite, {
					resolveExtractor: () =>
						createFakeExtractor({ steps: [{ kind: "succeed" }] }),
				}),
			).toBeNull();
		} finally {
			// The mock has to go before the next test, and not only because it is
			// tidy: a module left mocked keeps the database singleton it closed over,
			// so the test after this one would write to the previous fixture's file.
			vi.doUnmock("./extraction-job");
			vi.resetModules();
		}
	});
});

describe("startGeneratedFileReadback", () => {
	async function seedGeneratedFile(name: string, mimeType: string) {
		fixture.seedConversation("conv-1", userId);
		fixture.sqlite
			.prepare(
				`INSERT INTO messages (id, conversation_id, role, content, created_at)
				 VALUES ('msg-1', 'conv-1', 'assistant', 'here', unixepoch())`,
			)
			.run();
		const absolute = join(storageDir, name);
		await writeFile(absolute, "generated bytes", "utf8");
		fixture.sqlite
			.prepare(
				`INSERT INTO chat_generated_files
				 (id, conversation_id, assistant_message_id, user_id, filename, mime_type, size_bytes, storage_path, created_at)
				 VALUES ('gen-1', 'conv-1', 'msg-1', ?, ?, ?, 15, ?, unixepoch())`,
			)
			.run(
				userId,
				name,
				mimeType,
				relative(join(process.cwd(), "data", "chat-files"), absolute),
			);
	}

	it("queues a readback behind uploads, and says so to the engine", async () => {
		await seedGeneratedFile("generated.pdf", "application/pdf");

		const dto = await intake.startGeneratedFileReadback({
			userId,
			conversationId: "conv-1",
			chatGeneratedFileId: "gen-1",
			fileName: "generated.pdf",
			mimeType: "application/pdf",
			sizeBytes: 15,
		});

		expect(dto.status).toBe("queued");
		expect(wakes()).toBeGreaterThan(0);
		const [row] = fixture.db.select().from(schema.documentExtractionJobs).all();
		expect(row).toMatchObject({
			origin: "generated_file_readback",
			priority: 10,
			chatGeneratedFileId: "gen-1",
		});
	});

	it("answers a refused readback as failed, never queued", async () => {
		await seedGeneratedFile("clip.mp4", "video/mp4");

		const dto = await intake.startGeneratedFileReadback({
			userId,
			conversationId: "conv-1",
			chatGeneratedFileId: "gen-1",
			fileName: "clip.mp4",
			mimeType: "video/mp4",
			sizeBytes: 15,
		});

		expect(dto.status).toBe("failed");
		expect(dto.error?.code).toBe("unsupported_type");
	});
});
