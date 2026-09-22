// scripts/backfill-extractions.ts, exercised against a real migrated SQLite
// fixture — the same `createLedgerFixture` helper the extraction ledger's own
// integration tests use. Each test owns a throwaway cwd (for
// `data/knowledge/<userId>/…` files `resolveDeletablePath` can see) and a
// throwaway database, and imports the script fresh after pointing
// `DATABASE_PATH` at it.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import {
	createLedgerFixture,
	type LedgerFixture,
} from "$lib/server/services/extraction/testing/ledger-fixtures";
import {
	createFakeMineruServer,
	type FakeMineruServer,
	MINERU_FIXTURE_ROOT,
} from "$lib/server/services/mineru/testing/fake-server";

type ScriptModule = typeof import("./backfill-extractions");

let fixture: LedgerFixture;
let cwdDir: string;
let originalCwd: string;
let script: ScriptModule;

async function reimport() {
	process.env.DATABASE_PATH = fixture.dbPath;
	vi.resetModules();
	script = await import("./backfill-extractions");
}

/** Writes a real file under data/knowledge/<userId>/ so resolveDeletablePath sees it. */
async function seedFile(
	userId: string,
	name: string,
	bytes = "hello",
): Promise<string> {
	const dir = join(cwdDir, "data", "knowledge", userId);
	await mkdir(dir, { recursive: true });
	const abs = join(dir, name);
	await writeFile(abs, bytes, "utf8");
	return join("data", "knowledge", userId, name);
}

beforeEach(async () => {
	fixture = createLedgerFixture("backfill-script");
	cwdDir = await mkdtemp(join(tmpdir(), "alfyai-backfill-script-"));
	originalCwd = process.cwd();
	process.chdir(cwdDir);
	await reimport();
});

