// The whole phase, end to end, with nothing faked below the HTTP handler
// except MinerU itself — and MinerU is a real server on a real socket
// replaying the recorded 4.0.4 fixtures.
//
//   POST /api/knowledge/upload
//     -> upload-intake        (magic bytes, storage, artifact row)
//     -> the extraction ledger (a queued job, one per source artifact)
//     -> the worker            (claim, heartbeat, progress, verdict)
//     -> extractors/mineru4    (capabilities, upload, job, poll, download)
//     -> mineru/result         (zip -> blocks -> prompt markdown -> pages)
//     -> mineru/bundle         (normalized.md, pages.json, images/)
//     -> extraction/persist    (normalized artifact + structured metadata)
//     -> task-state/chunk-sync (rows carrying page_start / page_end)
//     -> task-state/artifacts  (the snippet the MODEL sees, with "[p. N]")
//
// Every other test of this phase cuts one of those seams: the extractor tests
// stub the ledger, `mineru/integration.test.ts` always passes a fake
// `persistResult`, and `upload-route-to-artifact.integration.test.ts` uses a
// fake extractor. Each is a reasonable unit test, and not one of them would
// notice if the pieces stopped fitting together — which is the failure mode of
// a phase written by six agents in parallel.
//
// The citation at the end is the point. It is the only assertion in the repo
// that a page number survives all nine hops, and it is the thing a user would
// see as "the model cited a page that does not exist" if any of them shifted.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
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
} from "./testing/fake-server";

vi.mock("$lib/server/auth/hooks", () => ({ requireAuth: vi.fn() }));

const USER_ID = "mineru-e2e-user";

let fixture: LedgerFixture;
let server: FakeMineruServer;
let cwdDir: string;
let originalCwd: string;

beforeEach(async () => {
	fixture = createLedgerFixture("mineru-e2e");
	fixture.seedUser(USER_ID);
	server = await createFakeMineruServer({ fixtureInput: "pdf" });

	// `knowledgeUserDir`, the bundle directory and the worker's source lookup
	// all hang off `process.cwd()`, so the test owns a throwaway one rather
	// than writing into the checkout's `data/`.
	cwdDir = await mkdtemp(join(tmpdir(), "alfyai-mineru-e2e-"));
	originalCwd = process.cwd();
	process.chdir(cwdDir);

	process.env.DATABASE_PATH = fixture.dbPath;
	process.env.MINERU_API_URL = server.baseUrl;
	process.env.MINERU_API_KEY = "";
	process.env.MINERU_POLL_MIN_MS = "250";
	process.env.MINERU_POLL_MAX_MS = "1000";
	process.env.MINERU_REQUEST_TIMEOUT_MS = "5000";
	process.env.MINERU_TRANSFER_TIMEOUT_MS = "10000";
	process.env.MINERU_CAPABILITIES_TTL_MS = "0";
	// Every recorded fixture renders to under 1 400 characters, so at the
	// 5 000-character production default NO fixture would produce a chunk row
	// at all and the citation path would be untestable against real data.
	// Lowered here, and only here.
	process.env.SMALL_FILE_THRESHOLD_CHARS = "1";

	vi.resetModules();
});

afterEach(async () => {
	process.chdir(originalCwd);
	await server?.close();
	fixture.cleanup();
	await rm(cwdDir, { recursive: true, force: true });
	process.env.SMALL_FILE_THRESHOLD_CHARS = "";
	vi.restoreAllMocks();
});

/**
 * The form is handed to the handler directly rather than re-parsed out of a
 * serialized body: under the repo's jsdom environment `Request.formData()`
 * returns undici's `File`, which is not the `File` the route's `instanceof`
 * sees. Everything below `request.formData()` is real.
 */
async function postUpload(file: File): Promise<Response> {
	const { POST } = await import(
		"../../../../routes/api/knowledge/upload/+server"
	);
	const body = new FormData();
	body.set("file", file);
	return (await POST({
		request: {
			headers: new Headers({ "content-type": "multipart/form-data" }),
			signal: new AbortController().signal,
			formData: async () => body,
		},
		locals: { user: { id: USER_ID } },
		url: new URL("http://localhost/api/knowledge/upload"),
		params: {},
	} as never)) as Response;
}

