// The one test that runs the whole upload path with nothing faked below the
// HTTP handler: route → upload-intake → knowledge store → extraction ledger →
// worker → a real `normalized_document` row in a real migrated database.
//
// Every other test of this phase mocks one of those seams. `upload.test.ts`
// mocks `upload-intake` wholesale, `upload-intake.test.ts` mocks the store AND
// the extraction facade, and `integration.test.ts` always passes a fake
// `persistResult`. Each of those is a reasonable unit test and none of them
// would notice if the pieces stopped fitting together — which is exactly the
// failure mode of a phase written by five agents in parallel.
//
// The legacy multipart route is used deliberately: it takes a plain `File`, so
// the test needs no streaming-body scaffolding, and it is the route the
// off-repo on-box verify scripts POST to, so its contract is the one most
// likely to break silently.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import { createFakeExtractor } from "./testing/fake-extractor";
import {
	createLedgerFixture,
	type LedgerFixture,
} from "./testing/ledger-fixtures";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

const USER_ID = "upload-e2e-user";

let fixture: LedgerFixture;
let cwdDir: string;
let originalCwd: string;

beforeEach(async () => {
	fixture = createLedgerFixture("upload-e2e");
	fixture.seedUser(USER_ID);

	// `knowledgeUserDir` and the worker's `resolveExtractionSource` both hang
	// off `process.cwd()`, so the test owns a throwaway one rather than writing
	// into the checkout's `data/`.
	cwdDir = await mkdtemp(join(tmpdir(), "alfyai-upload-e2e-"));
	originalCwd = process.cwd();
	process.chdir(cwdDir);

	process.env.DATABASE_PATH = fixture.dbPath;
	vi.resetModules();
});

afterEach(async () => {
	process.chdir(originalCwd);
	fixture.cleanup();
	await rm(cwdDir, { recursive: true, force: true });
});

/**
 * The form is handed to the handler directly rather than re-parsed out of a
 * serialized body: under the repo's jsdom environment `Request.formData()`
 * returns undici's `File`, which is not the `File` the route's `instanceof`
 * sees, so a round trip would test the environment instead of the route.
 * Everything below `request.formData()` — the whole point of this file — is
 * real.
 */
async function postUpload(file: File): Promise<Response> {
	const { POST } = await import(
		"../../../../routes/api/knowledge/upload/+server"
	);
	const body = new FormData();
	body.set("file", file);

	const request = {
		headers: new Headers({ "content-type": "multipart/form-data" }),
		signal: new AbortController().signal,
		formData: async () => body,
	};

	return (await POST({
		request,
		locals: { user: { id: USER_ID } },
		url: new URL("http://localhost/api/knowledge/upload"),
		params: {},
	} as never)) as Response;
}

function normalizedArtifactsFor(sourceArtifactId: string) {
	return fixture.db
		.select({ artifact: schema.artifacts })
		.from(schema.artifactLinks)
		.innerJoin(
			schema.artifacts,
			eq(schema.artifactLinks.artifactId, schema.artifacts.id),
		)
		.where(
			and(
				eq(schema.artifactLinks.relatedArtifactId, sourceArtifactId),
				eq(schema.artifactLinks.linkType, "derived_from"),
				eq(schema.artifacts.type, "normalized_document"),
			),
		)
		.all();
}

