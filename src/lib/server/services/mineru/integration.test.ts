// MinerU 4.1, end to end: the real job engine, the real extraction handler, the
// real extractor registry and an in-process 4.1 server on a real socket.
//
// Nothing is stubbed between the engine's `drain` and the wire except the persist
// sink, which belongs to a different slice. The extractor is NOT passed in: the
// handler resolves it through `extractors/registry.ts`, so this file also proves
// the registry flip. The configuration arrives the way it does in production —
// through the environment, read by `config-store` — which is why every test
// re-imports the module graph after setting it.
//
// A "process" here is a module graph: the engine keeps its running attempts and
// its worker identity in module state, so a graph imported after
// `vi.resetModules()` is a restarted process on the same database (`reimportAt`),
// and a take-back made from it reaches an attempt of the old graph the way one
// made by a restarted server reaches the attempt of the process that died.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentExtractor } from "$lib/server/services/extraction/contracts";
import {
	createLedgerFixture,
	type LedgerFixture,
} from "$lib/server/services/extraction/testing/ledger-fixtures";
import {
	type RunOnceOptions,
	runExtractionOnce,
} from "$lib/server/services/extraction/testing/run-once";
import { resetSeams } from "$lib/server/services/extraction/testing/runner-seams";
import type { Artifact } from "$lib/server/services/knowledge/types";
import { getIntakeTierHint } from "$lib/shared/file-types";
import {
	createFakeMineruServer,
	type FakeMineruServer,
	type FakeMineruServerOptions,
	MINERU_4_0_12_ERRORS,
	MINERU_FIXTURE_ROOT,
} from "./testing/fake-server";

type Ledger = typeof import("$lib/server/services/extraction/extraction-job");
type Capabilities = typeof import("./capabilities");

/**
 * The recorded inputs that MinerU is asked to read, with the file each fixture
 * directory carries. CSV is a recorded input too, but the registry reads it
 * directly (`direct-text`) and it never reaches MinerU from the app, so it is
 * not one of these: sending it here would assert a tier for a "native document"
 * that S4 says gets none.
 */
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
	["epub", "sample.epub", "application/epub+zip"],
	["png", "sample.png", "image/png"],
	["jpg", "sample.jpg", "image/jpeg"],
];

let fixture: LedgerFixture;
let server: FakeMineruServer;
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
 * job wait out an outage and then finish. The new graph is also a new worker
 * identity with nothing running in it: a restarted process.
 *
 * The test seams are spies on modules of the graph that was just thrown away;
 * they are put back on the next run, on the new one.
 */