afterEach(async () => {
	process.chdir(originalCwd);
	fixture.cleanup();
	await rm(cwdDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("parseArgs", () => {
	it("parses every flag, space- and =-separated", () => {
		const args = script.parseArgs([
			"--apply",
			"--tier",
			"standard",
			"--include-direct-text",
			"--since",
			"2026-01-01T00:00:00.000Z",
			"--limit=5",
			"--user=user@example.com",
			"--only-failed",
		]);
		expect(args).toMatchObject({
			apply: true,
			tier: "standard",
			includeDirectText: true,
			limit: 5,
			user: "user@example.com",
			onlyFailed: true,
		});
		expect(args.since?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
	});

	it("defaults to a dry run with nothing set", () => {
		const args = script.parseArgs([]);
		expect(args.apply).toBe(false);
		expect(args.tier).toBeNull();
		expect(args.since).toBeNull();
		expect(args.limit).toBeNull();
		expect(args.status).toBe(false);
	});

	it("rejects an unparseable --since", () => {
		expect(() => script.parseArgs(["--since", "not-a-date"])).toThrow();
	});
});

describe("buildBackfillPlan: dry-run classification", () => {
	it("buckets documents by route, and reports exclusions with reasons", async () => {
		fixture.seedUser("user-1");

		const pdfPath = await seedFile("user-1", "report.pdf", "pdf-bytes");
		fixture.seedArtifact({
			id: "doc-pdf",
			userId: "user-1",
			name: "report.pdf",
			mimeType: "application/pdf",
			storagePath: pdfPath,
			sizeBytes: 9,
		});

		fixture.seedArtifact({
			id: "doc-txt",
			userId: "user-1",
			name: "notes.txt",
			mimeType: "text/plain",
			storagePath: await seedFile("user-1", "notes.txt"),
		});

		fixture.seedArtifact({
			id: "doc-avif",
			userId: "user-1",
			name: "photo.avif",
			mimeType: "image/avif",
			storagePath: await seedFile("user-1", "photo.avif"),
		});

		// A mineru-routed row whose file never made it to disk.
		fixture.seedArtifact({
			id: "doc-missing",
			userId: "user-1",
			name: "gone.pdf",
			mimeType: "application/pdf",
			storagePath: "data/knowledge/user-1/gone.pdf",
		});

		const plan = await script.buildBackfillPlan(
			script.parseArgs(["--tier", "standard"]),
		);
		const byId = new Map(plan.items.map((item) => [item.doc.artifactId, item]));

		expect(byId.get("doc-pdf")).toMatchObject({
			route: "mineru",
			include: true,
		});
		expect(byId.get("doc-txt")).toMatchObject({
			route: "direct-text",
			include: false,
			skipReason: "route_direct_text_excluded",
		});
		expect(byId.get("doc-avif")).toMatchObject({
			route: "reject",
			include: false,
			skipReason: "route_reject",
			rejectReason: "convertImage",
		});
		expect(byId.get("doc-missing")).toMatchObject({
			route: "mineru",
			include: false,
			skipReason: "missing_file",
		});
	});
});

describe("buildBackfillPlan: tier logic", () => {
	it("forces flash for a registry tierHint format, regardless of --tier", async () => {
		fixture.seedUser("user-1");
		fixture.seedArtifact({
			id: "doc-docx",
			userId: "user-1",
			name: "memo.docx",
			mimeType:
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			storagePath: await seedFile("user-1", "memo.docx"),
		});
		fixture.seedArtifact({
			id: "doc-pdf",
			userId: "user-1",
			name: "report.pdf",
			mimeType: "application/pdf",
			storagePath: await seedFile("user-1", "report.pdf"),
		});

		const plan = await script.buildBackfillPlan(
			script.parseArgs(["--tier", "standard"]),
		);
		const byId = new Map(plan.items.map((item) => [item.doc.artifactId, item]));

		expect(byId.get("doc-docx")).toMatchObject({
			effectiveTier: "flash",
			tierForced: true,
		});
		expect(byId.get("doc-pdf")).toMatchObject({
			effectiveTier: "standard",
			tierForced: false,
		});
	});

	it("skips a document already parsed at or above the requested tier", async () => {
		fixture.seedUser("user-1");
		fixture.seedArtifact({
			id: "doc-pdf",
			userId: "user-1",
			name: "report.pdf",
			mimeType: "application/pdf",
			storagePath: await seedFile("user-1", "report.pdf"),
		});
		const normalizedId = fixture.seedArtifact({
			id: "norm-pdf",
			userId: "user-1",
			type: "normalized_document",
			name: "report (normalized)",
			metadata: { extractionTier: "standard" },
		});
		fixture.db
			.insert(schema.documentExtractionJobs)
			.values({
				id: "job-pdf",
				userId: "user-1",
				sourceArtifactId: "doc-pdf",
				normalizedArtifactId: normalizedId,
				intakeRoute: "mineru",
				fileName: "report.pdf",
				status: "succeeded",
			})
			.run();

		const atSameTier = await script.buildBackfillPlan(
			script.parseArgs(["--tier", "standard"]),
		);
		expect(atSameTier.items[0]).toMatchObject({
			include: false,
			skipReason: "already_at_tier",
		});

		const atHigherTier = await script.buildBackfillPlan(
			script.parseArgs(["--tier", "advanced"]),
		);
		expect(atHigherTier.items[0]).toMatchObject({ include: true });
	});

	it("skips a document with an active (in-flight) job", async () => {
		fixture.seedUser("user-1");
		fixture.seedArtifact({
			id: "doc-pdf",
			userId: "user-1",
			name: "report.pdf",
			mimeType: "application/pdf",
			storagePath: await seedFile("user-1", "report.pdf"),
		});
		fixture.db
			.insert(schema.documentExtractionJobs)
			.values({
				id: "job-pdf",
				userId: "user-1",
				sourceArtifactId: "doc-pdf",
				intakeRoute: "mineru",
				fileName: "report.pdf",
				status: "parsing",
			})
			.run();

		const plan = await script.buildBackfillPlan(
			script.parseArgs(["--tier", "standard"]),
		);
		expect(plan.items[0]).toMatchObject({
			include: false,
			skipReason: "in_flight",
		});
	});
});

describe("applyBackfillPlan: idempotency, --limit", () => {
	it("a second dry run finds nothing left to enqueue once jobs succeed at tier", async () => {
		fixture.seedUser("user-1");
		fixture.seedArtifact({
			id: "doc-1",
			userId: "user-1",
			name: "a.pdf",
			mimeType: "application/pdf",
			storagePath: await seedFile("user-1", "a.pdf"),
		});

		const plan = await script.buildBackfillPlan(
			script.parseArgs(["--tier", "standard"]),
		);
		expect(plan.items.filter((item) => item.include)).toHaveLength(1);

		const result = await script.applyBackfillPlan(
			plan.items.filter((item) => item.include),
			{ limit: null },
		);
		expect(result.enqueued).toHaveLength(1);
		expect(result.failed).toHaveLength(0);

		// The job now exists, stamped by the script, and queued — simulate the
		// worker finishing it successfully at the requested tier (the full,
		// real worker + fake MinerU server path is covered separately in
		// extraction-replace-path.e2e.test.ts).
		const [job] = fixture.db
			.select()
			.from(schema.documentExtractionJobs)
			.where(eq(schema.documentExtractionJobs.sourceArtifactId, "doc-1"))
			.all();
		expect(job?.requestedBy).toBe("backfill");
		expect(job?.status).toBe("queued");

		const normalizedId = fixture.seedArtifact({
			id: "norm-1",
			userId: "user-1",
			type: "normalized_document",
			name: "a (normalized)",
			metadata: { extractionTier: "standard" },
		});
		fixture.db
			.update(schema.documentExtractionJobs)
			.set({ status: "succeeded", normalizedArtifactId: normalizedId })
			.where(eq(schema.documentExtractionJobs.id, job?.id as string))
			.run();

		const secondPlan = await script.buildBackfillPlan(
			script.parseArgs(["--tier", "standard"]),
		);
		expect(secondPlan.items.filter((item) => item.include)).toHaveLength(0);
		const secondResult = await script.applyBackfillPlan([], { limit: null });
		expect(secondResult.enqueued).toHaveLength(0);
	});

	it("--limit enqueues only the first N and leaves the rest untouched", async () => {
		fixture.seedUser("user-1");
		for (const n of [1, 2, 3]) {
			fixture.seedArtifact({
				id: `doc-${n}`,
				userId: "user-1",
				name: `doc-${n}.pdf`,
				mimeType: "application/pdf",
				storagePath: await seedFile("user-1", `doc-${n}.pdf`),
			});
		}

		const plan = await script.buildBackfillPlan(
			script.parseArgs(["--tier", "standard"]),
		);
		const included = plan.items.filter((item) => item.include);
		expect(included).toHaveLength(3);

		const result = await script.applyBackfillPlan(included, { limit: 2 });
		expect(result.enqueued).toHaveLength(2);

		const jobs = fixture.db.select().from(schema.documentExtractionJobs).all();
		expect(jobs).toHaveLength(2);
	});

	it("bypasses the five-in-flight-per-user re-extraction cap", async () => {
		fixture.seedUser("user-1");
		for (let n = 0; n < 6; n++) {
			fixture.seedArtifact({
				id: `doc-${n}`,
				userId: "user-1",
				name: `doc-${n}.pdf`,
				mimeType: "application/pdf",
				storagePath: await seedFile("user-1", `doc-${n}.pdf`),
			});
		}
		const plan = await script.buildBackfillPlan(
			script.parseArgs(["--tier", "standard"]),
		);
		const included = plan.items.filter((item) => item.include);
		expect(included).toHaveLength(6);

		const result = await script.applyBackfillPlan(included, { limit: null });
		// Every one of the six queues, even though the user-facing cap is 5.
		expect(result.enqueued).toHaveLength(6);
		expect(result.failed).toHaveLength(0);
	});
});

describe("--only-failed", () => {
	it("selects only this campaign's user-retryable failures", async () => {
		fixture.seedUser("user-1");
		fixture.seedArtifact({
			id: "doc-backfill-retryable",
			userId: "user-1",
			name: "a.pdf",
			mimeType: "application/pdf",
			storagePath: await seedFile("user-1", "a.pdf"),
		});
		fixture.seedArtifact({
			id: "doc-backfill-terminal",
			userId: "user-1",
			name: "b.pdf",
			mimeType: "application/pdf",
			storagePath: await seedFile("user-1", "b.pdf"),
		});
		fixture.seedArtifact({
			id: "doc-organic-failure",
			userId: "user-1",
			name: "c.pdf",
			mimeType: "application/pdf",
			storagePath: await seedFile("user-1", "c.pdf"),
		});

		fixture.db
			.insert(schema.documentExtractionJobs)
			.values([
				{
					id: "job-retryable",
					userId: "user-1",
					sourceArtifactId: "doc-backfill-retryable",
					intakeRoute: "mineru",
					fileName: "a.pdf",
					status: "failed",
					retryable: true,
					errorCode: "job_failed",
					requestedBy: "backfill",
				},
				{
					id: "job-terminal",
					userId: "user-1",
					sourceArtifactId: "doc-backfill-terminal",
					intakeRoute: "mineru",
					fileName: "b.pdf",
					status: "failed",
					retryable: false,
					errorCode: "document_unreadable",
					requestedBy: "backfill",
				},
				{
					id: "job-organic",
					userId: "user-1",
					sourceArtifactId: "doc-organic-failure",
					intakeRoute: "mineru",
					fileName: "c.pdf",
					status: "failed",
					retryable: true,
					errorCode: "job_failed",
					requestedBy: null,
				},
			])
			.run();

		const plan = await script.buildBackfillPlan(
			script.parseArgs(["--tier", "standard"]),
		);
		const jobs = fixture.db.select().from(schema.documentExtractionJobs).all();
		const byId = new Map(
			jobs.map((row) => [
				row.id,
				{
					requestedBy: row.requestedBy,
					status: row.status,
					retryable: row.retryable,
				},
			]),
		);
		const onlyFailed = script.filterOnlyFailed(plan, byId);

		expect(onlyFailed.map((item) => item.doc.artifactId)).toEqual([
			"doc-backfill-retryable",
		]);
	});
});

describe("the replace path, end to end against a real MinerU 4 fixture", () => {
	let server: FakeMineruServer;

	afterEach(async () => {
		await server?.close();
	});

	it("keeps the document's id/title/created_at and ends with page-aware chunks", async () => {
		server = await createFakeMineruServer({ fixtureInput: "pdf" });

		const userId = "legacy-user";
		fixture.seedUser(userId);

		// A document parsed under MinerU 3.x: a normalized artifact with FLAT
		// chunks (no page_start/page_end) and no ledger job row at all — exactly
		// what `docs/uploads.md` calls a document that "predates structured
		// extraction". `createdAt` is set in the past so the test can assert it
		// survives the rewrite untouched.
		const legacyCreatedAt = new Date("2026-01-01T00:00:00.000Z");
		const sourceId = "legacy-source-doc";
		const pdfBytes = await readFile(
			join(MINERU_FIXTURE_ROOT, "pdf", "sample.pdf"),
		);
		const dir = join(cwdDir, "data", "knowledge", userId);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "sample.pdf"), pdfBytes);

		fixture.seedArtifact({
			id: sourceId,
			userId,
			name: "Board Report.pdf",
			mimeType: "application/pdf",
			sizeBytes: pdfBytes.byteLength,
			storagePath: "data/knowledge/legacy-user/sample.pdf",
			createdAt: legacyCreatedAt,
		});
		const normalizedId = "legacy-normalized-doc";
		fixture.seedArtifact({
			id: normalizedId,
			userId,
			type: "normalized_document",
			name: "Board Report (normalized)",
			contentText: "Flat MinerU-3 text, no pages.",
			createdAt: legacyCreatedAt,
		});
		fixture.seedNormalizedLink({
			userId,
			normalizedArtifactId: normalizedId,
			sourceArtifactId: sourceId,
		});
		fixture.db
			.insert(schema.artifactChunks)
			.values({
				id: "legacy-chunk-1",
				artifactId: normalizedId,
				userId,
				chunkIndex: 0,
				contentText: "Flat MinerU-3 text, no pages.",
				pageStart: null,
				pageEnd: null,
			})
			.run();

		process.env.MINERU_API_URL = server.baseUrl;
		process.env.MINERU_API_KEY = "";
		process.env.MINERU_POLL_MIN_MS = "50";
		process.env.MINERU_POLL_MAX_MS = "200";
		process.env.MINERU_REQUEST_TIMEOUT_MS = "5000";
		process.env.MINERU_TRANSFER_TIMEOUT_MS = "10000";
		process.env.MINERU_CAPABILITIES_TTL_MS = "0";
		process.env.SMALL_FILE_THRESHOLD_CHARS = "1";
		await reimport();

		const plan = await script.buildBackfillPlan(
			script.parseArgs(["--tier", "basic"]),
		);
		const item = plan.items.find((entry) => entry.doc.artifactId === sourceId);
		expect(item).toMatchObject({ route: "mineru", include: true });
		if (!item) throw new Error("expected a plan item for the legacy document");

		const applyResult = await script.applyBackfillPlan([item], {
			limit: null,
		});
		expect(applyResult.failed).toEqual([]);
		expect(applyResult.enqueued).toHaveLength(1);

		// Run the REAL worker against the fake server — no scripted extractor,
		// no fake `persistResult`: the same worker-runner + extractors/mineru4 +
		// extraction/persist path a live deployment runs.
		const worker = await import(
			"$lib/server/services/extraction/worker-runner"
		);
		const outcome = await worker.executeNextExtractionJob({
			workerId: "backfill-e2e",
		});
		expect(outcome?.status).toBe("succeeded");

		// The source document's identity is untouched.
		const [sourceRow] = fixture.db
			.select()
			.from(schema.artifacts)
			.where(eq(schema.artifacts.id, sourceId))
			.all();
		expect(sourceRow?.id).toBe(sourceId);
		expect(sourceRow?.name).toBe("Board Report.pdf");
		expect(sourceRow?.createdAt?.toISOString()).toBe(
			legacyCreatedAt.toISOString(),
		);

		// The normalized artifact was REWRITTEN in place — same id — per
		// `rewriteNormalizedArtifact` (src/lib/server/services/extraction/persist.ts).
		const [normalizedRow] = fixture.db
			.select()
			.from(schema.artifacts)
			.where(eq(schema.artifacts.id, normalizedId))
			.all();
		expect(normalizedRow?.id).toBe(normalizedId);
		const metadata = JSON.parse(normalizedRow?.metadataJson ?? "{}") as Record<
			string,
			unknown
		>;
		expect(metadata.extractionProducer).toBe("mineru");
		expect(metadata.pageCount).toBe(3);

		// The OLD flat chunk is gone; every current chunk carries a page range.
		const chunks = fixture.db
			.select()
			.from(schema.artifactChunks)
			.where(eq(schema.artifactChunks.artifactId, normalizedId))
			.all();
		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks.some((chunk) => chunk.id === "legacy-chunk-1")).toBe(false);
		for (const chunk of chunks) {
			expect(chunk.pageStart).not.toBeNull();
			expect(chunk.pageEnd).not.toBeNull();
		}

		// The job this script created is stamped, so a resumed run leaves it be.
		const [jobRow] = fixture.db
			.select()
			.from(schema.documentExtractionJobs)
			.where(eq(schema.documentExtractionJobs.sourceArtifactId, sourceId))
			.all();
		expect(jobRow?.requestedBy).toBe("backfill");
		expect(jobRow?.status).toBe("succeeded");
	});
});