describe("upload → MinerU 4 → chunks with pages → a cited prompt snippet", () => {
	it("carries a page number all the way from the zip to the model's context", async () => {
		const pdf = await readFile(join(MINERU_FIXTURE_ROOT, "pdf", "sample.pdf"));

		// 1. The upload returns as soon as the bytes are stored.
		const response = await postUpload(
			new File([pdf], "sample.pdf", { type: "application/pdf" }),
		);
		expect(response.status).toBe(200);
		const payload = (await response.json()) as {
			artifact: { id: string };
			promptReady: boolean;
			extraction: { status: string; intakeRoute: string };
		};
		expect(payload.extraction.intakeRoute).toBe("mineru");
		expect(payload.extraction.status).toBe("queued");
		expect(payload.promptReady).toBe(false);

		// 2. The worker runs the REAL extractor against the fake server. No
		//    `persistResult` override: `persist.ts` is in the path too.
		const worker = await import(
			"$lib/server/services/extraction/worker-runner"
		);
		const outcome = await worker.executeNextExtractionJob({
			workerId: "mineru-e2e",
		});
		expect(outcome).toEqual({
			jobId: expect.any(String),
			status: "succeeded",
		});

		// The protocol really happened, in order.
		const paths = server.requests.map(
			(entry) => `${entry.method} ${entry.path}`,
		);
		expect(paths).toContain("GET /v1/health");
		expect(paths).toContain("POST /v1/uploads");
		expect(paths).toContain("POST /v1/parse/jobs");
		expect(paths.some((path) => path.startsWith("GET /v1/files/"))).toBe(true);

		// 3. A real normalized artifact, carrying the structured metadata.
		const [link] = fixture.db
			.select({ artifact: schema.artifacts })
			.from(schema.artifactLinks)
			.innerJoin(
				schema.artifacts,
				eq(schema.artifactLinks.artifactId, schema.artifacts.id),
			)
			.where(
				and(
					eq(schema.artifactLinks.relatedArtifactId, payload.artifact.id),
					eq(schema.artifactLinks.linkType, "derived_from"),
					eq(schema.artifacts.type, "normalized_document"),
				),
			)
			.all();
		const normalized = link?.artifact;
		expect(normalized).toBeDefined();
		const metadata = JSON.parse(normalized?.metadataJson ?? "{}") as Record<
			string,
			unknown
		>;
		expect(metadata.extractionProducer).toBe("mineru");
		// `extensions.mineru.tier`, not the job's tier — the job's lies.
		expect(metadata.extractionTier).toBe("basic");
		expect(metadata.pageCount).toBe(3);
		expect(metadata.pageCountKind).toBe("physical");

		// 4. The bundle is on disk, under the OWNER's directory.
		const { readMineruParseManifest, readMineruPageIndex } = await import(
			"./bundle"
		);
		const manifest = await readMineruParseManifest(
			USER_ID,
			payload.artifact.id,
		);
		expect(manifest?.normalizedArtifactId).toBe(normalized?.id);
		expect(manifest?.pageCountKind).toBe("physical");
		// The page index is the text that was actually persisted, not a parse
		// ahead of it.
		const pages = await readMineruPageIndex(USER_ID, payload.artifact.id, {
			expectedMarkdown: normalized?.contentText ?? "",
		});
		expect(pages).not.toBeNull();
		expect(pages?.length).toBe(3);

		// 5. Chunk rows carry a page range.
		const chunks = fixture.db
			.select()
			.from(schema.artifactChunks)
			.where(eq(schema.artifactChunks.artifactId, normalized?.id ?? ""))
			.all();
		expect(chunks.length).toBeGreaterThan(0);
		for (const chunk of chunks) {
			expect(chunk.pageStart).not.toBeNull();
			expect(chunk.pageEnd).not.toBeNull();
			expect(chunk.pageStart as number).toBeGreaterThanOrEqual(1);
			expect(chunk.pageEnd as number).toBeGreaterThanOrEqual(
				chunk.pageStart as number,
			);
			expect(chunk.pageEnd as number).toBeLessThanOrEqual(3);
		}

		// 6. And the snippet the MODEL sees names the page.
		const { getPromptArtifactSnippets } = await import(
			"$lib/server/services/task-state/artifacts"
		);
		const { mapArtifact } = await import(
			"$lib/server/services/knowledge/store/core"
		);
		const snippets = await getPromptArtifactSnippets({
			userId: USER_ID,
			artifacts: [mapArtifact(normalized as never)],
			query: "ALFA",
		});
		const snippet = snippets.get(normalized?.id ?? "") ?? "";
		expect(snippet).toMatch(/\[p\. \d/);
		// The cited page is one the document really has.
		const cited = [...snippet.matchAll(/\[p\. (\d+)(?:–(\d+))?\]/g)].flatMap(
			(match) => [Number(match[1]), Number(match[2] ?? match[1])],
		);
		expect(cited.length).toBeGreaterThan(0);
		for (const page of cited) {
			expect(page).toBeGreaterThanOrEqual(1);
			expect(page).toBeLessThanOrEqual(3);
		}
	});
});