async function reimportAt(
	baseUrl: string,
	override?: string | undefined,
): Promise<void> {
	process.env.MINERU_API_URL = override ?? baseUrl;
	vi.resetModules();
	resetSeams();
	ledger = await import("$lib/server/services/extraction/extraction-job");
	capabilities = await import("./capabilities");
	capabilities.resetMineruCapabilitiesCacheForTests();
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

/**
 * Drains the extraction kind over the fixture's database and answers for the one
 * job that ran: its id and the word the browser would show for it, or null when
 * nothing was claimable. `config` is laid over the real extraction config for the
 * run (`heartbeatMs`, `maxConcurrency`…).
 */
function run(overrides: RunOnceOptions = {}) {
	return runExtractionOnce(fixture.sqlite, {
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

function cancelRequests() {
	return server.requests.filter(
		(entry) => entry.method === "POST" && entry.path.endsWith("/cancel"),
	);
}

function taskPolls(taskId?: string) {
	return server.requests.filter(
		(entry) =>
			entry.method === "GET" &&
			(taskId
				? entry.path === `/v1/tasks/${taskId}`
				: /^\/v1\/tasks\/[^/]+$/.test(entry.path)),
	);
}

function puts() {
	return server.requests.filter((entry) => entry.method === "PUT");
}

/**
 * Wait until a worker that is about to "die" has done everything a worker does
 * before the parse: the task exists, its handle is on the row, the bytes are up and
 * the row says `parsing`.
 *
 * A bare "the row has a checkpoint" is too early. The handle is written the moment
 * the task exists, before the PUT, so a test that went on from there raced the
 * upload: on a busy machine the PUT had not landed when it counted the uploads, or
 * the `parsing` write replaced the checkpoint it had just read. `parsing` is
 * reported after the PUT, so it is the one point after which nothing else of the
 * dying worker's changes the row or the server.
 */
async function theDeadWorkerHasItsBytesUp(jobId: string): Promise<void> {
	await vi.waitFor(async () => {
		const row = await ledger.getExtractionJobRow(jobId);
		expect(row?.phase).toBe("parsing");
		expect(row?.checkpoint).not.toBeNull();
	});
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
	)("%s parses to non-empty text through the real engine", async (input, file, mimeType) => {
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

		// What MinerU was told: the canonical name, and a tier only where one
		// can be used (S3, S4). A native document runs at flash whatever is asked.
		const create = server.requests.find(
			(entry) => entry.method === "POST" && entry.path === "/v1/tasks",
		)?.json as { files: Array<{ file_name: string }>; tier?: string };
		expect(create.files[0].file_name).toBe(`document.${input}`);
		// A native document is the registry's word (`tierHint: "flash"`), not a
		// list kept here: it gets no tier, everything else gets the best one.
		const native = getIntakeTierHint(file, mimeType) === "flash";
		expect("tier" in create).toBe(!native);
		if (!native) expect(create.tier).toBe("standard");

		// The structured payload P4-B reads, flat plus the bundle manifest.
		const structured = call.structured as Record<string, unknown>;
		expect(structured.parserVersion).toBe("mineru4/2");
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

		// What the browser would show: a running job is its phase.
		const seen: string[] = [];
		const watcher = setInterval(() => {
			const row = fixture.sqlite
				.prepare(
					"SELECT status, phase FROM document_extraction_jobs WHERE id = ?",
				)
				.get(jobId) as { status: string; phase: string | null } | undefined;
			if (!row) return;
			const word = row.status === "running" ? row.phase : row.status;
			if (word && seen.at(-1) !== word) seen.push(word);
		}, 20);
		watcher.unref?.();

		expect(await run()).toEqual({ jobId, status: "succeeded" });
		clearInterval(watcher);

		// The sampler races the engine's last write, so the terminal status is
		// read from the row rather than from the sample: what the samples prove
		// is that the job was VISIBLE as parsing while it was parsing, which is
		// the whole point of reporting a phase at all.
		expect(seen).toContain("parsing");
		expect(seen.indexOf("uploading")).toBeLessThan(seen.indexOf("parsing"));
		expect((await ledger.getExtractionJobRow(jobId))?.status).toBe("succeeded");

		// A slow task really was polled more than once.
		expect(taskPolls().length).toBeGreaterThan(1);
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
		// detected by the capability read: the probe answers "reachable, 4.1.7"
		// and the 401 surfaces at the first authenticated call. That is one
		// create, and no bytes: the PUT never happens.
		expect(countRequests("POST", "/v1/tasks")).toBe(1);
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
		// Refused before the request, so before the task: nothing was created.
		expect(countRequests("POST", "/v1/tasks")).toBe(0);
		// The person reads our sentence, not the setting's name or the server's.
		expect(row?.errorMessage).toBe(
			"The document service does not offer the requested quality tier. Ask an administrator to check the tier setting.",
		);
	});

	it("job_failed and a retry for a file MinerU could not parse, without MinerU's words", async () => {
		await boot({
			outcome: "file-failed",
			fileError: { message: "All connection attempts failed (see /srv/x)" },
		});
		const { jobId } = await seedJob();

		expect(await run()).toEqual({ jobId, status: "queued" });

		const row = await ledger.getExtractionJobRow(jobId);
		expect(row?.errorCode).toBe("job_failed");
		expect(row?.status).toBe("queued");
		// `error_message` is read by the send gate and by the Knowledge row.
		expect(row?.errorMessage).toBe(
			"The document service could not finish reading this file.",
		);
		// An operator finds MinerU's own words on the attempt.
		const attempts = fixture.sqlite
			.prepare("SELECT diagnostics_json FROM document_extraction_job_attempts")
			.all() as Array<{ diagnostics_json: string | null }>;
		expect(attempts[0].diagnostics_json).toContain("All connection attempts");
	});

	it("protocol for a completed task with no result to download", async () => {
		await boot({ outcome: "completed-without-result-url" });
		const { jobId } = await seedJob();

		expect(await run()).toEqual({ jobId, status: "queued" });
		expect((await ledger.getExtractionJobRow(jobId))?.errorCode).toBe(
			"protocol",
		);
	});
});

// ---------------------------------------------------------------------------
// Defect 1: a damaged document must not burn the budget on identical work
// ---------------------------------------------------------------------------

/** The message 4.0.4 returned live for a corrupt PDF and for a zero-page PDF. */
const PDFIUM_DAMAGED = "Failed to load document (PDFium: Data format error).";

describe("a document the reader cannot open", () => {
	it("fails once, permanently, and is not offered a Retry", async () => {
		await boot({
			outcome: "file-failed",
			fileError: { message: PDFIUM_DAMAGED },
		});
		const { jobId } = await seedJob();

		// `failed`, not `queued`: no second attempt is scheduled at all.
		expect(await run()).toEqual({ jobId, status: "failed" });

		const row = await ledger.getExtractionJobRow(jobId);
		expect(row?.status).toBe("failed");
		expect(row?.errorCode).toBe("document_unreadable");
		expect(row?.retryable).toBe(false);
		// The sentence comes from the code; "PDFium" is an operator's word.
		expect(row?.errorMessage).toContain("damaged or password-protected");
		expect(row?.errorMessage).not.toContain("PDFium");
		expect(await ledger.listExtractionJobAttempts(jobId)).toHaveLength(1);

		// One task, and the dead task id is not left behind for anyone to resume.
		// Live this cost three attempts, two of them `resumed: true` against the
		// same terminal job, and then a Retry that resumed it again.
		expect(countRequests("POST", "/v1/tasks")).toBe(1);
		expect(row?.checkpoint).toBeNull();
	});

	it("survives the whole round trip to the DTO the chip reads", async () => {
		await boot({
			outcome: "file-failed",
			fileError: { message: PDFIUM_DAMAGED },
		});
		const { artifactId } = await seedJob();
		await run();

		const readModel = await import(
			"$lib/server/services/extraction/read-model"
		);
		const dto = await readModel.getExtractionJobForArtifact({
			userId,
			artifactId,
		});
		expect(dto?.status).toBe("failed");
		expect(dto?.error?.code).toBe("document_unreadable");
		// Both i18n families key off the code, so this IS the message key.
		expect(`chat.extraction.error.${dto?.error?.code}`).toBe(
			"chat.extraction.error.document_unreadable",
		);
		expect(dto?.retryable).toBe(false);
	});
});

describe("an ordinary parse failure keeps its budget", () => {
	it("spends every attempt on a NEW remote task, never on the dead one", async () => {
		// The default `file-failed` message, "Parse failed", explains nothing, so
		// it stays a retryable `job_failed`. What changes is that each retry is now
		// a real re-parse instead of one GET on an already-failed task.
		await boot({ outcome: "file-failed" });
		const { jobId } = await seedJob();

		const remoteJobIds: string[] = [];
		for (let i = 0; i < 3; i += 1) {
			clearBackoffGates();
			await run();
			const handle = (await ledger.getExtractionJobRow(jobId))?.checkpoint;
			if (handle) remoteJobIds.push(JSON.parse(handle).remoteJobId);
		}

		const row = await ledger.getExtractionJobRow(jobId);
		expect(row?.status).toBe("failed");
		expect(row?.errorCode).toBe("max_attempts");
		expect(await ledger.listExtractionJobAttempts(jobId)).toHaveLength(3);

		// Three attempts, three DISTINCT remote tasks. Every one of them was
		// cleared on failure, so nothing was ever resumed.
		expect(countRequests("POST", "/v1/tasks")).toBe(3);
		expect(remoteJobIds).toEqual([]);

		// And it cost no extra bytes: the hash cache already holds them, so the
		// three tasks share the one PUT the first attempt made.
		expect(puts()).toHaveLength(1);
	});

	it("gives a user Retry after max_attempts a fresh remote task", async () => {
		await boot({ outcome: "file-failed" });
		const { jobId } = await seedJob();

		for (let i = 0; i < 3; i += 1) {
			clearBackoffGates();
			await run();
		}
		expect((await ledger.getExtractionJobRow(jobId))?.errorCode).toBe(
			"max_attempts",
		);

		// The server is healthy again and the file was always fine.
		server.setOptions({ outcome: "completed" });
		server.resetLog();
		await ledger.retryExtractionJob({ userId, jobId });
		expect(await run()).toEqual({ jobId, status: "succeeded" });

		// A brand new task, because no handle survived the last failure.
		expect(countRequests("POST", "/v1/tasks")).toBe(1);
		expect(
			server.requests.filter((entry) => entry.method === "GET"),
		).not.toEqual([]);
	});
});

describe("cancel while parsing", () => {
	it("cancels the remote task, settles cancelled and leaves no temp directory", async () => {
		await boot({ neverFinish: true });
		const { jobId } = await seedJob();

		const running = run();
		await vi.waitFor(async () => {
			const row = await ledger.getExtractionJobRow(jobId);
			// A running job is `running`, in the phase the extractor reported.
			expect([row?.status, row?.phase]).toEqual(["running", "parsing"]);
		});
		// The handle exists before the first poll, which is what makes the remote
		// cancel possible at all.
		expect((await ledger.getExtractionJobRow(jobId))?.checkpoint).toContain(
			"job_",
		);

		await ledger.cancelExtractionJob({ userId, jobId });
		// The browser's word for it keeps its one `l`; the row stores the engine's.
		expect(await running).toEqual({ jobId, status: "canceled" });

		await vi.waitFor(() => {
			expect(cancelRequests()).toHaveLength(1);
		});
		const row = await ledger.getExtractionJobRow(jobId);
		expect(row?.status).toBe("cancelled");
		expect(persisted).toHaveLength(0);
		// Temp-directory cleanup is asserted in `extractors/mineru4.test.ts`,
		// which can give the extractor a private root: counting entries in the
		// shared OS temp directory from here would race every other test file.
	});
});

describe("a worker that died mid-parse", () => {
	it("resumes the stored handle instead of creating a second task", async () => {
		await boot({ neverFinish: true });
		const { jobId } = await seedJob();

		// The first process: the real extractor up to the moment the remote task
		// has its bytes and its handle is on the row, and then nothing. No verdict, no
		// unwinding, no further write: that is what a killed worker looks like from
		// the ledger's side. (An abort without a reason counts as a lost claim, so the
		// real extractor lets go of the remote job without deleting it.)
		const { mineru4Extractor } = await import(
			"$lib/server/services/extraction/extractors/mineru4"
		);
		const dying: DocumentExtractor = {
			...mineru4Extractor,
			extract: async (request) => {
				const stop = new AbortController();
				const real = mineru4Extractor.extract({
					...request,
					signal: stop.signal,
					onProgress: (progress) => {
						request.onProgress(progress);
						if (progress.handle && progress.phase === "parsing") stop.abort();
					},
				});
				await real.catch(() => undefined);
				return new Promise<never>(() => undefined);
			},
		};
		void run({ resolveExtractor: () => dying });
		await theDeadWorkerHasItsBytesUp(jobId);
		const handleJson = (await ledger.getExtractionJobRow(jobId))?.checkpoint;

		// The restarted process is a fresh module graph on the same database, with a
		// worker identity of its own and nothing in memory: the engine's record of
		// what the dead one was running is gone with it, so the sweep that takes its
		// attempt back has nobody to tell.
		await reimportAt(server.baseUrl);
		const engine = await import("$lib/server/services/jobs");
		engine.resetJobsForTests();
		expect(
			await engine.recover(ledger.extractionJob, {
				staleBefore: new Date(Date.now() + 60_000),
			}),
		).toEqual({ recovered: 1 });
		clearBackoffGates();

		const createsBefore = countRequests("POST", "/v1/tasks");
		const putsBefore = puts().length;
		expect(createsBefore).toBe(1);
		expect(putsBefore).toBe(1);

		// The remote task can finish now; the restarted worker must pick up the
		// SAME one.
		server.setOptions({ neverFinish: false });
		expect(await run()).toEqual({ jobId, status: "succeeded" });

		// No second task and no second upload: the bytes are where the first
		// attempt put them.
		expect(countRequests("POST", "/v1/tasks")).toBe(createsBefore);
		expect(puts()).toHaveLength(putsBefore);

		const handle = JSON.parse(handleJson as string) as {
			remoteJobId: string;
			remoteFileId: string;
		};
		expect(handle.remoteJobId).toMatch(/^job_/);
		expect(handle.remoteFileId).toMatch(/^file-/);
		expect(puts()[0].path).toBe(
			`/v1/tasks/${handle.remoteJobId}/uploads/${handle.remoteFileId}`,
		);
		// Every poll the restarted worker made was for the first worker's task.
		expect(taskPolls(handle.remoteJobId).length).toBeGreaterThan(0);
		expect(taskPolls()).toEqual(taskPolls(handle.remoteJobId));

		// One attempt per process, and only the live one indexed anything.
		expect(persisted).toHaveLength(1);
		expect(await ledger.listExtractionJobAttempts(jobId)).toHaveLength(2);
	});

	it("does not cancel the remote task when a stale sweep takes the claim", async () => {
		// The dangerous variant of the test above: here the running attempt DOES
		// notice it lost the claim (the sweep ran in its own process, so the engine
		// tells it at once). It used to read that abort as a cancel and DELETE the
		// very job the new claimant had just been handed, so a stale sweep during a
		// slow parse destroyed the remote work the stored handle exists to resume,
		// and the next attempt paid for a second upload and a second parse.
		await boot({ neverFinish: true });
		const { jobId } = await seedJob();

		const orphaned = run();
		await vi.waitFor(async () => {
			expect(
				(await ledger.getExtractionJobRow(jobId))?.checkpoint,
			).not.toBeNull();
		});
		const handleJson = (await ledger.getExtractionJobRow(jobId))
			?.checkpoint as string;
		const remoteJobId = JSON.parse(handleJson).remoteJobId as string;

		// A sweep reclaims the attempt out from under the running one.
		const { recover } = await import("$lib/server/services/jobs");
		expect(
			await recover(ledger.extractionJob, {
				staleBefore: new Date(Date.now() + 60_000),
			}),
		).toEqual({ recovered: 1 });

		// The losing attempt unwinds and leaves the job queued behind its backoff,
		// for the next attempt to resume.
		expect(await orphaned).toEqual({ jobId, status: "queued" });
		expect(cancelRequests()).toEqual([]);
		expect(server.tasks.get(remoteJobId)?.status).not.toBe("canceled");

		// And the handle the next attempt needs is still on the row.
		const row = await ledger.getExtractionJobRow(jobId);
		expect(row?.checkpoint).toContain(remoteJobId);
		expect(row?.status).toBe("queued");
	});
});

describe("a MinerU that forgot every id", () => {
	it("creates the task again and uploads again, within the one attempt", async () => {
		// The restart lands right after the upload was accepted. 4.1 keeps its hash
		// cache in memory too (spike section 8), so nothing is skipped the second
		// time: a new task, and the bytes again.
		await boot({ restartAfterFirstUpload: true });
		const { jobId } = await seedJob();

		expect(await run()).toEqual({ jobId, status: "succeeded" });

		expect(countRequests("POST", "/v1/tasks")).toBe(2);
		expect(puts()).toHaveLength(2);
		expect(persisted).toHaveLength(1);
		// One attempt, and the handle the row ended up with is the second task's.
		expect(await ledger.listExtractionJobAttempts(jobId)).toHaveLength(1);
		expect(server.tasks.size).toBe(1);
	});

	it("does not loop on a server that forgets every time: the ledger retries it, with its budget", async () => {
		await boot({
			failures: [
				{
					path: "/v1/tasks/",
					method: "GET",
					status: 404,
					body: { error: { code: "task_not_found", message: "gone" } },
				},
			],
		});
		const { jobId } = await seedJob();

		expect(await run()).toEqual({ jobId, status: "queued" });

		// One create, one recovery, and the attempt ends: a retryable `protocol`
		// failure for the ledger to schedule, with no handle left to resume.
		expect(countRequests("POST", "/v1/tasks")).toBe(2);
		const row = await ledger.getExtractionJobRow(jobId);
		expect(row?.status).toBe("queued");
		expect(row?.errorCode).toBe("protocol");
		expect(row?.checkpoint).toBeNull();
		expect(row?.errorMessage).toBe(
			"The document service sent a response this app could not use.",
		);
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

				const gate = row?.runAfter?.getTime();
				expect(gate).toBeGreaterThan(Date.now());
				// Nothing is claimable before the gate: the wait is real.
				expect(await run()).toBeNull();
				vi.setSystemTime(gate as number);
			}

			// The old budget would have been spent after three.
			expect(waits).toBeGreaterThan(3);
			expect((await ledger.getExtractionJobRow(jobId))?.status).toBe("queued");
			// The message is the code's, not undici's.
			expect(
				(await ledger.getExtractionJobRow(jobId))?.errorMessage,
			).not.toContain("fetch failed");

			// The backend comes back. No user action, no second upload: the same
			// job row, the same bytes.
			await reimportAt(server.baseUrl);
			expect(await run()).toEqual({ jobId, status: "succeeded" });
			expect(persisted).toHaveLength(1);
			expect(countRequests("POST", "/v1/tasks")).toBe(1);
			expect(puts()).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

// ---------------------------------------------------------------------------
// The deadline: a slow document is not an outage
// ---------------------------------------------------------------------------

describe("a document that outlasts the whole-job deadline", () => {
	// The deadline is `MINERU_JOB_TIMEOUT_MS`, at its 10 s floor here. Date is
	// faked so the clock can run past it in the middle of an attempt; the sockets,
	// the server and the engine are real.
	const TIMEOUT_SENTENCE = "The document service did not answer in time.";
	const FLOOR = { MINERU_JOB_TIMEOUT_MS: "10000" };

	/**
	 * Runs one attempt, and lets the clock pass the deadline once it has looked at
	 * the file `looks` times. The first look finds a file MinerU has queued, the
	 * second finds it running, so a test about a RUNNING file needs two; the poll
	 * interval has a 250 ms floor that the environment cannot lower, which is real
	 * time these tests really spend, and why each carries an explicit bound.
	 */
	async function attemptPastTheDeadline(
		options: Parameters<typeof run>[0] = {},
		looks = 2,
	) {
		const polledBefore = taskPolls().length;
		const attempt = run(options);
		await vi.waitFor(
			() => {
				expect(taskPolls().length).toBeGreaterThanOrEqual(polledBefore + looks);
			},
			{ timeout: 30_000 },
		);
		vi.setSystemTime(Date.now() + 11_000);
		return attempt;
	}

	it("is an attempt when MinerU was running it: the budget is spent, and it ends with the timeout's sentence", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.UTC(2026, 10, 9, 9, 0, 0));
		try {
			await boot({ neverFinish: true }, FLOOR);
			const { jobId, artifactId } = await seedJob();
			const readModel = await import(
				"$lib/server/services/extraction/read-model"
			);

			for (let attempt = 1; attempt <= 2; attempt += 1) {
				expect(await attemptPastTheDeadline()).toEqual({
					jobId,
					status: "queued",
				});
				const row = await ledger.getExtractionJobRow(jobId);
				expect(row?.errorCode).toBe("job_failed");
				expect(row?.errorMessage).toBe(TIMEOUT_SENTENCE);
				// The cancelled task is not left behind to be resumed.
				expect(row?.checkpoint).toBeNull();
				// An attempt like any other: the budget moved.
				const dto = await readModel.getExtractionJobForArtifact({
					userId,
					artifactId,
				});
				expect(dto?.attemptCount).toBe(attempt);
				clearBackoffGates();
			}

			// The third try is the last: no more waiting for a document that does not
			// fit, and no "could not be reached" for one that was reached all along.
			expect(await attemptPastTheDeadline()).toEqual({
				jobId,
				status: "failed",
			});
			const failed = await ledger.getExtractionJobRow(jobId);
			expect(failed?.errorCode).toBe("max_attempts");
			expect(failed?.errorMessage).toBe(TIMEOUT_SENTENCE);
			expect(failed?.retryable).toBe(true);
			expect(await ledger.listExtractionJobAttempts(jobId)).toHaveLength(3);

			// Three fresh tasks, every one of them cancelled on the server.
			expect(countRequests("POST", "/v1/tasks")).toBe(3);
			expect(cancelRequests()).toHaveLength(3);
			expect(
				[...server.tasks.values()].every((task) => task.status === "canceled"),
			).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	}, 60_000);

	it("is MinerU's queue when it had not started it: the document keeps waiting and spends none of its attempts", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.UTC(2026, 10, 9, 9, 0, 0));
		try {
			await boot({ neverFinish: true }, FLOOR);
			const { jobId, artifactId } = await seedJob();
			// A MinerU with a long line: whatever the task, the file shows queued.
			const { createMineru4Extractor } = await import(
				"$lib/server/services/extraction/extractors/mineru4"
			);
			const { MineruClient } = await import("./client");
			const queuedFetch: typeof fetch = async (input, init) => {
				const response = await fetch(input, init);
				const path = new URL(String(input)).pathname;
				if (
					(init?.method ?? "GET") !== "GET" ||
					!/^\/v1\/tasks\/[^/]+$/.test(path)
				) {
					return response;
				}
				const body = (await response.json()) as {
					status: string;
					files: Array<Record<string, unknown>>;
				};
				body.status = "pending";
				for (const file of body.files) file.status = "pending";
				return Response.json(body, { status: response.status });
			};
			const queued = createMineru4Extractor({
				createClient: (config) =>
					new MineruClient({ config, fetchImpl: queuedFetch }),
			});
			const readModel = await import(
				"$lib/server/services/extraction/read-model"
			);

			// More times than the attempt budget allows (three): it is an outage wait,
			// and an outage wait has no bound of attempts, only the window of the
			// outage budget. One look is all it takes: the file is queued at the
			// first.
			for (let wait = 1; wait <= 4; wait += 1) {
				expect(
					await attemptPastTheDeadline({ resolveExtractor: () => queued }, 1),
				).toEqual({ jobId, status: "queued" });
				const row = await ledger.getExtractionJobRow(jobId);
				expect(row?.errorCode).toBe("timeout");
				expect(row?.errorMessage).toBe(TIMEOUT_SENTENCE);
				const dto = await readModel.getExtractionJobForArtifact({
					userId,
					artifactId,
				});
				expect(dto?.attemptCount).toBe(0);
				clearBackoffGates();
			}
			expect(cancelRequests()).toHaveLength(4);
		} finally {
			vi.useRealTimers();
		}
	}, 60_000);
});

// ---------------------------------------------------------------------------
// Ruling 4: a user cancel, and exactly one DELETE
// ---------------------------------------------------------------------------

describe("a user cancel", () => {
	it("sends exactly one cancel, and a later Retry starts a NEW remote task", async () => {
		await boot({ neverFinish: true });
		const { jobId } = await seedJob();

		const running = run();
		await vi.waitFor(async () => {
			expect((await ledger.getExtractionJobRow(jobId))?.checkpoint).toContain(
				"job_",
			);
		});
		const firstRemoteJobId = JSON.parse(
			(await ledger.getExtractionJobRow(jobId))?.checkpoint ?? "{}",
		).remoteJobId as string;

		await ledger.cancelExtractionJob({ userId, jobId });
		expect(await running).toEqual({ jobId, status: "canceled" });

		// ONE. The extractor's own abort path issues it; the worker used to
		// issue a second one on top, which the server answers 409.
		expect(cancelRequests().map((entry) => entry.path)).toEqual([
			`/v1/tasks/${firstRemoteJobId}/cancel`,
		]);
		expect(server.tasks.get(firstRemoteJobId)?.status).toBe("canceled");

		// The handle is gone with it. Keeping it meant a later Retry resumed a
		// task the backend had thrown away: the poll answers `canceled`, which
		// the error table reads as "canceled by someone else", a `job_failed`
		// the user never caused, on a document that parses perfectly fresh.
		const canceled = await ledger.getExtractionJobRow(jobId);
		expect(canceled?.status).toBe("cancelled");
		expect(canceled?.checkpoint).toBeNull();

		server.setOptions({ neverFinish: false });
		server.resetLog();
		await ledger.retryExtractionJob({ userId, jobId });
		expect(await run()).toEqual({ jobId, status: "succeeded" });

		// A second remote task, and not one request to the cancelled one.
		expect(countRequests("POST", "/v1/tasks")).toBe(1);
		expect(
			server.requests.filter((entry) => entry.path.includes(firstRemoteJobId)),
		).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// The cutover window: the URL still points at MinerU 4.0.12 (S6, R14)
// ---------------------------------------------------------------------------

describe("a document caught in the cutover window", () => {
	it("waits out the old server and finishes once the URL speaks 4.1, spending none of its attempts", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		// 4.0.12 refuses a 4.1 manifest in its own error voice.
		await boot({
			failures: [
				{
					path: "/v1/tasks",
					method: "POST",
					status: 400,
					body: MINERU_4_0_12_ERRORS.invalidManifest,
				},
			],
		});
		const { jobId, artifactId } = await seedJob();

		expect(await run()).toEqual({ jobId, status: "queued" });

		const waiting = await ledger.getExtractionJobRow(jobId);
		expect(waiting?.status).toBe("queued");
		expect(waiting?.errorCode).toBe("unavailable");
		// A sentence of ours, with no pydantic dump and no field name.
		expect(waiting?.errorMessage).toBe(
			"The document service could not be reached.",
		);
		expect(String(waiting?.errorMessage)).not.toMatch(/pydantic|file_name/);
		// An outage wait: the document has not used one of its attempts.
		const dto = await (
			await import("$lib/server/services/extraction/read-model")
		).getExtractionJobForArtifact({ userId, artifactId });
		expect(dto?.attemptCount).toBe(0);
		expect(dto?.error?.code).toBe("unavailable");
		expect(countRequests("POST", "/v1/tasks")).toBe(1);
		expect(puts()).toHaveLength(0);
		// An operator can see why it is waiting.
		expect(
			warn.mock.calls.some((call) =>
				String(call[0]).includes("another protocol"),
			),
		).toBe(true);

		// The URL is flipped. The same job row, no user action.
		server.setOptions({ failures: [] });
		clearBackoffGates();
		expect(await run()).toEqual({ jobId, status: "succeeded" });
		expect(persisted).toHaveLength(1);
		expect(countRequests("POST", "/v1/tasks")).toBe(2);
	});

	it("keeps a resumed task's handle while the old server cannot answer for it", async () => {
		await boot({ neverFinish: true });
		const { jobId } = await seedJob();

		// A worker that took the task and died: a stored handle, nothing else.
		const { mineru4Extractor } = await import(
			"$lib/server/services/extraction/extractors/mineru4"
		);
		const dying: DocumentExtractor = {
			...mineru4Extractor,
			extract: async (request) => {
				const stop = new AbortController();
				await mineru4Extractor
					.extract({
						...request,
						signal: stop.signal,
						onProgress: (progress) => {
							request.onProgress(progress);
							if (progress.handle && progress.phase === "parsing") stop.abort();
						},
					})
					.catch(() => undefined);
				return new Promise<never>(() => undefined);
			},
		};
		void run({ resolveExtractor: () => dying });
		await theDeadWorkerHasItsBytesUp(jobId);
		const handleJson = (await ledger.getExtractionJobRow(jobId))
			?.checkpoint as string;
		await reimportAt(server.baseUrl);
		const engine = await import("$lib/server/services/jobs");
		engine.resetJobsForTests();
		await engine.recover(ledger.extractionJob, {
			staleBefore: new Date(Date.now() + 60_000),
		});
		clearBackoffGates();

		// The URL was flipped BACK to the old server for a moment: its 404
		// `task_not_found` carries a `type`, so it is the old server, not a
		// forgotten id.
		server.setOptions({
			neverFinish: false,
			failures: [
				{
					path: "/v1/tasks/",
					method: "GET",
					status: 404,
					body: MINERU_4_0_12_ERRORS.taskNotFound,
				},
			],
		});
		expect(await run()).toEqual({ jobId, status: "queued" });
		const row = await ledger.getExtractionJobRow(jobId);
		expect(row?.errorCode).toBe("unavailable");
		// Not re-created, and the handle is still there.
		expect(countRequests("POST", "/v1/tasks")).toBe(1);
		expect(row?.checkpoint).toBe(handleJson);

		// And flipped forward again: the very same task is picked up.
		server.setOptions({ failures: [] });
		clearBackoffGates();
		expect(await run()).toEqual({ jobId, status: "succeeded" });
		expect(countRequests("POST", "/v1/tasks")).toBe(1);
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