describe("upload route → ledger → worker → persisted normalized artifact", () => {
	it("extracts a direct-text upload inline and persists a real normalized artifact", async () => {
		const text = "Quarterly report\n\nRevenue was up.\n";
		const response = await postUpload(
			new File([text], "quarterly.txt", { type: "text/plain" }),
		);

		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			artifact: { id: string };
			normalizedArtifact: { id: string; contentText?: string } | null;
			promptReady: boolean;
			extraction: { status: string; intakeRoute: string };
		};

		expect(payload.extraction.intakeRoute).toBe("direct-text");
		expect(payload.extraction.status).toBe("succeeded");
		expect(payload.promptReady).toBe(true);
		expect(payload.normalizedArtifact).not.toBeNull();

		// The row is really in the database, not just in the response.
		const persisted = normalizedArtifactsFor(payload.artifact.id);
		expect(persisted).toHaveLength(1);
		expect(persisted[0]?.artifact.contentText).toContain("Revenue was up.");

		const [job] = fixture.db
			.select()
			.from(schema.documentExtractionJobs)
			.where(
				eq(schema.documentExtractionJobs.sourceArtifactId, payload.artifact.id),
			)
			.all();
		expect(job?.status).toBe("succeeded");
		expect(job?.normalizedArtifactId).toBe(persisted[0]?.artifact.id);

		const chunkCount = fixture.db
			.select()
			.from(schema.artifactChunks)
			.where(
				eq(schema.artifactChunks.artifactId, persisted[0]?.artifact.id ?? ""),
			)
			.all();
		// Small files bypass chunking by design; the row set must at least be
		// consistent with the artifact rather than belonging to a stale one.
		for (const chunk of chunkCount) {
			expect(chunk.userId).toBe(USER_ID);
		}
	});

	it("returns a queued job for a backend-route upload and the worker persists it later", async () => {
		// A real PDF header, so the magic-byte check admits the file.
		const bytes = new Uint8Array([
			0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3,
			0xcf, 0xd3, 0x0a,
		]);
		const response = await postUpload(
			new File([bytes], "scan.pdf", { type: "application/pdf" }),
		);

		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			artifact: { id: string };
			normalizedArtifact: unknown;
			promptReady: boolean;
			extraction: { status: string; intakeRoute: string; id: string };
		};

		// The request did not wait on a backend.
		expect(payload.extraction.intakeRoute).toBe("mineru");
		expect(payload.extraction.status).toBe("queued");
		expect(payload.normalizedArtifact).toBeNull();
		expect(payload.promptReady).toBe(false);

		const worker = await import("./worker-runner");
		const extractor = createFakeExtractor({
			steps: [
				{ kind: "succeed", text: "Scanned page one of the quarterly filing." },
			],
		});

		// No `persistResult`: the real `createNormalizedArtifactFromExtraction`
		// runs, which is the seam every other test replaces.
		const result = await worker.executeNextExtractionJob({
			workerId: `worker-${randomUUID()}`,
			resolveExtractor: () => extractor,
		});

		expect(result?.status).toBe("succeeded");

		const persisted = normalizedArtifactsFor(payload.artifact.id);
		expect(persisted).toHaveLength(1);
		expect(persisted[0]?.artifact.contentText).toBe(
			"Scanned page one of the quarterly filing.",
		);

		const [job] = fixture.db
			.select()
			.from(schema.documentExtractionJobs)
			.where(eq(schema.documentExtractionJobs.id, payload.extraction.id))
			.all();
		expect(job?.status).toBe("succeeded");
		expect(job?.normalizedArtifactId).toBe(persisted[0]?.artifact.id);

		// And the send gate now admits it.
		const { resolvePromptAttachmentArtifacts } = await import(
			"$lib/server/services/knowledge/store/attachments"
		);
		const resolved = await resolvePromptAttachmentArtifacts(USER_ID, [
			payload.artifact.id,
		]);
		expect(resolved.items[0]?.promptReady).toBe(true);
	});

	it("never leaves two normalized artifacts for one source document", async () => {
		const bytes = new Uint8Array([
			0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a,
		]);
		const response = await postUpload(
			new File([bytes], "twice.pdf", { type: "application/pdf" }),
		);
		const payload = (await response.json()) as {
			artifact: { id: string };
			extraction: { id: string };
		};

		const worker = await import("./worker-runner");
		const ledger = await import("./job-ledger");

		// Attempt 1 gets as far as persisting the artifact and is then torn out
		// from under itself — the shape of a crash during `indexing`, and of a
		// cancel that lands while the chunk inserts are still running.
		const first = createFakeExtractor({
			steps: [{ kind: "succeed", text: "First read." }],
		});
		await worker.executeNextExtractionJob({
			workerId: "worker-a",
			resolveExtractor: () => first,
			persistResult: async (params) => {
				const { createNormalizedArtifactFromExtraction } = await import(
					"./persist"
				);
				const artifact = await createNormalizedArtifactFromExtraction(params);
				// The claim disappears before the completion write lands.
				await ledger.cancelExtractionJob({
					userId: USER_ID,
					jobId: payload.extraction.id,
				});
				return artifact;
			},
		});

		expect(normalizedArtifactsFor(payload.artifact.id)).toHaveLength(1);

		// The user presses Retry on the canceled job and the document is read
		// again — which must refresh the one normalized artifact, not mint a
		// second one whose chunks then double every retrieval hit.
		await ledger.retryExtractionJob({
			userId: USER_ID,
			jobId: payload.extraction.id,
		});
		const second = createFakeExtractor({
			steps: [{ kind: "succeed", text: "Second read." }],
		});
		await worker.executeNextExtractionJob({
			workerId: "worker-b",
			resolveExtractor: () => second,
		});

		const persisted = normalizedArtifactsFor(payload.artifact.id);
		expect(persisted).toHaveLength(1);
		expect(persisted[0]?.artifact.contentText).toBe("Second read.");

		// And the ledger's answer must be the artifact the prompt pipeline reads.
		const [job] = fixture.db
			.select()
			.from(schema.documentExtractionJobs)
			.where(eq(schema.documentExtractionJobs.id, payload.extraction.id))
			.all();
		const { getNormalizedArtifactForSource } = await import(
			"$lib/server/services/knowledge/store/core"
		);
		const forPrompt = await getNormalizedArtifactForSource(
			USER_ID,
			payload.artifact.id,
		);
		expect(forPrompt?.id).toBe(job?.normalizedArtifactId);
		expect(forPrompt?.contentText).toBe("Second read.");
	});

	// F6. `normalized_artifact_id` used to be ON DELETE SET NULL, which left a
	// `succeeded` job pointing at nothing: the partial UNIQUE index made a fresh
	// enqueue reuse that row, and retry is legal only from failed/canceled, so
	// the document could never be read again. The result and the record of
	// producing it now go together.
	it("deletes the job with its result artifact so the document can be re-extracted", async () => {
		const bytes = new Uint8Array([
			0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a,
		]);
		const response = await postUpload(
			new File([bytes], "lost-result.pdf", { type: "application/pdf" }),
		);
		const payload = (await response.json()) as {
			artifact: { id: string };
			extraction: { id: string };
		};

		const worker = await import("./worker-runner");
		await worker.executeNextExtractionJob({
			workerId: "worker-before-delete",
			resolveExtractor: () =>
				createFakeExtractor({ steps: [{ kind: "succeed", text: "First read." }] }),
		});

		const first = normalizedArtifactsFor(payload.artifact.id);
		expect(first).toHaveLength(1);
		const normalizedId = first[0]?.artifact.id as string;

		const attemptsBefore = fixture.db
			.select()
			.from(schema.documentExtractionJobAttempts)
			.where(
				eq(schema.documentExtractionJobAttempts.jobId, payload.extraction.id),
			)
			.all();
		expect(attemptsBefore.length).toBeGreaterThan(0);

		const { hardDeleteArtifactsForUser } = await import(
			"$lib/server/services/knowledge/store/cleanup"
		);
		await hardDeleteArtifactsForUser(USER_ID, [normalizedId]);

		// The job row went with it, and so did its attempts.
		expect(
			fixture.db
				.select()
				.from(schema.documentExtractionJobs)
				.where(eq(schema.documentExtractionJobs.id, payload.extraction.id))
				.all(),
		).toHaveLength(0);
		expect(
			fixture.db
				.select()
				.from(schema.documentExtractionJobAttempts)
				.where(
					eq(schema.documentExtractionJobAttempts.jobId, payload.extraction.id),
				)
				.all(),
		).toHaveLength(0);

		// Past the legacy grace window, so the read model calls the job-less
		// source failed rather than "probably still enqueueing".
		fixture.db
			.update(schema.artifacts)
			.set({ createdAt: new Date(Date.now() - 60 * 60 * 1000) })
			.where(eq(schema.artifacts.id, payload.artifact.id))
			.run();

		// The source survives, so the read model answers with a synthesised
		// legacy failure the Retry button can act on.
		const { getExtractionJobForArtifact } = await import("./read-model");
		const legacy = await getExtractionJobForArtifact({
			userId: USER_ID,
			artifactId: payload.artifact.id,
		});
		expect(legacy?.legacy).toBe(true);
		expect(legacy?.status).toBe("failed");
		expect(legacy?.retryable).toBe(true);
		expect(legacy?.error?.code).toBe("legacy_unknown");

		const { POST: retry } = await import(
			"../../../../routes/api/knowledge/extraction/[artifactId]/retry/+server"
		);
		const retryResponse = (await retry({
			locals: { user: { id: USER_ID } },
			params: { artifactId: payload.artifact.id },
		} as never)) as Response;
		expect(retryResponse.status).toBe(200);

		await worker.executeNextExtractionJob({
			workerId: "worker-after-delete",
			resolveExtractor: () =>
				createFakeExtractor({
					steps: [{ kind: "succeed", text: "Second read." }],
				}),
		});

		const after = normalizedArtifactsFor(payload.artifact.id);
		expect(after).toHaveLength(1);
		expect(after[0]?.artifact.contentText).toBe("Second read.");
	});
});
