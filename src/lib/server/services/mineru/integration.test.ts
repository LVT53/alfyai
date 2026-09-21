// MinerU 4, end to end: the real ledger, the real worker, the real extractor
// registry and an in-process V1 server on a real socket.
//
// Nothing is stubbed between `executeNextExtractionJob` and the wire except the
// persist sink, which belongs to a different slice. The extractor is NOT passed
// in: the worker resolves it through `extractors/registry.ts`, so this file also
// proves the registry flip. The configuration arrives the way it does in
// production — through the environment, read by `config-store` — which is why
// every test re-imports the module graph after setting it.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createLedgerFixture,
	type LedgerFixture,
} from "$lib/server/services/extraction/testing/ledger-fixtures";
import type { Artifact } from "$lib/server/services/knowledge/types";
import {
	createFakeMineruServer,
	type FakeMineruServer,
	type FakeMineruServerOptions,
	MINERU_FIXTURE_ROOT,
} from "./testing/fake-server";

type Worker = typeof import("$lib/server/services/extraction/worker-runner");
type Ledger = typeof import("$lib/server/services/extraction/job-ledger");
type Capabilities = typeof import("./capabilities");

/** The nine recorded inputs, with the file each fixture directory carries. */
const FIXTURE_INPUTS: ReadonlyArray<[string, string, string]> = [
	["pdf", "sample.pdf", "application/pdf"],
	[
		"docx",
		"sample.docx",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	],
	[
		"xlsx",
		"sample.xlsx",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	],
	[
		"pptx",
		"sample.pptx",
		"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	],
	["html", "sample.html", "text/html"],
	["csv", "sample.csv", "text/csv"],
	["epub", "sample.epub", "application/epub+zip"],
	["png", "sample.png", "image/png"],
	["jpg", "sample.jpg", "image/jpeg"],
];

let fixture: LedgerFixture;
let server: FakeMineruServer;
let worker: Worker;
let ledger: Ledger;
let capabilities: Capabilities;
let storageDir: string;
let userId: string;
/** Every `data/knowledge/<userId>` this test wrote, removed in afterEach. */
const writtenKnowledgeDirs = new Set<string>();

const persisted: Array<Record<string, unknown>> = [];

async function boot(
	options: FakeMineruServerOptions = {},
	env: Record<string, string> = {},
): Promise<void> {
	server = await createFakeMineruServer(options);

	process.env.DATABASE_PATH = fixture.dbPath;
	process.env.MINERU_API_URL = server.baseUrl;
	process.env.MINERU_API_KEY = env.MINERU_API_KEY ?? "";
	// The floor the admin registry clamps to. Two or three polls per job.
	process.env.MINERU_POLL_MIN_MS = "250";
	process.env.MINERU_POLL_MAX_MS = "1000";
	process.env.MINERU_REQUEST_TIMEOUT_MS = "5000";
	process.env.MINERU_TRANSFER_TIMEOUT_MS = "10000";
	process.env.MINERU_CAPABILITIES_TTL_MS = "0";
	for (const [key, value] of Object.entries(env)) process.env[key] = value;

	await reimportAt(server.baseUrl, env.MINERU_API_URL);
}

/**
 * Re-reads the whole module graph against a (possibly different) backend URL.
 *
 * The configuration is captured at module load, so "the backend moved" and
 * "the backend came back" are both a re-import. The ledger rows live in the
 * SQLite fixture and survive it, which is exactly what lets one test watch a
 * job wait out an outage and then finish.
 */
async function reimportAt(
	baseUrl: string,
	override?: string | undefined,
): Promise<void> {
	process.env.MINERU_API_URL = override ?? baseUrl;
	vi.resetModules();
	worker = await import("$lib/server/services/extraction/worker-runner");
	ledger = await import("$lib/server/services/extraction/job-ledger");
	capabilities = await import("./capabilities");
	capabilities.resetMineruCapabilitiesCacheForTests();
	worker.resetExtractionWorkerForTests();
}

/** The persist sink P4-B owns. Here it only records what reached it. */
function persistSink() {
	return (async (params: Record<string, unknown>) => {
		persisted.push(params);
		const id = fixture.seedArtifact({
			userId: params.userId as string,
			type: "normalized_document",
			name: `normalized-${randomUUID()}.md`,
		});
		return { id, metadata: {} } as unknown as Artifact;
	}) as never;
}

async function seedJob(
	options: { fixtureInput?: string; file?: string; mimeType?: string } = {},
) {
	const input = options.fixtureInput ?? "pdf";
	const file = options.file ?? `sample.${input}`;
	const bytes = await readFile(join(MINERU_FIXTURE_ROOT, input, file));
	const absolute = join(storageDir, `${randomUUID()}-${file}`);
	await writeFile(absolute, bytes);

	const artifactId = randomUUID();
	fixture.seedArtifact({
		id: artifactId,
		userId,
		name: file,
		mimeType: options.mimeType ?? "application/octet-stream",
		sizeBytes: bytes.byteLength,
		storagePath: relative(process.cwd(), absolute),
	});

	const { job } = await ledger.enqueueExtractionJob({
		userId,
		conversationId: null,
		origin: "upload",
		intakeRoute: "mineru",
		fileName: file,
		mimeType: options.mimeType ?? "application/octet-stream",
		sizeBytes: bytes.byteLength,
		sourceArtifactId: artifactId,
	});
	writtenKnowledgeDirs.add(join(process.cwd(), "data", "knowledge", userId));
	return { jobId: job.id, artifactId };
}

function run(overrides: Record<string, unknown> = {}) {
	return worker.executeNextExtractionJob({
		workerId: "mineru4-worker",
		persistResult: persistSink(),
		...overrides,
	});
}

function clearBackoffGates(): void {
	fixture.sqlite
		.prepare("UPDATE document_extraction_jobs SET next_attempt_at = NULL")
		.run();
}

function countRequests(method: string, path: string): number {
	return server.requests.filter(
		(entry) => entry.method === method && entry.path === path,
	).length;
}

beforeEach(async () => {
	persisted.length = 0;
	userId = `u${randomUUID().replace(/-/g, "")}`;
	fixture = createLedgerFixture("mineru4-integration");
	fixture.seedUser(userId);
	storageDir = join(tmpdir(), `alfyai-m4int-${randomUUID()}`);
	await mkdir(storageDir, { recursive: true });
});

afterEach(async () => {
	await server?.close();
	fixture.cleanup();
	await rm(storageDir, { recursive: true, force: true });
	for (const dir of writtenKnowledgeDirs) {
		await rm(dir, { recursive: true, force: true });
	}
	writtenKnowledgeDirs.clear();
	vi.restoreAllMocks();
});

describe("every recorded input reaches a normalized artifact", () => {
	it.each(
		FIXTURE_INPUTS,
	)("%s parses to non-empty text through the real worker", async (input, file, mimeType) => {
		await boot({ fixtureInput: input });
		const { jobId, artifactId } = await seedJob({
			fixtureInput: input,
			file,
			mimeType,
		});

		expect(await run()).toEqual({ jobId, status: "succeeded" });

		expect(persisted).toHaveLength(1);
		const call = persisted[0];
		expect(String(call.text).length).toBeGreaterThan(0);
		expect(call.mimeType).toBe("text/markdown");
		expect(call.normalizedName).toBe(`${file.split(".")[0]}.md`);
		expect(call.sourceArtifactId).toBe(artifactId);

		// The structured payload P4-B reads, flat plus the bundle manifest.
		const structured = call.structured as Record<string, unknown>;
		expect(structured.parserVersion).toBe("mineru4/1");
		expect(structured.markdown).toBe(call.text);
		expect(Array.isArray(structured.pages)).toBe(true);
		expect(structured.bundle).not.toBeNull();

		const row = await ledger.getExtractionJobRow(jobId);
		expect(row?.status).toBe("succeeded");
		expect(row?.errorCode).toBeNull();
	});
});

describe("direct text does not care what MinerU is", () => {
	it("still succeeds while MINERU_API_URL points at something that is not MinerU 4", async () => {
		// The consequence of having exactly one protocol: a deployment still
		// aimed at a 3.x server must fail the MinerU route CLEARLY and leave the
		// direct-text route completely untouched. The registry, not the backend,
		// decides which one a file takes.
		await boot({}, { MINERU_API_URL: "http://127.0.0.1:9/not-mineru4" });

		const absolute = join(storageDir, "notes.txt");
		await writeFile(absolute, "# Notes\n\nPlain text needs no backend.\n");
		const artifactId = randomUUID();
		fixture.seedArtifact({
			id: artifactId,
			userId,
			name: "notes.txt",
			mimeType: "text/plain",
			sizeBytes: 38,
			storagePath: relative(process.cwd(), absolute),
		});
		const { job } = await ledger.enqueueExtractionJob({
			userId,
			conversationId: null,
			origin: "upload",
			intakeRoute: "direct-text",
			fileName: "notes.txt",
			mimeType: "text/plain",
			sizeBytes: 38,
			sourceArtifactId: artifactId,
		});

		expect(await run()).toEqual({ jobId: job.id, status: "succeeded" });
		expect(persisted[0].text).toContain("Plain text needs no backend.");
		// Not one request left the process.
		expect(server.requests).toEqual([]);
	});
});

describe("a slow job walks the status ladder", () => {
	it("reports uploading, parsing and downloading before it settles", async () => {
		await boot({ parseDelayMs: 600 });
		const { jobId } = await seedJob();

		const seen: string[] = [];
		const watcher = setInterval(() => {
			const row = fixture.sqlite
				.prepare("SELECT status FROM document_extraction_jobs WHERE id = ?")
				.get(jobId) as { status: string } | undefined;
			if (row && seen.at(-1) !== row.status) seen.push(row.status);
		}, 20);
		watcher.unref?.();

		expect(await run()).toEqual({ jobId, status: "succeeded" });
		clearInterval(watcher);

		// The sampler races the worker's last write, so the terminal status is
		// read from the row rather than from the sample: what the samples prove
		// is that the job was VISIBLE as parsing while it was parsing, which is
		// the whole point of reporting a phase at all.
		expect(seen).toContain("parsing");
		expect(seen.indexOf("uploading")).toBeLessThan(seen.indexOf("parsing"));
		expect((await ledger.getExtractionJobRow(jobId))?.status).toBe("succeeded");

		// A slow job really was polled more than once.
		expect(
			server.requests.filter(
				(entry) =>
					entry.method === "GET" && entry.path.startsWith("/v1/parse/jobs/"),
			).length,
		).toBeGreaterThan(1);
	});
});

describe("mapped failures reach the ledger row", () => {
	it("auth_failed on a wrong key: once, and only the USER may retry", async () => {
		await boot({ apiKey: "the-real-key" }, { MINERU_API_KEY: "wrong-key" });
		const { jobId } = await seedJob();

		expect(await run()).toEqual({ jobId, status: "failed" });

		const row = await ledger.getExtractionJobRow(jobId);
		expect(row?.errorCode).toBe("auth_failed");
		// Not auto-retried — the attempt table proves it, one row — but offered
		// to the user, because the cure is an admin fixing the key and then
		// somebody pressing the button.
		expect(row?.retryable).toBe(true);
		expect(await ledger.listExtractionJobAttempts(jobId)).toHaveLength(1);

		// `/v1/health` stays PUBLIC under `--api-key`, so a wrong key cannot be
		// detected by the capability read: the probe answers "reachable, 4.0.4,
		// tiers unknown" and the 401 surfaces at the first authenticated call.
		// That is one create, and no bytes: the PUT never happens.
		expect(countRequests("POST", "/v1/uploads")).toBe(1);
		expect(server.requests.filter((entry) => entry.method === "PUT")).toEqual(
			[],
		);
	});

	it("tier_unavailable when a re-extract asks for a tier the server lacks", async () => {
		await boot({ tiers: ["flash", "basic"] });
		const bytes = await readFile(
			join(MINERU_FIXTURE_ROOT, "pdf", "sample.pdf"),
		);
		const absolute = join(storageDir, "reextract.pdf");
		await writeFile(absolute, bytes);
		const artifactId = randomUUID();
		fixture.seedArtifact({
			id: artifactId,
			userId,
			name: "reextract.pdf",
			storagePath: relative(process.cwd(), absolute),
		});
		const { job } = await ledger.enqueueExtractionJob({
			userId,
			conversationId: null,
			origin: "upload",
			intakeRoute: "mineru",
			fileName: "reextract.pdf",
			mimeType: "application/pdf",
			sizeBytes: bytes.byteLength,
			sourceArtifactId: artifactId,
			hints: { tier: "standard" },
		});

		expect(await run()).toEqual({ jobId: job.id, status: "failed" });

		const row = await ledger.getExtractionJobRow(job.id);
		expect(row?.errorCode).toBe("tier_unavailable");
		expect(row?.retryable).toBe(true);
		expect(countRequests("POST", "/v1/uploads")).toBe(0);
	});

	it("job_failed and a retry for a per-file failure inside a completed job", async () => {
		await boot({ jobOutcome: "file-failed" });
		const { jobId } = await seedJob();

		expect(await run()).toEqual({ jobId, status: "queued" });

		const row = await ledger.getExtractionJobRow(jobId);
		expect(row?.errorCode).toBe("job_failed");
		expect(row?.status).toBe("queued");
	});

	it("job_failed for a partial job", async () => {
		await boot({ jobOutcome: "partial" });
		const { jobId } = await seedJob();

		expect(await run()).toEqual({ jobId, status: "queued" });
		expect((await ledger.getExtractionJobRow(jobId))?.errorCode).toBe(
			"job_failed",
		);
	});

	it("protocol for a completed job with no zip", async () => {
		await boot({ jobOutcome: "completed-without-zip" });
		const { jobId } = await seedJob();

		expect(await run()).toEqual({ jobId, status: "queued" });
		expect((await ledger.getExtractionJobRow(jobId))?.errorCode).toBe(
			"protocol",
		);
	});
});

describe("cancel while parsing", () => {
	it("DELETEs the remote job, settles canceled and leaves no temp directory", async () => {
		await boot({ neverFinish: true });
		const { jobId } = await seedJob();

		const running = run({ heartbeatMs: 100 });
		await vi.waitFor(async () => {
			expect((await ledger.getExtractionJobRow(jobId))?.status).toBe("parsing");
		});
		// The handle exists before the first poll, which is what makes the remote
		// cancel possible at all.
		expect(
			(await ledger.getExtractionJobRow(jobId))?.remoteHandleJson,
		).toContain("job_");

		await ledger.cancelExtractionJob({ userId, jobId });
		expect(await running).toEqual({ jobId, status: "canceled" });

		await vi.waitFor(() => {
			expect(server.requests.some((entry) => entry.method === "DELETE")).toBe(
				true,
			);
		});
		const row = await ledger.getExtractionJobRow(jobId);
		expect(row?.status).toBe("canceled");
		expect(persisted).toHaveLength(0);
		// Temp-directory cleanup is asserted in `extractors/mineru4.test.ts`,
		// which can give the extractor a private root: counting entries in the
		// shared OS temp directory from here would race every other test file.
	});
});

describe("a worker that died mid-parse", () => {
	it("resumes the stored handle instead of uploading a second time", async () => {
		await boot({ neverFinish: true });
		const { jobId } = await seedJob();

		// `heartbeatMs` long enough that this attempt never notices it lost the
		// claim: that is what a killed process looks like from the ledger's side.
		const orphaned = run({ heartbeatMs: 600_000 }).catch(() => null);
		await vi.waitFor(async () => {
			expect(
				(await ledger.getExtractionJobRow(jobId))?.remoteHandleJson,
			).not.toBeNull();
		});
		const handleJson = (await ledger.getExtractionJobRow(jobId))
			?.remoteHandleJson;

		await ledger.recoverStaleExtractionAttempts({
			staleBefore: new Date(Date.now() + 60_000),
			maxAttempts: 3,
			retryBaseMs: 2000,
			retryMaxMs: 60000,
			outageWindowMs: 1_800_000,
		});
		clearBackoffGates();

		const uploadsBefore = countRequests("POST", "/v1/uploads");
		const jobsBefore = countRequests("POST", "/v1/parse/jobs");
		expect(uploadsBefore).toBe(1);

		// The remote job can finish now; the restarted worker must pick up the
		// SAME one.
		server.setOptions({ neverFinish: false });
		expect(await run({ workerId: "worker-restarted" })).toEqual({
			jobId,
			status: "succeeded",
		});

		expect(countRequests("POST", "/v1/uploads")).toBe(uploadsBefore);
		expect(countRequests("POST", "/v1/parse/jobs")).toBe(jobsBefore);
		expect(
			countRequests("PUT", `/v1/uploads/upload_000000000001/content`),
		).toBe(1);

		const resumedJobId = JSON.parse(handleJson as string).remoteJobId;
		expect(
			server.requests.filter(
				(entry) =>
					entry.method === "GET" &&
					entry.path === `/v1/parse/jobs/${resumedJobId}`,
			).length,
		).toBeGreaterThan(1);

		await orphaned;
	});

	it("does not DELETE the remote job when a stale sweep takes the claim", async () => {
		// The dangerous variant of the test above: here the running attempt DOES
		// notice it lost the claim, on its next heartbeat. It used to read that
		// abort as a cancel and DELETE the very job the new claimant had just
		// been handed — so a stale sweep during a slow parse destroyed the remote
		// work the stored handle exists to resume, and the next attempt paid for
		// a second upload and a second parse.
		await boot({ neverFinish: true });
		const { jobId } = await seedJob();

		const orphaned = run({ heartbeatMs: 100 }).catch(() => null);
		await vi.waitFor(async () => {
			expect(
				(await ledger.getExtractionJobRow(jobId))?.remoteHandleJson,
			).not.toBeNull();
		});
		const handleJson = (await ledger.getExtractionJobRow(jobId))
			?.remoteHandleJson as string;
		const remoteJobId = JSON.parse(handleJson).remoteJobId as string;

		// Another worker reclaims the attempt out from under the running one.
		await ledger.recoverStaleExtractionAttempts({
			staleBefore: new Date(Date.now() + 60_000),
			maxAttempts: 3,
			retryBaseMs: 2000,
			retryMaxMs: 60000,
			outageWindowMs: 1_800_000,
		});

		// Give the losing attempt time to observe the loss and unwind.
		expect(await orphaned).toBeNull();
		expect(server.requests.some((entry) => entry.method === "DELETE")).toBe(
			false,
		);
		expect(server.jobs.get(remoteJobId)?.status).not.toBe("canceled");

		// And the handle the next attempt needs is still on the row.
		const row = await ledger.getExtractionJobRow(jobId);
		expect(row?.remoteHandleJson).toContain(remoteJobId);
		expect(row?.status).not.toBe("canceled");
		expect(row?.status).not.toBe("failed");
	});
});

describe("a MinerU that forgot every id", () => {
	it("re-uploads by sha256 and finishes, without a second PUT", async () => {
		await boot({ parseDelayMs: 900, restartAfterMs: 350 });
		const { jobId } = await seedJob();

		expect(await run()).toEqual({ jobId, status: "succeeded" });

		// Two upload creates: the first real one, the second the dedupe probe
		// that recovered it. One PUT: the bytes outlived the identifiers (D7).
		expect(countRequests("POST", "/v1/uploads")).toBe(2);
		expect(
			server.requests.filter((entry) => entry.method === "PUT"),
		).toHaveLength(1);
		expect(countRequests("POST", "/v1/parse/jobs")).toBe(2);
		expect(persisted).toHaveLength(1);
		expect(await ledger.listExtractionJobAttempts(jobId)).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Ruling 1: an outage is not evidence against the document
// ---------------------------------------------------------------------------

describe("a backend that is not answering", () => {
	/**
	 * The live failure, reproduced: `MAX_ATTEMPTS 3` with a 2 s base backoff
	 * tolerates about ten seconds of downtime. A MinerU restart took 54 s and
	 * the job was permanently failed 37 s before the backend was back; with
	 * MinerU stopped, a job was terminal in 10 s and never self-healed.
	 *
	 * Date is faked so three minutes pass in milliseconds; the sockets, the
	 * server and the timers are all real.
	 */
	it("waits out a three-minute outage and then finishes on its own", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const startedAtMs = Date.UTC(2026, 8, 20, 9, 0, 0);
		vi.setSystemTime(startedAtMs);

		try {
			// A port nothing is listening on: `fetch` fails with ECONNREFUSED,
			// which is the transport failure a stopped MinerU produces.
			const dead = await createFakeMineruServer();
			const deadUrl = dead.baseUrl;
			await dead.close();

			await boot({}, { MINERU_API_URL: deadUrl });
			const { jobId, artifactId } = await seedJob();

			let waits = 0;
			while (Date.now() - startedAtMs < 180_000) {
				expect(await run()).toEqual({ jobId, status: "queued" });
				waits += 1;

				const row = await ledger.getExtractionJobRow(jobId);
				expect(row?.status).toBe("queued");
				expect(row?.errorCode).toBe("unavailable");
				// The DTO has to say so while it waits, or the chip shows a
				// cheerful "Waiting to be read" for half an hour.
				const dto = await (
					await import("$lib/server/services/extraction/read-model")
				).getExtractionJobForArtifact({ userId, artifactId });
				expect(dto?.status).toBe("queued");
				expect(dto?.error?.code).toBe("unavailable");
				expect(dto?.nextAttemptAt).toBeGreaterThan(Date.now());
				// Not one of the document's three attempts was spent.
				expect(dto?.attemptCount).toBe(0);

				const gate = row?.nextAttemptAt?.getTime();
				expect(gate).toBeGreaterThan(Date.now());
				// Nothing is claimable before the gate: the wait is real.
				expect(await run()).toBeNull();
				vi.setSystemTime(gate as number);
			}

			// The old budget would have been spent after three.
			expect(waits).toBeGreaterThan(3);
			expect(
				(await ledger.getExtractionJobRow(jobId))?.status,
			).toBe("queued");
			// The message is the code's, not undici's.
			expect((await ledger.getExtractionJobRow(jobId))?.errorMessage).not.toContain(
				"fetch failed",
			);

			// The backend comes back. No user action, no second upload: the same
			// job row, the same bytes.
			await reimportAt(server.baseUrl);
			expect(await run()).toEqual({ jobId, status: "succeeded" });
			expect(persisted).toHaveLength(1);
			expect(countRequests("POST", "/v1/uploads")).toBe(1);
			expect(countRequests("POST", "/v1/parse/jobs")).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

// ---------------------------------------------------------------------------
// Ruling 4: a user cancel, and exactly one DELETE
// ---------------------------------------------------------------------------

describe("a user cancel", () => {
	it("sends exactly one DELETE, and a later Retry starts a NEW remote job", async () => {
		await boot({ neverFinish: true });
		const { jobId } = await seedJob();

		const running = run({ heartbeatMs: 100 });
		await vi.waitFor(async () => {
			expect(
				(await ledger.getExtractionJobRow(jobId))?.remoteHandleJson,
			).toContain("job_");
		});
		const firstRemoteJobId = JSON.parse(
			(await ledger.getExtractionJobRow(jobId))?.remoteHandleJson ?? "{}",
		).remoteJobId as string;

		await ledger.cancelExtractionJob({ userId, jobId });
		expect(await running).toEqual({ jobId, status: "canceled" });

		// ONE. The extractor's own abort path issues it; the worker used to
		// issue a second one on top, which the server answers 409.
		const deletes = server.requests.filter(
			(entry) => entry.method === "DELETE",
		);
		expect(deletes.map((entry) => entry.path)).toEqual([
			`/v1/parse/jobs/${firstRemoteJobId}`,
		]);
		expect(server.jobs.get(firstRemoteJobId)?.status).toBe("canceled");

		// The handle is gone with it. Keeping it meant a later Retry resumed a
		// job the backend had thrown away: `getJob` answers `canceled`, which
		// the error table reads as "canceled by someone else" — a `job_failed`
		// the user never caused, on a document that parses perfectly fresh.
		const canceled = await ledger.getExtractionJobRow(jobId);
		expect(canceled?.status).toBe("canceled");
		expect(canceled?.remoteHandleJson).toBeNull();

		server.setOptions({ neverFinish: false });
		server.resetLog();
		await ledger.retryExtractionJob({ userId, jobId });
		expect(await run()).toEqual({ jobId, status: "succeeded" });

		// A second remote job, and not one request to the deleted one.
		expect(countRequests("POST", "/v1/parse/jobs")).toBe(1);
		expect(
			server.requests.filter((entry) =>
				entry.path.includes(firstRemoteJobId),
			),
		).toEqual([]);
	});
});

describe("the API key", () => {
	it("is sent to MinerU's own origin only, and never reaches a log or a row", async () => {
		const key = "integration-secret-key";
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const error = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		await boot({ apiKey: key }, { MINERU_API_KEY: key });
		const { jobId } = await seedJob();

		expect(await run()).toEqual({ jobId, status: "succeeded" });

		const carried = server.requests.filter(
			(entry) => entry.headers.authorization === `Bearer ${key}`,
		);
		expect(carried.length).toBeGreaterThan(0);
		for (const entry of carried) {
			expect(entry.headers.host).toBe(`127.0.0.1:${server.port}`);
		}
		// /v1/health stays public under --api-key, so it is the one call that may
		// legitimately go without one; nothing else does.
		for (const entry of server.requests) {
			if (entry.path === "/v1/health") continue;
			expect(entry.headers.authorization).toBe(`Bearer ${key}`);
		}

		const logged = [...warn.mock.calls, ...info.mock.calls, ...error.mock.calls]
			.map((call) => JSON.stringify(call))
			.join("\n");
		expect(logged).not.toContain(key);

		const row = await ledger.getExtractionJobRow(jobId);
		expect(JSON.stringify(row)).not.toContain(key);
	});
});
